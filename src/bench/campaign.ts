// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BENCHMARK_CAMPAIGN_SCHEMA = "benchmark-campaign.v1" as const;
export const BENCHMARK_RUN_SCHEMA = "benchmark-run.v1" as const;

export type BenchmarkStage = "tier_a" | "tier_b" | "calibration" | "holdout" | "live";
export type BenchmarkRunClassification =
  | "infrastructure_invalid"
  | "data_invalid"
  | "completed_negative"
  | "completed_noninferior"
  | "completed_positive";

export type PipelineCampaignArtifact = {
  id: string;
  kind: "case_manifest" | "lineage" | "review" | "candidate_pool" | "training_rows" | "model" | "model_manifest" | "evaluation" | "holdout";
  path: string;
  sha256: string;
  parents: string[];
  allowedStages: BenchmarkStage[];
};

export type BenchmarkCampaign = {
  schemaVersion: typeof BENCHMARK_CAMPAIGN_SCHEMA;
  campaignId: string;
  nonEvidence: boolean;
  source: { branch: string; baseCommit: string };
  runtime: { nodeMajor: 24; pnpm: "10.31.0"; python: "3.12" };
  semantic: {
    modelId: string;
    upstreamRevision: string;
    documentSchemaVersion: string;
    candidateLimit: 64;
    enrichedCandidateLimit: 128;
  };
  cases: {
    artifactId: string;
    expectedCounts: { train: number; calibration: number; holdout: number };
    splitField: string;
    idField: string;
    format: "json_cases" | "jsonl_rows";
  };
  holdout: { status: "sealed_detached" | "opened"; artifactId: string; openedEvaluationId: string | null };
  artifacts: PipelineCampaignArtifact[];
  gates: {
    boundedPoolRequiredSourceMissesAt128: 0;
    servedRecallAt64Overall: number;
    servedRecallAt64PerLanguage: number;
    expectedCalibrationErrorMax: number;
    generatedVendorTopOneMax: 0;
  };
};

export type ResolvedCampaignArtifact = PipelineCampaignArtifact & {
  absolutePath: string;
  bytes: number;
  actualSha256: string;
};

export type ResolvedCampaign = {
  campaign: BenchmarkCampaign;
  manifestPath: string;
  manifestSha256: string;
  artifacts: ResolvedCampaignArtifact[];
  caseIds: Record<"train" | "calibration" | "holdout", string[]>;
  fingerprint: string;
};

export function loadBenchmarkCampaign(manifestPath: string, options?: { verifyArtifacts?: boolean }): ResolvedCampaign {
  const absoluteManifest = path.resolve(manifestPath);
  const bytes = fs.readFileSync(absoluteManifest);
  const campaign = parseBenchmarkCampaign(JSON.parse(bytes.toString("utf8")) as unknown);
  const artifactById = new Map(campaign.artifacts.map((artifact) => [artifact.id, artifact]));
  if (artifactById.size !== campaign.artifacts.length) throw new Error("campaign artifact ids must be unique");
  for (const artifact of campaign.artifacts) {
    for (const parent of artifact.parents) {
      if (!artifactById.has(parent)) throw new Error(`artifact '${artifact.id}' names unknown parent '${parent}'`);
      if (parent === artifact.id) throw new Error(`artifact '${artifact.id}' cannot parent itself`);
    }
  }
  assertAcyclicArtifacts(campaign.artifacts);
  const manifestRoot = path.dirname(absoluteManifest);
  const repositoryRoot = findRepositoryRoot(manifestRoot);
  const resolvedArtifacts = campaign.artifacts.map((artifact): ResolvedCampaignArtifact => {
    const absolutePath = resolveRepositoryArtifact(repositoryRoot, artifact.path);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`campaign artifact '${artifact.id}' is missing: ${artifact.path}`);
    }
    const actualSha256 = fileSha256(absolutePath);
    if (options?.verifyArtifacts !== false && actualSha256 !== artifact.sha256) {
      throw new Error(`campaign artifact '${artifact.id}' hash mismatch`);
    }
    return { ...artifact, absolutePath, bytes: fs.statSync(absolutePath).size, actualSha256 };
  });
  const caseArtifact = resolvedArtifacts.find((artifact) => artifact.id === campaign.cases.artifactId);
  if (!caseArtifact) throw new Error("campaign cases.artifactId does not resolve to an artifact");
  const caseIds = readCaseIds(
    caseArtifact.absolutePath,
    campaign.cases.splitField,
    campaign.cases.idField,
    campaign.cases.format
  );
  for (const split of ["train", "calibration", "holdout"] as const) {
    if (caseIds[split].length !== campaign.cases.expectedCounts[split]) {
      throw new Error(`campaign ${split} case count mismatch: expected ${campaign.cases.expectedCounts[split]}, got ${caseIds[split].length}`);
    }
  }
  const holdoutArtifact = resolvedArtifacts.find((artifact) => artifact.id === campaign.holdout.artifactId);
  if (!holdoutArtifact || holdoutArtifact.kind !== "holdout") throw new Error("campaign holdout artifact is missing or has the wrong kind");
  if (campaign.holdout.status === "sealed_detached") {
    if (campaign.holdout.openedEvaluationId !== null) throw new Error("sealed holdout cannot name an opened evaluation");
    if (holdoutArtifact.allowedStages.some((stage) => stage !== "holdout")) {
      throw new Error("sealed holdout artifact may only be allowed for the holdout stage");
    }
  }
  const fingerprintPayload = {
    campaign,
    manifestSha256: infraSha256(bytes),
    artifacts: resolvedArtifacts.map(({ id, actualSha256 }) => ({ id, sha256: actualSha256 })),
    caseIds
  };
  return {
    campaign,
    manifestPath: absoluteManifest,
    manifestSha256: sha256(bytes),
    artifacts: resolvedArtifacts,
    caseIds,
    fingerprint: infraSha256(JSON.stringify(fingerprintPayload))
  };
}

export function assertStageDoesNotOpenHoldout(resolved: ResolvedCampaign, stage: BenchmarkStage): void {
  if (stage === "holdout") return;
  const forbidden = resolved.artifacts.filter((artifact) => artifact.kind === "holdout" && artifact.allowedStages.includes(stage));
  if (forbidden.length > 0) throw new Error(`${stage} cannot load holdout artifacts: ${forbidden.map((item) => item.id).join(", ")}`);
}

export function derivePipelineCacheKeys(input: {
  repositoryCommit: string;
  parserSchema: string;
  documentSchema: string;
  semanticModelManifest: string;
  tokenizerHash: string;
  candidateGeneratorHash: string;
  candidateConfigHash: string;
  reviewHash: string;
  featureSchemaHash: string;
  trainingConfigHash: string;
}): Record<"inventory" | "embeddings" | "candidates" | "reviews" | "training" | "model", string> {
  const inventory = digestParts("inventory-v1", input.repositoryCommit, input.parserSchema);
  const embeddings = digestParts("embeddings-v1", inventory, input.documentSchema, input.semanticModelManifest, input.tokenizerHash);
  const candidates = digestParts("candidates-v1", embeddings, input.candidateGeneratorHash, input.candidateConfigHash);
  const reviews = digestParts("reviews-v1", candidates, input.reviewHash);
  const training = digestParts("training-v1", reviews, input.featureSchemaHash);
  const model = digestParts("model-v1", training, input.trainingConfigHash);
  return { inventory, embeddings, candidates, reviews, training, model };
}

export function classifyBenchmarkRun(input: {
  infrastructureValid: boolean;
  dataValid: boolean;
  qualityPassed: boolean;
  candidateDelta: number;
  rankingDelta: number;
  noninferiorityMargin: number;
}): BenchmarkRunClassification {
  if (!input.infrastructureValid) return "infrastructure_invalid";
  if (!input.dataValid) return "data_invalid";
  if (!input.qualityPassed || input.candidateDelta < -input.noninferiorityMargin || input.rankingDelta < -input.noninferiorityMargin) {
    return "completed_negative";
  }
  return input.candidateDelta > 0 || input.rankingDelta > 0 ? "completed_positive" : "completed_noninferior";
}

function parseBenchmarkCampaign(value: unknown): BenchmarkCampaign {
  const root = record(value, "campaign");
  if (root.schemaVersion !== BENCHMARK_CAMPAIGN_SCHEMA) throw new Error("unsupported benchmark campaign schema");
  const source = record(root.source, "source");
  const runtime = record(root.runtime, "runtime");
  const semantic = record(root.semantic, "semantic");
  const cases = record(root.cases, "cases");
  const counts = record(cases.expectedCounts, "cases.expectedCounts");
  const holdout = record(root.holdout, "holdout");
  const gates = record(root.gates, "gates");
  const artifacts = array(root.artifacts, "artifacts").map((item, index): PipelineCampaignArtifact => {
    const artifact = record(item, `artifacts[${index}]`);
    const kind = oneOf(artifact.kind, ["case_manifest", "lineage", "review", "candidate_pool", "training_rows", "model", "model_manifest", "evaluation", "holdout"] as const, `artifacts[${index}].kind`);
    return {
      id: string(artifact.id, `artifacts[${index}].id`), kind,
      path: repositoryRelativePath(artifact.path, `artifacts[${index}].path`),
      sha256: hash(artifact.sha256, `artifacts[${index}].sha256`),
      parents: requiredStringArray(artifact.parents, `artifacts[${index}].parents`),
      allowedStages: array(artifact.allowedStages, `artifacts[${index}].allowedStages`).map((stage, stageIndex) =>
        oneOf(stage, ["tier_a", "tier_b", "calibration", "holdout", "live"] as const, `artifacts[${index}].allowedStages[${stageIndex}]`))
    };
  });
  const status = oneOf(holdout.status, ["sealed_detached", "opened"] as const, "holdout.status");
  return {
    schemaVersion: BENCHMARK_CAMPAIGN_SCHEMA,
    campaignId: string(root.campaignId, "campaignId"),
    nonEvidence: boolean(root.nonEvidence, "nonEvidence"),
    source: { branch: string(source.branch, "source.branch"), baseCommit: hash(source.baseCommit, "source.baseCommit", 40) },
    runtime: {
      nodeMajor: exact(runtime.nodeMajor, 24, "runtime.nodeMajor"),
      pnpm: exact(runtime.pnpm, "10.31.0", "runtime.pnpm"),
      python: exact(runtime.python, "3.12", "runtime.python")
    },
    semantic: {
      modelId: string(semantic.modelId, "semantic.modelId"),
      upstreamRevision: hash(semantic.upstreamRevision, "semantic.upstreamRevision", 40),
      documentSchemaVersion: string(semantic.documentSchemaVersion, "semantic.documentSchemaVersion"),
      candidateLimit: exact(semantic.candidateLimit, 64, "semantic.candidateLimit"),
      enrichedCandidateLimit: exact(semantic.enrichedCandidateLimit, 128, "semantic.enrichedCandidateLimit")
    },
    cases: {
      artifactId: string(cases.artifactId, "cases.artifactId"),
      expectedCounts: {
        train: nonnegativeInteger(counts.train, "cases.expectedCounts.train"),
        calibration: nonnegativeInteger(counts.calibration, "cases.expectedCounts.calibration"),
        holdout: nonnegativeInteger(counts.holdout, "cases.expectedCounts.holdout")
      },
      splitField: string(cases.splitField, "cases.splitField"),
      idField: string(cases.idField, "cases.idField"),
      format: oneOf(cases.format, ["json_cases", "jsonl_rows"] as const, "cases.format")
    },
    holdout: {
      status,
      artifactId: string(holdout.artifactId, "holdout.artifactId"),
      openedEvaluationId: holdout.openedEvaluationId === null ? null : string(holdout.openedEvaluationId, "holdout.openedEvaluationId")
    },
    artifacts,
    gates: {
      boundedPoolRequiredSourceMissesAt128: exact(gates.boundedPoolRequiredSourceMissesAt128, 0, "gates.boundedPoolRequiredSourceMissesAt128"),
      servedRecallAt64Overall: probability(gates.servedRecallAt64Overall, "gates.servedRecallAt64Overall"),
      servedRecallAt64PerLanguage: probability(gates.servedRecallAt64PerLanguage, "gates.servedRecallAt64PerLanguage"),
      expectedCalibrationErrorMax: probability(gates.expectedCalibrationErrorMax, "gates.expectedCalibrationErrorMax"),
      generatedVendorTopOneMax: exact(gates.generatedVendorTopOneMax, 0, "gates.generatedVendorTopOneMax")
    }
  };
}

