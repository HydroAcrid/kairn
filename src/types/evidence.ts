// SPDX-License-Identifier: Apache-2.0

export type RankerMode = "legacy" | "shadow" | "calibrated";
export type CandidateGeneratorMode = "legacy" | "shadow" | "semantic";

export type SemanticRetrieverConfig = {
  mode: CandidateGeneratorMode;
  modelId?: string;
  /** A local model directory containing kairn-model.json. Remote URLs are never accepted. */
  modelPath?: string;
};

export type SemanticIndexStatus =
  | "unavailable"
  | "corrupt"
  | "incompatible"
  | "stale_index"
  | "ready";

export type SemanticRetrieverStatus = {
  requestedMode: CandidateGeneratorMode;
  servedMode: CandidateGeneratorMode | "fallback";
  semanticModelId?: string;
  semanticIndexStatus: SemanticIndexStatus;
  semanticFallbackReason?: string;
  documentCount: number;
  embeddingCount: number;
  queryLatencyMs?: number;
  vectorScanLatencyMs?: number;
};

export type RankerConfig = {
  mode: RankerMode;
  /** A local JSON artifact. Remote URLs are never accepted. */
  modelPath?: string;
};

export type KairnRuntimeOptions = {
  ranker?: RankerConfig;
  semantic?: SemanticRetrieverConfig;
};

export type EvidenceDelivery = "path_hint" | "content";

export type EvidenceReason =
  | "exact_path"
  | "basename"
  | "exact_symbol"
  | "symbol_prefix"
  | "lexical"
  | "semantic"
  | "failure_reference"
  | "git_diff"
  | "already_delivered"
  | "graph_neighbor"
  | "source_test_pair"
  | "production_source"
  | "test_requested"
  | "role_match"
  | "generated_vendor"
  | "content_cost";

export type EvidenceTaskIntent = "source" | "test" | "docs" | "unknown";

export type EvidenceTaskSignals = {
  queryTerms: string[];
  explicitPaths: string[];
  mentionedBasenames: string[];
  /** Quoted, qualified, or otherwise code-shaped identifiers, strongest first. */
  preferredIdentifiers: string[];
  identifiers: string[];
  /** Exact symbols parsed from structured failing-check output. */
  failureIdentifiers: string[];
  failureReferences: string[];
  intent: EvidenceTaskIntent;
};

/**
 * Objective one-hop parser evidence produced by candidate generation.
 * Values are normalized, query-local facts; the calibrated model decides
 * whether they imply relevance.
 */
export type EvidenceGraphFacts = {
  precision: number;
  supportingSeedCount: number;
  seedStrength: number;
  independentEvidence: number;
  sourceTestPair: boolean;
};

export const EVIDENCE_FEATURE_NAMES = Object.freeze([
  "exactPath",
  "basenameMatch",
  "exactSymbol",
  "symbolPrefix",
  "bm25",
  "keyword",
  "semantic",
  "failureReference",
  "gitChanged",
  "alreadyDelivered",
  "graphNeighbor",
  "graphPrecision",
  "graphConsensus",
  "graphSupport",
  "graphSeedStrength",
  "graphIndependentEvidence",
  "sourceTestPair",
  "productionSource",
  "testFile",
  "docsFile",
  "generatedVendor",
  "intentRoleMatch",
  "importance",
  "contentCost",
  "missingSymbols",
  "missingLexical"
] as const);

export type EvidenceFeatureName = (typeof EVIDENCE_FEATURE_NAMES)[number];

export type EvidenceFeatureVector = Record<EvidenceFeatureName, number>;

export type EvidenceCandidate = {
  path: string;
  reasons: EvidenceReason[];
  features: EvidenceFeatureVector;
};

/** Deterministic query-local snapshot used to curate public ranker corpora. */
export type EvidenceCandidateInspection = {
  signals: EvidenceTaskSignals;
  /** Candidate@limit rows exported for corpus training and review. */
  candidates: EvidenceCandidate[];
  /** Complete bounded candidate union, including post-limit enrichment rows. */
  enrichedCandidates: EvidenceCandidate[];
  /** Cheap pre-enrichment candidates used to seed graph and source expansion. */
  initialCandidatePaths: string[];
  enrichedCandidatePaths: string[];
  initialCandidateCount: number;
  enrichedCandidateCount: number;
  candidateLimit: number;
  /** Local-only lane ranks used to diagnose bounded-union misses. */
  candidateDiagnostics?: {
    semanticQueryViews: string[][];
    semanticFused: string[];
    semanticEvidence: string[];
    bm25: string[];
    graph: string[];
    graphConsensus: string[];
    graphEvidence: Array<{
      path: string;
      supportCount: number;
      precision?: number;
      seedStrength?: number;
      independentEvidence?: number;
      supports: Array<{
        seedPath: string;
        seedRank: number;
        edgeType: import("./graph.js").GraphEdgeType;
        reason?: string;
      }>;
    }>;
  };
};

export type EvidenceRankerThresholds = {
  abstain: number;
  pathHint: number;
  content: number;
};

export type EvidenceRankerArtifact = {
  formatVersion: 1;
  modelId: string;
  featureSchemaVersion: "evidence-features-v4";
  featureSchemaHash: string;
  orderedFeatures: EvidenceFeatureName[];
  intercept: number;
  coefficients: number[];
  calibration: {
    kind: "platt";
    a: number;
    b: number;
  };
  decisionThresholds: EvidenceRankerThresholds;
  trainingDataHash: string;
  trainingManifest: string;
  checksum: string;
};

export type EvidenceModelPrediction = {
  rawScore: number;
  uncalibratedProbability: number;
  relevanceProbability: number;
};

export type EvidenceRankerStatus = {
  requestedMode: RankerMode;
  servedMode: RankerMode | "fallback";
  modelId: string;
  featureSchemaVersion: string;
  fallbackReason?: string;
};
