// SPDX-License-Identifier: Apache-2.0

import type {
  ContextShownRecord,
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  SemanticRetrieverStatus,
  SymbolRecord
} from "../types.js";
import {
  DEFAULT_ENRICHED_CANDIDATE_LIMIT,
  DEFAULT_INITIAL_CANDIDATE_LIMIT,
  extractEvidenceTaskSignals
} from "./evidenceSignals.js";
import type { SemanticCandidateHit } from "./semanticCandidates.js";

export type CandidateRanking = {
  channel: "semantic" | "bm25" | "symbol" | "git" | "session" | "graph";
  paths: string[];
};

export type ModelCandidateUnion = {
  initialPaths: string[];
  enrichedPaths: string[];
  candidateResults: HybridScoredResult[];
  semanticStatus: SemanticRetrieverStatus;
};

export function buildModelCandidateUnion(input: {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  bm25Results: HybridScoredResult[];
  semanticHits: SemanticCandidateHit[];
  semanticStatus: SemanticRetrieverStatus;
  edges: GraphEdgeRecord[];
  changedFiles?: Set<string>;
  shown?: ContextShownRecord[];
}): ModelCandidateUnion {
  const filesByPath = new Map(input.files.map((file) => [normalizePath(file.path), file]));
  const signals = extractEvidenceTaskSignals(input.query);
  const hardPaths = uniquePaths([
    ...resolveReferencedPaths(signals.failureReferences, filesByPath),
    ...resolveReferencedPaths(signals.explicitPaths, filesByPath)
  ]);
  const hardPathSet = new Set(hardPaths);
  const eligibleNonHard = (filePath: string): boolean => {
    const normalized = normalizePath(filePath);
    return hardPathSet.has(normalized) || filesByPath.get(normalized)?.indexTier !== "tier0";
  };
  const symbolStrength = new Map<string, number>();
  for (const symbol of input.symbols) {
    const identity = normalizeIdentity(symbol.name);
    if (!identity) continue;
    let strength = 0;
    if (signals.failureIdentifiers.includes(identity)) strength = 3;
    else if (signals.preferredIdentifiers.includes(identity)) strength = 2;
    if (strength > 0) {
      symbolStrength.set(
        normalizePath(symbol.filePath),
        Math.max(symbolStrength.get(normalizePath(symbol.filePath)) ?? 0, strength)
      );
    }
  }
  const symbolPaths = [...symbolStrength.keys()].sort((left, right) =>
    (symbolStrength.get(right) ?? 0) - (symbolStrength.get(left) ?? 0) ||
    left.localeCompare(right)
  );
  const semanticPaths = input.semanticHits
    .map((hit) => normalizePath(hit.path))
    .filter(eligibleNonHard);
  const bm25Paths = [...input.bm25Results]
    .sort((left, right) => right.bm25Score - left.bm25Score || left.path.localeCompare(right.path))
    .map((result) => normalizePath(result.path))
    .filter(eligibleNonHard);
  const baseRankings: CandidateRanking[] = [
    { channel: "semantic", paths: semanticPaths },
    { channel: "bm25", paths: bm25Paths },
    { channel: "symbol", paths: symbolPaths.filter(eligibleNonHard) },
    {
      channel: "git",
      paths: [...(input.changedFiles ?? [])].map(normalizePath).filter(eligibleNonHard).sort()
    },
    {
      channel: "session",
      paths: (input.shown ?? [])
        .map((record) => record.filePath)
        .filter((filePath): filePath is string => Boolean(filePath))
        .map(normalizePath)
        .filter(eligibleNonHard)
    }
  ];
  const structuralSeeds = reciprocalRankFuse({
    hardPaths,
    rankings: baseRankings,
    limit: DEFAULT_INITIAL_CANDIDATE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath));
  const graphPaths = rankDirectGraphCandidates({
    seedPaths: structuralSeeds,
    edges: input.edges,
    semanticPaths,
    bm25Paths,
    limit: DEFAULT_INITIAL_CANDIDATE_LIMIT
  }).filter(eligibleNonHard);
  const initialPaths = reciprocalRankFuse({
    hardPaths,
    rankings: [
      ...baseRankings,
      { channel: "graph", paths: graphPaths }
    ],
    limit: DEFAULT_INITIAL_CANDIDATE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath));
  const enrichedPaths = expandDirectGraphCandidates({
    seedPaths: initialPaths,
    edges: input.edges,
    limit: DEFAULT_ENRICHED_CANDIDATE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath) && eligibleNonHard(filePath));
  const bm25ByPath = new Map(input.bm25Results.map((result) => [normalizePath(result.path), result]));
  const semanticByPath = new Map(input.semanticHits.map((hit) => [normalizePath(hit.path), hit]));
  const changedPaths = new Set([...(input.changedFiles ?? [])].map(normalizePath));
  const graphEvidence = new Set([
    ...graphPaths,
    ...enrichedPaths.filter((filePath) => !initialPaths.includes(filePath))
  ]);
  const candidateResults = enrichedPaths.map((filePath): HybridScoredResult => {
    const file = filesByPath.get(filePath)!;
    const bm25 = bm25ByPath.get(filePath);
    const semantic = semanticByPath.get(filePath);
    const reasons = [
      ...(hardPaths.includes(filePath) ? ["hard repository evidence"] : []),
      ...(semantic ? ["semantic model candidate"] : []),
      ...((bm25?.bm25Score ?? 0) > 0 ? ["BM25 candidate"] : []),
      ...(symbolStrength.has(filePath) ? ["exact symbol candidate"] : []),
      ...(changedPaths.has(filePath) ? ["changed in diff"] : []),
      ...(graphEvidence.has(filePath) ? ["direct graph neighbor"] : [])
    ];
    return {
      ...file,
      score: Number((((semantic?.similarity ?? 0) + (bm25?.bm25Score ?? 0)) * 100).toFixed(3)),
      reasons,
      ...(semantic ? { semanticSimilarity: semantic.similarity } : {}),
      semanticScore: semantic?.similarity ?? 0,
      keywordScore: 0,
      bm25Score: bm25?.bm25Score ?? 0,
      behaviorScore: 0,
      graphScore: graphEvidence.has(filePath) ? 1 : 0,
      intentScore: 0,
      sessionScore: 0,
      importanceScore: file.importance,
      gitScore: changedPaths.has(filePath) ? 1 : 0,
      chunks: []
    };
  });
  return {
    initialPaths,
    enrichedPaths,
    candidateResults,
    semanticStatus: input.semanticStatus
  };
}

