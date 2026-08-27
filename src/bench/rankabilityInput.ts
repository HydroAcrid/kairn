// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEvidenceRankerArtifact, predictEvidenceRelevance } from "../retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES, type EvidenceFeatureVector, type EvidenceRankerArtifact } from "../types.js";

export const RANKABILITY_INPUT_SCHEMA = "rankability-input.v2" as const;

export type RankabilityLabelState = "positive" | "negative" | "unreviewed";

export type RankabilityCandidateInput = {
  path: string;
  gitBlobOid: string | null;
  features: number[];
  label: 0 | 1 | null;
  labelState: RankabilityLabelState;
  labelProvenance: string | null;
  labelWeight: number | null;
};

export type RankabilityCaseInput = {
  id: string;
  cohorts: Array<"required_source" | "weak_patch_calibration">;
  split: "train" | "calibration";
  language: string;
  scenario: string;
  repositoryLineageId: string;
  repositoryUrl: string;
  repositoryRef: string;
  querySha256: string;
  requiredFiles: Array<{
    path: string;
    provenance: "required_source_oracle";
    contentSha256: string | null;
    contentHashStatus: "verified" | "missing_checkout" | "missing_at_ref";
  }>;
  officialPatchFiles: string[];
  stages: {
    inventoryAvailable: string[];
    probe: string[];
    initial64: string[];
    bounded128: string[];
  };
  lanes: {
    semanticRaw: string[];
    semantic: string[];
    semanticEvidence: string[];
    bm25: string[];
    graph: string[];
    graphImporter: string[];
    graphConsensus: string[];
  };
  candidates: RankabilityCandidateInput[];
};

export type CandidateOracleInput = {
  id: string;
  language: string;
  scenario: string;
  requiredFiles: string[];
  deterministic: { initial64: string[]; bounded128: string[] };
  semantic: { initial64: string[]; bounded128: string[] } | null;
};

export type RankabilityInput = {
  schemaVersion: typeof RANKABILITY_INPUT_SCHEMA;
  promotionEligible: false;
  detachedHoldoutOpened: false;
  featureSchemaVersion: string;
  provenance: {
    sourceManifest: ArtifactDigest;
    sourceReport: ArtifactDigest;
    oracleCaseSet: ArtifactDigest;
    deterministicOracleReport: ArtifactDigest;
    semanticOracleProgress: ArtifactDigest;
    rankerCandidateGeneratorCommit: string;
    semanticOracleGeneratorCommit: string;
    semanticOracleComplete: boolean;
    semanticOracleSelectedCases: number;
    sourceReconstructionExact: boolean;
  };
  models: Array<{ id: string; checksum: string; path: string }>;
  cohortCounts: {
    candidateOracleExpected: 38;
    candidateOracleMaterialized: number;
    requiredSourceCases: number;
    requiredSourceFiles: number;
    weakPatchCalibrationCases: number;
  };
  candidateOracle: CandidateOracleInput[];
  cases: RankabilityCaseInput[];
};

type ArtifactDigest = { path: string; sha256: string; bytes: number };
type JsonRecord = Record<string, unknown>;
const treeCache = new Map<string, Map<string, string>>();

export type BuildRankabilityInputOptions = {
  sourceManifestPath: string;
  sourceReportPath: string;
  oracleCaseSetPath: string;
  deterministicOracleReportPath: string;
  semanticOracleProgressPath: string;
  modelPaths: string[];
  repositoryCacheRoot: string;
};

