#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  appendMissingLabeledCandidates,
  collapseCrossEncoderDocumentScores,
  rankCrossEncoderCandidates,
  repositoryIndexSnapshotCacheKey,
  selectFrozenSnapshot,
  type CrossEncoderCandidateScore,
  type SnapshotCatalogEntry
} from "../src/bench/crossEncoderEvaluation.js";
import {
  JINA_TINY_CROSS_ENCODER,
  crossEncoderManifestSha256,
  loadLocalCrossEncoder,
  normalizeCrossEncoderScore,
  verifyCrossEncoderModelFiles
} from "../src/bench/crossEncoderReranker.js";
import {
  loadLocalEmbeddingModel,
  quantizedCosineSimilarity
} from "../src/semantic/modelRuntime.js";
import { getSemanticModelState } from "../src/semantic/modelManager.js";
import { DEFAULT_SEMANTIC_MODEL_ID } from "../src/semantic/modelRegistry.js";

type FrozenCandidate = {
  path: string;
  features: Record<string, number>;
};

const BASE_FEATURES = [
  "exactPath", "basenameMatch", "exactSymbol", "symbolPrefix", "bm25",
  "keyword", "semantic", "failureReference", "gitChanged", "alreadyDelivered",
  "graphNeighbor", "graphPrecision", "graphConsensus", "graphSupport",
  "graphSeedStrength", "graphIndependentEvidence", "sourceTestPair",
  "productionSource", "testFile", "docsFile", "generatedVendor", "intentRoleMatch",
  "importance", "contentCost", "missingSymbols", "missingLexical"
] as const;

type FrozenCase = {
  id: string;
  split: "train" | "calibration" | "holdout";
  language: string;
  scenario: string;
  repositoryUrl: string;
  repositoryLineageId: string;
  repositoryRef: string;
  prompt: string;
  querySha256: string;
  trainingCandidates: FrozenCandidate[];
};

type ReportCase = {
  id: string;
  requiredSourceExistingFiles: string[];
  officialPatchSourceExistingFiles: string[];
};

type SemanticDocumentRow = {
  id: string;
  file_path: string;
  kind: "file" | "symbol";
  symbol: string | null;
  text: string;
  hash: string;
  schema_version: string;
  document_hash: string | null;
  model_id: string | null;
  dimensions: number | null;
  vector_blob: Buffer | null;
  scale: number | null;
};

type SelectedSemanticDocument = SemanticDocumentRow & { selectorSimilarity: number };

type EvaluatedCase = {
  id: string;
  split: "train" | "calibration";
  language: string;
  scenario: string;
  repositoryUrl: string;
  repositoryRef: string;
  querySha256: string;
  snapshotCacheKey: string;
  snapshotDatabaseSha256: string;
  semanticDocumentCoverage: number;
  documentsScored: number;
  candidatePoolSize: number;
  scoredCandidateCount: number;
  allPoolScoresAvailable: boolean;
  scoringMs: number;
  candidates: CrossEncoderCandidateScore[];
  requiredSourceRanks: Record<string, number | null>;
  officialPatchSourceRanks: Record<string, number | null>;
};

const options = parseOptions(process.argv.slice(2));
const manifestPath = path.resolve(options.manifest);
const reportPath = path.resolve(options.report);
const snapshotRoot = path.resolve(options.snapshotRoot);
const modelPath = path.resolve(options.modelPath);
const embeddingModelPath = path.resolve(options.embeddingModelPath);
const outPath = path.resolve(options.out);
const progressPath = `${outPath}.progress.json`;
const manifestBytes = fs.readFileSync(manifestPath);
const reportBytes = fs.readFileSync(reportPath);
const trainingRowsBytes = options.trainingRows
  ? fs.readFileSync(path.resolve(options.trainingRows))
  : undefined;
