// SPDX-License-Identifier: Apache-2.0

import { EVIDENCE_FEATURE_NAMES } from "../types.js";
import type { RankabilityCandidateInput, RankabilityCaseInput, RankabilityInput } from "./rankabilityInput.js";

type ProbeVerdict = "confirmed_gain" | "directional_gain" | "no_gain" | "regression";
type ProbeMetrics = { cases: number; requiredFiles: number; recallAt5: number; mrr: number };
type ProbeResult = ProbeMetrics & {
  deltaRecallAt5: number;
  deltaMrr: number;
  ci95RecallAt5: { lower: number; upper: number };
  ci95Mrr: { lower: number; upper: number };
  verdict: ProbeVerdict;
};

export type RankabilityDiagnosticCeilings = {
  promotionEligible: false;
  groupedBy: "repository_lineage";
  folds: number;
  evidenceStrength: "insufficient" | "diagnostic";
  pointwiseLinear: ProbeMetrics;
  pairwiseLinear: ProbeResult;
  shallowNonlinear: ProbeResult;
  limitations: string[];
};

type ScoredCase = { id: string; requiredRanks: Array<number | null> };
type LinearModel = { weights: number[]; intercept: number };
type Stump = { feature: number; threshold: number; left: number; right: number };
type StumpModel = { intercept: number; learningRate: number; stumps: Stump[] };

export function runRankabilityDiagnosticCeilings(input: RankabilityInput): RankabilityDiagnosticCeilings {
  const folds = groupedFolds(input.cases, 5);
  const pointwiseRows: ScoredCase[] = [];
  const pairwiseRows: ScoredCase[] = [];
  const nonlinearRows: ScoredCase[] = [];
  for (let fold = 0; fold < folds.length; fold += 1) {
    const testIds = new Set(folds[fold]);
    const train = input.cases.filter((item) => !testIds.has(item.id));
    const test = input.cases.filter((item) => testIds.has(item.id) && item.cohorts.includes("required_source"));
    if (test.length === 0) continue;
    const pointwise = trainPointwise(train);
    const pairwise = trainPairwise(train);
    const nonlinear = trainStumps(train);
    pointwiseRows.push(...scoreCases(test, (candidate) => pointwise.intercept + dot(pointwise.weights, candidate.features)));
    pairwiseRows.push(...scoreCases(test, (candidate) => dot(pairwise.weights, candidate.features)));
    nonlinearRows.push(...scoreCases(test, (candidate) => scoreStumps(nonlinear, candidate.features)));
  }
  const pointwiseMetrics = metrics(pointwiseRows);
  const caseCount = pointwiseMetrics.cases;
  const evidenceStrength = caseCount >= 20 ? "diagnostic" : "insufficient";
  return {
    promotionEligible: false,
    groupedBy: "repository_lineage",
    folds: folds.length,
    evidenceStrength,
    pointwiseLinear: pointwiseMetrics,
    pairwiseLinear: compareProbe(pointwiseRows, pairwiseRows, evidenceStrength),
    shallowNonlinear: compareProbe(pointwiseRows, nonlinearRows, evidenceStrength),
    limitations: [
      "All ceiling models are trained and evaluated only on frozen train/calibration rows.",
      "Repository lineages never cross a fold boundary.",
      "These probes select a mechanism; they are not calibrated runtime artifacts or promotion evidence.",
      ...(evidenceStrength === "insufficient" ? ["Fewer than 20 required-source cases make confidence intervals too weak for a model-family decision."] : [])
    ]
  };
}

function groupedFolds(cases: RankabilityCaseInput[], count: number): string[][] {
  const byLineage = new Map<string, string[]>();
  for (const item of cases) byLineage.set(item.repositoryLineageId, [...(byLineage.get(item.repositoryLineageId) ?? []), item.id]);
  const folds = Array.from({ length: count }, () => [] as string[]);
  const lineages = [...byLineage.entries()].sort(([left], [right]) => left.localeCompare(right));
  lineages.forEach(([, ids], index) => folds[index % count]!.push(...ids.sort()));
  return folds;
}

