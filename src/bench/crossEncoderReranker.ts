// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Tokenizer, type Encoding } from "@huggingface/tokenizers";
import type { InferenceSession, OnnxValue, Tensor as OrtTensor } from "onnxruntime-web";

type OrtRuntime = typeof import("onnxruntime-web");

export type CrossEncoderModelFile = {
  remotePath: string;
  localPath: string;
  bytes: number;
  sha256: string;
};

export type CrossEncoderModelManifest = {
  formatVersion: 1;
  modelId: string;
  upstreamRepository: string;
  upstreamRevision: string;
  license: string;
  maxTokens: number;
  queryTokenBudget: number;
  documentTokenBudget: number;
  runtime: {
    library: "kairn-onnx-wasm-cross-encoder-v1";
    modelFilePath: "onnx/model.onnx";
    outputName: "logits";
  };
  files: CrossEncoderModelFile[];
};

export type CrossEncoderModelState = {
  modelId: string;
  modelPath: string;
  status: "unavailable" | "corrupt" | "incompatible" | "ready";
  totalBytes: number;
  manifestSha256: string;
  error?: string;
};

export type CrossEncoderPair = {
  query: string;
  document: string;
};

export type LocalCrossEncoder = {
  manifest: CrossEncoderModelManifest;
  modelPath: string;
  score(pairs: CrossEncoderPair[]): Promise<number[]>;
  close(): Promise<void>;
};

export type CrossEncoderRuntimeVerification = {
  modelId: string;
  coldInitializationMs: number;
  inferenceMs: number;
  relevantScore: number;
  unrelatedScore: number;
  maximumDeterminismDelta: number;
  maximumBatchCompositionDelta: number;
  passed: boolean;
};

export const JINA_TINY_CROSS_ENCODER: CrossEncoderModelManifest = {
  formatVersion: 1,
  modelId: "jina-reranker-v1-tiny-en-q8",
  upstreamRepository: "jinaai/jina-reranker-v1-tiny-en",
  upstreamRevision: "1e1d77a66362c3ed4fce2fb290028a39553c8d13",
  license: "Apache-2.0",
  maxTokens: 512,
  queryTokenBudget: 160,
  documentTokenBudget: 344,
  runtime: {
    library: "kairn-onnx-wasm-cross-encoder-v1",
    modelFilePath: "onnx/model.onnx",
    outputName: "logits"
  },
  files: [
    {
      remotePath: "config.json",
      localPath: "config.json",
      bytes: 1_206,
      sha256: "dc70646aa6c9e75e3c513cc9c037f35ad54308001c3961d45c0f69749bcfb022"
    },
    {
      remotePath: "tokenizer.json",
      localPath: "tokenizer.json",
      bytes: 2_030_772,
      sha256: "0046da43cc8c424b317f56b092b0512aaaa65c4f925d2f16af9d9eeb4d0ef902"
    },
    {
      remotePath: "tokenizer_config.json",
      localPath: "tokenizer_config.json",
      bytes: 1_215,
      sha256: "d291c6652d96d56ffdbcf1ea19d9bae5ed79003f7648c627e725a619227ce8fa"
    },
    {
      remotePath: "onnx/model_quantized.onnx",
      localPath: "onnx/model.onnx",
      bytes: 33_424_854,
      sha256: "5fa8508528828b4ad9bc97c97b6e020984e3b745fbcb53f0a907e68704f8a18a"
    }
  ]
};

const loadedModels = new Map<string, Promise<LocalCrossEncoder>>();
let ortRuntimePromise: Promise<OrtRuntime> | undefined;

export function defaultCrossEncoderModelPath(homeDir = os.homedir()): string {
  const explicit = process.env.KAIRN_CROSS_ENCODER_HOME?.trim();
  const root = explicit
    ? path.resolve(explicit)
    : path.join(path.resolve(homeDir), ".cache", "kairn-reranker-eval");
  return path.join(root, JINA_TINY_CROSS_ENCODER.modelId.replace(/[^a-z0-9._-]+/gi, "-"));
}

export function crossEncoderManifestSha256(
  manifest: CrossEncoderModelManifest = JINA_TINY_CROSS_ENCODER
): string {
  return sha256(Buffer.from(stableJson(manifest), "utf8"));
}

export function crossEncoderModelDownloadUrl(
  file: CrossEncoderModelFile,
  manifest: CrossEncoderModelManifest = JINA_TINY_CROSS_ENCODER
): string {
  return `https://huggingface.co/${manifest.upstreamRepository}/resolve/${manifest.upstreamRevision}/${file.remotePath}`;
}

