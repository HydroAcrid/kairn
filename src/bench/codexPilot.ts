// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  CodexPilotAttemptPlan,
  CodexPilotAttemptResult,
  CodexPilotFileAccess,
  CodexPilotPlan,
  CodexPilotReport,
  CodexPilotStage,
  CodexPilotUsage,
  ExperimentTask
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import { enableKairn, planKairnEnable } from "../cli/setup/enable.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { getSemanticModelState } from "../semantic/modelManager.js";
import { evaluateDiffScopes, evaluateSourceInvariants } from "./sourceValidation.js";
import {
  buildCodexPilotSchedule,
  CODEX_PILOT_PIN,
  loadCodexPilotPlan
} from "./codexPilotPlan.js";
import {
  codexThreadId,
  emptyUsage,
  observedCodexUsage,
  observedCodexUsageByTurn,
  transcriptFirstMention,
  type TimedCodexEvent
} from "./codexPilotUsage.js";
import type { HookAuditRecord } from "../watch/hookAudit.js";

export type RunCodexPilotOptions = {
  planPath: string;
  outDir: string;
  seed: number;
  stage: CodexPilotStage;
  resume?: boolean | undefined;
  dryRun?: boolean | undefined;
  codexCommand?: string | undefined;
  codexHome?: string | undefined;
  fakeCodexFixture?: string | undefined;
  onProgress?: ((message: string) => void) | undefined;
};

type CampaignState = {
  schemaVersion: "codex-pilot-state.v1";
  campaignId: string;
  planSha256: string;
  seed: number;
  codex: typeof CODEX_PILOT_PIN;
  kairnCommit: string;
  rankerModelSha256: string;
  firstRepeatIntegrityPassed: boolean;
  invalidGenerations: Record<string, number>;
};

type CapturedTurn = {
  turn: number;
  status: number | null;
  timedOut: boolean;
  events: TimedCodexEvent[];
  stdout: string;
  stderr: string;
  threadId?: string | undefined;
};

type SyscallAccess = CodexPilotFileAccess & { timestampMs: number };

const FORBIDDEN_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "REASONBLOCKS_API_KEY"
];

