// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureKairnDir } from "../src/config/paths.js";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { EVIDENCE_FEATURE_SCHEMA_VERSION } from "../src/retrieval/evidenceModel.js";
import { SEMANTIC_DOCUMENT_SCHEMA_VERSION } from "../src/semantic/documents.js";
import {
  semanticDocumentEmbeddingManifestSha256
} from "../src/semantic/modelManager.js";
import {
  DEFAULT_SEMANTIC_MODEL_ID,
  getSemanticModelManifest
} from "../src/semantic/modelRegistry.js";
import { preferredSemanticRuntimeIdentity } from "../src/semantic/modelRuntime.js";
import { SqliteStore } from "../src/store/sqliteStore.js";
import { resolveRoot } from "../src/utils/paths.js";
import {
  benchmarkCachePolicy,
  benchmarkCachePreflight,
  benchmarkCacheRootForPath,
  enforceBenchmarkCacheRetention,
  formatBenchmarkCacheBytes,
  leaseBenchmarkCacheEntry,
  registerBenchmarkCacheEntry,
  type BenchmarkCachePolicy
} from "../src/bench/cacheRetention.js";
import type {
  EvidenceCandidate,
  SemanticEmbeddingRecord,
  SemanticRetrieverStatus
} from "../src/types.js";

const require = createRequire(import.meta.url);

export type Split = "train" | "calibration" | "holdout";
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
  migratedFeatureSchemaFrom?:
    | "evidence-features-v1"
    | "evidence-features-v2"
    | "evidence-features-v3";
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
  cacheMaxBytes?: number;
  allowSample?: boolean;
  allowLocalFixture?: boolean;
  draft?: boolean;
  limit?: number;
  caseIds?: string[];
  splits?: Split[];
  processIsolation?: boolean;
  isolatedWorker?: boolean;
  snapshotEmbeddingCachePath?: string;
  lineageEmbeddingCachePath?: string;
  repositoryIndexSnapshotPath?: string;
  migrateFeatureSchema?: boolean;
  resume?: boolean;
  requireSemantic?: boolean;
  /** Draft-only diagnostic probe export. Public corpus bounds remain 64/128. */
  probeLimit?: number;
};

export type IsolatedMaterializationProgress = {
  schemaVersion: "ranker-corpus-materialization-progress.v1";
  kairnCommit: string;
  intakeSha256: string;
  selectedCaseIds: string[];
  /** Present for draft diagnostic campaigns and bound into resume identity. */
  probeLimit?: number;
  complete: boolean;
  materializedCases: Array<Record<string, unknown>>;
  reportCases: Array<Record<string, unknown>>;
};

const MATERIALIZATION_PROGRESS_DISK_SCHEMA =
  "ranker-corpus-materialization-progress.v2" as const;
const MATERIALIZATION_PROGRESS_RECEIPT_SCHEMA =
  "ranker-corpus-materialization-receipt.v1" as const;
