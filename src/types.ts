export type SessionStatus = "active" | "completed" | "abandoned";

export type FileKind =
  | "source"
  | "test"
  | "config"
  | "route"
  | "component"
  | "schema"
  | "doc"
  | "style"
  | "unknown";

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

export type WatchEventSource = "watch" | "generic" | "claude" | "codex";

export type WatchEventKind = "file_change" | "diff_change" | "command" | "tool" | "session" | "hook" | "failure";

export type MetricsEventKind =
  | "find_context"
  | "read_file"
  | "read_symbol"
  | "related"
  | "tests"
  | "diff"
  | "failure_context"
  | "compression"
  | "hook_signal"
  | "prime_context"
  | "prime_quality"
  | "mcp_tool_call";

export type EvalRunMode = "baseline" | "kairn" | "manual";

export type EvalRunStatus = "active" | "completed" | "abandoned";

export type EvalObservationKind =
  | "codex_usage"
  | "hook_summary"
  | "command_summary"
  | "artifact"
  | "manual_outcome"
  | "hook_signal_stats"
  | "agent_file_usage"
  | "retrieval_feedback";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "let"
  | "var"
  | "component"
  | "default"
  | "unknown";

export type GraphEdgeType =
  | "imports"
  | "imported_by"
  | "test_for"
  | "tested_by"
  | "parent_route"
  | "definition"
  | "reference"
  | "call"
  | "type_reference"
  | "implementation";

export type SemanticChunkKind = "symbol" | "file_summary";

export type ContextQueryMode = "brief" | "snippets" | "summary" | "exact";

export type PrimeProfile = "auto" | "ui" | "workflow" | "backend" | "test" | "generic";

export type CodexSetupMode = "savings" | "observe" | "debug" | "mcp-first" | "hybrid";

export type HookOutputProfile = "full-prime" | "tiny-directive" | "failure-only" | "mcp-brief";

export type FileRecord = {
  rootPath: string;
  path: string;
  language: string;
  kind: FileKind;
  size: number;
  hash: string;
  importance: number;
  updatedAt: string;
};

export type SymbolRecord = {
  rootPath: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  signature: string;
};

export type GraphEdgeRecord = {
  rootPath: string;
  fromFile: string;
  toFile: string;
  type: GraphEdgeType;
  metadata: Record<string, unknown>;
};

export type ParsedFile = {
  rootPath: string;
  filePath: string;
  language: string;
  symbols: SymbolRecord[];
  imports: string[];
  hasErrors: boolean;
};

export type RepoGraph = {
  rootPath: string;
  files: FileRecord[];
  parsedFiles: ParsedFile[];
  symbols: SymbolRecord[];
  edges: GraphEdgeRecord[];
};

export type SemanticChunkRecord = {
  rootPath: string;
  id: string;
  filePath: string;
  kind: SemanticChunkKind;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  text: string;
  hash: string;
  tokenEstimate: number;
};

export type SemanticVectorRecord = {
  rootPath: string;
  chunkId: string;
  dimensions: number;
  vector: number[];
};

export type LexicalDocumentRecord = {
  rootPath: string;
  id: string;
  filePath: string;
  kind: "file" | "symbol" | "chunk";
  symbol?: string;
  length: number;
  tokenEstimate: number;
  hash: string;
};

export type LexicalTermRecord = {
  rootPath: string;
  term: string;
  documentId: string;
  filePath: string;
  frequency: number;
};

export type LexicalStatsRecord = {
  rootPath: string;
  documentCount: number;
  averageDocumentLength: number;
};

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