const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
  materializer: { kairnCommit: string };
  cases: FrozenCase[];
};
const report = JSON.parse(reportBytes.toString("utf8")) as { cases: ReportCase[] };
if (!Array.isArray(manifest.cases) || !Array.isArray(report.cases)) {
  throw new Error("Frozen manifest/report do not contain case arrays.");
}
const allCases = manifest.cases;
if (allCases.length !== 135) throw new Error(`Expected the frozen 135-case cohort; found ${allCases.length}.`);
if (allCases.some((item) => item.split === "holdout")) {
  throw new Error("Cross-encoder development evaluation must never load holdout cases.");
}
const reportById = new Map(report.cases.map((item) => [item.id, item]));
if (reportById.size !== allCases.length || allCases.some((item) => !reportById.has(item.id))) {
  throw new Error("Frozen manifest/report case populations differ.");
}
const selectedIds = options.caseIds.length > 0
  ? options.caseIds
  : allCases.map((item) => item.id);
if (new Set(selectedIds).size !== selectedIds.length) throw new Error("Duplicate --case-id values are not allowed.");
const byId = new Map(allCases.map((item) => [item.id, item]));
const selected = selectedIds.map((id) => {
  const item = byId.get(id);
  if (!item) throw new Error(`Unknown frozen case ${id}.`);
  return item;
});
const nonEvidence = selected.length !== 135;
if (!nonEvidence && !trainingRowsBytes) {
  throw new Error("Full cross-encoder evaluation requires --training-rows to bind reviewed labels.");
}
const labeledCandidatesByCase = trainingRowsBytes
  ? readLabeledTrainingCandidates(trainingRowsBytes, byId)
  : new Map<string, Map<string, FrozenCandidate>>();
const modelState = verifyCrossEncoderModelFiles(modelPath);
if (modelState.status !== "ready") throw new Error(modelState.error ?? `Cross-encoder is ${modelState.status}.`);
const embeddingModelState = getSemanticModelState({
  modelId: DEFAULT_SEMANTIC_MODEL_ID,
  modelPath: embeddingModelPath,
  verifyHashes: true
});
if (embeddingModelState.status !== "ready") {
  throw new Error(embeddingModelState.error ?? `Semantic selector model is ${embeddingModelState.status}.`);
}
const catalog = readSnapshotCatalog(snapshotRoot);
if (!/^[0-9a-f]{40}$/.test(manifest.materializer?.kairnCommit ?? "")) {
  throw new Error("Frozen manifest is missing its materializer commit.");
}
const kairnRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryIndexImplementationSha256 = implementationSha256AtCommit(
  kairnRoot,
  manifest.materializer.kairnCommit
);
const evaluatorImplementationSha256 = sha256([
  ["scripts/evaluate-cross-encoder-reranker.ts", fileURLToPath(import.meta.url)],
  ["src/bench/crossEncoderEvaluation.ts", path.join(kairnRoot, "src/bench/crossEncoderEvaluation.ts")],
  ["src/bench/crossEncoderReranker.ts", path.join(kairnRoot, "src/bench/crossEncoderReranker.ts")]
].map(([relative, target]) => `${relative}\0${sha256(fs.readFileSync(target!))}`).join("\0"));
const inputFingerprint = sha256([
  "cross-encoder-evaluation.v4",
  sha256(manifestBytes),
  sha256(reportBytes),
  trainingRowsBytes ? sha256(trainingRowsBytes) : "selected-case-smoke",
  crossEncoderManifestSha256(),
  embeddingModelState.manifestSha256 ?? "missing-semantic-manifest",
  repositoryIndexImplementationSha256,
  evaluatorImplementationSha256,
  ...selectedIds
].join("\0"));
const completed = options.resume
  ? readProgress(progressPath, inputFingerprint, selectedIds)
  : [];
const completedIds = new Set(completed.map((item) => item.id));
const model = await loadLocalCrossEncoder({ modelPath });
const embeddingModel = await loadLocalEmbeddingModel({
  modelId: DEFAULT_SEMANTIC_MODEL_ID,
  modelPath: embeddingModelPath
});
const verifiedSnapshots = new Set<string>();
const started = performance.now();

