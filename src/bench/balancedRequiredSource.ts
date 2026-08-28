// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LANGUAGES = ["python", "typescript", "go", "java", "cpp"] as const;
const SCENARIOS = ["source_localization", "failure_first", "long_session"] as const;
const BASE_FEATURES = [
  "exactPath", "basenameMatch", "exactSymbol", "symbolPrefix", "bm25", "keyword", "semantic",
  "failureReference", "gitChanged", "alreadyDelivered", "graphNeighbor", "graphPrecision",
  "graphConsensus", "graphSupport", "graphSeedStrength", "graphIndependentEvidence", "sourceTestPair",
  "productionSource", "testFile", "docsFile", "generatedVendor", "intentRoleMatch", "importance",
  "contentCost", "missingSymbols", "missingLexical"
] as const;
const DOCUMENT_FEATURES = ["semanticFile", "semanticSymbol", "missingSemanticFile", "missingSemanticSymbol"] as const;

type Language = (typeof LANGUAGES)[number];
type Scenario = (typeof SCENARIOS)[number];
type Metric = { numerator: number; denominator: number; value: number };
type CohortCase = {
  id: string;
  language: Language;
  scenario: Scenario;
  requiredExistingFiles: string[];
  excludedExistingPatchFiles: string[];
  creationFilesExcludedFromRecall: string[];
  review: string;
};
type CohortManifest = {
  schemaVersion: "balanced-required-source-cohort.v1";
  cohortId: string;
  promotionEligible: false;
  selection: { caseCount: 15; languageCount: 5; scenarioCount: 3; rankInspectionDisclosure: string };
  evidencePolicy: { developmentOnly: true; publicClaimEligible: false; reason: string; publicProofRequires: string };
  holdout: { status: "contaminated_do_not_use"; eventId: string; replacementRequired: true };
  inputs: {
    candidateManifest: ArtifactReference;
    candidateReport: ArtifactReference;
    baselineModel: ArtifactReference & { id: string };
  };
  stoppingRule: {
    maximumMechanismExperiments: 1;
    minimumRequiredFileRecallAt64AbsoluteGain: number;
    expectedCalibrationErrorMax: number;
    recallAt5NoninferiorityMargin: number;
    mrrNoninferiorityMargin: number;
    noGeneratedVendorTopOne: true;
  };
  cases: CohortCase[];
};
type ArtifactReference = { path: string; sha256: string };
type SourceCandidate = { path: string; features: Record<string, number> };
type SourceCase = {
  id: string;
  split: string;
  language: Language;
  scenario: Scenario;
  trainingCandidates: SourceCandidate[];
};
type SourceManifest = { cases: SourceCase[] };
type SourceReportCase = {
  id: string;
  officialPatchSourceExistingFiles: string[];
  officialPatchSourceCreationFiles: string[];
  candidateDiagnostics?: { semanticInteractions?: SemanticInteraction[] };
};
type SemanticInteraction = { path: string; fileSimilarity?: number | null; symbolSimilarity?: number | null };
type BaselineArtifact = {
  model: {
    kind: string;
    intercept: number;
    coefficients: Record<string, number>;
    calibration: { kind: "platt"; a: number; b: number };
  };
  calibrationEce: number;
};
type CaseRow = {
  id: string;
  language: Language;
  scenario: Scenario;
  requiredFileRanks: Record<string, number | null>;
  requiredFilesAt1: number;
  requiredFilesAt5: number;
  requiredFilesAt64: number;
  requiredFilesAt128: number;
  strictFullRecallAt64: boolean;
  strictFullRecallAt128: boolean;
  generatedVendorTopOne: boolean;
  topFiveMisses: string[];
  top64Misses: string[];
};