const MATERIALIZATION_PROGRESS_CASE_SCHEMA =
  "ranker-corpus-materialization-progress-case.v1" as const;

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
  if (options.probeLimit && !options.draft) {
    throw new Error("--probe-limit requires --draft and is never promotion evidence");
  }
  if (options.processIsolation) return materializeEvidenceCorpusIsolated(options);
  if (options.resume) {
    throw new Error("--resume requires the default isolated materialization mode");
  }
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
  const cachePolicy = materializationCachePolicy(options);
  reportCachePreflight(cacheDir, cachePolicy, options.isolatedWorker === true);

  const materializedCases: Array<Record<string, unknown>> = [];
  const reportCases: Array<Record<string, unknown>> = [];
  const selectedCases = selectIntakeCases(intake.cases, options);
  for (const intakeCase of selectedCases) {
    const caseStarted = performance.now();
    const caseTiming = {
      checkout: 0,
      indexSnapshotRestore: 0,
      embeddingCacheRestore: 0,
      candidateInspection: 0,
      reportAssembly: 0,
      embeddingCachePersist: 0,
      indexSnapshotPersist: 0,
      cleanup: 0,
      totalWorker: 0
    };
    const checkoutStarted = performance.now();
    const checkout = resolveCheckout(intakeCase, cacheDir, {
      allowLocalFixture: options.allowLocalFixture === true,
      sampleOnly: intake.sampleOnly
    });
    caseTiming.checkout = roundMilliseconds(performance.now() - checkoutStarted);
    const indexSnapshotStarted = performance.now();
    const indexSnapshotRestored = options.repositoryIndexSnapshotPath
      ? restoreRepositoryIndexSnapshot(checkout.root, options.repositoryIndexSnapshotPath)
      : false;
    caseTiming.indexSnapshotRestore = roundMilliseconds(performance.now() - indexSnapshotStarted);
    const snapshotPath = options.snapshotEmbeddingCachePath;
    const lineagePath = options.lineageEmbeddingCachePath;
    // Rolling lineage state is only a content-addressed warm start. An exact
    // immutable snapshot is restored second so it wins when both contain the
    // same document id. The indexer still requires an exact document hash.
    const cacheRestoreStarted = performance.now();
    const lineageCacheEntries = lineagePath ? restoreSnapshotEmbeddingCache(checkout.root, lineagePath) : 0;
    const snapshotCacheEntries = snapshotPath ? restoreSnapshotEmbeddingCache(checkout.root, snapshotPath) : 0;
    const warmEmbeddingIdentities = listEmbeddingIdentities(checkout.root);
    caseTiming.embeddingCacheRestore = roundMilliseconds(performance.now() - cacheRestoreStarted);
    const embeddingCachePaths = [snapshotPath, lineagePath].filter(
      (value): value is string => Boolean(value)
    );
    const snapshotTimer = embeddingCachePaths.length > 0
      ? setInterval(() => {
          for (const cachePath of embeddingCachePaths) {
            try {
              persistSnapshotEmbeddingCache(checkout.root, cachePath);
            } catch (error) {
              process.stderr.write(
                `Semantic embedding checkpoint failed: ${error instanceof Error ? error.message : String(error)}\n`
              );
            }
          }
        }, 60_000)
      : undefined;
    snapshotTimer?.unref();
    const runtime = new KairnRuntime(checkout.root);
    let repositoryIndexSnapshotEligible = false;
    try {
      const requiredSourcePartition = partitionRepositoryPaths(checkout.root, intakeCase.requiredSourceFiles);
      const officialPatchSourcePartition = partitionRepositoryPaths(checkout.root, intakeCase.officialPatchSourceFiles);
      const inspectionStarted = performance.now();
      const inspection = await runtime.inspectEvidenceCandidates({
        query: intakeCase.prompt,
        limit: 64,
        ...(indexSnapshotRestored ? { reuseIndex: true } : {}),
        ...(options.probeLimit ? { probeLimit: options.probeLimit } : {})
      });
      caseTiming.candidateInspection = roundMilliseconds(performance.now() - inspectionStarted);
      const embeddingReuse = inspectEmbeddingReuse(checkout.root, warmEmbeddingIdentities);
      repositoryIndexSnapshotEligible = isSemanticMaterializationReady(inspection.semanticStatus);
      if (options.requireSemantic) {
        assertSemanticMaterializationReady(inspection.semanticStatus, intakeCase.id);
      }
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
      const missingRequiredSourceFilesAt128 = [...requiredSourcePaths].filter(
        (candidatePath) => !trainingCandidatePaths.has(candidatePath)
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
      const requiredRecallAt128 = requiredSourcePartition.existing.length > 0
        ? fractionRecalled(requiredSourcePartition.existing, trainingCandidatePaths)
        : null;
      const patchRecall = officialPatchSourcePartition.existing.length > 0
        ? fractionRecalled(officialPatchSourcePartition.existing, candidatePathsAt64)
        : null;
      const patchRecallAt128 = officialPatchSourcePartition.existing.length > 0
        ? fractionRecalled(officialPatchSourcePartition.existing, trainingCandidatePaths)
        : null;
      const candidates = inspection.candidates.map((candidate) => labeledCandidate(candidate, labels));
      const trainingCandidates = inspection.enrichedCandidates.map((candidate) => labeledCandidate(candidate, labels));
      const probeCandidates = inspection.probeCandidates?.map((candidate) =>
        labeledCandidate(candidate, labels)
      );
      const explicitNegativesAt64 = candidates.filter(
        (candidate) => candidate.labelProvenance === "explicit_noise_or_excluded"
      ).length;
      const explicitNegatives = trainingCandidates.filter(
        (candidate) => candidate.labelProvenance === "explicit_noise_or_excluded"
      ).length;
      const positiveCandidates = candidates.filter((candidate) => candidate.label === 1).length;
      const positiveTrainingCandidates = trainingCandidates.filter((candidate) => candidate.label === 1).length;
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
      const reportAssemblyStarted = performance.now();
      reportCases.push({
        id: intakeCase.id,
        repositoryRef: resolvedRef,
        initialCandidateCount: inspection.initialCandidateCount,
        enrichedCandidateCount: inspection.enrichedCandidateCount,
        exportedCandidateCount: candidates.length,
        trainingCandidateCount: trainingCandidates.length,
        requiredSourceRecallAt64: requiredRecall,
        requiredSourceRecallAt128: requiredRecallAt128,
        requiredSourceExistingFiles: requiredSourcePartition.existing,
        requiredSourceCreationFiles: requiredSourcePartition.creation,
        officialPatchSourceRecallAt64: patchRecall,
        officialPatchSourceRecallAt128: patchRecallAt128,
        officialPatchSourceExistingFiles: officialPatchSourcePartition.existing,
        officialPatchSourceCreationFiles: officialPatchSourcePartition.creation,
        positiveSourceHitAt64: positiveCandidates > 0,
        positiveSourceHitAt128: positiveTrainingCandidates > 0,
        explicitNegativeCount: explicitNegatives,
        explicitNegativeCountAt64: explicitNegativesAt64,
        missingLabeledFiles: missingLabels,
        missingRequiredSourceFiles,
        missingRequiredSourceFilesAt128,
        missingExplicitNoiseFiles,
        missingExplicitNoiseFilesAt64,
        missingRequiredOrNoiseFiles: [...missingRequiredSourceFiles, ...missingExplicitNoiseFiles],
        candidatePathsSha256: sha256(trainingCandidates.map((candidate) => candidate.path).join("\n")),
        candidatePathsAt64Sha256: sha256(candidates.map((candidate) => candidate.path).join("\n")),
        timingMs: caseTiming,
        inspectionTimingMs: inspection.timingMs,
        embeddingReuse: {
          indexSnapshotRestored,
          lineageCacheEntries,
          snapshotCacheEntries,
          warmEntriesAvailable: warmEmbeddingIdentities.size,
          ...embeddingReuse
        },
        ...(inspection.semanticStatus ? { semanticStatus: inspection.semanticStatus } : {}),
        ...(options.draft ? {
          signals: inspection.signals,
          index: indexCoverage(runtime.getIndexStatus()),
          initialCandidatePaths: inspection.initialCandidatePaths,
          enrichedCandidatePaths: inspection.enrichedCandidatePaths,
          ...(inspection.candidateDiagnostics
            ? { candidateDiagnostics: inspection.candidateDiagnostics }
            : {}),
          enrichedCandidates: inspection.enrichedCandidates,
          ...(probeCandidates
            ? { probeCandidates }
            : {}),
          ...(inspection.probeCandidatePaths
            ? { probeCandidatePaths: inspection.probeCandidatePaths }
            : {}),
          ...(inspection.probeCandidateCount !== undefined
            ? { probeCandidateCount: inspection.probeCandidateCount }
            : {}),
          ...(inspection.probeLimit !== undefined
            ? { probeLimit: inspection.probeLimit }
            : {}),
          candidates: inspection.enrichedCandidates.map((candidate) => ({
            path: candidate.path,
            reasons: candidate.reasons
          }))
        } : {})
      });
      caseTiming.reportAssembly = roundMilliseconds(performance.now() - reportAssemblyStarted);
    } finally {
      if (snapshotTimer) clearInterval(snapshotTimer);
      runtime.close();
      const persistStarted = performance.now();
      for (const cachePath of embeddingCachePaths) {
        try {
          persistSnapshotEmbeddingCache(checkout.root, cachePath, {
            mergeExisting: cachePath === lineagePath
          });
        } catch (error) {
          process.stderr.write(
            `Final semantic embedding checkpoint failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      }
      caseTiming.embeddingCachePersist = roundMilliseconds(performance.now() - persistStarted);
      const indexPersistStarted = performance.now();
      if (
        options.repositoryIndexSnapshotPath &&
        !indexSnapshotRestored &&
        repositoryIndexSnapshotEligible
      ) {
        persistRepositoryIndexSnapshot(checkout.root, options.repositoryIndexSnapshotPath);
      }
      caseTiming.indexSnapshotPersist = roundMilliseconds(performance.now() - indexPersistStarted);
      const cleanupStarted = performance.now();
      checkout.cleanup();
      caseTiming.cleanup = roundMilliseconds(performance.now() - cleanupStarted);
      caseTiming.totalWorker = roundMilliseconds(performance.now() - caseStarted);
      enforceBenchmarkCacheRetention(cacheDir, { policy: cachePolicy });
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
      requireSemantic: options.requireSemantic === true,
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
    candidateRecallAt128: fullRecallRate(reportCases, "requiredSourceRecallAt128"),
    positiveSourceAnyHitRateAt64: booleanRate(reportCases, "positiveSourceHitAt64"),
    positiveSourceAnyHitRateAt128: booleanRate(reportCases, "positiveSourceHitAt128"),
    officialPatchMeanRecallAt64: meanNullable(reportCases, "officialPatchSourceRecallAt64"),
    officialPatchMeanRecallAt128: meanNullable(reportCases, "officialPatchSourceRecallAt128"),
    timingSummary: summarizeMaterializationTiming(reportCases),
    ...(options.limit || options.caseIds || options.splits ? {
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
  const cachePolicy = materializationCachePolicy(options);
  reportCachePreflight(cacheDir, cachePolicy, false);
  const intakeHash = sha256(fs.readFileSync(intakePath));
  const selectedCaseIds = selectedCases.map((item) => item.id);
  const progressPath = `${outPath}.progress.json`;
  const restoredProgress = options.resume
    ? readIsolatedMaterializationProgress(progressPath, {
        kairnCommit,
        intakeSha256: intakeHash,
        selectedCaseIds,
        ...(options.probeLimit ? { probeLimit: options.probeLimit } : {})
      })
    : undefined;
  const materializedCases: Array<Record<string, unknown>> = [
    ...(restoredProgress?.materializedCases ?? [])
  ];
  const reportCases: Array<Record<string, unknown>> = [
    ...(restoredProgress?.reportCases ?? [])
  ];
  const completedCaseIds = new Set(
    materializedCases.map((item) => string(item.id, "progress materialized case id"))
  );
  const scriptPath = fileURLToPath(import.meta.url);

  for (const intakeCase of selectedCases) {
    if (completedCaseIds.has(intakeCase.id)) continue;
    const snapshotEmbeddingCachePath = path.join(
      cacheDir,
      "semantic-embedding-cache",
      `${semanticSnapshotCacheKey(intakeCase)}.json`
    );
    const lineageEmbeddingCachePath = path.join(
      cacheDir,
      "semantic-embedding-lineage-cache",
      `${semanticLineageCacheKey(intakeCase)}.json`
    );
    const repositoryIndexSnapshotPath = path.join(
      cacheDir,
      "repository-index-snapshots",
      `${repositoryIndexSnapshotCacheKey(intakeCase, kairnRoot)}.sqlite`
    );
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
      "--cache-max-bytes", String(cachePolicy.maxBytes),
      "--case-id", intakeCase.id,
      "--in-process",
      "--isolated-worker",
      "--snapshot-embedding-cache", snapshotEmbeddingCachePath,
      "--lineage-embedding-cache", lineageEmbeddingCachePath,
      "--repository-index-snapshot", repositoryIndexSnapshotPath,
      ...(options.draft ? ["--draft"] : []),
      ...(options.allowSample ? ["--allow-sample"] : []),
      ...(options.allowLocalFixture ? ["--allow-local-fixture"] : []),
      ...(options.migrateFeatureSchema ? ["--migrate-feature-schema"] : []),
      ...(options.requireSemantic ? ["--require-semantic"] : []),
      ...(options.probeLimit ? ["--probe-limit", String(options.probeLimit)] : [])
    ];
    const isolatedStartedAt = new Date().toISOString();
    const isolatedStarted = performance.now();
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
      const reportRow = record(reportRows[0], `${intakeCase.id} report case`);
      reportRow.isolatedProcess = {
        startedAt: isolatedStartedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: roundMilliseconds(performance.now() - isolatedStarted)
      };
      reportCases.push(reportRow);
      completedCaseIds.add(intakeCase.id);
      if (options.resume) {
        writeIsolatedMaterializationProgress(progressPath, {
          schemaVersion: "ranker-corpus-materialization-progress.v1",
          kairnCommit,
          intakeSha256: intakeHash,
          selectedCaseIds,
          ...(options.probeLimit ? { probeLimit: options.probeLimit } : {}),
          complete: false,
          materializedCases,
          reportCases
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${intakeCase.id}: isolated materialization failed: ${detail}`);
    } finally {
      fs.rmSync(childManifestPath, { force: true });
      fs.rmSync(childReportPath, { force: true });
      enforceBenchmarkCacheRetention(cacheDir, { policy: cachePolicy });
    }
  }

  const relativeRegistry = normalizePath(path.relative(path.dirname(outPath), registryPath));
  const partial = Boolean(options.limit || options.caseIds || options.splits);
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
      requireSemantic: options.requireSemantic === true,
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
    candidateRecallAt128: fullRecallRate(reportCases, "requiredSourceRecallAt128"),
    positiveSourceAnyHitRateAt64: booleanRate(reportCases, "positiveSourceHitAt64"),
    positiveSourceAnyHitRateAt128: booleanRate(reportCases, "positiveSourceHitAt128"),
    officialPatchMeanRecallAt64: meanNullable(reportCases, "officialPatchSourceRecallAt64"),
    officialPatchMeanRecallAt128: meanNullable(reportCases, "officialPatchSourceRecallAt128"),
    timingSummary: summarizeMaterializationTiming(reportCases),
    ...(partial ? { partial: true, selectedCaseIds: selectedCases.map((item) => item.id) } : {}),
    cases: reportCases
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (options.resume) {
    if (!restoredProgress?.complete) {
      writeIsolatedMaterializationProgress(progressPath, {
        schemaVersion: "ranker-corpus-materialization-progress.v1",
        kairnCommit,
        intakeSha256: intakeHash,
        selectedCaseIds,
        ...(options.probeLimit ? { probeLimit: options.probeLimit } : {}),
        complete: true,
        materializedCases,
        reportCases
      });
    }
    finalizeIsolatedMaterializationProgress(progressPath, outPath, reportPath);
  }
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

function listEmbeddingIdentities(rootPath: string): Set<string> {
  const store = new SqliteStore(ensureKairnDir(rootPath).databasePath);
  try {
    return new Set(store.listSemanticEmbeddings(rootPath).map(semanticEmbeddingContentIdentity));
  } finally {
    store.close();
  }
}

function inspectEmbeddingReuse(
  rootPath: string,
  warmEmbeddingIdentities: Set<string>
): {
  currentDocuments: number;
  validCurrentEmbeddings: number;
  reusedEmbeddings: number;
  generatedEmbeddings: number;
  reuseRate: number;
} {
  const store = new SqliteStore(ensureKairnDir(rootPath).databasePath);
  try {
    const documents = store.listSemanticDocuments(rootPath);
    const currentHashes = new Map(documents.map((document) => [document.id, document.hash]));
    const validIdentities = new Set(
      store.listSemanticEmbeddings(rootPath)
        .filter((embedding) => currentHashes.get(embedding.documentId) === embedding.documentHash)
        .map(semanticEmbeddingContentIdentity)
    );
    const reusedEmbeddings = [...validIdentities].filter((identity) => warmEmbeddingIdentities.has(identity)).length;
    const generatedEmbeddings = Math.max(0, validIdentities.size - reusedEmbeddings);
    return {
      currentDocuments: documents.length,
      validCurrentEmbeddings: validIdentities.size,
      reusedEmbeddings,
      generatedEmbeddings,
      reuseRate: validIdentities.size > 0 ? roundRatio(reusedEmbeddings / validIdentities.size) : 0
    };
  } finally {
    store.close();
  }
}

function semanticEmbeddingContentIdentity(
  embedding: Pick<SemanticEmbeddingRecord, "documentId" | "documentHash" | "modelId" | "runtimeId" | "schemaVersion">
): string {
  return [
    embedding.documentId,
    embedding.documentHash,
    embedding.modelId,
    embedding.runtimeId,
    embedding.schemaVersion
  ].join("\0");
}

function summarizeMaterializationTiming(reportCases: Array<Record<string, unknown>>): Record<string, unknown> {
  const caseTimes = reportCases.map((row) => nestedNumber(row, "timingMs", "totalWorker")).filter(isFiniteNumber);
  const isolatedTimes = reportCases.map((row) => nestedNumber(row, "isolatedProcess", "elapsedMs")).filter(isFiniteNumber);
  const phaseNames = [
    "checkout",
    "indexSnapshotRestore",
    "embeddingCacheRestore",
    "candidateInspection",
    "reportAssembly",
    "embeddingCachePersist",
    "indexSnapshotPersist",
    "cleanup"
  ];
  const phaseTotalsMs = Object.fromEntries(phaseNames.map((phase) => [
    phase,
    roundMilliseconds(reportCases.reduce((total, row) => total + (nestedNumber(row, "timingMs", phase) ?? 0), 0))
  ]));
  const reusedEmbeddings = reportCases.reduce(
    (total, row) => total + (nestedNumber(row, "embeddingReuse", "reusedEmbeddings") ?? 0),
    0
  );
  const generatedEmbeddings = reportCases.reduce(
    (total, row) => total + (nestedNumber(row, "embeddingReuse", "generatedEmbeddings") ?? 0),
    0
  );
  const restoredIndexSnapshots = reportCases.filter(
    (row) => record(row.embeddingReuse ?? {}, "embeddingReuse").indexSnapshotRestored === true
  ).length;
  return {
    measuredCases: caseTimes.length,
    totalCaseWorkerMs: roundMilliseconds(sumNumbers(caseTimes)),
    medianCaseWorkerMs: percentile(caseTimes, 0.5),
    p95CaseWorkerMs: percentile(caseTimes, 0.95),
    maxCaseWorkerMs: caseTimes.length > 0 ? roundMilliseconds(Math.max(...caseTimes)) : null,
    ...(isolatedTimes.length > 0 ? {
      totalIsolatedProcessMs: roundMilliseconds(sumNumbers(isolatedTimes)),
      medianIsolatedProcessMs: percentile(isolatedTimes, 0.5),
      p95IsolatedProcessMs: percentile(isolatedTimes, 0.95)
    } : {}),
    phaseTotalsMs,
    indexSnapshotReuse: {
      restoredCases: restoredIndexSnapshots,
      coldCases: reportCases.length - restoredIndexSnapshots
    },
    embeddingReuse: {
      reusedEmbeddings,
      generatedEmbeddings,
      reuseRate: reusedEmbeddings + generatedEmbeddings > 0
        ? roundRatio(reusedEmbeddings / (reusedEmbeddings + generatedEmbeddings))
        : 0
    }
  };
}

function nestedNumber(row: Record<string, unknown>, parent: string, child: string): number | undefined {
  const nested = row[parent];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  const value = (nested as Record<string, unknown>)[child];
  return isFiniteNumber(value) ? value : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sumNumbers(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return roundMilliseconds(sorted[index]!);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function selectIntakeCases<T extends { id: string; split: Split }>(
  cases: T[],
  options: Pick<MaterializeOptions, "draft" | "limit" | "caseIds" | "splits" | "isolatedWorker">
): T[] {
  const orderedCases = [...cases].sort((left, right) => left.id.localeCompare(right.id));
  const selectors = [options.limit, options.caseIds, options.splits].filter(Boolean).length;
  if (selectors > 1) {
    throw new Error("--limit, --case-id, and --split are mutually exclusive");
  }
  if ((options.limit || options.caseIds || options.splits) && !options.draft && !options.isolatedWorker) {
    throw new Error("partial materialization is allowed only with --draft");
  }
  const requestedCaseIds = options.caseIds ? new Set(options.caseIds) : undefined;
  const requestedSplits = options.splits ? new Set(options.splits) : undefined;
  if (
    options.draft &&
    !options.limit &&
    !requestedCaseIds &&
    !requestedSplits &&
    cases.some((item) => item.split === "holdout")
  ) {
    throw new Error(
      "draft materialization containing holdout cases requires an explicit --split, --case-id, or --limit"
    );
  }
  const selectedCases = requestedCaseIds
    ? orderedCases.filter((item) => requestedCaseIds.has(item.id))
    : requestedSplits
      ? orderedCases.filter((item) => requestedSplits.has(item.split))
      : options.limit
        ? orderedCases.slice(0, options.limit)
        : orderedCases;
  if (requestedCaseIds) {
    const selectedIds = new Set(selectedCases.map((item) => item.id));
    const missing = [...requestedCaseIds].filter((id) => !selectedIds.has(id));
    if (missing.length > 0) throw new Error(`unknown --case-id value(s): ${missing.join(", ")}`);
  }
  if (requestedSplits && selectedCases.length === 0) {
    throw new Error("--split did not select any intake cases");
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
  const migratedFeatureSchemaFrom = (
    root.featureSchemaVersion === "evidence-features-v1" ||
    root.featureSchemaVersion === "evidence-features-v2" ||
    root.featureSchemaVersion === "evidence-features-v3"
  ) && options.migrateFeatureSchema
    ? root.featureSchemaVersion
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
    const fixtureRoot = path.resolve(intakeCase.localFixtureRoot);
    if (git(["rev-parse", "HEAD"], fixtureRoot) !== intakeCase.repositoryRef) {
      throw new Error(`${intakeCase.id}: local fixture HEAD does not match repositoryRef`);
    }
    const worktreesDir = path.join(cacheDir, "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
    const checkout = path.join(
      worktreesDir,
      `local-${intakeCase.repositoryRef.slice(0, 12)}-${crypto.randomUUID()}`
    );
    git(["worktree", "add", "--quiet", "--detach", checkout, intakeCase.repositoryRef], fixtureRoot);
    return {
      root: checkout,
      cleanup: () => {
        const statePath = path.join(checkout, ".kairn");
        if (fs.existsSync(statePath)) fs.rmSync(statePath, { recursive: true, force: true });
        if (fs.existsSync(checkout)) git(["worktree", "remove", checkout], fixtureRoot);
      }
    };
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
  const repositoryEntryId = `repository:${repositoryKey}`;
  registerBenchmarkCacheEntry(cacheDir, {
    id: repositoryEntryId,
    kind: "repository",
    paths: [repositoryCache]
  });
  const repositoryLease = leaseBenchmarkCacheEntry(cacheDir, repositoryEntryId);
  try {
    const remote = git(["remote", "get-url", "origin"], repositoryCache).replace(/\.git$/i, "").replace(/\/$/, "");
    const expected = intakeCase.repositoryUrl.replace(/\.git$/i, "").replace(/\/$/, "");
    if (remote !== expected) throw new Error(`${intakeCase.id}: cached checkout remote mismatch`);
    git(["fetch", "--quiet", "--depth=1", "origin", intakeCase.repositoryRef], repositoryCache);
    registerBenchmarkCacheEntry(cacheDir, {
      id: repositoryEntryId,
      kind: "repository",
      paths: [repositoryCache]
    });
    const checkout = path.join(worktreesDir, `${repositoryKey}-${intakeCase.repositoryRef.slice(0, 12)}-${crypto.randomUUID()}`);
    git(["worktree", "add", "--quiet", "--detach", checkout, intakeCase.repositoryRef], repositoryCache);
    if (git(["rev-parse", "HEAD"], checkout) !== intakeCase.repositoryRef) throw new Error(`${intakeCase.id}: worktree commit mismatch`);
    return {
      root: checkout,
      cleanup: () => {
        try {
          const statePath = path.join(checkout, ".kairn");
          if (fs.existsSync(statePath)) fs.rmSync(statePath, { recursive: true, force: true });
          if (fs.existsSync(checkout)) git(["worktree", "remove", checkout], repositoryCache);
        } finally {
          repositoryLease.release();
        }
      }
    };
  } catch (error) {
    repositoryLease.release();
    throw error;
  }
}

type SnapshotEmbeddingCache = {
  formatVersion: 1 | 2 | 3;
  cacheKey: string;
  embeddings: Array<{
    documentId: string;
    documentHash: string;
    modelId: string;
    runtimeBackend: SemanticEmbeddingRecord["runtimeBackend"];
    runtimeId: string;
    schemaVersion: SemanticEmbeddingRecord["schemaVersion"];
    dimensions: number;
    scale: number;
    vectorBase64: string;
  }>;
};

type RepositoryIndexSnapshotManifest = {
  formatVersion: 2;
  cacheKey: string;
  sourceRootPath: string;
  databaseSha256: string;
  databaseBytes: number;
  databaseBlobPath: string;
};

const CANONICAL_REPOSITORY_SNAPSHOT_ROOT = "/__kairn_benchmark_snapshot_root__";

function semanticSnapshotCacheKey(intakeCase: IntakeCase): string {
  const modelId = process.env.KAIRN_SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL_ID;
  const documentEmbeddingManifestSha256 = semanticDocumentEmbeddingManifestSha256(
    getSemanticModelManifest(modelId)
  );
  const runtime = preferredSemanticRuntimeIdentity();
  return buildSemanticSnapshotCacheKey({
    repositoryLineageId: intakeCase.repositoryLineageId,
    repositoryRef: intakeCase.repositoryRef,
    modelId,
    runtimeId: runtime.runtimeId,
    documentEmbeddingManifestSha256,
    documentSchemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION
  });
}

function semanticLineageCacheKey(intakeCase: IntakeCase): string {
  const modelId = process.env.KAIRN_SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL_ID;
  const documentEmbeddingManifestSha256 = semanticDocumentEmbeddingManifestSha256(
    getSemanticModelManifest(modelId)
  );
  const runtime = preferredSemanticRuntimeIdentity();
  return buildSemanticLineageCacheKey({
    repositoryLineageId: intakeCase.repositoryLineageId,
    modelId,
    runtimeId: runtime.runtimeId,
    documentEmbeddingManifestSha256,
    documentSchemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION
  });
}

function repositoryIndexSnapshotCacheKey(intakeCase: IntakeCase, kairnRoot: string): string {
  const modelId = process.env.KAIRN_SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL_ID;
  const runtime = preferredSemanticRuntimeIdentity();
  return buildRepositoryIndexSnapshotCacheKey({
    repositoryLineageId: intakeCase.repositoryLineageId,
    repositoryRef: intakeCase.repositoryRef,
    modelManifestSha256: semanticDocumentEmbeddingManifestSha256(getSemanticModelManifest(modelId)),
    runtimeId: runtime.runtimeId,
    documentSchemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION,
    implementationSha256: repositoryIndexImplementationSha256(kairnRoot)
  });
}

export function readIsolatedMaterializationProgress(
  progressPath: string,
  expected: {
    kairnCommit: string;
    intakeSha256: string;
    selectedCaseIds: string[];
    probeLimit?: number;
  }
): IsolatedMaterializationProgress | undefined {
  if (!fs.existsSync(progressPath)) return undefined;
  const parsed = record(
    JSON.parse(fs.readFileSync(progressPath, "utf8")),
    "isolated materialization progress"
  );
  if (parsed.schemaVersion === MATERIALIZATION_PROGRESS_RECEIPT_SCHEMA) {
    const receiptDirectory = path.dirname(path.resolve(progressPath));
    const manifestPath = path.resolve(
      receiptDirectory,
      string(parsed.manifestPath, "materialization receipt manifestPath")
    );
    const reportPath = path.resolve(
      receiptDirectory,
      string(parsed.reportPath, "materialization receipt reportPath")
    );
    const expectedManifestPath = path.resolve(progressPath.slice(0, -".progress.json".length));
    if (manifestPath !== expectedManifestPath) {
      throw new Error("materialization receipt does not match its manifest path");
    }
    for (const [target, hashField] of [
      [manifestPath, "manifestSha256"],
      [reportPath, "reportSha256"]
    ] as const) {
      if (!fs.existsSync(target)) throw new Error(`materialization receipt artifact is missing: ${target}`);
      if (sha256(fs.readFileSync(target)) !== string(parsed[hashField], `materialization receipt ${hashField}`)) {
        throw new Error(`materialization receipt artifact checksum mismatch: ${target}`);
      }
    }
    const manifest = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")), "materialization receipt manifest");
    const report = record(JSON.parse(fs.readFileSync(reportPath, "utf8")), "materialization receipt report");
    return parseIsolatedMaterializationProgress({
      ...parsed,
      schemaVersion: "ranker-corpus-materialization-progress.v1",
      complete: true,
      materializedCases: array(manifest.cases, "materialization receipt manifest cases"),
      reportCases: array(report.cases, "materialization receipt report cases")
    }, expected);
  }
  if (parsed.schemaVersion === MATERIALIZATION_PROGRESS_DISK_SCHEMA) {
    const completedCaseIds = array(parsed.completedCaseIds, "progress completedCaseIds")
      .map((item, index) => string(item, `progress completedCaseIds[${index}]`));
    const caseDirectory = materializationProgressCaseDirectory(progressPath);
    const materializedCases: Array<Record<string, unknown>> = [];
    const reportCases: Array<Record<string, unknown>> = [];
    for (let index = 0; index < completedCaseIds.length; index += 1) {
      const casePath = materializationProgressCasePath(caseDirectory, index);
      if (!fs.existsSync(casePath)) {
        throw new Error(`isolated materialization progress is missing case row ${index}`);
      }
      const caseRecord = record(
        JSON.parse(fs.readFileSync(casePath, "utf8")),
        `progress case row ${index}`
      );
      if (caseRecord.schemaVersion !== MATERIALIZATION_PROGRESS_CASE_SCHEMA) {
        throw new Error(`isolated materialization progress case row ${index} has an unsupported schema`);
      }
      const materializedCase = record(
        caseRecord.materializedCase,
        `progress materializedCases[${index}]`
      );
      const reportCase = record(caseRecord.reportCase, `progress reportCases[${index}]`);
      if (
        string(materializedCase.id, `progress materializedCases[${index}].id`) !== completedCaseIds[index] ||
        string(reportCase.id, `progress reportCases[${index}].id`) !== completedCaseIds[index]
      ) {
        throw new Error(`isolated materialization progress case row ${index} does not match its header`);
      }
      materializedCases.push(materializedCase);
      reportCases.push(reportCase);
    }
    return parseIsolatedMaterializationProgress({
      ...parsed,
      schemaVersion: "ranker-corpus-materialization-progress.v1",
      materializedCases,
      reportCases
    }, expected);
  }
  if (parsed.schemaVersion !== "ranker-corpus-materialization-progress.v1") {
    throw new Error("isolated materialization progress has an unsupported schema");
  }
  return parseIsolatedMaterializationProgress(parsed, expected);
}

function parseIsolatedMaterializationProgress(
  parsed: Record<string, unknown>,
  expected: {
    kairnCommit: string;
    intakeSha256: string;
    selectedCaseIds: string[];
    probeLimit?: number;
  }
): IsolatedMaterializationProgress {
  const kairnCommit = string(parsed.kairnCommit, "progress kairnCommit");
  const intakeSha256 = string(parsed.intakeSha256, "progress intakeSha256");
  const selectedCaseIds = array(parsed.selectedCaseIds, "progress selectedCaseIds")
    .map((item, index) => string(item, `progress selectedCaseIds[${index}]`));
  const probeLimit = parsed.probeLimit === undefined
    ? undefined
    : positiveIntegerValue(parsed.probeLimit, "progress probeLimit");
  if (
    kairnCommit !== expected.kairnCommit ||
    intakeSha256 !== expected.intakeSha256 ||
    !sameStrings(selectedCaseIds, expected.selectedCaseIds) ||
    probeLimit !== expected.probeLimit
  ) {
    throw new Error(
      "isolated materialization progress does not match the current commit, intake, selected cases, or probe limit"
    );
  }
  if (typeof parsed.complete !== "boolean") {
    throw new Error("isolated materialization progress complete must be a boolean");
  }
  const materializedCases = array(parsed.materializedCases, "progress materializedCases")
    .map((item, index) => record(item, `progress materializedCases[${index}]`));
  const reportCases = array(parsed.reportCases, "progress reportCases")
    .map((item, index) => record(item, `progress reportCases[${index}]`));
  const materializedIds = materializedCases.map((item) =>
    string(item.id, "progress materialized case id")
  );
  const reportIds = reportCases.map((item) => string(item.id, "progress report case id"));
  if (
    materializedIds.length !== new Set(materializedIds).size ||
    !sameStrings(materializedIds, reportIds) ||
    !sameStrings(materializedIds, selectedCaseIds.slice(0, materializedIds.length))
  ) {
    throw new Error("isolated materialization progress contains inconsistent case rows");
  }
  if (parsed.complete && materializedIds.length !== selectedCaseIds.length) {
    throw new Error("complete isolated materialization progress is missing selected cases");
  }
  return {
    schemaVersion: "ranker-corpus-materialization-progress.v1",
    kairnCommit,
    intakeSha256,
    selectedCaseIds,
    ...(probeLimit ? { probeLimit } : {}),
    complete: parsed.complete,
    materializedCases,
    reportCases
  };
}

export function writeIsolatedMaterializationProgress(
  progressPath: string,
  progress: IsolatedMaterializationProgress
): void {
  const parent = path.dirname(progressPath);
  fs.mkdirSync(parent, { recursive: true });
  const materializedIds = progress.materializedCases.map((item) =>
    string(item.id, "progress materialized case id")
  );
  const reportIds = progress.reportCases.map((item) =>
    string(item.id, "progress report case id")
  );
  if (
    materializedIds.length !== new Set(materializedIds).size ||
    !sameStrings(materializedIds, reportIds) ||
    !sameStrings(materializedIds, progress.selectedCaseIds.slice(0, materializedIds.length))
  ) {
    throw new Error("isolated materialization progress contains inconsistent case rows");
  }
  if (progress.complete && materializedIds.length !== progress.selectedCaseIds.length) {
    throw new Error("complete isolated materialization progress is missing selected cases");
  }

  const caseDirectory = materializationProgressCaseDirectory(progressPath);
  let persistedCaseCount = 0;
  if (fs.existsSync(progressPath)) {
    const existing = record(
      JSON.parse(fs.readFileSync(progressPath, "utf8")),
      "existing isolated materialization progress"
    );
    if (existing.schemaVersion === MATERIALIZATION_PROGRESS_DISK_SCHEMA) {
      const existingIds = array(existing.completedCaseIds, "existing progress completedCaseIds")
        .map((item, index) => string(item, `existing progress completedCaseIds[${index}]`));
      if (!sameStrings(existingIds, materializedIds.slice(0, existingIds.length))) {
        throw new Error("existing isolated materialization progress is not a prefix of the new progress");
      }
      persistedCaseCount = existingIds.length;
    } else if (existing.schemaVersion !== "ranker-corpus-materialization-progress.v1") {
      throw new Error("existing isolated materialization progress has an unsupported schema");
    }
  } else if (fs.existsSync(caseDirectory)) {
    throw new Error("isolated materialization progress case directory exists without a header");
  }
  fs.mkdirSync(caseDirectory, { recursive: true });
  for (let index = persistedCaseCount; index < materializedIds.length; index += 1) {
    writeAtomicJson(materializationProgressCasePath(caseDirectory, index), {
      schemaVersion: MATERIALIZATION_PROGRESS_CASE_SCHEMA,
      materializedCase: progress.materializedCases[index],
      reportCase: progress.reportCases[index]
    });
  }
  writeAtomicJson(progressPath, {
    schemaVersion: MATERIALIZATION_PROGRESS_DISK_SCHEMA,
    kairnCommit: progress.kairnCommit,
    intakeSha256: progress.intakeSha256,
    selectedCaseIds: progress.selectedCaseIds,
    ...(progress.probeLimit ? { probeLimit: progress.probeLimit } : {}),
    complete: progress.complete,
    completedCaseIds: materializedIds
  });
}

export function finalizeIsolatedMaterializationProgress(
  progressPath: string,
  manifestPath: string,
  reportPath: string
): void {
  if (!fs.existsSync(progressPath)) throw new Error("cannot finalize missing materialization progress");
  const current = record(
    JSON.parse(fs.readFileSync(progressPath, "utf8")),
    "isolated materialization progress"
  );
  if (
    current.schemaVersion !== MATERIALIZATION_PROGRESS_DISK_SCHEMA &&
    current.schemaVersion !== MATERIALIZATION_PROGRESS_RECEIPT_SCHEMA
  ) {
    throw new Error("only journaled materialization progress can be finalized");
  }
  if (current.schemaVersion === MATERIALIZATION_PROGRESS_DISK_SCHEMA && current.complete !== true) {
    throw new Error("cannot finalize incomplete materialization progress");
  }
  const resolvedManifest = path.resolve(manifestPath);
  const resolvedReport = path.resolve(reportPath);
  const expectedManifest = path.resolve(progressPath.slice(0, -".progress.json".length));
  if (resolvedManifest !== expectedManifest) throw new Error("materialization progress path does not match manifest path");
  if (!fs.existsSync(resolvedManifest) || !fs.existsSync(resolvedReport)) {
    throw new Error("cannot finalize materialization progress before output artifacts exist");
  }
  const identity = current.schemaVersion === MATERIALIZATION_PROGRESS_RECEIPT_SCHEMA
    ? current
    : {
        kairnCommit: current.kairnCommit,
        intakeSha256: current.intakeSha256,
        selectedCaseIds: current.selectedCaseIds,
        ...(current.probeLimit === undefined ? {} : { probeLimit: current.probeLimit })
      };
  writeAtomicJson(progressPath, {
    schemaVersion: MATERIALIZATION_PROGRESS_RECEIPT_SCHEMA,
    kairnCommit: string(identity.kairnCommit, "progress kairnCommit"),
    intakeSha256: string(identity.intakeSha256, "progress intakeSha256"),
    selectedCaseIds: array(identity.selectedCaseIds, "progress selectedCaseIds"),
    ...(identity.probeLimit === undefined ? {} : { probeLimit: identity.probeLimit }),
    complete: true,
    manifestPath: path.relative(path.dirname(path.resolve(progressPath)), resolvedManifest),
    manifestSha256: sha256(fs.readFileSync(resolvedManifest)),
    reportPath: path.relative(path.dirname(path.resolve(progressPath)), resolvedReport),
    reportSha256: sha256(fs.readFileSync(resolvedReport))
  });
  removeCompletedMaterializationCaseJournal(progressPath);
}

function removeCompletedMaterializationCaseJournal(progressPath: string): void {
  const caseDirectory = materializationProgressCaseDirectory(progressPath);
  if (!fs.existsSync(caseDirectory)) return;
  const parent = path.resolve(path.dirname(progressPath));
  const resolved = path.resolve(caseDirectory);
  if (path.dirname(resolved) !== parent || resolved !== path.resolve(`${progressPath}.cases`)) {
    throw new Error("materialization case journal path is outside its artifact directory");
  }
  const unexpected = fs.readdirSync(resolved).filter((name) => !/^\d{6}\.json$/.test(name));
  if (unexpected.length > 0) {
    throw new Error(`materialization case journal contains unknown files: ${unexpected.join(", ")}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function materializationProgressCaseDirectory(progressPath: string): string {
  return `${progressPath}.cases`;
}

function materializationProgressCasePath(caseDirectory: string, index: number): string {
  return path.join(caseDirectory, `${String(index).padStart(6, "0")}.json`);
}

function writeAtomicJson(targetPath: string, value: unknown): void {
  const staged = `${targetPath}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(staged, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    replaceSnapshotCache(targetPath, staged);
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function materializationCachePolicy(options: Pick<MaterializeOptions, "cacheMaxBytes">): BenchmarkCachePolicy {
  return benchmarkCachePolicy({
    ...process.env,
    ...(options.cacheMaxBytes
      ? { KAIRN_BENCHMARK_CACHE_MAX_BYTES: String(options.cacheMaxBytes) }
      : {})
  });
}

function reportCachePreflight(
  cacheDir: string,
  policy: BenchmarkCachePolicy,
  quiet: boolean
): void {
  const preflight = benchmarkCachePreflight(cacheDir, policy);
  if (!quiet) {
    process.stderr.write(
      `Benchmark cache: ${formatBenchmarkCacheBytes(preflight.status.totalBytes)} / ` +
      `${formatBenchmarkCacheBytes(policy.maxBytes)} retained ` +
      `(${preflight.status.entryCount} managed entries).\n`
    );
    if (preflight.warning) process.stderr.write(`Warning: ${preflight.warning}.\n`);
  }
}

export function buildSemanticSnapshotCacheKey(input: {
  repositoryLineageId: string;
  repositoryRef: string;
  modelId: string;
  runtimeId: string;
  documentEmbeddingManifestSha256: string;
  documentSchemaVersion: SemanticEmbeddingRecord["schemaVersion"];
}): string {
  return sha256([
    "semantic-embedding-cache.v6",
    input.repositoryLineageId,
    input.repositoryRef,
    input.modelId,
    input.runtimeId,
    input.documentEmbeddingManifestSha256,
    input.documentSchemaVersion
  ].join("\0"));
}

export function buildSemanticLineageCacheKey(input: {
  repositoryLineageId: string;
  modelId: string;
  runtimeId: string;
  documentEmbeddingManifestSha256: string;
  documentSchemaVersion: SemanticEmbeddingRecord["schemaVersion"];
}): string {
  return sha256([
    "semantic-embedding-lineage-cache.v3",
    input.repositoryLineageId,
    input.modelId,
    input.runtimeId,
    input.documentEmbeddingManifestSha256,
    input.documentSchemaVersion
  ].join("\0"));
}

export function buildRepositoryIndexSnapshotCacheKey(input: {
  repositoryLineageId: string;
  repositoryRef: string;
  modelManifestSha256: string;
  runtimeId: string;
  documentSchemaVersion: string;
  implementationSha256: string;
}): string {
  return sha256([
    "repository-index-snapshot.v3",
    input.repositoryLineageId,
    input.repositoryRef,
    input.modelManifestSha256,
    input.runtimeId,
    input.documentSchemaVersion,
    input.implementationSha256
  ].join("\0"));
}

export function restoreRepositoryIndexSnapshot(rootPath: string, cachePath: string): boolean {
  const manifestPath = `${cachePath}.manifest.json`;
  if (!fs.existsSync(cachePath) && !fs.existsSync(manifestPath)) return false;
  if (!fs.existsSync(manifestPath)) throw new Error(`repository index snapshot manifest is missing: ${manifestPath}`);
  const manifest = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")), "repository index snapshot manifest");
  const expectedKey = path.basename(cachePath, ".sqlite");
  if ((manifest.formatVersion !== 1 && manifest.formatVersion !== 2) || manifest.cacheKey !== expectedKey) {
    throw new Error(`repository index snapshot identity mismatch: ${cachePath}`);
  }
  const expectedHash = string(manifest.databaseSha256, "repository index snapshot databaseSha256");
  const cacheRoot = benchmarkCacheRootForPath(cachePath);
  const databasePath = manifest.formatVersion === 2
    ? resolveSnapshotBlobPath(
        cacheRoot,
        string(manifest.databaseBlobPath, "repository index snapshot databaseBlobPath")
      )
    : cachePath;
  if (!fs.existsSync(databasePath) || sha256(fs.readFileSync(databasePath)) !== expectedHash) {
    throw new Error(`repository index snapshot checksum mismatch: ${cachePath}`);
  }
  if (
    manifest.formatVersion === 2 &&
    positiveIntegerValue(manifest.databaseBytes, "repository index snapshot databaseBytes") !== fs.statSync(databasePath).size
  ) {
    throw new Error(`repository index snapshot size mismatch: ${cachePath}`);
  }
  const entryPaths = manifest.formatVersion === 2
    ? [manifestPath, databasePath]
    : [manifestPath, cachePath];
  registerBenchmarkCacheEntry(cacheRoot, {
    id: `repository_index_snapshot:${expectedKey}`,
    kind: "repository_index_snapshot",
    paths: entryPaths,
    contentSha256: expectedHash
  });
  const sourceRootPath = string(manifest.sourceRootPath, "repository index snapshot sourceRootPath");
  const destinationRootPath = resolveRoot(rootPath);
  const paths = ensureKairnDir(destinationRootPath);
  const staged = `${paths.databasePath}.snapshot-${crypto.randomUUID()}`;
  try {
    fs.copyFileSync(databasePath, staged, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(paths.databasePath)) throw new Error("cannot restore repository index snapshot over existing state");
    fs.renameSync(staged, paths.databasePath);
    const store = new SqliteStore(paths.databasePath);
    try { store.relocateIndexRoot(sourceRootPath, destinationRootPath); }
    finally { store.close(); }
  } finally { fs.rmSync(staged, { force: true }); }
  return true;
}

export function persistRepositoryIndexSnapshot(rootPath: string, cachePath: string): void {
  const manifestPath = `${cachePath}.manifest.json`;
  if (fs.existsSync(cachePath) || fs.existsSync(manifestPath)) {
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`repository index snapshot is incomplete: ${cachePath}`);
    }
    restoreRepositoryIndexSnapshotManifestOnly(cachePath);
    return;
  }
  const sourceRootPath = resolveRoot(rootPath);
  const paths = ensureKairnDir(sourceRootPath);
  const store = new SqliteStore(paths.databasePath);
  try { store.checkpointWal(); }
  finally { store.close(); }
  const parent = path.dirname(cachePath);
  fs.mkdirSync(parent, { recursive: true });
  const cacheRoot = benchmarkCacheRootForPath(cachePath);
  const sourceDatabaseBytes = fs.statSync(paths.databasePath).size;
  enforceBenchmarkCacheRetention(cacheRoot, {
    additionalBytes: sourceDatabaseBytes + 4096
  });
  const blobRoot = path.join(cacheRoot, "content-blobs", "sha256");
  fs.mkdirSync(blobRoot, { recursive: true });
  const stagedDatabase = path.join(blobRoot, `.snapshot-${crypto.randomUUID()}.sqlite`);
  const stagedManifest = `${manifestPath}.tmp-${crypto.randomUUID()}`;
  let createdBlobPath: string | undefined;
  let completed = false;
  try {
    fs.copyFileSync(paths.databasePath, stagedDatabase, fs.constants.COPYFILE_EXCL);
    const stagedStore = new SqliteStore(stagedDatabase);
    try {
      stagedStore.relocateIndexRoot(sourceRootPath, CANONICAL_REPOSITORY_SNAPSHOT_ROOT);
      stagedStore.checkpointWal();
    } finally {
      stagedStore.close();
    }
    const databaseHash = sha256(fs.readFileSync(stagedDatabase));
    const databaseBytes = fs.statSync(stagedDatabase).size;
    const blobPath = path.join(blobRoot, `${databaseHash}.sqlite`);
    const blobRelativePath = path.relative(cacheRoot, blobPath).replace(/\\/g, "/");
    if (!fs.existsSync(blobPath)) {
      fs.renameSync(stagedDatabase, blobPath);
      createdBlobPath = blobPath;
    } else if (fs.statSync(blobPath).size !== databaseBytes || sha256(fs.readFileSync(blobPath)) !== databaseHash) {
      throw new Error(`repository index snapshot blob checksum mismatch: ${blobPath}`);
    }
    const payload: RepositoryIndexSnapshotManifest = {
      formatVersion: 2,
      cacheKey: path.basename(cachePath, ".sqlite"),
      sourceRootPath: CANONICAL_REPOSITORY_SNAPSHOT_ROOT,
      databaseSha256: databaseHash,
      databaseBytes,
      databaseBlobPath: blobRelativePath
    };
    fs.writeFileSync(stagedManifest, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(stagedManifest, manifestPath);
    registerBenchmarkCacheEntry(cacheRoot, {
      id: `repository_index_snapshot:${payload.cacheKey}`,
      kind: "repository_index_snapshot",
      paths: [manifestPath, blobPath],
      contentSha256: databaseHash
    });
    completed = true;
  } finally {
    fs.rmSync(stagedDatabase, { force: true });
    fs.rmSync(`${stagedDatabase}-wal`, { force: true });
    fs.rmSync(`${stagedDatabase}-shm`, { force: true });
    fs.rmSync(stagedManifest, { force: true });
    if (!completed) {
      fs.rmSync(manifestPath, { force: true });
      if (createdBlobPath) fs.rmSync(createdBlobPath, { force: true });
    }
  }
}

function restoreRepositoryIndexSnapshotManifestOnly(cachePath: string): void {
  const manifestPath = `${cachePath}.manifest.json`;
  const parsed = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")), "repository index snapshot manifest");
  const expectedKey = path.basename(cachePath, ".sqlite");
  if ((parsed.formatVersion !== 1 && parsed.formatVersion !== 2) || parsed.cacheKey !== expectedKey) {
    throw new Error(`repository index snapshot identity mismatch: ${cachePath}`);
  }
  const expectedHash = string(parsed.databaseSha256, "repository index snapshot databaseSha256");
  const cacheRoot = benchmarkCacheRootForPath(cachePath);
  const databasePath = parsed.formatVersion === 2
    ? resolveSnapshotBlobPath(
        cacheRoot,
        string(parsed.databaseBlobPath, "repository index snapshot databaseBlobPath")
      )
    : cachePath;
  if (!fs.existsSync(databasePath) || sha256(fs.readFileSync(databasePath)) !== expectedHash) {
    throw new Error(`repository index snapshot checksum mismatch: ${cachePath}`);
  }
  if (
    parsed.formatVersion === 2 &&
    positiveIntegerValue(parsed.databaseBytes, "repository index snapshot databaseBytes") !== fs.statSync(databasePath).size
  ) {
    throw new Error(`repository index snapshot size mismatch: ${cachePath}`);
  }
  registerBenchmarkCacheEntry(cacheRoot, {
    id: `repository_index_snapshot:${expectedKey}`,
    kind: "repository_index_snapshot",
    paths: [manifestPath, databasePath],
    contentSha256: expectedHash
  });
}

function resolveSnapshotBlobPath(cacheRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("repository index snapshot blob path must be relative");
  const root = path.resolve(cacheRoot);
  const target = path.resolve(root, relativePath);
  const blobRoot = path.resolve(root, "content-blobs", "sha256");
  if (!target.startsWith(`${blobRoot}${path.sep}`)) {
    throw new Error("repository index snapshot blob escapes the content-addressed store");
  }
  return target;
}

function repositoryIndexImplementationSha256(kairnRoot: string): string {
  const sources = [
    "src/parser/parseFile.ts", "src/semantic/documents.ts", "src/indexer/indexRepo.ts",
    "src/graph/buildGraph.ts", "src/graph/budget.ts", "src/lexical/bm25.ts",
    "src/scanner/scanRepo.ts", "src/config/indexing.ts"
  ];
  return sha256(sources.map((relative) => `${relative}\0${sha256(fs.readFileSync(path.join(kairnRoot, relative)))}`).join("\0"));
}

export function restoreSnapshotEmbeddingCache(rootPath: string, cachePath: string): number {
  if (!fs.existsSync(cachePath)) return 0;
  const cache = parseSnapshotEmbeddingCache(cachePath);
  const cacheRoot = benchmarkCacheRootForPath(cachePath);
  const identity = embeddingCacheLedgerIdentity(cachePath);
  registerBenchmarkCacheEntry(cacheRoot, {
    id: identity.id,
    kind: identity.kind,
    paths: [cachePath],
    contentSha256: sha256(fs.readFileSync(cachePath))
  });
  const paths = ensureKairnDir(rootPath);
  const store = new SqliteStore(paths.databasePath);
  try {
    store.upsertSemanticEmbeddings(cache.embeddings.map((embedding) => ({
      rootPath,
      documentId: embedding.documentId,
      documentHash: embedding.documentHash,
      modelId: embedding.modelId,
      runtimeBackend: embedding.runtimeBackend,
      runtimeId: embedding.runtimeId,
      schemaVersion: embedding.schemaVersion,
      dimensions: embedding.dimensions,
      scale: embedding.scale,
      vector: new Int8Array(Buffer.from(embedding.vectorBase64, "base64"))
    })));
  } finally {
    store.close();
  }
  return cache.embeddings.length;
}

export function persistSnapshotEmbeddingCache(
  rootPath: string,
  cachePath: string,
  options: { mergeExisting?: boolean } = {}
): void {
  const paths = ensureKairnDir(rootPath);
  const store = new SqliteStore(paths.databasePath);
  let embeddings: SemanticEmbeddingRecord[];
  try {
    embeddings = store.listSemanticEmbeddings(rootPath);
  } finally {
    store.close();
  }
  if (embeddings.length === 0) return;
  const cacheKey = path.basename(cachePath, ".json");
  const previous = options.mergeExisting !== false && fs.existsSync(cachePath)
    ? parseSnapshotEmbeddingCache(cachePath).embeddings
    : [];
  const merged = new Map(
    previous.map((embedding) => [snapshotEmbeddingIdentity(embedding), embedding])
  );
  for (const embedding of embeddings) {
    const serialized = {
      documentId: embedding.documentId,
      documentHash: embedding.documentHash,
      modelId: embedding.modelId,
      runtimeBackend: embedding.runtimeBackend,
      runtimeId: embedding.runtimeId,
      schemaVersion: embedding.schemaVersion,
      dimensions: embedding.dimensions,
      scale: embedding.scale,
      vectorBase64: Buffer.from(
        embedding.vector.buffer,
        embedding.vector.byteOffset,
        embedding.vector.byteLength
      ).toString("base64")
    };
    merged.set(snapshotEmbeddingIdentity(serialized), serialized);
  }
  const payload: SnapshotEmbeddingCache = {
    formatVersion: 3,
    cacheKey,
    embeddings: [...merged.values()].sort((left, right) =>
      left.documentId.localeCompare(right.documentId) ||
      left.modelId.localeCompare(right.modelId) ||
      left.schemaVersion.localeCompare(right.schemaVersion)
    )
  };
  const serialized = `${JSON.stringify(payload)}\n`;
  const cacheRoot = benchmarkCacheRootForPath(cachePath);
  enforceBenchmarkCacheRetention(cacheRoot, {
    additionalBytes: Buffer.byteLength(serialized)
  });
  const parent = path.dirname(cachePath);
  fs.mkdirSync(parent, { recursive: true });
  const staged = `${cachePath}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(staged, serialized, { encoding: "utf8", flag: "wx" });
    replaceSnapshotCache(cachePath, staged);
    const identity = embeddingCacheLedgerIdentity(cachePath);
    registerBenchmarkCacheEntry(cacheRoot, {
      id: identity.id,
      kind: identity.kind,
      paths: [cachePath],
      contentSha256: sha256(Buffer.from(serialized))
    });
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function embeddingCacheLedgerIdentity(cachePath: string): {
  id: string;
  kind: "semantic_embedding_snapshot" | "semantic_embedding_lineage";
} {
  const cacheKey = path.basename(cachePath, ".json");
  const lineage = path.basename(path.dirname(cachePath)) === "semantic-embedding-lineage-cache";
  return {
    id: `${lineage ? "semantic_embedding_lineage" : "semantic_embedding_snapshot"}:${cacheKey}`,
    kind: lineage ? "semantic_embedding_lineage" : "semantic_embedding_snapshot"
  };
}

function snapshotEmbeddingIdentity(
  embedding: Pick<
    SnapshotEmbeddingCache["embeddings"][number],
    "documentId" | "modelId" | "runtimeId" | "schemaVersion"
  >
): string {
  return [
    embedding.documentId,
    embedding.modelId,
    embedding.runtimeId,
    embedding.schemaVersion
  ].join("\0");
}

function replaceSnapshotCache(cachePath: string, stagedPath: string): void {
  if (!fs.existsSync(cachePath)) {
    fs.renameSync(stagedPath, cachePath);
    return;
  }
  const backupPath = `${cachePath}.backup-${crypto.randomUUID()}`;
  fs.renameSync(cachePath, backupPath);
  try {
    fs.renameSync(stagedPath, cachePath);
    fs.rmSync(backupPath, { force: true });
  } catch (error) {
    if (!fs.existsSync(cachePath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, cachePath);
    }
    throw error;
  }
}

function parseSnapshotEmbeddingCache(cachePath: string): SnapshotEmbeddingCache {
  const parsed = record(JSON.parse(fs.readFileSync(cachePath, "utf8")), "snapshot embedding cache");
  const cacheKey = path.basename(cachePath, ".json");
  if ((parsed.formatVersion !== 1 && parsed.formatVersion !== 2 && parsed.formatVersion !== 3) || parsed.cacheKey !== cacheKey) {
    throw new Error(`semantic embedding cache identity mismatch: ${cachePath}`);
  }
  const embeddings = array(parsed.embeddings, "snapshot embedding cache embeddings").map((value, index) => {
    const item = record(value, `snapshot embedding cache embeddings[${index}]`);
    const schemaVersion = string(item.schemaVersion, `snapshot embedding cache embeddings[${index}].schemaVersion`);
    if (
      schemaVersion !== "semantic-documents-v1" &&
      schemaVersion !== "semantic-documents-v2" &&
      schemaVersion !== SEMANTIC_DOCUMENT_SCHEMA_VERSION
    ) {
      throw new Error(`snapshot embedding cache has unsupported schema ${schemaVersion}`);
    }
    const supportedSchemaVersion: SemanticEmbeddingRecord["schemaVersion"] = schemaVersion;
    const dimensions = positiveIntegerValue(
      item.dimensions,
      `snapshot embedding cache embeddings[${index}].dimensions`
    );
    const vectorBase64 = string(
      item.vectorBase64,
      `snapshot embedding cache embeddings[${index}].vectorBase64`
    );
    if (Buffer.from(vectorBase64, "base64").length !== dimensions) {
      throw new Error(`snapshot embedding cache vector length mismatch at row ${index}`);
    }
    return {
      documentId: string(item.documentId, `snapshot embedding cache embeddings[${index}].documentId`),
      documentHash: string(item.documentHash, `snapshot embedding cache embeddings[${index}].documentHash`),
      modelId: string(item.modelId, `snapshot embedding cache embeddings[${index}].modelId`),
      runtimeBackend: parsed.formatVersion === 1
        ? "wasm"
        : semanticRuntimeBackend(
            item.runtimeBackend,
            `snapshot embedding cache embeddings[${index}].runtimeBackend`
          ),
      runtimeId: parsed.formatVersion === 3
        ? string(item.runtimeId, `snapshot embedding cache embeddings[${index}].runtimeId`)
        : parsed.formatVersion === 2 && item.runtimeBackend === "node"
          ? "onnxruntime-node@unknown"
          : "onnxruntime-web@1.27.0",
      schemaVersion: supportedSchemaVersion,
      dimensions,
      scale: finiteNumber(item.scale, `snapshot embedding cache embeddings[${index}].scale`),
      vectorBase64
    };
  });
  return { formatVersion: parsed.formatVersion as 1 | 2 | 3, cacheKey, embeddings };
}

function semanticRuntimeBackend(
  value: unknown,
  label: string
): SemanticEmbeddingRecord["runtimeBackend"] {
  if (value !== "node" && value !== "wasm") throw new Error(`${label} must be node or wasm`);
  return value;
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

export function assertSemanticMaterializationReady(
  status: SemanticRetrieverStatus | undefined,
  caseId: string
): void {
  if (!isSemanticMaterializationReady(status)) {
    const detail = status
      ? [
          `requested=${status.requestedMode}`,
          `served=${status.servedMode}`,
          `index=${status.semanticIndexStatus}`,
          status.semanticFallbackReason
        ].filter(Boolean).join(", ")
      : "semantic status missing";
    throw new Error(`${caseId}: required semantic retrieval is not ready (${detail})`);
  }
}

export function isSemanticMaterializationReady(
  status: SemanticRetrieverStatus | undefined
): boolean {
  return Boolean(
    status &&
    status.requestedMode === "semantic" &&
    status.servedMode === "semantic" &&
    status.semanticIndexStatus === "ready"
  );
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

function positiveIntegerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
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
      token === "--migrate-feature-schema" || token === "--resume" ||
      token === "--require-semantic"
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
    ...(values.get("--cache-max-bytes")
      ? { cacheMaxBytes: positiveInteger(values.get("--cache-max-bytes")!, "--cache-max-bytes") }
      : {}),
    ...(values.get("--snapshot-embedding-cache")
      ? { snapshotEmbeddingCachePath: values.get("--snapshot-embedding-cache")! }
      : {}),
    ...(values.get("--lineage-embedding-cache")
      ? { lineageEmbeddingCachePath: values.get("--lineage-embedding-cache")! }
      : {}),
    ...(values.get("--repository-index-snapshot")
      ? { repositoryIndexSnapshotPath: values.get("--repository-index-snapshot")! }
      : {}),
    allowSample: flags.has("--allow-sample"),
    allowLocalFixture: flags.has("--allow-local-fixture"),
    draft: flags.has("--draft"),
    processIsolation: !flags.has("--in-process"),
    isolatedWorker: flags.has("--isolated-worker"),
    migrateFeatureSchema: flags.has("--migrate-feature-schema"),
    resume: flags.has("--resume"),
    requireSemantic: flags.has("--require-semantic"),
    ...(values.get("--limit") ? { limit: positiveInteger(values.get("--limit")!, "--limit") } : {}),
    ...(values.get("--probe-limit")
      ? { probeLimit: boundedProbeLimit(values.get("--probe-limit")!) }
      : {}),
    ...(values.get("--case-id") ? { caseIds: commaSeparated(values.get("--case-id")!, "--case-id") } : {}),
    ...(values.get("--split") ? { splits: corpusSplits(values.get("--split")!) } : {})
  };
}

function boundedProbeLimit(value: string): number {
  const parsed = positiveInteger(value, "--probe-limit");
  if (parsed < 128 || parsed > 512) {
    throw new Error("--probe-limit must be between 128 and 512");
  }
  return parsed;
}

function commaSeparated(value: string, label: string): string[] {
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error(`${label} must contain at least one case id`);
  return values;
}

function corpusSplits(value: string): Split[] {
  const values = commaSeparated(value, "--split");
  const allowed = new Set<Split>(["train", "calibration", "holdout"]);
  const invalid = values.filter((item) => !allowed.has(item as Split));
  if (invalid.length > 0) {
    throw new Error(`--split contains unsupported value(s): ${invalid.join(", ")}`);
  }
  return values as Split[];
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
