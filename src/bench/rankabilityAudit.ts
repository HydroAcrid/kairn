// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import { loadEvidenceRankerArtifact, predictEvidenceRelevance } from "../retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES, type EvidenceFeatureVector, type EvidenceRankerArtifact } from "../types.js";
import type { BenchmarkRunClassification } from "./campaign.js";
import {
  RANKABILITY_INPUT_SCHEMA,
  type CandidateOracleInput,
  type RecordedRankabilityBaseline,
  type RankabilityCandidateInput,
  type RankabilityCaseInput,
  type RankabilityInput
} from "./rankabilityInput.js";
import { runRankabilityDiagnosticCeilings, type RankabilityDiagnosticCeilings } from "./rankabilityProbes.js";

export type RankabilityFailureCause =
  | "candidate_coverage"
  | "label_quality"
  | "feature_representation"
  | "model_capacity"
  | "ranked"
  | "unresolved";

export type MetricEstimate = { numerator: number | null; denominator: number; value: number };
export type MetricDelta = {
  baseline: number;
  candidate: number;
  absoluteDelta: number;
  percentagePointDelta: number;
  ci95: { lower: number; upper: number; iterations: 10_000; unit: "case" };
};

type ScoreContribution = { feature: string; value: number; coefficient: number; contribution: number };
type RankedCandidate = {
  candidate: RankabilityCandidateInput;
  rank: number;
  hardPriority: number;
  rawScore: number;
  uncalibratedProbability: number;
  probability: number;
  contributions: ScoreContribution[];
};

export type RankabilityModelMetrics = {
  modelId: string;
  cases: number;
  requiredFiles: number;
  strictFullRecallAt1: MetricEstimate;
  strictFullRecallAt5: MetricEstimate;
  strictFullRecallAt64: MetricEstimate;
  strictFullRecallAt128: MetricEstimate;
  requiredFileRecallAt1: MetricEstimate;
  requiredFileRecallAt5: MetricEstimate;
  requiredFileRecallAt64: MetricEstimate;
  requiredFileRecallAt128: MetricEstimate;
  mrr: MetricEstimate;
  medianRequiredFileRank: number | null;
  expectedCalibrationError: MetricEstimate;
  brierScore: MetricEstimate;
  logLoss: MetricEstimate;
  generatedVendorTopOneViolations: string[];
  perLanguage: Record<string, GroupMetrics>;
  perScenario: Record<string, GroupMetrics>;
};

type GroupMetrics = { cases: number; requiredFiles: number; strictFullRecallAt64: number; requiredFileRecallAt5: number };
type CandidateMetrics = {
  cases: number;
  requiredFiles: number;
  strictFullRecallAt64: MetricEstimate;
  strictFullRecallAt128: MetricEstimate;
  requiredFileRecallAt64: MetricEstimate;
  requiredFileRecallAt128: MetricEstimate;
};
type CandidateComparison = {
  valid: boolean;
  expectedCases: 38;
  comparedCases: number;
  baselineGeneratorId: string;
  candidateGeneratorId: string;
  missingSemanticCases: string[];
  deterministic: CandidateMetrics;
  semantic: CandidateMetrics | null;
  deltas: { strictFullRecallAt64: MetricDelta; strictFullRecallAt128: MetricDelta; requiredFileRecallAt64: MetricDelta; requiredFileRecallAt128: MetricDelta } | null;
  perLanguage: Record<string, CandidateStratumComparison>;
  perScenario: Record<string, CandidateStratumComparison>;
  misses: Array<{ arm: "deterministic" | "semantic"; caseId: string; at64: string[]; at128: string[] }>;
};
type CandidateStratumComparison = {
  cases: number;
  requiredFiles: number;
  deterministic: CandidateMetrics;
  semantic: CandidateMetrics | null;
  deltas: CandidateComparison["deltas"];
};

type HigherRankedCandidate = {
  path: string;
  rank: number;
  labelState: RankabilityCandidateInput["labelState"];
  labelProvenance: string | null;
  probability: number;
  probabilityGap: number;
  differingFeatures: string[];
  featureDistance: number;
  collision: "exact" | "near" | "none";
};
type RequiredFileAudit = {
  path: string;
  contentSha256: string | null;
  stageRanks: Record<"inventory" | "probe" | "initial64" | "bounded128" | "semanticRaw" | "semantic" | "bm25" | "graph", number | null>;
  primaryCause: RankabilityFailureCause;
  contributingCauses: RankabilityFailureCause[];
  diagnosisReasons: string[];
  models: Array<{
    modelId: string;
    rank: number | null;
    probability: number | null;
    probabilityGapFromTop: number | null;
    rawScore: number | null;
    uncalibratedProbability: number | null;
    intercept: number;
    calibration: { kind: "platt"; a: number; b: number; calibratedLogit: number | null; finalProbability: number | null };
    contributions: ScoreContribution[];
    higherRankedCandidates: HigherRankedCandidate[];
  }>;
};
type RankabilityCaseAudit = {
  id: string;
  language: string;
  scenario: string;
  repositoryLineageId: string;
  requiredFiles: RequiredFileAudit[];
  primaryCause: RankabilityFailureCause;
  contributingCauses: RankabilityFailureCause[];
};

export type RankabilityAudit = {
  schemaVersion: "rankability-audit.v2";
  promotionEligible: false;
  infrastructure: { valid: boolean; campaignFingerprint: string; evidenceSha256: string };
  data: {
    valid: boolean;
    inputSha256: string;
    cohortHash: string;
    detachedHoldoutOpened: false;
    limitations: string[];
    failures: string[];
  };
  classification: BenchmarkRunClassification;
  evidencePolicy: { developmentOnly: true; publicClaimRequires: "sealed_holdout_and_quality_passing_live_runs" };
  recordedBaselines: RecordedRankabilityBaseline[];
  cohorts: {
    candidateOracle: { expectedCases: 38; materializedCases: number };
    requiredSource: { cases: number; requiredFiles: number; languages: string[]; scenarios: string[] };
    weakPatchCalibration: { cases: number };
  };
  candidateComparison: CandidateComparison;
  /** Required-source diagnostic metrics: 10 cases / 17 files. */
  modelMetrics: RankabilityModelMetrics[];
  /** Weak-patch calibration metrics: 45 cases, kept separate from required-source diagnostics. */
  calibrationModelMetrics: RankabilityModelMetrics[];
  modelComparison: {
    baselineModelId: string;
    candidateModelId: string;
    recallAt5: MetricDelta;
    mrr: MetricDelta;
    strictFullRecallAt64: MetricDelta;
    perLanguage: Record<string, ModelStratumComparison>;
    perScenario: Record<string, ModelStratumComparison>;
    negativeRankMovements: Array<{ caseId: string; path: string; baselineRank: number | null; candidateRank: number | null; delta: number | null }>;
  } | null;
  calibrationModelComparison: {
    baselineModelId: string;
    candidateModelId: string;
    recallAt5: MetricDelta;
    mrr: MetricDelta;
    strictFullRecallAt64: MetricDelta;
    perLanguage: Record<string, ModelStratumComparison>;
    perScenario: Record<string, ModelStratumComparison>;
    negativeRankMovements: Array<{ caseId: string; path: string; baselineRank: number | null; candidateRank: number | null; delta: number | null }>;
  } | null;
  diagnosticCeilings: RankabilityDiagnosticCeilings;
  rootCauses: { byRequiredFile: Record<RankabilityFailureCause, number>; byCase: Record<RankabilityFailureCause, number> };
  nextExperiment: {
    kind: "candidate_generation" | "label_repair" | "feature_representation" | "pairwise_ranker" | "nonlinear_ranker" | "expand_reviewed_data" | "none";
    reason: string;
  };
  cases: RankabilityCaseAudit[];
};