try {
  for (const [caseIndex, item] of selected.entries()) {
    if (completedIds.has(item.id)) continue;
    const expectedCacheKey = repositoryIndexSnapshotCacheKey({
      repositoryLineageId: item.repositoryLineageId,
      repositoryRef: item.repositoryRef,
      modelManifestSha256: embeddingModelState.manifestSha256!,
      implementationSha256: repositoryIndexImplementationSha256
    });
    const snapshot = selectFrozenSnapshot({ catalog, expectedCacheKey });
    if (!verifiedSnapshots.has(snapshot.databasePath)) {
      const actual = await sha256File(snapshot.databasePath);
      if (actual !== snapshot.databaseSha256) {
        throw new Error(`${item.id}: immutable repository snapshot SHA-256 mismatch.`);
      }
      verifiedSnapshots.add(snapshot.databasePath);
    }
    const reportCase = reportById.get(item.id)!;
    const scoreAllCandidates = nonEvidence || item.split === "calibration" ||
      reportCase.requiredSourceExistingFiles.length > 0;
    const labeledCandidates = labeledCandidatesByCase.get(item.id) ?? new Map<string, FrozenCandidate>();
    const candidatesToScore = scoreAllCandidates
      ? appendMissingLabeledCandidates(item.trainingCandidates, labeledCandidates)
      : [...labeledCandidates.values()].sort((left, right) => left.path.localeCompare(right.path));
    const [queryVector] = await embeddingModel.embedQueries([item.prompt]);
    if (!queryVector) throw new Error(`${item.id}: semantic selector returned no query embedding.`);
    const documents = readSemanticDocuments(
      snapshot.databasePath,
      candidatesToScore.map((candidate) => candidate.path),
      queryVector
    );
    const scoringStarted = performance.now();
    const scored: CrossEncoderCandidateScore[] = [];
    const frozenPoolPaths = new Set(item.trainingCandidates.map((candidate) => candidate.path));
    let documentsScored = 0;
    let filesWithSemanticDocuments = 0;
    for (const candidate of candidatesToScore) {
      const semanticDocument = documents.get(candidate.path);
      if (semanticDocument) filesWithSemanticDocuments += 1;
      const objectiveFallback = objectiveMetadataDocument(item, candidate);
      const pairs = semanticDocument
        ? [{ query: item.prompt, document: semanticDocument.text }]
        : [{ query: item.prompt, document: objectiveFallback }];
      const logits = await model.score(pairs);
      documentsScored += logits.length;
      scored.push(collapseCrossEncoderDocumentScores({
        path: candidate.path,
        documents: semanticDocument ? [{
          hash: semanticDocument.hash,
          logit: logits[0]!,
          kind: semanticDocument.kind,
          symbol: semanticDocument.symbol,
          selectorSimilarity: semanticDocument.selectorSimilarity
        }] : [],
        fallbackLogit: logits[0]!,
        probability: normalizeCrossEncoderScore,
        exactPath: numericFeature(candidate, "exactPath"),
        failureReference: numericFeature(candidate, "failureReference"),
        generatedVendor: numericFeature(candidate, "generatedVendor"),
        inFrozenPool: frozenPoolPaths.has(candidate.path)
      }));
    }
    const ranked = rankCrossEncoderCandidates(scored.filter((candidate) => candidate.inFrozenPool));
    const positions = new Map(ranked.map((candidate, index) => [candidate.path, index + 1]));
    completed.push({
      id: item.id,
      split: item.split,
      language: item.language,
      scenario: item.scenario,
      repositoryUrl: item.repositoryUrl,
      repositoryRef: item.repositoryRef,
      querySha256: item.querySha256,
      snapshotCacheKey: snapshot.cacheKey,
      snapshotDatabaseSha256: snapshot.databaseSha256,
      semanticDocumentCoverage: filesWithSemanticDocuments / candidatesToScore.length,
      documentsScored,
      candidatePoolSize: item.trainingCandidates.length,
      scoredCandidateCount: candidatesToScore.length,
      allPoolScoresAvailable: scoreAllCandidates,
      scoringMs: rounded(performance.now() - scoringStarted),
      candidates: scored,
      requiredSourceRanks: ranksFor(reportCase.requiredSourceExistingFiles, positions),
      officialPatchSourceRanks: ranksFor(reportCase.officialPatchSourceExistingFiles, positions)
    });
    completedIds.add(item.id);
    writeProgress(progressPath, inputFingerprint, selectedIds, completed);
    console.log(JSON.stringify({
      completed: completed.length,
      total: selected.length,
      caseIndex: caseIndex + 1,
      id: item.id,
      documentsScored,
      scoringMs: completed.at(-1)?.scoringMs
    }));
  }
} finally {
  await model.close();
}