export type BalancedRequiredSourceEvaluation = {
  schemaVersion: "balanced-required-source-evaluation.v1";
  status: "completed_baseline";
  promotionEligible: false;
  cohortId: string;
  modelId: string;
  inputs: { cohortSha256: string; candidateManifestSha256: string; candidateReportSha256: string; baselineModelSha256: string };
  validation: {
    valid: true;
    exactCellCoverage: true;
    deterministicSelectionVerified: true;
    calibrationOnly: true;
    holdoutAccessed: false;
    allRequiredFilesInBoundedPool: boolean;
    limitations: string[];
  };
  metrics: {
    cases: number;
    requiredFiles: number;
    strictFullRecallAt64: Metric;
    strictFullRecallAt128: Metric;
    requiredFileRecallAt1: Metric;
    requiredFileRecallAt5: Metric;
    requiredFileRecallAt64: Metric;
    requiredFileRecallAt128: Metric;
    mrr: Metric;
    medianRequiredFileRank: number | null;
    calibrationEce: number;
    generatedVendorTopOneViolations: string[];
    perLanguage: Record<string, StratumMetrics>;
    perScenario: Record<string, StratumMetrics>;
  };
  diagnosis: {
    dominantFailureMechanism: "candidate_coverage" | "ranker_ordering" | "none_at_recall64";
    boundedPoolMisses: Array<{ caseId: string; paths: string[] }>;
    servedTop64Misses: Array<{ caseId: string; paths: string[] }>;
    remainingTopFiveMisses: Array<{ caseId: string; paths: string[] }>;
  };
  stoppingDecision: {
    rankingExperimentAuthorized: boolean;
    experimentsUsed: 0;
    experimentsRemaining: 0 | 1;
    decision: "preregister_one_mechanism_experiment" | "freeze_ranking";
    reason: string;
    qualifyingGain: { absoluteRequiredFileRecallAt64: number; orPairedCiLowerBoundAboveZero: true };
  };
  cases: CaseRow[];
};

type StratumMetrics = {
  cases: number;
  requiredFiles: number;
  strictFullRecallAt64: number;
  requiredFileRecallAt5: number;
  requiredFileRecallAt64: number;
  mrr: number;
};

export function evaluateBalancedRequiredSource(options: {
  cohortPath: string;
  repositoryRoot?: string;
}): BalancedRequiredSourceEvaluation {
  const cohortPath = path.resolve(options.cohortPath);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? findRepositoryRoot(path.dirname(cohortPath)));
  const cohortBytes = fs.readFileSync(cohortPath);
  const cohort = parseCohort(JSON.parse(cohortBytes.toString("utf8")) as unknown);
  const manifestBytes = verifiedArtifact(repositoryRoot, cohort.inputs.candidateManifest);
  const reportBytes = verifiedArtifact(repositoryRoot, cohort.inputs.candidateReport);
  const modelBytes = verifiedArtifact(repositoryRoot, cohort.inputs.baselineModel);
  const source = JSON.parse(manifestBytes.toString("utf8")) as SourceManifest;
  const report = JSON.parse(reportBytes.toString("utf8")) as { cases: SourceReportCase[] };
  const baseline = JSON.parse(modelBytes.toString("utf8")) as BaselineArtifact;
  const sourceById = new Map(source.cases.map((item) => [item.id, item]));
  const reportById = new Map(report.cases.map((item) => [item.id, item]));
  validateCohortAgainstSource(cohort, source, sourceById, reportById);

  const caseRows = cohort.cases.map((cohortCase) => rankCase(
    cohortCase,
    sourceById.get(cohortCase.id)!,
    reportById.get(cohortCase.id)!,
    baseline
  ));
  const metrics = buildMetrics(caseRows, baseline.calibrationEce);
  const boundedPoolMisses = cohort.cases.flatMap((cohortCase) => {
    const pool = new Set(sourceById.get(cohortCase.id)!.trainingCandidates.map((item) => item.path));
    const paths = cohortCase.requiredExistingFiles.filter((item) => !pool.has(item));
    return paths.length ? [{ caseId: cohortCase.id, paths }] : [];
  });
  const servedTop64Misses = caseRows.filter((item) => item.top64Misses.length > 0)
    .map((item) => ({ caseId: item.id, paths: item.top64Misses }));
  const remainingTopFiveMisses = caseRows.filter((item) => item.topFiveMisses.length > 0)
    .map((item) => ({ caseId: item.id, paths: item.topFiveMisses }));
  const dominantFailureMechanism = boundedPoolMisses.length > 0
    ? "candidate_coverage" as const
    : servedTop64Misses.length > 0
      ? "ranker_ordering" as const
      : "none_at_recall64" as const;
  const rankingExperimentAuthorized = metrics.requiredFileRecallAt64.value < 1;
  return {
    schemaVersion: "balanced-required-source-evaluation.v1",
    status: "completed_baseline",
    promotionEligible: false,
    cohortId: cohort.cohortId,
    modelId: cohort.inputs.baselineModel.id,
    inputs: {
      cohortSha256: digest(cohortBytes),
      candidateManifestSha256: digest(manifestBytes),
      candidateReportSha256: digest(reportBytes),
      baselineModelSha256: digest(modelBytes)
    },
    validation: {
      valid: true,
      exactCellCoverage: true,
      deterministicSelectionVerified: true,
      calibrationOnly: true,
      holdoutAccessed: false,
      allRequiredFilesInBoundedPool: boundedPoolMisses.length === 0,
      limitations: [
        cohort.selection.rankInspectionDisclosure,
        cohort.evidencePolicy.reason,
        cohort.evidencePolicy.publicProofRequires
      ]
    },
    metrics,
    diagnosis: { dominantFailureMechanism, boundedPoolMisses, servedTop64Misses, remainingTopFiveMisses },
    stoppingDecision: {
      rankingExperimentAuthorized,
      experimentsUsed: 0,
      experimentsRemaining: rankingExperimentAuthorized ? 1 : 0,
      decision: rankingExperimentAuthorized ? "preregister_one_mechanism_experiment" : "freeze_ranking",
      reason: rankingExperimentAuthorized
        ? `v185 has ${servedTop64Misses.length} case(s) with a required file outside the served top 64; one mechanism experiment may be preregistered.`
        : "v185 already recalls every reviewed required file within 64 on this cohort, leaving no room for the preregistered +5 percentage-point Recall@64 gain. Further ranking iteration would violate the stopping discipline.",
      qualifyingGain: {
        absoluteRequiredFileRecallAt64: cohort.stoppingRule.minimumRequiredFileRecallAt64AbsoluteGain,
        orPairedCiLowerBoundAboveZero: true
      }
    },
    cases: caseRows
  };
}

