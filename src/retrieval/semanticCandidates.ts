// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import type {
  SemanticDocumentRecord,
  SemanticEmbeddingRecord,
  SemanticRetrieverConfig,
  SemanticRetrieverStatus
} from "../types.js";
import { getSemanticModelState } from "../semantic/modelManager.js";
import {
  loadLocalEmbeddingModel,
  quantizedCosineSimilarity
} from "../semantic/modelRuntime.js";
import { DEFAULT_SEMANTIC_MODEL_ID } from "../semantic/modelRegistry.js";

export type SemanticCandidateHit = {
  path: string;
  similarity: number;
  documentIds: string[];
};

export type SemanticCandidateSearchResult = {
  hits: SemanticCandidateHit[];
  status: SemanticRetrieverStatus;
};

const MAX_QUERY_CHARS = 4_000;
const MIN_QUERY_VIEW_CHARS = 240;
const MAX_SEMANTIC_QUERY_VIEWS = 3;

export async function searchSemanticCandidates(input: {
  query: string;
  config: SemanticRetrieverConfig;
  documents: SemanticDocumentRecord[];
  embeddings: SemanticEmbeddingRecord[];
  limit?: number;
}): Promise<SemanticCandidateSearchResult> {
  const modelId = input.config.modelId ?? DEFAULT_SEMANTIC_MODEL_ID;
  if (input.config.mode === "legacy") {
    return {
      hits: [],
      status: {
        requestedMode: "legacy",
        servedMode: "legacy",
        semanticIndexStatus: "unavailable",
        semanticFallbackReason: "Model-based candidate generation is disabled.",
        documentCount: input.documents.length,
        embeddingCount: input.embeddings.length
      }
    };
  }

  const modelState = getSemanticModelState({
    modelId,
    ...(input.config.modelPath ? { modelPath: input.config.modelPath } : {})
  });
  if (modelState.status !== "ready") {
    return unavailableResult(input, modelState.status, modelState.error, modelId);
  }

  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const eligibleEmbeddings = input.embeddings.filter((embedding) => {
    const document = documentsById.get(embedding.documentId);
    return (
      embedding.modelId === modelState.modelId &&
      embedding.schemaVersion === "semantic-documents-v3" &&
      document?.hash === embedding.documentHash
    );
  });
  if (eligibleEmbeddings.length === 0 || eligibleEmbeddings.length !== input.documents.length) {
    return unavailableResult(
      input,
      "stale_index",
      eligibleEmbeddings.length === 0
        ? "No current model embeddings are indexed."
        : `Semantic index coverage is stale (${eligibleEmbeddings.length}/${input.documents.length} documents).`,
      modelState.modelId
    );
  }

  try {
    const queryStarted = performance.now();
    const model = await loadLocalEmbeddingModel({
      modelId,
      ...(input.config.modelPath ? { modelPath: input.config.modelPath } : {})
    });
    const queryViews = buildSemanticQueryViews(input.query);
    const queryVectors = await model.embedQueries(queryViews);
    const scanStarted = performance.now();
    const hits = scoreSemanticEmbeddingIndex({
      queryVectors,
      documents: input.documents,
      embeddings: eligibleEmbeddings,
      ...(input.limit !== undefined ? { limit: input.limit } : {})
    });
    const vectorScanLatencyMs = performance.now() - scanStarted;
    return {
      hits,
      status: {
        requestedMode: input.config.mode,
        servedMode: input.config.mode,
        semanticModelId: model.manifest.modelId,
        semanticIndexStatus: "ready",
        documentCount: input.documents.length,
        embeddingCount: eligibleEmbeddings.length,
        queryViewCount: queryViews.length,
        queryLatencyMs: Number((performance.now() - queryStarted).toFixed(3)),
        vectorScanLatencyMs: Number(vectorScanLatencyMs.toFixed(3))
      }
    };
  } catch (error) {
    return unavailableResult(
      input,
      "incompatible",
      error instanceof Error ? error.message : String(error),
      modelId
    );
  }
}