const output = {
  schemaVersion: "cross-encoder-frozen-pool-scores.v2",
  promotionEligible: false,
  nonEvidence,
  reason: nonEvidence
    ? "Selected-case infrastructure smoke; it cannot support an effectiveness claim."
    : "Train/calibration-only model-capacity diagnostic; detached holdout remains sealed.",
  inputFingerprint,
  inputs: {
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    reportPath,
    reportSha256: sha256(reportBytes),
    trainingRowsPath: options.trainingRows ? path.resolve(options.trainingRows) : null,
    trainingRowsSha256: trainingRowsBytes ? sha256(trainingRowsBytes) : null,
    snapshotRoot,
    modelPath,
    modelManifestSha256: crossEncoderManifestSha256(),
    embeddingModelPath,
    embeddingModelId: embeddingModelState.modelId,
    embeddingModelManifestSha256: embeddingModelState.manifestSha256,
    materializerCommit: manifest.materializer.kairnCommit,
    repositoryIndexImplementationSha256,
    evaluatorImplementationSha256
  },
  model: JINA_TINY_CROSS_ENCODER,
  documentSchema: {
    primary: "semantic-documents-v5",
    fallback: "objective path, language, and existing file-role features only",
    semanticSelection: "maximum normalized cosine similarity over existing Jina file/symbol documents",
    fileCollapse: "one embedding-selected structural document receives one cross-encoder logit per file",
    hardPriority: "precise failure reference, then explicit path, then model logit",
    inferenceIsolation: "one query/document pair per ONNX invocation"
  },
  cohort: {
    selectedCases: selected.length,
    totalFrozenCases: allCases.length,
    caseIds: selectedIds,
    holdoutAccessed: false
  },
  runtime: {
    totalMs: rounded(performance.now() - started),
    documentsScored: completed.reduce((sum, item) => sum + item.documentsScored, 0),
    uniqueSnapshotsVerified: verifiedSnapshots.size
  },
  zeroShot: summarize(completed),
  cases: completed.sort((left, right) => left.id.localeCompare(right.id))
};
writeAtomic(outPath, output);
console.log(JSON.stringify({
  out: outPath,
  nonEvidence,
  runtime: output.runtime,
  zeroShot: output.zeroShot
}, null, 2));

function readSnapshotCatalog(root: string): SnapshotCatalogEntry[] {
  if (!fs.existsSync(root)) throw new Error(`Snapshot root does not exist: ${root}`);
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(".sqlite.manifest.json"))
    .sort()
    .map((name) => {
      const manifestPath = path.join(root, name);
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<SnapshotCatalogEntry> & {
        formatVersion?: number;
      };
      const cacheKey = name.slice(0, -".sqlite.manifest.json".length);
      const databasePath = path.join(root, `${cacheKey}.sqlite`);
      if (
        parsed.formatVersion !== 1 ||
        parsed.cacheKey !== cacheKey ||
        typeof parsed.sourceRootPath !== "string" ||
        typeof parsed.databaseSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(parsed.databaseSha256) ||
        !fs.existsSync(databasePath)
      ) {
        throw new Error(`Invalid or incomplete repository snapshot manifest: ${manifestPath}`);
      }
      return {
        databasePath,
        manifestPath,
        cacheKey,
        sourceRootPath: parsed.sourceRootPath,
        databaseSha256: parsed.databaseSha256
      };
    });
}

