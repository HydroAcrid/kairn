// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import type {
  SemanticDocumentRecord,
  SemanticEmbeddingRecord,
  SemanticRetrieverConfig,
  SemanticRetrieverStatus
} from "../types.js";
import { buildEvidenceRetrievalQueries } from "./evidenceSignals.js";
import { getSemanticModelState } from "../semantic/modelManager.js";
import { SEMANTIC_DOCUMENT_SCHEMA_VERSION } from "../semantic/documents.js";
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
  queryRankings?: SemanticCandidateHit[][];
  status: SemanticRetrieverStatus;
};

const MAX_QUERY_CHARS = 1_600;
const MAX_SEMANTIC_QUERY_VIEWS = 5;
const SEMANTIC_QUERY_WINDOW_CHARS = 560;
const SEMANTIC_QUERY_WINDOW_OVERLAP_CHARS = 80;
const SEMANTIC_DIAGNOSTIC_RANK_LIMIT = 512;

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
      embedding.schemaVersion === SEMANTIC_DOCUMENT_SCHEMA_VERSION &&
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
    const semanticQueries = buildSemanticQueries(input.query);
    const queryVectors = await model.embedQueries(semanticQueries);
    const scanStarted = performance.now();
    const queryRankings = queryVectors.map((queryVector) => scoreSemanticEmbeddingIndex({
        queryVector,
        documents: input.documents,
        embeddings: eligibleEmbeddings,
        limit: Math.max(
          input.limit ?? 64,
          Math.min(SEMANTIC_DIAGNOSTIC_RANK_LIMIT, input.documents.length)
        )
      }));
    const hits = fuseSemanticCandidateRankings(
      queryRankings,
      input.limit
    );
    const vectorScanLatencyMs = performance.now() - scanStarted;
    return {
      hits,
      queryRankings,
      status: {
        requestedMode: input.config.mode,
        servedMode: input.config.mode,
        semanticModelId: model.manifest.modelId,
        semanticIndexStatus: "ready",
        documentCount: input.documents.length,
        embeddingCount: eligibleEmbeddings.length,
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

/**
 * Semantic queries come from structural task cleanup, then the model decides
 * relevance. Keeping the concise task headline and the code-aware narrative
 * prevents broad failure inventories or issue templates from consuming the
 * model's complete token window.
 */
export function buildSemanticQueries(query: string): string[] {
  const unwrapped = unwrapSerializedQuery(query);
  const structuralQueries = buildEvidenceRetrievalQueries(unwrapped);
  const headline = structuralQueries[0];
  const narrative = structuralQueries[1] ?? structuralQueries.at(-1);
  const codeAware = structuralQueries.at(-1);
  const narrativeWindows = narrative
    ? boundedQueryWindows(narrative, SEMANTIC_QUERY_WINDOW_CHARS, SEMANTIC_QUERY_WINDOW_OVERLAP_CHARS)
    : [];
  const availableNarrativeViews = Math.max(0, MAX_SEMANTIC_QUERY_VIEWS - (headline ? 1 : 0));
  const selected = [
    ...(headline ? [headline] : []),
    ...evenlySampleIncludingEndpoints(narrativeWindows, availableNarrativeViews)
  ];
  if (
    codeAware &&
    codeAware !== narrative &&
    selected.length < MAX_SEMANTIC_QUERY_VIEWS
  ) {
    selected.push(codeAware);
  }
  const normalized = selected
    .map((item) => representativeQuery(normalizeSemanticQuery(item), MAX_QUERY_CHARS))
    .filter(Boolean);
  return [...new Set(normalized)].slice(0, MAX_SEMANTIC_QUERY_VIEWS).length > 0
    ? [...new Set(normalized)].slice(0, MAX_SEMANTIC_QUERY_VIEWS)
    : [representativeQuery(normalizeSemanticQuery(unwrapped), MAX_QUERY_CHARS)];
}

function boundedQueryWindows(value: string, maxChars: number, overlapChars: number): string[] {
  const normalized = normalizeSemanticQuery(value);
  if (!normalized || normalized.length <= maxChars) return normalized ? [normalized] : [];
  const windows: string[] = [];
  const boundedOverlap = Math.max(0, Math.min(overlapChars, maxChars - 1));
  let start = 0;
  while (start < normalized.length) {
    const idealEnd = Math.min(normalized.length, start + maxChars);
    const end = idealEnd < normalized.length
      ? Math.max(start + 1, normalized.lastIndexOf(" ", idealEnd))
      : normalized.length;
    windows.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    const nextIdeal = Math.max(start + 1, end - boundedOverlap);
    const nextBoundary = normalized.indexOf(" ", nextIdeal);
    start = nextBoundary >= 0 && nextBoundary < end ? nextBoundary + 1 : nextIdeal;
  }
  return windows.filter(Boolean);
}

function evenlySampleIncludingEndpoints<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= values.length) return [...values];
  if (count === 1) return [values[0]!];
  return Array.from({ length: count }, (_, index) =>
    values[Math.round((index * (values.length - 1)) / (count - 1))]!
  );
}

