// SPDX-License-Identifier: Apache-2.0

import type {
  ContextShownRecord,
  EvidenceGraphFacts,
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
import {
  fuseSemanticCandidateRankings,
  type SemanticCandidateHit
} from "./semanticCandidates.js";

export type CandidateRanking = {
  channel:
    | "semantic"
    | "bm25"
    | "symbol"
    | "git"
    | "session"
    | "graph"
    | "graph_importer"
    | "graph_consensus";
  paths: string[];
};

export type ModelCandidateUnion = {
  initialPaths: string[];
  enrichedPaths: string[];
  probePaths: string[];
  candidateResults: HybridScoredResult[];
  probeCandidateResults: HybridScoredResult[];
  semanticStatus: SemanticRetrieverStatus;
  graphPaths: string[];
  graphImporterPaths: string[];
  graphConsensusPaths: string[];
  graphSeedPaths: string[];
  graphSeedRanks: ReadonlyMap<string, number>;
  graphEvidenceByPath: ReadonlyMap<string, EvidenceGraphFacts>;
  semanticPaths: string[];
  semanticEvidencePaths: string[];
};

/**
 * Internal retrieval breadth used only to obtain model-backed graph probes.
 * Public candidate delivery remains bounded at 64 initial and 128 enriched
 * files. A broader probe pool lets precise parser facts validate semantic
 * candidates that would otherwise be discarded before graph enrichment.
 */
export const MODEL_RETRIEVAL_PROBE_LIMIT = 512;
const PRIMARY_SEMANTIC_QUERY_VIEW_LIMIT = 2;
const MODEL_INITIAL_SEMANTIC_RESERVE = Math.floor(
  DEFAULT_INITIAL_CANDIDATE_LIMIT * 7 / 8
);
const MODEL_INITIAL_SYMBOL_RESERVE = 4;
const MODEL_INITIAL_GRAPH_RESERVE = 16;
const MAX_TEST_GRAPH_PROBE_PATHS = 192;
const GRAPH_ENRICHMENT_CAPACITY =
  DEFAULT_ENRICHED_CANDIDATE_LIMIT - DEFAULT_INITIAL_CANDIDATE_LIMIT;
const MAX_GRAPH_CONSENSUS_SUPPORT_SEEDS = 3;

export function buildModelCandidateUnion(input: {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  bm25Results: HybridScoredResult[];
  semanticHits: SemanticCandidateHit[];
  semanticQueryRankings?: SemanticCandidateHit[][];
  semanticEvidencePaths?: string[];
  semanticStatus: SemanticRetrieverStatus;
  edges: GraphEdgeRecord[];
  changedFiles?: Set<string>;
  shown?: ContextShownRecord[];
  /** Offline diagnostics only; serving remains bounded at 128. */
  probeLimit?: number;
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
  // Apply objective repository-role policy inside each model-ranked query
  // view, before bounded multi-view fusion. Applying it only after fusion is
  // too late when tests/examples have already crowded a production file out
  // of the fused semantic lane. Similarities are unchanged and the embedding
  // model still decides relevance within each role partition.
  const intentAwareSemanticRankings = input.semanticQueryRankings?.map((ranking) =>
    prioritizeRetrievalHitsForIntent(
      ranking.filter((hit) => eligibleNonHard(hit.path)),
      signals.intent,
      filesByPath
    )
  );
  // Headline and narrative synopsis are the primary semantic retrieval views.
  // Additional structurally bounded evidence views remain available to seed
  // precise one-hop graph discovery, but they do not get to crowd primary
  // model hits out merely by adding another independent ranking.
  const primarySemanticRankings = intentAwareSemanticRankings?.slice(
    0,
    PRIMARY_SEMANTIC_QUERY_VIEW_LIMIT
  );
  const intentAwareSemanticHits = primarySemanticRankings?.length
    ? fuseSemanticCandidateRankings(
        primarySemanticRankings,
        MODEL_RETRIEVAL_PROBE_LIMIT
      )
    : input.semanticHits.filter((hit) => eligibleNonHard(hit.path));
  const semanticPaths = prioritizeRetrievalPathsForIntent(
    intentAwareSemanticHits.map((hit) => normalizePath(hit.path)),
    signals.intent,
    filesByPath
  );
  const semanticEvidencePaths = intentAwareSemanticRankings?.length
    ? interleaveSemanticRankingPaths(
        intentAwareSemanticRankings,
        MODEL_RETRIEVAL_PROBE_LIMIT * 8
      )
    : prioritizeRetrievalPathsForIntent(uniquePaths(
        input.semanticEvidencePaths ?? semanticPaths
      ).filter(eligibleNonHard), signals.intent, filesByPath);
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
  const fusedRetrievalOrder = reciprocalRankFuse({
    hardPaths,
    rankings: baseRankings,
    limit: MODEL_RETRIEVAL_PROBE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath));
  // RRF rewards agreement, but a broad lexical/symbol overlap can otherwise
  // consume the complete 64-file bound before a strong model-only candidate
  // enters. Preserve a fixed model-retrieval slice, then let RRF fill the
  // remainder. Hard paths stay first and the public bound does not change.
  const preliminaryUnion = uniquePaths([
    ...hardPaths,
    ...semanticPaths.slice(0, MODEL_INITIAL_SEMANTIC_RESERVE),
    ...fusedRetrievalOrder
  ])
    .filter((filePath) => filesByPath.has(filePath))
    .slice(0, MODEL_RETRIEVAL_PROBE_LIMIT);
  const preliminaryGraphSeedPaths = uniquePaths([
    ...hardPaths,
    ...semanticPaths.slice(0, MODEL_INITIAL_SEMANTIC_RESERVE),
    ...fusedRetrievalOrder
  ])
    .filter((filePath) => filesByPath.has(filePath))
    .slice(0, DEFAULT_INITIAL_CANDIDATE_LIMIT);
  const graphProbePaths = signals.intent === "source"
    ? uniquePaths([
        ...semanticEvidencePaths
          .filter((filePath) =>
            !preliminaryGraphSeedPaths.includes(filePath) &&
            filesByPath.get(filePath)?.kind === "test"
          )
          .slice(0, MAX_TEST_GRAPH_PROBE_PATHS),
        ...semanticEvidencePaths
          .filter((filePath) => {
            const file = filesByPath.get(filePath);
            return Boolean(
              !preliminaryGraphSeedPaths.includes(filePath) &&
              file &&
              isProductionEvidenceFile(file)
            );
          })
      ])
        .filter((filePath) => !preliminaryGraphSeedPaths.includes(filePath))
        .slice(0, MODEL_RETRIEVAL_PROBE_LIMIT - preliminaryGraphSeedPaths.length)
    : [];
  const graphSeedPaths = uniquePaths([...preliminaryGraphSeedPaths, ...graphProbePaths]);
  const semanticEvidenceRanks = new Map(
    semanticEvidencePaths.map((filePath, index) => [filePath, index + 1])
  );
  // Probe selection is role-balanced so semantically relevant tests retain a
  // chance to rescue their production companions. That coverage policy must
  // not overwrite the model's relevance ordering, however. Keep primary seed
  // ranks from the bounded fused lane and score every additional probe at its
  // original semantic-evidence rank.
  const graphSeedRanks = new Map(
    graphSeedPaths.map((filePath, index) => [filePath, index + 1])
  );
  for (const filePath of graphProbePaths) {
    const semanticEvidenceRank = semanticEvidenceRanks.get(filePath);
    if (semanticEvidenceRank !== undefined) {
      graphSeedRanks.set(filePath, semanticEvidenceRank);
    }
  }
  const graphEvidenceByPath = new Map<string, EvidenceGraphFacts>();
  const graphPaths = prioritizeGraphPathsForIntent(
    rankEvidenceBackedGraphCandidates({
      seedPaths: preliminaryGraphSeedPaths,
      probeSeedPaths: graphProbePaths,
      edges: input.edges,
      filesByPath,
      evidenceRankings: [
        { channel: "semantic", paths: semanticEvidencePaths },
        { channel: "bm25", paths: bm25Paths },
        { channel: "symbol", paths: eligibleSymbolPaths }
      ],
      seedRanks: graphSeedRanks,
      graphEvidenceByPath
    }),
    signals.intent,
    filesByPath
  );
  const graphConsensusPaths = prioritizeGraphPathsForIntent(
    rankEvidenceBackedGraphCandidates({
      seedPaths: preliminaryGraphSeedPaths,
      probeSeedPaths: graphProbePaths,
      edges: input.edges,
      filesByPath,
      evidenceRankings: [
        { channel: "semantic", paths: semanticEvidencePaths },
        { channel: "bm25", paths: bm25Paths },
        { channel: "symbol", paths: eligibleSymbolPaths }
      ],
      seedRanks: graphSeedRanks,
      minimumSeedSupport: 2,
      ordering: "support"
    }),
    signals.intent,
    filesByPath
  );
  const graphImporterPaths = prioritizeGraphPathsForIntent(
    rankEvidenceBackedGraphCandidates({
      seedPaths: preliminaryGraphSeedPaths,
      probeSeedPaths: graphProbePaths,
      edges: input.edges,
      filesByPath,
      evidenceRankings: [
        { channel: "semantic", paths: semanticEvidencePaths },
        { channel: "bm25", paths: bm25Paths },
        { channel: "symbol", paths: eligibleSymbolPaths }
      ],
      seedRanks: graphSeedRanks,
      relationMode: "model_corroborated_reverse_import",
      graphEvidenceByPath
    }),
    signals.intent,
    filesByPath
  );
  // Candidate recall needs independent lanes to survive before the calibrated
  // ranker sees the first 64 files. A model-only reserve can crowd out exact
  // symbols and parser-proven direct neighbors, while an unconstrained graph
  // lane can replace the model evidence that made those neighbors meaningful.
  // Keep small, fixed maxima for semantic, symbol, and one-hop graph evidence,
  // then let RRF and the prior preliminary union fill every unused slot.
  const initialPaths = uniquePaths([
    ...hardPaths,
    ...semanticPaths.slice(0, MODEL_INITIAL_SEMANTIC_RESERVE),
    ...eligibleSymbolPaths.slice(0, MODEL_INITIAL_SYMBOL_RESERVE),
    ...graphPaths.slice(0, MODEL_INITIAL_GRAPH_RESERVE),
    ...fusedRetrievalOrder,
    ...preliminaryUnion
  ])
    .filter((filePath) => filesByPath.has(filePath))
    .slice(0, DEFAULT_INITIAL_CANDIDATE_LIMIT);
  const graphEnrichedOrder = reciprocalRankFuse({
    hardPaths,
    rankings: graphPaths.length > 0
      ? [
          ...baseRankings,
          { channel: "graph", paths: graphPaths },
          ...(graphImporterPaths.length > 0
            ? [{ channel: "graph_importer" as const, paths: graphImporterPaths }]
            : []),
          ...(graphConsensusPaths.length > 0
            ? [{ channel: "graph_consensus" as const, paths: graphConsensusPaths }]
            : [])
        ]
      : baseRankings,
    limit: DEFAULT_ENRICHED_CANDIDATE_LIMIT
  }).filter((filePath) => filesByPath.has(filePath));
  const graphCorePaths = reciprocalRankFuse({
    hardPaths: [],
    rankings: [
      { channel: "graph", paths: graphPaths },
      ...(graphConsensusPaths.length > 0
        ? [{ channel: "graph_consensus" as const, paths: graphConsensusPaths }]
        : [])
    ],
    limit: GRAPH_ENRICHMENT_CAPACITY
  }).filter((filePath) => filesByPath.has(filePath));
  // Preserve the complete parser-precision/consensus core before admitting
  // the weaker reverse-import relation. The tail is still model-based:
  // importer candidates require their own semantic evidence. A two-to-one
  // structural interleave reflects the stronger multi-seed consensus without
  // assigning brittle independent quotas or enlarging the 128-file union.
  const graphTailPaths = weightedInterleavePaths([
    { paths: graphConsensusPaths, weight: 2 },
    { paths: graphImporterPaths, weight: 1 }
  ], DEFAULT_ENRICHED_CANDIDATE_LIMIT)
    .filter((filePath) => filesByPath.has(filePath));
  // Interleave the precision core with the corroborated tail before applying
  // the global 128-file bound. Appending a complete 64-file core first makes
  // the tail depend on accidental overlap with the initial 64: tiny numeric
  // differences between supported ONNX runtimes can then create or remove the
  // only available tail slot. A bounded weighted merge preserves the stronger
  // core while keeping the independent importer/consensus lane observable.
  const graphEnrichmentPaths = weightedInterleavePaths([
    { paths: graphCorePaths, weight: 2 },
    { paths: graphTailPaths, weight: 1 }
  ], DEFAULT_ENRICHED_CANDIDATE_LIMIT)
    .filter((filePath) => filesByPath.has(filePath));
  // Graph relations enrich the bounded union; they do not get to evict
  // independently retrieved evidence from the initial 64-file lane. Preserve
  // that serving contract, then fill the remaining bounded capacity with the
  // one-hop additions supported by multiple independent seeds before the
  // broader graph ranking and retrieval tail. Putting the consensus lane
  // after its own superset would make it observationally inert.
  // The calibrated ranker therefore sees the intended 64 initial + up to 64
  // graph-enriched candidates without a second fusion silently dropping a
  // parser-proven neighbor. Fuse precision and consensus inside the complete
  // enrichment capacity instead of assigning brittle independent quotas.
  const enrichedPaths = uniquePaths([
    ...initialPaths,
    ...graphEnrichmentPaths,
    ...graphCorePaths,
    ...graphTailPaths,
    ...graphConsensusPaths,
    ...graphImporterPaths,
    ...graphPaths,
    ...graphEnrichedOrder,
    ...preliminaryUnion
  ]).slice(0, DEFAULT_ENRICHED_CANDIDATE_LIMIT);
  const probeLimit = Math.max(
    DEFAULT_ENRICHED_CANDIDATE_LIMIT,
    Math.min(
      Math.floor(input.probeLimit ?? DEFAULT_ENRICHED_CANDIDATE_LIMIT),
      MODEL_RETRIEVAL_PROBE_LIMIT
    )
  );
  const probePaths = uniquePaths([
    ...enrichedPaths,
    // The diagnostic pool exists to test whether the learned selector can
    // recover model candidates that the current 64/128 policy misses. Keep
    // the complete independent semantic lane ahead of optional graph tails;
    // otherwise a large import graph can consume all 512 slots before a
    // genuine model hit is made available to the ranker.
    ...semanticEvidencePaths,
    ...graphCorePaths,
    ...graphTailPaths,
    ...graphConsensusPaths,
    ...graphImporterPaths,
    ...graphPaths,
    ...graphEnrichedOrder,
    ...preliminaryUnion
  ])
    .filter((filePath) => filesByPath.has(filePath))
    .slice(0, probeLimit);
  const bm25ByPath = new Map(input.bm25Results.map((result) => [normalizePath(result.path), result]));
  const semanticByPath = new Map(
    [...input.semanticHits, ...intentAwareSemanticHits]
      .map((hit) => [normalizePath(hit.path), hit] as const)
  );
  const changedPaths = new Set([...(input.changedFiles ?? [])].map(normalizePath));
  const graphPathSet = new Set([
    ...graphPaths,
    ...graphImporterPaths,
    ...graphConsensusPaths
  ]);
  const resultForPath = (filePath: string): HybridScoredResult => {
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
  };
  const candidateResults = enrichedPaths.map(resultForPath);
  const probeCandidateResults = probePaths.map(resultForPath);
  return {
    initialPaths,
    enrichedPaths,
    probePaths,
    candidateResults,
    probeCandidateResults,
    semanticStatus: input.semanticStatus,
    graphPaths,
    graphImporterPaths,
    graphConsensusPaths,
    graphSeedPaths,
    graphSeedRanks,
    graphEvidenceByPath,
    semanticPaths,
    semanticEvidencePaths
  };
}

function prioritizeRetrievalHitsForIntent(
  hits: SemanticCandidateHit[],
  intent: ReturnType<typeof extractEvidenceTaskSignals>["intent"],
  filesByPath: Map<string, FileRecord>
): SemanticCandidateHit[] {
  if (intent !== "source") return hits;
  const production: SemanticCandidateHit[] = [];
  const companions: SemanticCandidateHit[] = [];
  for (const hit of hits) {
    const file = filesByPath.get(normalizePath(hit.path));
    if (file && isProductionEvidenceFile(file)) production.push(hit);
    else companions.push(hit);
  }
  return [...production, ...companions];
}

function interleaveSemanticRankingPaths(
  rankings: SemanticCandidateHit[][],
  limit: number
): string[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const selected: string[] = [];
  const seen = new Set<string>();
  const maximumLength = rankings.reduce(
    (maximum, ranking) => Math.max(maximum, ranking.length),
    0
  );
  for (let rank = 0; rank < maximumLength && selected.length < boundedLimit; rank += 1) {
    for (const ranking of rankings) {
      const filePath = ranking[rank]?.path;
      if (!filePath) continue;
      const normalized = normalizePath(filePath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      selected.push(normalized);
      if (selected.length >= boundedLimit) break;
    }
  }
  return selected;
}

function prioritizeRetrievalPathsForIntent(
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
  seedRanks?: ReadonlyMap<string, number>;
  minimumSeedSupport?: number;
  ordering?: "precision" | "support";
  relationMode?: "all" | "model_corroborated_reverse_import";
  graphEvidenceByPath?: Map<string, EvidenceGraphFacts>;
}): string[] {
  const primarySeeds = uniquePaths(input.seedPaths);
  const primarySeedSet = new Set(primarySeeds);
  const probeSeeds = uniquePaths(input.probeSeedPaths ?? []).filter(
    (filePath) => !primarySeeds.includes(filePath)
  );
  const seedRanks = new Map(
    [...primarySeeds, ...probeSeeds].map((filePath, index) => [
      filePath,
      input.seedRanks?.get(filePath) ?? index + 1
    ])
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
    sourceTestPair: boolean;
  };
  const candidates = new Map<string, GraphCandidate>();
  const consider = (
    seedPath: string,
    neighborPath: string,
    edge: GraphEdgeRecord,
    direction: "forward" | "reverse"
  ): void => {
    const seedRank = seedRanks.get(seedPath);
    const neighbor = input.filesByPath.get(neighborPath);
    if (!seedRank || !neighbor || seedPath === neighborPath || neighbor.indexTier === "tier0") return;
    const independentEvidence = evidenceRanks.get(neighborPath);
    const isModelCorroboratedReverseImporter = (
      probeSeedSet.has(seedPath) &&
      edge.type === "imports" &&
      direction === "reverse" &&
      (independentEvidence?.has("semantic") ?? false)
    );
    if (
      input.relationMode === "model_corroborated_reverse_import" &&
      !isModelCorroboratedReverseImporter
    ) {
      return;
    }
    if (
      probeSeedSet.has(seedPath) &&
      !isProbeEligibleEdge({
        type: edge.type,
        seedKind: input.filesByPath.get(seedPath)?.kind,
        direction,
        hasSemanticNeighborEvidence: independentEvidence?.has("semantic") ?? false
      })
    ) {
      return;
    }
    const precision = edgePriority(edge.type);
    if (precision === 0) return;
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
    let sourceTestPair = precision > (existing?.precision ?? 0)
      ? false
      : existing?.sourceTestPair ?? false;
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
    if (
      precision === strongestPrecision &&
      (edge.type === "test_for" || edge.type === "tested_by")
    ) {
      sourceTestPair = true;
    }
    candidates.set(neighborPath, {
      path: neighborPath,
      precision: strongestPrecision,
      bestSeedRank: Math.min(...seedSupport.values()),
      seedRanks: seedSupport,
      relationFamilyRanks,
      sourceTestPair
    });
  };

  for (const edge of input.edges) {
    const from = normalizePath(edge.fromFile);
    const to = normalizePath(edge.toFile);
    consider(from, to, edge, "forward");
    consider(to, from, edge, "reverse");
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
    const strongestSeedRanks = [...candidate.seedRanks.values()]
      .sort((left, right) => left - right)
      .slice(0, MAX_GRAPH_CONSENSUS_SUPPORT_SEEDS);
    for (const rank of strongestSeedRanks) score += 1 / (60 + rank);
    return score;
  };
  const supportWeightedScore = (candidate: GraphCandidate): number =>
    candidate.precision * graphSupportScore(candidate) + independentScore(candidate.path);
  if (input.graphEvidenceByPath) {
    const maximumSeedStrength = [1, 2, 3]
      .reduce((sum, rank) => sum + 1 / (60 + rank), 0);
    const maximumIndependentEvidence = 3 / 61;
    for (const candidate of candidates.values()) {
      const current = input.graphEvidenceByPath.get(candidate.path);
      const next = {
        precision: candidate.precision / 5,
        supportingSeedCount: candidate.seedRanks.size,
        seedStrength: clamp01(graphSupportScore(candidate) / maximumSeedStrength),
        independentEvidence: clamp01(
          independentScore(candidate.path) / maximumIndependentEvidence
        ),
        sourceTestPair: candidate.sourceTestPair
      };
      input.graphEvidenceByPath.set(candidate.path, current ? {
        precision: Math.max(current.precision, next.precision),
        supportingSeedCount: Math.max(current.supportingSeedCount, next.supportingSeedCount),
        seedStrength: Math.max(current.seedStrength, next.seedStrength),
        independentEvidence: Math.max(current.independentEvidence, next.independentEvidence),
        sourceTestPair: current.sourceTestPair || next.sourceTestPair
      } : next);
    }
  }
  const minimumSeedSupport = Math.max(1, Math.floor(input.minimumSeedSupport ?? 1));
  const ordering = input.ordering ?? "precision";
  const ranked = [...candidates.values()]
    .filter((candidate) =>
      !primarySeedSet.has(candidate.path) &&
      candidate.seedRanks.size >= minimumSeedSupport
    )
    .sort((left, right) => ordering === "support"
      ? (
          supportWeightedScore(right) - supportWeightedScore(left) ||
          right.seedRanks.size - left.seedRanks.size ||
          right.precision - left.precision ||
          left.bestSeedRank - right.bestSeedRank ||
          left.path.localeCompare(right.path)
        )
      : (
          right.precision - left.precision ||
          (evidenceRanks.get(right.path)?.size ?? 0) - (evidenceRanks.get(left.path)?.size ?? 0) ||
          left.bestSeedRank - right.bestSeedRank ||
          right.seedRanks.size - left.seedRanks.size ||
          graphSupportScore(right) - graphSupportScore(left) ||
          independentScore(right.path) - independentScore(left.path) ||
          left.path.localeCompare(right.path)
        ));
  return diversifyModuleInstallationFamilies(ranked).map((candidate) => candidate.path);
}

function isProbeEligibleEdge(input: {
  type: GraphEdgeRecord["type"];
  seedKind: FileRecord["kind"] | undefined;
  direction: "forward" | "reverse";
  hasSemanticNeighborEvidence: boolean;
}): boolean {
  if (input.seedKind === "test") {
    return (
      input.type === "test_for" ||
      input.type === "tested_by" ||
      input.type === "shared_call_target"
    );
  }
  return (
    input.type === "call" ||
    input.type === "shared_call_target" ||
    input.type === "type_reference" ||
    (
      input.type === "imports" &&
      input.direction === "reverse" &&
      input.hasSemanticNeighborEvidence
    )
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
  let diversifiedIndex = 0;
  return ranked.map((candidate) => {
    if (!preciseSet.has(candidate)) return candidate;
    const replacement = diversified[diversifiedIndex];
    diversifiedIndex += 1;
    return replacement ?? candidate;
  });
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

function weightedInterleavePaths(
  rankings: Array<{ paths: string[]; weight: number }>,
  limit: number
): string[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const lanes = rankings
    .map((ranking) => ({
      paths: uniquePaths(ranking.paths),
      weight: Math.max(1, Math.floor(ranking.weight)),
      cursor: 0
    }))
    .filter((ranking) => ranking.paths.length > 0);
  const selected: string[] = [];
  const seen = new Set<string>();
  let progressed = true;
  while (selected.length < boundedLimit && progressed) {
    progressed = false;
    for (const lane of lanes) {
      let taken = 0;
      while (
        taken < lane.weight &&
        lane.cursor < lane.paths.length &&
        selected.length < boundedLimit
      ) {
        const filePath = lane.paths[lane.cursor]!;
        lane.cursor += 1;
        if (seen.has(filePath)) continue;
        selected.push(filePath);
        seen.add(filePath);
        taken += 1;
        progressed = true;
      }
    }
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