export function rankDirectGraphCandidates(input: {
  seedPaths: string[];
  edges: GraphEdgeRecord[];
  semanticPaths: string[];
  bm25Paths: string[];
  limit: number;
}): string[] {
  const seedRank = rankingMap(input.seedPaths);
  const semanticRank = rankingMap(input.semanticPaths);
  const bm25Rank = rankingMap(input.bm25Paths);
  const candidates = new Map<string, {
    score: number;
    seedRank: number;
    edgePriority: number;
    semanticRank: number;
    bm25Rank: number;
  }>();
  for (const edge of input.edges) {
    const fromRank = seedRank.get(normalizePath(edge.fromFile));
    const toRank = seedRank.get(normalizePath(edge.toFile));
    const seed = fromRank !== undefined
      ? { rank: fromRank, neighbor: normalizePath(edge.toFile) }
      : toRank !== undefined
        ? { rank: toRank, neighbor: normalizePath(edge.fromFile) }
        : undefined;
    if (!seed || seedRank.has(seed.neighbor)) continue;
    const semantic = semanticRank.get(seed.neighbor) ?? Number.POSITIVE_INFINITY;
    const lexical = bm25Rank.get(seed.neighbor) ?? Number.POSITIVE_INFINITY;
    const score =
      reciprocalRankScore(seed.rank) +
      reciprocalRankScore(semantic) +
      reciprocalRankScore(lexical);
    const existing = candidates.get(seed.neighbor);
    const candidate = {
      score,
      seedRank: seed.rank,
      edgePriority: edgePriority(edge.type),
      semanticRank: semantic,
      bm25Rank: lexical
    };
    if (
      !existing ||
      candidate.score > existing.score ||
      (
        candidate.score === existing.score &&
        (
          candidate.edgePriority > existing.edgePriority ||
          (
            candidate.edgePriority === existing.edgePriority &&
            candidate.seedRank < existing.seedRank
          )
        )
      )
    ) {
      candidates.set(seed.neighbor, candidate);
    }
  }
  return [...candidates.keys()]
    .sort((left, right) => {
      const leftEvidence = candidates.get(left)!;
      const rightEvidence = candidates.get(right)!;
      return (
        rightEvidence.score - leftEvidence.score ||
        rightEvidence.edgePriority - leftEvidence.edgePriority ||
        leftEvidence.seedRank - rightEvidence.seedRank ||
        leftEvidence.semanticRank - rightEvidence.semanticRank ||
        leftEvidence.bm25Rank - rightEvidence.bm25Rank ||
        left.localeCompare(right)
      );
    })
    .slice(0, Math.max(1, Math.floor(input.limit)));
}

