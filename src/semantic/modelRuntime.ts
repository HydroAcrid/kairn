// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Tokenizer, type Encoding } from "@huggingface/tokenizers";
import type { InferenceSession, OnnxValue, Tensor as OrtTensor } from "onnxruntime-web";
import type { SemanticEmbeddingRecord } from "../types.js";
import {
  getSemanticModelState,
  validateLocalModelPath
} from "./modelManager.js";
import {
  DEFAULT_SEMANTIC_MODEL_ID,
  getSemanticModelManifest,
  type SemanticModelManifest
} from "./modelRegistry.js";

type OrtRuntime = typeof import("onnxruntime-web");

type LoadedOnnxModel = {
  tokenizer: Tokenizer;
  session: InferenceSession;
};

export type LocalEmbeddingModel = {
  manifest: SemanticModelManifest;
  modelPath: string;
  embedQueries(texts: string[]): Promise<Float32Array[]>;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
};

export type SemanticModelRuntimeVerification = {
  modelId: string;
  dimensions: number;
  coldInitializationMs: number;
  batchInferenceMs: number;
  maximumDeterminismDelta: number;
  maximumBatchCompositionDelta: number;
  queryNorm: number;
  relevantSimilarity: number;
  unrelatedSimilarity: number;
  passed: boolean;
};

const pipelineCache = new Map<string, Promise<LocalEmbeddingModel>>();
let ortRuntimePromise: Promise<OrtRuntime> | undefined;

export async function loadLocalEmbeddingModel(input?: {
  modelId?: string;
  modelPath?: string;
  homeDir?: string;
}): Promise<LocalEmbeddingModel> {
  const modelId = input?.modelId ?? DEFAULT_SEMANTIC_MODEL_ID;
  const state = getSemanticModelState({
    modelId,
    ...(input?.modelPath ? { modelPath: input.modelPath } : {}),
    ...(input?.homeDir ? { homeDir: input.homeDir } : {})
  });
  if (state.status !== "ready") {
    throw new Error(state.error ?? `Semantic model ${modelId} is ${state.status}.`);
  }
  const modelPath = validateLocalModelPath(state.modelPath);
  // getSemanticModelState has already verified that the installed weights and
  // tokenizer match the pinned artifact. Runtime query/document metadata must
  // come from the current release, however: an older compatible receipt can
  // legitimately name a previous document schema even though the on-disk
  // model files are byte-identical.
  const manifest = getSemanticModelManifest(modelId);
  const cacheKey = `${modelPath}\0${state.manifestSha256}`;
  const existing = pipelineCache.get(cacheKey);
  if (existing) return existing;
  const loading = createLocalEmbeddingModel(modelPath, manifest);
  pipelineCache.set(cacheKey, loading);
  try {
    return await loading;
  } catch (error) {
    pipelineCache.delete(cacheKey);
    throw error;
  }
}

