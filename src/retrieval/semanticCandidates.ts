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
  /** Best whole-file document similarity for this query view. */
  fileSimilarity?: number;
  /** Best symbol-body document similarity for this query view. */
  symbolSimilarity?: number;
  documentIds: string[];
};

export type SemanticCandidateSearchResult = {
  hits: SemanticCandidateHit[];
  queryRankings?: SemanticCandidateHit[][];
  status: SemanticRetrieverStatus;
};

const MAX_QUERY_CHARS = 1_600;
const MAX_SEMANTIC_QUERY_CANDIDATES = 18;
const MAX_NARRATIVE_QUERY_CANDIDATES = 5;
const MAX_FENCED_QUERY_CANDIDATES = 12;
const SEMANTIC_QUERY_WINDOW_CHARS = 560;
const SEMANTIC_QUERY_WINDOW_OVERLAP_CHARS = 80;
const SEMANTIC_DIAGNOSTIC_RANK_LIMIT = 512;
const SEMANTIC_SYNOPSIS_HEADLINE_CHARS = 320;
const SEMANTIC_SYNOPSIS_NARRATIVE_CHARS = 620;
const SEMANTIC_EVIDENCE_ENDPOINT_CHARS = 720;
const MAX_SEMANTIC_CONSENSUS_RESERVE = 16;

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
    const semanticQueries = buildSemanticServingQueries(input.query);
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
export type SemanticQueryViewCandidate = {
  kind: "headline" | "narrative" | "fence";
  text: string;
  structuralIndex: number;
};

export function buildSemanticQueryCandidates(query: string): SemanticQueryViewCandidate[] {
  const unwrapped = unwrapSerializedQuery(query);
  const structuralQueries = buildEvidenceRetrievalQueries(unwrapped);
  const headline = structuralQueries[0];
  const narrative = structuralQueries[1] ?? structuralQueries.at(-1);
  const narrativeWindows = narrative
    ? boundedQueryWindows(narrative, SEMANTIC_QUERY_WINDOW_CHARS, SEMANTIC_QUERY_WINDOW_OVERLAP_CHARS)
    : [];
  const rawCandidates: SemanticQueryViewCandidate[] = [
    ...(headline ? [{
      kind: "headline" as const,
      text: headline,
      structuralIndex: 0
    }] : []),
    ...evenlySampleIncludingEndpoints(
      narrativeWindows,
      Math.min(MAX_NARRATIVE_QUERY_CANDIDATES, narrativeWindows.length)
    ).map((text, index) => ({
      kind: "narrative" as const,
      text,
      structuralIndex: index
    })),
    ...evenlySampleIncludingEndpoints(
      extractFencedBlocks(unwrapped),
      MAX_FENCED_QUERY_CANDIDATES
    )
      .map((block) => ({
        kind: "fence" as const,
        text: [
          ...(block.language ? [`language: ${block.language}`] : []),
          block.body
        ].join("\n"),
        structuralIndex: block.index
      }))
  ];
  const candidates: SemanticQueryViewCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    const text = representativeQuery(
      normalizeSemanticQuery(candidate.text),
      MAX_QUERY_CHARS
    );
    if (!text || seen.has(text)) continue;
    seen.add(text);
    candidates.push({ ...candidate, text });
    if (candidates.length >= MAX_SEMANTIC_QUERY_CANDIDATES) break;
  }
  if (candidates.length > 0) return candidates;
  return [{
    kind: "headline",
    text: representativeQuery(normalizeSemanticQuery(unwrapped), MAX_QUERY_CHARS),
    structuralIndex: 0
  }];
}

export function buildSemanticQueries(query: string): string[] {
  return buildSemanticQueryCandidates(query).map((candidate) => candidate.text);
}

/**
 * Serving uses at most three compact model queries so a broad issue template
 * cannot gain extra retrieval votes merely because it contains more sections.
 * The independent structural headline preserves concise task intent while a
 * bounded synopsis lets the model relate behavior described across multiple
 * issue sections. A separate fenced-evidence view preserves precise
 * diagnostics and reproductions. The embedding model—not task words or
 * filenames—decides relevance.
 *
 * The broader candidate/view builder remains available for offline diagnostics
 * and model-selection analysis.
 */