type ModelStratumComparison = {
  cases: number;
  requiredFiles: number;
  recallAt5: MetricDelta;
  mrr: MetricDelta;
  strictFullRecallAt64: MetricDelta;
};

export function buildRankabilityAudit(input: {
  inputPath: string;
  modelPaths: string[];
  infrastructureValid: boolean;
  campaignFingerprint: string;
  infrastructureEvidenceSha256: string;
}): RankabilityAudit {
  const inputBytes = fs.readFileSync(input.inputPath);
  const source = parseInput(JSON.parse(inputBytes.toString("utf8")) as unknown);
  const models = input.modelPaths.map((modelPath) => loadEvidenceRankerArtifact(modelPath));
  assertModelIdentity(source, models);
  const dataFailures = validateAuditData(source);
  const rankings = rankEveryCase(source, models);
  const cases = source.cases.filter((item) => item.cohorts.includes("required_source"))
    .map((item) => auditCase(item, models, rankings.get(item.id)!));
  const modelMetrics = models.map((model) => buildModelMetrics(source, model, rankings, "required_source"));
  const calibrationModelMetrics = models.map((model) => buildModelMetrics(source, model, rankings, "weak_patch_calibration"));
  const candidateComparison = buildCandidateComparison(source);
  const modelComparison = models.length >= 2
    ? compareModels(source, rankings, modelMetrics[0]!, modelMetrics[1]!, models[0]!.modelId, models[1]!.modelId, "required_source")
    : null;
  const calibrationModelComparison = models.length >= 2
    ? compareModels(source, rankings, calibrationModelMetrics[0]!, calibrationModelMetrics[1]!, models[0]!.modelId, models[1]!.modelId, "weak_patch_calibration")
    : null;
  const diagnosticCeilings = runRankabilityDiagnosticCeilings(source);
  const rootCauses = summarizeRootCauses(cases);
  const dataValid = dataFailures.length === 0;
  const candidateMetrics = modelMetrics[1] ?? modelMetrics[0]!;
  const classification = classifyAudit(input.infrastructureValid, dataValid, source, candidateMetrics, modelComparison);
  return {
    schemaVersion: "rankability-audit.v2",
    promotionEligible: false,
    infrastructure: { valid: input.infrastructureValid, campaignFingerprint: input.campaignFingerprint, evidenceSha256: input.infrastructureEvidenceSha256 },
    data: {
      valid: dataValid,
      inputSha256: digest(inputBytes),
      cohortHash: digest(Buffer.from(JSON.stringify(source.cases.map((item) => ({
        id: item.id,
        repositoryRef: item.repositoryRef,
        candidates: item.candidates.map((candidate) => ({ path: candidate.path, gitBlobOid: candidate.gitBlobOid, features: candidate.features }))
      }))))),
      detachedHoldoutOpened: false,
      limitations: limitations(source),
      failures: dataFailures
    },
    classification,
    evidencePolicy: { developmentOnly: true, publicClaimRequires: "sealed_holdout_and_quality_passing_live_runs" },
    recordedBaselines: source.recordedBaselines,
    cohorts: {
      candidateOracle: { expectedCases: 38, materializedCases: source.cohortCounts.candidateOracleMaterialized },
      requiredSource: {
        cases: cases.length,
        requiredFiles: cases.reduce((sum, item) => sum + item.requiredFiles.length, 0),
        languages: [...new Set(cases.map((item) => item.language))].sort(),
        scenarios: [...new Set(cases.map((item) => item.scenario))].sort()
      },
      weakPatchCalibration: { cases: source.cohortCounts.weakPatchCalibrationCases }
    },
    candidateComparison,
    modelMetrics,
    modelComparison,
    diagnosticCeilings,
    rootCauses,
    nextExperiment: chooseNextExperiment(candidateComparison, rootCauses, diagnosticCeilings, dataValid),
    calibrationModelMetrics,
    calibrationModelComparison,
    cases
  };
}

