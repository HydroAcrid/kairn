// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { EVIDENCE_FEATURE_SCHEMA_VERSION } from "../src/retrieval/evidenceModel.js";
import type { EvidenceCandidate } from "../src/types.js";

const require = createRequire(import.meta.url);

type Split = "train" | "calibration" | "holdout";
type Language = "python" | "typescript" | "go" | "java" | "cpp";
type Scenario = "source_localization" | "failure_first" | "long_session";
type Origin = "public_benchmark" | "public_patch" | "synthetic";

type IntakeCase = {
  id: string;
  split: Split;
  language: Language;
  scenario: Scenario;
  repositoryLineageId: string;
  repositoryUrl: string;
  repositoryRef: string;
  publicSourceUrl: string;
  dataOrigin: Origin;
  prompt: string;
  requiredSourceFiles: string[];
  officialPatchSourceFiles: string[];
  verifiedObservedReadTouchFiles: string[];
  qualityVerified: boolean;
  explicitNoiseFiles: string[];
  syntheticVariantOf?: string;
  syntheticVariantIndex?: 1 | 2;
  localFixtureRoot?: string;
};

type Intake = {
  schemaVersion: "ranker-corpus-intake.v1";
  corpusId: string;
  featureSchemaVersion: string;
  migratedFeatureSchemaFrom?: "evidence-features-v1";
  sealed: boolean;
  sampleOnly: boolean;
  lineageRegistry: string;
  cases: IntakeCase[];
};

export type MaterializeOptions = {
  intakePath: string;
  outPath: string;
  reportPath: string;
  cacheDir?: string;
  allowSample?: boolean;
  allowLocalFixture?: boolean;
  draft?: boolean;
  limit?: number;
  caseIds?: string[];
  processIsolation?: boolean;
  isolatedWorker?: boolean;
  migrateFeatureSchema?: boolean;
};

const INTAKE_KEYS = new Set([
  "id", "split", "language", "scenario", "repositoryLineageId", "repositoryUrl",
  "repositoryRef", "publicSourceUrl", "dataOrigin", "prompt", "requiredSourceFiles",
  "officialPatchSourceFiles", "verifiedObservedReadTouchFiles", "qualityVerified",
  "explicitNoiseFiles", "syntheticVariantOf", "syntheticVariantIndex", "localFixtureRoot"
]);