export type WatchEventRecord = {
  id?: number;
  sessionId: string;
  source: WatchEventSource;
  kind: WatchEventKind;
  eventName: string;
  toolName?: string;
  command?: string;
  files: string[];
  exitCode?: number;
  summary: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type HostSessionLinkRecord = {
  source: WatchEventSource;
  rootPath: string;
  hostSessionId: string;
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
};

export type MetricsEventRecord = {
  id?: number;
  sessionId: string;
  rootPath: string;
  eventKind: MetricsEventKind;
  eventName: string;
  source: WatchEventSource | "runtime" | "cli" | "mcp";
  responseMode?: ContextResponseMode;
  baselineTokens: number;
  outputTokens: number;
  savedTokens: number;
  files: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type MetricsBucket = {
  events: number;
  baselineTokens: number;
  outputTokens: number;
  savedTokens: number;
};

export type MetricsSummary = {
  sessionId: string;
  rootPath: string;
  totals: MetricsBucket & {
    savingsRate: number;
  };
  byKind: Record<string, MetricsBucket>;
  bySource: Record<string, MetricsBucket>;
  watch: {
    events: number;
    failures: number;
    fileChanges: number;
    hooks: number;
  };
  observed: {
    evalRuns: number;
    observations: number;
    latestCodexUsage?: CodexUsageRecord;
  };
  coordination: {
    duplicateContextAvoided: number;
    hookFiles: string[];
    mcpFiles: string[];
    overlapFiles: string[];
  };
  recentEvents: MetricsEventRecord[];
};

export type EvalRunRecord = {
  id: string;
  sessionId?: string;
  rootPath: string;
  task: string;
  label: string;
  mode: EvalRunMode;
  status: EvalRunStatus;
  startedAt: string;
  endedAt?: string;
  metadata: Record<string, unknown>;
};

export type EvalObservationRecord = {
  id?: number;
  runId: string;
  sessionId?: string;
  kind: EvalObservationKind;
  summary: string;
  metrics: Record<string, unknown>;
  files: string[];
  contentHash: string;
  createdAt: string;
};

export type CodexUsageRecord = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model?: string;
  hostSessionId?: string;
  turnId?: string;
  transcriptPath?: string;
  transcriptHash?: string;
  source: "footer" | "transcript" | "footer+transcript";
};

export type EvalRunReport = {
  run: EvalRunRecord;
  observations: EvalObservationRecord[];
  codexUsage?: CodexUsageRecord;
  estimatedMetrics?: MetricsSummary;
  watch: {
    events: number;
    failures: number;
    fileChanges: number;
    hooks: number;
  };
};

export type EvalComparison = {
  baseline: EvalRunReport;
  kairn: EvalRunReport;
  observedTokenDelta?: {
    baselineTokens: number;
    kairnTokens: number;
    savedTokens: number;
    savingsRate: number;
  };
  estimatedKairnSavings: MetricsBucket & {
    savingsRate: number;
  };
  outcomeNotes: EvalObservationRecord[];
};

export type BenchmarkRunMode = "replay" | "agent" | "hybrid";

export type BenchmarkAssistanceMode =
  | "baseline"
  | "prompt_only"
  | "prompt_plus_hooks"
  | "manual_prime"
  | "hook_full_prime"
  | "hook_tiny_directive"
  | "hook_tiny_with_failures"
  | "mcp_first"
  | "real_mcp_first"
  | "mcp_first_plus_hook_full_prime"
  | "hybrid_mcp_brief"
  | "passive_hooks"
  | "proactive";

export type BenchmarkCaseMode = "context" | "related" | "tests" | "diff" | "hook" | "agent";

export type BenchmarkRunStatus = "active" | "completed" | "abandoned";

export type BenchmarkTaskOutcome = "pass" | "fail" | "partial" | "skipped";

export type BenchmarkCase = {
  id: string;
  task: string;
  mode: BenchmarkCaseMode;
  query?: string;
  target?: string;
  expectedFiles: string[];
  excludedFiles: string[];
  budget?: number;
  successCriteria?: string[];
  agentPrompt?: string;
  allowedCommands?: string[];
  seed?: BenchmarkSeedSpec;
};

export type BenchmarkSuite = {
  id: string;
  name: string;
  cases: BenchmarkCase[];
};

export type BenchmarkSeedSpec = {
  repoUrl: string;
  ref?: string;
  cloneDepth?: number;
  setupCommands?: string[];
  setupPatch?: string;
  setupPatchFile?: string;
  expectedFailureCommand?: string;
  testCommand?: string;
};

export type BenchmarkRunRecord = {
  id: string;
  rootPath: string;
  suiteId: string;
  suiteName: string;
  mode: BenchmarkRunMode;
  status: BenchmarkRunStatus;
  startedAt: string;
  endedAt?: string;
  metadata: Record<string, unknown>;
};

export type BenchmarkResultRecord = {
  id?: number;
  runId: string;
  caseId: string;
  caseMode: BenchmarkCaseMode;
  score: number;
  expectedFileRecall: number;
  topKHitRate: number;
  unexpectedFileRate: number;
  responseTokens: number;
  observedCodexTokens?: number;
  hookContextEmitted: number;
  hookContextSuppressed: number;
  taskOutcome: BenchmarkTaskOutcome;
  expectedFiles: string[];
  actualFiles: string[];
  excludedFiles: string[];
  summary: string;
  recommendations: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type BenchmarkReport = {
  run: BenchmarkRunRecord;
  results: BenchmarkResultRecord[];
  overallScore: number;
  observed?: {
    codexTokens: number;
    codexCaseCount: number;
  };
  weakestCases: BenchmarkResultRecord[];
  recommendations: string[];
};

export type BenchmarkComparison = {
  before: BenchmarkReport;
  after: BenchmarkReport;
  scoreDelta: number;
  observedTokenDelta?: {
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    savingsRate: number;
  };
  improvedCases: string[];
  regressedCases: string[];
  recommendations: string[];
};

export type BenchmarkProofReport = {
  baseline: BenchmarkReport;
  promptOnly?: BenchmarkReport;
  promptPlusHooks?: BenchmarkReport;
  manualPrime?: BenchmarkReport;
  hookFullPrime?: BenchmarkReport;
  hookTinyDirective?: BenchmarkReport;
  hookTinyWithFailures?: BenchmarkReport;
  mcpFirst?: BenchmarkReport;
  realMcpFirst?: BenchmarkReport;
  mcpFirstPlusHookFullPrime?: BenchmarkReport;
  hybridMcpBrief?: BenchmarkReport;
  passiveHooks: BenchmarkReport;
  proactive: BenchmarkReport;
  runs?: Partial<Record<BenchmarkAssistanceMode, BenchmarkReport[]>>;
  aggregate?: {
    repeat: number;
    modes: Partial<Record<BenchmarkAssistanceMode, {
      reports: number;
      meanTokens?: number;
      medianTokens?: number;
      caseCount: number;
    }>>;
    deltas: Partial<Record<string, {
      beforeMedianTokens?: number;
      afterMedianTokens?: number;
      savedTokens?: number;
      savingsRate?: number;
    }>>;
  };
  observedTokenDeltas: {
    passiveVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    proactiveVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    proactiveVsPassive?: BenchmarkComparison["observedTokenDelta"];
    promptOnlyVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    promptPlusHooksVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    manualPrimeVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    hookFullPrimeVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    hookTinyDirectiveVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    hookTinyWithFailuresVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    mcpFirstVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    realMcpFirstVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    mcpFirstPlusHookFullPrimeVsBaseline?: BenchmarkComparison["observedTokenDelta"];
    hybridMcpBriefVsBaseline?: BenchmarkComparison["observedTokenDelta"];
  };
  caseDeltas: Array<{
    caseId: string;
    baselineTokens?: number;
    passiveHooksTokens?: number;
    proactiveTokens?: number;
    proactiveVsBaseline?: number;
    proactiveVsPassive?: number;
    outcome: {
      baseline: BenchmarkTaskOutcome;
      passiveHooks: BenchmarkTaskOutcome;
      proactive: BenchmarkTaskOutcome;
    };
  }>;
  recommendations: string[];
};

export type ContextPrime = {
  session: TaskSession;
  task: string;
  profile: Exclude<PrimeProfile, "auto">;
  content: string;
  files: string[];
  tokenEstimate: number;
  quality?: PrimeQuality;
  warnings: string[];
  suggestedCommands: string[];
};

export type PrimeQualityAction = "emit" | "shrink" | "suppress";

export type PrimeQuality = {
  score: number;
  action: PrimeQualityAction;
  reasons: string[];
  topScore: number;
  topGap: number;
  exactPathMentioned: boolean;
  expectedSavingsRisk: "low" | "medium" | "high";
};

export type TaskSession = {
  id: string;
  rootPath: string;
  task: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  filesShown: ContextShownRecord[];
  symbolsShown: ContextShownRecord[];
  commandsRun: CommandRecord[];
  diffsObserved: DiffRecord[];
  watchEvents: WatchEventRecord[];
  risks: string[];
  verificationHints: string[];
};

export type NormalizedHookEvent = {
  source: WatchEventSource;
  eventName: string;
  kind: WatchEventKind;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  command?: string;
  output?: string;
  exitCode?: number;
  files: string[];
  cwd?: string;
  timestamp?: string;
  hostSessionId?: string;
  metadata: Record<string, unknown>;
};

export type WatchRecommendation = {
  summary: string;
  files: string[];
  suggestedNextContext: string[];
  warnings: string[];
  content?: string;
};

export type FailureContext = {
  session: TaskSession;
  type: OutputKind;
  content: string;
  files: string[];
  failureFiles: string[];
  relatedFiles: string[];
  testFiles: string[];
  changedFiles: string[];
  tokenEstimate: number;
  warnings: string[];
};

export type WatchSnapshot = {
  sessionId: string;
  rootPath: string;
  changedFiles: string[];
  indexedFiles: number;
  watchEvents: WatchEventRecord[];
  recommendations: WatchRecommendation[];
  createdAt: string;
};

export type HookHandlingResult = {
  session: TaskSession;
  event: WatchEventRecord;
  recommendation?: WatchRecommendation;
  response?: ContextResponse;
  failureContext?: FailureContext;
  prime?: ContextPrime;
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

export type ScanResult = {
  rootPath: string;
  files: FileRecord[];
  ignoredCount: number;
  scannedAt: string;
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