import type {
  BenchmarkAssistanceMode,
  BenchmarkComparison,
  BenchmarkContextBehavior,
  BenchmarkEnduranceReport,
  BenchmarkEnduranceRepeatReport,
  BenchmarkProofReport,
  BenchmarkReport
} from "../types.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { workspacePatch } from "./agent.js";
import { runBenchmarkEndurance, runBenchmarkEnduranceRepeats } from "./endurance.js";
import { runBenchmarkMcpSmoke, type BenchmarkMcpSmokeReport } from "./mcpSmoke.js";
import { buildSweProOfficialEvalReport, type SweProOfficialEvalReport } from "./sweProOfficial.js";
import { sha256 } from "../utils/hash.js";

export type CampaignStage = "proxy" | "live" | "official" | "all";
export type CampaignRunProfile = "default" | "fast-live" | "proof" | "publication";
export type CampaignCleanupMode = "never" | "on_success" | "always";
export type CampaignEntryKind = "proxy" | "proof" | "endurance" | "mcp_smoke" | "official_eval" | "control";
export type CampaignEntryStatus = "planned" | "passed" | "failed" | "skipped";
export type CampaignProxyClassification =
  | "would_over_assist"
  | "wrong_surface_risk"
  | "scope_too_broad"
  | "evidence_needed"
  | "valid_guardrail"
  | "suppression_expected"
  | "proxy_pass";

const CAMPAIGN_ENTRY_KINDS = new Set<CampaignEntryKind>(["proxy", "proof", "endurance", "mcp_smoke", "official_eval", "control"]);
const CAMPAIGN_STAGES = new Set<CampaignStage>(["proxy", "live", "official", "all"]);
const CLEANUP_MODES = new Set<CampaignCleanupMode>(["never", "on_success", "always"]);

export type CampaignManifest = {
  id: string;
  name: string;
  description?: string | undefined;
  defaults?: {
    model?: string | undefined;
    parallel?: number | undefined;
    agentTimeoutMs?: number | undefined;
    turnTimeoutMs?: number | undefined;
    workdir?: string | undefined;
    cleanup?: CampaignCleanupMode | undefined;
    commands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
    setupCommands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
  } | undefined;
  pauseRules?: {
    maxQualityDrops?: number | undefined;
    maxScopeViolations?: number | undefined;
    maxRepeatedFailureClass?: number | undefined;
    maxTokenRegressionClass?: number | undefined;
    stopOnHarnessFailure?: boolean | undefined;
  } | undefined;
  entries: CampaignEntry[];
};

export type CampaignEntry = {
  id: string;
  kind: CampaignEntryKind;
  label?: string | undefined;
  tags?: string[] | undefined;
  root?: string | undefined;
  suite?: string | undefined;
  input?: string | undefined;
  rowIds?: string[] | undefined;
  evaluatorResultsPath?: string | undefined;
  officialRunnerCommand?: string | undefined;
  task?: string | undefined;
  expectedFiles?: string[] | undefined;
  minExpectedHits?: number | undefined;
  budget?: number | undefined;
  detail?: "compact" | "full" | undefined;
  modes?: BenchmarkAssistanceMode[] | undefined;
  repeat?: number | undefined;
  timeoutMs?: number | undefined;
  expectedFailureClass?: string | undefined;
  contextBehavior?: BenchmarkContextBehavior | undefined;
  commands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
  setupCommands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
};

export type CampaignRunOptions = {
  manifestPath: string;
  outDir: string;
  stage?: CampaignStage | undefined;
  profile?: CampaignRunProfile | undefined;
  parallel?: number | undefined;
  resume?: boolean | undefined;
  only?: string | undefined;
  dryRun?: boolean | undefined;
  reuseBaseline?: boolean | undefined;
  baselineCacheDir?: string | undefined;
  kairnOnlyAgainstBaseline?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
};

export type CampaignArtifact = {
  entryId: string;
  kind: CampaignEntryKind;
  stage: CampaignStage;
  status: CampaignEntryStatus;
  tags: string[];
  startedAt: string;
  endedAt: string;
  artifactPath: string;
  workerPacketPath?: string | undefined;
  commands: string[];
  report?: unknown;
  classifications: string[];
  error?: string | undefined;
  workspacePaths: string[];
  officialPatchPaths?: Record<string, string> | undefined;
  metrics: CampaignEntryMetrics;
};

export type CampaignEntryMetrics = {
  qualityPassed: boolean;
  observedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  savedTokens?: number | undefined;
  savingsRate?: number | undefined;
  estimatedObservedTokens?: number | undefined;
  estimatedBaselineTokens?: number | undefined;
  estimatedSavedTokens?: number | undefined;
  estimatedSavingsRate?: number | undefined;
  tokenAccounting?: "observed" | "timeout_estimate" | undefined;
  cleanPassPass: boolean;
  tokenRegression: boolean;
  qualityDrop: boolean;
  qualityRescue: boolean;
  harmfulAssist: boolean;
  scopeViolations: number;
  mcpCalls: number;
  mcpUsefulAttribution: number;
  elapsedMs: number;
};

export type CampaignReport = {
  id: string;
  name: string;
  generatedAt: string;
  manifestPath: string;
  outDir: string;
  stage: CampaignStage;
  dryRun: boolean;
  parallel: number;
  paused: boolean;
  pauseReasons: string[];
  artifacts: CampaignArtifact[];
  rows: CampaignResultRow[];
  aggregate: CampaignAggregate;
  outputs: CampaignOutputPaths;
};

export type CampaignResultRow = {
  entryId: string;
  kind: CampaignEntryKind;
  stage: CampaignStage;
  status: CampaignEntryStatus;
  tags: string;
  qualityPassed: boolean;
  observedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  savedTokens?: number | undefined;
  savingsRate?: number | undefined;
  estimatedObservedTokens?: number | undefined;
  estimatedBaselineTokens?: number | undefined;
  estimatedSavedTokens?: number | undefined;
  estimatedSavingsRate?: number | undefined;
  tokenAccounting?: "observed" | "timeout_estimate" | undefined;
  cleanPassPass: boolean;
  tokenRegression: boolean;
  qualityDrop: boolean;
  qualityRescue: boolean;
  harmfulAssist: boolean;
  scopeViolations: number;
  mcpCalls: number;
  mcpUsefulAttribution: number;
  classifications: string;
  elapsedMs: number;
};

export type CampaignAggregate = {
  entries: number;
  completedEntries: number;
  failedEntries: number;
  qualityPassRate: number;
  cleanPassPassRows: number;
  tokenRegressionRows: number;
  passiveTokenRegressionRows: number;
  qualityRescueRows: number;
  harmfulRows: number;
  scopeViolations: number;
  mcpCalls: number;
  mcpUsefulAttribution: number;
  medianSavedTokens: number;
  medianSavingsRate: number;
  medianElapsedMsByStage: Record<string, number>;
  repeatedFailureClasses: Array<{ classification: string; count: number; examples: string[] }>;
  pauseRuleStatus: {
    paused: boolean;
    reasons: string[];
  };
};

export type CampaignOutputPaths = {
  manifestPath: string;
  summaryPath: string;
  resultsCsvPath: string;
  failuresCsvPath: string;
  proxyResultsCsvPath: string;
  workerPacketsDir: string;
  rawDir: string;
  workDir: string;
  baselineCacheDir: string;
};

export type CampaignCleanupReport = {
  outDir: string;
  dryRun: boolean;
  removed: string[];
  skipped: string[];
};

type CampaignBaselineCacheArtifact = {
  version: 1;
  cacheKey: string;
  entryId: string;
  createdAt: string;
  root: string;
  suitePath: string;
  suiteHash: string;
  baselineCommandHash: string;
  baselineSetupCommandHash?: string | undefined;
  repeat: number;
  reports: BenchmarkReport[];
};

export async function runCampaign(options: CampaignRunOptions): Promise<CampaignReport> {
  const manifest = loadCampaignManifest(options.manifestPath);
  const stage = options.stage ?? "all";
  const profile = options.profile ?? "default";
  validateCampaignManifest(manifest);
  validateStage(stage);
  validateProfile(profile);
  const outDir = path.resolve(options.outDir);
  const outputs = campaignOutputPaths(outDir, options.baselineCacheDir);
  fs.mkdirSync(outputs.rawDir, { recursive: true });
  fs.mkdirSync(outputs.workerPacketsDir, { recursive: true });
  fs.mkdirSync(outputs.workDir, { recursive: true });
  fs.mkdirSync(outputs.baselineCacheDir, { recursive: true });
  const entries = manifest.entries.filter((entry) => entryMatchesStage(entry, stage)).filter((entry) => matchesOnly(entry, options.only));
  const requestedParallel = Math.max(1, Math.floor(options.parallel ?? manifest.defaults?.parallel ?? 3));
  const parallel = effectiveCampaignParallel(stage, entries, requestedParallel);
  const artifacts: CampaignArtifact[] = [];
  let paused = false;
  let pauseReasons: string[] = [];
  const runEntries = entries.map((entry) => async () => {
    if (paused) {
      const artifact = skippedArtifact({ manifest, entry, stage, outputs, reason: "campaign paused before entry started" });
      artifacts.push(artifact);
      return artifact;
    }
    const artifact = await runCampaignEntry({
      manifest,
      entry,
      stage,
      outputs,
      resume: Boolean(options.resume),
      dryRun: Boolean(options.dryRun),
      profile,
      reuseBaseline: Boolean(options.reuseBaseline),
      kairnOnlyAgainstBaseline: Boolean(options.kairnOnlyAgainstBaseline),
      onProgress: options.onProgress
    });
    artifacts.push(artifact);
    const pause = evaluatePauseRules(manifest, artifacts);
    if (pause.paused) {
      paused = true;
      pauseReasons = pause.reasons;
    }
    return artifact;
  });
  await runCampaignTaskPool(runEntries, parallel);
  const finalArtifacts = orderedArtifacts(entries, artifacts);
  const rows = finalArtifacts.map(artifactToRow);
  const aggregate = aggregateCampaignRows(rows, finalArtifacts, manifest);
  const report: CampaignReport = {
    id: manifest.id,
    name: manifest.name,
    generatedAt: new Date().toISOString(),
    manifestPath: path.resolve(options.manifestPath),
    outDir,
    stage,
    dryRun: Boolean(options.dryRun),
    parallel,
    paused: aggregate.pauseRuleStatus.paused,
    pauseReasons: aggregate.pauseRuleStatus.reasons,
    artifacts: finalArtifacts,
    rows,
    aggregate,
    outputs
  };
  writeCampaignOutputs({ manifest, report });
  return report;
}