export function fuseSemanticCandidateRankings(
  rankings: SemanticCandidateHit[][],
  limit = 64,
  rankConstant = 60
): SemanticCandidateHit[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const boundedConstant = Math.max(1, Math.floor(rankConstant));
  const byPath = new Map<string, {
    score: number;
    bestRank: number;
    similarity: number;
    documentIds: Set<string>;
  }>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((hit, index) => {
      if (seen.has(hit.path)) return;
      seen.add(hit.path);
      const rank = index + 1;
      const current = byPath.get(hit.path) ?? {
        score: 0,
        bestRank: Number.POSITIVE_INFINITY,
        similarity: Number.NEGATIVE_INFINITY,
        documentIds: new Set<string>()
      };
      current.score += 1 / (boundedConstant + rank);
      current.bestRank = Math.min(current.bestRank, rank);
      current.similarity = Math.max(current.similarity, hit.similarity);
      hit.documentIds.forEach((documentId) => current.documentIds.add(documentId));
      byPath.set(hit.path, current);
    });
  }
  const fused = [...byPath.entries()]
    .sort(([leftPath, left], [rightPath, right]) =>
      right.score - left.score ||
      left.bestRank - right.bestRank ||
      right.similarity - left.similarity ||
      leftPath.localeCompare(rightPath)
    );
  const selectedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const uniqueRankings = rankings.map((ranking) => {
    const seen = new Set<string>();
    return ranking.filter((hit) => {
      if (seen.has(hit.path)) return false;
      seen.add(hit.path);
      return true;
    });
  });
  let rank = 0;
  let madeProgress = true;
  // The bounded semantic lane exists to maximize recall before the calibrated
  // ranker decides relevance. Preserve equal-depth coverage from every
  // structural query view; otherwise files that are strong for one precise
  // issue facet can be crowded out by generic files appearing in every view.
  while (selectedPaths.length < boundedLimit && madeProgress) {
    madeProgress = false;
    for (const ranking of uniqueRankings) {
      const hit = ranking[rank];
      if (!hit || seenPaths.has(hit.path)) continue;
      selectedPaths.push(hit.path);
      seenPaths.add(hit.path);
      madeProgress = true;
      if (selectedPaths.length >= boundedLimit) break;
    }
    rank += 1;
  }
  for (const [filePath] of fused) {
    if (selectedPaths.length >= boundedLimit) break;
    if (seenPaths.has(filePath)) continue;
    selectedPaths.push(filePath);
    seenPaths.add(filePath);
  }
  const selectedOrder = new Map(selectedPaths.map((filePath, index) => [filePath, index]));
  return fused
    .filter(([filePath]) => selectedOrder.has(filePath))
    .sort(([leftPath], [rightPath]) =>
      (selectedOrder.get(leftPath) ?? Number.POSITIVE_INFINITY) -
      (selectedOrder.get(rightPath) ?? Number.POSITIVE_INFINITY)
    )
    .map(([filePath, value]) => ({
      path: filePath,
      similarity: Number(value.similarity.toFixed(6)),
      documentIds: [...value.documentIds].sort().slice(0, 6)
    }));
}

export function scoreSemanticEmbeddingIndex(input: {
  queryVector: Float32Array;
  documents: SemanticDocumentRecord[];
  embeddings: SemanticEmbeddingRecord[];
  limit?: number;
}): SemanticCandidateHit[] {
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const byFile = new Map<string, SemanticCandidateHit>();
  for (const embedding of input.embeddings) {
    const document = documentsById.get(embedding.documentId);
    if (!document) continue;
    const similarity = quantizedCosineSimilarity(input.queryVector, embedding);
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

function representativeQuery(query: string, maxChars: number): string {
  if (query.length <= maxChars) return query;
  const separator = " […] ";
  const sectionCount = 3;
  const available = maxChars - separator.length * (sectionCount - 1);
  const sectionSize = Math.max(1, Math.floor(available / sectionCount));
  const starts = [
    0,
    Math.max(0, Math.floor((query.length - sectionSize) / 2)),
    Math.max(0, query.length - sectionSize)
  ];
  return starts.map((start) => query.slice(start, start + sectionSize)).join(separator);
}
