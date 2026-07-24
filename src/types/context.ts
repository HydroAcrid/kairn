// SPDX-License-Identifier: Apache-2.0

import type { FileKind, FileRecord, IndexStateStats, RepoGraph, ScanResult, SemanticChunkRecord } from "./graph.js";
import type { TaskSession } from "./runtime.js";
import type {
  CandidateGeneratorMode,
  EvidenceDelivery,
  EvidenceReason,
  RankerMode,
  SemanticIndexStatus
} from "./evidence.js";

export type ContextRequestType =
  | "initial_brief"
  | "find_context"
  | "file"
  | "symbol"
  | "related"
  | "tests"
  | "error"
  | "diff"
  | "verify_plan";

export type ContextResponseMode =
  | "brief"
  | "exact_code"
  | "compressed_summary"
  | "snippets"
  | "graph_neighbors"
  | "failure_context"
  | "verification_plan";

export type OutputKind = "test" | "lint" | "typecheck" | "generic";

export type ContextQueryMode = "brief" | "snippets" | "summary" | "exact";

export type PrimeProfile = "auto" | "ui" | "workflow" | "backend" | "test" | "failure_debug" | "generic";

export type CanonicalCodexSetupMode = "source-first" | "observe" | "debug" | "mcp-first" | "hybrid";

/**
 * `savings` is accepted as a v0.2 compatibility alias. New configuration and
 * public output must use `source-first`.
 */
export type CodexSetupMode = CanonicalCodexSetupMode | "savings";

export type HookOutputProfile = "full-prime" | "tiny-directive" | "failure-only" | "mcp-brief";

export type ContextShownRecord = {
  id?: number;
  sessionId: string;
  kind: "file" | "symbol" | "summary" | "diff" | "tests" | "context";
  filePath?: string;
  symbol?: string;
  mode: ContextResponseMode;
  contentHash: string;
  createdAt: string;
};

export type CommandRecord = {
  id?: number;
  sessionId: string;
  type: OutputKind | "diff";
  summary: string;
  createdAt: string;
};

export type DiffRecord = {
  id?: number;
  sessionId: string;
  files: string[];
  summary: string;
  createdAt: string;
};

export type ContextPrime = {
  session: TaskSession;
  task: string;
  profile: Exclude<PrimeProfile, "auto">;
  content: string;
  files: string[];
  tokenEstimate: number;
  invariants?: ContextInvariant[];
  quality?: PrimeQuality;
  contextDecision?: ContextValueDecision;
  editScope?: EditScopeDecision;
  timings?: Record<string, number>;
  metadata?: Record<string, unknown>;
  warnings: string[];
  suggestedCommands: string[];
};

export type PrimeQualityAction = "emit" | "shrink" | "suppress" | "request_evidence";

export type ContextValueAction = "emit" | "shrink" | "suppress" | "request_evidence";

export type TaskFrame =
  | "cheap_single_source"
  | "source_rescue"
  | "multi_file_debug"
  | "failure_first"
  | "runtime_procedural"
  | "verification_cleanup"
  | "weak_signal"
  | "official_patch"
  | "qna_source_grounded";

export type FileRoleV2 =
  | "production_source"
  | "test"
  | "docs"
  | "example"
  | "generated"
  | "vendor_dep"
  | "config"
  | "schema"
  | "public_api"
  | "entrypoint"
  | "platform_variant"
  | "ui_surface"
  | "route"
  | "unknown";

export type EvidenceRequestKind =
  | "failure_output"
  | "exact_source"
  | "verification_result"
  | "runtime_scope"
  | "changed_file"
  | "clarify_task";

export type EvidenceRequest = {
  kind: EvidenceRequestKind;
  prompt: string;
  reason: string;
};

export type ContextGovernorModelPrediction = {
  pUseful: number;
  pHarm: number;
  pNeedMoreEvidence: number;
  suggestedAction: ContextValueAction;
  confidence: number;
  source: "deterministic" | "linear_model";
};

export type ContextGovernorFeatureSummary = {
  taskFrame: TaskFrame;
  candidateCount: number;
  fileRoleCounts: Partial<Record<FileRoleV2, number>>;
  repoLanguageMix: Record<string, number>;
  topRole?: FileRoleV2;
  topLanguage?: string;
  confidenceGap: number;
  candidateEntropy: number;
  ambiguity: number;
  expectedContextCost: number;
  estimatedSearchCost: number;
};

export type PrimeQuality = {
  score: number;
  action: PrimeQualityAction;
  reasons: string[];
  topScore: number;
  topGap: number;
  exactPathMentioned: boolean;
  expectedSavingsRisk: "low" | "medium" | "high";
};