export async function runCodexPilot(input: RunCodexPilotOptions): Promise<CodexPilotReport> {
  const planPath = path.resolve(input.planPath);
  const plan = loadCodexPilotPlan(planPath);
  const schedule = buildCodexPilotSchedule({ plan, seed: input.seed, stage: input.stage });
  const outDir = path.resolve(input.outDir);
  const dryRun = Boolean(input.dryRun);
  const fakeFixture = input.fakeCodexFixture ? loadFakeFixture(input.fakeCodexFixture) : undefined;
  const codexCommand = resolveCommandInput(input.codexCommand ?? "codex");
  const codexHome = path.resolve(input.codexHome ?? process.env.KAIRN_CODEX_PILOT_HOME ?? ".kairn/codex-pilot-home");
  const planSha256 = sha256(fs.readFileSync(planPath));
  const kairnCommit = gitOutput(process.cwd(), ["rev-parse", "HEAD"]) || "uncommitted";
  const rankerModel = process.env.KAIRN_RANKER_MODEL?.trim();
  const rankerModelSha256 = plan.kairn?.rankerArtifactChecksum ?? (
    rankerModel && fs.existsSync(rankerModel) ? sha256(fs.readFileSync(rankerModel)) : "unconfigured"
  );
  if (!dryRun && !fakeFixture) {
    validateLiveEnvironment({ plan, rankerModel, kairnCommit });
    verifyCodexBinary(codexCommand, codexHome);
  }
  fs.mkdirSync(path.join(outDir, "attempts"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "workspaces"), { recursive: true });
  const statePath = path.join(outDir, "campaign-state.json");
  const state = prepareCampaignState({
    statePath,
    resume: Boolean(input.resume),
    expected: {
      schemaVersion: "codex-pilot-state.v1",
      campaignId: plan.id,
      planSha256,
      seed: input.seed,
      codex: CODEX_PILOT_PIN,
      kairnCommit,
      rankerModelSha256,
      firstRepeatIntegrityPassed: false,
      invalidGenerations: {}
    }
  });
  if (input.stage === "complete" && !state.firstRepeatIntegrityPassed) {
    throw new Error("complete stage requires a trace-valid first_repeat gate in the same frozen campaign directory");
  }
  if (!dryRun && !fakeFixture && !input.resume && fs.readdirSync(path.join(outDir, "attempts")).length > 0) {
    throw new Error("attempt output already exists; use --resume or choose a fresh output directory");
  }
  if (input.resume) prepareInvalidPairReruns(schedule, outDir, state);

  const attempts: CodexPilotAttemptResult[] = [];
  for (const [index, attempt] of schedule.entries()) {
    const task = plan.tasks.find((candidate) => candidate.id === attempt.taskId);
    if (!task) throw new Error(`task '${attempt.taskId}' disappeared after validation`);
    const cached = input.resume ? readCachedAttempt(outDir, attempt, planSha256) : undefined;
    if (cached) {
      input.onProgress?.(`[codex-pilot ${index + 1}/${schedule.length}] resume ${attempt.id}`);
      attempts.push(cached);
      continue;
    }
    input.onProgress?.(`[codex-pilot ${index + 1}/${schedule.length}] ${dryRun ? "plan" : "run"} ${attempt.id}`);
    const result = dryRun
      ? plannedAttempt(attempt, task)
      : fakeFixture
        ? fakeAttempt(attempt, task, fakeFixture)
        : await runLiveAttempt({
            plan,
            attempt,
            task,
            outDir,
            codexCommand,
            codexHome
          });
    writeCachedAttempt(outDir, result, planSha256);
    attempts.push(result);
  }

  if (input.stage === "first_repeat") {
    state.firstRepeatIntegrityPassed = firstRepeatIntegrity(attempts, plan.tasks.length);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  const expectedAttemptCount = input.stage === "complete" ? 90 : input.stage === "first_repeat" ? 30 : 2;
  const protocolComplete = !dryRun &&
    attempts.length === expectedAttemptCount &&
    attempts.every((attempt) => attempt.traceValid && attempt.status !== "invalid" && attempt.status !== "infrastructure_failure") &&
    pairedBlocksComplete(attempts);
  const reportPath = path.join(outDir, "codex-pilot-report.json");
  const attemptsPath = path.join(outDir, "codex-pilot-attempts.jsonl");
  const manifestPath = path.join(outDir, "codex-pilot-manifest.json");
  const publicEvidencePath = path.join(outDir, "public-codex-pilot-evidence.v1.json");
  const report: CodexPilotReport = {
    schemaVersion: "codex-pilot-report.v1",
    campaignId: plan.id,
    generatedAt: new Date().toISOString(),
    profile: plan.profile,
    stage: input.stage,
    seed: input.seed,
    planSha256,
    codex: CODEX_PILOT_PIN,
    ...(plan.kairn ? { kairn: plan.kairn } : {}),
    dryRun,
    expectedAttemptCount,
    completedAttemptCount: attempts.filter((attempt) => attempt.status !== "planned").length,
    validAttemptCount: attempts.filter((attempt) => attempt.traceValid).length,
    protocolComplete,
    attempts,
    outputs: { manifestPath, attemptsPath, reportPath, publicEvidencePath }
  };
  fs.writeFileSync(attemptsPath, attempts.map((attempt) => JSON.stringify(attempt)).join("\n") + "\n", "utf8");
  fs.writeFileSync(manifestPath, `${JSON.stringify(buildCampaignManifest({ plan, input, planSha256, state, schedule }), null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(publicEvidencePath, `${JSON.stringify(buildPublicEvidence(report), null, 2)}\n`, "utf8");
  return report;
}

function validateLiveEnvironment(input: { plan: CodexPilotPlan; rankerModel?: string | undefined; kairnCommit: string }): void {
  const configured = FORBIDDEN_PROVIDER_KEYS.filter((key) => Boolean(process.env[key]?.trim()));
  if (configured.length > 0) {
    throw new Error(`subscription-only Codex pilot refuses API credentials: ${configured.join(", ")}`);
  }
  if (input.plan.kairn) {
    const forbiddenOverrides = [
      "KAIRN_CANDIDATE_MODE",
      "KAIRN_SEMANTIC_MODEL",
      "KAIRN_SEMANTIC_MODEL_PATH",
      "KAIRN_RANKER_MODE",
      "KAIRN_RANKER_MODEL"
    ].filter((key) => Boolean(process.env[key]?.trim()));
    if (forbiddenOverrides.length > 0) {
      throw new Error(`sealed semantic Codex pilot refuses runtime overrides: ${forbiddenOverrides.join(", ")}`);
    }
    const model = getSemanticModelState({ modelId: input.plan.kairn.semanticModelId });
    if (
      model.status !== "ready" ||
      model.manifestSha256 !== input.plan.kairn.semanticModelManifestSha256
    ) {
      throw new Error("sealed semantic Codex pilot requires the checksummed local Jina model to be ready");
    }
  } else {
    if (!input.rankerModel || !fs.existsSync(input.rankerModel)) {
      throw new Error("live Codex pilot requires KAIRN_RANKER_MODEL pointing to the promoted local artifact");
    }
    if (process.env.KAIRN_RANKER_MODE !== "calibrated") {
      throw new Error("live Codex pilot requires KAIRN_RANKER_MODE=calibrated");
    }
  }
  if (input.kairnCommit === "uncommitted" || gitOutput(process.cwd(), ["status", "--porcelain"])) {
    throw new Error("live Codex pilot requires a clean, committed Kairn checkout so the campaign can be frozen");
  }
  if (process.platform !== "linux") throw new Error("live Codex pilot currently requires Linux/WSL strace instrumentation");
  commandMustSucceed("strace", ["--version"], process.cwd(), 10_000);
  commandMustSucceed("docker", ["version", "--format", "{{.Server.Version}}"], process.cwd(), 20_000);
  if (input.plan.profile === "pilot" && input.plan.repeats !== 3) throw new Error("pilot repeats changed after validation");
}

async function runLiveAttempt(input: {
  plan: CodexPilotPlan;
  attempt: CodexPilotAttemptPlan;
  task: ExperimentTask;
  outDir: string;
  codexCommand: string;
  codexHome: string;
}): Promise<CodexPilotAttemptResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const workspace = path.join(input.outDir, "workspaces", input.attempt.id);
  const rawDir = path.join(input.outDir, "raw", input.attempt.id);
  let cleanupKairn = () => {};
  let cleanupCodexTrust = () => {};
  try {
    if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
    if (fs.existsSync(rawDir)) fs.rmSync(rawDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(workspace), { recursive: true });
    fs.mkdirSync(rawDir, { recursive: true });
    commandMustSucceed("git", ["clone", "--quiet", "--no-checkout", input.task.repoUrl, workspace], input.outDir, input.plan.timeoutMs);
    commandMustSucceed("git", ["checkout", "--quiet", "--detach", input.task.ref], workspace, 120_000);
    const resolvedCommit = gitOutput(workspace, ["rev-parse", "HEAD"]);
    if (resolvedCommit.toLowerCase() !== input.task.ref.toLowerCase()) throw new Error(`resolved commit ${resolvedCommit} differs from sealed ref`);
    applyTaskSetup(input.task, workspace, input.plan.timeoutMs);
    const checkoutTreeHash = workspaceTreeHash(workspace);
    const requiredBefore = hashSelectedFiles(workspace, input.task.requiredTouchedFiles ?? []);
    const initialFailure = input.task.initialFailureCommand
      ? runDockerTask(input.task, workspace, input.task.initialFailureCommand, input.plan.timeoutMs)
      : undefined;
    if (initialFailure && initialFailure.status === 0) throw new Error("failure_first precondition unexpectedly passed");

    if (input.attempt.condition === "codex_kairn") cleanupKairn = await configureKairn(workspace, input.plan);
    else assertVanillaHasNoKairnConfig(workspace);
    cleanupCodexTrust = configureCodexProjectTrust(input.codexHome, workspace);
    const tracePrefix = path.join(rawDir, "strace");
    const hookAuditPath = path.join(rawDir, "kairn-hook-audit.jsonl");
    const turns = taskPrompts(input.task, initialFailure?.output);
    const captured: CapturedTurn[] = [];
    let threadId: string | undefined;
    for (const [turnIndex, prompt] of turns.entries()) {
      const turn = turnIndex + 1;
      const result = await runCodexTurn({
        command: input.codexCommand,
        home: input.codexHome,
        workspace,
        prompt,
        turn,
        timeoutMs: input.plan.timeoutMs,
        tracePath: `${tracePrefix}.t${turn}`,
        hookAuditPath,
        threadId
      });
      captured.push(result);
      threadId = threadId ?? result.threadId;
      fs.writeFileSync(path.join(rawDir, `turn-${turn}.jsonl`), result.stdout, "utf8");
      fs.writeFileSync(path.join(rawDir, `turn-${turn}.stderr.txt`), result.stderr, "utf8");
      if (result.status !== 0 || result.timedOut) break;
      if (turn < turns.length && !threadId) break;
    }
    cleanupKairn();
    cleanupKairn = () => {};
    cleanupCodexTrust();
    cleanupCodexTrust = () => {};

    const allEvents = captured.flatMap((turn) => turn.events);
    const transcript = captured.map((turn) => turn.stdout).join("\n");
    const hookEvidence = inspectCodexPilotHookEvidence(rawDir, hookAuditPath);
    const syscallAccesses = collectSyscallAccesses(rawDir, workspace);
    const changedFiles = changedRepositoryFiles(workspace);
    const fileAccesses = markRepeatedReads(syscallAccesses, changedFiles);
    const verification = runDockerTask(input.task, workspace, input.task.verificationCommand, input.plan.timeoutMs);
    const invariant = evaluateSourceInvariants({ rootPath: workspace, invariants: input.task.sourceInvariants });
    const diffScope = await evaluateDiffScopes({
      rootPath: workspace,
      scopes: input.task.allowedDiffScopes,
      ignoreFiles: [".codex/config.toml", ".codex/hooks.json"]
    });
    const requiredAfter = hashSelectedFiles(workspace, input.task.requiredTouchedFiles ?? []);
    const requiredTouchedPassed = [...requiredBefore].every(([file, before]) => requiredAfter.get(file) !== before);
    const requiredPaths = input.task.requiredSourceFiles.map(normalizePath);
    const sourceReads = new Set(fileAccesses.filter((access) => access.operation === "read").map((access) => normalizePath(access.path)));
    const requiredReadCount = requiredPaths.filter((required) => sourceReads.has(required)).length;
    const firstMention = transcriptFirstMention({ events: allEvents, paths: requiredPaths });
    const firstAccess = syscallAccesses
      .filter((access) => access.operation === "read" && requiredPaths.includes(normalizePath(access.path)))
      .sort((left, right) => left.timestampMs - right.timestampMs)[0];
    const usage = observedCodexUsage(allEvents);
    const usageByTurn = observedCodexUsageByTurn(allEvents);
    const explicitNoiseFilesOpened = uniquePaths(
      fileAccesses.filter((access) => input.task.explicitNoisePatterns?.some((pattern) => globMatches(access.path, pattern))).map((access) => access.path)
    ).length;
    const allowed = new Set([
      ...input.task.requiredSourceFiles,
      ...(input.task.allowedSupportFiles ?? []),
      ...(input.task.requiredTouchedFiles ?? [])
    ].map(normalizePath));
    const extraneousFilesOpened = uniquePaths(
      fileAccesses.filter((access) => access.operation === "read" && !allowed.has(normalizePath(access.path))).map((access) => access.path)
    ).length;
    const hookIntegrityPassed = input.attempt.condition === "codex_kairn"
      ? hookEvidence.traceInvocationCount === turns.length &&
        hookEvidence.auditRecordsValid &&
        hookEvidence.auditRecordCount === turns.length
      : hookEvidence.traceInvocationCount === 0 && hookEvidence.auditRecordCount === 0;
    const traceValid = captured.length === turns.length &&
      captured.every((turn) => turn.status === 0 && !turn.timedOut) &&
      usage.totalTokens > 0 &&
      syscallAccesses.length > 0 &&
      hookIntegrityPassed;
    const invalidReasons = [
      ...(captured.length !== turns.length ? ["incomplete_turn_sequence"] : []),
      ...(captured.some((turn) => turn.status !== 0 || turn.timedOut) ? ["codex_process_failure"] : []),
      ...(usage.totalTokens === 0 ? ["missing_observed_token_usage"] : []),
      ...(syscallAccesses.length === 0 ? ["missing_syscall_trace"] : []),
      ...(!hookEvidence.auditRecordsValid ? ["invalid_kairn_hook_audit"] : []),
      ...(input.attempt.condition === "codex_kairn" && hookEvidence.traceInvocationCount !== turns.length
        ? [hookEvidence.traceInvocationCount === 0 ? "missing_kairn_hook_invocation" : "unexpected_kairn_hook_invocation_count"]
        : []),
      ...(input.attempt.condition === "codex_kairn" && hookEvidence.auditRecordCount !== turns.length
        ? [hookEvidence.auditRecordCount === 0 ? "missing_kairn_hook_audit" : "unexpected_kairn_hook_audit_count"]
        : []),
      ...(input.attempt.condition === "vanilla_codex" && (hookEvidence.traceInvocationCount > 0 || hookEvidence.auditRecordCount > 0)
        ? ["vanilla_kairn_contamination"]
        : [])
    ];
    const verificationPassed = verification.status === 0 && !verification.timedOut;
    const qualityGatePassed = verificationPassed && requiredTouchedPassed && invariant.passed && diffScope.passed;
    const firstPathTurn = firstMention?.turn;
    const firstAccessTurn = firstAccess?.turn;
    const result: CodexPilotAttemptResult = {
      attempt: input.attempt,
      task: taskSummary(input.task),
      status: !traceValid ? "invalid" : qualityGatePassed ? "passed" : "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      traceValid,
      invalidReasons,
      resolvedCommit,
      checkoutTreeHash,
      finalTreeHash: workspaceTreeHash(workspace),
      transcriptSha256: sha256(transcript),
      syscallTraceSha256: syscallTraceHash(rawDir),
      usage,
      fileAccesses,
      requiredSourcePathSeen: Boolean(firstMention),
      requiredSourceContentAccessed: requiredReadCount > 0,
      requiredSourceAccessRecall: requiredPaths.length > 0 ? requiredReadCount / requiredPaths.length : 1,
      explicitNoiseFilesOpened,
      extraneousFilesOpened,
      repeatedUnchangedReadEvents: fileAccesses.filter((access) => access.unchangedRepeat).length,
      kairnHookInvocationCount: hookEvidence.traceInvocationCount,
      kairnHookAuditCount: hookEvidence.auditRecordCount,
      kairnPayloadTokens: input.attempt.condition === "codex_kairn" ? hookEvidence.estimatedPayloadTokens : 0,
      ...(firstMention ? { timeToFirstRequiredPathMs: Math.max(0, firstMention.receivedMs - startedMs) } : {}),
      ...(firstAccess ? { timeToFirstRequiredContentMs: Math.max(0, firstAccess.timestampMs - startedMs) } : {}),
      ...(firstPathTurn ? { tokensBeforeFirstRequiredPath: usageBeforeTurn(usageByTurn, firstPathTurn) } : {}),
      ...(firstAccessTurn ? { tokensBeforeFirstRequiredContent: usageBeforeTurn(usageByTurn, firstAccessTurn) } : {}),
      verificationPassed,
      requiredTouchedPassed,
      sourceInvariantPassed: invariant.passed,
      diffScopePassed: diffScope.passed,
      qualityGatePassed
    };
    return result;
  } catch (error) {
    return {
      attempt: input.attempt,
      task: taskSummary(input.task),
      status: "infrastructure_failure",
      startedAt,
      endedAt: new Date().toISOString(),
      traceValid: false,
      invalidReasons: ["infrastructure_failure"],
      usage: emptyUsage(),
      fileAccesses: [],
      requiredSourcePathSeen: false,
      requiredSourceContentAccessed: false,
      requiredSourceAccessRecall: 0,
      explicitNoiseFilesOpened: 0,
      extraneousFilesOpened: 0,
      repeatedUnchangedReadEvents: 0,
      kairnHookInvocationCount: 0,
      kairnHookAuditCount: 0,
      kairnPayloadTokens: 0,
      verificationPassed: false,
      requiredTouchedPassed: false,
      sourceInvariantPassed: false,
      diffScopePassed: false,
      qualityGatePassed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    cleanupKairn();
    cleanupCodexTrust();
  }
}

async function configureKairn(workspace: string, plan: CodexPilotPlan): Promise<() => void> {
  const snapshots = ["config.toml", "hooks.json"].map((name) => {
    const file = path.join(workspace, ".codex", name);
    return { file, existed: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file) : undefined };
  });
  const previous = process.env.KAIRN_DISABLE_BACKGROUND_INDEX;
  process.env.KAIRN_DISABLE_BACKGROUND_INDEX = "1";
  try {
    const result = await enableKairn({
      plan: planKairnEnable({
        root: workspace,
        agents: "codex",
        semanticServing: plan.kairn?.candidateMode === "semantic"
      }),
      index: true,
      installModel: false
    });
    if (!result.indexed || result.agents.some((agent) => agent.target === "codex" && agent.status === "action-required")) {
      throw new Error(`Kairn setup failed: ${result.indexError ?? "Codex integration was not configured"}`);
    }
    if (plan.kairn) {
      if (result.semanticMode !== "semantic" || result.semanticModel.status !== "ready") {
        throw new Error("Kairn semantic release candidate was not configured as sealed");
      }
      const runtime = new KairnRuntime(workspace);
      try {
        await runtime.init();
        const status = runtime.getIndexStatus();
        if (status.semanticEmbeddingCount === 0) {
          throw new Error("Kairn semantic index contains no embeddings after release-candidate setup");
        }
      } finally {
        runtime.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.KAIRN_DISABLE_BACKGROUND_INDEX;
    else process.env.KAIRN_DISABLE_BACKGROUND_INDEX = previous;
  }
  return () => {
    for (const snapshot of snapshots) {
      if (snapshot.existed && snapshot.content) {
        fs.mkdirSync(path.dirname(snapshot.file), { recursive: true });
        fs.writeFileSync(snapshot.file, snapshot.content);
      } else {
        fs.rmSync(snapshot.file, { force: true });
      }
    }
  };
}

function assertVanillaHasNoKairnConfig(workspace: string): void {
  for (const name of ["config.toml", "hooks.json"]) {
    const target = path.join(workspace, ".codex", name);
    if (fs.existsSync(target) && /kairn/i.test(fs.readFileSync(target, "utf8"))) {
      throw new Error(`vanilla checkout already contains Kairn configuration at .codex/${name}`);
    }
  }
}

function configureCodexProjectTrust(codexHome: string, workspace: string): () => void {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const target = path.join(codexHome, "config.toml");
  const existed = fs.existsSync(target);
  const previous = existed ? fs.readFileSync(target) : undefined;
  const temporary = `${target}.kairn-pilot-${process.pid}`;
  fs.writeFileSync(temporary, codexPilotProjectTrustConfig(workspace), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return () => {
    fs.rmSync(temporary, { force: true });
    if (existed && previous) fs.writeFileSync(target, previous, { mode: 0o600 });
    else fs.rmSync(target, { force: true });
  };
}

export function codexPilotProjectTrustConfig(workspace: string): string {
  return `[projects.${JSON.stringify(path.resolve(workspace))}]\ntrust_level = "trusted"\n`;
}

async function runCodexTurn(input: {
  command: string;
  home: string;
  workspace: string;
  prompt: string;
  turn: number;
  timeoutMs: number;
  tracePath: string;
  hookAuditPath: string;
  threadId?: string | undefined;
}): Promise<CapturedTurn> {
  fs.mkdirSync(input.home, { recursive: true });
  const common = buildCodexPilotCommonArgs();
  const codexArgs = input.threadId
    ? ["exec", "resume", ...common, input.threadId, input.prompt]
    : ["exec", ...common, "--sandbox", "workspace-write", input.prompt];
  const args = ["-ff", "-ttt", "-e", "trace=openat,openat2,execve", "-o", input.tracePath, input.command, ...codexArgs];
  const result = await captureProcess("strace", args, {
    cwd: input.workspace,
    timeoutMs: input.timeoutMs,
    env: sanitizedCodexEnvironment(input.home, input.hookAuditPath),
    turn: input.turn
  });
  const threadId = codexThreadId(result.events);
  return { ...result, ...(threadId ? { threadId } : {}) };
}

export function buildCodexPilotCommonArgs(): string[] {
  return [
    "--json",
    "--strict-config",
    "--ignore-rules",
    "--dangerously-bypass-hook-trust",
    "--model", CODEX_PILOT_PIN.model,
    "--config", 'approval_policy="never"',
    "--config", `model_reasoning_effort="${CODEX_PILOT_PIN.reasoningEffort}"`,
    "--config", `service_tier="${CODEX_PILOT_PIN.serviceTier}"`,
    "--config", "features.fast_mode=false"
  ];
}

function sanitizedCodexEnvironment(codexHome: string, hookAuditPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  for (const key of FORBIDDEN_PROVIDER_KEYS) delete env[key];
  if (hookAuditPath) env.KAIRN_HOOK_AUDIT_PATH = hookAuditPath;
  else delete env.KAIRN_HOOK_AUDIT_PATH;
  return env;
}

async function captureProcess(command: string, args: string[], input: {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  turn: number;
}): Promise<Omit<CapturedTurn, "threadId">> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const events: TimedCodexEvent[] = [];
    let timedOut = false;
    const accept = (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const raw of lines) events.push(timedEvent(raw, input.turn));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      stdout += value;
      accept(value);
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
    }, input.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (pending.trim()) events.push(timedEvent(pending, input.turn));
      resolve({ turn: input.turn, status, timedOut, events, stdout, stderr });
    });
  });
}

function timedEvent(raw: string, turn: number): TimedCodexEvent {
  const trimmed = raw.trim();
  try {
    return { turn, receivedMs: Date.now(), raw: trimmed, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { turn, receivedMs: Date.now(), raw: trimmed };
  }
}

function applyTaskSetup(task: ExperimentTask, workspace: string, timeoutMs: number): void {
  if (task.setupPatchFile) commandMustSucceed("git", ["apply", "--whitespace=nowarn", task.setupPatchFile], workspace, 120_000);
  if (task.setupPatch) {
    const patchPath = path.join(workspace, ".kairn-pilot-setup.patch");
    fs.writeFileSync(patchPath, task.setupPatch, "utf8");
    try {
      commandMustSucceed("git", ["apply", "--whitespace=nowarn", patchPath], workspace, 120_000);
    } finally {
      fs.rmSync(patchPath, { force: true });
    }
  }
  if (task.setupCommands?.length) {
    const setup = runDockerTask(task, workspace, task.setupCommands.join(" && "), timeoutMs);
    if (setup.status !== 0 || setup.timedOut) throw new Error(`offline setup failed: ${setup.output.slice(-1000)}`);
  }
}

function runDockerTask(task: ExperimentTask, workspace: string, command: string, timeoutMs: number): {
  status: number | null;
  timedOut: boolean;
  output: string;
} {
  if (!task.sandboxImage) throw new Error("sandbox image missing after validation");
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none",
    "--volume", `${workspace}:/workspace`,
    "--workdir", "/workspace",
    task.sandboxImage,
    "sh", "-lc", command
  ], { cwd: workspace, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return {
    status: result.status,
    timedOut: Boolean(result.error && "code" in result.error && result.error.code === "ETIMEDOUT"),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

function collectSyscallAccesses(rawDir: string, workspace: string): SyscallAccess[] {
  const output: SyscallAccess[] = [];
  const workspaceNormalized = workspace.replace(/\\/g, "/");
  for (const name of fs.readdirSync(rawDir).filter((candidate) => candidate.startsWith("strace.t"))) {
    const content = fs.readFileSync(path.join(rawDir, name), "utf8");
    if (content.split(/\r?\n/).some(isKairnCodexHookExecve)) continue;
    const turn = Number(/strace\.t(\d+)/.exec(name)?.[1] ?? 0);
    for (const line of content.split(/\r?\n/)) {
      const timestampMs = Number(/^\s*(\d+(?:\.\d+)?)/.exec(line)?.[1] ?? 0) * 1000;
      const syscall = /\b(execve|openat2|openat)\(/.exec(line)?.[1];
      if (!syscall) continue;
      const candidates = [...line.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => decodeTraceString(match[1] ?? ""));
      const candidate = candidates.find((value) => value.startsWith(workspaceNormalized)) ??
        candidates.find((value) => looksLikeRepositoryPath(value) && fs.existsSync(path.join(workspace, value)));
      if (!candidate) continue;
      const absolute = candidate.startsWith(workspaceNormalized) ? candidate : path.join(workspace, candidate);
      const relative = normalizePath(path.relative(workspace, absolute));
      if (!relative || relative.startsWith("../") || isInternalPilotPath(relative)) continue;
      const operation: CodexPilotFileAccess["operation"] = syscall === "execve"
        ? "execute"
        : /O_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)/.test(line) ? "write" : "read";
      output.push({ path: relative, operation, turn, unchangedRepeat: false, timestampMs });
    }
  }
  return output;
}

export function inspectCodexPilotHookEvidence(rawDir: string, auditPath: string): {
  traceInvocationCount: number;
  auditRecordCount: number;
  auditRecordsValid: boolean;
  estimatedPayloadTokens: number;
} {
  let traceInvocationCount = 0;
  for (const name of fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((candidate) => candidate.startsWith("strace.t"))
    : []) {
    const content = fs.readFileSync(path.join(rawDir, name), "utf8");
    traceInvocationCount += content.split(/\r?\n/).filter(isKairnCodexHookExecve).length;
  }
  if (!fs.existsSync(auditPath)) {
    return { traceInvocationCount, auditRecordCount: 0, auditRecordsValid: true, estimatedPayloadTokens: 0 };
  }
  let auditRecordsValid = true;
  let estimatedPayloadTokens = 0;
  const records = fs.readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as Partial<HookAuditRecord>;
      if (
        value.schemaVersion !== "kairn-hook-audit.v1" ||
        value.source !== "codex" ||
        value.eventName !== "UserPromptSubmit" ||
        typeof value.estimatedPayloadTokens !== "number" ||
        !Number.isSafeInteger(value.estimatedPayloadTokens) ||
        value.estimatedPayloadTokens < 0 ||
        typeof value.payloadSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.payloadSha256)
      ) {
        auditRecordsValid = false;
        return [];
      }
      estimatedPayloadTokens += value.estimatedPayloadTokens;
      return [value];
    } catch {
      auditRecordsValid = false;
      return [];
    }
  });
  return {
    traceInvocationCount,
    auditRecordCount: records.length,
    auditRecordsValid,
    estimatedPayloadTokens
  };
}

function isKairnCodexHookExecve(line: string): boolean {
  return /\bexecve\(/.test(line) &&
    /(?:^|,\s*)"hook"(?:,|\])/.test(line) &&
    /(?:^|,\s*)"--source"(?:,|\])/.test(line) &&
    /(?:^|,\s*)"codex"(?:,|\])/.test(line);
}

function markRepeatedReads(accesses: SyscallAccess[], changedFiles: string[]): CodexPilotFileAccess[] {
  const changed = new Set(changedFiles.map(normalizePath));
  const firstTurn = new Map<string, number>();
  return accesses.map((access) => {
    const normalized = normalizePath(access.path);
    const seenTurn = firstTurn.get(normalized);
    if (access.operation === "read" && seenTurn === undefined) firstTurn.set(normalized, access.turn);
    return {
      path: access.path,
      operation: access.operation,
      turn: access.turn,
      unchangedRepeat: access.operation === "read" && seenTurn !== undefined && access.turn > seenTurn && !changed.has(normalized)
    };
  });
}

function verifyCodexBinary(command: string, home: string): void {
  const version = runSync(command, ["--version"], process.cwd(), 15_000, sanitizedCodexEnvironment(home));
  if (version.status !== 0 || !new RegExp(`\\b${CODEX_PILOT_PIN.version.replace(/\./g, "\\.")}\\b`).test(version.output)) {
    throw new Error(`Codex binary must report pinned version ${CODEX_PILOT_PIN.version}; received ${version.output.trim() || "no version"}`);
  }
  const installedIntegrity = codexPackageIntegrity(command) ?? process.env.KAIRN_CODEX_NPM_INTEGRITY?.trim();
  if (installedIntegrity !== CODEX_PILOT_PIN.integrity) {
    throw new Error("Codex npm package integrity does not match the sealed 0.145.0 pilot pin");
  }
  const auth = runSync(command, ["login", "status"], process.cwd(), 15_000, sanitizedCodexEnvironment(home));
  if (auth.status !== 0) throw new Error("dedicated CODEX_HOME is not signed in with a ChatGPT subscription; run codex login first");
}

function codexPackageIntegrity(command: string): string | undefined {
  const executable = resolveExecutable(command);
  if (!executable) return undefined;
  let current = path.dirname(fs.realpathSync(executable));
  for (let depth = 0; depth < 8; depth += 1) {
    const lockPath = path.join(current, "package-lock.json");
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
        packages?: Record<string, { integrity?: string | undefined }> | undefined;
      };
      return lock.packages?.["node_modules/@openai/codex"]?.integrity;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function resolveExecutable(command: string): string | undefined {
  if (command.includes(path.sep) || command.includes("/")) {
    const resolved = path.resolve(command);
    return fs.existsSync(resolved) ? resolved : undefined;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveCommandInput(command: string): string {
  return command.includes(path.sep) || command.includes("/") ? path.resolve(command) : command;
}

function commandMustSucceed(command: string, args: string[], cwd: string, timeoutMs: number): void {
  const result = runSync(command, args, cwd, timeoutMs, process.env);
  if (result.status !== 0 || result.timedOut) {
    throw new Error(`${command} failed${result.timedOut ? " (timeout)" : ""}: ${result.output.slice(-1200)}`);
  }
}

function runSync(command: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): {
  status: number | null;
  timedOut: boolean;
  output: string;
} {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return {
    status: result.status,
    timedOut: Boolean(result.error && "code" in result.error && result.error.code === "ETIMEDOUT"),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

function taskPrompts(task: ExperimentTask, failureOutput?: string | undefined): string[] {
  const turns = task.turns?.map((turn) => turn.prompt) ?? [task.prompt];
  if (!failureOutput) return turns;
  return turns.map((prompt, index) => index === 0
    ? `${prompt}\n\nThe preregistered failing command produced this output:\n${failureOutput.slice(0, 12000)}`
    : prompt);
}

function plannedAttempt(attempt: CodexPilotAttemptPlan, task: ExperimentTask): CodexPilotAttemptResult {
  const now = new Date().toISOString();
  return {
    attempt,
    task: taskSummary(task),
    status: "planned",
    startedAt: now,
    endedAt: now,
    traceValid: false,
    invalidReasons: [],
    usage: emptyUsage(),
    fileAccesses: [],
    requiredSourcePathSeen: false,
    requiredSourceContentAccessed: false,
    requiredSourceAccessRecall: 0,
    explicitNoiseFilesOpened: 0,
    extraneousFilesOpened: 0,
    repeatedUnchangedReadEvents: 0,
    kairnHookInvocationCount: 0,
    kairnHookAuditCount: 0,
    kairnPayloadTokens: 0,
    verificationPassed: false,
    requiredTouchedPassed: false,
    sourceInvariantPassed: false,
    diffScopePassed: false,
    qualityGatePassed: false
  };
}

function loadFakeFixture(target: string): Map<string, Record<string, unknown>> {
  const root = JSON.parse(fs.readFileSync(path.resolve(target), "utf8")) as unknown;
  if (!isRecord(root) || root.schemaVersion !== "codex-pilot-fake.v1" || !Array.isArray(root.attempts)) {
    throw new Error("fake fixture must use schemaVersion codex-pilot-fake.v1 and an attempts array");
  }
  const output = new Map<string, Record<string, unknown>>();
  for (const value of root.attempts) {
    if (!isRecord(value) || typeof value.id !== "string") throw new Error("fake attempt requires id");
    if (output.has(value.id)) throw new Error(`duplicate fake attempt '${value.id}'`);
    output.set(value.id, value);
  }
  return output;
}

function fakeAttempt(
  attempt: CodexPilotAttemptPlan,
  task: ExperimentTask,
  fixture: Map<string, Record<string, unknown>>
): CodexPilotAttemptResult {
  const row = fixture.get(attempt.id);
  if (!row) throw new Error(`fake fixture has no attempt '${attempt.id}'`);
  const usage = isRecord(row.usage) ? row.usage : {};
  const token = (key: string) => typeof usage[key] === "number" ? Number(usage[key]) : 0;
  const quality = row.qualityGatePassed === true;
  const traceValid = row.traceValid === true;
  const now = new Date().toISOString();
  return {
    attempt,
    task: taskSummary(task),
    status: !traceValid ? "invalid" : quality ? "passed" : "failed",
    startedAt: now,
    endedAt: now,
    traceValid,
    invalidReasons: traceValid ? [] : ["fake_invalid_trace"],
    usage: {
      inputTokens: token("inputTokens"),
      cachedInputTokens: token("cachedInputTokens"),
      outputTokens: token("outputTokens"),
      reasoningTokens: token("reasoningTokens"),
      totalTokens: token("totalTokens")
    },
    fileAccesses: [],
    requiredSourcePathSeen: row.requiredSourcePathSeen === true,
    requiredSourceContentAccessed: row.requiredSourceContentAccessed === true,
    requiredSourceAccessRecall: typeof row.requiredSourceAccessRecall === "number" ? row.requiredSourceAccessRecall : 0,
    explicitNoiseFilesOpened: typeof row.explicitNoiseFilesOpened === "number" ? row.explicitNoiseFilesOpened : 0,
    extraneousFilesOpened: typeof row.extraneousFilesOpened === "number" ? row.extraneousFilesOpened : 0,
    repeatedUnchangedReadEvents: typeof row.repeatedUnchangedReadEvents === "number" ? row.repeatedUnchangedReadEvents : 0,
    kairnHookInvocationCount: typeof row.kairnHookInvocationCount === "number" ? row.kairnHookInvocationCount : 0,
    kairnHookAuditCount: typeof row.kairnHookAuditCount === "number" ? row.kairnHookAuditCount : 0,
    kairnPayloadTokens: typeof row.kairnPayloadTokens === "number" ? row.kairnPayloadTokens : 0,
    verificationPassed: row.verificationPassed === true,
    requiredTouchedPassed: row.requiredTouchedPassed === true,
    sourceInvariantPassed: row.sourceInvariantPassed === true,
    diffScopePassed: row.diffScopePassed === true,
    qualityGatePassed: quality
  };
}

function prepareCampaignState(input: { statePath: string; resume: boolean; expected: CampaignState }): CampaignState {
  if (!fs.existsSync(input.statePath)) {
    fs.writeFileSync(input.statePath, `${JSON.stringify(input.expected, null, 2)}\n`, "utf8");
    return input.expected;
  }
  if (!input.resume) throw new Error("campaign state already exists; use --resume or choose a new output directory");
  const current = JSON.parse(fs.readFileSync(input.statePath, "utf8")) as CampaignState;
  for (const key of ["schemaVersion", "campaignId", "planSha256", "seed", "kairnCommit", "rankerModelSha256"] as const) {
    if (current[key] !== input.expected[key]) throw new Error(`resume fingerprint mismatch: ${key}`);
  }
  if (JSON.stringify(current.codex) !== JSON.stringify(input.expected.codex)) throw new Error("resume fingerprint mismatch: codex pin");
  return current;
}

function prepareInvalidPairReruns(schedule: CodexPilotAttemptPlan[], outDir: string, state: CampaignState): void {
  for (const blockId of new Set(schedule.map((attempt) => attempt.blockId))) {
    const block = schedule.filter((attempt) => attempt.blockId === blockId);
    const cached = block.map((attempt) => readCachedAttempt(outDir, attempt, state.planSha256)).filter(Boolean) as CodexPilotAttemptResult[];
    if (!cached.some((attempt) => attempt.status === "invalid" || attempt.status === "infrastructure_failure")) continue;
    const generation = state.invalidGenerations[blockId] ?? 0;
    if (generation >= 3) continue;
    for (const attempt of block) fs.rmSync(cachePath(outDir, attempt.id), { force: true });
    state.invalidGenerations[blockId] = generation + 1;
  }
  fs.writeFileSync(path.join(outDir, "campaign-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function writeCachedAttempt(outDir: string, result: CodexPilotAttemptResult, planSha256: string): void {
  fs.writeFileSync(cachePath(outDir, result.attempt.id), `${JSON.stringify({ planSha256, result }, null, 2)}\n`, "utf8");
}

function readCachedAttempt(outDir: string, attempt: CodexPilotAttemptPlan, planSha256: string): CodexPilotAttemptResult | undefined {
  const target = cachePath(outDir, attempt.id);
  if (!fs.existsSync(target)) return undefined;
  const value = JSON.parse(fs.readFileSync(target, "utf8")) as { planSha256?: string; result?: CodexPilotAttemptResult };
  if (value.planSha256 !== planSha256 || value.result?.attempt.id !== attempt.id) throw new Error(`cached attempt integrity mismatch: ${attempt.id}`);
  return value.result;
}

function cachePath(outDir: string, attemptId: string): string {
  return path.join(outDir, "attempts", `${attemptId}.json`);
}

function firstRepeatIntegrity(attempts: CodexPilotAttemptResult[], taskCount: number): boolean {
  return attempts.length === taskCount * 2 && attempts.every((attempt) => attempt.traceValid) && pairedBlocksComplete(attempts);
}

function pairedBlocksComplete(attempts: CodexPilotAttemptResult[]): boolean {
  const byBlock = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    const set = byBlock.get(attempt.attempt.blockId) ?? new Set<string>();
    set.add(attempt.attempt.condition);
    byBlock.set(attempt.attempt.blockId, set);
  }
  return [...byBlock.values()].every((conditions) => conditions.size === 2);
}

function buildCampaignManifest(input: {
  plan: CodexPilotPlan;
  input: RunCodexPilotOptions;
  planSha256: string;
  state: CampaignState;
  schedule: CodexPilotAttemptPlan[];
}): Record<string, unknown> {
  return {
    schemaVersion: "codex-pilot-manifest.v1",
    campaignId: input.plan.id,
    profile: input.plan.profile,
    stage: input.input.stage,
    planSha256: input.planSha256,
    seed: input.input.seed,
    codex: CODEX_PILOT_PIN,
    ...(input.plan.kairn ? { kairn: input.plan.kairn } : {}),
    kairnCommit: input.state.kairnCommit,
    rankerModelSha256: input.state.rankerModelSha256,
    subscriptionAuthOnly: true,
    rawArtifactsPublished: false,
    conditions: input.plan.conditions,
    randomization: input.schedule,
    tasks: input.plan.tasks.map((task) => ({
      id: task.id,
      repoUrl: task.repoUrl,
      ref: task.ref,
      language: task.language,
      taskClass: task.taskClass,
      sandboxImage: task.sandboxImage
    }))
  };
}

function buildPublicEvidence(report: CodexPilotReport): Record<string, unknown> {
  const blocks = new Map<string, CodexPilotAttemptResult[]>();
  for (const attempt of report.attempts) {
    const rows = blocks.get(attempt.attempt.blockId) ?? [];
    rows.push(attempt);
    blocks.set(attempt.attempt.blockId, rows);
  }
  const qualityPairs = [...blocks.values()].flatMap((rows) => {
    const vanilla = rows.find((row) => row.attempt.condition === "vanilla_codex");
    const kairn = rows.find((row) => row.attempt.condition === "codex_kairn");
    if (!vanilla || !kairn || !vanilla.traceValid || !kairn.traceValid || !vanilla.qualityGatePassed || !kairn.qualityGatePassed) return [];
    return [{
      blockId: vanilla.attempt.blockId,
      taskId: vanilla.task.id,
      language: vanilla.task.language,
      scenario: vanilla.task.taskClass,
      signedTotalTokenDelta: kairn.usage.totalTokens - vanilla.usage.totalTokens,
      signedRepeatedReadDelta: kairn.repeatedUnchangedReadEvents - vanilla.repeatedUnchangedReadEvents,
      signedExtraneousFileDelta: kairn.extraneousFilesOpened - vanilla.extraneousFilesOpened
    }];
  });
  const tokenDeltas = qualityPairs.map((pair) => pair.signedTotalTokenDelta);
  const strata = [...new Set(qualityPairs.map((pair) => `${pair.language}/${pair.scenario}`))].sort().map((key) => {
    const rows = qualityPairs.filter((pair) => `${pair.language}/${pair.scenario}` === key);
    return {
      language: rows[0]?.language,
      scenario: rows[0]?.scenario,
      qualityEligiblePairs: rows.length,
      medianSignedTotalTokenDelta: median(rows.map((row) => row.signedTotalTokenDelta)),
      signedTotalTokenDeltaCi95: pairedBootstrapCi(rows.map((row) => row.signedTotalTokenDelta), report.seed)
    };
  });
  return {
    schemaVersion: "public-codex-pilot-evidence.v1",
    campaignId: report.campaignId,
    generatedAt: report.generatedAt,
    label: "preliminary_ecological_codex_pilot",
    status: report.dryRun ? "not_run" : report.protocolComplete ? "complete" : "partial",
    controlledFourArmEvidence: false,
    model: CODEX_PILOT_PIN.model,
    codexVersion: CODEX_PILOT_PIN.version,
    codexPackageIntegrity: CODEX_PILOT_PIN.integrity,
    ...(report.kairn ? { kairn: report.kairn } : {}),
    reasoningEffort: CODEX_PILOT_PIN.reasoningEffort,
    serviceTier: CODEX_PILOT_PIN.serviceTier,
    fastMode: CODEX_PILOT_PIN.fastMode,
    conditions: ["vanilla_codex", "codex_kairn"],
    profile: report.profile,
    stage: report.stage,
    protocolComplete: report.protocolComplete,
    attempts: report.attempts.length,
    validAttempts: report.validAttemptCount,
    qualityPassingAttempts: report.attempts.filter((attempt) => attempt.qualityGatePassed).length,
    invalidAttempts: report.attempts.filter((attempt) => !attempt.traceValid).length,
    failedVerificationAttempts: report.attempts.filter((attempt) => attempt.traceValid && !attempt.qualityGatePassed).length,
    qualityEligiblePairs: qualityPairs.length,
    negativeTokenPairs: qualityPairs.filter((pair) => pair.signedTotalTokenDelta > 0).length,
    zeroTokenPairs: qualityPairs.filter((pair) => pair.signedTotalTokenDelta === 0).length,
    positiveTokenPairs: qualityPairs.filter((pair) => pair.signedTotalTokenDelta < 0).length,
    medianSignedTotalTokenDelta: median(tokenDeltas),
    signedTotalTokenDeltaCi95: pairedBootstrapCi(tokenDeltas, report.seed),
    strata,
    attemptRows: report.attempts.map((attempt) => ({
      id: attempt.attempt.id,
      blockId: attempt.attempt.blockId,
      taskId: attempt.task.id,
      condition: attempt.attempt.condition,
      language: attempt.task.language,
      scenario: attempt.task.taskClass,
      traceValid: attempt.traceValid,
      status: attempt.status,
      qualityGatePassed: attempt.qualityGatePassed,
      verificationPassed: attempt.verificationPassed,
      requiredTouchedPassed: attempt.requiredTouchedPassed,
      sourceInvariantPassed: attempt.sourceInvariantPassed,
      diffScopePassed: attempt.diffScopePassed,
      requiredSourcePathSeen: attempt.requiredSourcePathSeen,
      requiredSourceContentAccessed: attempt.requiredSourceContentAccessed,
      requiredSourceAccessRecall: attempt.requiredSourceAccessRecall,
      tokens: attempt.usage,
      tokensBeforeFirstRequiredPath: attempt.tokensBeforeFirstRequiredPath ?? null,
      tokensBeforeFirstRequiredContent: attempt.tokensBeforeFirstRequiredContent ?? null,
      timeToFirstRequiredPathMs: attempt.timeToFirstRequiredPathMs ?? null,
      timeToFirstRequiredContentMs: attempt.timeToFirstRequiredContentMs ?? null,
      explicitNoiseFilesOpened: attempt.explicitNoiseFilesOpened,
      extraneousFilesOpened: attempt.extraneousFilesOpened,
      repeatedUnchangedReadEvents: attempt.repeatedUnchangedReadEvents,
      kairnHookInvocationCount: attempt.kairnHookInvocationCount,
      kairnHookAuditCount: attempt.kairnHookAuditCount,
      kairnPayloadTokens: attempt.kairnPayloadTokens,
      invalidReasons: attempt.invalidReasons
    })),
    pairRows: qualityPairs,
    rawArtifactsPublished: false,
    dollarConversionPublished: false,
    reasonBlocksComparisonPublished: false
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}

function pairedBootstrapCi(values: number[], seed: number): { lower: number; upper: number; samples: number } | null {
  if (values.length === 0) return null;
  let state = (seed ^ values.length ^ 0x9e3779b9) >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const samples = 5000;
  const estimates: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const draw = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)] ?? 0);
    estimates.push(median(draw) ?? 0);
  }
  estimates.sort((left, right) => left - right);
  return {
    lower: estimates[Math.floor(samples * 0.025)] ?? estimates[0] ?? 0,
    upper: estimates[Math.floor(samples * 0.975)] ?? estimates.at(-1) ?? 0,
    samples
  };
}

function workspaceTreeHash(workspace: string): string {
  const status = gitOutput(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter((line) => line && !/[\\/]\.kairn(?:[\\/]|$)/.test(line) && !/[\\/]\.codex(?:[\\/]|$)/.test(line))
    .sort()
    .join("\n");
  const diff = gitOutput(workspace, ["diff", "--binary", "--no-ext-diff"]);
  return sha256(`${status}\n${diff}`);
}

function changedRepositoryFiles(workspace: string): string[] {
  return gitOutput(workspace, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/)
    .map((line) => normalizePath(line.slice(3)))
    .filter((file) => file && !isInternalPilotPath(file));
}

function hashSelectedFiles(workspace: string, files: string[]): Map<string, string> {
  return new Map(files.map((file) => {
    const absolute = path.join(workspace, file);
    return [normalizePath(file), fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute)) : "missing"];
  }));
}

function syscallTraceHash(rawDir: string): string {
  const value = fs.readdirSync(rawDir)
    .filter((name) => name.startsWith("strace.t"))
    .sort()
    .map((name) => `${name}\n${fs.readFileSync(path.join(rawDir, name), "utf8")}`)
    .join("\n");
  return sha256(value);
}

function usageBeforeTurn(values: Map<number, CodexPilotUsage>, turn: number): number {
  let total = 0;
  for (const [candidate, usage] of values) if (candidate < turn) total += usage.totalTokens;
  return total;
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^"|"$/g, "").toLowerCase();
}

function isInternalPilotPath(value: string): boolean {
  const normalized = normalizePath(value);
  return normalized === ".kairn" || normalized.startsWith(".kairn/") ||
    normalized === ".codex" || normalized.startsWith(".codex/") ||
    normalized === ".git" || normalized.startsWith(".git/") ||
    normalized === "node_modules" || normalized.startsWith("node_modules/");
}

function looksLikeRepositoryPath(value: string): boolean {
  return !value.startsWith("/") && !value.startsWith("../") && /(?:^|\/)[^/]+\.[a-z0-9]+$/i.test(value);
}

function decodeTraceString(value: string): string {
  try { return JSON.parse(`"${value}"`) as string; } catch { return value; }
}

function globMatches(file: string, pattern: string): boolean {
  const regex = pattern.replace(/\\/g, "/").split("**").map((part) => part
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")).join(".*");
  return new RegExp(`^${regex}$`, "i").test(normalizePath(file));
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map(normalizePath))];
}

function taskSummary(task: ExperimentTask): CodexPilotAttemptResult["task"] {
  return { id: task.id, repoUrl: task.repoUrl, ref: task.ref, language: task.language, taskClass: task.taskClass };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