export function summarizeCampaign(outDir: string): CampaignReport {
  const absoluteOutDir = path.resolve(outDir);
  const outputs = campaignOutputPaths(absoluteOutDir);
  if (fs.existsSync(outputs.manifestPath) && fs.existsSync(outputs.rawDir)) {
    const manifest = loadCampaignManifest(outputs.manifestPath);
    validateCampaignManifest(manifest);
    const entriesById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    const artifacts = loadRawCampaignArtifacts(outputs.rawDir).map((artifact) => {
      const entry = entriesById.get(artifact.entryId);
      return entry ? refreshArtifactMetrics(entry, artifact) : artifact;
    });
    if (artifacts.length > 0) {
      const ordered = orderedArtifacts(manifest.entries, artifacts);
      const rows = ordered.map(artifactToRow);
      const aggregate = aggregateCampaignRows(rows, ordered, manifest);
      const report: CampaignReport = {
        id: manifest.id,
        name: manifest.name,
        generatedAt: new Date().toISOString(),
        manifestPath: outputs.manifestPath,
        outDir: absoluteOutDir,
        stage: "all",
        dryRun: ordered.every((artifact) => artifact.status === "planned"),
        parallel: Math.max(1, Math.floor(manifest.defaults?.parallel ?? 3)),
        paused: aggregate.pauseRuleStatus.paused,
        pauseReasons: aggregate.pauseRuleStatus.reasons,
        artifacts: ordered,
        rows,
        aggregate,
        outputs
      };
      writeCampaignOutputs({ manifest, report });
      return sanitizedCampaignReport(report);
    }
  }
  if (!fs.existsSync(outputs.summaryPath)) throw new Error(`No campaign summary found at ${outputs.summaryPath}`);
  return JSON.parse(fs.readFileSync(outputs.summaryPath, "utf8")) as CampaignReport;
}

export function cleanupCampaign(outDir: string, input: { dryRun?: boolean | undefined } = {}): CampaignCleanupReport {
  const absoluteOutDir = path.resolve(outDir);
  const workDir = campaignOutputPaths(absoluteOutDir).workDir;
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(workDir)) {
    return { outDir: absoluteOutDir, dryRun: Boolean(input.dryRun), removed, skipped };
  }
  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    const target = path.join(workDir, entry.name);
    if (!entry.isDirectory() || !entry.name.startsWith("campaign-")) {
      skipped.push(target);
      continue;
    }
    if (!input.dryRun) fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { outDir: absoluteOutDir, dryRun: Boolean(input.dryRun), removed, skipped };
}

export function loadCampaignManifest(manifestPath: string): CampaignManifest {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Campaign manifest must be a JSON object.");
  return parsed as CampaignManifest;
}

function loadRawCampaignArtifacts(rawDir: string): CampaignArtifact[] {
  if (!fs.existsSync(rawDir)) return [];
  return fs.readdirSync(rawDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(rawDir, name))
    .map((artifactPath) => JSON.parse(fs.readFileSync(artifactPath, "utf8")) as CampaignArtifact)
    .filter((artifact) => Boolean(artifact.entryId));
}

function refreshArtifactMetrics(entry: CampaignEntry, artifact: CampaignArtifact): CampaignArtifact {
  if (artifact.report === undefined || artifact.status !== "passed") return artifact;
  const metrics = metricsFromReport(entry, artifact.report, artifact.metrics.elapsedMs);
  return {
    ...artifact,
    metrics,
    classifications: classificationsFromMetrics(entry, metrics, artifact.report)
  };
}

export function validateCampaignManifest(manifest: CampaignManifest): void {
  if (!manifest.id) throw new Error("Campaign manifest requires id.");
  if (!manifest.name) throw new Error("Campaign manifest requires name.");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("Campaign manifest requires entries.");
  if (manifest.defaults?.cleanup && !CLEANUP_MODES.has(manifest.defaults.cleanup)) throw new Error(`Unsupported cleanup mode: ${manifest.defaults.cleanup}`);
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry.id) throw new Error("Campaign entry requires id.");
    if (ids.has(entry.id)) throw new Error(`Duplicate campaign entry id: ${entry.id}`);
    ids.add(entry.id);
    if (!CAMPAIGN_ENTRY_KINDS.has(entry.kind)) throw new Error(`${entry.id}: unsupported campaign entry kind: ${entry.kind}`);
    if (entry.kind === "proxy" && !entry.task) throw new Error(`${entry.id}: proxy entry requires task.`);
    if ((entry.kind === "proof" || entry.kind === "control") && !entry.suite) throw new Error(`${entry.id}: proof/control entry requires suite.`);
    if (entry.kind === "endurance" && !entry.suite) throw new Error(`${entry.id}: endurance entry requires suite.`);
    if (entry.kind === "mcp_smoke" && !entry.task) throw new Error(`${entry.id}: mcp_smoke entry requires task.`);
    if (entry.kind === "official_eval" && !entry.input) throw new Error(`${entry.id}: official_eval entry requires input.`);
    if (entry.expectedFiles !== undefined && !Array.isArray(entry.expectedFiles)) throw new Error(`${entry.id}: expectedFiles must be an array.`);
    for (const expectedFile of entry.expectedFiles ?? []) {
      if (typeof expectedFile !== "string" || expectedFile.trim().length === 0) throw new Error(`${entry.id}: expectedFiles must contain non-empty strings.`);
    }
    for (const mode of entry.modes ?? []) {
      if (!isBenchmarkAssistanceMode(mode)) throw new Error(`${entry.id}: unsupported campaign mode: ${mode}`);
    }
  }
}