export function buildRankabilityInput(options: BuildRankabilityInputOptions): RankabilityInput {
  const sourceManifest = loadJson(options.sourceManifestPath);
  const sourceReport = loadJson(options.sourceReportPath);
  const oracleSet = loadJson(options.oracleCaseSetPath);
  const deterministicReport = loadJson(options.deterministicOracleReportPath);
  const semanticProgress = loadJson(options.semanticOracleProgressPath);
  validateSources(sourceManifest, sourceReport, oracleSet, deterministicReport, semanticProgress);

  const manifestCases = byId(array(sourceManifest.cases, "sourceManifest.cases"), "sourceManifest.cases");
  const reportCases = byId(array(sourceReport.cases, "sourceReport.cases"), "sourceReport.cases");
  const deterministicCases = byId(array(deterministicReport.cases, "deterministicReport.cases"), "deterministicReport.cases");
  const semanticCases = byId(array(semanticProgress.materializedCases, "semanticProgress.materializedCases"), "semanticProgress.materializedCases");
  const oracleIds = stringArray(oracleSet.caseIds, "oracleSet.caseIds");
  if (oracleIds.length !== 38 || new Set(oracleIds).size !== 38) throw new Error("candidate oracle must contain exactly 38 unique cases");

  const candidateOracle = oracleIds.map((id): CandidateOracleInput => {
    const deterministic = requiredCase(deterministicCases, id, "deterministic oracle report");
    const semantic = semanticCases.get(id);
    const requiredFiles = stringArray(deterministic.requiredSourceExistingFiles, `${id}.requiredSourceExistingFiles`);
    return {
      id,
      language: caseDimension(id, manifestCases, semantic, "language"),
      scenario: caseDimension(id, manifestCases, semantic, "scenario"),
      requiredFiles,
      deterministic: {
        initial64: stringArray(deterministic.initialCandidatePaths, `${id}.deterministic.initialCandidatePaths`).slice(0, 64),
        bounded128: stringArray(deterministic.enrichedCandidatePaths, `${id}.deterministic.enrichedCandidatePaths`).slice(0, 128)
      },
      semantic: semantic ? {
        initial64: candidatePaths(semantic.candidates, `${id}.semantic.candidates`).slice(0, 64),
        bounded128: candidatePaths(semantic.trainingCandidates, `${id}.semantic.trainingCandidates`).slice(0, 128)
      } : null
    };
  });

  const requiredIds = [...reportCases.values()]
    .filter((item) => stringArray(item.requiredSourceExistingFiles, `${String(item.id)}.requiredSourceExistingFiles`).length > 0)
    .map((item) => string(item.id, "report case id"));
  const calibrationIds = [...manifestCases.values()]
    .filter((item) => item.split === "calibration")
    .map((item) => string(item.id, "manifest case id"));
  const selectedIds = [...new Set([...requiredIds, ...calibrationIds])].sort();

  const cases = selectedIds.map((id): RankabilityCaseInput => {
    const manifestCase = requiredCase(manifestCases, id, "source manifest");
    const reportCase = requiredCase(reportCases, id, "source report");
    const requiredFiles = stringArray(reportCase.requiredSourceExistingFiles, `${id}.requiredSourceExistingFiles`);
    const officialPatchFiles = stringArray(reportCase.officialPatchSourceExistingFiles, `${id}.officialPatchSourceExistingFiles`);
    const repositoryUrl = string(manifestCase.repositoryUrl, `${id}.repositoryUrl`);
    const repositoryRef = string(manifestCase.repositoryRef, `${id}.repositoryRef`);
    const candidates = array(manifestCase.trainingCandidates, `${id}.trainingCandidates`).map((value, index) => {
      const candidate = record(value, `${id}.trainingCandidates[${index}]`);
      const label: 0 | 1 | null = candidate.label === 0 ? 0 : candidate.label === 1 ? 1 : null;
      const features = featureArray(record(candidate.features, `${id}.trainingCandidates[${index}].features`));
      const candidatePath = string(candidate.path, `${id}.trainingCandidates[${index}].path`);
      return {
        path: candidatePath,
        gitBlobOid: resolveGitBlobOid(options.repositoryCacheRoot, repositoryUrl, repositoryRef, candidatePath),
        features,
        label,
        labelState: label === 1 ? "positive" as const : label === 0 ? "negative" as const : "unreviewed" as const,
        labelProvenance: typeof candidate.labelProvenance === "string" ? candidate.labelProvenance : null,
        labelWeight: typeof candidate.labelWeight === "number" && Number.isFinite(candidate.labelWeight) ? candidate.labelWeight : null
      };
    });
    const candidatePathsSet = new Set(candidates.map((candidate) => candidate.path));
    const diagnostics = record(reportCase.candidateDiagnostics, `${id}.candidateDiagnostics`);
    return {
      id,
      cohorts: [
        ...(requiredFiles.length > 0 ? ["required_source" as const] : []),
        ...(manifestCase.split === "calibration" ? ["weak_patch_calibration" as const] : [])
      ],
      split: oneOf(manifestCase.split, ["train", "calibration"] as const, `${id}.split`),
      language: string(manifestCase.language, `${id}.language`),
      scenario: string(manifestCase.scenario, `${id}.scenario`),
      repositoryLineageId: string(manifestCase.repositoryLineageId, `${id}.repositoryLineageId`),
      repositoryUrl,
      repositoryRef,
      querySha256: sha256String(manifestCase.querySha256, `${id}.querySha256`),
      requiredFiles: requiredFiles.map((filePath) => {
        const digest = resolveContentSha256(options.repositoryCacheRoot, repositoryUrl, repositoryRef, filePath);
        return { path: filePath, provenance: "required_source_oracle", ...digest };
      }),
      officialPatchFiles,
      stages: {
        inventoryAvailable: requiredFiles.filter((filePath) => candidatePathsSet.has(filePath) || resolveGitBlobOid(options.repositoryCacheRoot, repositoryUrl, repositoryRef, filePath) !== null),
        probe: candidatePaths(reportCase.probeCandidates, `${id}.probeCandidates`),
        initial64: stringArray(reportCase.initialCandidatePaths, `${id}.initialCandidatePaths`).slice(0, 64),
        bounded128: stringArray(reportCase.enrichedCandidatePaths, `${id}.enrichedCandidatePaths`).slice(0, 128)
      },
      lanes: {
        semanticRaw: optionalStringArray(diagnostics.semanticRawFused, `${id}.semanticRawFused`),
        semantic: stringArray(diagnostics.semanticFused, `${id}.semanticFused`),
        semanticEvidence: stringArray(diagnostics.semanticEvidence, `${id}.semanticEvidence`),
        bm25: stringArray(diagnostics.bm25, `${id}.bm25`),
        graph: stringArray(diagnostics.graph, `${id}.graph`),
        graphImporter: optionalStringArray(diagnostics.graphImporter, `${id}.graphImporter`),
        graphConsensus: stringArray(diagnostics.graphConsensus, `${id}.graphConsensus`)
      },
      candidates
    };
  });

  const models = options.modelPaths.map((modelPath) => {
    const artifact = loadEvidenceRankerArtifact(modelPath);
    validateModelsAgainstCases(artifact, cases);
    return { id: artifact.modelId, checksum: artifact.checksum, path: repositoryRelative(modelPath) };
  });
  const requiredCases = cases.filter((item) => item.cohorts.includes("required_source"));
  return {
    schemaVersion: RANKABILITY_INPUT_SCHEMA,
    promotionEligible: false,
    detachedHoldoutOpened: false,
    featureSchemaVersion: string(sourceManifest.featureSchemaVersion, "sourceManifest.featureSchemaVersion"),
    provenance: {
      sourceManifest: digest(options.sourceManifestPath),
      sourceReport: digest(options.sourceReportPath),
      oracleCaseSet: digest(options.oracleCaseSetPath),
      deterministicOracleReport: digest(options.deterministicOracleReportPath),
      semanticOracleProgress: digest(options.semanticOracleProgressPath),
      rankerCandidateGeneratorCommit: string(record(sourceManifest.materializer, "sourceManifest.materializer").kairnCommit, "materializer.kairnCommit"),
      semanticOracleGeneratorCommit: string(semanticProgress.kairnCommit, "semanticProgress.kairnCommit"),
      semanticOracleComplete: semanticProgress.complete === true,
      semanticOracleSelectedCases: stringArray(semanticProgress.selectedCaseIds, "semanticProgress.selectedCaseIds").length,
      sourceReconstructionExact: true
    },
    models,
    cohortCounts: {
      candidateOracleExpected: 38,
      candidateOracleMaterialized: candidateOracle.filter((item) => item.semantic !== null).length,
      requiredSourceCases: requiredCases.length,
      requiredSourceFiles: requiredCases.reduce((sum, item) => sum + item.requiredFiles.length, 0),
      weakPatchCalibrationCases: cases.filter((item) => item.cohorts.includes("weak_patch_calibration")).length
    },
    candidateOracle,
    cases
  };
}