export function buildSemanticServingQueries(query: string): string[] {
  const candidates = buildSemanticQueryCandidates(query);
  const headline = candidates.find((candidate) => candidate.kind === "headline");
  const narratives = candidates
    .filter((candidate) => candidate.kind === "narrative")
    .slice(-2);
  const fences = candidates.filter((candidate) => candidate.kind === "fence");
  const parts = [...new Set(
    [
      headline?.text.slice(0, SEMANTIC_SYNOPSIS_HEADLINE_CHARS).trim(),
      ...narratives.map((narrative) =>
        narrative.text.slice(0, SEMANTIC_SYNOPSIS_NARRATIVE_CHARS).trim()
      )
    ].filter((value): value is string => Boolean(value))
  )];
  const synopsis = normalizeSemanticQuery(parts.join("\n\n")).slice(0, MAX_QUERY_CHARS).trim();
  const evidenceParts = evenlySampleIncludingEndpoints(
    fences,
    Math.min(2, fences.length)
  ).map((candidate) =>
    candidate.text.slice(0, SEMANTIC_EVIDENCE_ENDPOINT_CHARS).trim()
  );
  const evidenceSynopsis = normalizeSemanticQuery(
    [...new Set(evidenceParts)].join("\n\n")
  ).slice(0, MAX_QUERY_CHARS).trim();
  return [...new Set(
    [headline?.text, synopsis, evidenceSynopsis]
      .filter((value): value is string => Boolean(value))
  )].slice(0, 3);
}

export function selectSemanticQueryViewIndexes(
  candidates: SemanticQueryViewCandidate[],
  vectors: ArrayLike<number>[],
  limit = 5,
  fencedLimit = 2
): number[] {
  if (candidates.length !== vectors.length) {
    throw new Error("Semantic query candidates and vectors must have the same length.");
  }
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), candidates.length));
  const fenceIndexes = candidates
    .map((candidate, index) => candidate.kind === "fence" ? index : -1)
    .filter((index) => index >= 0);
  const selectedFenceCapacity = Math.min(
    Math.max(0, Math.floor(fencedLimit)),
    fenceIndexes.length,
    Math.max(0, boundedLimit - 1)
  );
  const anchorCapacity = Math.max(1, boundedLimit - selectedFenceCapacity);
  const headlineIndexes = candidates
    .map((candidate, index) => candidate.kind === "headline" ? index : -1)
    .filter((index) => index >= 0);
  const narrativeIndexes = candidates
    .map((candidate, index) => candidate.kind === "narrative" ? index : -1)
    .filter((index) => index >= 0);
  const selectedAnchors = uniqueIndexes([
    ...headlineIndexes.slice(0, 1),
    ...evenlySampleIncludingEndpoints(
      narrativeIndexes,
      Math.max(0, anchorCapacity - Math.min(1, headlineIndexes.length))
    )
  ]).slice(0, anchorCapacity);
  for (const index of [...headlineIndexes, ...narrativeIndexes]) {
    if (selectedAnchors.length >= anchorCapacity) break;
    if (!selectedAnchors.includes(index)) selectedAnchors.push(index);
  }
  if (selectedAnchors.length === 0) selectedAnchors.push(0);
  const selectedFences = fenceIndexes
    .map((index) => ({
      index,
      score: Math.max(
        ...selectedAnchors.map((anchorIndex) =>
          cosineSimilarity(vectors[index]!, vectors[anchorIndex]!)
        )
      )
    }))
    .sort((left, right) =>
      right.score - left.score ||
      candidates[left.index]!.structuralIndex - candidates[right.index]!.structuralIndex
    )
    .slice(0, selectedFenceCapacity)
    .map((item) => item.index);
  return uniqueIndexes([...selectedAnchors, ...selectedFences]).slice(0, boundedLimit);
}

type FencedBlock = {
  index: number;
  language?: string;
  body: string;
};

function extractFencedBlocks(value: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let active: { index: number; language?: string; lines: string[] } | undefined;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("```")) {
      if (active) active.lines.push(line);
      continue;
    }
    if (!active) {
      const language = trimmed.slice(3).trim().split(/\s+/, 1)[0];
      active = {
        index: blocks.length,
        ...(language ? { language } : {}),
        lines: []
      };
      continue;
    }
    const body = active.lines.join("\n").trim();
    if (body) {
      blocks.push({
        index: active.index,
        ...(active.language ? { language: active.language } : {}),
        body
      });
    }
    active = undefined;
  }
  return blocks;
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

function uniqueIndexes(values: number[]): number[] {
  return [...new Set(values)];
}