export function scoreSemanticEmbeddingIndex(input: {
  queryVector?: Float32Array;
  queryVectors?: Float32Array[];
  documents: SemanticDocumentRecord[];
  embeddings: SemanticEmbeddingRecord[];
  limit?: number;
}): SemanticCandidateHit[] {
  const queryVectors = input.queryVectors ?? (input.queryVector ? [input.queryVector] : []);
  if (queryVectors.length === 0) return [];
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const byFile = new Map<string, SemanticCandidateHit>();
  for (const embedding of input.embeddings) {
    const document = documentsById.get(embedding.documentId);
    if (!document) continue;
    let similarity = Number.NEGATIVE_INFINITY;
    for (const queryVector of queryVectors) {
      similarity = Math.max(similarity, quantizedCosineSimilarity(queryVector, embedding));
    }
    const existing = byFile.get(document.filePath);
    if (!existing || similarity > existing.similarity) {
      byFile.set(document.filePath, {
        path: document.filePath,
        similarity,
        documentIds: [document.id]
      });
    } else if (Math.abs(similarity - existing.similarity) < 1e-9 && existing.documentIds.length < 3) {
      existing.documentIds.push(document.id);
    }
  }
  return [...byFile.values()]
    .sort((left, right) => right.similarity - left.similarity || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, Math.floor(input.limit ?? 64)))
    .map((hit) => ({
      ...hit,
      similarity: Number(hit.similarity.toFixed(6)),
      documentIds: [...hit.documentIds].sort()
    }));
}

/**
 * Preserve the complete task while giving long, multi-intent requests two
 * additional fixed views. The split is positional and independent of task
 * vocabulary, paths, filenames, repository identity, and benchmark labels.
 * Relevance still comes exclusively from model cosine similarity.
 */
export function buildSemanticQueryViews(query: string): string[] {
  const normalized = normalizeSemanticQuery(unwrapSerializedQuery(query)).slice(0, MAX_QUERY_CHARS);
  if (!normalized) return [""];
  if (normalized.length < MIN_QUERY_VIEW_CHARS * 2) return [normalized];

  const split = nearestWhitespace(normalized, Math.floor(normalized.length / 2));
  const first = normalized.slice(0, split).trim();
  const second = normalized.slice(split).trim();
  if (first.length < MIN_QUERY_VIEW_CHARS || second.length < MIN_QUERY_VIEW_CHARS) {
    return [normalized];
  }
  return [...new Set([normalized, first, second])].slice(0, MAX_SEMANTIC_QUERY_VIEWS);
}

function unavailableResult(
  input: {
    config: SemanticRetrieverConfig;
    documents: SemanticDocumentRecord[];
    embeddings: SemanticEmbeddingRecord[];
  },
  status: "unavailable" | "corrupt" | "incompatible" | "stale_index",
  reason: string | undefined,
  modelId: string
): SemanticCandidateSearchResult {
  return {
    hits: [],
    status: {
      requestedMode: input.config.mode,
      servedMode: "fallback",
      semanticModelId: modelId,
      semanticIndexStatus: status,
      semanticFallbackReason: reason ?? `Semantic model is ${status}.`,
      documentCount: input.documents.length,
      embeddingCount: input.embeddings.length
    }
  };
}

function unwrapSerializedQuery(query: string): string {
  let current = query.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    if (!current.startsWith("\"") || !current.endsWith("\"")) break;
    try {
      const decoded: unknown = JSON.parse(current);
      if (typeof decoded !== "string" || decoded === current) break;
      current = decoded.trim();
    } catch {
      break;
    }
  }
  return current;
}

function normalizeSemanticQuery(query: string): string {
  let output = "";
  let pendingSpace = false;
  for (const character of query.normalize("NFKC")) {
    const isWhitespace =
      character === " " ||
      character === "\n" ||
      character === "\r" ||
      character === "\t" ||
      character === "\f" ||
      character === "\v";
    if (isWhitespace) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) output += " ";
    output += character;
    pendingSpace = false;
  }
  return output.trim();
}

function nearestWhitespace(value: string, target: number): number {
  for (let distance = 0; distance < value.length; distance += 1) {
    const right = target + distance;
    if (right < value.length && value[right] === " ") return right;
    const left = target - distance;
    if (left > 0 && value[left] === " ") return left;
  }
  return target;
}