function validateSources(manifest: JsonRecord, report: JsonRecord, oracleSet: JsonRecord, deterministic: JsonRecord, semantic: JsonRecord): void {
  if (manifest.schemaVersion !== "ranker-corpus.v1" || report.schemaVersion !== "ranker-corpus-materialization-report.v1") {
    throw new Error("rankability input requires the frozen ranker corpus manifest and report");
  }
  if (oracleSet.schemaVersion !== "semantic-oracle-case-set.v1") throw new Error("unsupported candidate oracle case set");
  if (semantic.schemaVersion !== "ranker-corpus-materialization-progress.v1") throw new Error("unsupported semantic oracle progress artifact");
  if (typeof semantic.complete !== "boolean") throw new Error("semantic oracle progress is missing its completion state");
  if (!/^[a-f0-9]{40}$/i.test(string(semantic.kairnCommit, "semanticProgress.kairnCommit"))) throw new Error("semantic oracle progress has an invalid generator commit");
  if (!Array.isArray(deterministic.cases)) throw new Error("deterministic oracle report is missing cases");
  const materializer = record(manifest.materializer, "sourceManifest.materializer");
  if (report.kairnCommit !== materializer.kairnCommit || report.intakeSha256 !== materializer.intakeSha256) {
    throw new Error("frozen source manifest/report provenance mismatch");
  }
  if (manifest.sealed !== false || manifest.status !== "draft_for_label_review") throw new Error("unexpected source corpus state");
  if (array(manifest.cases, "sourceManifest.cases").some((value, index) => record(value, `sourceManifest.cases[${index}]`).split === "holdout")) {
    throw new Error("rankability input source may not contain detached holdout rows");
  }
}