export function formatRankabilityAuditMarkdown(audit: RankabilityAudit): string {
  const lines = [
    "# Kairn v0.2C-R rankability audit",
    "",
    `Infrastructure: **${audit.infrastructure.valid ? "valid" : "invalid"}**  `,
    `Data: **${audit.data.valid ? "valid" : "invalid"}**  `,
    `Classification: **${audit.classification}**  `,
    `Campaign: \`${audit.infrastructure.campaignFingerprint}\`  `,
    `Input: \`${audit.data.inputSha256}\``,
    "",
    "> Development diagnostic only. A public improvement claim requires sealed-holdout confirmation and quality-passing live-agent results.",
    "",
    "## Immutable recorded baselines",
    "",
    "| Cohort | Model | Pool | Cases | Files | Recall@5 | MRR | Strict@64 | ECE |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ...audit.recordedBaselines.map((item) => `| ${item.cohort} | ${item.modelId} | ${item.candidatePool} | ${item.cases} | ${item.requiredFiles} | ${percent(item.recallAt5)} | ${item.mrr.toFixed(4)} | ${percent(item.strictFullRecallAt64)} | ${item.expectedCalibrationError === null ? "n/a" : item.expectedCalibrationError.toFixed(4)} |`),
    "",
    "## Cohorts",
    "",
    `- Candidate oracle: ${audit.cohorts.candidateOracle.materializedCases}/${audit.cohorts.candidateOracle.expectedCases} semantic cases reconstructed.`,
    `- Required-source diagnostic: ${audit.cohorts.requiredSource.cases} cases / ${audit.cohorts.requiredSource.requiredFiles} required files.`,
    `- Weak-patch calibration: ${audit.cohorts.weakPatchCalibration.cases} cases.`,
    `- Required-source languages: ${audit.cohorts.requiredSource.languages.join(", ") || "none"}.`,
    "",
    "## Frozen candidate generation (38 cases / 72 required files)",
    "",
    `- Baseline: \`${audit.candidateComparison.baselineGeneratorId}\`.`,
    `- Candidate: \`${audit.candidateComparison.candidateGeneratorId}\`.`,
    `- Strict full recall@64: ${formatMetric(audit.candidateComparison.deterministic.strictFullRecallAt64)} → ${audit.candidateComparison.semantic ? formatMetric(audit.candidateComparison.semantic.strictFullRecallAt64) : "unavailable"}.`,
    `- Strict full recall@128: ${formatMetric(audit.candidateComparison.deterministic.strictFullRecallAt128)} → ${audit.candidateComparison.semantic ? formatMetric(audit.candidateComparison.semantic.strictFullRecallAt128) : "unavailable"}.`,
    `- Required-file recall@64: ${formatMetric(audit.candidateComparison.deterministic.requiredFileRecallAt64)} → ${audit.candidateComparison.semantic ? formatMetric(audit.candidateComparison.semantic.requiredFileRecallAt64) : "unavailable"}.`,
    `- Required-file recall@128: ${formatMetric(audit.candidateComparison.deterministic.requiredFileRecallAt128)} → ${audit.candidateComparison.semantic ? formatMetric(audit.candidateComparison.semantic.requiredFileRecallAt128) : "unavailable"}.`,
    ...(audit.candidateComparison.deltas ? [
      `- Strict@64 delta: ${points(audit.candidateComparison.deltas.strictFullRecallAt64.percentagePointDelta)} (95% paired CI ${points(audit.candidateComparison.deltas.strictFullRecallAt64.ci95.lower * 100)} to ${points(audit.candidateComparison.deltas.strictFullRecallAt64.ci95.upper * 100)}).`,
      `- File@64 delta: ${points(audit.candidateComparison.deltas.requiredFileRecallAt64.percentagePointDelta)} (95% paired CI ${points(audit.candidateComparison.deltas.requiredFileRecallAt64.ci95.lower * 100)} to ${points(audit.candidateComparison.deltas.requiredFileRecallAt64.ci95.upper * 100)}).`
    ] : []),
    "",
    "## Same-pool required-source model metrics (10-case diagnostic)",
    "",
    "| Model | Cases | Files | Recall@5 | Strict@64 | File@64 | MRR | ECE | Brier | Log loss |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...audit.modelMetrics.map((metric) => `| ${metric.modelId} | ${metric.cases} | ${metric.requiredFiles} | ${percent(metric.requiredFileRecallAt5.value)} | ${percent(metric.strictFullRecallAt64.value)} | ${percent(metric.requiredFileRecallAt64.value)} | ${metric.mrr.value.toFixed(4)} | ${metric.expectedCalibrationError.value.toFixed(4)} | ${metric.brierScore.value.toFixed(4)} | ${metric.logLoss.value.toFixed(4)} |`),
    "",
    "## Same-pool weak-patch calibration metrics (45 cases)",
    "",
    "| Model | Cases | Files | Recall@5 | Strict@64 | File@64 | MRR | ECE | Brier | Log loss |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...audit.calibrationModelMetrics.map((metric) => `| ${metric.modelId} | ${metric.cases} | ${metric.requiredFiles} | ${percent(metric.requiredFileRecallAt5.value)} | ${percent(metric.strictFullRecallAt64.value)} | ${percent(metric.requiredFileRecallAt64.value)} | ${metric.mrr.value.toFixed(4)} | ${metric.expectedCalibrationError.value.toFixed(4)} | ${metric.brierScore.value.toFixed(4)} | ${metric.logLoss.value.toFixed(4)} |`),
    "",
    "## Root-cause accounting",
    "",
    "| Cause | Required files | Cases |",
    "|---|---:|---:|",
    ...causes().map((cause) => `| ${cause} | ${audit.rootCauses.byRequiredFile[cause]} | ${audit.rootCauses.byCase[cause]} |`),
    "",
    "## Decision",
    "",
    `Next experiment: **${audit.nextExperiment.kind}** — ${audit.nextExperiment.reason}`,
    ""
  ];
  if (audit.modelComparison) {
    lines.push(
      "## Quantified baseline → candidate deltas",
      "",
      `- Required-file Recall@5: ${points(audit.modelComparison.recallAt5.percentagePointDelta)} (95% paired CI ${points(audit.modelComparison.recallAt5.ci95.lower * 100)} to ${points(audit.modelComparison.recallAt5.ci95.upper * 100)}).`,
      `- MRR: ${signed(audit.modelComparison.mrr.absoluteDelta)} (95% paired CI ${signed(audit.modelComparison.mrr.ci95.lower)} to ${signed(audit.modelComparison.mrr.ci95.upper)}).`,
      `- Strict full recall@64: ${points(audit.modelComparison.strictFullRecallAt64.percentagePointDelta)} (95% paired CI ${points(audit.modelComparison.strictFullRecallAt64.ci95.lower * 100)} to ${points(audit.modelComparison.strictFullRecallAt64.ci95.upper * 100)}).`,
      ""
    );
  }
  if (audit.calibrationModelComparison) {
    lines.push(
      "## Weak-patch calibration baseline → candidate deltas",
      "",
      `- Required-file Recall@5: ${points(audit.calibrationModelComparison.recallAt5.percentagePointDelta)} (95% paired CI ${points(audit.calibrationModelComparison.recallAt5.ci95.lower * 100)} to ${points(audit.calibrationModelComparison.recallAt5.ci95.upper * 100)}).`,
      `- MRR: ${signed(audit.calibrationModelComparison.mrr.absoluteDelta)} (95% paired CI ${signed(audit.calibrationModelComparison.mrr.ci95.lower)} to ${signed(audit.calibrationModelComparison.mrr.ci95.upper)}).`,
      `- Strict full recall@64: ${points(audit.calibrationModelComparison.strictFullRecallAt64.percentagePointDelta)} (95% paired CI ${points(audit.calibrationModelComparison.strictFullRecallAt64.ci95.lower * 100)} to ${points(audit.calibrationModelComparison.strictFullRecallAt64.ci95.upper * 100)}).`,
      ""
    );
  }
  if (audit.data.failures.length > 0) lines.push("## Data failures", "", ...audit.data.failures.map((item) => `- ${item}`), "");
  lines.push("## Limitations", "", ...audit.data.limitations.map((item) => `- ${item}`), "");
  return `${lines.join("\n")}\n`;
}