export async function verifyLocalEmbeddingModel(input?: {
  modelId?: string;
  modelPath?: string;
  homeDir?: string;
}): Promise<SemanticModelRuntimeVerification> {
  const started = performance.now();
  const model = await loadLocalEmbeddingModel(input);
  const coldInitializationMs = performance.now() - started;
  const queryText = "Find the implementation that renews access after an authorization session expires.";
  const documentTexts = [
    "This function restores access by refreshing credentials after the authorization session expires.",
    "This stylesheet controls spacing and colors for the analytics dashboard."
  ];
  const inferenceStarted = performance.now();
  const [query] = await model.embedQueries([queryText]);
  const documents = await model.embedDocuments(documentTexts);
  const [repeat] = await model.embedQueries([queryText]);
  const [batchedQuery] = await model.embedQueries([
    queryText,
    "Locate the stylesheet that controls dashboard spacing and colors."
  ]);
  const [standaloneDocument] = await model.embedDocuments([documentTexts[0]!]);
  const batchInferenceMs = performance.now() - inferenceStarted;
  if (!query || !repeat || !batchedQuery || !standaloneDocument || !documents[0] || !documents[1]) {
    throw new Error(`Semantic model ${model.manifest.modelId} returned an incomplete verification batch.`);
  }
  const maximumDeterminismDelta = maximumVectorDelta(query, repeat);
  const maximumBatchCompositionDelta = Math.max(
    maximumVectorDelta(query, batchedQuery),
    maximumVectorDelta(standaloneDocument, documents[0])
  );
  const queryNorm = vectorNorm(query);
  const relevantSimilarity = floatCosineSimilarity(query, documents[0]);
  const unrelatedSimilarity = floatCosineSimilarity(query, documents[1]);
  const values = [
    coldInitializationMs,
    batchInferenceMs,
    maximumDeterminismDelta,
    maximumBatchCompositionDelta,
    queryNorm,
    relevantSimilarity,
    unrelatedSimilarity
  ];
  return {
    modelId: model.manifest.modelId,
    dimensions: query.length,
    coldInitializationMs: rounded(coldInitializationMs),
    batchInferenceMs: rounded(batchInferenceMs),
    maximumDeterminismDelta,
    maximumBatchCompositionDelta,
    queryNorm: rounded(queryNorm, 6),
    relevantSimilarity: rounded(relevantSimilarity, 6),
    unrelatedSimilarity: rounded(unrelatedSimilarity, 6),
    passed:
      query.length === model.manifest.dimensions &&
      documents.every((vector) => vector.length === model.manifest.dimensions) &&
      values.every(Number.isFinite) &&
      Math.abs(queryNorm - 1) <= 1e-4 &&
      maximumDeterminismDelta <= 1e-5 &&
      maximumBatchCompositionDelta <= 1e-5
  };
}

export function quantizeSemanticEmbedding(input: {
  rootPath: string;
  documentId: string;
  documentHash: string;
  modelId: string;
  schemaVersion: SemanticEmbeddingRecord["schemaVersion"];
  vector: Float32Array;
}): SemanticEmbeddingRecord {
  let maxAbsolute = 0;
  for (const value of input.vector) maxAbsolute = Math.max(maxAbsolute, Math.abs(value));
  const scale = maxAbsolute > 0 ? maxAbsolute / 127 : 1;
  const vector = new Int8Array(input.vector.length);
  for (let index = 0; index < input.vector.length; index += 1) {
    vector[index] = Math.max(-127, Math.min(127, Math.round((input.vector[index] ?? 0) / scale)));
  }
  return {
    rootPath: input.rootPath,
    documentId: input.documentId,
    documentHash: input.documentHash,
    modelId: input.modelId,
    schemaVersion: input.schemaVersion,
    dimensions: vector.length,
    vector,
    scale
  };
}

export function quantizedCosineSimilarity(
  query: Float32Array,
  document: Pick<SemanticEmbeddingRecord, "vector" | "scale" | "dimensions">
): number {
  const length = Math.min(query.length, document.vector.length, document.dimensions);
  if (length === 0) return 0;
  let dot = 0;
  let queryMagnitude = 0;
  let documentMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const queryValue = query[index] ?? 0;
    const documentValue = (document.vector[index] ?? 0) * document.scale;
    dot += queryValue * documentValue;
    queryMagnitude += queryValue * queryValue;
    documentMagnitude += documentValue * documentValue;
  }
  if (queryMagnitude === 0 || documentMagnitude === 0) return 0;
  return dot / Math.sqrt(queryMagnitude * documentMagnitude);
}