export function verifyCrossEncoderModelFiles(
  modelPath: string,
  manifest: CrossEncoderModelManifest = JINA_TINY_CROSS_ENCODER
): CrossEncoderModelState {
  const resolved = validateLocalModelPath(modelPath);
  const manifestSha256 = crossEncoderManifestSha256(manifest);
  if (!fs.existsSync(resolved)) {
    return {
      modelId: manifest.modelId,
      modelPath: resolved,
      status: "unavailable",
      totalBytes: 0,
      manifestSha256,
      error: "The local cross-encoder model is not installed."
    };
  }
  try {
    validateManifest(manifest);
    let totalBytes = 0;
    for (const file of manifest.files) {
      const target = resolveWithin(resolved, file.localPath);
      if (!fs.existsSync(target)) throw new Error(`Missing ${file.localPath}.`);
      const bytes = fs.readFileSync(target);
      if (bytes.length !== file.bytes) {
        throw new Error(`${file.localPath} has ${bytes.length} bytes; expected ${file.bytes}.`);
      }
      if (sha256(bytes) !== file.sha256) {
        throw new Error(`${file.localPath} does not match its pinned SHA-256.`);
      }
      totalBytes += bytes.length;
    }
    return {
      modelId: manifest.modelId,
      modelPath: resolved,
      status: "ready",
      totalBytes,
      manifestSha256
    };
  } catch (error) {
    return {
      modelId: manifest.modelId,
      modelPath: resolved,
      status: isCompatibilityError(error) ? "incompatible" : "corrupt",
      totalBytes: directorySize(resolved),
      manifestSha256,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function installCrossEncoderModel(input?: {
  modelPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<CrossEncoderModelState> {
  const manifest = JINA_TINY_CROSS_ENCODER;
  const modelPath = validateLocalModelPath(input?.modelPath ?? defaultCrossEncoderModelPath());
  const ready = verifyCrossEncoderModelFiles(modelPath, manifest);
  if (ready.status === "ready") return ready;
  const fetchImpl = input?.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("This Node runtime does not provide fetch.");
  const parent = path.dirname(modelPath);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(parent, `.${path.basename(modelPath)}.partial-${randomUUID()}`);
  fs.mkdirSync(stage, { recursive: false });
  try {
    for (const file of manifest.files) {
      const response = await fetchImpl(crossEncoderModelDownloadUrl(file, manifest));
      if (!response.ok) {
        throw new Error(`Failed to download ${file.remotePath}: HTTP ${response.status}.`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`Downloaded ${file.remotePath} failed its pinned size or SHA-256 check.`);
      }
      const target = resolveWithin(stage, file.localPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
    }
    const staged = verifyCrossEncoderModelFiles(stage, manifest);
    if (staged.status !== "ready") throw new Error(staged.error ?? "Staged model is invalid.");
    const backup = fs.existsSync(modelPath)
      ? path.join(parent, `.${path.basename(modelPath)}.backup-${randomUUID()}`)
      : undefined;
    if (backup) fs.renameSync(modelPath, backup);
    try {
      fs.renameSync(stage, modelPath);
      if (backup) removeWithin(parent, backup);
    } catch (error) {
      if (!fs.existsSync(modelPath) && backup && fs.existsSync(backup)) fs.renameSync(backup, modelPath);
      throw error;
    }
    return verifyCrossEncoderModelFiles(modelPath, manifest);
  } finally {
    if (fs.existsSync(stage)) removeWithin(parent, stage);
  }
}

export async function loadLocalCrossEncoder(input?: {
  modelPath?: string;
}): Promise<LocalCrossEncoder> {
  const modelPath = validateLocalModelPath(input?.modelPath ?? defaultCrossEncoderModelPath());
  const state = verifyCrossEncoderModelFiles(modelPath);
  if (state.status !== "ready") throw new Error(state.error ?? `Cross-encoder is ${state.status}.`);
  const key = `${modelPath}\0${state.manifestSha256}`;
  const cached = loadedModels.get(key);
  if (cached) return cached;
  const loading = createLocalCrossEncoder(modelPath, JINA_TINY_CROSS_ENCODER);
  loadedModels.set(key, loading);
  try {
    return await loading;
  } catch (error) {
    loadedModels.delete(key);
    throw error;
  }
}

export async function verifyCrossEncoderRuntime(input?: {
  modelPath?: string;
}): Promise<CrossEncoderRuntimeVerification> {
  const started = performance.now();
  const model = await loadLocalCrossEncoder(input);
  const coldInitializationMs = performance.now() - started;
  const query = "Where is expired authorization access refreshed?";
  const relevant = "file: src/auth/session.ts\nfunction refreshCredentials() renews access after an authorization session expires.";
  const unrelated = "file: src/styles/dashboard.css\nControls spacing and colors for the analytics dashboard.";
  const inferenceStarted = performance.now();
  const [relevantScore, unrelatedScore] = await model.score([
    { query, document: relevant },
    { query, document: unrelated }
  ]);
  const [repeatScore] = await model.score([{ query, document: relevant }]);
  const [batchedScore] = await model.score([
    { query, document: relevant },
    { query: "Where is dashboard spacing defined?", document: unrelated }
  ]);
  const inferenceMs = performance.now() - inferenceStarted;
  const maximumDeterminismDelta = Math.abs((relevantScore ?? 0) - (repeatScore ?? 0));
  const maximumBatchCompositionDelta = Math.abs((relevantScore ?? 0) - (batchedScore ?? 0));
  return {
    modelId: model.manifest.modelId,
    coldInitializationMs: rounded(coldInitializationMs),
    inferenceMs: rounded(inferenceMs),
    relevantScore: rounded(relevantScore ?? Number.NaN, 6),
    unrelatedScore: rounded(unrelatedScore ?? Number.NaN, 6),
    maximumDeterminismDelta: rounded(maximumDeterminismDelta, 8),
    maximumBatchCompositionDelta: rounded(maximumBatchCompositionDelta, 8),
    passed:
      [relevantScore, unrelatedScore, repeatScore, batchedScore].every(Number.isFinite) &&
      (relevantScore ?? Number.NEGATIVE_INFINITY) > (unrelatedScore ?? Number.POSITIVE_INFINITY) &&
      maximumDeterminismDelta <= 1e-5 &&
      maximumBatchCompositionDelta <= 1e-4
  };
}

export function normalizeCrossEncoderScore(logit: number): number {
  if (logit >= 0) return 1 / (1 + Math.exp(-logit));
  const exponent = Math.exp(logit);
  return exponent / (1 + exponent);
}

async function createLocalCrossEncoder(
  modelPath: string,
  manifest: CrossEncoderModelManifest
): Promise<LocalCrossEncoder> {
  const tokenizer = new Tokenizer(
    readJson(path.join(modelPath, "tokenizer.json")),
    readJson(path.join(modelPath, "tokenizer_config.json"))
  );
  const ort = await getOrtRuntime();
  const modelBytes = new Uint8Array(fs.readFileSync(path.join(modelPath, manifest.runtime.modelFilePath)));
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ["wasm"],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    enableCpuMemArena: true,
    enableMemPattern: true
  });
  if (
    !session.inputNames.includes("input_ids") ||
    !session.inputNames.includes("attention_mask") ||
    !session.outputNames.includes(manifest.runtime.outputName)
  ) {
    await session.release();
    throw new Error(`Cross-encoder ${manifest.modelId} has an incompatible ONNX interface.`);
  }
  return {
    manifest,
    modelPath,
    async score(pairs) {
      const scores: number[] = [];
      // The pinned dynamically quantized graph can select activation scales
      // over the complete input tensor. Isolated rows keep a score dependent
      // only on the query, document, tokenizer, and model artifact rather than
      // on unrelated batch companions.
      for (const pair of pairs) {
        const encoded = [encodePairBounded(tokenizer, pair, manifest)];
        const outputs = await session.run(buildFeeds(ort, session, encoded));
        scores.push(...readLogits(outputs, manifest.runtime.outputName, 1));
      }
      return scores;
    },
    async close() {
      loadedModels.delete(`${modelPath}\0${crossEncoderManifestSha256(manifest)}`);
      await session.release();
    }
  };
}

function encodePairBounded(
  tokenizer: Tokenizer,
  pair: CrossEncoderPair,
  manifest: CrossEncoderModelManifest
): Encoding {
  const query = truncateToTokens(tokenizer, pair.query, manifest.queryTokenBudget);
  let documentBudget = manifest.documentTokenBudget;
  let document = truncateToTokens(tokenizer, pair.document, documentBudget);
  let encoded = tokenizer.encode(query, {
    text_pair: document,
    add_special_tokens: true,
    return_token_type_ids: true
  });
  while (encoded.ids.length > manifest.maxTokens && documentBudget > 1) {
    documentBudget = Math.max(1, documentBudget - (encoded.ids.length - manifest.maxTokens));
    document = truncateToTokens(tokenizer, pair.document, documentBudget);
    encoded = tokenizer.encode(query, {
      text_pair: document,
      add_special_tokens: true,
      return_token_type_ids: true
    });
  }
  if (encoded.ids.length > manifest.maxTokens) {
    throw new Error(`Cross-encoder pair could not be bounded to ${manifest.maxTokens} tokens.`);
  }
  return encoded;
}

function truncateToTokens(tokenizer: Tokenizer, text: string, limit: number): string {
  const encoded = tokenizer.encode(text, { add_special_tokens: false });
  if (encoded.ids.length <= limit) return text;
  return tokenizer.decode(encoded.ids.slice(0, limit), { skip_special_tokens: true });
}

function buildFeeds(
  ort: OrtRuntime,
  session: InferenceSession,
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
      const position = row * sequenceLength + column;
      inputIds[position] = BigInt(item.ids[column] ?? 0);
      attentionMask[position] = BigInt(item.attention_mask[column] ?? 1);
      tokenTypeIds[position] = BigInt(item.token_type_ids?.[column] ?? 0);
    }
  }
  const dimensions = [encoded.length, sequenceLength];
  const feeds: Record<string, OnnxValue> = {};
  for (const name of session.inputNames) {
    if (name === "input_ids") feeds[name] = new ort.Tensor("int64", inputIds, dimensions);
    else if (name === "attention_mask") feeds[name] = new ort.Tensor("int64", attentionMask, dimensions);
    else if (name === "token_type_ids") feeds[name] = new ort.Tensor("int64", tokenTypeIds, dimensions);
    else throw new Error(`Cross-encoder requires unsupported ONNX input "${name}".`);
  }
  return feeds;
}

function readLogits(outputs: Record<string, OrtTensor>, outputName: string, batchSize: number): number[] {
  const output = outputs[outputName];
  if (!output) throw new Error(`Cross-encoder did not return ONNX output "${outputName}".`);
  const dimensions = output.dims.map(Number);
  if (dimensions.length !== 2 || dimensions[0] !== batchSize || dimensions[1] !== 1) {
    throw new Error(`Cross-encoder returned incompatible output dimensions ${dimensions.join("x")}.`);
  }
  return Array.from({ length: batchSize }, (_, index) => Number(output.data[index]));
}

async function getOrtRuntime(): Promise<OrtRuntime> {
  if (!ortRuntimePromise) {
    ortRuntimePromise = import("onnxruntime-web").then((ort) => {
      const configured = Number(process.env.KAIRN_CROSS_ENCODER_THREADS);
      ort.env.wasm.numThreads = Number.isInteger(configured) && configured >= 1 && configured <= 8
        ? configured
        : Math.max(1, Math.min(4, os.availableParallelism()));
      ort.env.wasm.proxy = false;
      ort.env.wasm.initTimeout = 5_000;
      return ort;
    });
  }
  return ortRuntimePromise;
}

function validateManifest(manifest: CrossEncoderModelManifest): void {
  if (
    manifest.formatVersion !== 1 ||
    !manifest.modelId ||
    !/^[0-9a-f]{40}$/i.test(manifest.upstreamRevision) ||
    manifest.license !== "Apache-2.0" ||
    manifest.maxTokens < 1 ||
    manifest.queryTokenBudget + manifest.documentTokenBudget > manifest.maxTokens ||
    manifest.runtime.library !== "kairn-onnx-wasm-cross-encoder-v1" ||
    manifest.runtime.modelFilePath !== "onnx/model.onnx" ||
    manifest.runtime.outputName !== "logits" ||
    manifest.files.length === 0
  ) {
    throw new Error("The cross-encoder manifest is incompatible with this benchmark runtime.");
  }
  for (const file of manifest.files) {
    if (
      !file.remotePath ||
      !file.localPath ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[0-9a-f]{64}$/i.test(file.sha256)
    ) {
      throw new Error("The cross-encoder file manifest is invalid.");
    }
  }
}

function validateLocalModelPath(modelPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(modelPath)) {
    throw new Error("Cross-encoder modelPath must be a local filesystem path.");
  }
  return path.resolve(modelPath);
}

function resolveWithin(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Cross-encoder artifact path escapes its model directory: ${relative}`);
  }
  return target;
}

function removeWithin(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Refusing to remove a path outside the cross-encoder cache root.");
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function directorySize(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function isCompatibilityError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("incompatible");
}

function readJson(filePath: string): object {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as object;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rounded(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}