function trainPointwise(cases: RankabilityCaseInput[]): LinearModel {
  const rows = cases.flatMap((item) => item.candidates.filter((candidate) => candidate.label !== null));
  const weights = Array.from({ length: EVIDENCE_FEATURE_NAMES.length }, () => 0);
  let intercept = 0;
  for (let epoch = 1; epoch <= 280; epoch += 1) {
    const gradient = Array.from({ length: weights.length }, () => 0);
    let interceptGradient = 0;
    for (const row of rows) {
      const probability = sigmoid(intercept + dot(weights, row.features));
      const error = (probability - row.label!) * (row.labelWeight ?? 1);
      interceptGradient += error;
      for (let index = 0; index < gradient.length; index += 1) gradient[index]! += error * row.features[index]!;
    }
    const rate = 0.2 / Math.sqrt(epoch);
    const denominator = Math.max(1, rows.length);
    intercept -= rate * interceptGradient / denominator;
    for (let index = 0; index < weights.length; index += 1) weights[index]! -= rate * (gradient[index]! / denominator + 0.02 * weights[index]!);
  }
  return { weights, intercept };
}

function trainPairwise(cases: RankabilityCaseInput[]): LinearModel {
  const pairs = cases.flatMap((item) => {
    const positives = item.candidates.filter((candidate) => candidate.label === 1);
    const negatives = item.candidates.filter((candidate) => candidate.label === 0).slice(0, 64);
    return positives.flatMap((positive) => negatives.map((negative) => ({
      difference: positive.features.map((value, index) => value - negative.features[index]!),
      weight: Math.min(positive.labelWeight ?? 1, negative.labelWeight ?? 1)
    })));
  });
  const weights = Array.from({ length: EVIDENCE_FEATURE_NAMES.length }, () => 0);
  for (let epoch = 1; epoch <= 320; epoch += 1) {
    const gradient = Array.from({ length: weights.length }, () => 0);
    for (const pair of pairs) {
      const error = sigmoid(dot(weights, pair.difference)) - 1;
      for (let index = 0; index < weights.length; index += 1) gradient[index]! += error * pair.difference[index]! * pair.weight;
    }
    const rate = 0.25 / Math.sqrt(epoch);
    const denominator = Math.max(1, pairs.length);
    for (let index = 0; index < weights.length; index += 1) weights[index]! -= rate * (gradient[index]! / denominator + 0.02 * weights[index]!);
  }
  return { weights, intercept: 0 };
}

function trainStumps(cases: RankabilityCaseInput[]): StumpModel {
  const rows = cases.flatMap((item) => item.candidates.filter((candidate) => candidate.label !== null));
  const positiveRate = Math.min(1 - 1e-6, Math.max(1e-6, rows.reduce((sum, row) => sum + row.label!, 0) / Math.max(1, rows.length)));
  const model: StumpModel = { intercept: Math.log(positiveRate / (1 - positiveRate)), learningRate: 0.15, stumps: [] };
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const residuals = rows.map((row) => row.label! - sigmoid(scoreStumps(model, row.features)));
    let best: { error: number; stump: Stump } | null = null;
    for (let feature = 0; feature < EVIDENCE_FEATURE_NAMES.length; feature += 1) {
      const values = rows.map((row) => row.features[feature]!).sort((left, right) => left - right);
      for (const fraction of [0.25, 0.5, 0.75]) {
        const threshold = values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
        const leftIndices = rows.flatMap((row, index) => row.features[feature]! <= threshold ? [index] : []);
        const rightIndices = rows.flatMap((row, index) => row.features[feature]! > threshold ? [index] : []);
        if (leftIndices.length === 0 || rightIndices.length === 0) continue;
        const left = averageIndices(residuals, leftIndices); const right = averageIndices(residuals, rightIndices);
        const error = residuals.reduce((sum, residual, index) => sum + (residual - (rows[index]!.features[feature]! <= threshold ? left : right)) ** 2, 0);
        if (!best || error < best.error) best = { error, stump: { feature, threshold, left, right } };
      }
    }
    if (!best) break;
    model.stumps.push(best.stump);
  }
  return model;
}