function readSemanticDocuments(
  databasePath: string,
  filePaths: string[],
  queryVector: Float32Array
): Map<string, SelectedSemanticDocument> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const placeholders = filePaths.map(() => "?").join(",");
    const rows = database.prepare(
      `select d.id, d.file_path, d.kind, d.symbol, d.text, d.hash, d.schema_version,
              e.document_hash, e.model_id, e.dimensions, e.vector_blob, e.scale
       from semantic_documents d
       left join semantic_embeddings e
         on e.root_path = d.root_path
        and e.document_id = d.id
        and e.document_hash = d.hash
        and e.model_id = ?
       where d.file_path in (${placeholders})`
    ).all(DEFAULT_SEMANTIC_MODEL_ID, ...filePaths) as SemanticDocumentRow[];
    const grouped = new Map<string, SelectedSemanticDocument>();
    for (const row of rows) {
      if (row.schema_version !== "semantic-documents-v5") {
        throw new Error(`Snapshot contains unsupported semantic document schema ${row.schema_version}.`);
      }
      if (
        row.model_id !== DEFAULT_SEMANTIC_MODEL_ID ||
        row.document_hash !== row.hash ||
        !row.vector_blob ||
        !row.dimensions ||
        row.scale === null
      ) {
        continue;
      }
      const selectorSimilarity = quantizedCosineSimilarity(queryVector, {
        vector: new Int8Array(row.vector_blob.buffer, row.vector_blob.byteOffset, row.vector_blob.byteLength),
        dimensions: row.dimensions,
        scale: row.scale
      });
      const candidate = { ...row, selectorSimilarity };
      const existing = grouped.get(row.file_path);
      if (
        !existing ||
        candidate.selectorSimilarity > existing.selectorSimilarity ||
        (candidate.selectorSimilarity === existing.selectorSimilarity &&
          (candidate.kind.localeCompare(existing.kind) || candidate.hash.localeCompare(existing.hash)) < 0)
      ) {
        grouped.set(row.file_path, candidate);
      }
    }
    return grouped;
  } finally {
    database.close();
  }
}

function objectiveMetadataDocument(item: FrozenCase, candidate: FrozenCandidate): string {
  const role = numericFeature(candidate, "generatedVendor") > 0
    ? "generated-or-vendor"
    : numericFeature(candidate, "testFile") > 0
      ? "test"
      : numericFeature(candidate, "docsFile") > 0
        ? "documentation"
        : numericFeature(candidate, "productionSource") > 0
          ? "production-source"
          : "unclassified";
  return `file: ${candidate.path}\nlanguage: ${item.language}\nrole: ${role}`;
}

