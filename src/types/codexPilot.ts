// SPDX-License-Identifier: Apache-2.0

import type { ExperimentTask } from "./experiment.js";

export type CodexPilotCondition = "vanilla_codex" | "codex_kairn";
export type CodexPilotProfile = "smoke" | "pilot";
export type CodexPilotStage = "smoke" | "first_repeat" | "complete";

export type CodexPilotPin = {
  package: "@openai/codex";
  version: "0.145.0";
  integrity: "sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==";
  model: "gpt-5.6";
  reasoningEffort: "medium";
  serviceTier: "standard";
  fastMode: false;
};

export type CodexPilotKairnPin = {
  candidateMode: "semantic";
  semanticModelId: "jina-code-v2-q8";
  semanticModelManifestSha256: string;
  rankerMode: "calibrated";
  rankerModelId: "kairn-semantic-rc-v185";
  rankerArtifactChecksum: string;
  featureSchemaVersion: "evidence-features-v5";
};

export type CodexPilotPlan = {
  schemaVersion: "codex-pilot.v1" | "codex-pilot.v2";
  id: string;
  name: string;
  sealed: true;
  profile: CodexPilotProfile;
  lineageRegistry: string;
  conditions: CodexPilotCondition[];
  codex: CodexPilotPin;
  kairn?: CodexPilotKairnPin | undefined;
  repeats: number;
  timeoutMs: number;
  tasks: ExperimentTask[];
};

export type CodexPilotAttemptPlan = {
  id: string;
  campaignId: string;
  taskId: string;
  condition: CodexPilotCondition;
  repeat: number;
  order: number;
  blockId: string;
};

export type CodexPilotUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type CodexPilotFileAccess = {
  path: string;
  operation: "read" | "write" | "execute";
  turn: number;
  unchangedRepeat: boolean;
};

export type CodexPilotAttemptResult = {
  attempt: CodexPilotAttemptPlan;
  task: Pick<ExperimentTask, "id" | "repoUrl" | "ref" | "language" | "taskClass">;
  status: "planned" | "passed" | "failed" | "invalid" | "infrastructure_failure";
  startedAt: string;
  endedAt: string;
  traceValid: boolean;
  invalidReasons: string[];
  resolvedCommit?: string | undefined;
  checkoutTreeHash?: string | undefined;
  finalTreeHash?: string | undefined;
  transcriptSha256?: string | undefined;
  syscallTraceSha256?: string | undefined;
  usage: CodexPilotUsage;
  fileAccesses: CodexPilotFileAccess[];
  requiredSourcePathSeen: boolean;
  requiredSourceContentAccessed: boolean;
  requiredSourceAccessRecall: number;
  explicitNoiseFilesOpened: number;
  extraneousFilesOpened: number;
  repeatedUnchangedReadEvents: number;
  kairnPayloadTokens: number;
  timeToFirstRequiredPathMs?: number | undefined;
  timeToFirstRequiredContentMs?: number | undefined;
  tokensBeforeFirstRequiredPath?: number | undefined;
  tokensBeforeFirstRequiredContent?: number | undefined;
  verificationPassed: boolean;
  requiredTouchedPassed: boolean;
  sourceInvariantPassed: boolean;
  diffScopePassed: boolean;
  qualityGatePassed: boolean;
  error?: string | undefined;
};

export type CodexPilotReport = {
  schemaVersion: "codex-pilot-report.v1";
  campaignId: string;
  generatedAt: string;
  profile: CodexPilotProfile;
  stage: CodexPilotStage;
  seed: number;
  planSha256: string;
  codex: CodexPilotPin;
  kairn?: CodexPilotKairnPin | undefined;
  dryRun: boolean;
  expectedAttemptCount: number;
  completedAttemptCount: number;
  validAttemptCount: number;
  protocolComplete: boolean;
  attempts: CodexPilotAttemptResult[];
  outputs: {
    manifestPath: string;
    attemptsPath: string;
    reportPath: string;
    publicEvidencePath: string;
  };
};