function scoreCases(cases: RankabilityCaseInput[], score: (candidate: RankabilityCandidateInput) => number): ScoredCase[] {
  return cases.map((item) => {
    const ranked = item.candidates.map((candidate) => ({
      path: candidate.path,
      priority: candidate.features[EVIDENCE_FEATURE_NAMES.indexOf("failureReference")]! > 0 ? 2 : candidate.features[EVIDENCE_FEATURE_NAMES.indexOf("exactPath")]! > 0 ? 1 : 0,
      score: score(candidate)
    })).sort((left, right) => right.priority - left.priority || right.score - left.score || left.path.localeCompare(right.path));
    const positions = new Map(ranked.map((candidate, index) => [candidate.path, index + 1]));
    return { id: item.id, requiredRanks: item.requiredFiles.map((required) => positions.get(required.path) ?? null) };
  });
}

function compareProbe(baseline: ScoredCase[], candidate: ScoredCase[], evidenceStrength: RankabilityDiagnosticCeilings["evidenceStrength"]): ProbeResult {
  const left = metrics(baseline); const right = metrics(candidate);
  const recallDelta = pairedBootstrap(baseline.map((row) => fileRecall(row.requiredRanks, 5)), candidate.map((row) => fileRecall(row.requiredRanks, 5)));
  const mrrDelta = pairedBootstrap(baseline.map((row) => mean(row.requiredRanks.map(reciprocal))), candidate.map((row) => mean(row.requiredRanks.map(reciprocal))));
  const deltaRecallAt5 = right.recallAt5 - left.recallAt5; const deltaMrr = right.mrr - left.mrr;
  let verdict: ProbeVerdict = deltaRecallAt5 < -0.02 || deltaMrr < -0.02 ? "regression" : deltaRecallAt5 > 0 || deltaMrr > 0 ? "directional_gain" : "no_gain";
  if (evidenceStrength === "diagnostic" && (recallDelta.lower > 0 || mrrDelta.lower > 0) && deltaRecallAt5 >= -0.02 && deltaMrr >= -0.02) verdict = "confirmed_gain";
  return { ...right, deltaRecallAt5: round(deltaRecallAt5), deltaMrr: round(deltaMrr), ci95RecallAt5: recallDelta, ci95Mrr: mrrDelta, verdict };
}

function metrics(rows: ScoredCase[]): ProbeMetrics {
  const ranks = rows.flatMap((row) => row.requiredRanks);
  return { cases: rows.length, requiredFiles: ranks.length, recallAt5: round(fileRecall(ranks, 5)), mrr: round(mean(ranks.map(reciprocal))) };
}

function pairedBootstrap(left: number[], right: number[]): { lower: number; upper: number } {
  if (left.length !== right.length || left.length === 0) return { lower: 0, upper: 0 };
  const random = mulberry32(0x52414e4b); const deltas: number[] = [];
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    let a = 0; let b = 0;
    for (let index = 0; index < left.length; index += 1) { const sampled = Math.floor(random() * left.length); a += left[sampled]!; b += right[sampled]!; }
    deltas.push(b / left.length - a / left.length);
  }
  deltas.sort((a, b) => a - b);
  return { lower: round(deltas[Math.floor(deltas.length * 0.025)] ?? 0), upper: round(deltas[Math.floor(deltas.length * 0.975)] ?? 0) };
}

function scoreStumps(model: StumpModel, features: number[]): number { return model.intercept + model.learningRate * model.stumps.reduce((sum, stump) => sum + (features[stump.feature]! <= stump.threshold ? stump.left : stump.right), 0); }
function averageIndices(values: number[], indices: number[]): number { return indices.reduce((sum, index) => sum + values[index]!, 0) / indices.length; }
function dot(left: number[], right: number[]): number { return left.reduce((sum, value, index) => sum + value * right[index]!, 0); }
function sigmoid(value: number): number { return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value)); }
function fileRecall(ranks: Array<number | null>, limit: number): number { return ranks.length === 0 ? 0 : ranks.filter((rank) => rank !== null && rank <= limit).length / ranks.length; }
function reciprocal(rank: number | null): number { return rank === null ? 0 : 1 / rank; }
function mean(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function round(value: number): number { return Number(value.toFixed(9)); }
function mulberry32(seed: number): () => number { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