function validateModelsAgainstCases(model: EvidenceRankerArtifact, cases: RankabilityCaseInput[]): void {
  for (const item of cases) {
    for (const candidate of item.candidates) predictEvidenceRelevance(model, featureVector(candidate.features));
  }
}

function resolveGitBlobOid(cacheRoot: string, repositoryUrl: string, repositoryRef: string, filePath: string): string | null {
  const repository = repositoryCachePath(cacheRoot, repositoryUrl);
  if (!fs.existsSync(repository)) return null;
  try {
    const cacheKey = `${repository}:${repositoryRef}`;
    let files = treeCache.get(cacheKey);
    if (!files) {
      const output = execFileSync("git", ["ls-tree", "-r", "-z", repositoryRef], {
        cwd: repository,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      });
      files = new Map(output.split("\0").filter(Boolean).flatMap((entry) => {
        const match = /^\d+\s+blob\s+([a-f0-9]{40,64})\t([\s\S]+)$/i.exec(entry);
        return match ? [[match[2]!, match[1]!.toLowerCase()] as const] : [];
      }));
      treeCache.set(cacheKey, files);
    }
    return files.get(filePath) ?? null;
  } catch {
    return null;
  }
}

function resolveContentSha256(cacheRoot: string, repositoryUrl: string, repositoryRef: string, filePath: string): Pick<RankabilityCaseInput["requiredFiles"][number], "contentSha256" | "contentHashStatus"> {
  const repository = repositoryCachePath(cacheRoot, repositoryUrl);
  if (!fs.existsSync(repository)) return { contentSha256: null, contentHashStatus: "missing_checkout" };
  try {
    const bytes = execFileSync("git", ["show", `${repositoryRef}:${filePath}`], { cwd: repository, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return { contentSha256: crypto.createHash("sha256").update(bytes).digest("hex"), contentHashStatus: "verified" };
  } catch {
    return { contentSha256: null, contentHashStatus: "missing_at_ref" };
  }
}

function repositoryCachePath(cacheRoot: string, repositoryUrl: string): string {
  const key = crypto.createHash("sha256").update(repositoryUrl).digest("hex").slice(0, 24);
  return path.resolve(cacheRoot, "repositories", `${key}.git`);
}

function featureArray(features: JsonRecord): number[] {
  return EVIDENCE_FEATURE_NAMES.map((name) => finite(features[name], `features.${name}`));
}

function featureVector(values: number[]): EvidenceFeatureVector {
  if (values.length !== EVIDENCE_FEATURE_NAMES.length) throw new Error("feature vector length mismatch");
  return Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name, index) => [name, values[index]!])) as EvidenceFeatureVector;
}

function candidatePaths(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(record(item, `${label}[${index}]`).path, `${label}[${index}].path`));
}

function caseDimension(id: string, manifestCases: Map<string, JsonRecord>, semantic: JsonRecord | undefined, key: "language" | "scenario"): string {
  const source = manifestCases.get(id) ?? semantic;
  if (!source) {
    const parts = id.split("-");
    if (key === "language" && parts.length >= 4) return parts[2]!;
    if (key === "scenario" && parts.length >= 5) return parts.slice(3, -1).join("_");
    throw new Error(`${id}: cannot recover ${key}`);
  }
  return string(source[key], `${id}.${key}`);
}

function byId(values: unknown[], label: string): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>();
  for (let index = 0; index < values.length; index += 1) {
    const item = record(values[index], `${label}[${index}]`);
    const id = string(item.id, `${label}[${index}].id`);
    if (result.has(id)) throw new Error(`${label} contains duplicate case ${id}`);
    result.set(id, item);
  }
  return result;
}

function requiredCase(values: Map<string, JsonRecord>, id: string, label: string): JsonRecord {
  const value = values.get(id);
  if (!value) throw new Error(`${label} is missing case ${id}`);
  return value;
}

function digest(filePath: string): ArtifactDigest {
  const bytes = fs.readFileSync(path.resolve(filePath));
  return { path: repositoryRelative(filePath), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function repositoryRelative(filePath: string): string {
  const resolved = path.resolve(filePath);
  const relative = path.relative(process.cwd(), resolved).replace(/\\/g, "/");
  return relative.startsWith("../") ? `external-frozen-source/${path.basename(resolved)}` : relative;
}

function loadJson(filePath: string): JsonRecord {
  return record(JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as unknown, filePath);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha256String(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[a-f0-9]{64}$/i.test(parsed)) throw new Error(`${label} must be SHA-256`);
  return parsed.toLowerCase();
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function optionalStringArray(value: unknown, label: string): string[] {
  return value === undefined ? [] : stringArray(value, label);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return value as T[number];
}
