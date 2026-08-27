// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export type SnapshotCatalogEntry = {
  databasePath: string;
  manifestPath: string;
  cacheKey: string;
  sourceRootPath: string;
  databaseSha256: string;
};

export type CrossEncoderCandidateScore = {
  path: string;
  logit: number;
  probability: number;
  documentCount: number;
  documentHashes: string[];
  documentSource: "semantic_documents_v5" | "objective_metadata_fallback";
  selectedDocumentKind: "file" | "symbol" | null;
  selectedDocumentSymbol: string | null;
  semanticSelectorSimilarity: number | null;
  inFrozenPool: boolean;
  exactPath: number;
  failureReference: number;
  generatedVendor: number;
};

export function repositorySnapshotPrefix(repositoryUrl: string, repositoryRef: string): string {
  return `${sha256(repositoryUrl).slice(0, 24)}-${repositoryRef.slice(0, 12)}-`;
}

export function selectFrozenSnapshot(input: {
  catalog: SnapshotCatalogEntry[];
  expectedCacheKey: string;
}): SnapshotCatalogEntry {
  const matches = input.catalog.filter((entry) => entry.cacheKey === input.expectedCacheKey);
  if (matches.length !== 1) {
    throw new Error(
      `Frozen repository snapshot mapping for cache key ${input.expectedCacheKey} produced ` +
      `${matches.length} matches; expected exactly one.`
    );
  }
  return matches[0]!;
}

export function repositoryIndexSnapshotCacheKey(input: {
  repositoryLineageId: string;
  repositoryRef: string;
  modelManifestSha256: string;
  implementationSha256: string;
}): string {
  return sha256([
    "repository-index-snapshot.v2",
    input.repositoryLineageId,
    input.repositoryRef,
    input.modelManifestSha256,
    "semantic-documents-v5",
    "semantic",
    input.implementationSha256
  ].join("\0"));
}

export function collapseCrossEncoderDocumentScores(input: {
  path: string;
  documents: Array<{
    hash: string;
    logit: number;
    kind?: "file" | "symbol";
    symbol?: string | null;
    selectorSimilarity?: number;
  }>;
  fallbackLogit: number;
  probability: (logit: number) => number;
  exactPath: number;
  failureReference: number;
  generatedVendor: number;
  inFrozenPool?: boolean;
}): CrossEncoderCandidateScore {
  const source = input.documents.length > 0
    ? input.documents
    : [{ hash: sha256(`objective-metadata-fallback\0${input.path}`), logit: input.fallbackLogit }];
  const logit = Math.max(...source.map((document) => document.logit));
  return {
    path: input.path,
    logit,
    probability: input.probability(logit),
    documentCount: source.length,
    documentHashes: source.map((document) => document.hash).sort(),
    documentSource: input.documents.length > 0
      ? "semantic_documents_v5"
      : "objective_metadata_fallback",
    selectedDocumentKind: input.documents[0]?.kind ?? null,
    selectedDocumentSymbol: input.documents[0]?.symbol ?? null,
    semanticSelectorSimilarity: input.documents[0]?.selectorSimilarity ?? null,
    inFrozenPool: input.inFrozenPool ?? true,
    exactPath: input.exactPath,
    failureReference: input.failureReference,
    generatedVendor: input.generatedVendor
  };
}

export function rankCrossEncoderCandidates(
  candidates: CrossEncoderCandidateScore[]
): CrossEncoderCandidateScore[] {
  return candidates.slice().sort((left, right) =>
    hardPriority(right) - hardPriority(left) ||
    right.logit - left.logit ||
    left.path.localeCompare(right.path)
  );
}

export function appendMissingLabeledCandidates<T extends { path: string }>(
  frozenPool: T[],
  labeledCandidates: Map<string, T>
): T[] {
  const frozenPaths = new Set(frozenPool.map((candidate) => candidate.path));
  const additional = [...labeledCandidates.values()]
    .filter((candidate) => !frozenPaths.has(candidate.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  return [...frozenPool, ...additional];
}

function hardPriority(candidate: CrossEncoderCandidateScore): number {
  if (candidate.failureReference > 0) return 2;
  if (candidate.exactPath > 0) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
