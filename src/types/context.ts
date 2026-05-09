import type { FileRecord, IndexStateStats, RepoGraph, ScanResult, SemanticChunkRecord } from "./graph.js";
import type { TaskSession } from "./runtime.js";

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

export type CodexSetupMode = "savings" | "observe" | "debug" | "mcp-first" | "hybrid";

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
  quality?: PrimeQuality;
  contextDecision?: ContextValueDecision;
  timings?: Record<string, number>;
  warnings: string[];
  suggestedCommands: string[];
};

export type PrimeQualityAction = "emit" | "shrink" | "suppress";

export type ContextValueAction = "emit" | "shrink" | "suppress";

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
  language: "typescript" | "javascript" | "python" | "java" | "cpp" | "c" | "unknown";
  exactPathMentioned: boolean;
  estimatedContextCost: number;
  expectedSavingsRisk: "low" | "medium" | "high";
  debugSignal: boolean;
  easyTaskSignal: boolean;
  wrongContextRisk?: boolean;
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
  tokenEstimate: number;
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