export function reciprocalRankFuse(input: {
  hardPaths: string[];
  rankings: CandidateRanking[];
  limit: number;
  rankConstant?: number;
}): string[] {
  const limit = Math.max(1, Math.floor(input.limit));
  const rankConstant = Math.max(1, Math.floor(input.rankConstant ?? 60));
  const selected: string[] = [];
  const selectedPaths = new Set<string>();
  for (const filePath of uniquePaths(input.hardPaths)) {
    if (selected.length >= limit) break;
    selected.push(filePath);
    selectedPaths.add(filePath);
  }

  const scores = new Map<string, number>();
  const bestRank = new Map<string, number>();
  for (const ranking of input.rankings) {
    uniquePaths(ranking.paths).forEach((filePath, index) => {
      if (selectedPaths.has(filePath)) return;
      const rank = index + 1;
      scores.set(filePath, (scores.get(filePath) ?? 0) + 1 / (rankConstant + rank));
      bestRank.set(filePath, Math.min(bestRank.get(filePath) ?? Number.POSITIVE_INFINITY, rank));
    });
  }
  const fused = [...scores.keys()].sort((left, right) =>
    (scores.get(right) ?? 0) - (scores.get(left) ?? 0) ||
    (bestRank.get(left) ?? Number.POSITIVE_INFINITY) - (bestRank.get(right) ?? Number.POSITIVE_INFINITY) ||
    left.localeCompare(right)
  );
  for (const filePath of fused) {
    if (selected.length >= limit) break;
    selected.push(filePath);
  }
  return selected;
}

function rankingMap(paths: string[]): Map<string, number> {
  return new Map(uniquePaths(paths).map((filePath, index) => [filePath, index + 1]));
}

function reciprocalRankScore(rank: number): number {
  return Number.isFinite(rank) ? 1 / (60 + rank) : 0;
}

export function expandDirectGraphCandidates(input: {
  seedPaths: string[];
  edges: GraphEdgeRecord[];
  limit: number;
}): string[] {
  const selected = uniquePaths(input.seedPaths).slice(0, input.limit);
  const selectedPaths = new Set(selected);
  if (selected.length >= input.limit) return selected;
  const queues = new Map<string, Array<{ path: string; priority: number }>>();
  for (const seed of selected) queues.set(seed, []);
  for (const edge of input.edges) {
    const priority = edgePriority(edge.type);
    if (priority === 0) continue;
    if (queues.has(edge.fromFile) && !selectedPaths.has(edge.toFile)) {
      queues.get(edge.fromFile)!.push({ path: edge.toFile, priority });
    }
    if (queues.has(edge.toFile) && !selectedPaths.has(edge.fromFile)) {
      queues.get(edge.toFile)!.push({ path: edge.fromFile, priority });
    }
  }
  for (const queue of queues.values()) {
    queue.sort((left, right) => right.priority - left.priority || left.path.localeCompare(right.path));
  }
  const cursors = new Map([...queues.keys()].map((seed) => [seed, 0]));
  let progressed = true;
  while (selected.length < input.limit && progressed) {
    progressed = false;
    for (const seed of input.seedPaths) {
      const queue = queues.get(seed) ?? [];
      let cursor = cursors.get(seed) ?? 0;
      while (cursor < queue.length && selectedPaths.has(queue[cursor]!.path)) cursor += 1;
      const next = queue[cursor];
      cursors.set(seed, cursor + 1);
      if (!next) continue;
      selected.push(next.path);
      selectedPaths.add(next.path);
      progressed = true;
      if (selected.length >= input.limit) break;
    }
  }
  return selected;
}

function edgePriority(type: GraphEdgeRecord["type"]): number {
  if (type === "test_for" || type === "tested_by") return 3;
  if (type === "definition" || type === "implementation") return 2;
  if (type === "imports" || type === "imported_by") return 1;
  return 0;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function normalizeIdentity(value: string): string {
  let output = "";
  for (const character of value.normalize("NFKC").toLowerCase()) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) output += character;
  }
  return output;
}

function resolveReferencedPaths(
  references: string[],
  filesByPath: Map<string, FileRecord>
): string[] {
  const resolved: string[] = [];
  for (const reference of references) {
    let normalized = normalizePath(reference);
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    if (filesByPath.has(normalized)) {
      resolved.push(normalized);
      continue;
    }
    const suffix = `/${normalized}`;
    for (const filePath of filesByPath.keys()) {
      if (normalized.endsWith(`/${filePath}`) || filePath.endsWith(suffix)) {
        resolved.push(filePath);
      }
    }
  }
  return uniquePaths(resolved);
}