function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator > 0 ? dot / denominator : -1;
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
    fileSimilarity: number;
    symbolSimilarity: number;
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
        fileSimilarity: Number.NEGATIVE_INFINITY,
        symbolSimilarity: Number.NEGATIVE_INFINITY,
        documentIds: new Set<string>()
      };
      current.score += 1 / (boundedConstant + rank);
      current.bestRank = Math.min(current.bestRank, rank);
      current.similarity = Math.max(current.similarity, hit.similarity);
      current.fileSimilarity = Math.max(
        current.fileSimilarity,
        hit.fileSimilarity ?? Number.NEGATIVE_INFINITY
      );
      current.symbolSimilarity = Math.max(
        current.symbolSimilarity,
        hit.symbolSimilarity ?? Number.NEGATIVE_INFINITY
      );
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
  // Cross-view agreement is useful model evidence, but query facets are
  // alternatives: a concise headline can be precise when a long issue body is
  // noisy, and the reverse is also common. Reserve a small fixed head for RRF
  // consensus, then spend the remaining candidate budget on equal-depth facet
  // coverage. The calibrated ranker decides relevance after recall is secured.
  const consensusLimit = Math.max(
    1,
    Math.min(MAX_SEMANTIC_CONSENSUS_RESERVE, Math.floor(boundedLimit / 2))
  );
  for (const [filePath] of fused.slice(0, consensusLimit)) {
    selectedPaths.push(filePath);
    seenPaths.add(filePath);
  }
  let rank = 0;
  const maximumRankingLength = uniqueRankings.reduce(
    (maximum, ranking) => Math.max(maximum, ranking.length),
    0
  );
  // The bounded semantic lane exists to maximize recall before the calibrated
  // ranker decides relevance. Preserve equal-depth coverage from every
  // structural query view after consensus; otherwise files that are strong for
  // one precise issue facet can be crowded out by generic cross-view files.
  while (selectedPaths.length < boundedLimit && rank < maximumRankingLength) {
    for (const ranking of uniqueRankings) {
      const hit = ranking[rank];
      if (!hit || seenPaths.has(hit.path)) continue;
      selectedPaths.push(hit.path);
      seenPaths.add(hit.path);
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
      ...(Number.isFinite(value.fileSimilarity)
        ? { fileSimilarity: Number(value.fileSimilarity.toFixed(6)) }
        : {}),
      ...(Number.isFinite(value.symbolSimilarity)
        ? { symbolSimilarity: Number(value.symbolSimilarity.toFixed(6)) }
        : {}),
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
  const byFile = new Map<string, {
    path: string;
    similarity: number;
    fileSimilarity: number;
    symbolSimilarity: number;
    documentIds: string[];
  }>();
  for (const embedding of input.embeddings) {
    const document = documentsById.get(embedding.documentId);
    if (!document) continue;
    const similarity = quantizedCosineSimilarity(input.queryVector, embedding);
    const existing = byFile.get(document.filePath) ?? {
        path: document.filePath,
        similarity: Number.NEGATIVE_INFINITY,
        fileSimilarity: Number.NEGATIVE_INFINITY,
        symbolSimilarity: Number.NEGATIVE_INFINITY,
        documentIds: []
      };
    if (document.kind === "file") {
      existing.fileSimilarity = Math.max(existing.fileSimilarity, similarity);
    } else {
      existing.symbolSimilarity = Math.max(existing.symbolSimilarity, similarity);
    }
    if (similarity > existing.similarity) {
      existing.similarity = similarity;
      existing.documentIds = [document.id];
    } else if (Math.abs(similarity - existing.similarity) < 1e-9 && existing.documentIds.length < 3) {
      existing.documentIds.push(document.id);
    }
    byFile.set(document.filePath, existing);
  }
  return [...byFile.values()]
    .sort((left, right) => right.similarity - left.similarity || left.path.localeCompare(right.path))
    .slice(0, Math.max(1, Math.floor(input.limit ?? 64)))
    .map((hit) => ({
      path: hit.path,
      similarity: Number(hit.similarity.toFixed(6)),
      ...(Number.isFinite(hit.fileSimilarity)
        ? { fileSimilarity: Number(hit.fileSimilarity.toFixed(6)) }
        : {}),
      ...(Number.isFinite(hit.symbolSimilarity)
        ? { symbolSimilarity: Number(hit.symbolSimilarity.toFixed(6)) }
        : {}),
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