async function runCampaignEntry(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  stage: CampaignStage;
  outputs: CampaignOutputPaths;
  resume: boolean;
  dryRun: boolean;
  profile: CampaignRunProfile;
  reuseBaseline: boolean;
  kairnOnlyAgainstBaseline: boolean;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<CampaignArtifact> {
  const artifactPath = path.join(input.outputs.rawDir, `${input.entry.id}.json`);
  if (input.resume && fs.existsSync(artifactPath)) {
    const existing = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as CampaignArtifact;
    if (existing.status === "passed") {
      const refreshed = refreshArtifactMetrics(input.entry, existing);
      if (JSON.stringify(refreshed.metrics) !== JSON.stringify(existing.metrics) ||
        refreshed.classifications.join("\0") !== existing.classifications.join("\0")) {
        writeJsonAtomic(artifactPath, refreshed);
      }
      input.onProgress?.(`[bench campaign] ${input.entry.id}: resume skipped`);
      return refreshed;
    }
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const commands = plannedCampaignCommands(input.manifest, input.entry);
  const workerPacketPath = writeWorkerPacket(input.manifest, input.entry, input.outputs);
  input.onProgress?.(`[bench campaign] ${input.entry.id}: start`);
  if (input.dryRun) {
    const artifact = baseArtifact({
      entry: input.entry,
      stage: input.stage,
      status: "planned",
      startedAt,
      artifactPath,
      workerPacketPath,
      commands,
      elapsedMs: Date.now() - startedMs
    });
    writeJsonAtomic(artifactPath, artifact);
    return artifact;
  }
  try {
    const report = await executeCampaignEntry({
      manifest: input.manifest,
      entry: input.entry,
      outputs: input.outputs,
      artifactPath,
      commands,
      profile: input.profile,
      reuseBaseline: input.reuseBaseline,
      kairnOnlyAgainstBaseline: input.kairnOnlyAgainstBaseline,
      onProgress: input.onProgress
    });
    const metrics = metricsFromReport(input.entry, report, Date.now() - startedMs);
    const officialPatchPaths = writeOfficialPatchArtifacts({
      entry: input.entry,
      report,
      outputs: input.outputs
    });
    const artifact = baseArtifact({
      entry: input.entry,
      stage: input.stage,
      status: "passed",
      startedAt,
      artifactPath,
      workerPacketPath,
      commands,
      report,
      classifications: classificationsFromMetrics(input.entry, metrics, report),
      metrics,
      workspacePaths: workspacePathsFromReport(input.entry, report),
      officialPatchPaths,
      elapsedMs: Date.now() - startedMs
    });
    writeJsonAtomic(artifactPath, artifact);
    removeSuccessfulPartialArtifact(artifactPath);
    input.onProgress?.(`[bench campaign] ${input.entry.id}: passed`);
    cleanupEntryWorkspaces(input.manifest, artifact);
    return artifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metrics = emptyMetrics(Date.now() - startedMs);
    const artifact = baseArtifact({
      entry: input.entry,
      stage: input.stage,
      status: "failed",
      startedAt,
      artifactPath,
      workerPacketPath,
      commands,
      error: message,
      classifications: ["harness_failure"],
      metrics,
      elapsedMs: Date.now() - startedMs
    });
    writeJsonAtomic(artifactPath, artifact);
    input.onProgress?.(`[bench campaign] ${input.entry.id}: failed`);
    cleanupEntryWorkspaces(input.manifest, artifact);
    return artifact;
  }
}

async function executeCampaignEntry(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  outputs: CampaignOutputPaths;
  artifactPath: string;
  commands: string[];
  profile: CampaignRunProfile;
  reuseBaseline: boolean;
  kairnOnlyAgainstBaseline: boolean;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<unknown> {
  if (input.entry.kind === "proxy") return runProxyEntry(input.manifest, input.entry);
  if (input.entry.kind === "mcp_smoke") {
    return runBenchmarkMcpSmoke({
      rootPath: rootFor(input.entry),
      task: input.entry.task!,
      budget: input.entry.budget,
      detail: input.entry.detail
    });
  }
  if (input.entry.kind === "endurance") {
    const modes = modesFor(input.manifest, input.entry);
    const args = {
      rootPath: rootFor(input.entry),
      suitePath: input.entry.suite!,
      baselineCommand: commandFor(input.manifest, input.entry, "baseline"),
      ...(modes.includes("kairn_codex_session")
        ? { kairnCodexSessionCommand: commandFor(input.manifest, input.entry, "kairn_codex_session"), kairnCodexSessionSetupCommand: setupCommandFor(input.manifest, input.entry, "kairn_codex_session") }
        : {}),
      ...(modes.includes("real_mcp_first")
        ? { realMcpFirstCommand: commandFor(input.manifest, input.entry, "real_mcp_first"), realMcpFirstSetupCommand: setupCommandFor(input.manifest, input.entry, "real_mcp_first") }
        : {}),
      ...(modes.includes("hybrid_mcp_brief")
        ? { hybridMcpBriefCommand: commandFor(input.manifest, input.entry, "hybrid_mcp_brief"), hybridMcpBriefSetupCommand: setupCommandFor(input.manifest, input.entry, "hybrid_mcp_brief") }
        : {}),
      turnTimeoutMs: input.entry.timeoutMs ?? input.manifest.defaults?.turnTimeoutMs
    };
    const repeat = Math.max(1, Math.floor(input.entry.repeat ?? 1));
    return repeat > 1 ? runBenchmarkEnduranceRepeats({ ...args, repeat }) : runBenchmarkEndurance(args);
  }
  if (input.entry.kind === "proof" || input.entry.kind === "control") {
    const runtime = new KairnRuntime(rootFor(input.entry));
    try {
      input.onProgress?.(`[bench campaign] ${input.entry.id}: proof runtime init start (${rootFor(input.entry)})`);
      await runtime.init();
      input.onProgress?.(`[bench campaign] ${input.entry.id}: proof runtime init complete`);
      const modes = modesFor(input.manifest, input.entry);
      const baselineCache = input.reuseBaseline || input.kairnOnlyAgainstBaseline
        ? readBaselineCache({
            manifest: input.manifest,
            entry: input.entry,
            outputs: input.outputs,
            requireCache: input.kairnOnlyAgainstBaseline
          })
        : undefined;
      input.onProgress?.(`[bench campaign] ${input.entry.id}: prove start (${modes.join(", ")})`);
      const proof = await runtime.proveBenchmark({
        suitePath: input.entry.suite!,
        baselineCommand: commandFor(input.manifest, input.entry, "baseline"),
        baselineSetupCommand: setupCommandFor(input.manifest, input.entry, "baseline"),
        ...(modes.includes("prompt_only") ? { promptOnlyCommand: commandFor(input.manifest, input.entry, "prompt_only"), promptOnlySetupCommand: setupCommandFor(input.manifest, input.entry, "prompt_only") } : {}),
        ...(modes.includes("prompt_plus_hooks") ? { promptPlusHooksCommand: commandFor(input.manifest, input.entry, "prompt_plus_hooks"), promptPlusHooksSetupCommand: setupCommandFor(input.manifest, input.entry, "prompt_plus_hooks") } : {}),
        ...(modes.includes("manual_prime") ? { manualPrimeCommand: commandFor(input.manifest, input.entry, "manual_prime"), manualPrimeSetupCommand: setupCommandFor(input.manifest, input.entry, "manual_prime") } : {}),
        ...(modes.includes("hook_full_prime") ? { hookFullPrimeCommand: commandFor(input.manifest, input.entry, "hook_full_prime"), hookFullPrimeSetupCommand: setupCommandFor(input.manifest, input.entry, "hook_full_prime") } : {}),
        ...(modes.includes("hook_tiny_directive") ? { hookTinyDirectiveCommand: commandFor(input.manifest, input.entry, "hook_tiny_directive"), hookTinyDirectiveSetupCommand: setupCommandFor(input.manifest, input.entry, "hook_tiny_directive") } : {}),
        ...(modes.includes("hook_tiny_with_failures") ? { hookTinyWithFailuresCommand: commandFor(input.manifest, input.entry, "hook_tiny_with_failures"), hookTinyWithFailuresSetupCommand: setupCommandFor(input.manifest, input.entry, "hook_tiny_with_failures") } : {}),
        ...(modes.includes("kairn_codex_session") ? { kairnCodexSessionCommand: commandFor(input.manifest, input.entry, "kairn_codex_session"), kairnCodexSessionSetupCommand: setupCommandFor(input.manifest, input.entry, "kairn_codex_session") } : {}),
        ...(modes.includes("kairn_codex_session_no_governor") ? { kairnCodexSessionNoGovernorCommand: commandFor(input.manifest, input.entry, "kairn_codex_session_no_governor"), kairnCodexSessionNoGovernorSetupCommand: setupCommandFor(input.manifest, input.entry, "kairn_codex_session_no_governor") } : {}),
        ...(modes.includes("mcp_first") ? { mcpFirstCommand: commandFor(input.manifest, input.entry, "mcp_first"), mcpFirstSetupCommand: setupCommandFor(input.manifest, input.entry, "mcp_first") } : {}),
        ...(modes.includes("real_mcp_first") ? { realMcpFirstCommand: commandFor(input.manifest, input.entry, "real_mcp_first"), realMcpFirstSetupCommand: setupCommandFor(input.manifest, input.entry, "real_mcp_first") } : {}),
        ...(modes.includes("mcp_first_plus_hook_full_prime") ? { mcpFirstPlusHookFullPrimeCommand: commandFor(input.manifest, input.entry, "mcp_first_plus_hook_full_prime"), mcpFirstPlusHookFullPrimeSetupCommand: setupCommandFor(input.manifest, input.entry, "mcp_first_plus_hook_full_prime") } : {}),
        ...(modes.includes("hybrid_mcp_brief") ? { hybridMcpBriefCommand: commandFor(input.manifest, input.entry, "hybrid_mcp_brief"), hybridMcpBriefSetupCommand: setupCommandFor(input.manifest, input.entry, "hybrid_mcp_brief") } : {}),
        agentTimeoutMs: agentTimeoutFor(input.manifest, input.entry, input.profile),
        repeat: Math.max(1, Math.floor(input.entry.repeat ?? 1)),
        cachedBaselineReports: baselineCache?.reports,
        proofOutputPath: `${input.artifactPath}.partial.json`,
        onProgress: input.onProgress
      });
      if (!baselineCache) {
        writeBaselineCache({
          manifest: input.manifest,
          entry: input.entry,
          outputs: input.outputs,
          proof
        });
      }
      return proof;
    } finally {
      runtime.close();
    }
  }
  if (input.entry.kind === "official_eval") {
    return buildSweProOfficialEvalReport({
      rowsPath: input.entry.input!,
      rowIds: input.entry.rowIds,
      evaluatorResultsPath: input.entry.evaluatorResultsPath,
      officialRunnerCommand: input.entry.officialRunnerCommand
    });
  }
  throw new Error(`Unsupported campaign entry kind: ${input.entry.kind}`);
}

async function runProxyEntry(manifest: CampaignManifest, entry: CampaignEntry): Promise<CampaignProxyReport> {
  const runtime = new KairnRuntime(rootFor(entry));
  try {
    await runtime.init();
    const rootPath = rootFor(entry);
    const expectedFiles = stringArray(entry.expectedFiles);
    const expectedFilesForGate = expectedFiles.filter((expectedFile) => fs.existsSync(path.join(rootPath, expectedFile)));
    const useExpectedFilesAsEditScope =
      (entry.tags ?? []).some((tag) => /swe[-_]?pro|official/i.test(tag)) ||
      /\bselected (?:verification )?tests? from swe[- ]bench pro metadata\b/i.test(entry.task ?? "");
    const prime = await runtime.primeContext({
      task: entry.task!,
      budget: entry.budget,
      source: "bench",
      refreshIndex: true,
      metadata: { campaignEntryId: entry.id },
      editScopeHints: useExpectedFilesAsEditScope && expectedFilesForGate.length > 0
        ? { allowedDiffScopes: expectedFilesForGate.map((file) => ({ file, allowWholeFile: true })) }
        : undefined
    });
    const deliveryTrace = isRecord(prime.metadata?.deliveryTrace) ? prime.metadata.deliveryTrace : {};
    const editScope = isRecord(prime.editScope) ? prime.editScope : undefined;
    const emittedFileCount = Array.isArray(prime.files) ? prime.files.length : 0;
    const initialEditFiles = Array.isArray(editScope?.initialEditFiles) ? stringArray(editScope.initialEditFiles) : [];
    const readOnlyFiles = Array.isArray(editScope?.readOnlyFiles) ? stringArray(editScope.readOnlyFiles) : [];
    const deliveryAction = stringValue(deliveryTrace.action);
    const recommendedDelivery = stringValue(deliveryTrace.recommendedDelivery);
    const minExpectedHits = Math.max(
      0,
      Math.min(
        expectedFilesForGate.length,
        Math.floor(numberValue(entry.minExpectedHits) ?? expectedFilesForGate.length)
      )
    );
    const surfaceFiles = useExpectedFilesAsEditScope
      ? uniqueStrings([
          ...prime.files,
          ...(deliveryAction === "suppress" ? initialEditFiles : []),
          ...readOnlyFiles
        ])
      : uniqueStrings([...prime.files, ...initialEditFiles, ...readOnlyFiles]);
    const expectedFilesMatched = expectedFilesForGate.filter((expectedFile) => surfaceFiles.some((file) => pathsMatch(file, expectedFile)));
    const estimatedDirectiveTokens = numberValue(deliveryTrace.estimatedDirectiveTokens) ?? prime.tokenEstimate;
    const classifications = classifyProxy({
      action: deliveryAction,
      directiveStyle: stringValue(deliveryTrace.directiveStyle),
      requiredSurface: stringValue(deliveryTrace.requiredSurface),
      taskShapeSignal: stringValue(deliveryTrace.taskShapeSignal),
      emittedFileCount,
      strictBoundary: Boolean(editScope?.strictBoundary),
      estimatedDirectiveTokens,
      expectedFileCount: expectedFilesForGate.length,
      minExpectedHits,
      expectedFilesMatchedCount: expectedFilesMatched.length
    });
    return {
      entryId: entry.id,
      taskHash: sha256(entry.task ?? ""),
      profile: prime.profile,
      tokenEstimate: prime.tokenEstimate,
      files: prime.files,
      action: deliveryAction,
      recommendedDelivery,
      taskShapeSignal: stringValue(deliveryTrace.taskShapeSignal),
      requiredSurface: stringValue(deliveryTrace.requiredSurface),
      directiveStyle: stringValue(deliveryTrace.directiveStyle),
      guardrailVariant: stringValue(deliveryTrace.guardrailVariant),
      emittedFileCount,
      emittedFileRoleSummary: recordValue(deliveryTrace.emittedFileRoleSummary),
      editScopeSource: stringValue(editScope?.scopeSource),
      initialEditFileCount: initialEditFiles.length,
      readOnlyFileCount: readOnlyFiles.length,
      expectedFileCount: expectedFiles.length,
      minExpectedHits,
      expectedExistingFileCount: expectedFilesForGate.length,
      expectedFilesMatchedCount: expectedFilesMatched.length,
      estimatedDirectiveTokens,
      estimatedSourceContextTokens: numberValue(deliveryTrace.estimatedSourceContextTokens),
      classifications
    };
  } finally {
    runtime.close();
  }
}

type CampaignProxyReport = {
  entryId: string;
  taskHash: string;
  profile: string;
  tokenEstimate: number;
  files: string[];
  action?: string | undefined;
  recommendedDelivery?: string | undefined;
  taskShapeSignal?: string | undefined;
  requiredSurface?: string | undefined;
  directiveStyle?: string | undefined;
  guardrailVariant?: string | undefined;
  emittedFileCount: number;
  emittedFileRoleSummary?: Record<string, unknown> | undefined;
  editScopeSource?: string | undefined;
  initialEditFileCount: number;
  readOnlyFileCount: number;
  expectedFileCount: number;
  minExpectedHits: number;
  expectedExistingFileCount: number;
  expectedFilesMatchedCount: number;
  estimatedDirectiveTokens: number;
  estimatedSourceContextTokens?: number | undefined;
  classifications: CampaignProxyClassification[];
};

function classifyProxy(input: {
  action?: string | undefined;
  directiveStyle?: string | undefined;
  requiredSurface?: string | undefined;
  taskShapeSignal?: string | undefined;
  emittedFileCount: number;
  strictBoundary: boolean;
  estimatedDirectiveTokens: number;
  expectedFileCount: number;
  minExpectedHits: number;
  expectedFilesMatchedCount: number;
}): CampaignProxyClassification[] {
  const classes: CampaignProxyClassification[] = [];
  if (input.action === "request_evidence" || input.requiredSurface === "evidence_needed") classes.push("evidence_needed");
  if (input.action === "suppress") classes.push("suppression_expected");
  if (input.directiveStyle === "scope_guardrail" || input.strictBoundary) classes.push("valid_guardrail");
  if (input.emittedFileCount > 6) classes.push("scope_too_broad");
  if (input.action !== "suppress" && input.estimatedDirectiveTokens > 900) classes.push("would_over_assist");
  const intentionalNarrowParserSuppression =
    input.action === "suppress" &&
    input.taskShapeSignal === "narrow_package_parser" &&
    input.requiredSurface === "single_file";
  const intentionalCollectionNameValidationSuppression =
    input.action === "suppress" &&
    input.taskShapeSignal === "collection_name_validation" &&
    input.requiredSurface === "paired_contract";
  const intentionalTopicOrderingSuppression =
    input.action === "suppress" &&
    input.taskShapeSignal === "topic_ordering" &&
    input.requiredSurface === "paired_contract";
  const intentionalEvidenceOrSuppression =
    input.action === "request_evidence" ||
    input.requiredSurface === "evidence_needed";
  if (
    input.expectedFileCount > 0 &&
    input.expectedFilesMatchedCount < input.minExpectedHits &&
    !intentionalNarrowParserSuppression &&
    !intentionalCollectionNameValidationSuppression &&
    !intentionalTopicOrderingSuppression &&
    !intentionalEvidenceOrSuppression
  ) classes.push("wrong_surface_risk");
  if (
    input.action === "suppress" &&
    input.taskShapeSignal === "discovery_config" &&
    input.requiredSurface === "paired_contract"
  ) classes.push("wrong_surface_risk");
  if (input.taskShapeSignal === "ambiguous_frontend_ownership" && input.action !== "request_evidence") classes.push("wrong_surface_risk");
  if (classes.length === 0) classes.push("proxy_pass");
  return [...new Set(classes)];
}

function metricsFromReport(entry: CampaignEntry, report: unknown, elapsedMs: number): CampaignEntryMetrics {
  if (entry.kind === "proxy") return proxyMetrics(report as CampaignProxyReport, elapsedMs);
  if (entry.kind === "mcp_smoke") return mcpSmokeMetrics(report as BenchmarkMcpSmokeReport, elapsedMs);
  if (entry.kind === "endurance") return enduranceMetrics(report as BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport, elapsedMs);
  if (entry.kind === "proof" || entry.kind === "control") return proofMetrics(report as BenchmarkProofReport, elapsedMs);
  if (entry.kind === "official_eval") return officialMetrics(report as SweProOfficialEvalReport, elapsedMs);
  return emptyMetrics(elapsedMs);
}

function proxyMetrics(report: CampaignProxyReport, elapsedMs: number): CampaignEntryMetrics {
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: !report.classifications.includes("wrong_surface_risk") && !report.classifications.includes("scope_too_broad"),
    observedTokens: report.estimatedDirectiveTokens,
    scopeViolations: report.classifications.includes("scope_too_broad") ? 1 : 0
  };
}

function mcpSmokeMetrics(report: BenchmarkMcpSmokeReport, elapsedMs: number): CampaignEntryMetrics {
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: report.metrics.mcpToolCalls > 0,
    mcpCalls: report.metrics.mcpToolCalls,
    mcpUsefulAttribution: report.prepare.startFiles.length
  };
}

function enduranceMetrics(report: BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport, elapsedMs: number): CampaignEntryMetrics {
  if ("aggregate" in report) {
    const baseline = report.aggregate.baseline;
    const nonBaseline = Object.values(report.aggregate).filter((mode) => mode.mode !== "baseline");
    const best = nonBaseline.sort((a, b) => (b.medianSavedTokens ?? 0) - (a.medianSavedTokens ?? 0))[0];
    return {
      ...emptyMetrics(elapsedMs),
      qualityPassed: nonBaseline.every((mode) => mode.qualityPasses === mode.repeats),
      observedTokens: best?.medianObservedCodexTokens,
      baselineTokens: baseline?.medianObservedCodexTokens,
      savedTokens: best?.medianSavedTokens,
      savingsRate: best?.medianSavingsRate,
      cleanPassPass: Boolean(best && best.validSavingsRuns > 0 && best.qualityPasses === best.repeats),
      tokenRegression: Boolean(best && (best.medianSavedTokens ?? 0) < 0),
      qualityDrop: nonBaseline.some((mode) => mode.qualityPasses < (baseline?.qualityPasses ?? mode.repeats)),
      qualityRescue: nonBaseline.some((mode) => (mode.classifications.quality_rescue ?? 0) > 0),
      harmfulAssist: nonBaseline.some((mode) => mode.harmfulRuns > 0),
      scopeViolations: sum(nonBaseline.map((mode) => mode.scopeViolations)),
      mcpCalls: sum(nonBaseline.map((mode) => mode.mcpCalls)),
      mcpUsefulAttribution: sum(nonBaseline.map((mode) => mode.mcpAttributedUsefulFileCount ?? 0))
    };
  }
  const baseline = report.reports.find((mode) => mode.mode === "baseline");
  const nonBaseline = report.reports.filter((mode) => mode.mode !== "baseline");
  const best = nonBaseline.sort((a, b) => {
    const aSaved = report.deltas[a.mode]?.savedTokens ?? Number.NEGATIVE_INFINITY;
    const bSaved = report.deltas[b.mode]?.savedTokens ?? Number.NEGATIVE_INFINITY;
    return bSaved - aSaved;
  })[0];
  const delta = best ? report.deltas[best.mode] : undefined;
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: nonBaseline.every((mode) => mode.qualityGatePassed),
    observedTokens: best?.totalObservedCodexTokens,
    baselineTokens: baseline?.totalObservedCodexTokens,
    savedTokens: delta?.savedTokens,
    savingsRate: delta?.savingsRate,
    cleanPassPass: Boolean(baseline?.qualityGatePassed && best?.qualityGatePassed && (delta?.validSavings ?? 0) > 0),
    tokenRegression: Boolean(delta && (delta.savedTokens ?? 0) < 0),
    qualityDrop: nonBaseline.some((mode) => mode.qualityGatePassed === false && baseline?.qualityGatePassed === true),
    qualityRescue: nonBaseline.some((mode) => mode.qualityGatePassed === true && baseline?.qualityGatePassed === false),
    harmfulAssist: nonBaseline.some((mode) => Boolean(report.deltas[mode.mode]?.harmfulAssist)),
    scopeViolations: sum(nonBaseline.map((mode) => stringArray(mode.metadata?.finalDiffScopeViolations).length)),
    mcpCalls: sum(nonBaseline.map((mode) => mode.assistanceActions.mcpCalls)),
    mcpUsefulAttribution: sum(nonBaseline.map((mode) => numberValue(mode.metadata?.mcpAttributedUsefulFileCount) ?? 0))
  };
}