function rankEveryCase(source: RankabilityInput, models: EvidenceRankerArtifact[]): Map<string, Map<string, RankedCandidate[]>> {
  return new Map(source.cases.map((item) => [item.id, new Map(models.map((model) => [model.modelId, rankCandidates(model, item.candidates)]))]));
}

function rankCandidates(model: EvidenceRankerArtifact, candidates: RankabilityCandidateInput[]): RankedCandidate[] {
  const ranked = candidates.map((candidate): RankedCandidate => {
    const features = featureVector(candidate.features);
    const prediction = predictEvidenceRelevance(model, features);
    return {
      candidate,
      rank: 0,
      hardPriority: features.failureReference > 0 ? 2 : features.exactPath > 0 ? 1 : 0,
      rawScore: prediction.rawScore,
      uncalibratedProbability: prediction.uncalibratedProbability,
      probability: prediction.relevanceProbability,
      contributions: model.orderedFeatures.map((feature, index) => ({
        feature,
        value: features[feature],
        coefficient: model.coefficients[index]!,
        contribution: round(features[feature] * model.coefficients[index]!)
      }))
    };
  }).sort((left, right) => right.hardPriority - left.hardPriority || right.probability - left.probability || left.candidate.path.localeCompare(right.candidate.path));
  ranked.forEach((item, index) => { item.rank = index + 1; });
  return ranked;
}

function auditCase(item: RankabilityCaseInput, models: EvidenceRankerArtifact[], rankings: Map<string, RankedCandidate[]>): RankabilityCaseAudit {
  const requiredFiles = item.requiredFiles.map((required): RequiredFileAudit => {
    const candidate = item.candidates.find((value) => value.path === required.path);
    const modelResults = models.map((model) => {
      const ranked = rankings.get(model.modelId)!;
      const found = ranked.find((value) => value.candidate.path === required.path);
      const higher = found ? ranked.slice(0, found.rank - 1).slice(0, 16) : ranked.slice(0, 16);
      return {
        modelId: model.modelId,
        rank: found?.rank ?? null,
        probability: found?.probability ?? null,
        probabilityGapFromTop: found && ranked[0] ? round(ranked[0].probability - found.probability) : null,
        rawScore: found?.rawScore ?? null,
        uncalibratedProbability: found?.uncalibratedProbability ?? null,
        intercept: model.intercept,
        calibration: {
          kind: "platt" as const,
          a: model.calibration.a,
          b: model.calibration.b,
          calibratedLogit: found ? round(model.calibration.a * found.rawScore + model.calibration.b) : null,
          finalProbability: found?.probability ?? null
        },
        contributions: found?.contributions ?? [],
        higherRankedCandidates: higher.map((other): HigherRankedCandidate => {
          const difference = featureDifference(candidate?.features, other.candidate.features);
          return {
            path: other.candidate.path,
            rank: other.rank,
            labelState: other.candidate.labelState,
            labelProvenance: other.candidate.labelProvenance,
            probability: other.probability,
            probabilityGap: found ? round(other.probability - found.probability) : 0,
            differingFeatures: difference.names,
            featureDistance: difference.distance,
            collision: difference.exact ? "exact" : difference.distance <= 0.01 ? "near" : "none"
          };
        })
      };
    });
    return {
      path: required.path,
      contentSha256: required.contentSha256,
      stageRanks: {
        inventory: rankOf(item.stages.inventoryAvailable, required.path),
        probe: rankOf(item.stages.probe, required.path),
        initial64: rankOf(item.stages.initial64, required.path),
        bounded128: rankOf(item.stages.bounded128, required.path),
        semanticRaw: rankOf(item.lanes.semanticRaw, required.path),
        semantic: rankOf(item.lanes.semantic, required.path),
        bm25: rankOf(item.lanes.bm25, required.path),
        graph: rankOf(item.lanes.graph, required.path)
      },
      ...diagnose(item, required.path, candidate, modelResults.at(-1)),
      models: modelResults
    };
  });
  const primaryCause = strongestCause(requiredFiles.map((file) => file.primaryCause));
  return {
    id: item.id,
    language: item.language,
    scenario: item.scenario,
    repositoryLineageId: item.repositoryLineageId,
    requiredFiles,
    primaryCause,
    contributingCauses: [...new Set(requiredFiles.flatMap((file) => [file.primaryCause, ...file.contributingCauses]))].filter((cause) => cause !== primaryCause)
  };
}

function diagnose(item: RankabilityCaseInput, path: string, candidate: RankabilityCandidateInput | undefined, model: RequiredFileAudit["models"][number] | undefined): Pick<RequiredFileAudit, "primaryCause" | "contributingCauses" | "diagnosisReasons"> {
  if (!item.stages.bounded128.includes(path) || !candidate) {
    return diagnosis("candidate_coverage", "Required source is absent from the frozen bounded 128-file pool.");
  }
  if (candidate.label !== 1 || candidate.labelProvenance !== "required_source_oracle") {
    return diagnosis("label_quality", "Required source does not carry an intact required-source positive label.");
  }
  if ((model?.rank ?? Number.POSITIVE_INFINITY) <= 5) return diagnosis("ranked", "Required source ranks within the top five.");
  const higher = model?.higherRankedCandidates ?? [];
  const collisions = higher.filter((value) => value.labelState === "negative" && value.collision !== "none");
  if (collisions.length > 0) return diagnosis("feature_representation", `${collisions.length} reviewed negative candidate(s) collide with the required source under the current feature schema.`);
  const unreviewed = higher.filter((value) => value.labelState === "unreviewed");
  const negatives = higher.filter((value) => value.labelState === "negative");
  if (unreviewed.length > 0) {
    return {
      primaryCause: "unresolved",
      contributingCauses: negatives.length > 0 ? ["model_capacity"] : [],
      diagnosisReasons: [`${unreviewed.length} higher-ranked candidate(s) are unreviewed, so the audit cannot call them false positives.`]
    };
  }
  if (negatives.length > 0) return diagnosis("model_capacity", "Reviewed negatives outrank the required source despite distinct feature vectors.");
  return diagnosis("unresolved", "Insufficient reviewed contrast exists above the required source.");
}

function diagnosis(primaryCause: RankabilityFailureCause, reason: string): Pick<RequiredFileAudit, "primaryCause" | "contributingCauses" | "diagnosisReasons"> {
  return { primaryCause, contributingCauses: [], diagnosisReasons: [reason] };
}

