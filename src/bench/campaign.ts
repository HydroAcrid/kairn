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

export type CampaignArtifact = {
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
  artifacts: CampaignArtifact[];
  gates: {
    boundedPoolRequiredSourceMissesAt128: 0;
    servedRecallAt64Overall: number;
    servedRecallAt64PerLanguage: number;
    expectedCalibrationErrorMax: number;
    generatedVendorTopOneMax: 0;
  };
};

export type ResolvedCampaignArtifact = CampaignArtifact & {
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
    manifestSha256: sha256(bytes),
    artifacts: resolvedArtifacts.map(({ id, actualSha256 }) => ({ id, sha256: actualSha256 })),
    caseIds
  };
  return {
    campaign,
    manifestPath: absoluteManifest,
    manifestSha256: sha256(bytes),
    artifacts: resolvedArtifacts,
    caseIds,
    fingerprint: sha256(JSON.stringify(fingerprintPayload))
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
  const artifacts = array(root.artifacts, "artifacts").map((item, index): CampaignArtifact => {
    const artifact = record(item, `artifacts[${index}]`);
    const kind = oneOf(artifact.kind, ["case_manifest", "lineage", "review", "candidate_pool", "training_rows", "model", "model_manifest", "evaluation", "holdout"] as const, `artifacts[${index}].kind`);
    return {
      id: string(artifact.id, `artifacts[${index}].id`), kind,
      path: repositoryRelativePath(artifact.path, `artifacts[${index}].path`),
      sha256: hash(artifact.sha256, `artifacts[${index}].sha256`),
      parents: stringArray(artifact.parents, `artifacts[${index}].parents`),
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

function assertAcyclicArtifacts(artifacts: CampaignArtifact[]): void {
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

function digestParts(...values: string[]): string { return sha256(values.join("\0")); }
function fileSha256(filePath: string): string { return sha256(fs.readFileSync(filePath)); }
function sha256(value: crypto.BinaryLike): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function string(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`); return value; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`); return value; }
function hash(value: unknown, label: string, length = 64): string { const parsed = string(value, label); if (!new RegExp(`^[a-f0-9]{${length}}$`, "i").test(parsed)) throw new Error(`${label} must be a ${length}-character hexadecimal digest`); return parsed.toLowerCase(); }
function stringArray(value: unknown, label: string): string[] { return array(value, label).map((item, index) => string(item, `${label}[${index}]`)); }
function nonnegativeInteger(value: unknown, label: string): number { if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`); return Number(value); }
function probability(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a probability`); return value; }
function exact<T extends string | number>(value: unknown, expected: T, label: string): T { if (value !== expected) throw new Error(`${label} must equal ${String(expected)}`); return expected; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} must be one of ${allowed.join(", ")}`); return value as T; }
