// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { scoreSemanticEmbeddingIndex } from "../src/retrieval/semanticCandidates.js";
import {
  loadLocalEmbeddingModel,
  quantizeSemanticEmbedding
} from "../src/semantic/modelRuntime.js";
import type {
  SemanticDocumentRecord,
  SemanticEmbeddingRecord
} from "../src/types.js";

type SelectionCase = {
  id: string;
  lineageId: string;
  split: "train" | "calibration" | "holdout";
  language: "python" | "typescript" | "go" | "java" | "cpp";
  scenario: "source_localization" | "failure_first" | "long_session";
  targetPath: string;
  query: string;
  targetText: string;
};

type SelectionManifest = {
  schemaVersion: "semantic-model-selection.v1";
  campaignId: string;
  sealed: true;
  documentSchemaVersion: SemanticDocumentRecord["schemaVersion"];
  selectionSplits: Array<"train" | "calibration">;
  holdoutSplit: "holdout";
  cases: SelectionCase[];
};

const options = parseArguments(process.argv.slice(2));
const manifestPath = path.resolve(options.manifest);
const rawManifest = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(rawManifest) as SelectionManifest;
validateManifest(manifest);
const selectedSplits = options.phase === "selection"
  ? new Set<string>(manifest.selectionSplits)
  : new Set<string>([manifest.holdoutSplit]);
const selectedCases = manifest.cases.filter((item) => selectedSplits.has(item.split));
if (selectedCases.length === 0) throw new Error(`No ${options.phase} cases exist in the semantic model manifest.`);

const initializationStarted = performance.now();
const model = await loadLocalEmbeddingModel({
  modelId: options.modelId,
  modelPath: path.resolve(options.modelPath)
});
const coldInitializationMs = performance.now() - initializationStarted;
const targetDocuments = manifest.cases.map((item) => semanticDocument(
  item.targetPath,
  item.targetText,
  `case:${item.id}`,
  manifest.documentSchemaVersion
));
const noiseDocuments = buildNoiseDocuments(120, manifest.documentSchemaVersion);
const documents = [...targetDocuments, ...noiseDocuments];
const embeddings: SemanticEmbeddingRecord[] = [];
const embeddingStarted = performance.now();
for (let offset = 0; offset < documents.length; offset += 8) {
  const batch = documents.slice(offset, offset + 8);
  const vectors = await model.embedDocuments(batch.map((document) => document.text));
  for (let index = 0; index < batch.length; index += 1) {
    const semanticDocument = batch[index]!;
    embeddings.push(quantizeSemanticEmbedding({
      rootPath: "/synthetic-semantic-selection",
      documentId: semanticDocument.id,
      documentHash: semanticDocument.hash,
      modelId: model.manifest.modelId,
      schemaVersion: manifest.documentSchemaVersion,
      vector: vectors[index]!
    }));
  }
}
const embeddingMs = performance.now() - embeddingStarted;

const rows = [];
for (const selectionCase of selectedCases) {
  const started = performance.now();
  const [queryVector] = await model.embedQueries([selectionCase.query]);
  if (!queryVector) throw new Error(`Model returned no query vector for ${selectionCase.id}.`);
  const hits = scoreSemanticEmbeddingIndex({
    queryVector,
    documents,
    embeddings,
    limit: 128
  });
  const rankIndex = hits.findIndex((hit) => hit.path === selectionCase.targetPath);
  const rank = rankIndex >= 0 ? rankIndex + 1 : null;
  rows.push({
    id: selectionCase.id,
    lineageId: selectionCase.lineageId,
    split: selectionCase.split,
    language: selectionCase.language,
    scenario: selectionCase.scenario,
    targetPath: selectionCase.targetPath,
    rank,
    hitAt1: rank === 1,
    hitAt5: rank !== null && rank <= 5,
    hitAt64: rank !== null && rank <= 64,
    hitAt128: rank !== null && rank <= 128,
    queryLatencyMs: rounded(performance.now() - started)
  });
}