function buildModelMetrics(
  source: RankabilityInput,
  model: EvidenceRankerArtifact,
  rankings: Map<string, Map<string, RankedCandidate[]>>,
  cohort: "required_source" | "weak_patch_calibration"
): RankabilityModelMetrics {
  const required = source.cases.filter((item) => item.cohorts.includes(cohort)).map((item) => ({
    item,
    ranks: cohortPaths(item, cohort).map((filePath) => rankings.get(item.id)!.get(model.modelId)!.find((value) => value.candidate.path === filePath)?.rank ?? null)
  }));
  const fileRanks = required.flatMap((item) => item.ranks);
  const samples = source.cases.filter((item) => item.cohorts.includes("weak_patch_calibration")).flatMap((item) =>
    rankings.get(item.id)!.get(model.modelId)!.filter((value) => value.candidate.label !== null)
      .map((value) => ({ probability: value.probability, label: value.candidate.label! })));
  const violations = required.flatMap(({ item }) => {
    const top = rankings.get(item.id)!.get(model.modelId)![0];
    return top && featureVector(top.candidate.features).generatedVendor > 0 ? [item.id] : [];
  });
  return {
    modelId: model.modelId,
    cases: required.length,
    requiredFiles: fileRanks.length,
    strictFullRecallAt1: strictRecall(required, 1),
    strictFullRecallAt5: strictRecall(required, 5),
    strictFullRecallAt64: strictRecall(required, 64),
    strictFullRecallAt128: strictRecall(required, 128),
    requiredFileRecallAt1: fileRecall(fileRanks, 1),
    requiredFileRecallAt5: fileRecall(fileRanks, 5),
    requiredFileRecallAt64: fileRecall(fileRanks, 64),
    requiredFileRecallAt128: fileRecall(fileRanks, 128),
    mrr: estimate(null, fileRanks.length, mean(fileRanks.map((rank) => rank === null ? 0 : 1 / rank))),
    medianRequiredFileRank: median(fileRanks.filter((rank): rank is number => rank !== null)),
    expectedCalibrationError: estimate(null, samples.length, ece(samples)),
    brierScore: estimate(null, samples.length, mean(samples.map((sample) => (sample.probability - sample.label) ** 2))),
    logLoss: estimate(null, samples.length, mean(samples.map((sample) => logLoss(sample.probability, sample.label)))),
    generatedVendorTopOneViolations: violations,
    perLanguage: grouped(required, (item) => item.language),
    perScenario: grouped(required, (item) => item.scenario)
  };
}

function buildCandidateComparison(source: RankabilityInput): CandidateComparison {
  const cases = source.candidateOracle;
  const missingSemanticCases = cases.filter((item) => item.semantic === null).map((item) => item.id);
  const deterministic = candidateMetrics(cases, "deterministic");
  const valid = cases.length === 38 && missingSemanticCases.length === 0;
  const semantic = valid ? candidateMetrics(cases, "semantic") : null;
  const misses: CandidateComparison["misses"] = [];
  for (const item of cases) {
    for (const arm of ["deterministic", "semantic"] as const) {
      const value = arm === "deterministic" ? item.deterministic : item.semantic;
      if (!value) continue;
      const at64 = item.requiredFiles.filter((file) => !value.initial64.includes(file));
      const at128 = item.requiredFiles.filter((file) => !value.bounded128.includes(file));
      if (at64.length > 0 || at128.length > 0) misses.push({ arm, caseId: item.id, at64, at128 });
    }
  }
  return {
    valid,
    expectedCases: 38,
    comparedCases: valid ? 38 : cases.length - missingSemanticCases.length,
    baselineGeneratorId: "deterministic-frozen-v73",
    candidateGeneratorId: `semantic-frozen-${source.provenance.semanticOracleGeneratorCommit}`,
    missingSemanticCases,
    deterministic,
    semantic,
    deltas: semantic ? candidateDeltas(cases, deterministic, semantic) : null,
    perLanguage: candidateStrata(cases, (item) => item.language),
    perScenario: candidateStrata(cases, (item) => item.scenario),
    misses
  };
}

function candidateStrata(cases: CandidateOracleInput[], key: (item: CandidateOracleInput) => string): Record<string, CandidateStratumComparison> {
  const groups = new Map<string, CandidateOracleInput[]>();
  for (const item of cases) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, items]) => {
    const deterministic = candidateMetrics(items, "deterministic");
    const semantic = items.every((item) => item.semantic !== null) ? candidateMetrics(items, "semantic") : null;
    return [name, {
      cases: items.length,
      requiredFiles: items.reduce((sum, item) => sum + item.requiredFiles.length, 0),
      deterministic,
      semantic,
      deltas: semantic ? candidateDeltas(items, deterministic, semantic) : null
    }];
  }));
}

function candidateDeltas(cases: CandidateOracleInput[], baseline: CandidateMetrics, candidate: CandidateMetrics): NonNullable<CandidateComparison["deltas"]> {
  const paired = cases.filter((item) => item.semantic !== null).map((item) => ({
    baselineStrict64: allWithin(item.requiredFiles, item.deterministic.initial64) ? 1 : 0,
    candidateStrict64: allWithin(item.requiredFiles, item.semantic!.initial64) ? 1 : 0,
    baselineStrict128: allWithin(item.requiredFiles, item.deterministic.bounded128) ? 1 : 0,
    candidateStrict128: allWithin(item.requiredFiles, item.semantic!.bounded128) ? 1 : 0,
    baselineFile64: pathRecall(item.requiredFiles, item.deterministic.initial64),
    candidateFile64: pathRecall(item.requiredFiles, item.semantic!.initial64),
    baselineFile128: pathRecall(item.requiredFiles, item.deterministic.bounded128),
    candidateFile128: pathRecall(item.requiredFiles, item.semantic!.bounded128)
  }));
  return {
    strictFullRecallAt64: delta(baseline.strictFullRecallAt64.value, candidate.strictFullRecallAt64.value, paired.map((item) => item.baselineStrict64), paired.map((item) => item.candidateStrict64)),
    strictFullRecallAt128: delta(baseline.strictFullRecallAt128.value, candidate.strictFullRecallAt128.value, paired.map((item) => item.baselineStrict128), paired.map((item) => item.candidateStrict128)),
    requiredFileRecallAt64: delta(baseline.requiredFileRecallAt64.value, candidate.requiredFileRecallAt64.value, paired.map((item) => item.baselineFile64), paired.map((item) => item.candidateFile64)),
    requiredFileRecallAt128: delta(baseline.requiredFileRecallAt128.value, candidate.requiredFileRecallAt128.value, paired.map((item) => item.baselineFile128), paired.map((item) => item.candidateFile128))
  };
}

