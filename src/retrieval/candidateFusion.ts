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
  extractEvidenceTaskSignals,
  isProductionEvidenceFile
} from "./evidenceSignals.js";
import type { SemanticCandidateHit } from "./semanticCandidates.js";

export type CandidateRanking = {
  channel: "semantic" | "bm25" | "symbol" | "git" | "session" | "graph" | "graph_consensus";
  paths: string[];
};

export type ModelCandidateUnion = {
  initialPaths: string[];
  enrichedPaths: string[];
  candidateResults: HybridScoredResult[];
  semanticStatus: SemanticRetrieverStatus;
  graphPaths: string[];
  graphConsensusPaths: string[];
  graphSeedPaths: string[];
};

/**
 * Internal retrieval breadth used only to obtain model-backed graph probes.
 * Public candidate delivery remains bounded at 64 initial and 128 enriched
 * files. A broader probe pool lets precise parser facts validate semantic
 * candidates that would otherwise be discarded before graph enrichment.
 */
export const MODEL_RETRIEVAL_PROBE_LIMIT = 512;
const MAX_TEST_GRAPH_PROBE_PATHS = 192;

export function buildModelCandidateUnion(input: {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  bm25Results: HybridScoredResult[];
  semanticHits: SemanticCandidateHit[];
  semanticEvidencePaths?: string[];
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
  const semanticEvidencePaths = uniquePaths(
    input.semanticEvidencePaths ?? semanticPaths
  ).filter(eligibleNonHard);
  const bm25Paths = [...input.bm25Results]
    .filter((result) => result.bm25Score > 0)
    .sort((left, right) => right.bm25Score - left.bm25Score || left.path.localeCompare(right.path))
    .map((result) => normalizePath(result.path))
    .filter(eligibleNonHard);
  const eligibleSymbolPaths = symbolPaths.filter(eligibleNonHard);
  const baseRankings: CandidateRanking[] = [
    { channel: "semantic", paths: semanticPaths },
    { channel: "bm25", paths: bm25Paths },
    { channel: "symbol", paths: eligibleSymbolPaths },
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
  const preliminaryUnion = reciprocalRankFuse({
    hardPaths,
    rankings: baseRankings,
    limit: MODEL_RETRIEVAL_PROBE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath));
  const initialPaths = preliminaryUnion.slice(0, DEFAULT_INITIAL_CANDIDATE_LIMIT);
  const graphProbePaths = signals.intent === "source"
    ? uniquePaths([
        ...semanticEvidencePaths
          .filter((filePath) =>
            !initialPaths.includes(filePath) &&
            filesByPath.get(filePath)?.kind === "test"
          )
          .slice(0, MAX_TEST_GRAPH_PROBE_PATHS),
        ...semanticEvidencePaths
          .filter((filePath) => {
            const file = filesByPath.get(filePath);
            return Boolean(
              !initialPaths.includes(filePath) &&
              file &&
              isProductionEvidenceFile(file)
            );
          })
      ])
        .filter((filePath) => !initialPaths.includes(filePath))
        .slice(0, MODEL_RETRIEVAL_PROBE_LIMIT - initialPaths.length)
    : [];
  const graphSeedPaths = uniquePaths([...initialPaths, ...graphProbePaths]);
  const graphPaths = prioritizeGraphPathsForIntent(
    rankEvidenceBackedGraphCandidates({
      seedPaths: initialPaths,
      probeSeedPaths: graphProbePaths,
      edges: input.edges,
      filesByPath,
      evidenceRankings: [
        { channel: "semantic", paths: semanticEvidencePaths },
        { channel: "bm25", paths: bm25Paths },
        { channel: "symbol", paths: eligibleSymbolPaths }
      ]
    }),
    signals.intent,
    filesByPath
  );
  const graphConsensusPaths = prioritizeGraphPathsForIntent(
    rankEvidenceBackedGraphCandidates({
      seedPaths: initialPaths,
      probeSeedPaths: graphProbePaths,
      edges: input.edges,
      filesByPath,
      evidenceRankings: [
        { channel: "semantic", paths: semanticEvidencePaths },
        { channel: "bm25", paths: bm25Paths },
        { channel: "symbol", paths: eligibleSymbolPaths }
      ],
      minimumSeedSupport: 2
    }),
    signals.intent,
    filesByPath
  );
  const graphEnrichedOrder = reciprocalRankFuse({
    hardPaths,
    rankings: graphPaths.length > 0
      ? [
          ...baseRankings,
          { channel: "graph", paths: graphPaths },
          ...(graphConsensusPaths.length > 0
            ? [{ channel: "graph_consensus" as const, paths: graphConsensusPaths }]
            : [])
        ]
      : baseRankings,
    limit: DEFAULT_ENRICHED_CANDIDATE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath));
  // Graph relations enrich the bounded union; they do not get to evict
  // independently retrieved evidence from the initial 64-file lane. Preserve
  // that serving contract, then fill the remaining bounded capacity with the
  // one-hop additions supported by multiple independent seeds before the
  // broader graph ranking and retrieval tail. Putting the consensus lane
  // after its own superset would make it observationally inert.
  // The calibrated ranker therefore sees the intended 64 initial + up to 64
  // graph-enriched candidates without a second fusion silently dropping a
  // parser-proven neighbor.
  const enrichedPaths = uniquePaths([
    ...initialPaths,
    ...graphConsensusPaths,
    ...graphPaths,
    ...graphEnrichedOrder,
    ...preliminaryUnion
  ]).slice(0, DEFAULT_ENRICHED_CANDIDATE_LIMIT);
  const bm25ByPath = new Map(input.bm25Results.map((result) => [normalizePath(result.path), result]));
  const semanticByPath = new Map(input.semanticHits.map((hit) => [normalizePath(hit.path), hit]));
  const changedPaths = new Set([...(input.changedFiles ?? [])].map(normalizePath));
  const graphPathSet = new Set([...graphPaths, ...graphConsensusPaths]);
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
      ...(graphPathSet.has(filePath) ? ["direct graph neighbor"] : [])
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
      graphScore: graphPathSet.has(filePath) ? 1 : 0,
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
    semanticStatus: input.semanticStatus,
    graphPaths,
    graphConsensusPaths,
    graphSeedPaths
  };
}

function prioritizeGraphPathsForIntent(
  paths: string[],
  intent: ReturnType<typeof extractEvidenceTaskSignals>["intent"],
  filesByPath: Map<string, FileRecord>
): string[] {
  if (intent !== "source") return paths;
  const production: string[] = [];
  const companions: string[] = [];
  for (const filePath of paths) {
    const file = filesByPath.get(filePath);
    if (file && isProductionEvidenceFile(file)) production.push(filePath);
    else companions.push(filePath);
  }
  return [...production, ...companions];
}

/**
 * Produces a bounded graph ranking without turning arbitrary import fan-out
 * into relevance. Precise source/test and definition edges stand on their own.
 * Import neighbors must be production files that also appear in an independent
 * semantic, lexical, or exact-symbol ranking.
 */
export function rankEvidenceBackedGraphCandidates(input: {
  seedPaths: string[];
  probeSeedPaths?: string[];
  edges: GraphEdgeRecord[];
  filesByPath: Map<string, FileRecord>;
  evidenceRankings: CandidateRanking[];
  minimumSeedSupport?: number;
}): string[] {
  const primarySeeds = uniquePaths(input.seedPaths);
  const primarySeedSet = new Set(primarySeeds);
  const probeSeeds = uniquePaths(input.probeSeedPaths ?? []).filter(
    (filePath) => !primarySeeds.includes(filePath)
  );
  const seedRanks = new Map(
    [...primarySeeds, ...probeSeeds].map((filePath, index) => [filePath, index + 1])
  );
  const probeSeedSet = new Set(probeSeeds);
  const evidenceRanks = new Map<string, Map<CandidateRanking["channel"], number>>();
  for (const ranking of input.evidenceRankings) {
    uniquePaths(ranking.paths).forEach((filePath, index) => {
      const channelRanks = evidenceRanks.get(filePath) ?? new Map<CandidateRanking["channel"], number>();
      channelRanks.set(ranking.channel, Math.min(channelRanks.get(ranking.channel) ?? Number.POSITIVE_INFINITY, index + 1));
      evidenceRanks.set(filePath, channelRanks);
    });
  }

  type GraphCandidate = {
    path: string;
    precision: number;
    bestSeedRank: number;
    seedRanks: Map<string, number>;
    relationFamilyRanks: Map<string, number>;
  };
  const candidates = new Map<string, GraphCandidate>();
  const consider = (seedPath: string, neighborPath: string, edge: GraphEdgeRecord): void => {
    const seedRank = seedRanks.get(seedPath);
    const neighbor = input.filesByPath.get(neighborPath);
    if (!seedRank || !neighbor || primarySeedSet.has(neighborPath) || neighbor.indexTier === "tier0") return;
    if (
      probeSeedSet.has(seedPath) &&
      !isProbeEligibleEdge(edge.type, input.filesByPath.get(seedPath)?.kind)
    ) {
      return;
    }
    const precision = edgePriority(edge.type);
    if (precision === 0) return;
    const independentEvidence = evidenceRanks.get(neighborPath);
    if (
      (precision === 1 || edge.type === "shared_call_target") &&
      (!isProductionEvidenceFile(neighbor) || !independentEvidence || independentEvidence.size === 0)
    ) {
      return;
    }
    const existing = candidates.get(neighborPath);
    const strongestPrecision = Math.max(existing?.precision ?? 0, precision);
    const seedSupport = precision > (existing?.precision ?? 0)
      ? new Map<string, number>()
      : new Map(existing?.seedRanks ?? []);
    const relationFamilyRanks = precision > (existing?.precision ?? 0)
      ? new Map<string, number>()
      : new Map(existing?.relationFamilyRanks ?? []);
    // Do not combine the precision of one relationship with the rank/support
    // of a different, weaker relationship. A generic import from seed 1 must
    // not make a precise call observed from seed 40 look like seed-1 evidence.
    if (precision === strongestPrecision) {
      seedSupport.set(seedPath, Math.min(seedSupport.get(seedPath) ?? Number.POSITIVE_INFINITY, seedRank));
    }
    const relationFamily = graphRelationFamily(edge, seedPath);
    if (relationFamily && precision === strongestPrecision) {
      relationFamilyRanks.set(
        relationFamily,
        Math.min(relationFamilyRanks.get(relationFamily) ?? Number.POSITIVE_INFINITY, seedRank)
      );
    }
    candidates.set(neighborPath, {
      path: neighborPath,
      precision: strongestPrecision,
      bestSeedRank: Math.min(...seedSupport.values()),
      seedRanks: seedSupport,
      relationFamilyRanks
    });
  };

  for (const edge of input.edges) {
    const from = normalizePath(edge.fromFile);
    const to = normalizePath(edge.toFile);
    consider(from, to, edge);
    consider(to, from, edge);
  }

  const independentScore = (filePath: string): number => {
    let score = 0;
    for (const rank of evidenceRanks.get(filePath)?.values() ?? []) {
      score += 1 / (60 + rank);
    }
    return score;
  };
  const graphSupportScore = (candidate: GraphCandidate): number => {
    let score = 0;
    for (const rank of candidate.seedRanks.values()) score += 1 / (60 + rank);
    return score;
  };
  const minimumSeedSupport = Math.max(1, Math.floor(input.minimumSeedSupport ?? 1));
  const ranked = [...candidates.values()]
    .filter((candidate) => candidate.seedRanks.size >= minimumSeedSupport)
    .sort((left, right) =>
      right.precision - left.precision ||
      (evidenceRanks.get(right.path)?.size ?? 0) - (evidenceRanks.get(left.path)?.size ?? 0) ||
      left.bestSeedRank - right.bestSeedRank ||
      right.seedRanks.size - left.seedRanks.size ||
      graphSupportScore(right) - graphSupportScore(left) ||
      independentScore(right.path) - independentScore(left.path) ||
      left.path.localeCompare(right.path)
    );
  return diversifyModuleInstallationFamilies(ranked).map((candidate) => candidate.path);
}

function isProbeEligibleEdge(
  type: GraphEdgeRecord["type"],
  seedKind: FileRecord["kind"] | undefined
): boolean {
  if (seedKind === "test") {
    return (
      type === "test_for" ||
      type === "tested_by" ||
      type === "shared_call_target"
    );
  }
  return (
    type === "call" ||
    type === "shared_call_target" ||
    type === "type_reference"
  );
}

function graphRelationFamily(edge: GraphEdgeRecord, seedPath: string): string | undefined {
  if (edge.type !== "module_installation") return undefined;
  const through = typeof edge.metadata.through === "string"
    ? normalizePath(edge.metadata.through)
    : "";
  return through || normalizePath(seedPath);
}

function diversifyModuleInstallationFamilies<T extends {
  precision: number;
  path: string;
  relationFamilyRanks: Map<string, number>;
}>(ranked: T[]): T[] {
  const precise = ranked.filter((candidate) =>
    candidate.precision === edgePriority("module_installation") &&
    candidate.relationFamilyRanks.size > 0
  );
  if (precise.length < 2) return ranked;
  const preciseSet = new Set(precise);
  const queues = new Map<string, T[]>();
  const firstRank = new Map<string, number>();
  precise.forEach((candidate, index) => {
    const family = [...candidate.relationFamilyRanks.entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (!family) return;
    queues.set(family, [...(queues.get(family) ?? []), candidate]);
    firstRank.set(family, Math.min(firstRank.get(family) ?? Number.POSITIVE_INFINITY, index));
  });
  const families = [...queues.keys()].sort((left, right) =>
    (firstRank.get(left) ?? Number.POSITIVE_INFINITY) -
      (firstRank.get(right) ?? Number.POSITIVE_INFINITY) ||
    left.localeCompare(right)
  );
  const diversified: T[] = [];
  let depth = 0;
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const family of families) {
      const candidate = queues.get(family)?.[depth];
      if (!candidate) continue;
      diversified.push(candidate);
      madeProgress = true;
    }
    depth += 1;
  }
  return [...diversified, ...ranked.filter((candidate) => !preciseSet.has(candidate))];
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
  if (
    type === "test_for" ||
    type === "tested_by" ||
    type === "shared_call_target" ||
    type === "call"
  ) return 5;
  if (type === "module_installation" || type === "type_reference") return 4;
  if (
    type === "definition" ||
    type === "implementation"
  ) {
    return 2;
  }
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
