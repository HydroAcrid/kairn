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
  requiredTouchedFiles?: string[];
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

export type BenchmarkRepoSizeClass = "small" | "medium" | "large" | "huge";

export type BenchmarkMatrixGates = {
  maxStateMb?: number;
  maxPrimeLatencyMs?: number;
  expectedTopK?: number;
  requireSuppressionForWeakCases?: boolean;
};

export type BenchmarkRepoTarget = {
  id: string;
  name?: string;
  repoUrl?: string;
  ref?: string;
  cloneDepth?: number;
  localPath?: string;
  subdir?: string;
  language?: string;
  sizeClass?: BenchmarkRepoSizeClass;
  setupCommands?: string[];
  gates?: BenchmarkMatrixGates;
  cases: BenchmarkCase[];
};

export type BenchmarkRepoMatrix = {
  id: string;
  name: string;
  gates?: BenchmarkMatrixGates;
  repos: BenchmarkRepoTarget[];
};

export type BenchmarkMatrixCaseResult = {
  repoId: string;
  caseId: string;
  task: string;
  profile: string;
  expectedFiles: string[];
  returnedFiles: string[];
  missingExpectedFiles: string[];
  excludedFiles: string[];
  excludedHits: string[];
  primeTokens: number;
  primeLatencyMs: number;
  contextDecision?: string;
  qualityScore?: number;
  expectedTopKPassed: boolean;
  excludedFilesAvoided: boolean;
  suppressionPassed: boolean;
  qualityGatePassed: boolean;
  summary: string;
  recommendations: string[];
};

export type BenchmarkMatrixRepoResult = {
  repo: BenchmarkRepoTarget;
  rootPath?: string;
  status: "passed" | "failed" | "skipped";
  error?: string;
  index: {
    files: number;
    totalSizeBytes: number;
    totalSizeMb: number;
    softMaxSizeMb: number;
    hardMaxSizeMb: number;
    graphEdges: number;
    semanticChunks: number;
    lexicalTerms: number;
    tiers: Record<string, number>;
  };
  gates: Required<BenchmarkMatrixGates>;
  stateWithinLimit: boolean;
  cases: BenchmarkMatrixCaseResult[];
  weakestCases: BenchmarkMatrixCaseResult[];
  recommendations: string[];
};

export type BenchmarkMatrixReport = {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string;
  repos: BenchmarkMatrixRepoResult[];
  totals: {
    repos: number;
    passedRepos: number;
    failedRepos: number;
    skippedRepos: number;
    cases: number;
    qualityPassingCases: number;
    statePassingRepos: number;
  };
  recommendations: string[];
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
    qualityGatePassed?: boolean;
    validSavings?: number;
    invalidSavings?: number;
    negativeEvidenceReason?: string;
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
      qualityPassingReports?: number;
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