function candidateMetrics(cases: CandidateOracleInput[], arm: "deterministic" | "semantic"): CandidateMetrics {
  const available = arm === "deterministic" ? cases : cases.filter((item) => item.semantic !== null);
  const rows = available.map((item) => {
    const value = arm === "deterministic" ? item.deterministic : item.semantic!;
    return {
      at64: item.requiredFiles.map((file) => rankOf(value.initial64, file)),
      at128: item.requiredFiles.map((file) => rankOf(value.bounded128, file))
    };
  });
  const at64 = rows.flatMap((row) => row.at64);
  const at128 = rows.flatMap((row) => row.at128);
  return {
    cases: available.length,
    requiredFiles: at64.length,
    strictFullRecallAt64: estimate(rows.filter((row) => row.at64.every((rank) => rank !== null && rank <= 64)).length, rows.length),
    strictFullRecallAt128: estimate(rows.filter((row) => row.at128.every((rank) => rank !== null && rank <= 128)).length, rows.length),
    requiredFileRecallAt64: fileRecall(at64, 64),
    requiredFileRecallAt128: fileRecall(at128, 128)
  };
}

function compareModels(
  source: RankabilityInput,
  rankings: Map<string, Map<string, RankedCandidate[]>>,
  baseline: RankabilityModelMetrics,
  candidate: RankabilityModelMetrics,
  baselineId: string,
  candidateId: string,
  cohort: "required_source" | "weak_patch_calibration"
): NonNullable<RankabilityAudit["modelComparison"]> {
  const cases = source.cases.filter((item) => item.cohorts.includes(cohort));
  const values = cases.map((item) => {
    const paths = cohortPaths(item, cohort);
    const left = paths.map((filePath) => rankings.get(item.id)!.get(baselineId)!.find((value) => value.candidate.path === filePath)?.rank ?? null);
    const right = paths.map((filePath) => rankings.get(item.id)!.get(candidateId)!.find((value) => value.candidate.path === filePath)?.rank ?? null);
    return {
      language: item.language,
      scenario: item.scenario,
      requiredFiles: paths.length,
      leftRecall5: fileRecallValue(left, 5), rightRecall5: fileRecallValue(right, 5),
      leftMrr: mean(left.map(reciprocal)), rightMrr: mean(right.map(reciprocal)),
      leftStrict64: left.every((rank) => rank !== null && rank <= 64) ? 1 : 0,
      rightStrict64: right.every((rank) => rank !== null && rank <= 64) ? 1 : 0
    };
  });
  return {
    baselineModelId: baselineId,
    candidateModelId: candidateId,
    recallAt5: delta(baseline.requiredFileRecallAt5.value, candidate.requiredFileRecallAt5.value, values.map((item) => item.leftRecall5), values.map((item) => item.rightRecall5)),
    mrr: delta(baseline.mrr.value, candidate.mrr.value, values.map((item) => item.leftMrr), values.map((item) => item.rightMrr)),
    strictFullRecallAt64: delta(baseline.strictFullRecallAt64.value, candidate.strictFullRecallAt64.value, values.map((item) => item.leftStrict64), values.map((item) => item.rightStrict64)),
    perLanguage: modelStrata(values, (item) => item.language),
    perScenario: modelStrata(values, (item) => item.scenario),
    negativeRankMovements: cases.flatMap((item) => cohortPaths(item, cohort).flatMap((filePath) => {
      const baselineRank = rankings.get(item.id)!.get(baselineId)!.find((value) => value.candidate.path === filePath)?.rank ?? null;
      const candidateRank = rankings.get(item.id)!.get(candidateId)!.find((value) => value.candidate.path === filePath)?.rank ?? null;
      return baselineRank !== null && candidateRank !== null && candidateRank > baselineRank
        ? [{ caseId: item.id, path: filePath, baselineRank, candidateRank, delta: candidateRank - baselineRank }] : [];
    })).sort((left, right) => (right.delta ?? 0) - (left.delta ?? 0) || left.caseId.localeCompare(right.caseId))
  };
}

function modelStrata<T extends { language: string; scenario: string; requiredFiles: number; leftRecall5: number; rightRecall5: number; leftMrr: number; rightMrr: number; leftStrict64: number; rightStrict64: number }>(
  values: T[],
  key: (item: T) => string
): Record<string, ModelStratumComparison> {
  const groups = new Map<string, T[]>();
  for (const item of values) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, items]) => [name, {
    cases: items.length,
    requiredFiles: items.reduce((sum, item) => sum + item.requiredFiles, 0),
    recallAt5: delta(mean(items.map((item) => item.leftRecall5)), mean(items.map((item) => item.rightRecall5)), items.map((item) => item.leftRecall5), items.map((item) => item.rightRecall5)),
    mrr: delta(mean(items.map((item) => item.leftMrr)), mean(items.map((item) => item.rightMrr)), items.map((item) => item.leftMrr), items.map((item) => item.rightMrr)),
    strictFullRecallAt64: delta(mean(items.map((item) => item.leftStrict64)), mean(items.map((item) => item.rightStrict64)), items.map((item) => item.leftStrict64), items.map((item) => item.rightStrict64))
  }]));
}

function classifyAudit(infrastructureValid: boolean, dataValid: boolean, source: RankabilityInput, metrics: RankabilityModelMetrics, comparison: RankabilityAudit["modelComparison"]): BenchmarkRunClassification {
  if (!infrastructureValid) return "infrastructure_invalid";
  if (!dataValid) return "data_invalid";
  const boundedMiss = source.candidateOracle.some((item) => item.semantic && item.requiredFiles.some((file) => !item.semantic!.bounded128.includes(file)));
  const languageGate = Object.values(metrics.perLanguage).every((item) => item.strictFullRecallAt64 >= 0.95);
  const gates = !boundedMiss && metrics.strictFullRecallAt64.value >= 0.99 && languageGate && metrics.expectedCalibrationError.value <= 0.05 && metrics.generatedVendorTopOneViolations.length === 0;
  if (!gates || !comparison || comparison.recallAt5.absoluteDelta < -0.02 || comparison.mrr.absoluteDelta < -0.02) return "completed_negative";
  return comparison.recallAt5.ci95.lower > 0 || comparison.mrr.ci95.lower > 0 || comparison.strictFullRecallAt64.ci95.lower > 0
    ? "completed_positive" : "completed_noninferior";
}