export async function materializeEvidenceCorpus(options: MaterializeOptions): Promise<{
  manifestPath: string;
  reportPath: string;
  caseCount: number;
}> {
  if (options.processIsolation) return materializeEvidenceCorpusIsolated(options);
  const intakePath = path.resolve(options.intakePath);
  const outPath = path.resolve(options.outPath);
  const reportPath = path.resolve(options.reportPath);
  const intake = parseIntake(JSON.parse(fs.readFileSync(intakePath, "utf8")), {
    allowSample: options.allowSample === true,
    allowLocalFixture: options.allowLocalFixture === true,
    draft: options.draft === true,
    migrateFeatureSchema: options.migrateFeatureSchema === true
  });
  const intakeDir = path.dirname(intakePath);
  const registryPath = path.resolve(intakeDir, intake.lineageRegistry);
  assertWithin(intakeDir, registryPath, "lineageRegistry");
  validateLineageAssignments(registryPath, intake.cases);

  const kairnRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const kairnCommit = git(["rev-parse", "HEAD"], kairnRoot);
  if (!intake.sampleOnly && git(["status", "--porcelain"], kairnRoot)) {
    throw new Error("production corpus materialization requires a clean Kairn checkout");
  }
  const cacheDir = path.resolve(options.cacheDir ?? path.join(kairnRoot, "artifacts", "ranker-checkouts"));
  fs.mkdirSync(cacheDir, { recursive: true });

  const materializedCases: Array<Record<string, unknown>> = [];
  const reportCases: Array<Record<string, unknown>> = [];
  const selectedCases = selectIntakeCases(intake.cases, options);
  for (const intakeCase of selectedCases) {
    const checkout = resolveCheckout(intakeCase, cacheDir, {
      allowLocalFixture: options.allowLocalFixture === true,
      sampleOnly: intake.sampleOnly
    });
    const runtime = new KairnRuntime(checkout.root);
    try {
      const requiredSourcePartition = partitionRepositoryPaths(checkout.root, intakeCase.requiredSourceFiles);
      const officialPatchSourcePartition = partitionRepositoryPaths(checkout.root, intakeCase.officialPatchSourceFiles);
      const inspection = await runtime.inspectEvidenceCandidates({ query: intakeCase.prompt, limit: 64 });
      if (!options.draft && inspection.candidates.length < 7) {
        throw new Error(`${intakeCase.id}: candidate generator returned fewer than seven candidates`);
      }
      const labels = buildLabels(intakeCase);
      const candidatePathsAt64 = new Set(inspection.candidates.map((candidate) => normalizePath(candidate.path)));
      const trainingCandidatePaths = new Set(
        inspection.enrichedCandidates.map((candidate) => normalizePath(candidate.path))
      );
      const missingLabels = [...labels.keys()].filter((candidatePath) => !trainingCandidatePaths.has(candidatePath));
      const requiredSourcePaths = new Set(requiredSourcePartition.existing);
      const explicitNoisePaths = new Set(intakeCase.explicitNoiseFiles.map(normalizePath));
      const missingRequiredSourceFiles = [...requiredSourcePaths].filter(
        (candidatePath) => !candidatePathsAt64.has(candidatePath)
      );
      const missingExplicitNoiseFiles = missingLabels.filter((candidatePath) => explicitNoisePaths.has(candidatePath));
      const missingExplicitNoiseFilesAt64 = [...explicitNoisePaths].filter(
        (candidatePath) => !candidatePathsAt64.has(candidatePath)
      );
      if (!options.draft && missingExplicitNoiseFiles.length > 0) {
        throw new Error(`${intakeCase.id}: explicit-noise files missed the training candidate union: ${missingExplicitNoiseFiles.join(", ")}`);
      }
      const requiredRecall = requiredSourcePartition.existing.length > 0
        ? fractionRecalled(requiredSourcePartition.existing, candidatePathsAt64)
        : null;
      const patchRecall = officialPatchSourcePartition.existing.length > 0
        ? fractionRecalled(officialPatchSourcePartition.existing, candidatePathsAt64)
        : null;
      const patchRecallAt128 = officialPatchSourcePartition.existing.length > 0
        ? fractionRecalled(officialPatchSourcePartition.existing, trainingCandidatePaths)
        : null;
      const candidates = inspection.candidates.map((candidate) => labeledCandidate(candidate, labels));
      const trainingCandidates = inspection.enrichedCandidates.map((candidate) => labeledCandidate(candidate, labels));
      const explicitNegativesAt64 = candidates.filter(
        (candidate) => candidate.labelProvenance === "explicit_noise_or_excluded"
      ).length;
      const explicitNegatives = trainingCandidates.filter(
        (candidate) => candidate.labelProvenance === "explicit_noise_or_excluded"
      ).length;
      const positiveCandidates = candidates.filter((candidate) => candidate.label === 1).length;
      if (!options.draft && explicitNegatives < 6) {
        throw new Error(`${intakeCase.id}: at least six training candidates must be curated as explicit noise`);
      }
      const resolvedRef = intakeCase.localFixtureRoot
        ? git(["rev-parse", "HEAD"], checkout.root)
        : intakeCase.repositoryRef;
      materializedCases.push({
        id: intakeCase.id,
        split: intakeCase.split,
        language: intakeCase.language,
        scenario: intakeCase.scenario,
        repositoryLineageId: intakeCase.repositoryLineageId,
        repositoryUrl: intakeCase.repositoryUrl,
        repositoryRef: resolvedRef,
        publicSourceUrl: intakeCase.publicSourceUrl,
        dataOrigin: intakeCase.dataOrigin,
        prompt: intakeCase.prompt,
        querySha256: sha256(intakeCase.prompt),
        requiredSourceOracleCount: intakeCase.requiredSourceFiles.length,
        requiredSourceOracleSha256: sha256(
          [...intakeCase.requiredSourceFiles].map(normalizePath).sort().join("\n")
        ),
        requiredSourceExistingCount: requiredSourcePartition.existing.length,
        requiredSourceExistingSha256: sha256(requiredSourcePartition.existing.join("\n")),
        requiredSourceCreationCount: requiredSourcePartition.creation.length,
        requiredSourceCreationSha256: sha256(requiredSourcePartition.creation.join("\n")),
        ...(intakeCase.syntheticVariantOf ? {
          syntheticVariantOf: intakeCase.syntheticVariantOf,
          syntheticVariantIndex: intakeCase.syntheticVariantIndex
        } : {}),
        candidates,
        trainingCandidates
      });
      reportCases.push({
        id: intakeCase.id,
        repositoryRef: resolvedRef,
        initialCandidateCount: inspection.initialCandidateCount,
        enrichedCandidateCount: inspection.enrichedCandidateCount,
        exportedCandidateCount: candidates.length,
        trainingCandidateCount: trainingCandidates.length,
        requiredSourceRecallAt64: requiredRecall,
        requiredSourceExistingFiles: requiredSourcePartition.existing,
        requiredSourceCreationFiles: requiredSourcePartition.creation,
        officialPatchSourceRecallAt64: patchRecall,
        officialPatchSourceRecallAt128: patchRecallAt128,
        officialPatchSourceExistingFiles: officialPatchSourcePartition.existing,
        officialPatchSourceCreationFiles: officialPatchSourcePartition.creation,
        positiveSourceHitAt64: positiveCandidates > 0,
        explicitNegativeCount: explicitNegatives,
        explicitNegativeCountAt64: explicitNegativesAt64,
        missingLabeledFiles: missingLabels,
        missingRequiredSourceFiles,
        missingExplicitNoiseFiles,
        missingExplicitNoiseFilesAt64,
        missingRequiredOrNoiseFiles: [...missingRequiredSourceFiles, ...missingExplicitNoiseFiles],
        candidatePathsSha256: sha256(trainingCandidates.map((candidate) => candidate.path).join("\n")),
        candidatePathsAt64Sha256: sha256(candidates.map((candidate) => candidate.path).join("\n")),
        ...(options.draft ? {
          signals: inspection.signals,
          index: indexCoverage(runtime.getIndexStatus()),
          initialCandidatePaths: inspection.initialCandidatePaths,
          enrichedCandidatePaths: inspection.enrichedCandidatePaths,
          enrichedCandidates: inspection.enrichedCandidates,
          candidates: inspection.enrichedCandidates.map((candidate) => ({
            path: candidate.path,
            reasons: candidate.reasons
          }))
        } : {})
      });
    } finally {
      runtime.close();
      checkout.cleanup();
    }
  }

  const relativeRegistry = normalizePath(path.relative(path.dirname(outPath), registryPath));
  const manifest = {
    schemaVersion: "ranker-corpus.v1",
    corpusId: intake.corpusId,
    featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
    sealed: options.draft !== true,
    sampleOnly: intake.sampleOnly,
    status: options.draft ? "draft_for_label_review" : "materialized",
    lineageRegistry: relativeRegistry,
    materializer: {
      schemaVersion: "ranker-corpus-materializer.v1",
      kairnCommit,
      intakeSha256: sha256(fs.readFileSync(intakePath)),
      candidateLimit: 64,
      enrichedCandidateLimit: 128,
      graphHops: 1,
      ...(intake.migratedFeatureSchemaFrom
        ? { migratedFeatureSchemaFrom: intake.migratedFeatureSchemaFrom }
        : {})
    },
    cases: materializedCases
  };
  const report = {
    schemaVersion: "ranker-corpus-materialization-report.v1",
    corpusId: intake.corpusId,
    sampleOnly: intake.sampleOnly,
    kairnCommit,
    intakeSha256: sha256(fs.readFileSync(intakePath)),
    caseCount: materializedCases.length,
    candidateRecallEligibleCases: reportCases.filter((row) => row.requiredSourceRecallAt64 !== null).length,
    candidateRecallAt64: fullRecallRate(reportCases, "requiredSourceRecallAt64"),
    positiveSourceAnyHitRateAt64: booleanRate(reportCases, "positiveSourceHitAt64"),
    officialPatchMeanRecallAt64: meanNullable(reportCases, "officialPatchSourceRecallAt64"),
    officialPatchMeanRecallAt128: meanNullable(reportCases, "officialPatchSourceRecallAt128"),
    ...(options.limit || options.caseIds ? {
      partial: true,
      selectedCaseIds: selectedCases.map((item) => item.id)
    } : {}),
    cases: reportCases
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { manifestPath: outPath, reportPath, caseCount: materializedCases.length };
}

async function materializeEvidenceCorpusIsolated(options: MaterializeOptions): Promise<{
  manifestPath: string;
  reportPath: string;
  caseCount: number;
}> {
  const intakePath = path.resolve(options.intakePath);
  const outPath = path.resolve(options.outPath);
  const reportPath = path.resolve(options.reportPath);
  const intake = parseIntake(JSON.parse(fs.readFileSync(intakePath, "utf8")), {
    allowSample: options.allowSample === true,
    allowLocalFixture: options.allowLocalFixture === true,
    draft: options.draft === true,
    migrateFeatureSchema: options.migrateFeatureSchema === true
  });
  const intakeDir = path.dirname(intakePath);
  const registryPath = path.resolve(intakeDir, intake.lineageRegistry);
  assertWithin(intakeDir, registryPath, "lineageRegistry");
  validateLineageAssignments(registryPath, intake.cases);
  const selectedCases = selectIntakeCases(intake.cases, options);
  const kairnRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const kairnCommit = git(["rev-parse", "HEAD"], kairnRoot);
  if (!intake.sampleOnly && git(["status", "--porcelain"], kairnRoot)) {
    throw new Error("production corpus materialization requires a clean Kairn checkout");
  }
  const cacheDir = path.resolve(options.cacheDir ?? path.join(kairnRoot, "artifacts", "ranker-checkouts"));
  fs.mkdirSync(cacheDir, { recursive: true });
  const materializedCases: Array<Record<string, unknown>> = [];
  const reportCases: Array<Record<string, unknown>> = [];
  const scriptPath = fileURLToPath(import.meta.url);

  for (const intakeCase of selectedCases) {
    const temporaryPrefix = path.join(intakeDir, `.kairn-ranker-case-${crypto.randomUUID()}`);
    const childManifestPath = `${temporaryPrefix}.manifest.json`;
    const childReportPath = `${temporaryPrefix}.report.json`;
    const args = [
      require.resolve("tsx/cli"),
      scriptPath,
      "--intake", intakePath,
      "--out", childManifestPath,
      "--report-out", childReportPath,
      "--cache", cacheDir,
      "--case-id", intakeCase.id,
      "--in-process",
      "--isolated-worker",
      ...(options.draft ? ["--draft"] : []),
      ...(options.allowSample ? ["--allow-sample"] : []),
      ...(options.allowLocalFixture ? ["--allow-local-fixture"] : []),
      ...(options.migrateFeatureSchema ? ["--migrate-feature-schema"] : [])
    ];
    try {
      execFileSync(process.execPath, args, {
        cwd: kairnRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024
      });
      const childManifest = record(JSON.parse(fs.readFileSync(childManifestPath, "utf8")), `${intakeCase.id} manifest`);
      const childReport = record(JSON.parse(fs.readFileSync(childReportPath, "utf8")), `${intakeCase.id} report`);
      const manifestRows = array(childManifest.cases, `${intakeCase.id} manifest cases`);
      const reportRows = array(childReport.cases, `${intakeCase.id} report cases`);
      if (manifestRows.length !== 1 || reportRows.length !== 1) {
        throw new Error(`${intakeCase.id}: isolated worker must emit exactly one case`);
      }
      materializedCases.push(record(manifestRows[0], `${intakeCase.id} materialized case`));
      reportCases.push(record(reportRows[0], `${intakeCase.id} report case`));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${intakeCase.id}: isolated materialization failed: ${detail}`);
    } finally {
      fs.rmSync(childManifestPath, { force: true });
      fs.rmSync(childReportPath, { force: true });
    }
  }

  const intakeHash = sha256(fs.readFileSync(intakePath));
  const relativeRegistry = normalizePath(path.relative(path.dirname(outPath), registryPath));
  const partial = Boolean(options.limit || options.caseIds);
  const manifest = {
    schemaVersion: "ranker-corpus.v1",
    corpusId: intake.corpusId,
    featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
    sealed: options.draft !== true,
    sampleOnly: intake.sampleOnly,
    status: options.draft ? "draft_for_label_review" : "materialized",
    lineageRegistry: relativeRegistry,
    materializer: {
      schemaVersion: "ranker-corpus-materializer.v1",
      kairnCommit,
      intakeSha256: intakeHash,
      candidateLimit: 64,
      enrichedCandidateLimit: 128,
      graphHops: 1,
      caseProcessIsolation: true,
      ...(intake.migratedFeatureSchemaFrom
        ? { migratedFeatureSchemaFrom: intake.migratedFeatureSchemaFrom }
        : {})
    },
    cases: materializedCases
  };
  const report = {
    schemaVersion: "ranker-corpus-materialization-report.v1",
    corpusId: intake.corpusId,
    sampleOnly: intake.sampleOnly,
    kairnCommit,
    intakeSha256: intakeHash,
    caseProcessIsolation: true,
    caseCount: materializedCases.length,
    candidateRecallEligibleCases: reportCases.filter((row) => row.requiredSourceRecallAt64 !== null).length,
    candidateRecallAt64: fullRecallRate(reportCases, "requiredSourceRecallAt64"),
    positiveSourceAnyHitRateAt64: booleanRate(reportCases, "positiveSourceHitAt64"),
    officialPatchMeanRecallAt64: meanNullable(reportCases, "officialPatchSourceRecallAt64"),
    officialPatchMeanRecallAt128: meanNullable(reportCases, "officialPatchSourceRecallAt128"),
    ...(partial ? { partial: true, selectedCaseIds: selectedCases.map((item) => item.id) } : {}),
    cases: reportCases
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { manifestPath: outPath, reportPath, caseCount: materializedCases.length };
}

function indexCoverage(stats: ReturnType<KairnRuntime["getIndexStatus"]>): Record<string, unknown> {
  return {
    fileCount: stats.fileCount,
    symbolCount: stats.symbolCount,
    graphEdgeCount: stats.graphEdgeCount,
    semanticChunkCount: stats.semanticChunkCount,
    lexicalDocumentCount: stats.lexicalDocumentCount,
    lexicalTermCount: stats.lexicalTermCount,
    dbSizeBytes: stats.dbSizeBytes,
    walSizeBytes: stats.walSizeBytes,
    totalSizeBytes: stats.totalSizeBytes,
    tiers: stats.tiers
  };
}

function selectIntakeCases(
  cases: IntakeCase[],
  options: Pick<MaterializeOptions, "draft" | "limit" | "caseIds" | "isolatedWorker">
): IntakeCase[] {
  const orderedCases = [...cases].sort((left, right) => left.id.localeCompare(right.id));
  if (options.limit && options.caseIds) throw new Error("--limit and --case-id cannot be combined");
  if ((options.limit || options.caseIds) && !options.draft && !options.isolatedWorker) {
    throw new Error("partial materialization is allowed only with --draft");
  }
  const requestedCaseIds = options.caseIds ? new Set(options.caseIds) : undefined;
  const selectedCases = requestedCaseIds
    ? orderedCases.filter((item) => requestedCaseIds.has(item.id))
    : options.limit
      ? orderedCases.slice(0, options.limit)
      : orderedCases;
  if (requestedCaseIds) {
    const selectedIds = new Set(selectedCases.map((item) => item.id));
    const missing = [...requestedCaseIds].filter((id) => !selectedIds.has(id));
    if (missing.length > 0) throw new Error(`unknown --case-id value(s): ${missing.join(", ")}`);
  }
  return selectedCases;
}

function parseIntake(value: unknown, options: {
  allowSample: boolean;
  allowLocalFixture: boolean;
  draft: boolean;
  migrateFeatureSchema: boolean;
}): Intake {
  const root = record(value, "intake");
  if (root.schemaVersion !== "ranker-corpus-intake.v1") throw new Error("intake schemaVersion must be ranker-corpus-intake.v1");
  const migratedFeatureSchemaFrom = root.featureSchemaVersion === "evidence-features-v1" &&
    options.migrateFeatureSchema
    ? "evidence-features-v1" as const
    : undefined;
  if (root.featureSchemaVersion !== EVIDENCE_FEATURE_SCHEMA_VERSION && !migratedFeatureSchemaFrom) {
    throw new Error(`featureSchemaVersion must be ${EVIDENCE_FEATURE_SCHEMA_VERSION}`);
  }
  if (root.sealed !== true && !options.draft) throw new Error("corpus intake must be sealed before materialization");
  if (root.sealed !== true && root.sealed !== false) throw new Error("sealed must be a boolean");
  if (typeof root.sampleOnly !== "boolean") throw new Error("sampleOnly must be a boolean");
  if (root.sampleOnly && !options.allowSample) throw new Error("sample-only intake requires --allow-sample");
  const cases = array(root.cases, "cases").map((item, index) => parseCase(item, index, root.sampleOnly as boolean, options));
  if (cases.length === 0) throw new Error("cases must not be empty");
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("case ids must be unique");
  return {
    schemaVersion: "ranker-corpus-intake.v1",
    corpusId: string(root.corpusId, "corpusId"),
    featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
    ...(migratedFeatureSchemaFrom ? { migratedFeatureSchemaFrom } : {}),
    sealed: root.sealed as boolean,
    sampleOnly: root.sampleOnly as boolean,
    lineageRegistry: string(root.lineageRegistry, "lineageRegistry"),
    cases
  };
}

function parseCase(
  value: unknown,
  index: number,
  sampleOnly: boolean,
  options: { allowLocalFixture: boolean }
): IntakeCase {
  const label = `cases[${index}]`;
  const row = record(value, label);
  const unknown = Object.keys(row).filter((key) => !INTAKE_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  const split = oneOf(row.split, ["train", "calibration", "holdout"] as const, `${label}.split`);
  const language = oneOf(row.language, ["python", "typescript", "go", "java", "cpp"] as const, `${label}.language`);
  const scenario = oneOf(row.scenario, ["source_localization", "failure_first", "long_session"] as const, `${label}.scenario`);
  const dataOrigin = oneOf(row.dataOrigin, ["public_benchmark", "public_patch", "synthetic"] as const, `${label}.dataOrigin`);
  const repositoryUrl = publicHttps(row.repositoryUrl, `${label}.repositoryUrl`);
  const repositoryLineageId = publicHttps(row.repositoryLineageId, `${label}.repositoryLineageId`).replace(/\/$/, "");
  if (repositoryLineageId !== repositoryUrl.replace(/\.git$/i, "").replace(/\/$/, "")) {
    throw new Error(`${label}: repositoryLineageId must be the canonical repositoryUrl without .git`);
  }
  const repositoryRef = string(row.repositoryRef, `${label}.repositoryRef`);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(repositoryRef)) {
    throw new Error(`${label}.repositoryRef must be a full immutable commit hash`);
  }
  const localFixtureRoot = optionalString(row.localFixtureRoot, `${label}.localFixtureRoot`);
  if (localFixtureRoot && (!sampleOnly || !options.allowLocalFixture)) {
    throw new Error(`${label}.localFixtureRoot is allowed only for an explicitly enabled sample intake`);
  }
  const qualityVerified = row.qualityVerified;
  if (typeof qualityVerified !== "boolean") throw new Error(`${label}.qualityVerified must be a boolean`);
  const verifiedObservedReadTouchFiles = pathArray(row.verifiedObservedReadTouchFiles, `${label}.verifiedObservedReadTouchFiles`);
  if (verifiedObservedReadTouchFiles.length > 0 && !qualityVerified) {
    throw new Error(`${label}: observed read/touch labels require qualityVerified=true`);
  }
  const syntheticVariantOf = optionalString(row.syntheticVariantOf, `${label}.syntheticVariantOf`);
  const syntheticVariantIndex = row.syntheticVariantIndex;
  if (dataOrigin === "synthetic") {
    if (split !== "train" || !syntheticVariantOf || (syntheticVariantIndex !== 1 && syntheticVariantIndex !== 2)) {
      throw new Error(`${label}: synthetic cases require train split, parent id, and variant index 1 or 2`);
    }
  } else if (syntheticVariantOf !== undefined || syntheticVariantIndex !== undefined) {
    throw new Error(`${label}: natural cases must omit synthetic variant fields`);
  }
  const requiredSourceFiles = pathArray(row.requiredSourceFiles, `${label}.requiredSourceFiles`);
  const officialPatchSourceFiles = pathArray(row.officialPatchSourceFiles, `${label}.officialPatchSourceFiles`);
  if (requiredSourceFiles.length === 0 && officialPatchSourceFiles.length === 0 && verifiedObservedReadTouchFiles.length === 0) {
    throw new Error(`${label}: at least one source-positive label is required`);
  }
  return {
    id: string(row.id, `${label}.id`), split, language, scenario, repositoryLineageId,
    repositoryUrl, repositoryRef,
    publicSourceUrl: publicHttps(row.publicSourceUrl, `${label}.publicSourceUrl`, { allowQuery: true }),
    dataOrigin,
    prompt: string(row.prompt, `${label}.prompt`),
    requiredSourceFiles,
    officialPatchSourceFiles,
    verifiedObservedReadTouchFiles,
    qualityVerified,
    explicitNoiseFiles: pathArray(row.explicitNoiseFiles, `${label}.explicitNoiseFiles`),
    ...(syntheticVariantOf ? { syntheticVariantOf, syntheticVariantIndex: syntheticVariantIndex as 1 | 2 } : {}),
    ...(localFixtureRoot ? { localFixtureRoot: path.resolve(localFixtureRoot) } : {})
  };
}

function resolveCheckout(
  intakeCase: IntakeCase,
  cacheDir: string,
  options: { allowLocalFixture: boolean; sampleOnly: boolean }
): { root: string; cleanup: () => void } {
  if (intakeCase.localFixtureRoot) {
    if (!options.allowLocalFixture || !options.sampleOnly) throw new Error("local fixture checkout is not authorized");
    const root = path.resolve(intakeCase.localFixtureRoot);
    if (git(["rev-parse", "HEAD"], root) !== intakeCase.repositoryRef) {
      throw new Error(`${intakeCase.id}: local fixture HEAD does not match repositoryRef`);
    }
    return { root, cleanup: () => undefined };
  }
  const repositoryKey = sha256(intakeCase.repositoryUrl).slice(0, 24);
  const repositoriesDir = path.join(cacheDir, "repositories");
  const worktreesDir = path.join(cacheDir, "worktrees");
  fs.mkdirSync(repositoriesDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  const repositoryCache = path.join(repositoriesDir, `${repositoryKey}.git`);
  if (!fs.existsSync(repositoryCache)) {
    const temporary = path.join(repositoriesDir, `${repositoryKey}.tmp-${crypto.randomUUID()}.git`);
    try {
      git(["clone", "--quiet", "--filter=blob:none", "--bare", intakeCase.repositoryUrl, temporary], repositoriesDir);
      fs.renameSync(temporary, repositoryCache);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  const remote = git(["remote", "get-url", "origin"], repositoryCache).replace(/\.git$/i, "").replace(/\/$/, "");
  const expected = intakeCase.repositoryUrl.replace(/\.git$/i, "").replace(/\/$/, "");
  if (remote !== expected) throw new Error(`${intakeCase.id}: cached checkout remote mismatch`);
  git(["fetch", "--quiet", "--depth=1", "origin", intakeCase.repositoryRef], repositoryCache);
  const checkout = path.join(worktreesDir, `${repositoryKey}-${intakeCase.repositoryRef.slice(0, 12)}-${crypto.randomUUID()}`);
  git(["worktree", "add", "--quiet", "--detach", checkout, intakeCase.repositoryRef], repositoryCache);
  if (git(["rev-parse", "HEAD"], checkout) !== intakeCase.repositoryRef) throw new Error(`${intakeCase.id}: worktree commit mismatch`);
  return {
    root: checkout,
    cleanup: () => {
      const statePath = path.join(checkout, ".kairn");
      if (fs.existsSync(statePath)) fs.rmSync(statePath, { recursive: true, force: true });
      if (fs.existsSync(checkout)) git(["worktree", "remove", checkout], repositoryCache);
    }
  };
}

function buildLabels(intakeCase: IntakeCase): Map<string, { label: 0 | 1; weight: number; provenance: string }> {
  const labels = new Map<string, { label: 0 | 1; weight: number; provenance: string }>();
  const assign = (filePath: string, label: 0 | 1, weight: number, provenance: string): void => {
    const normalized = normalizePath(filePath);
    const current = labels.get(normalized);
    if (current && current.label !== label) throw new Error(`${intakeCase.id}: conflicting labels for ${normalized}`);
    if (!current || weight > current.weight) labels.set(normalized, { label, weight, provenance });
  };
  intakeCase.verifiedObservedReadTouchFiles.forEach((filePath) => assign(filePath, 1, 0.25, "quality_passing_observed_read_touch"));
  intakeCase.officialPatchSourceFiles.forEach((filePath) => assign(filePath, 1, 0.75, "verified_official_patch_source"));
  intakeCase.requiredSourceFiles.forEach((filePath) => assign(filePath, 1, 1, "required_source_oracle"));
  intakeCase.explicitNoiseFiles.forEach((filePath) => assign(filePath, 0, 1, "explicit_noise_or_excluded"));
  return labels;
}

function labeledCandidate(
  candidate: EvidenceCandidate,
  labels: Map<string, { label: 0 | 1; weight: number; provenance: string }>
): Record<string, unknown> {
  const curated = labels.get(normalizePath(candidate.path));
  return {
    path: normalizePath(candidate.path),
    features: candidate.features,
    ...(curated ? {
      label: curated.label,
      labelWeight: curated.weight,
      labelProvenance: curated.provenance
    } : { label: null })
  };
}

function validateLineageAssignments(registryPath: string, cases: IntakeCase[]): void {
  const root = record(JSON.parse(fs.readFileSync(registryPath, "utf8")), "lineage registry");
  if (root.schemaVersion !== "lineage-registry.v1") throw new Error("lineage registry schemaVersion must be lineage-registry.v1");
  const roles = new Map(array(root.lineages, "lineages").map((value, index) => {
    const row = record(value, `lineages[${index}]`);
    return [publicHttps(row.id, `lineages[${index}].id`).replace(/\/$/, ""), string(row.role, `lineages[${index}].role`)] as const;
  }));
  for (const item of cases) {
    if (roles.get(item.repositoryLineageId) !== item.split) {
      throw new Error(`${item.id}: lineage registry role must match split ${item.split}`);
    }
  }
}

function fractionRecalled(required: string[], candidates: Set<string>): number {
  return required.filter((filePath) => candidates.has(normalizePath(filePath))).length / required.length;
}

function partitionRepositoryPaths(rootPath: string, filePaths: string[]): {
  existing: string[];
  creation: string[];
} {
  const existing: string[] = [];
  const creation: string[] = [];
  for (const filePath of [...filePaths].map(normalizePath).sort()) {
    const resolved = path.resolve(rootPath, filePath);
    assertWithin(rootPath, resolved, "source oracle path");
    let isFile = false;
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    (isFile ? existing : creation).push(filePath);
  }
  return { existing, creation };
}

function fullRecallRate(rows: Array<Record<string, unknown>>, field: string): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.filter((value) => value === 1).length / values.length : null;
}

function meanNullable(rows: Array<Record<string, unknown>>, field: string): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function booleanRate(rows: Array<Record<string, unknown>>, field: string): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is boolean => typeof value === "boolean");
  return values.length > 0 ? values.filter(Boolean).length / values.length : null;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

function publicHttps(value: unknown, label: string, options?: { allowQuery?: boolean }): string {
  const result = string(value, label);
  const parsed = new URL(result);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    (!options?.allowQuery && parsed.search) || parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free public HTTPS URL`);
  }
  return result;
}

function pathArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => normalizePath(string(item, `${label}[${index}]`)));
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid repository-relative path '${value}'`);
  }
  return normalized;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay beside the intake manifest`);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  const result = string(value, label);
  if (!values.includes(result)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return result as T[number];
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): MaterializeOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const args = argv.filter((token) => token !== "--");
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (
      token === "--allow-sample" || token === "--allow-local-fixture" || token === "--draft" ||
      token === "--in-process" || token === "--isolated-worker" ||
      token === "--migrate-feature-schema"
    ) {
      flags.add(token);
      continue;
    }
    const next = args[index + 1];
    if (!token.startsWith("--") || !next || next.startsWith("--")) throw new Error(`invalid argument '${token}'`);
    values.set(token, next);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    intakePath: required("--intake"),
    outPath: required("--out"),
    reportPath: required("--report-out"),
    ...(values.get("--cache") ? { cacheDir: values.get("--cache")! } : {}),
    allowSample: flags.has("--allow-sample"),
    allowLocalFixture: flags.has("--allow-local-fixture"),
    draft: flags.has("--draft"),
    processIsolation: !flags.has("--in-process"),
    isolatedWorker: flags.has("--isolated-worker"),
    migrateFeatureSchema: flags.has("--migrate-feature-schema"),
    ...(values.get("--limit") ? { limit: positiveInteger(values.get("--limit")!, "--limit") } : {}),
    ...(values.get("--case-id") ? { caseIds: commaSeparated(values.get("--case-id")!, "--case-id") } : {})
  };
}

function commaSeparated(value: string, label: string): string[] {
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error(`${label} must contain at least one case id`);
  return values;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  materializeEvidenceCorpus(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
