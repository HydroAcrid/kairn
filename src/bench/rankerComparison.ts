// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { classifyBenchmarkRun, type BenchmarkRunClassification } from "./campaign.js";

type EvaluationMetrics = {
  currentStrictFullRecallAt128: number;
  rankedStrictFullRecallAt64: number;
  rankedRequiredFileRecallAt5: number;
  rankedRequiredFileMrr: number;
  expectedCalibrationError: number;
  generatedVendorTopOneViolations: unknown[];
};
type Evaluation = {
  schemaVersion: string;
  evaluationSplit: string;
  referenceKind: string;
  model: { id: string; featureSchemaVersion: string };
  inputs: { manifest: { sha256: string }; report: { sha256: string } };
  targetCaseCount: number;
  metrics: EvaluationMetrics;
  cases: Array<{ id: string }>;
};

export type RankerComparisonReport = {
  schemaVersion: "ranker-comparison.v1";
  infrastructure: { valid: boolean; campaignFingerprint: string };
  data: { valid: boolean; cohortHash: string; split: string; referenceKind: string; caseCount: number };
  classification: BenchmarkRunClassification;
  baseline: { modelId: string; metrics: EvaluationMetrics };
  candidate: { modelId: string; metrics: EvaluationMetrics };
  deltas: { recallAt5: number; mrr: number; servedRecallAt64: number; boundedRecallAt128: number; ece: number };
  regressions: string[];
};

export function compareRankerEvaluations(input: {
  baselinePath: string;
  candidatePath: string;
  infrastructureValid: boolean;
  campaignFingerprint: string;
  noninferiorityMargin?: number;
}): RankerComparisonReport {
  const baseline = readEvaluation(input.baselinePath);
  const candidate = readEvaluation(input.candidatePath);
  const baselineIds = baseline.cases.map((item) => item.id).sort();
  const candidateIds = candidate.cases.map((item) => item.id).sort();
  const shared = baseline.evaluationSplit === candidate.evaluationSplit &&
    baseline.referenceKind === candidate.referenceKind &&
    baseline.targetCaseCount === candidate.targetCaseCount &&
    JSON.stringify(baselineIds) === JSON.stringify(candidateIds) &&
    baseline.inputs.manifest.sha256 === candidate.inputs.manifest.sha256 &&
    baseline.inputs.report.sha256 === candidate.inputs.report.sha256;
  if (!shared) throw new Error("ranker evaluations do not share the same frozen cohort and candidate pool");
  const deltas = {
    recallAt5: candidate.metrics.rankedRequiredFileRecallAt5 - baseline.metrics.rankedRequiredFileRecallAt5,
    mrr: candidate.metrics.rankedRequiredFileMrr - baseline.metrics.rankedRequiredFileMrr,
    servedRecallAt64: candidate.metrics.rankedStrictFullRecallAt64 - baseline.metrics.rankedStrictFullRecallAt64,
    boundedRecallAt128: candidate.metrics.currentStrictFullRecallAt128 - baseline.metrics.currentStrictFullRecallAt128,
    ece: candidate.metrics.expectedCalibrationError - baseline.metrics.expectedCalibrationError
  };
  const regressions: string[] = [];
  if (deltas.recallAt5 < 0) regressions.push(`Recall@5 regressed by ${formatDelta(deltas.recallAt5)}.`);
  if (deltas.mrr < 0) regressions.push(`MRR regressed by ${formatDelta(deltas.mrr)}.`);
  if (deltas.servedRecallAt64 < 0) regressions.push(`Served recall@64 regressed by ${formatDelta(deltas.servedRecallAt64)}.`);
  if (deltas.ece > 0) regressions.push(`ECE worsened by ${formatDelta(deltas.ece)}.`);
  const qualityPassed = candidate.metrics.currentStrictFullRecallAt128 === 1 &&
    candidate.metrics.rankedStrictFullRecallAt64 >= 0.99 &&
    candidate.metrics.expectedCalibrationError <= 0.05 &&
    candidate.metrics.generatedVendorTopOneViolations.length === 0;
  return {
    schemaVersion: "ranker-comparison.v1",
    infrastructure: { valid: input.infrastructureValid, campaignFingerprint: input.campaignFingerprint },
    data: {
      valid: true,
      cohortHash: baseline.inputs.manifest.sha256,
      split: baseline.evaluationSplit,
      referenceKind: baseline.referenceKind,
      caseCount: baseline.targetCaseCount
    },
    classification: classifyBenchmarkRun({
      infrastructureValid: input.infrastructureValid,
      dataValid: true,
      qualityPassed,
      candidateDelta: deltas.boundedRecallAt128,
      rankingDelta: deltas.recallAt5,
      noninferiorityMargin: input.noninferiorityMargin ?? 0.02
    }),
    baseline: { modelId: baseline.model.id, metrics: baseline.metrics },
    candidate: { modelId: candidate.model.id, metrics: candidate.metrics },
    deltas,
    regressions
  };
}

function readEvaluation(filePath: string): Evaluation {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Evaluation;
  if (!value || typeof value !== "object" || !value.model?.id || !value.inputs?.manifest?.sha256 || !value.inputs?.report?.sha256 || !Array.isArray(value.cases)) {
    throw new Error(`invalid ranker evaluation: ${filePath}`);
  }
  return value;
}
function formatDelta(value: number): string { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)} pp`; }