function chooseNextExperiment(candidateComparison: CandidateComparison, root: RankabilityAudit["rootCauses"], ceilings: RankabilityDiagnosticCeilings, dataValid: boolean): RankabilityAudit["nextExperiment"] {
  if (!dataValid) return { kind: "expand_reviewed_data", reason: "Audit inputs are incomplete or invalid; no mechanism change is authorized." };
  const semanticCoverageMisses = candidateComparison.misses.filter((item) => item.arm === "semantic" && item.at128.length > 0);
  if (semanticCoverageMisses.length > 0) return {
    kind: "candidate_generation",
    reason: `${semanticCoverageMisses.length} of ${candidateComparison.comparedCases} frozen semantic-oracle cases still miss required source at bounded pool@128; the ranker remains frozen.`
  };
  if (root.byRequiredFile.candidate_coverage > 0) return { kind: "candidate_generation", reason: "A required file is absent from the bounded pool, which no reranker can repair." };
  if (root.byRequiredFile.label_quality > 0) return { kind: "label_repair", reason: "Required-source label integrity fails before model comparison." };
  if (root.byRequiredFile.feature_representation > 0) return { kind: "feature_representation", reason: "Reviewed negatives collide with required files under the current feature schema." };
  if (ceilings.pairwiseLinear.verdict === "confirmed_gain") return { kind: "pairwise_ranker", reason: "Grouped pairwise-linear diagnostics improve ranking with existing features." };
  if (ceilings.shallowNonlinear.verdict === "confirmed_gain") return { kind: "nonlinear_ranker", reason: "Only the grouped nonlinear diagnostic finds a reliable gain from existing features." };
  if (root.byRequiredFile.unresolved > 0 || ceilings.evidenceStrength === "insufficient") return { kind: "expand_reviewed_data", reason: "Unreviewed contrasts or cohort size prevent a defensible reranker choice." };
  return { kind: "none", reason: "No unresolved top-five rankability failure remains." };
}

function validateAuditData(input: RankabilityInput): string[] {
  const failures: string[] = [];
  if (!input.provenance.sourceReconstructionExact) failures.push("Frozen source reconstruction is not exact.");
  if (!input.provenance.semanticOracleComplete) failures.push("Semantic candidate reconstruction is not marked complete.");
  if (input.provenance.semanticOracleSelectedCases !== 38) failures.push(`Semantic candidate reconstruction selected ${input.provenance.semanticOracleSelectedCases}/38 oracle cases.`);
  if (input.detachedHoldoutOpened) failures.push("Detached holdout was opened.");
  if (input.candidateOracle.length !== 38) failures.push(`Candidate oracle contains ${input.candidateOracle.length}/38 cases.`);
  const missingSemantic = input.candidateOracle.filter((item) => item.semantic === null).length;
  if (missingSemantic > 0) failures.push(`Semantic candidate reconstruction is incomplete for ${missingSemantic} oracle cases.`);
  const requiredCases = input.cases.filter((item) => item.cohorts.includes("required_source"));
  if (requiredCases.length !== 10) failures.push(`Required-source cohort contains ${requiredCases.length}/10 cases.`);
  const requiredFiles = requiredCases.flatMap((item) => item.requiredFiles);
  if (requiredFiles.length !== 17) failures.push(`Required-source cohort contains ${requiredFiles.length}/17 files.`);
  const missingHashes = requiredFiles.filter((item) => item.contentHashStatus !== "verified" || item.contentSha256 === null).length;
  if (missingHashes > 0) failures.push(`${missingHashes} required source file(s) lack verified content SHA-256.`);
  if (input.cohortCounts.weakPatchCalibrationCases !== 45) failures.push(`Weak-patch calibration cohort contains ${input.cohortCounts.weakPatchCalibrationCases}/45 cases.`);
  if (input.recordedBaselines.length !== 4) failures.push(`Recorded baseline contract contains ${input.recordedBaselines.length}/4 evaluations.`);
  for (const cohort of ["required_source", "weak_patch_calibration"] as const) {
    const baselines = input.recordedBaselines.filter((item) => item.cohort === cohort);
    if (baselines.length !== 2) failures.push(`${cohort} recorded baseline contract contains ${baselines.length}/2 models.`);
    if (new Set(baselines.map((item) => item.modelId)).size !== baselines.length) failures.push(`${cohort} recorded baseline contract contains duplicate model ids.`);
  }
  for (const item of input.cases) {
    if (item.stages.bounded128.length > 128) failures.push(`${item.id}: bounded pool exceeds 128 files.`);
    if (new Set(item.candidates.map((candidate) => candidate.path)).size !== item.candidates.length) failures.push(`${item.id}: candidate pool contains duplicate paths.`);
    for (const required of item.requiredFiles) {
      const candidate = item.candidates.find((value) => value.path === required.path);
      if (candidate && (candidate.label !== 1 || candidate.labelProvenance !== "required_source_oracle")) failures.push(`${item.id}:${required.path}: required-source label provenance is invalid.`);
    }
    for (const candidate of item.candidates) {
      if (candidate.features.length !== EVIDENCE_FEATURE_NAMES.length || candidate.features.some((value) => !Number.isFinite(value))) failures.push(`${item.id}:${candidate.path}: feature vector is invalid.`);
      if (candidate.label !== null && candidate.labelProvenance === null) failures.push(`${item.id}:${candidate.path}: labeled row lacks provenance.`);
    }
  }
  return [...new Set(failures)].sort();
}

function assertModelIdentity(input: RankabilityInput, models: EvidenceRankerArtifact[]): void {
  if (models.length < 2) throw new Error("rankability audit requires at least two models");
  for (const model of models) {
    const pinned = input.models.find((item) => item.id === model.modelId);
    if (!pinned || pinned.checksum !== model.checksum) throw new Error(`model ${model.modelId} does not match the frozen audit input`);
    if (model.featureSchemaVersion !== input.featureSchemaVersion) throw new Error(`model ${model.modelId} feature schema does not match the audit input`);
  }
}

function summarizeRootCauses(cases: RankabilityCaseAudit[]): RankabilityAudit["rootCauses"] {
  const blank = (): Record<RankabilityFailureCause, number> => Object.fromEntries(causes().map((cause) => [cause, 0])) as Record<RankabilityFailureCause, number>;
  const byRequiredFile = blank(); const byCase = blank();
  for (const item of cases) { byCase[item.primaryCause] += 1; for (const file of item.requiredFiles) byRequiredFile[file.primaryCause] += 1; }
  return { byRequiredFile, byCase };
}