function proofMetrics(report: BenchmarkProofReport, elapsedMs: number): CampaignEntryMetrics {
  const modeReports = proofModeReports(report);
  const nonBaseline = modeReports.filter((item) => item.mode !== "baseline");
  const baselinePassed = report.baseline.results.every(resultQualityPassed);
  const qualityPassed = nonBaseline.length > 0 && nonBaseline.every((item) => item.report.results.every(resultQualityPassed));
  const delta = bestProofDelta(report);
  const estimatedDelta = delta ? undefined : bestTimeoutEstimatedProofDelta(report, nonBaseline);
  const observedDeltas = Object.values(report.observedTokenDeltas)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const savedTokens = delta?.savedTokens;
  const passiveTokenRegression = delta?.assistClassification === "passive_token_regression";
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed,
    observedTokens: nonBaseline.find((item) => item.report.observed?.codexTokens !== undefined)?.report.observed?.codexTokens,
    baselineTokens: report.baseline.observed?.codexTokens,
    savedTokens,
    savingsRate: delta?.savingsRate,
    estimatedObservedTokens: estimatedDelta?.observedTokens,
    estimatedBaselineTokens: estimatedDelta?.baselineTokens,
    estimatedSavedTokens: estimatedDelta?.savedTokens,
    estimatedSavingsRate: estimatedDelta?.savingsRate,
    tokenAccounting: delta ? "observed" : estimatedDelta ? "timeout_estimate" : undefined,
    cleanPassPass: baselinePassed && qualityPassed && (savedTokens ?? 0) > 0,
    tokenRegression: baselinePassed && qualityPassed && (savedTokens ?? 0) < 0 && !passiveTokenRegression,
    qualityDrop: baselinePassed && nonBaseline.some((item) => item.report.results.some((result) => !resultQualityPassed(result))),
    qualityRescue: !baselinePassed && qualityPassed || observedDeltas.some((item) => item.assistClassification === "quality_rescue"),
    harmfulAssist: nonBaseline.some((item) => item.report.results.some((result) => result.metadata.assistClassification === "harmful_invalid_assist")) ||
      observedDeltas.some((item) => Boolean(item.harmfulAssist) || item.assistClassification === "harmful_invalid_assist"),
    scopeViolations: sum(nonBaseline.flatMap((item) => item.report.results.map((result) => stringArray(result.metadata.diffScopeViolations).length))),
    mcpCalls: sum(nonBaseline.map((item) => benchmarkReportMcpCalls(item.report))),
    mcpUsefulAttribution: sum(nonBaseline.map((item) => benchmarkReportMcpUsefulAttribution(item.report)))
  };
}

function officialMetrics(report: SweProOfficialEvalReport, elapsedMs: number): CampaignEntryMetrics {
  const tokenRows = report.results
    .map((result) => result.tokenMetrics)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const baselineTokens = sum(tokenRows.map((item) => item.baselineTokens ?? 0));
  const assistedTokens = sum(tokenRows.map((item) => item.assistedTokens ?? 0));
  const savedTokens = tokenRows.length > 0 ? baselineTokens - assistedTokens : undefined;
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: report.officialEvaluatorPassed,
    observedTokens: tokenRows.length > 0 ? assistedTokens : undefined,
    baselineTokens: tokenRows.length > 0 ? baselineTokens : undefined,
    savedTokens,
    savingsRate: savedTokens !== undefined && baselineTokens > 0 ? savedTokens / baselineTokens : undefined,
    cleanPassPass: report.officialEvaluatorPassed && (savedTokens ?? 0) > 0,
    tokenRegression: (savedTokens ?? 0) < 0,
    qualityDrop: !report.officialEvaluatorPassed
  };
}

function emptyMetrics(elapsedMs: number): CampaignEntryMetrics {
  return {
    qualityPassed: false,
    cleanPassPass: false,
    tokenRegression: false,
    qualityDrop: false,
    qualityRescue: false,
    harmfulAssist: false,
    scopeViolations: 0,
    mcpCalls: 0,
    mcpUsefulAttribution: 0,
    elapsedMs
  };
}