export function formatBalancedRequiredSourceMarkdown(value: BalancedRequiredSourceEvaluation): string {
  const pct = (metric: Metric) => `${(100 * metric.value).toFixed(2)}% (${metric.numerator}/${metric.denominator})`;
  const lines = [
    "# Kairn v0.2C balanced required-source baseline",
    "",
    `- Status: **${value.status}**`,
    `- Cohort: \`${value.cohortId}\``,
    `- Model: \`${value.modelId}\``,
    `- Required-file Recall@64: **${pct(value.metrics.requiredFileRecallAt64)}**`,
    `- Strict full case Recall@64: **${pct(value.metrics.strictFullRecallAt64)}**`,
    `- Required-file Recall@5: ${pct(value.metrics.requiredFileRecallAt5)}`,
    `- MRR: ${value.metrics.mrr.value.toFixed(4)}`,
    `- Calibration ECE: ${value.metrics.calibrationEce.toFixed(4)}`,
    `- Generated/vendor top-one violations: ${value.metrics.generatedVendorTopOneViolations.length}`,
    "",
    "## Decision",
    "",
    `**${value.stoppingDecision.decision}.** ${value.stoppingDecision.reason}`,
    "",
    "## Remaining top-five misses",
    "",
    ...(value.diagnosis.remainingTopFiveMisses.length
      ? value.diagnosis.remainingTopFiveMisses.map((item) => `- \`${item.caseId}\`: ${item.paths.map((file) => `\`${file}\``).join(", ")}`)
      : ["- None."]),
    "",
    "## Evidence boundary",
    "",
    ...value.validation.limitations.map((item) => `- ${item}`),
    "- The contaminated detached holdout was not accessed.",
    ""
  ];
  return lines.join("\n");
}

function rankCase(
  cohortCase: CohortCase,
  sourceCase: SourceCase,
  reportCase: SourceReportCase,
  baseline: BaselineArtifact
): CaseRow {
  const interactions = new Map((reportCase.candidateDiagnostics?.semanticInteractions ?? []).map((item) => [item.path, item]));
  const ranked = sourceCase.trainingCandidates.map((candidate) => {
    const rawScore = scoreCandidate(candidate, interactions.get(candidate.path), baseline);
    const priority = numberFeature(candidate, "failureReference") > 0 ? 2 : numberFeature(candidate, "exactPath") > 0 ? 1 : 0;
    return { path: candidate.path, priority, rawScore, generatedVendor: numberFeature(candidate, "generatedVendor") > 0 };
  }).sort((left, right) => right.priority - left.priority || right.rawScore - left.rawScore || left.path.localeCompare(right.path));
  const ranks = new Map(ranked.map((item, index) => [item.path, index + 1]));
  const requiredFileRanks = Object.fromEntries(cohortCase.requiredExistingFiles.map((file) => [file, ranks.get(file) ?? null]));
  const values = Object.values(requiredFileRanks);
  const within = (limit: number) => values.filter((rank) => rank !== null && rank <= limit).length;
  return {
    id: cohortCase.id,
    language: cohortCase.language,
    scenario: cohortCase.scenario,
    requiredFileRanks,
    requiredFilesAt1: within(1),
    requiredFilesAt5: within(5),
    requiredFilesAt64: within(64),
    requiredFilesAt128: within(128),
    strictFullRecallAt64: within(64) === values.length,
    strictFullRecallAt128: within(128) === values.length,
    generatedVendorTopOne: ranked[0]?.generatedVendor ?? false,
    topFiveMisses: cohortCase.requiredExistingFiles.filter((file) => (ranks.get(file) ?? Number.POSITIVE_INFINITY) > 5),
    top64Misses: cohortCase.requiredExistingFiles.filter((file) => (ranks.get(file) ?? Number.POSITIVE_INFINITY) > 64)
  };
}

function scoreCandidate(candidate: SourceCandidate, interaction: SemanticInteraction | undefined, baseline: BaselineArtifact): number {
  let value = baseline.model.intercept;
  for (const feature of BASE_FEATURES) value += numberFeature(candidate, feature) * requiredCoefficient(baseline, feature);
  const file = interaction?.fileSimilarity;
  const symbol = interaction?.symbolSimilarity;
  const documentValues: Record<(typeof DOCUMENT_FEATURES)[number], number> = {
    semanticFile: typeof file === "number" ? clamp01(file) : 0,
    semanticSymbol: typeof symbol === "number" ? clamp01(symbol) : 0,
    missingSemanticFile: typeof file === "number" ? 0 : 1,
    missingSemanticSymbol: typeof symbol === "number" ? 0 : 1
  };
  for (const feature of DOCUMENT_FEATURES) value += documentValues[feature] * requiredCoefficient(baseline, feature);
  return value;
}

function buildMetrics(rows: CaseRow[], calibrationEce: number): BalancedRequiredSourceEvaluation["metrics"] {
  const requiredFiles = rows.reduce((sum, item) => sum + Object.keys(item.requiredFileRanks).length, 0);
  const ranks = rows.flatMap((item) => Object.values(item.requiredFileRanks));
  const finiteRanks = ranks.filter((rank): rank is number => rank !== null).sort((left, right) => left - right);
  const metric = (numerator: number, denominator: number): Metric => ({ numerator, denominator, value: denominator ? numerator / denominator : 0 });
  const groups = (key: "language" | "scenario") => Object.fromEntries(
    [...new Set(rows.map((item) => item[key]))].sort().map((name) => {
      const selected = rows.filter((item) => item[key] === name);
      const count = selected.reduce((sum, item) => sum + Object.keys(item.requiredFileRanks).length, 0);
      const groupRanks = selected.flatMap((item) => Object.values(item.requiredFileRanks));
      return [name, {
        cases: selected.length,
        requiredFiles: count,
        strictFullRecallAt64: selected.filter((item) => item.strictFullRecallAt64).length / selected.length,
        requiredFileRecallAt5: groupRanks.filter((rank) => rank !== null && rank <= 5).length / count,
        requiredFileRecallAt64: groupRanks.filter((rank) => rank !== null && rank <= 64).length / count,
        mrr: groupRanks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / count
      } satisfies StratumMetrics];
    })
  );
  const midpoint = Math.floor(finiteRanks.length / 2);
  const median = finiteRanks.length === 0 ? null : finiteRanks.length % 2
    ? finiteRanks[midpoint]!
    : (finiteRanks[midpoint - 1]! + finiteRanks[midpoint]!) / 2;
  return {
    cases: rows.length,
    requiredFiles,
    strictFullRecallAt64: metric(rows.filter((item) => item.strictFullRecallAt64).length, rows.length),
    strictFullRecallAt128: metric(rows.filter((item) => item.strictFullRecallAt128).length, rows.length),
    requiredFileRecallAt1: metric(rows.reduce((sum, item) => sum + item.requiredFilesAt1, 0), requiredFiles),
    requiredFileRecallAt5: metric(rows.reduce((sum, item) => sum + item.requiredFilesAt5, 0), requiredFiles),
    requiredFileRecallAt64: metric(rows.reduce((sum, item) => sum + item.requiredFilesAt64, 0), requiredFiles),
    requiredFileRecallAt128: metric(rows.reduce((sum, item) => sum + item.requiredFilesAt128, 0), requiredFiles),
    mrr: metric(ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0), requiredFiles),
    medianRequiredFileRank: median,
    calibrationEce,
    generatedVendorTopOneViolations: rows.filter((item) => item.generatedVendorTopOne).map((item) => item.id),
    perLanguage: groups("language"),
    perScenario: groups("scenario")
  };
}

function validateCohortAgainstSource(
  cohort: CohortManifest,
  source: SourceManifest,
  sourceById: Map<string, SourceCase>,
  reportById: Map<string, SourceReportCase>
): void {
  const expectedCells = new Set(LANGUAGES.flatMap((language) => SCENARIOS.map((scenario) => `${language}/${scenario}`)));
  const actualCells = new Set(cohort.cases.map((item) => `${item.language}/${item.scenario}`));
  if (cohort.cases.length !== 15 || actualCells.size !== 15 || [...expectedCells].some((cell) => !actualCells.has(cell))) {
    throw new Error("balanced cohort must contain exactly one case in every language/scenario cell");
  }
  for (const item of cohort.cases) {
    const sourceCase = sourceById.get(item.id);
    const reportCase = reportById.get(item.id);
    if (!sourceCase || !reportCase) throw new Error(`${item.id}: missing frozen source materialization`);
    if (sourceCase.split !== "calibration") throw new Error(`${item.id}: balanced cohort may only use calibration cases`);
    if (sourceCase.language !== item.language || sourceCase.scenario !== item.scenario) throw new Error(`${item.id}: cell metadata mismatch`);
    const first = source.cases.filter((candidate) => candidate.split === "calibration" && candidate.language === item.language && candidate.scenario === item.scenario)
      .map((candidate) => candidate.id).sort()[0];
    if (first !== item.id) throw new Error(`${item.id}: violates deterministic first-case selection rule; expected ${first ?? "none"}`);
    if (item.requiredExistingFiles.length === 0) throw new Error(`${item.id}: required-source review is empty`);
    const official = new Set(reportCase.officialPatchSourceExistingFiles);
    const reviewedPatch = new Set([...item.requiredExistingFiles, ...item.excludedExistingPatchFiles]);
    if ([...official].some((file) => !reviewedPatch.has(file)) || [...reviewedPatch].some((file) => !official.has(file))) {
      throw new Error(`${item.id}: every existing production patch file must receive exactly one review decision`);
    }
    if (new Set(item.creationFilesExcludedFromRecall).size !== reportCase.officialPatchSourceCreationFiles.length ||
        reportCase.officialPatchSourceCreationFiles.some((file) => !item.creationFilesExcludedFromRecall.includes(file))) {
      throw new Error(`${item.id}: creation-file exclusions do not match the frozen public patch`);
    }
    const pool = new Set(sourceCase.trainingCandidates.map((candidate) => candidate.path));
    for (const file of item.requiredExistingFiles) if (!pool.has(file)) throw new Error(`${item.id}:${file}: required source is outside the bounded pool`);
  }
}

function parseCohort(value: unknown): CohortManifest {
  const cohort = value as Partial<CohortManifest>;
  if (!cohort || cohort.schemaVersion !== "balanced-required-source-cohort.v1" || cohort.promotionEligible !== false) throw new Error("invalid balanced required-source cohort schema");
  if (cohort.holdout?.status !== "contaminated_do_not_use" || cohort.holdout.replacementRequired !== true) throw new Error("contaminated holdout must remain fail-closed");
  if (cohort.evidencePolicy?.developmentOnly !== true || cohort.evidencePolicy.publicClaimEligible !== false) throw new Error("balanced cohort must remain development-only");
  if (!cohort.inputs || !cohort.stoppingRule || !Array.isArray(cohort.cases)) throw new Error("balanced cohort is incomplete");
  if (cohort.stoppingRule.maximumMechanismExperiments !== 1 || cohort.stoppingRule.minimumRequiredFileRecallAt64AbsoluteGain < 0.05) {
    throw new Error("balanced cohort weakens the one-experiment stopping discipline");
  }
  return cohort as CohortManifest;
}

function verifiedArtifact(root: string, reference: ArtifactReference): Buffer {
  const target = path.resolve(root, reference.path);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`artifact path escapes repository: ${reference.path}`);
  const bytes = fs.readFileSync(target);
  if (digest(bytes) !== reference.sha256) throw new Error(`artifact hash mismatch: ${reference.path}`);
  return bytes;
}

function requiredCoefficient(baseline: BaselineArtifact, feature: string): number {
  const value = baseline.model.coefficients[feature];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`v185 coefficient missing for ${feature}`);
  return value;
}

function numberFeature(candidate: SourceCandidate, feature: string): number {
  const value = candidate.features[feature];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${candidate.path}: invalid ${feature} feature`);
  return value;
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function digest(value: crypto.BinaryLike): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("balanced cohort is outside a Kairn checkout");
    current = parent;
  }
}