function grouped(rows: Array<{ item: RankabilityCaseInput; ranks: Array<number | null> }>, key: (item: RankabilityCaseInput) => string): Record<string, GroupMetrics> {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) groups.set(key(row.item), [...(groups.get(key(row.item)) ?? []), row]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => {
    const ranks = items.flatMap((item) => item.ranks);
    return [name, { cases: items.length, requiredFiles: ranks.length, strictFullRecallAt64: ratio(items.filter((item) => item.ranks.every((rank) => rank !== null && rank <= 64)).length, items.length), requiredFileRecallAt5: fileRecallValue(ranks, 5) }];
  }));
}

function delta(baseline: number, candidate: number, baselineCases: number[], candidateCases: number[]): MetricDelta {
  return { baseline, candidate, absoluteDelta: round(candidate - baseline), percentagePointDelta: round((candidate - baseline) * 100), ci95: pairedBootstrap(baselineCases, candidateCases) };
}

function pairedBootstrap(left: number[], right: number[]): MetricDelta["ci95"] {
  if (left.length !== right.length || left.length === 0) return { lower: 0, upper: 0, iterations: 10_000, unit: "case" };
  const random = mulberry32(0x4b414952); const values: number[] = [];
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    let a = 0; let b = 0;
    for (let index = 0; index < left.length; index += 1) { const sampled = Math.floor(random() * left.length); a += left[sampled]!; b += right[sampled]!; }
    values.push(b / left.length - a / left.length);
  }
  values.sort((a, b) => a - b);
  return { lower: round(quantile(values, 0.025)), upper: round(quantile(values, 0.975)), iterations: 10_000, unit: "case" };
}

function featureDifference(left: number[] | undefined, right: number[]): { names: string[]; distance: number; exact: boolean } {
  if (!left) return { names: [...EVIDENCE_FEATURE_NAMES], distance: 1, exact: false };
  const differences = left.map((value, index) => Math.abs(value - right[index]!));
  const names = EVIDENCE_FEATURE_NAMES.filter((_, index) => differences[index]! > 1e-9);
  return { names, distance: round(Math.sqrt(mean(differences.map((value) => value * value)))), exact: names.length === 0 };
}

function limitations(input: RankabilityInput): string[] {
  const required = input.cases.filter((item) => item.cohorts.includes("required_source"));
  const values = [
    "The required-source cohort contains 10 cases and 17 files and is diagnostic, not publication-grade evidence.",
    "Language and scenario coverage is uneven; percentages are reported with explicit denominators.",
    "Weak official-patch positives are evaluated separately from required-source oracles.",
    "Diagnostic ceiling models are promotion-ineligible and never access the detached holdout."
  ];
  if (!required.some((item) => item.language === "python")) values.splice(1, 0, "The required-source cohort contains no Python cases.");
  return values;
}

function cohortPaths(item: RankabilityCaseInput, cohort: "required_source" | "weak_patch_calibration"): string[] {
  return cohort === "required_source" ? item.requiredFiles.map((file) => file.path) : item.officialPatchFiles;
}

function allWithin(required: string[], candidates: string[]): boolean {
  const paths = new Set(candidates);
  return required.every((filePath) => paths.has(filePath));
}

function pathRecall(required: string[], candidates: string[]): number {
  const paths = new Set(candidates);
  return ratio(required.filter((filePath) => paths.has(filePath)).length, required.length);
}

function parseInput(value: unknown): RankabilityInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rankability input must be an object");
  const input = value as RankabilityInput;
  if (input.schemaVersion !== RANKABILITY_INPUT_SCHEMA || input.promotionEligible !== false || input.detachedHoldoutOpened !== false || !Array.isArray(input.cases) || !Array.isArray(input.candidateOracle)) throw new Error("invalid rankability-input.v2 artifact");
  return input;
}

function strictRecall(rows: Array<{ ranks: Array<number | null> }>, limit: number): MetricEstimate { return estimate(rows.filter((item) => item.ranks.every((rank) => rank !== null && rank <= limit)).length, rows.length); }
function fileRecall(ranks: Array<number | null>, limit: number): MetricEstimate { return estimate(ranks.filter((rank) => rank !== null && rank <= limit).length, ranks.length); }
function fileRecallValue(ranks: Array<number | null>, limit: number): number { return ratio(ranks.filter((rank) => rank !== null && rank <= limit).length, ranks.length); }
function estimate(numerator: number | null, denominator: number, value?: number): MetricEstimate { return { numerator, denominator, value: round(value ?? ratio(numerator ?? 0, denominator)) }; }
function featureVector(values: number[]): EvidenceFeatureVector { if (values.length !== EVIDENCE_FEATURE_NAMES.length) throw new Error("feature vector length mismatch"); return Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name, index) => [name, values[index]!])) as EvidenceFeatureVector; }
function strongestCause(values: RankabilityFailureCause[]): RankabilityFailureCause { return causes().find((cause) => values.includes(cause)) ?? "unresolved"; }
function causes(): RankabilityFailureCause[] { return ["candidate_coverage", "label_quality", "feature_representation", "model_capacity", "unresolved", "ranked"]; }
function rankOf(paths: string[], target: string): number | null { const index = paths.indexOf(target); return index < 0 ? null : index + 1; }
function reciprocal(rank: number | null): number { return rank === null ? 0 : 1 / rank; }
function ece(samples: Array<{ probability: number; label: 0 | 1 }>): number { if (samples.length === 0) return 0; let total = 0; for (let bin = 0; bin < 10; bin += 1) { const values = samples.filter((sample) => sample.probability >= bin / 10 && (sample.probability < (bin + 1) / 10 || bin === 9 && sample.probability === 1)); if (values.length > 0) total += values.length / samples.length * Math.abs(mean(values.map((item) => item.label)) - mean(values.map((item) => item.probability))); } return round(total); }
function logLoss(probability: number, label: 0 | 1): number { const value = Math.min(1 - 1e-12, Math.max(1e-12, probability)); return -(label * Math.log(value) + (1 - label) * Math.log(1 - value)); }
function median(values: number[]): number | null { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!; }
function mean(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 0 : numerator / denominator; }
function round(value: number): number { return Number(value.toFixed(9)); }
function digest(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function quantile(values: number[], probability: number): number { return values[Math.min(values.length - 1, Math.max(0, Math.floor(probability * values.length)))] ?? 0; }
function mulberry32(seed: number): () => number { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
function percent(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function signed(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(4)}`; }
function points(value: number): string { return `${value >= 0 ? "+" : ""}${value.toFixed(2)} pp`; }
function formatMetric(metric: MetricEstimate): string { return `${metric.numerator ?? "—"}/${metric.denominator} (${percent(metric.value)})`; }