function classificationsFromMetrics(entry: CampaignEntry, metrics: CampaignEntryMetrics, report: unknown): string[] {
  if (entry.kind === "proxy") return (report as CampaignProxyReport).classifications;
  const classes: string[] = [];
  const proofAssistClassifications = entry.kind === "proof" || entry.kind === "control"
    ? Object.values((report as BenchmarkProofReport).observedTokenDeltas ?? {})
        .filter((delta): delta is NonNullable<typeof delta> => Boolean(delta))
        .map((delta) => delta.assistClassification)
    : [];
  if (metrics.cleanPassPass) classes.push("clean_passpass");
  if (proofAssistClassifications.includes("passive_token_regression")) classes.push("passive_token_regression");
  if (metrics.tokenRegression) classes.push("official_token_regression");
  if (metrics.qualityDrop) classes.push("quality_drop");
  if (metrics.qualityRescue) classes.push("quality_rescue");
  if (metrics.harmfulAssist) classes.push("harmful_invalid_assist");
  if (metrics.scopeViolations > 0) classes.push("scope_violation");
  if (metrics.mcpCalls > 0) classes.push(metrics.mcpUsefulAttribution > 0 ? "mcp_useful_attribution" : "mcp_missing_attribution");
  if (metrics.tokenAccounting === "timeout_estimate") classes.push("timeout_pass_estimated_tokens");
  if (
    (entry.kind === "proof" || entry.kind === "control" || entry.kind === "official_eval") &&
    metrics.qualityPassed &&
    metrics.tokenAccounting !== "timeout_estimate" &&
    (metrics.observedTokens === undefined || metrics.baselineTokens === undefined)
  ) {
    classes.push("official_pass_token_unavailable");
  }
  if (!metrics.qualityPassed) classes.push(metrics.mcpCalls > 0 ? "mcp_quality_incomplete" : "quality_incomplete");
  if (classes.length === 0) classes.push(metrics.qualityPassed ? "pass" : "neutral");
  return classes;
}

function aggregateCampaignRows(rows: CampaignResultRow[], artifacts: CampaignArtifact[], manifest: CampaignManifest): CampaignAggregate {
  const qualityRows = rows.filter((row) => row.status === "passed" || row.status === "skipped");
  const repeated = repeatedFailureClasses(rows);
  const pause = evaluatePauseRules(manifest, artifacts);
  return {
    entries: rows.length,
    completedEntries: rows.filter((row) => row.status === "passed" || row.status === "skipped").length,
    failedEntries: rows.filter((row) => row.status === "failed").length,
    qualityPassRate: qualityRows.length > 0 ? qualityRows.filter((row) => row.qualityPassed).length / qualityRows.length : 0,
    cleanPassPassRows: rows.filter((row) => row.cleanPassPass).length,
    tokenRegressionRows: rows.filter((row) => row.tokenRegression).length,
    passiveTokenRegressionRows: rows.filter((row) => row.classifications.split(";").includes("passive_token_regression")).length,
    qualityRescueRows: rows.filter((row) => row.qualityRescue).length,
    harmfulRows: rows.filter((row) => row.harmfulAssist).length,
    scopeViolations: sum(rows.map((row) => row.scopeViolations)),
    mcpCalls: sum(rows.map((row) => row.mcpCalls)),
    mcpUsefulAttribution: sum(rows.map((row) => row.mcpUsefulAttribution)),
    medianSavedTokens: median(rows.filter((row) => row.tokenAccounting !== "timeout_estimate").map((row) => row.savedTokens).filter(isNumber)),
    medianSavingsRate: median(rows.filter((row) => row.tokenAccounting !== "timeout_estimate").map((row) => row.savingsRate).filter(isNumber)),
    medianElapsedMsByStage: medianElapsedByStage(rows),
    repeatedFailureClasses: repeated,
    pauseRuleStatus: pause
  };
}

function evaluatePauseRules(manifest: CampaignManifest, artifacts: CampaignArtifact[]): { paused: boolean; reasons: string[] } {
  const rules = manifest.pauseRules ?? {};
  const rows = artifacts.map(artifactToRow);
  const reasons: string[] = [];
  if (rules.maxQualityDrops !== undefined && rows.filter((row) => row.qualityDrop).length > rules.maxQualityDrops) reasons.push("quality drop limit exceeded");
  if (rules.maxScopeViolations !== undefined && sum(rows.map((row) => row.scopeViolations)) > rules.maxScopeViolations) reasons.push("scope violation limit exceeded");
  if (rules.maxTokenRegressionClass !== undefined && rows.filter((row) => row.tokenRegression).length > rules.maxTokenRegressionClass) reasons.push("token regression limit exceeded");
  if (rows.some((row) => row.kind === "proxy" && !row.qualityPassed)) reasons.push("proxy quality gate failed");
  if (rules.maxRepeatedFailureClass !== undefined) {
    const repeated = repeatedFailureClasses(rows).filter((item) => item.count > rules.maxRepeatedFailureClass!);
    for (const item of repeated) reasons.push(`repeated failure class: ${item.classification}`);
  }
  if (rules.stopOnHarnessFailure && artifacts.some((artifact) => artifact.classifications.includes("harness_failure"))) reasons.push("harness failure");
  return { paused: reasons.length > 0, reasons };
}

function writeCampaignOutputs(input: { manifest: CampaignManifest; report: CampaignReport }): void {
  const outputs = input.report.outputs;
  writeJsonAtomic(outputs.manifestPath, input.manifest);
  writeJsonAtomic(outputs.summaryPath, sanitizedCampaignReport(input.report));
  fs.writeFileSync(outputs.resultsCsvPath, campaignRowsCsv(input.report.rows));
  fs.writeFileSync(
    outputs.failuresCsvPath,
    campaignRowsCsv(input.report.rows.filter((row) =>
      row.status === "failed" ||
      !row.qualityPassed ||
      row.qualityDrop ||
      row.harmfulAssist ||
      row.scopeViolations > 0 ||
      row.classifications.split(";").includes("official_pass_token_unavailable") ||
      row.classifications.split(";").includes("timeout_pass_estimated_tokens") ||
      row.classifications.split(";").includes("passive_token_regression")
    ))
  );
  fs.writeFileSync(outputs.proxyResultsCsvPath, campaignRowsCsv(input.report.rows.filter((row) => row.kind === "proxy")));
}

function sanitizedCampaignReport(report: CampaignReport): CampaignReport {
  return {
    ...report,
    manifestPath: path.basename(report.outputs.manifestPath),
    outDir: ".",
    artifacts: report.artifacts.map((artifact) => {
      const sanitized: CampaignArtifact = {
        entryId: artifact.entryId,
        kind: artifact.kind,
        stage: artifact.stage,
        status: artifact.status,
        tags: artifact.tags,
        startedAt: artifact.startedAt,
        endedAt: artifact.endedAt,
        artifactPath: `raw/${path.basename(artifact.artifactPath)}`,
        ...(artifact.workerPacketPath ? { workerPacketPath: `worker-packets/${path.basename(artifact.workerPacketPath)}` } : {}),
        commands: [],
        classifications: artifact.classifications,
        ...(artifact.error ? { error: redactLocalPaths(artifact.error) } : {}),
        workspacePaths: [],
        metrics: artifact.metrics
      };
      return sanitized;
    }),
    outputs: {
      manifestPath: path.basename(report.outputs.manifestPath),
      summaryPath: path.basename(report.outputs.summaryPath),
      resultsCsvPath: path.basename(report.outputs.resultsCsvPath),
      failuresCsvPath: path.basename(report.outputs.failuresCsvPath),
      proxyResultsCsvPath: path.basename(report.outputs.proxyResultsCsvPath),
      workerPacketsDir: path.basename(report.outputs.workerPacketsDir),
      rawDir: path.basename(report.outputs.rawDir),
      workDir: path.basename(report.outputs.workDir),
      baselineCacheDir: path.basename(report.outputs.baselineCacheDir)
    }
  };
}

function readCaseIds(
  filePath: string,
  splitField: string,
  idField: string,
  format: "json_cases" | "jsonl_rows"
): Record<"train" | "calibration" | "holdout", string[]> {
  const source = fs.readFileSync(filePath, "utf8");
  const rows = format === "json_cases"
    ? array(record(JSON.parse(source) as unknown, "case manifest").cases, "case manifest.cases")
    : source.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line) as unknown; }
        catch { throw new Error(`case manifest JSONL row ${index + 1} is invalid`); }
      });
  const output = { train: [] as string[], calibration: [] as string[], holdout: [] as string[] };
  const seen = new Set<string>();
  rows.forEach((item, index) => {
    const row = record(item, `case manifest.cases[${index}]`);
    const id = string(row[idField], `case manifest.cases[${index}].${idField}`);
    const split = oneOf(row[splitField], ["train", "calibration", "holdout"] as const, `case manifest.cases[${index}].${splitField}`);
    if (!seen.has(id)) { seen.add(id); output[split].push(id); }
    else if (!output[split].includes(id)) throw new Error(`campaign case id '${id}' crosses splits`);
  });
  for (const values of Object.values(output)) values.sort();
  return output;
}

function assertAcyclicArtifacts(artifacts: PipelineCampaignArtifact[]): void {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const visiting = new Set<string>(); const complete = new Set<string>();
  const visit = (id: string): void => {
    if (complete.has(id)) return;
    if (visiting.has(id)) throw new Error(`campaign artifact graph contains a cycle at '${id}'`);
    visiting.add(id);
    for (const parent of byId.get(id)?.parents ?? []) visit(parent);
    visiting.delete(id); complete.add(id);
  };
  for (const artifact of artifacts) visit(artifact.id);
}

function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("campaign manifest is not inside a Kairn checkout");
    current = parent;
  }
}

function resolveRepositoryArtifact(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) throw new Error(`artifact path escapes repository: ${relative}`);
  return resolved;
}

function repositoryRelativePath(value: unknown, label: string): string {
  const parsed = string(value, label).replace(/\\/g, "/");
  if (path.isAbsolute(parsed) || parsed.split("/").includes("..")) throw new Error(`${label} must stay within the repository`);
  return parsed;
}

