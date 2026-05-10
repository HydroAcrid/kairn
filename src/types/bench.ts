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

export type BenchmarkAssistanceStatus = "none" | "active" | "passive_suppressed";

export type BenchmarkBaselineDifficulty = "unknown" | "cheap_pass" | "expensive_pass" | "quality_fail";

export type BenchmarkAbstentionOutcome =
  | "not_applicable"
  | "correct_abstention"
  | "missed_savings_opportunity"
  | "missed_quality_opportunity"
  | "passive_quality_regression";

export type BenchmarkAssistClassification =
  | "baseline"
  | "valid_assist"
  | "over_assist"
  | "harmful_invalid_assist"
  | "correct_abstention"
  | "missed_savings_opportunity"
  | "missed_quality_opportunity"
  | "passive_quality_regression"
  | "neutral";

export type BenchmarkContextBehavior =
  | "cheap_single_source"
  | "source_rescue"
  | "multi_file_debug"
  | "failure_first"
  | "session_repeat"
  | "weak_signal";

export type BenchmarkBehaviorTargetOutcome = "met" | "missed" | "not_applicable";

export type BenchmarkCase = {
  id: string;
  task: string;
  mode: BenchmarkCaseMode;
  query?: string;
  target?: string;
  contextBehavior?: BenchmarkContextBehavior;
  expectedFiles: string[];
  requiredTouchedFiles?: string[];
  excludedFiles: string[];
  budget?: number;
  successCriteria?: string[];
  agentPrompt?: string;
  allowedCommands?: string[];
  seed?: BenchmarkSeedSpec;
};

export type BenchmarkEnduranceTurn = {
  id: string;
  task: string;
  agentPrompt?: string;
  expectedFiles: string[];
  requiredTouchedFiles?: string[];
  excludedFiles: string[];
  verificationCommand?: string;
  sourceInvariants?: BenchmarkSourceInvariant[];
  allowedDiffScopes?: BenchmarkDiffScope[];
  budget?: number;
};

export type BenchmarkEnduranceSuite = {
  id: string;
  name: string;
  task: string;
  seed?: BenchmarkSeedSpec;
  turns: BenchmarkEnduranceTurn[];
  finalVerificationCommand?: string;
  finalSourceInvariants?: BenchmarkSourceInvariant[];
  allowedDiffScopes?: BenchmarkDiffScope[];
};

export type BenchmarkSourceInvariant = {
  id?: string;
  file: string;
  description?: string;
  requiredPresent?: string[];
  requiredAbsent?: string[];
  requiredRegex?: string[];
  requiredAny?: string[];
  requiredAnyRegex?: string[];
};

export type BenchmarkDiffScope = {
  file: string;
  symbols?: string[];
  allowWholeFile?: boolean;
};

export type BenchmarkEnduranceTurnResult = {
  turnId: string;
  mode: "baseline" | "kairn" | "mcp";
  outcome: BenchmarkTaskOutcome;
  observedCodexTokens?: number;
  responseTokens: number;
  elapsedMs: number;
  actualFiles: string[];
  agentTouchedFiles: string[];
  expectedFiles: string[];
  missingExpectedFiles: string[];
  requiredTouchedSatisfied: boolean;
  qualityGatePassed: boolean;
  repeatedFilesAvoided: number;
  repeatedSnippetsAvoided: number;
  summary: string;
  metadata: Record<string, unknown>;
};

export type BenchmarkEnduranceModeReport = {
  mode: "baseline" | "kairn" | "mcp";
  workspacePath: string;
  sessionId?: string;
  turns: BenchmarkEnduranceTurnResult[];
  totalObservedCodexTokens?: number;
  totalResponseTokens: number;
  totalElapsedMs: number;
  qualityGatePassed: boolean;
  finalVerificationPassed: boolean;
  assistanceStatus: BenchmarkAssistanceStatus;
  assistanceActions: {
    emitted: number;
    shrunk: number;
    suppressed: number;
    mcpCalls: number;
    failureContexts: number;
  };
  metadata?: Record<string, unknown>;
  ledger?: import("./ledger.js").SessionLedgerSummary;
};

export type BenchmarkEnduranceReport = {
  suiteId: string;
  suiteName: string;
  startedAt: string;
  endedAt: string;
  reports: BenchmarkEnduranceModeReport[];
  deltas: Record<string, {
    baselineTokens?: number;
    modeTokens?: number;
    savedTokens?: number;
    savingsRate?: number;
    qualityGatePassed: boolean;
    assistanceStatus: BenchmarkAssistanceStatus;
    assistanceEligible: boolean;
    baselineDifficulty: BenchmarkBaselineDifficulty;
    baselineTokenCost?: number;
    abstentionOutcome: BenchmarkAbstentionOutcome;
    missedOpportunity: boolean;
    overAssist: boolean;
    harmfulAssist: boolean;
    assistClassification: BenchmarkAssistClassification;
    validSavings?: number;
    invalidSavings?: number;
    passiveSavings?: number;
    negativeEvidenceReason?: string;
  }>;
  recommendations: string[];
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
  absentExpectedFiles?: string[];
  returnedFiles: string[];
  missingExpectedFiles: string[];
  companionFilesReturned?: string[];
  missingCompanionFiles?: string[];
  excludedFiles: string[];
  excludedHits: string[];
  noisePrefixHits?: string[];
  sourceVsTestDecision?: string;
  companionReasons?: Record<string, string[]>;
  primeTokens: number;
  primeLatencyMs: number;
  timings?: Record<string, number>;
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
    assistanceStatus?: BenchmarkAssistanceStatus;
    assistanceEligible?: boolean;
    baselineDifficulty?: BenchmarkBaselineDifficulty;
    baselineTokenCost?: number;
    abstentionOutcome?: BenchmarkAbstentionOutcome;
    missedOpportunity?: boolean;
    overAssist?: boolean;
    harmfulAssist?: boolean;
    assistClassification?: BenchmarkAssistClassification;
    validSavings?: number;
    invalidSavings?: number;
    passiveSavings?: number;
    negativeEvidenceReason?: string;
  };
  behaviorTargetSummary?: Partial<Record<BenchmarkContextBehavior, {
    cases: number;
    met: number;
    missed: number;
  }>>;
  caseBehaviorOutcomes?: Array<{
    caseId: string;
    behavior: BenchmarkContextBehavior;
    outcome: BenchmarkBehaviorTargetOutcome;
    reason: string;
    baselineTokens?: number;
    afterTokens?: number;
    savedTokens?: number;
    savingsRate?: number;
    assistanceStatus: BenchmarkAssistanceStatus;
    assistClassification: BenchmarkAssistClassification;
  }>;
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
  abstentionSummary?: Partial<Record<BenchmarkAssistClassification, number>>;
  behaviorTargetSummary?: Partial<Record<BenchmarkContextBehavior, {
    cases: number;
    met: number;
    missed: number;
  }>>;
  caseRepeatClassifications?: Array<{
    mode: BenchmarkAssistanceMode;
    caseId: string;
    repeats: number;
    qualityPasses: number;
    activeRuns: number;
    suppressedRuns: number;
    baselineMedianTokens?: number;
    modeMedianTokens?: number;
    medianSavedTokens?: number;
    medianSavingsRate?: number;
    classifications: Partial<Record<BenchmarkAssistClassification, number>>;
    verdict:
      | "insufficient_data"
      | "consistent_win"
      | "consistent_abstention"
      | "missed_opportunity"
      | "over_assist"
      | "quality_risk"
      | "volatile";
    recommendation: string;
  }>;
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