const report = {
  schemaVersion: "semantic-model-evaluation.v1",
  campaignId: manifest.campaignId,
  manifestSha256: sha256(rawManifest),
  phase: options.phase,
  model: {
    modelId: model.manifest.modelId,
    upstreamRepository: model.manifest.upstreamRepository,
    upstreamRevision: model.manifest.upstreamRevision,
    dimensions: model.manifest.dimensions,
    pooling: model.manifest.pooling
  },
  corpus: {
    caseCount: rows.length,
    documentCount: documents.length,
    noiseDocumentCount: noiseDocuments.length,
    splits: [...selectedSplits].sort()
  },
  runtime: {
    coldInitializationMs: rounded(coldInitializationMs),
    embeddingMs: rounded(embeddingMs),
    medianQueryLatencyMs: median(rows.map((row) => row.queryLatencyMs))
  },
  metrics: {
    recallAt1: ratio(rows.filter((row) => row.hitAt1).length, rows.length),
    recallAt5: ratio(rows.filter((row) => row.hitAt5).length, rows.length),
    strictFullRecallAt64: ratio(rows.filter((row) => row.hitAt64).length, rows.length),
    strictFullRecallAt128: ratio(rows.filter((row) => row.hitAt128).length, rows.length),
    meanReciprocalRank: rounded(
      rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length,
      6
    ),
    zeroPositiveCasesAt128: rows.filter((row) => !row.hitAt128).length
  },
  rows
};

const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) {
  const outputPath = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
}
process.stdout.write(output);

function parseArguments(args: string[]): {
  modelId: string;
  modelPath: string;
  manifest: string;
  phase: "selection" | "holdout";
  out?: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid semantic evaluation argument near ${key ?? "<end>"}.`);
    values.set(key.slice(2), value);
  }
  const modelId = values.get("model-id");
  const modelPath = values.get("model-path");
  const phase = values.get("phase") ?? "selection";
  if (!modelId || !modelPath) throw new Error("--model-id and --model-path are required.");
  if (phase !== "selection" && phase !== "holdout") throw new Error("--phase must be selection or holdout.");
  return {
    modelId,
    modelPath,
    manifest: values.get("manifest") ?? "benchmarks/semantic/model-selection-v3.json",
    phase,
    ...(values.get("out") ? { out: values.get("out")! } : {})
  };
}

function validateManifest(manifest: SelectionManifest): void {
  if (
    manifest.schemaVersion !== "semantic-model-selection.v1" ||
    manifest.sealed !== true ||
    ![
      "semantic-documents-v1",
      "semantic-documents-v2",
      "semantic-documents-v3",
      "semantic-documents-v4",
      "semantic-documents-v5"
    ].includes(manifest.documentSchemaVersion) ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== 15
  ) {
    throw new Error("Semantic model selection manifest is not sealed or complete.");
  }
  const identities = new Set<string>();
  const cells = new Set<string>();
  const lineages = new Set<string>();
  for (const item of manifest.cases) {
    if (identities.has(item.id) || lineages.has(item.lineageId)) {
      throw new Error(`Semantic selection identity or lineage is duplicated: ${item.id}.`);
    }
    identities.add(item.id);
    lineages.add(item.lineageId);
    cells.add(`${item.language}:${item.scenario}`);
  }
  if (cells.size !== 15) throw new Error("Semantic model selection must cover all 15 language/scenario cells.");
}

function semanticDocument(
  filePath: string,
  text: string,
  identity: string,
  schemaVersion: SemanticDocumentRecord["schemaVersion"]
): SemanticDocumentRecord {
  return {
    rootPath: "/synthetic-semantic-selection",
    id: `sdoc_${sha256(identity).slice(0, 24)}`,
    filePath,
    kind: "file",
    text,
    hash: sha256(`${schemaVersion}\0${text}`),
    tokenEstimate: Math.ceil(text.length / 4),
    schemaVersion
  };
}

function buildNoiseDocuments(
  count: number,
  schemaVersion: SemanticDocumentRecord["schemaVersion"]
): SemanticDocumentRecord[] {
  const domains = [
    "analytics chart rendering", "email template formatting", "image thumbnail resizing",
    "command line argument help", "database schema migrations", "international date display",
    "keyboard shortcut mapping", "static asset compression", "test snapshot serialization",
    "documentation navigation", "color theme selection", "CSV report export"
  ];
  const operations = [
    "loads configuration", "formats output", "validates a field", "renders a component",
    "writes an audit record", "converts a value", "sorts display rows", "builds a menu",
    "parses metadata", "generates a label"
  ];
  return Array.from({ length: count }, (_, index) => {
    const domain = domains[index % domains.length]!;
    const operation = operations[Math.floor(index / domains.length) % operations.length]!;
    const filePath = `noise/module-${String(index).padStart(3, "0")}.txt`;
    return semanticDocument(
      filePath,
      `file: ${filePath}\nlanguage: unknown\nrole: source\nmodule: noise\n\nThis unrelated implementation ${operation} for ${domain}.`,
      `noise:${index}`,
      schemaVersion
    );
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? rounded(numerator / denominator, 6) : 0;
}

function rounded(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return rounded(sorted[middle] ?? 0);
  return rounded(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}