function digestParts(...values: string[]): string { return infraSha256(values.join("\0")); }
function fileSha256(filePath: string): string { return infraSha256(fs.readFileSync(filePath)); }
function infraSha256(value: crypto.BinaryLike): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function string(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`); return value; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`); return value; }
function hash(value: unknown, label: string, length = 64): string { const parsed = string(value, label); if (!new RegExp(`^[a-f0-9]{${length}}$`, "i").test(parsed)) throw new Error(`${label} must be a ${length}-character hexadecimal digest`); return parsed.toLowerCase(); }
function requiredStringArray(value: unknown, label: string): string[] { return array(value, label).map((item, index) => string(item, `${label}[${index}]`)); }
function nonnegativeInteger(value: unknown, label: string): number { if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`); return Number(value); }
function probability(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a probability`); return value; }
function exact<T extends string | number>(value: unknown, expected: T, label: string): T { if (value !== expected) throw new Error(`${label} must equal ${String(expected)}`); return expected; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} must be one of ${allowed.join(", ")}`); return value as T; }
function redactLocalPaths(value: string): string {
  return value.replace(/\/Users\/[^/\s]+\/[^\s"']+/g, "<path>");
}

function campaignRowsCsv(rows: CampaignResultRow[]): string {
  const header = [
    "entry_id",
    "kind",
    "stage",
    "status",
    "tags",
    "quality_passed",
    "observed_tokens",
    "baseline_tokens",
    "saved_tokens",
    "savings_rate",
    "estimated_observed_tokens",
    "estimated_baseline_tokens",
    "estimated_saved_tokens",
    "estimated_savings_rate",
    "token_accounting",
    "clean_passpass",
    "token_regression",
    "quality_drop",
    "quality_rescue",
    "harmful_assist",
    "scope_violations",
    "mcp_calls",
    "mcp_useful_attribution",
    "classifications",
    "elapsed_ms"
  ];
  return `${[header, ...rows.map((row) => [
    row.entryId,
    row.kind,
    row.stage,
    row.status,
    row.tags,
    String(row.qualityPassed),
    optionalNumber(row.observedTokens),
    optionalNumber(row.baselineTokens),
    optionalNumber(row.savedTokens),
    optionalNumber(row.savingsRate),
    optionalNumber(row.estimatedObservedTokens),
    optionalNumber(row.estimatedBaselineTokens),
    optionalNumber(row.estimatedSavedTokens),
    optionalNumber(row.estimatedSavingsRate),
    row.tokenAccounting ?? "",
    String(row.cleanPassPass),
    String(row.tokenRegression),
    String(row.qualityDrop),
    String(row.qualityRescue),
    String(row.harmfulAssist),
    String(row.scopeViolations),
    String(row.mcpCalls),
    String(row.mcpUsefulAttribution),
    row.classifications,
    String(row.elapsedMs)
  ])].map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

function artifactToRow(artifact: CampaignArtifact): CampaignResultRow {
  return {
    entryId: artifact.entryId,
    kind: artifact.kind,
    stage: artifact.stage,
    status: artifact.status,
    tags: artifact.tags.join(";"),
    qualityPassed: artifact.metrics.qualityPassed,
    observedTokens: artifact.metrics.observedTokens,
    baselineTokens: artifact.metrics.baselineTokens,
    savedTokens: artifact.metrics.savedTokens,
    savingsRate: artifact.metrics.savingsRate,
    estimatedObservedTokens: artifact.metrics.estimatedObservedTokens,
    estimatedBaselineTokens: artifact.metrics.estimatedBaselineTokens,
    estimatedSavedTokens: artifact.metrics.estimatedSavedTokens,
    estimatedSavingsRate: artifact.metrics.estimatedSavingsRate,
    tokenAccounting: artifact.metrics.tokenAccounting,
    cleanPassPass: artifact.metrics.cleanPassPass,
    tokenRegression: artifact.metrics.tokenRegression,
    qualityDrop: artifact.metrics.qualityDrop,
    qualityRescue: artifact.metrics.qualityRescue,
    harmfulAssist: artifact.metrics.harmfulAssist,
    scopeViolations: artifact.metrics.scopeViolations,
    mcpCalls: artifact.metrics.mcpCalls,
    mcpUsefulAttribution: artifact.metrics.mcpUsefulAttribution,
    classifications: artifact.classifications.join(";"),
    elapsedMs: artifact.metrics.elapsedMs
  };
}

function baseArtifact(input: {
  entry: CampaignEntry;
  stage: CampaignStage;
  status: CampaignEntryStatus;
  startedAt: string;
  artifactPath: string;
  workerPacketPath: string;
  commands: string[];
  report?: unknown | undefined;
  error?: string | undefined;
  classifications?: string[] | undefined;
  metrics?: CampaignEntryMetrics | undefined;
  workspacePaths?: string[] | undefined;
  officialPatchPaths?: Record<string, string> | undefined;
  elapsedMs: number;
}): CampaignArtifact {
  return {
    entryId: input.entry.id,
    kind: input.entry.kind,
    stage: stageForEntry(input.entry, input.stage),
    status: input.status,
    tags: input.entry.tags ?? [],
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    artifactPath: input.artifactPath,
    workerPacketPath: input.workerPacketPath,
    commands: input.commands,
    ...(input.report !== undefined ? { report: input.report } : {}),
    ...(input.error ? { error: input.error } : {}),
    classifications: input.classifications ?? [],
    workspacePaths: input.workspacePaths ?? [],
    ...(input.officialPatchPaths && Object.keys(input.officialPatchPaths).length > 0 ? { officialPatchPaths: input.officialPatchPaths } : {}),
    metrics: input.metrics ?? emptyMetrics(input.elapsedMs)
  };
}

function skippedArtifact(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  stage: CampaignStage;
  outputs: CampaignOutputPaths;
  reason: string;
}): CampaignArtifact {
  const now = new Date().toISOString();
  return baseArtifact({
    entry: input.entry,
    stage: input.stage,
    status: "skipped",
    startedAt: now,
    artifactPath: path.join(input.outputs.rawDir, `${input.entry.id}.json`),
    workerPacketPath: path.join(input.outputs.workerPacketsDir, `${input.entry.id}.json`),
    commands: plannedCampaignCommands(input.manifest, input.entry),
    error: input.reason,
    classifications: ["campaign_paused"],
    elapsedMs: 0
  });
}

function plannedCampaignCommands(manifest: CampaignManifest, entry: CampaignEntry): string[] {
  if (entry.kind === "proxy") return [`kairn prime --root ${rootFor(entry)} --task <task>`];
  if (entry.kind === "mcp_smoke") return [`kairn bench mcp-smoke --root ${rootFor(entry)} --task <task>`];
  if (entry.kind === "official_eval") return [entry.officialRunnerCommand ?? "kairn bench swe-pro-official/eval aggregation"];
  const modes = modesFor(manifest, entry);
  return modes.map((mode) => `${mode}: ${commandFor(manifest, entry, mode)}`);
}

function writeWorkerPacket(manifest: CampaignManifest, entry: CampaignEntry, outputs: CampaignOutputPaths): string {
  const packetPath = path.join(outputs.workerPacketsDir, `${entry.id}.json`);
  const packet = {
    campaignId: manifest.id,
    entryId: entry.id,
    kind: entry.kind,
    tags: entry.tags ?? [],
    root: entry.root,
    suite: entry.suite,
    stage: stageForEntry(entry, "all"),
    command: `kairn bench campaign run --manifest ${outputs.manifestPath} --out-dir ${path.dirname(outputs.summaryPath)} --only ${entry.id} --parallel 1`,
    commands: plannedCampaignCommands(manifest, entry)
  };
  writeJsonAtomic(packetPath, packet);
  return packetPath;
}

function cleanupEntryWorkspaces(manifest: CampaignManifest, artifact: CampaignArtifact): void {
  const cleanup = manifest.defaults?.cleanup ?? "never";
  if (cleanup === "never") return;
  if (cleanup === "on_success" && artifact.status !== "passed") return;
  for (const workspace of artifact.workspacePaths) {
    if (workspace.includes(`${path.sep}campaign-`) || workspace.includes(`${path.sep}kairn-bench-`)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

function readBaselineCache(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  outputs: CampaignOutputPaths;
  requireCache: boolean;
}): CampaignBaselineCacheArtifact | undefined {
  const cacheKey = baselineCacheKey(input.manifest, input.entry);
  const cachePath = baselineCachePath(input.outputs, cacheKey);
  if (!fs.existsSync(cachePath)) {
    if (input.requireCache) throw new Error(`${input.entry.id}: missing cached baseline artifact (${cachePath})`);
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<CampaignBaselineCacheArtifact>;
  if (parsed.version !== 1 || parsed.cacheKey !== cacheKey || !Array.isArray(parsed.reports) || parsed.reports.length === 0) {
    if (input.requireCache) throw new Error(`${input.entry.id}: invalid cached baseline artifact (${cachePath})`);
    return undefined;
  }
  return parsed as CampaignBaselineCacheArtifact;
}

function writeBaselineCache(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  outputs: CampaignOutputPaths;
  proof: BenchmarkProofReport;
}): void {
  const reports = input.proof.runs?.baseline ?? [input.proof.baseline];
  if (reports.length === 0) return;
  const cacheKey = baselineCacheKey(input.manifest, input.entry);
  const suitePath = path.resolve(input.entry.suite!);
  const suiteHash = fileHashOrValue(suitePath);
  const baselineSetupCommand = setupCommandFor(input.manifest, input.entry, "baseline");
  const artifact: CampaignBaselineCacheArtifact = {
    version: 1,
    cacheKey,
    entryId: input.entry.id,
    createdAt: new Date().toISOString(),
    root: rootFor(input.entry),
    suitePath,
    suiteHash,
    baselineCommandHash: sha256(commandFor(input.manifest, input.entry, "baseline")),
    ...(baselineSetupCommand ? { baselineSetupCommandHash: sha256(baselineSetupCommand) } : {}),
    repeat: Math.max(1, Math.floor(input.entry.repeat ?? 1)),
    reports
  };
  writeJsonAtomic(baselineCachePath(input.outputs, cacheKey), artifact);
}

function baselineCachePath(outputs: CampaignOutputPaths, cacheKey: string): string {
  return path.join(outputs.baselineCacheDir, `${cacheKey}.baseline.json`);
}

function baselineCacheKey(manifest: CampaignManifest, entry: CampaignEntry): string {
  const suitePath = path.resolve(entry.suite!);
  const baselineSetupCommand = setupCommandFor(manifest, entry, "baseline");
  return sha256(JSON.stringify({
    version: 1,
    kind: entry.kind,
    root: rootFor(entry),
    suitePath,
    suiteHash: fileHashOrValue(suitePath),
    baselineCommand: commandFor(manifest, entry, "baseline"),
    baselineSetupCommand: baselineSetupCommand ?? "",
    repeat: Math.max(1, Math.floor(entry.repeat ?? 1))
  }));
}

function fileHashOrValue(filePath: string): string {
  return fs.existsSync(filePath) ? sha256(fs.readFileSync(filePath)) : sha256(filePath);
}

function agentTimeoutFor(manifest: CampaignManifest, entry: CampaignEntry, profile: CampaignRunProfile): number | undefined {
  const configured = entry.timeoutMs ?? manifest.defaults?.agentTimeoutMs;
  if (profile === "fast-live") return Math.min(configured ?? 480_000, 480_000);
  if (profile === "proof") return configured ?? 900_000;
  if (profile === "publication") return configured ?? 1_200_000;
  return configured;
}

function workspacePathsFromReport(entry: CampaignEntry, report: unknown): string[] {
  if (entry.kind === "proof" || entry.kind === "control") {
    return uniqueStrings(
      proofModeReports(report as BenchmarkProofReport).flatMap((item) =>
        item.report.results.map((result) => stringValue(result.metadata.workspacePath)).filter((value): value is string => Boolean(value))
      )
    );
  }
  if (entry.kind === "endurance") {
    const enduranceReport = report as BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport;
    if ("aggregate" in enduranceReport) {
      return uniqueStrings(enduranceReport.runs.flatMap((run) => run.reports.map((mode) => mode.workspacePath)));
    }
    return uniqueStrings(enduranceReport.reports.map((mode) => mode.workspacePath));
  }
  return [];
}

function writeOfficialPatchArtifacts(input: {
  entry: CampaignEntry;
  report: unknown;
  outputs: CampaignOutputPaths;
}): Record<string, string> | undefined {
  if (input.entry.kind !== "proof" && input.entry.kind !== "control") return undefined;
  const patchPaths: Record<string, string> = {};
  for (const item of proofModeReports(input.report as BenchmarkProofReport)) {
    const patchRows = item.report.results
      .map((result) => {
        const workspacePath = stringValue(result.metadata.workspacePath);
        if (!workspacePath) return undefined;
        return {
          instance_id: result.caseId,
          patch: workspacePatch(workspacePath),
          prefix: item.mode
        };
      })
      .filter((row): row is { instance_id: string; patch: string; prefix: BenchmarkAssistanceMode } => Boolean(row));
    if (patchRows.length === 0) continue;
    const patchPath = path.join(input.outputs.rawDir, `${input.entry.id}.${item.mode}.patches.json`);
    writeJsonAtomic(patchPath, patchRows);
    patchPaths[item.mode] = patchPath;
  }
  return Object.keys(patchPaths).length > 0 ? patchPaths : undefined;
}

function campaignOutputPaths(outDir: string, baselineCacheDir?: string | undefined): CampaignOutputPaths {
  return {
    manifestPath: path.join(outDir, "campaign-manifest.json"),
    summaryPath: path.join(outDir, "campaign-summary.json"),
    resultsCsvPath: path.join(outDir, "results.csv"),
    failuresCsvPath: path.join(outDir, "failures.csv"),
    proxyResultsCsvPath: path.join(outDir, "proxy-results.csv"),
    workerPacketsDir: path.join(outDir, "worker-packets"),
    rawDir: path.join(outDir, "raw"),
    workDir: path.join(outDir, "work"),
    baselineCacheDir: path.resolve(baselineCacheDir ?? path.join(outDir, "baseline-cache"))
  };
}

function validateStage(stage: CampaignStage): void {
  if (!CAMPAIGN_STAGES.has(stage)) throw new Error(`Unsupported campaign stage: ${stage}`);
}

function validateProfile(profile: CampaignRunProfile): void {
  if (!["default", "fast-live", "proof", "publication"].includes(profile)) throw new Error(`Unsupported campaign profile: ${profile}`);
}

function effectiveCampaignParallel(stage: CampaignStage, entries: CampaignEntry[], requestedParallel: number): number {
  if (stage === "proxy" || entries.every((entry) => stageForEntry(entry, stage) === "proxy")) return 1;
  return requestedParallel;
}

function entryMatchesStage(entry: CampaignEntry, stage: CampaignStage): boolean {
  if (stage === "all") return true;
  return stageForEntry(entry, stage) === stage;
}

function stageForEntry(entry: CampaignEntry, _requested: CampaignStage): CampaignStage {
  if (entry.kind === "proxy") return "proxy";
  if (entry.kind === "official_eval") return "official";
  return "live";
}

function modesFor(manifest: CampaignManifest, entry: CampaignEntry): BenchmarkAssistanceMode[] {
  return entry.modes ?? (manifest.defaults?.commands ? Object.keys(manifest.defaults.commands).filter(isBenchmarkAssistanceMode) : ["baseline", "kairn_codex_session"]);
}

function commandFor(manifest: CampaignManifest, entry: CampaignEntry, mode: BenchmarkAssistanceMode): string {
  const model = manifest.defaults?.model ?? "gpt-5.4-mini";
  const command = entry.commands?.[mode] ?? manifest.defaults?.commands?.[mode];
  if (!command) throw new Error(`${entry.id}: missing command for mode ${mode}`);
  return command.replaceAll("{model}", model);
}

function setupCommandFor(manifest: CampaignManifest, entry: CampaignEntry, mode: BenchmarkAssistanceMode): string | undefined {
  return entry.setupCommands?.[mode] ?? manifest.defaults?.setupCommands?.[mode];
}

function rootFor(entry: CampaignEntry): string {
  return path.resolve(entry.root ?? process.cwd());
}

function matchesOnly(entry: CampaignEntry, only: string | undefined): boolean {
  if (!only) return true;
  return entry.id === only || entry.kind === only || (entry.tags ?? []).includes(only) || entry.contextBehavior === only;
}

function pathsMatch(actual: string, expected: string): boolean {
  const normalizedActual = actual.replaceAll("\\", "/");
  const normalizedExpected = expected.replaceAll("\\", "/");
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.endsWith(`/${normalizedExpected}`) ||
    normalizedExpected.endsWith(`/${normalizedActual}`)
  );
}

export async function runCampaignTaskPool<T>(tasks: Array<() => Promise<T>>, parallel: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(parallel)), tasks.length) }, () => worker()));
  return results;
}

