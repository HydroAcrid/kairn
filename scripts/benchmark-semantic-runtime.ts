// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import { scoreSemanticEmbeddingIndex } from "../src/retrieval/semanticCandidates.js";
import { loadLocalEmbeddingModel } from "../src/semantic/modelRuntime.js";
import type { SemanticDocumentRecord, SemanticEmbeddingRecord } from "../src/types.js";

const options = parseArguments(process.argv.slice(2));
const initializationStarted = performance.now();
const model = await loadLocalEmbeddingModel({
  modelId: options.modelId,
  modelPath: options.modelPath
});
const coldInitializationMs = performance.now() - initializationStarted;

await model.embedQueries(["Locate the implementation that restores an expired authorization session."]);
const documentText = boundedCodeDocument(options.documentChars);
const embeddingLatencies: number[] = [];
for (let repeat = 0; repeat < options.repeats; repeat += 1) {
  const started = performance.now();
  await model.embedDocuments(Array.from({ length: options.batchSize }, () => documentText));
  embeddingLatencies.push(performance.now() - started);
}

const queryLatencies: number[] = [];
let queryVector: Float32Array | undefined;
for (let repeat = 0; repeat < Math.max(5, options.repeats); repeat += 1) {
  const started = performance.now();
  [queryVector] = await model.embedQueries([
    "Locate the implementation that restores an expired authorization session."
  ]);
  queryLatencies.push(performance.now() - started);
}
if (!queryVector) throw new Error("Semantic runtime returned no benchmark query vector.");

const scanCorpus = buildScanCorpus(options.scanDocuments, model.manifest.dimensions);
const scanLatencies: number[] = [];
for (let repeat = 0; repeat < Math.max(20, options.repeats); repeat += 1) {
  const started = performance.now();
  scoreSemanticEmbeddingIndex({
    queryVector,
    documents: scanCorpus.documents,
    embeddings: scanCorpus.embeddings,
    limit: 64
  });
  scanLatencies.push(performance.now() - started);
}

const embeddingP95Ms = percentile(embeddingLatencies, 0.95);
const report = {
  schemaVersion: "semantic-runtime-benchmark.v1",
  modelId: model.manifest.modelId,
  dimensions: model.manifest.dimensions,
  cpuThreads: process.env.KAIRN_SEMANTIC_THREADS ?? "default",
  documentChars: options.documentChars,
  batchSize: options.batchSize,
  repeats: options.repeats,
  scanDocuments: options.scanDocuments,
  coldInitializationMs: rounded(coldInitializationMs),
  warmQueryP50Ms: percentile(queryLatencies, 0.5),
  warmQueryP95Ms: percentile(queryLatencies, 0.95),
  embeddingBatchP50Ms: percentile(embeddingLatencies, 0.5),
  embeddingBatchP95Ms: embeddingP95Ms,
  projectedEmbeddingMinutesAt7500: rounded(
    (embeddingP95Ms * Math.ceil(7_500 / options.batchSize)) / 60_000,
    2
  ),
  vectorScanP50Ms: percentile(scanLatencies, 0.5),
  vectorScanP95Ms: percentile(scanLatencies, 0.95),
  gates: {
    coldInitializationAtMostFiveSeconds: coldInitializationMs <= 5_000,
    warmCandidateAtMost300Ms: percentile(queryLatencies, 0.95) + percentile(scanLatencies, 0.95) <= 300,
    vectorScanAtMost50Ms: percentile(scanLatencies, 0.95) <= 50
  }
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function parseArguments(args: string[]): {
  modelId: string;
  modelPath: string;
  documentChars: number;
  batchSize: number;
  repeats: number;
  scanDocuments: number;
} {
  const values = new Map<string, string>();
  const normalizedArgs = args.filter((value) => value !== "--");
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid semantic benchmark argument near ${key ?? "<end>"}.`);
    }
    values.set(key.slice(2), value);
  }
  const modelId = values.get("model-id");
  const modelPath = values.get("model-path");
  if (!modelId || !modelPath) throw new Error("--model-id and --model-path are required.");
  return {
    modelId,
    modelPath,
    documentChars: positiveInteger(values.get("document-chars") ?? "4000", "--document-chars"),
    batchSize: positiveInteger(values.get("batch-size") ?? "8", "--batch-size"),
    repeats: positiveInteger(values.get("repeats") ?? "3", "--repeats"),
    scanDocuments: positiveInteger(values.get("scan-documents") ?? "7500", "--scan-documents")
  };
}

function boundedCodeDocument(targetChars: number): string {
  const header = [
    "file: src/session/renewal.ts",
    "language: typescript",
    "role: source",
    "module: src/session",
    "exported symbols:",
    "function renewAuthorization(session: Session): Promise<Session>",
    "",
    "representative source:"
  ].join("\n");
  const body = [
    "export async function renewAuthorization(session: Session) {",
    "  const credentials = await exchangeRefreshCredential(session.refreshCredential);",
    "  return persistRenewedSession(credentials);",
    "}"
  ].join("\n");
  let result = header;
  while (result.length < targetChars) result += `\n${body}`;
  return result.slice(0, targetChars);
}

function buildScanCorpus(
  count: number,
  dimensions: number
): { documents: SemanticDocumentRecord[]; embeddings: SemanticEmbeddingRecord[] } {
  const documents: SemanticDocumentRecord[] = [];
  const embeddings: SemanticEmbeddingRecord[] = [];
  let state = 0x9e3779b9;
  for (let index = 0; index < count; index += 1) {
    const id = `benchmark-${index}`;
    const vector = new Int8Array(dimensions);
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
      vector[dimension] = (state & 0xff) - 127;
    }
    documents.push({
      rootPath: "/semantic-runtime-benchmark",
      id,
      filePath: `src/file-${String(index).padStart(5, "0")}.ts`,
      kind: "file",
      text: "",
      hash: id,
      tokenEstimate: 0,
      schemaVersion: "semantic-documents-v3"
    });
    embeddings.push({
      rootPath: "/semantic-runtime-benchmark",
      documentId: id,
      documentHash: id,
      modelId: "benchmark",
      schemaVersion: "semantic-documents-v3",
      dimensions,
      vector,
      scale: 1 / 127
    });
  }
  return { documents, embeddings };
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return rounded(sorted[index] ?? 0);
}

function rounded(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}