async function createLocalEmbeddingModel(
  modelPath: string,
  manifest: SemanticModelManifest
): Promise<LocalEmbeddingModel> {
  const loaded = await loadOnnxModel(modelPath, manifest);
  const embed = async (texts: string[], prefix: string): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];
    const ort = await getOrtRuntime();
    const vectors: Float32Array[] = [];
    // Dynamically quantized ONNX graphs can choose activation scales across
    // the complete input tensor. Running unrelated texts in one tensor then
    // makes an individual embedding depend on its batch companions even when
    // attention-mask pooling is correct. Single-row inference keeps content,
    // model, tokenizer, and document schema as the complete embedding key.
    for (const text of texts) {
      const encoded = [encodeBounded(loaded.tokenizer, `${prefix}${text}`, manifest.maxTokens)];
      const feeds = buildFeeds(ort, loaded.session.inputNames, encoded);
      const outputs = await loaded.session.run(feeds);
      const [vector] = poolAndNormalize(
        outputs,
        loaded.session.outputNames,
        encoded,
        manifest
      );
      if (!vector) {
        throw new Error(`Semantic model ${manifest.modelId} returned an incomplete embedding.`);
      }
      vectors.push(vector);
    }
    return vectors;
  };

  return {
    manifest,
    modelPath,
    embedQueries: (texts) => embed(texts, manifest.queryPrefix),
    embedDocuments: (texts) => embed(texts, manifest.documentPrefix)
  };
}

async function loadOnnxModel(
  modelPath: string,
  manifest: SemanticModelManifest
): Promise<LoadedOnnxModel> {
  const tokenizer = new Tokenizer(
    readJson(path.join(modelPath, "tokenizer.json")),
    readJson(path.join(modelPath, "tokenizer_config.json"))
  );
  const ort = await getOrtRuntime();
  const modelBytes = new Uint8Array(
    fs.readFileSync(path.join(modelPath, manifest.runtime.modelFilePath))
  );
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    enableCpuMemArena: true,
    enableMemPattern: true
  });
  if (!session.inputNames.includes("input_ids") || session.outputNames.length === 0) {
    await session.release();
    throw new Error(`Semantic model ${manifest.modelId} has an incompatible ONNX interface.`);
  }
  return { tokenizer, session };
}

async function getOrtRuntime(): Promise<OrtRuntime> {
  if (!ortRuntimePromise) {
    ortRuntimePromise = import("onnxruntime-web").then((ort) => {
      ort.env.wasm.numThreads = semanticInferenceThreads();
      ort.env.wasm.proxy = false;
      ort.env.wasm.initTimeout = 5_000;
      return ort;
    });
  }
  return ortRuntimePromise;
}

function semanticInferenceThreads(): number {
  const configured = Number(process.env.KAIRN_SEMANTIC_THREADS);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 8) return configured;
  return Math.max(1, Math.min(4, availableParallelism()));
}

function encodeBounded(tokenizer: Tokenizer, text: string, maxTokens: number): Encoding {
  const encoded = tokenizer.encode(text, {
    add_special_tokens: true,
    return_token_type_ids: true
  });
  if (encoded.ids.length <= maxTokens) return encoded;
  const ids = encoded.ids.slice(0, maxTokens);
  const attentionMask = encoded.attention_mask.slice(0, maxTokens);
  const tokenTypeIds = encoded.token_type_ids?.slice(0, maxTokens);
  const tokens = encoded.tokens.slice(0, maxTokens);
  const finalIndex = encoded.ids.length - 1;
  ids[maxTokens - 1] = encoded.ids[finalIndex] ?? ids[maxTokens - 1] ?? 0;
  tokens[maxTokens - 1] = encoded.tokens[finalIndex] ?? tokens[maxTokens - 1] ?? "";
  attentionMask[maxTokens - 1] = 1;
  if (tokenTypeIds) tokenTypeIds[maxTokens - 1] = encoded.token_type_ids?.[finalIndex] ?? 0;
  return {
    ids,
    tokens,
    attention_mask: attentionMask,
    ...(tokenTypeIds ? { token_type_ids: tokenTypeIds } : {})
  };
}

