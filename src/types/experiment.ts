// SPDX-License-Identifier: Apache-2.0

import type { BenchmarkDiffScope, BenchmarkSourceInvariant } from "./bench.js";

export type ExperimentCondition = "vanilla" | "reasonblocks" | "kairn" | "kairn_reasonblocks";

export type ExperimentLanguage = "python" | "typescript" | "go" | "java" | "cpp";

export type ExperimentTaskClass = "source_localization" | "failure_first" | "long_session";

export type ExperimentProfile = "smoke" | "pilot" | "publication";

export type AssistanceExpectation = "required" | "optional" | "abstain";

export type ExperimentDelivery = "path_hint" | "content";

export type ExperimentTraceEventKind =
  | "attempt_start"
  | "assistance_start"
  | "turn_start"
  | "provider_injection"
  | "model_request"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "file_edit"
  | "failure"
  | "verification"
  | "turn_end"
  | "attempt_end";

export type ExperimentTraceFile = {
  path: string;
  delivery: ExperimentDelivery;
  contentHash?: string | undefined;
  tokenEstimate?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
};

export type ExperimentTraceEvent = {
  schemaVersion: 1;
  attemptId: string;
  sequence: number;
  monotonicMs: number;
  turn: number;
  modelStep?: number | undefined;
  kind: ExperimentTraceEventKind;
  provider?: "kairn" | "reasonblocks" | undefined;
  tool?: string | undefined;
  action?: "emit" | "shrink" | "suppress" | "request_evidence" | undefined;
  files?: ExperimentTraceFile[] | undefined;
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  tokenEstimate?: number | undefined;
  latencyMs?: number | undefined;
  passed?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ExperimentTaskTurn = {
  id: string;
  prompt: string;
  assistanceExpectation?: AssistanceExpectation | undefined;
};

export type ExperimentTask = {
  id: string;
  repoUrl: string;
  ref: string;
  publicRepo: true;
  language: ExperimentLanguage;
  taskClass: ExperimentTaskClass;
  prompt: string;
  turns?: ExperimentTaskTurn[] | undefined;
  requiredSourceFiles: string[];
  allowedSupportFiles?: string[] | undefined;
  explicitNoisePatterns?: string[] | undefined;
  requiredTouchedFiles?: string[] | undefined;
  sourceInvariants?: BenchmarkSourceInvariant[] | undefined;
  allowedDiffScopes?: BenchmarkDiffScope[] | undefined;
  assistanceExpectation?: AssistanceExpectation | undefined;
  setupCommands?: string[] | undefined;
  setupPatch?: string | undefined;
  setupPatchFile?: string | undefined;
  sandboxImage?: string | undefined;
  initialFailureCommand?: string | undefined;
  verificationCommand: string;
};

export type ExperimentPlan = {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string | undefined;
  profile?: ExperimentProfile | undefined;
  conditions?: ExperimentCondition[] | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  maxSteps?: number | undefined;
  maxTokensPerResponse?: number | undefined;
  timeoutMs?: number | undefined;
  repeats?: number | undefined;
  pythonCommand?: string | undefined;
  kairnCommand?: string | undefined;
  tasks: ExperimentTask[];
};

export type ExperimentAttemptPlan = {
  id: string;
  campaignId: string;
  taskId: string;
  condition: ExperimentCondition;
  repeat: number;
  order: number;
  blockId: string;
};

export type ExperimentDockerImageProvenance = {
  requestedImage: string;
  id: string;
  repoDigests: string[];
  os: string;
  architecture: string;
};

export type ExperimentHostRuntimeFingerprint = {
  nodeVersion: string;
  v8Version: string;
  platform: string;
  architecture: string;
  osType: string;
  osRelease: string;
  endianness: string;
  cpuModel: string;
  logicalCpuCount: number;
  pythonVersion: string;
  dockerClientVersion?: string | undefined;
  dockerServerVersion?: string | undefined;
  dockerServerOs?: string | undefined;
  dockerServerArchitecture?: string | undefined;
};

export type ExperimentExecutionEnvironment = {
  schemaVersion: 1;
  verified: boolean;
  hostRuntime: ExperimentHostRuntimeFingerprint;
  dockerImages: ExperimentDockerImageProvenance[];
  hash: string;
};

export type ExperimentAttemptMetrics = {
  requiredSourceFound: boolean;
  requiredSourceMissRate: number;
  timeToFirstRequiredPathHintMs?: number | undefined;
  timeToFirstRequiredContentMs?: number | undefined;
  modelTokensBeforeFirstRequiredPathHint?: number | undefined;
  modelTokensBeforeFirstRequiredContent?: number | undefined;
  modelCallsBeforeFirstRequiredContent: number;
  searchCallsBeforeFirstRequiredContent: number;
  estimatedFirstEvidencePayloadTokens?: number | undefined;
  totalModelTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedToolResultTokens: number;
  estimatedRepositoryContentTokens: number;
  estimatedProviderInjectionTokens: number;
  estimatedKairnGuidanceTokens: number;
  estimatedReasonblocksGuidanceTokens: number;
  estimatedVerificationTokens: number;
  requiredSourceContentRecall: number;
  requiredSourceToolReadRecall: number;
  explicitNoiseFilesOpened: number;
  excludedFilesTouched: number;
  extraneousFilesOpened: number;
  explicitNoiseReadEvents: number;
  estimatedUnnecessaryEmissionTokens: number;
  emissionRate: number;
  suppressionRate: number;
  crossTurnRepeatReadEvents: number;
  avoidableCrossTurnRepeatReadEvents: number;
  estimatedAvoidableRepeatReadTokens: number;
  coldIndexingMs?: number | undefined;
  coldKairnResponseMs?: number | undefined;
  medianWarmKairnResponseMs?: number | undefined;
  kairnSetupMs?: number | undefined;
  reasonblocksSetupMs?: number | undefined;
  kairnStateBytes?: number | undefined;
  hostCpuMs?: number | undefined;
  hostPeakRssBytes?: number | undefined;
  directChildCpuMs?: number | undefined;
  directChildPeakRssBytes?: number | undefined;
  finalVerifierPassed: boolean;
  requiredTouchedPassed: boolean;
  sourceInvariantPassed: boolean;
  diffScopePassed: boolean;
  qualityGatePassed: boolean;
};

export type ExperimentAttemptResult = {
  attempt: ExperimentAttemptPlan;
  task: Pick<ExperimentTask, "id" | "language" | "taskClass" | "repoUrl" | "ref">;
  runId: string;
  executionId?: string | undefined;
  executionEnvironmentHash?: string | undefined;
  workspaceTreeDigest?: string | undefined;
  resolvedRepoCommit?: string | undefined;
  status: "planned" | "passed" | "failed" | "invalid" | "infrastructure_failure";
  startedAt: string;
  endedAt: string;
  workspaceSetupMs: number;
  providerSetupMs: number;
  kairnSetupMs?: number | undefined;
  reasonblocksSetupMs?: number | undefined;
  onlineMs: number;
  totalMs: number;
  traceValid: boolean;
  invalidReasons: string[];
  metrics: ExperimentAttemptMetrics;
  tracePath?: string | undefined;
  traceDigest?: string | undefined;
  error?: string | undefined;
};

export type ExperimentConditionAggregate = {
  condition: ExperimentCondition;
  attempts: number;
  validAttempts: number;
  qualityPasses: number;
  qualityPassRate: number;
  requiredSourceFoundRate: number;
  requiredSourceContentRecall: number;
  medianTotalModelTokens: number;
  medianUncachedInputTokens: number;
  medianCacheCreationInputTokens: number;
  medianCachedInputTokens: number;
  medianOutputTokens: number;
  medianEstimatedToolResultTokens: number;
  medianTokensBeforeRequiredSource: number;
  medianTimeToRequiredSourceMs: number;
  medianEstimatedRepositoryContentTokens: number;
  medianEstimatedKairnGuidanceTokens: number;
  medianEstimatedReasonblocksGuidanceTokens: number;
  medianEstimatedVerificationTokens: number;
  explicitNoiseFilesOpened: number;
  excludedFilesTouched: number;
  extraneousFilesOpened: number;
  estimatedUnnecessaryEmissionTokens: number;
  estimatedAvoidableRepeatReadTokens: number;
  medianColdIndexingMs: number;
};

export type ExperimentPairMetricEffect = {
  pairCount: number;
  medianSignedDelta: number;
};

export type ExperimentPairMetricEffects = {
  totalModelTokens: ExperimentPairMetricEffect;
  modelTokensBeforeFirstRequiredPathHint: ExperimentPairMetricEffect;
  timeToFirstRequiredPathHintMs: ExperimentPairMetricEffect;
  modelTokensBeforeFirstRequiredContent: ExperimentPairMetricEffect;
  timeToFirstRequiredContentMs: ExperimentPairMetricEffect;
  explicitNoiseFilesOpened: ExperimentPairMetricEffect;
  explicitNoiseReadEvents: ExperimentPairMetricEffect;
  extraneousFilesOpened: ExperimentPairMetricEffect;
  requiredSourceContentRecall: ExperimentPairMetricEffect;
  requiredSourceToolReadRecall: ExperimentPairMetricEffect;
  estimatedToolResultTokens: ExperimentPairMetricEffect;
  estimatedRepositoryContentTokens: ExperimentPairMetricEffect;
  estimatedProviderInjectionTokens: ExperimentPairMetricEffect;
  estimatedKairnGuidanceTokens: ExperimentPairMetricEffect;
  estimatedReasonblocksGuidanceTokens: ExperimentPairMetricEffect;
  estimatedUnnecessaryEmissionTokens: ExperimentPairMetricEffect;
  crossTurnRepeatReadEvents: ExperimentPairMetricEffect;
  avoidableCrossTurnRepeatReadEvents: ExperimentPairMetricEffect;
  estimatedAvoidableRepeatReadTokens: ExperimentPairMetricEffect;
};

export type ExperimentPairComparison = {
  id: string;
  baseline: ExperimentCondition;
  treatment: ExperimentCondition;
  scheduledBlocks: number;
  protocolValidPairs: number;
  qualityEligiblePairs: number;
  qualityIneligiblePairs: number;
  medianSignedTotalTokenDelta: number;
  medianTokenReductionPercent: number;
  signedTotalTokenDeltaCi95: { lower: number; upper: number } | null;
  improvements: number;
  regressions: number;
  ties: number;
  metricEffects: ExperimentPairMetricEffects;
};

export type ExperimentStratumAggregate = {
  language: ExperimentLanguage;
  taskClass: ExperimentTaskClass;
  attempts: number;
  aggregates: ExperimentConditionAggregate[];
  comparisons: ExperimentPairComparison[];
};

export type ExperimentReport = {
  schemaVersion: 1;
  id: string;
  name: string;
  generatedAt: string;
  planHash: string;
  runId: string;
  seed: number;
  dryRun: boolean;
  externalTrajectoryAllowed: boolean;
  model: string;
  conditions: ExperimentCondition[];
  attempts: ExperimentAttemptResult[];
  aggregates: ExperimentConditionAggregate[];
  strata: ExperimentStratumAggregate[];
  comparisons: ExperimentPairComparison[];
  expectedAttemptCount: number;
  protocolComplete: boolean;
  executionEnvironment?: ExperimentExecutionEnvironment | undefined;
  outputs: {
    manifestPath: string;
    attemptsPath: string;
    resultsCsvPath: string;
    failuresCsvPath: string;
    aggregatePath: string;
    markdownPath: string;
    publicEvidencePath: string;
  };
};

export type PublicEvidenceV1 = {
  schemaVersion: "public-evidence.v1";
  campaign: {
    id: string;
    generatedAt: string;
    planHash: string;
    seed: number;
    model: string;
    conditions: ExperimentCondition[];
    repeats: number;
    taskCount: number;
    expectedAttemptCount: number;
    languages: ExperimentLanguage[];
    taskClasses: ExperimentTaskClass[];
    status: "methodology_only" | "complete" | "partial";
  };
  provenance: {
    kairnCommit?: string | undefined;
    kairnPackageVersion: string;
    harnessHash: string;
    toolSchemaHash: string;
    rankerModelId?: string | undefined;
    rankerModelHash?: string | undefined;
    taskManifestHash: string;
    anthropicVersion?: string | undefined;
    reasonblocksVersion?: string | undefined;
    reasonblocksServiceVersion?: string | undefined;
    reasonblocksServiceVersionSource?: "operator_asserted" | undefined;
    pythonVersion?: string | undefined;
    executionEnvironmentHash?: string | undefined;
    hostRuntime?: ExperimentHostRuntimeFingerprint | undefined;
    externalTrajectoryAllowed: boolean;
  };
  arms: Array<{
    condition: ExperimentCondition;
    kairn: boolean;
    reasonblocks: boolean;
    guidanceOrder: Array<"kairn" | "reasonblocks">;
  }>;
  repositories: Array<{
    taskId: string;
    repoUrl: string;
    commit: string;
    sandboxImage?: string | undefined;
    sandboxImageId?: string | undefined;
    sandboxRepoDigests?: string[] | undefined;
    sandboxOs?: string | undefined;
    sandboxArchitecture?: string | undefined;
    language: ExperimentLanguage;
    taskClass: ExperimentTaskClass;
  }>;
  definitions: Record<string, string>;
  attempts: Array<{
    id: string;
    taskId: string;
    condition: ExperimentCondition;
    language: ExperimentLanguage;
    taskClass: ExperimentTaskClass;
    repeat: number;
    blockId: string;
    order: number;
    status: ExperimentAttemptResult["status"];
    startedAt: string;
    endedAt: string;
    traceValid: boolean;
    executionId?: string | undefined;
    executionEnvironmentHash?: string | undefined;
    workspaceTreeDigest?: string | undefined;
    traceDigest?: string | undefined;
    invalidReasons: string[];
    qualityFailures: string[];
    resolvedRepoCommit?: string | undefined;
    error?: string | undefined;
    metrics: ExperimentAttemptMetrics;
  }>;
  aggregates: ExperimentConditionAggregate[];
  strata: ExperimentStratumAggregate[];
  comparisons: ExperimentPairComparison[];
  exclusions: Array<{ attemptId: string; reasons: string[] }>;
  artifactUrl?: string | undefined;
  checksum: string;
};