function orderedArtifacts(entries: CampaignEntry[], artifacts: CampaignArtifact[]): CampaignArtifact[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.entryId, artifact]));
  return entries.map((entry) => byId.get(entry.id)).filter((item): item is CampaignArtifact => Boolean(item));
}

function repeatedFailureClasses(rows: CampaignResultRow[]): Array<{ classification: string; count: number; examples: string[] }> {
  const counts = new Map<string, { count: number; examples: string[] }>();
  const benign = new Set([
    "pass",
    "proxy_pass",
    "clean_passpass",
    "quality_rescue",
    "mcp_useful_attribution",
    "valid_guardrail",
    "suppression_expected",
    "passive_token_regression",
    "missed_savings_opportunity",
    "campaign_paused"
  ]);
  for (const row of rows) {
    for (const classification of row.classifications.split(";").filter(Boolean)) {
      if (benign.has(classification)) continue;
      const existing = counts.get(classification) ?? { count: 0, examples: [] };
      existing.count += 1;
      if (existing.examples.length < 5) existing.examples.push(row.entryId);
      counts.set(classification, existing);
    }
  }
  return [...counts.entries()].map(([classification, value]) => ({ classification, ...value })).filter((item) => item.count > 1);
}

function medianElapsedByStage(rows: CampaignResultRow[]): Record<string, number> {
  const grouped = new Map<string, number[]>();
  for (const row of rows) grouped.set(row.stage, [...(grouped.get(row.stage) ?? []), row.elapsedMs]);
  return Object.fromEntries([...grouped.entries()].map(([stage, values]) => [stage, median(values)]));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function removeSuccessfulPartialArtifact(artifactPath: string): void {
  const partialPath = `${artifactPath}.partial.json`;
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
}

function optionalNumber(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "" : String(value);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resultQualityPassed(result: BenchmarkReport["results"][number]): boolean {
  return result.taskOutcome === "pass" && result.metadata.qualityGatePassed !== false;
}

function benchmarkReportMcpCalls(report: BenchmarkReport | undefined): number {
  return report?.results.reduce((total, result) => {
    return total + (numberValue(result.metadata.actualMcpToolCalls) ?? numberValue(result.metadata.mcpToolCalls) ?? 0);
  }, 0) ?? 0;
}

function benchmarkReportMcpUsefulAttribution(report: BenchmarkReport | undefined): number {
  return report?.results.reduce((total, result) => {
    return total + (
      numberValue(result.metadata.mcpAttributedUsefulFileCount) ??
      numberValue(result.metadata.mcpReturnedUsefulFileCount) ??
      numberValue(result.metadata.mcpReturnedExpectedFileCount) ??
      0
    );
  }, 0) ?? 0;
}

function proofModeReports(report: BenchmarkProofReport): Array<{ mode: BenchmarkAssistanceMode; report: BenchmarkReport }> {
  const entries: Array<[BenchmarkAssistanceMode, BenchmarkReport | undefined]> = [
    ["baseline", report.baseline],
    ["prompt_only", report.promptOnly],
    ["prompt_plus_hooks", report.promptPlusHooks],
    ["manual_prime", report.manualPrime],
    ["hook_full_prime", report.hookFullPrime],
    ["hook_tiny_directive", report.hookTinyDirective],
    ["hook_tiny_with_failures", report.hookTinyWithFailures],
    ["kairn_codex_session", report.kairnCodexSession],
    ["kairn_codex_session_no_governor", report.kairnCodexSessionNoGovernor],
    ["mcp_first", report.mcpFirst],
    ["real_mcp_first", report.realMcpFirst],
    ["mcp_first_plus_hook_full_prime", report.mcpFirstPlusHookFullPrime],
    ["hybrid_mcp_brief", report.hybridMcpBrief],
    ["passive_hooks", report.passiveHooks],
    ["proactive", report.proactive]
  ];
  const baselineRunId = report.baseline.run.id;
  return entries.flatMap(([mode, modeReport]) => {
    if (!modeReport) return [];
    if (
      mode !== "baseline" &&
      (modeReport.run.id === baselineRunId || modeReport.run.metadata?.assistanceMode === "baseline")
    ) return [];
    return [{ mode, report: modeReport }];
  });
}

function bestProofDelta(report: BenchmarkProofReport): BenchmarkComparison["observedTokenDelta"] | undefined {
  return Object.values(report.observedTokenDeltas)
    .filter((delta): delta is NonNullable<typeof delta> => Boolean(delta))
    .sort((a, b) => (b.savedTokens ?? Number.NEGATIVE_INFINITY) - (a.savedTokens ?? Number.NEGATIVE_INFINITY))[0];
}

function bestTimeoutEstimatedProofDelta(
  report: BenchmarkProofReport,
  candidates: Array<{ mode: BenchmarkAssistanceMode; report: BenchmarkReport }>
): { mode: BenchmarkAssistanceMode; baselineTokens: number; observedTokens: number; savedTokens: number; savingsRate: number } | undefined {
  const baselineTokens = reportResponseTokens(report.baseline);
  if (baselineTokens === undefined || baselineTokens <= 0) return undefined;
  if (report.baseline.observed?.codexTokens !== undefined) return undefined;

  const baselineTimedOut = reportHasAgentTimeout(report.baseline);
  return candidates
    .flatMap((candidate) => {
      if (candidate.report.observed?.codexTokens !== undefined) return [];
      if (!baselineTimedOut && !reportHasAgentTimeout(candidate.report)) return [];
      if (!candidate.report.results.every(resultQualityPassed)) return [];
      const observedTokens = reportResponseTokens(candidate.report);
      if (observedTokens === undefined || observedTokens <= 0) return [];
      const savedTokens = baselineTokens - observedTokens;
      return [{
        mode: candidate.mode,
        baselineTokens,
        observedTokens,
        savedTokens,
        savingsRate: savedTokens / baselineTokens
      }];
    })
    .sort((a, b) => b.savedTokens - a.savedTokens)[0];
}

function reportResponseTokens(report: BenchmarkReport): number | undefined {
  const tokens = sum(report.results.map((result) => result.responseTokens).filter(isNumber));
  return tokens > 0 ? tokens : undefined;
}

function reportHasAgentTimeout(report: BenchmarkReport): boolean {
  return report.results.some((result) => result.metadata.agentTimedOut === true);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isBenchmarkAssistanceMode(value: string): value is BenchmarkAssistanceMode {
  return [
    "baseline",
    "prompt_only",
    "prompt_plus_hooks",
    "manual_prime",
    "hook_full_prime",
    "hook_tiny_directive",
    "hook_tiny_with_failures",
    "kairn_codex_session",
    "kairn_codex_session_no_governor",
    "mcp_first",
    "real_mcp_first",
    "mcp_first_plus_hook_full_prime",
    "hybrid_mcp_brief",
    "passive_hooks",
    "proactive"
  ].includes(value);
}