function numericFeature(candidate: FrozenCandidate, name: string): number {
  const value = candidate.features[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${candidate.path}: missing numeric feature ${name}.`);
  }
  return value;
}

function ranksFor(paths: string[], positions: Map<string, number>): Record<string, number | null> {
  return Object.fromEntries(paths.map((filePath) => [filePath, positions.get(filePath) ?? null]));
}

function summarize(cases: EvaluatedCase[]): Record<string, unknown> {
  const calibration = evaluateRanks(cases, "officialPatchSourceRanks", "calibration");
  const required = evaluateRanks(cases, "requiredSourceRanks");
  return { weakPatchCalibration: calibration, requiredSourceDiagnostic: required };
}

function evaluateRanks(
  cases: EvaluatedCase[],
  field: "requiredSourceRanks" | "officialPatchSourceRanks",
  split?: "calibration"
): Record<string, unknown> {
  const selected = cases.filter((item) => (!split || item.split === split) && Object.keys(item[field]).length > 0);
  const ranks = selected.flatMap((item) => Object.values(item[field]));
  const recall = (limit: number) => ranks.length > 0
    ? ranks.filter((rank) => rank !== null && rank <= limit).length / ranks.length
    : null;
  return {
    cases: selected.length,
    requiredFiles: ranks.length,
    recallAt1: recall(1),
    recallAt5: recall(5),
    recallAt64: recall(64),
    recallAt128: recall(128),
    mrr: ranks.length > 0
      ? ranks.reduce((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length
      : null,
    missesAt5: selected
      .filter((item) => Object.values(item[field]).some((rank) => rank === null || rank > 5))
      .map((item) => ({ id: item.id, ranks: item[field] })),
    missesAt64: selected
      .filter((item) => Object.values(item[field]).some((rank) => rank === null || rank > 64))
      .map((item) => ({ id: item.id, ranks: item[field] }))
  };
}

function readProgress(
  progressPath: string,
  fingerprint: string,
  selectedIds: string[]
): EvaluatedCase[] {
  if (!fs.existsSync(progressPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(progressPath, "utf8")) as {
    schemaVersion?: string;
    inputFingerprint?: string;
    selectedIds?: string[];
    cases?: EvaluatedCase[];
  };
  if (
    parsed.schemaVersion !== "cross-encoder-evaluation-progress.v4" ||
    parsed.inputFingerprint !== fingerprint ||
    JSON.stringify(parsed.selectedIds) !== JSON.stringify(selectedIds) ||
    !Array.isArray(parsed.cases)
  ) {
    throw new Error("Cross-encoder progress identity does not match this exact run.");
  }
  const completedIds = parsed.cases.map((item) => item.id);
  if (JSON.stringify(completedIds) !== JSON.stringify(selectedIds.slice(0, completedIds.length))) {
    throw new Error("Cross-encoder progress is not a valid selected-case prefix.");
  }
  return parsed.cases;
}

function readLabeledTrainingCandidates(
  bytes: Buffer,
  cases: Map<string, FrozenCase>
): Map<string, Map<string, FrozenCandidate>> {
  const result = new Map<string, Map<string, FrozenCandidate>>();
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      caseGroupId?: string;
      candidatePath?: string;
      split?: string;
      label?: number | null;
      features?: number[];
    };
    if (row.label !== 0 && row.label !== 1) continue;
    if (row.split === "holdout") throw new Error(`Training row ${index + 1} attempts to load holdout data.`);
    if (
      !row.caseGroupId ||
      !row.candidatePath ||
      !cases.has(row.caseGroupId) ||
      !Array.isArray(row.features) ||
      row.features.length !== BASE_FEATURES.length ||
      !row.features.every(Number.isFinite)
    ) {
      throw new Error(`Training row ${index + 1} does not map to the frozen 135-case cohort.`);
    }
    const candidates = result.get(row.caseGroupId) ?? new Map<string, FrozenCandidate>();
    const candidate: FrozenCandidate = {
      path: row.candidatePath,
      features: Object.fromEntries(
        BASE_FEATURES.map((name, featureIndex) => [name, row.features![featureIndex]!])
      )
    };
    const existing = candidates.get(candidate.path);
    if (existing && JSON.stringify(existing.features) !== JSON.stringify(candidate.features)) {
      throw new Error(`Training row ${index + 1} conflicts with an earlier feature vector.`);
    }
    candidates.set(candidate.path, candidate);
    result.set(row.caseGroupId, candidates);
  }
  if (result.size === 0) throw new Error("Reviewed training rows contain no labeled candidates.");
  return result;
}

function writeProgress(
  progressPath: string,
  fingerprint: string,
  selectedIds: string[],
  cases: EvaluatedCase[]
): void {
  writeAtomic(progressPath, {
    schemaVersion: "cross-encoder-evaluation-progress.v4",
    inputFingerprint: fingerprint,
    selectedIds,
    cases
  });
}

function writeAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(staged, target);
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function implementationSha256AtCommit(root: string, commit: string): string {
  const sources = [
    "src/parser/parseFile.ts",
    "src/semantic/documents.ts",
    "src/indexer/indexRepo.ts",
    "src/graph/buildGraph.ts",
    "src/graph/budget.ts",
    "src/lexical/bm25.ts",
    "src/scanner/scanRepo.ts",
    "src/config/indexing.ts"
  ];
  return sha256(sources.map((relative) => {
    const content = execFileSync("git", ["show", `${commit}:${relative}`], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024
    });
    return `${relative}\0${sha256(content)}`;
  }).join("\0"));
}

function rounded(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function parseOptions(argv: string[]): {
  manifest: string;
  report: string;
  snapshotRoot: string;
  modelPath: string;
  embeddingModelPath: string;
  trainingRows?: string;
  out: string;
  caseIds: string[];
  resume: boolean;
} {
  const args = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  const caseIds: string[] = [];
  let resume = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === "--resume") {
      resume = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`);
    index += 1;
    if (key === "--case-id") caseIds.push(value);
    else values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`Missing required option ${key}.`);
    return value;
  };
  return {
    manifest: required("--manifest"),
    report: required("--report"),
    snapshotRoot: required("--snapshot-root"),
    modelPath: required("--model-path"),
    embeddingModelPath: required("--embedding-model-path"),
    ...(values.get("--training-rows") ? { trainingRows: values.get("--training-rows")! } : {}),
    out: required("--out"),
    caseIds,
    resume
  };
}