function buildFeeds(
  ort: OrtRuntime,
  inputNames: readonly string[],
  encoded: Encoding[]
): Record<string, OnnxValue> {
  const sequenceLength = Math.max(1, ...encoded.map((item) => item.ids.length));
  const size = encoded.length * sequenceLength;
  const inputIds = new BigInt64Array(size);
  const attentionMask = new BigInt64Array(size);
  const tokenTypeIds = new BigInt64Array(size);
  for (let row = 0; row < encoded.length; row += 1) {
    const item = encoded[row];
    if (!item) continue;
    for (let column = 0; column < item.ids.length; column += 1) {
      const offset = row * sequenceLength + column;
      inputIds[offset] = BigInt(item.ids[column] ?? 0);
      attentionMask[offset] = BigInt(item.attention_mask[column] ?? 1);
      tokenTypeIds[offset] = BigInt(item.token_type_ids?.[column] ?? 0);
    }
  }
  const dims = [encoded.length, sequenceLength];
  const feeds: Record<string, OnnxValue> = {};
  for (const name of inputNames) {
    if (name === "input_ids") feeds[name] = new ort.Tensor("int64", inputIds, dims);
    else if (name === "attention_mask") feeds[name] = new ort.Tensor("int64", attentionMask, dims);
    else if (name === "token_type_ids") feeds[name] = new ort.Tensor("int64", tokenTypeIds, dims);
    else throw new Error(`Semantic model requires unsupported ONNX input "${name}".`);
  }
  return feeds;
}

function poolAndNormalize(
  outputs: Record<string, OrtTensor>,
  outputNames: readonly string[],
  encoded: Encoding[],
  manifest: SemanticModelManifest
): Float32Array[] {
  const configuredOutput = manifest.runtime.outputName
    ? outputs[manifest.runtime.outputName]
    : undefined;
  if (manifest.runtime.outputName && !configuredOutput) {
    throw new Error(
      `Semantic model ${manifest.modelId} did not return configured ONNX output ` +
      `"${manifest.runtime.outputName}".`
    );
  }
  const output = configuredOutput ?? outputs.last_hidden_state ?? outputs[outputNames[0] ?? ""];
  if (!output) throw new Error(`Semantic model ${manifest.modelId} returned no ONNX output.`);
  const values = output.data;
  const dims = output.dims.map(Number);
  if (dims.length === 2 && dims[0] === encoded.length && dims[1] === manifest.dimensions) {
    return Array.from({ length: encoded.length }, (_, row) =>
      normalizedRow(values, row * manifest.dimensions, manifest.dimensions)
    );
  }
  const [batchSize, sequenceLength, dimensions] = dims;
  if (
    dims.length !== 3 ||
    batchSize !== encoded.length ||
    dimensions !== manifest.dimensions ||
    !sequenceLength
  ) {
    throw new Error(
      `Semantic model ${manifest.modelId} returned incompatible dimensions (${dims.join("x")}).`
    );
  }
  return Array.from({ length: batchSize }, (_, row) => {
    const vector = new Float32Array(dimensions);
    if (manifest.pooling === "cls") {
      const offset = row * sequenceLength * dimensions;
      for (let index = 0; index < dimensions; index += 1) {
        vector[index] = Number(values[offset + index] ?? 0);
      }
      normalizeInPlace(vector);
      return vector;
    }
    const mask = encoded[row]?.attention_mask ?? [];
    let included = 0;
    for (let token = 0; token < sequenceLength; token += 1) {
      if ((mask[token] ?? 0) === 0) continue;
      const offset = (row * sequenceLength + token) * dimensions;
      for (let index = 0; index < dimensions; index += 1) {
        vector[index] = (vector[index] ?? 0) + Number(values[offset + index] ?? 0);
      }
      included += 1;
    }
    const divisor = Math.max(1, included);
    for (let index = 0; index < dimensions; index += 1) {
      vector[index] = (vector[index] ?? 0) / divisor;
    }
    normalizeInPlace(vector);
    return vector;
  });
}

function normalizedRow(values: ArrayLike<unknown>, offset: number, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = Number(values[offset + index] ?? 0);
  }
  normalizeInPlace(vector);
  return vector;
}

function normalizeInPlace(vector: Float32Array): void {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  const divisor = Math.sqrt(magnitude);
  if (divisor === 0) return;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / divisor;
  }
}

function readJson(filePath: string): object {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as object;
}

function maximumVectorDelta(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
  }
  return maximum;
}

function vectorNorm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function floatCosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  return leftMagnitude > 0 && rightMagnitude > 0
    ? dot / Math.sqrt(leftMagnitude * rightMagnitude)
    : 0;
}

function rounded(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}