export type ContextValueDecision = {
  score: number;
  action: ContextValueAction;
  reasons: string[];
  topScore: number;
  topGap: number;
  primaryFile?: string;
  language: "typescript" | "javascript" | "python" | "java" | "cpp" | "c" | "go" | "ruby" | "unknown";
  exactPathMentioned: boolean;
  exactSourceHit?: boolean;
  sourceRescue?: boolean;
  canonicalSourceHit?: boolean;
  cheapSingleSource?: boolean;
  cheapExactSource?: boolean;
  companionSpecific?: boolean;
  multiSurfaceSignal?: boolean;
  companionCount?: number;
  companionTopScore?: number;
  recommendedDelivery?: "full_prime" | "one_file_directive" | "multi_file_directive" | "evidence_request" | "none";
  estimatedContextCost: number;
  expectedSavingsRisk: "low" | "medium" | "high";
  debugSignal: boolean;
  easyTaskSignal: boolean;
  wrongContextRisk?: boolean;
  taskFrame?: TaskFrame;
  evidenceRequest?: EvidenceRequest;
  modelPrediction?: ContextGovernorModelPrediction;
  featureSummary?: ContextGovernorFeatureSummary;
  policySource?: "calibrated_evidence_policy_v1";
};

export type EditScopeConfidence = "high" | "medium" | "low";

export type EditScopeSource =
  | "exact_source"
  | "source_rescue"
  | "multi_file_debug"
  | "failure_output"
  | "official_harness"
  | "session_ledger"
  | "weak_signal";

export type EditScopeDecision = {
  initialEditFiles: string[];
  readOnlyFiles: string[];
  allowedExpansionTriggers: string[];
  forbiddenEditPatterns: string[];
  scopeConfidence: EditScopeConfidence;
  scopeSource: EditScopeSource;
  reason: string;
  dynamic: true;
};

export type ContextRequest = {
  sessionId: string;
  requestType: ContextRequestType;
  target?: string;
  query?: string;
  agentIntent?: string;
  budget?: number;
  mode?: ContextQueryMode;
};

export type ContextResponse = {
  mode: ContextResponseMode;
  content: string;
  files: string[];
  symbols: string[];
  related: string[];
  warnings: string[];
  suggestedNextContext: string[];
  rankedFiles?: ContextRankedFile[];
  tokenEstimate: number;
  metadata?: Record<string, unknown>;
};

export type ContextRankedFile = {
  path: string;
  kind: FileKind;
  score: number;
  reasons: string[];
  relevanceProbability?: number;
  probabilityGap?: number;
  rankerModelId?: string;
  featureSchemaVersion?: string;
  evidenceReasons?: EvidenceReason[];
  delivery?: EvidenceDelivery;
  rankerMode?: RankerMode | "fallback";
  rankerFallbackReason?: string;
  candidateGeneratorMode?: CandidateGeneratorMode | "fallback";
  semanticModelId?: string;
  semanticIndexStatus?: SemanticIndexStatus;
  semanticFallbackReason?: string;
  scores?: {
    semantic?: number;
    keyword?: number;
    bm25?: number;
    behavior?: number;
    graph?: number;
    intent?: number;
    session?: number;
    importance?: number;
    git?: number;
  };
};

export type ExactSourceEvidence = {
  file: string;
  symbol?: string;
  lines?: string;
  snippet?: string;
  expectedBehavior: string;
  invariant?: ContextInvariant;
  verificationCommand: string;
  tokenEstimate: number;
};

export type ContextInvariant = {
  file: string;
  symbol?: string;
  statement: string;
  evidence?: string;
  verificationCommand?: string;
  confidence: number;
  source: "seed" | "test" | "failure" | "symbol" | "heuristic";
};

export type InitResult = {
  rootPath: string;
  kairnDir: string;
  configPath: string;
  databasePath: string;
  scan: ScanResult;
  graph: RepoGraph;
  semantic: {
    chunks: number;
    vectors: number;
    documents?: number;
    embeddings?: number;
    modelId?: string;
    status?: "disabled" | "unavailable" | "corrupt" | "incompatible" | "ready";
    reusedEmbeddings?: number;
    createdEmbeddings?: number;
    error?: string;
  };
  state?: IndexStateStats;
};

export type ScoredFile = FileRecord & {
  score: number;
  reasons: string[];
};

export type HybridScoredResult = FileRecord & {
  score: number;
  reasons: string[];
  relevanceProbability?: number;
  probabilityGap?: number;
  rankerModelId?: string;
  featureSchemaVersion?: string;
  evidenceReasons?: EvidenceReason[];
  delivery?: EvidenceDelivery;
  rankerMode?: RankerMode | "fallback";
  rankerFallbackReason?: string;
  candidateGeneratorMode?: CandidateGeneratorMode | "fallback";
  semanticModelId?: string;
  semanticIndexStatus?: SemanticIndexStatus;
  semanticFallbackReason?: string;
  semanticScore: number;
  keywordScore: number;
  bm25Score: number;
  behaviorScore: number;
  graphScore: number;
  intentScore: number;
  sessionScore: number;
  importanceScore: number;
  gitScore: number;
  chunks: SemanticChunkRecord[];
};

export type ResponseDecision = {
  mode: ContextResponseMode;
  reason: string;
  warnings: string[];
};
