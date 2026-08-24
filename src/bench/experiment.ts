// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  BenchmarkCase,
  ExperimentAttemptPlan,
  ExperimentAttemptResult,
  ExperimentDockerImageProvenance,
  ExperimentExecutionEnvironment,
  ExperimentHostRuntimeFingerprint,
  ExperimentPlan,
  ExperimentReport,
  ExperimentTask,
  ExperimentTraceEvent
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import {
  EVIDENCE_FEATURE_SCHEMA_HASH,
  EVIDENCE_FEATURE_SCHEMA_VERSION,
  loadEvidenceRankerArtifact
} from "../retrieval/evidenceModel.js";
import { runAgentBenchmarkCase } from "./agent.js";
import { deriveExperimentMetrics, validateExperimentTrace } from "./experimentMetrics.js";
import { buildExperimentSchedule, EXPERIMENT_CONDITIONS, loadExperimentPlan } from "./experimentPlan.js";
import {
  aggregateExperimentResults,
  buildPairComparisons,
  buildStrataAggregates,
  canonicalTaskManifest,
  emptyAttemptMetrics,
  taskManifestHash,
  writeExperimentOutputs
} from "./experimentReport.js";

export type RunExperimentOptions = {
  planPath: string;
  outDir: string;
  seed: number;
  repeat?: number | undefined;
  resume?: boolean | undefined;
  only?: string | undefined;
  dryRun?: boolean | undefined;
  allowExternalTrajectory?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
};

export async function runExperiment(input: RunExperimentOptions): Promise<ExperimentReport> {
  const plan = snapshotSetupPatchFiles(loadExperimentPlan(input.planPath));
  for (const task of plan.tasks) validatePublicRepositoryUrlShape(task.repoUrl);
  const outDir = path.resolve(input.outDir);
  const dryRun = Boolean(input.dryRun);
  const externalAllowed = Boolean(input.allowExternalTrajectory);
  const artifactUrl = resolveEvidenceArtifactUrl(process.env.KAIRN_EVIDENCE_ARTIFACT_URL, {
    required: !dryRun && plan.profile === "publication"
  });
  const model = plan.model ?? "claude-sonnet-4-6";
  const planSource = fs.readFileSync(path.resolve(input.planPath), "utf8");
  const planHash = sha256(planSource);
  if (input.repeat !== undefined && plan.profile && input.repeat !== plan.repeats) {
    throw new Error(`${plan.profile} profile repeat count is frozen at ${String(plan.repeats)} and cannot be overridden.`);
  }
  const repeats = input.repeat ?? plan.repeats ?? 3;
  const fullSchedule = buildExperimentSchedule({ plan, seed: input.seed, repeats });
  const expectedAttemptCount = fullSchedule.length;
  if (plan.profile === "publication") assertPublicationSchedule(plan, fullSchedule, repeats);
  let schedule = [...fullSchedule];
  if (input.only) {
    schedule = schedule.filter((attempt) =>
      attempt.id === input.only ||
      attempt.taskId === input.only ||
      attempt.condition === input.only ||
      attempt.blockId === input.only
    );
  }
  if (schedule.length === 0) throw new Error("Experiment selection produced no attempts.");
  const needsReasonBlocks = schedule.some((item) => item.condition === "reasonblocks" || item.condition === "kairn_reasonblocks");
  if (!dryRun && needsReasonBlocks && !externalAllowed) {
    throw new Error("ReasonBlocks attempts require --allow-external-trajectory and public-repository consent.");
  }
  if (!dryRun && needsReasonBlocks && !process.env.REASONBLOCKS_API_KEY) {
    throw new Error("REASONBLOCKS_API_KEY is required for ReasonBlocks attempts; no fallback to vanilla is allowed.");
  }
  if (!dryRun && plan.profile === "publication" && needsReasonBlocks && !process.env.REASONBLOCKS_SERVICE_VERSION?.trim()) {
    throw new Error(
      "Publication attempts require a preregistered REASONBLOCKS_SERVICE_VERSION; the public SDK does not expose a hosted build identifier."
    );
  }
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for live experiment attempts.");
  }

  fs.mkdirSync(path.join(outDir, "attempts"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "traces"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "runtime"), { recursive: true });
  const hostPath = resolveExperimentHost();
  const harnessFingerprint = fingerprintHarnessSources(hostPath);
  const harnessHash = harnessFingerprint.hash;
  const kairnCommit = process.env.KAIRN_COMMIT?.trim() || currentGitCommit();
  const kairnPackageVersion = currentPackageVersion();
  const kairnCommand = plan.kairnCommand ?? "kairn";
  const kairnCommandFingerprint = fingerprintCommand(kairnCommand);
  const kairnEnvironmentFingerprint = fingerprintKairnEnvironment(process.env, {
    publication: !dryRun && plan.profile === "publication"
  });
  const executionEnvironment = collectExecutionEnvironment({
    plan,
    requireResolvedImages: !dryRun
  });
  const rankerModelHash = localFileHash(process.env.KAIRN_RANKER_MODEL);
  let publicationRanker: PublicationRankerExpectation | undefined;
  if (!dryRun && plan.profile === "publication") {
    if (!kairnCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(kairnCommit)) {
      throw new Error("Publication experiments require a recorded Kairn commit (or KAIRN_COMMIT for a packaged build).");
    }
    if (currentGitDirty() === true) {
      throw new Error("Publication experiments require a clean Kairn source tree; commit or remove local changes first.");
    }
    if (process.env.KAIRN_RANKER_MODE !== "calibrated") {
      throw new Error("Publication experiments require KAIRN_RANKER_MODE=calibrated.");
    }
    if (!process.env.KAIRN_RANKER_MODEL_ID?.trim() || !rankerModelHash) {
      throw new Error("Publication experiments require KAIRN_RANKER_MODEL_ID and a readable local KAIRN_RANKER_MODEL artifact.");
    }
    publicationRanker = validatePublicationModelLineage(
      process.env.KAIRN_RANKER_MODEL!,
      process.env.KAIRN_RANKER_MODEL_ID!,
      plan.tasks.map((task) => task.repoUrl)
    );
    if (publicationRanker.modelHash !== rankerModelHash) {
      throw new Error("Publication ranker artifact changed while its provenance was being validated.");
    }
    if (!harnessFingerprint.complete) {
      throw new Error(`Publication harness fingerprint is incomplete: ${harnessFingerprint.missing.join(", ")}.`);
    }
    if (!kairnCommandFingerprint.complete || kairnCommandFingerprint.runtimePackage?.name !== "usekairn") {
      throw new Error(
        "Publication experiments require a resolvable usekairn command whose complete declared runtime can be fingerprinted."
      );
    }
    if (kairnCommandFingerprint.runtimePackage.version !== kairnPackageVersion) {
      throw new Error("The Kairn command package version does not match the harness package version.");
    }
    if (!/^0\.(?:[3-9]|\d{2,})\.|^[1-9]\d*\./.test(kairnPackageVersion)) {
      throw new Error(`Publication experiments require Kairn v0.3 or later (found ${kairnPackageVersion}).`);
    }
  }
  const campaignFingerprint = buildCampaignFingerprint({
    harnessFingerprint,
    kairnCommit,
    kairnPackageVersion,
    kairnCommandFingerprint,
    kairnEnvironmentFingerprint,
    executionEnvironment,
    rankerModelHash,
    rankerModelId: process.env.KAIRN_RANKER_MODEL_ID?.trim(),
    rankerMode: process.env.KAIRN_RANKER_MODE?.trim(),
    publicationRanker
  });
  const scheduleDigest = sha256(JSON.stringify(fullSchedule));
  const runState = prepareRunState({
    outDir,
    resume: Boolean(input.resume),
    planHash,
    seed: input.seed,
    model,
    repeats,
    scheduleDigest,
    externalTrajectoryAllowed: externalAllowed,
    harnessHash,
    campaignFingerprintHash: campaignFingerprint.hash,
    executionEnvironmentHash: executionEnvironment.hash
  });
  const runId = runState.runId;
  const canonicalTasks = canonicalTaskManifest(plan);
  const attempts: ExperimentAttemptResult[] = [];
  for (const [index, attempt] of schedule.entries()) {
    const task = plan.tasks.find((item) => item.id === attempt.taskId);
    if (!task) throw new Error(`Experiment task '${attempt.taskId}' disappeared after validation.`);
    const taskIndex = plan.tasks.findIndex((item) => item.id === attempt.taskId);
    const taskHash = sha256(JSON.stringify(canonicalTasks[taskIndex]) ?? "missing-task");
    const cacheIntegrity: AttemptCacheIntegrity = {
      planHash,
      seed: input.seed,
      model,
      runId,
      harnessHash,
      campaignFingerprintHash: campaignFingerprint.hash,
      environmentFingerprintHash: kairnEnvironmentFingerprint.hash,
      executionEnvironmentHash: executionEnvironment.hash,
      ...(publicationRanker ? { publicationRanker } : {}),
      taskHash,
      attemptId: attempt.id
    };
    const cached = input.resume ? readCachedAttempt(outDir, cacheIntegrity, attempt) : undefined;
    if (cached && cached.status !== "planned") {
      input.onProgress?.(`[experiment ${index + 1}/${schedule.length}] resume ${attempt.id}`);
      attempts.push(cached);
      continue;
    }
    input.onProgress?.(`[experiment ${index + 1}/${schedule.length}] ${dryRun ? "plan" : "run"} ${attempt.id}`);
    const result = dryRun
      ? plannedAttempt(attempt, task, runId)
      : await runExperimentAttempt({
          plan,
          task,
          attempt,
          outDir,
          externalAllowed,
          runId,
          environmentFingerprintHash: kairnEnvironmentFingerprint.hash,
          executionEnvironmentHash: executionEnvironment.hash,
          publicationRanker
        });
    writeCachedAttempt(outDir, result, cacheIntegrity);
    attempts.push(result);
  }

  const endingHarnessFingerprint = fingerprintHarnessSources(hostPath);
  const endingExecutionEnvironment = collectExecutionEnvironment({
    plan,
    requireResolvedImages: !dryRun
  });
  const endingCampaignFingerprint = buildCampaignFingerprint({
    harnessFingerprint: endingHarnessFingerprint,
    kairnCommit: process.env.KAIRN_COMMIT?.trim() || currentGitCommit(),
    kairnPackageVersion: currentPackageVersion(),
    kairnCommandFingerprint: fingerprintCommand(kairnCommand),
    kairnEnvironmentFingerprint: fingerprintKairnEnvironment(process.env, {
      publication: !dryRun && plan.profile === "publication"
    }),
    executionEnvironment: endingExecutionEnvironment,
    rankerModelHash: localFileHash(process.env.KAIRN_RANKER_MODEL),
    rankerModelId: process.env.KAIRN_RANKER_MODEL_ID?.trim(),
    rankerMode: process.env.KAIRN_RANKER_MODE?.trim(),
    publicationRanker
  });
  if (endingCampaignFingerprint.hash !== campaignFingerprint.hash) {
    throw new Error("Campaign implementation fingerprint changed while attempts were running; discard the run and start again.");
  }
  if (endingExecutionEnvironment.hash !== executionEnvironment.hash) {
    throw new Error("Execution environment changed while attempts were running; discard the run and start again.");
  }
  if (!dryRun && plan.profile === "publication" && currentGitDirty() === true) {
    throw new Error("Publication Kairn source tree changed while attempts were running; discard the run and start again.");
  }

  const selectionComplete = !input.only && schedule.length === expectedAttemptCount;
  const workspaceTreeParity = evaluateWorkspaceTreeParity(attempts);
  if (!dryRun && selectionComplete) applyWorkspaceTreeParityFailures(attempts, workspaceTreeParity);
  const generatedAt = new Date().toISOString();
  const aggregates = aggregateExperimentResults(EXPERIMENT_CONDITIONS, attempts);
  const comparisons = buildPairComparisons(attempts, input.seed);
  const strata = buildStrataAggregates(attempts, EXPERIMENT_CONDITIONS, input.seed);
  const traceProvenance = collectTraceProvenance(attempts);
  const protocolComplete = !dryRun &&
    plan.profile === "publication" &&
    expectedAttemptCount === 600 &&
    selectionComplete &&
    attempts.length === 600 &&
    new Set(attempts.map((attempt) => attempt.attempt.id)).size === 600 &&
    attempts.every((attempt) => attempt.traceValid && (attempt.status === "passed" || attempt.status === "failed")) &&
    executionEnvironment.verified &&
    workspaceTreeParity.consistent &&
    traceProvenance.consistent;
  const baseReport: Omit<ExperimentReport, "outputs"> = {
    schemaVersion: 1,
    id: plan.id,
    name: plan.name,
    generatedAt,
    planHash,
    runId,
    seed: input.seed,
    dryRun,
    externalTrajectoryAllowed: externalAllowed,
    model,
    conditions: EXPERIMENT_CONDITIONS,
    attempts,
    aggregates,
    strata,
    comparisons,
    expectedAttemptCount,
    protocolComplete,
    executionEnvironment
  };
  const toolSchemaHash = traceProvenance.toolSchemaHash ?? sha256("instrumented-repository-tools-v1");
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    campaignId: plan.id,
    name: plan.name,
    generatedAt,
    runId,
    profile: plan.profile ?? "smoke",
    planHash,
    taskManifestHash: taskManifestHash(plan),
    harnessHash,
    harnessFiles: harnessFingerprint.files,
    campaignFingerprint,
    executionEnvironment,
    workspaceTreeParity,
    toolSchemaHash,
    kairnCommit,
    model,
    temperature: plan.temperature ?? 0,
    maxSteps: plan.maxSteps ?? 40,
    maxTokensPerResponse: plan.maxTokensPerResponse ?? 4096,
    timeoutMs: plan.timeoutMs ?? 1_800_000,
    seed: input.seed,
    repeats,
    expectedAttemptCount,
    protocolComplete,
    conditions: EXPERIMENT_CONDITIONS,
    externalTrajectoryAllowed: externalAllowed,
    randomization: schedule,
    tasks: canonicalTasks,
    providerVersions: traceProvenance,
    repositories: plan.tasks.map((task) => {
      const sandboxImageProvenance = executionEnvironment.dockerImages.find(
        (item) => item.requestedImage === task.sandboxImage
      );
      return {
        taskId: task.id,
        repoUrl: task.repoUrl,
        requestedRef: task.ref,
        sandboxImage: task.sandboxImage,
        sandboxImageProvenance: sandboxImageProvenance ?? null,
        resolvedCommit: attempts.find((attempt) => attempt.task.id === task.id && attempt.resolvedRepoCommit)?.resolvedRepoCommit ?? null
      };
    })
  };
  return writeExperimentOutputs({
    outDir,
    report: baseReport,
    plan,
    manifest,
    kairnPackageVersion,
    harnessHash,
    toolSchemaHash,
    ...(kairnCommit ? { kairnCommit } : {}),
    ...(process.env.KAIRN_RANKER_MODEL_ID ? { rankerModelId: process.env.KAIRN_RANKER_MODEL_ID } : {}),
    ...(rankerModelHash ? { rankerModelHash } : {}),
    ...(traceProvenance.anthropicVersion ? { anthropicVersion: traceProvenance.anthropicVersion } : {}),
    ...(traceProvenance.reasonblocksVersion ? { reasonblocksVersion: traceProvenance.reasonblocksVersion } : {}),
    ...(traceProvenance.reasonblocksServiceVersion ? { reasonblocksServiceVersion: traceProvenance.reasonblocksServiceVersion } : {}),
    ...(traceProvenance.reasonblocksServiceVersionSource
      ? { reasonblocksServiceVersionSource: traceProvenance.reasonblocksServiceVersionSource }
      : {}),
    ...(traceProvenance.pythonVersion ? { pythonVersion: traceProvenance.pythonVersion } : {}),
    ...(artifactUrl ? { artifactUrl } : {})
  });
}

async function runExperimentAttempt(input: {
  plan: ExperimentPlan;
  task: ExperimentTask;
  attempt: ExperimentAttemptPlan;
  outDir: string;
  externalAllowed: boolean;
  runId: string;
  environmentFingerprintHash: string;
  executionEnvironmentHash: string;
  publicationRanker?: PublicationRankerExpectation | undefined;
}): Promise<ExperimentAttemptResult> {
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  const wallStarted = Date.now();
  const tracePath = path.join(input.outDir, "traces", `${input.attempt.id}.jsonl`);
  const taskPath = path.join(input.outDir, "runtime", `${input.attempt.id}.task.json`);
  fs.rmSync(tracePath, { force: true });
  writeRuntimeTask(
    taskPath,
    input.task,
    input.attempt,
    input.runId,
    executionId,
    input.environmentFingerprintHash,
    input.executionEnvironmentHash
  );
  const benchmarkCase = experimentBenchmarkCase(input.task);
  let workspacePath = "";
  try {
    const hostCommand = experimentHostCommand({
      plan: input.plan,
      attempt: input.attempt,
      taskPath,
      tracePath,
      externalAllowed: input.externalAllowed
    });
    const agentResult = await runAgentBenchmarkCase({
      rootPath: process.cwd(),
      benchmarkCase,
      agentCommand: hostCommand,
      timeoutMs: input.plan.timeoutMs ?? 1_800_000,
      untrustedEnvironment: scrubCredentials(process.env),
      agentEnvironment: process.env
    });
    workspacePath = agentResult.workspacePath;
    const resolvedRepoCommit = scalarStringMetadata(agentResult.metadata.seedResolvedCommit) ?? workspaceGitCommit(workspacePath);
    const events = readTrace(tracePath);
    const invalidReasons = [
      ...validateExperimentTrace({ attemptId: input.attempt.id, events }),
      ...validateConditionTrace(
        input.attempt,
        events,
        input.plan.model ?? "claude-sonnet-4-6",
        input.runId,
        executionId,
        input.environmentFingerprintHash,
        input.executionEnvironmentHash,
        input.publicationRanker
      )
    ];
    if (
      input.plan.profile === "publication" &&
      (!resolvedRepoCommit || resolvedRepoCommit.toLowerCase() !== input.task.ref.toLowerCase())
    ) {
      invalidReasons.push("resolved repository commit does not match the preregistered publication commit");
    }
    const requiredTouchedValue = agentResult.metadata.requiredTouchedSatisfied;
    const sourceInvariantValue = agentResult.metadata.sourceInvariantPassed;
    const diffScopeValue = agentResult.metadata.diffScopePassed;
    if (typeof requiredTouchedValue !== "boolean") {
      invalidReasons.push("required-touched proof metadata is missing or invalid");
    }
    if (typeof sourceInvariantValue !== "boolean") {
      invalidReasons.push("source-invariant proof metadata is missing or invalid");
    }
    if (typeof diffScopeValue !== "boolean") {
      invalidReasons.push("diff-scope proof metadata is missing or invalid");
    }
    const traceValid = invalidReasons.length === 0;
    const assistanceMetadata = events.find((event) => event.kind === "assistance_start")?.metadata;
    const workspaceTreeDigest = scalarStringMetadata(assistanceMetadata?.workspaceTreeDigest);
    const verifierPassed = agentResult.metadata.seedTestExitCode === 0;
    const changedFiles = stringMetadata(agentResult.metadata.agentChangedFiles);
    const excludedTouchedFiles = changedFiles.filter((file) => matchesAnyPattern(file, input.task.explicitNoisePatterns ?? []));
    const requiredTouchedSatisfied = booleanMetadata(requiredTouchedValue, false);
    const sourceInvariantPassed = booleanMetadata(sourceInvariantValue, false);
    const diffScopePassed = booleanMetadata(diffScopeValue, false);
    const baseQuality = agentResult.outcome === "pass" &&
      verifierPassed &&
      traceValid &&
      requiredTouchedSatisfied &&
      sourceInvariantPassed &&
      diffScopePassed &&
      excludedTouchedFiles.length === 0;
    const preliminary = deriveExperimentMetrics({
      task: input.task,
      events,
      externalQualityGatePassed: baseQuality,
      externalFinalVerifierPassed: verifierPassed,
      externalRequiredTouchedPassed: requiredTouchedSatisfied,
      externalSourceInvariantPassed: sourceInvariantPassed,
      externalDiffScopePassed: diffScopePassed,
      externalVerificationTokens: numberMetadata(agentResult.metadata.seedTestOutputTokens),
      excludedTouchedFiles
    });
    const qualityGatePassed = baseQuality &&
      preliminary.requiredSourceContentRecall === 1 &&
      preliminary.explicitNoiseFilesOpened === 0 &&
      preliminary.excludedFilesTouched === 0;
    const metrics = { ...preliminary, qualityGatePassed };
    const attemptEnd = events.at(-1);
    const infrastructure = agentResult.outcome === "skipped" ||
      attemptEnd?.metadata?.category === "infrastructure" ||
      !attemptEnd ||
      typeof agentResult.metadata.workspaceSetupError === "string" ||
      agentResult.metadata.workspaceSetupSkipped === true;
    const status: ExperimentAttemptResult["status"] = infrastructure
      ? "infrastructure_failure"
      : !traceValid
        ? "invalid"
        : qualityGatePassed
          ? "passed"
          : "failed";
    return {
      attempt: input.attempt,
      task: taskIdentity(input.task),
      runId: input.runId,
      executionId,
      executionEnvironmentHash: input.executionEnvironmentHash,
      ...(workspaceTreeDigest ? { workspaceTreeDigest } : {}),
      ...(resolvedRepoCommit ? { resolvedRepoCommit } : {}),
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      workspaceSetupMs: numberMetadata(agentResult.metadata.workspaceSetupMs),
      providerSetupMs: (metrics.kairnSetupMs ?? 0) + (metrics.reasonblocksSetupMs ?? 0),
      ...(metrics.kairnSetupMs !== undefined ? { kairnSetupMs: metrics.kairnSetupMs } : {}),
      ...(metrics.reasonblocksSetupMs !== undefined ? { reasonblocksSetupMs: metrics.reasonblocksSetupMs } : {}),
      onlineMs: numberMetadata(agentResult.metadata.agentElapsedMs),
      totalMs: Date.now() - wallStarted,
      traceValid,
      invalidReasons,
      metrics,
      tracePath,
      traceDigest: fs.existsSync(tracePath) ? sha256(fs.readFileSync(tracePath)) : undefined,
      ...(status === "failed" || status === "infrastructure_failure" ? { error: agentResult.summary } : {})
    };
  } catch (error) {
    const events = readTrace(tracePath);
    const invalidReasons = validateExperimentTrace({ attemptId: input.attempt.id, events });
    return {
      attempt: input.attempt,
      task: taskIdentity(input.task),
      runId: input.runId,
      executionId,
      executionEnvironmentHash: input.executionEnvironmentHash,
      status: "infrastructure_failure",
      startedAt,
      endedAt: new Date().toISOString(),
      workspaceSetupMs: 0,
      providerSetupMs: 0,
      onlineMs: 0,
      totalMs: Date.now() - wallStarted,
      traceValid: false,
      invalidReasons: invalidReasons.length > 0 ? invalidReasons : ["experiment host failed before producing a complete trace"],
      metrics: emptyAttemptMetrics(),
      ...(fs.existsSync(tracePath) ? { tracePath } : {}),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    fs.rmSync(taskPath, { force: true });
    removeBenchmarkWorkspace(workspacePath);
  }
}

function experimentBenchmarkCase(task: ExperimentTask): BenchmarkCase {
  const defaultDiffScopes = (task.requiredTouchedFiles ?? []).map((file) => ({ file, allowWholeFile: true }));
  return {
    id: task.id,
    task: task.prompt,
    agentPrompt: task.prompt,
    mode: "agent",
    expectedFiles: task.requiredSourceFiles,
    requiredTouchedFiles: task.requiredTouchedFiles ?? [],
    excludedFiles: task.explicitNoisePatterns ?? [],
    sourceInvariants: task.sourceInvariants ?? [],
    allowedDiffScopes: task.allowedDiffScopes ?? defaultDiffScopes,
    seed: {
      repoUrl: task.repoUrl,
      ref: task.ref,
      cloneDepth: 1,
      commitSetupBaseline: true,
      ...(task.sandboxImage ? { sandboxImage: task.sandboxImage } : {}),
      ...(task.setupCommands ? { setupCommands: task.setupCommands } : {}),
      ...(task.setupPatch ? { setupPatch: task.setupPatch } : {}),
      ...(task.setupPatchFile ? { setupPatchFile: task.setupPatchFile } : {}),
      testCommand: task.verificationCommand
    }
  };
}

function experimentHostCommand(input: {
  plan: ExperimentPlan;
  attempt: ExperimentAttemptPlan;
  taskPath: string;
  tracePath: string;
  externalAllowed: boolean;
}): string {
  const host = resolveExperimentHost();
  const args = [
    input.plan.pythonCommand ?? "python3",
    host,
    "--condition", input.attempt.condition,
    "--workspace", "{root}",
    "--task-file", input.taskPath,
    "--trace", input.tracePath,
    "--model", input.plan.model ?? "claude-sonnet-4-6",
    "--temperature", String(input.plan.temperature ?? 0),
    "--max-steps", String(input.plan.maxSteps ?? 40),
    "--max-tokens", String(input.plan.maxTokensPerResponse ?? 4096),
    "--kairn-command", input.plan.kairnCommand ?? "kairn"
  ];
  if (input.externalAllowed) args.push("--allow-external-trajectory");
  return args.map((item) => item === "{root}" ? item : shellQuote(item)).join(" ");
}

function resolveExperimentHost(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(current, "../../benchmarks/anthropic_messages_host.py"),
    path.resolve(current, "../benchmarks/anthropic_messages_host.py"),
    path.resolve(process.cwd(), "benchmarks/anthropic_messages_host.py")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Anthropic experiment host is missing from benchmarks/anthropic_messages_host.py.");
  return found;
}

function writeRuntimeTask(
  target: string,
  task: ExperimentTask,
  attempt: ExperimentAttemptPlan,
  runId: string,
  executionId: string,
  environmentFingerprintHash: string,
  executionEnvironmentHash: string
): void {
  const payload = {
    schema_version: 1,
    attempt_id: attempt.id,
    run_id: runId,
    execution_id: executionId,
    environment_fingerprint_hash: environmentFingerprintHash,
    execution_environment_hash: executionEnvironmentHash,
    task_id: task.id,
    condition: attempt.condition,
    prompt: task.prompt,
    turns: task.turns ?? [],
    assistance_expectation: task.assistanceExpectation ?? "optional",
    required_source_files: task.requiredSourceFiles,
    required_touched_files: task.requiredTouchedFiles ?? [],
    allowed_support_files: task.allowedSupportFiles ?? [],
    explicit_noise_patterns: task.explicitNoisePatterns ?? [],
    sandbox_image: task.sandboxImage,
    initial_failure_command: task.initialFailureCommand,
    verification_command: task.verificationCommand
  };
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function readTrace(tracePath: string): ExperimentTraceEvent[] {
  if (!fs.existsSync(tracePath)) return [];
  const events: ExperimentTraceEvent[] = [];
  for (const line of fs.readFileSync(tracePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ExperimentTraceEvent);
    } catch {
      return [];
    }
  }
  return events;
}

function validateConditionTrace(
  attempt: ExperimentAttemptPlan,
  events: ExperimentTraceEvent[],
  model: string,
  runId: string,
  executionId: string,
  environmentFingerprintHash: string,
  executionEnvironmentHash: string,
  publicationRanker?: PublicationRankerExpectation | undefined
): string[] {
  const reasons: string[] = [];
  const kairn = events.filter((event) => event.kind === "provider_injection" && event.provider === "kairn");
  const reasonblocks = events.filter((event) => event.kind === "provider_injection" && event.provider === "reasonblocks");
  const expectedKairn = attempt.condition === "kairn" || attempt.condition === "kairn_reasonblocks";
  const expectedReasonBlocks = attempt.condition === "reasonblocks" || attempt.condition === "kairn_reasonblocks";
  const startMetadata = events.find((event) => event.kind === "attempt_start")?.metadata;
  const endMetadata = events.find((event) => event.kind === "attempt_end")?.metadata;
  if (startMetadata?.condition !== attempt.condition) reasons.push("attempt_start condition metadata does not match the scheduled arm");
  if (startMetadata?.model !== model) reasons.push("attempt_start model metadata does not match the frozen plan");
  if (startMetadata?.runId !== runId) reasons.push("attempt_start run id does not match the campaign run");
  if (startMetadata?.executionId !== executionId) reasons.push("attempt_start execution id does not match the live execution");
  if (startMetadata?.environmentFingerprintHash !== environmentFingerprintHash) {
    reasons.push("attempt_start Kairn environment fingerprint does not match the frozen campaign");
  }
  if (startMetadata?.executionEnvironmentHash !== executionEnvironmentHash) {
    reasons.push("attempt_start execution environment fingerprint does not match the frozen campaign");
  }
  if (startMetadata?.hostProtocolVersion !== "comparison-host-v2") reasons.push("attempt_start host protocol version is missing or unsupported");
  if (!isSha256(startMetadata?.toolSchemaHash)) reasons.push("attempt_start tool schema hash is missing or invalid");
  if (!nonEmptyString(startMetadata?.anthropicVersion)) reasons.push("attempt_start Anthropic SDK version is missing");
  if (!nonEmptyString(startMetadata?.pythonVersion)) reasons.push("attempt_start Python version is missing");
  const assistanceMetadata = events.find((event) => event.kind === "assistance_start")?.metadata;
  if (!isSha256(assistanceMetadata?.workspaceTreeDigest)) {
    reasons.push("assistance_start workspace tree digest is missing or invalid");
  }
  if (!Number.isInteger(assistanceMetadata?.workspaceTreeFileCount) || Number(assistanceMetadata?.workspaceTreeFileCount) < 0) {
    reasons.push("assistance_start workspace tree file count is missing or invalid");
  }
  if (!isNonNegativeNumber(assistanceMetadata?.workspaceTreeBytes)) {
    reasons.push("assistance_start workspace tree byte count is missing or invalid");
  }
  if (assistanceMetadata?.workspaceTreeScope !== "git-tracked-and-unignored-v1") {
    reasons.push("assistance_start workspace tree scope is missing or unsupported");
  }
  if (expectedReasonBlocks && !nonEmptyString(startMetadata?.reasonblocksVersion)) {
    reasons.push("ReasonBlocks condition is missing the ReasonBlocks SDK version");
  }
  if (
    expectedReasonBlocks &&
    publicationRanker &&
    (!nonEmptyString(startMetadata?.reasonblocksServiceVersion) || startMetadata?.reasonblocksServiceVersion === "unavailable")
  ) {
    reasons.push("Publication ReasonBlocks condition is missing a frozen hosted-service version");
  }
  if (
    expectedReasonBlocks &&
    publicationRanker &&
    startMetadata?.reasonblocksServiceVersionSource !== "operator_asserted"
  ) {
    reasons.push("Publication ReasonBlocks hosted-service version is not labeled as operator asserted");
  }
  if (expectedReasonBlocks) {
    const protocol = isRecord(startMetadata?.reasonblocksProtocolRequested)
      ? startMetadata.reasonblocksProtocolRequested
      : undefined;
    if (
      protocol?.adapter !== "SteeringSession.begin_step/end_step" ||
      protocol?.modelRouting !== false ||
      protocol?.serverMonitors !== true ||
      protocol?.eTraces !== true ||
      protocol?.withinSessionState !== true ||
      protocol?.prepopulatedMemory !== false ||
      protocol?.importGraph !== false ||
      protocol?.langchainCompression !== false
    ) {
      reasons.push("ReasonBlocks condition did not request the frozen steering-only protocol");
    }
  }
  if (expectedReasonBlocks && endMetadata?.reasonblocksLifecycleCompleted !== true) {
    reasons.push("ReasonBlocks condition did not record a completed hosted-session lifecycle");
  }
  if (
    expectedReasonBlocks &&
    (!isNonNegativeNumber(endMetadata?.reasonblocksSetupMs) || !isNonNegativeNumber(endMetadata?.reasonblocksCloseMs))
  ) {
    reasons.push("ReasonBlocks condition did not record construction/open/close timing");
  }
  if (expectedReasonBlocks) {
    const expectedSteps = events.filter((event) => event.kind === "model_request").length;
    if (!Number.isInteger(endMetadata?.reasonblocksStepLogEntries)) {
      reasons.push("ReasonBlocks condition did not record its step-log entry count");
    } else if (Number(endMetadata?.reasonblocksStepLogEntries) !== expectedSteps) {
      reasons.push("ReasonBlocks step-log entry count does not match model steps");
    }
  }
  if ((attempt.condition === "kairn" || attempt.condition === "kairn_reasonblocks") && kairn.length === 0) {
    reasons.push("Kairn condition recorded no Kairn provider decision");
  }
  if ((attempt.condition === "reasonblocks" || attempt.condition === "kairn_reasonblocks") && reasonblocks.length === 0) {
    reasons.push("ReasonBlocks condition recorded no ReasonBlocks provider decision");
  }
  if (attempt.condition === "vanilla" && (kairn.length > 0 || reasonblocks.length > 0)) {
    reasons.push("vanilla condition received provider guidance");
  }
  if (!expectedKairn && kairn.length > 0) reasons.push(`${attempt.condition} condition unexpectedly received Kairn guidance`);
  if (!expectedReasonBlocks && reasonblocks.length > 0) reasons.push(`${attempt.condition} condition unexpectedly received ReasonBlocks guidance`);

  for (const event of reasonblocks) {
    const effective = isRecord(event.metadata?.reasonblocksEffectiveProtocol)
      ? event.metadata.reasonblocksEffectiveProtocol
      : undefined;
    if (
      effective?.inspection !== "installed_session_object" ||
      effective?.modelRoutingConfigured !== false ||
      effective?.stateManagerPresent !== true ||
      !Number.isInteger(effective?.injectionCount) ||
      Number(effective?.injectionCount) < 1 ||
      !Array.isArray(effective?.injectionTypes) ||
      effective?.monitorSteeringPresent !== true ||
      effective?.eTraceInjectionPresent !== true
    ) {
      reasons.push(`ReasonBlocks decision at sequence ${event.sequence} lacks effective steering-session evidence`);
    }
    if (!nonEmptyString(event.metadata?.state)) reasons.push(`ReasonBlocks decision at sequence ${event.sequence} is missing FSM state`);
    if (event.metadata?.modelRouted !== false) reasons.push(`ReasonBlocks decision at sequence ${event.sequence} did not prove routing was disabled`);
    if (!isSha256(event.metadata?.injectionHash)) reasons.push(`ReasonBlocks decision at sequence ${event.sequence} is missing its injection hash`);
    if (!Number.isInteger(event.metadata?.monitorEventCount) || Number(event.metadata?.monitorEventCount) < 0) {
      reasons.push(`ReasonBlocks decision at sequence ${event.sequence} is missing its monitor-event count`);
    }
    if (!Number.isInteger(event.metadata?.pendingInjectionCount) || Number(event.metadata?.pendingInjectionCount) < 0) {
      reasons.push(`ReasonBlocks decision at sequence ${event.sequence} is missing its pending-injection count`);
    }
    const patternHashes = Array.isArray(event.metadata?.patternHashes) ? event.metadata.patternHashes : [];
    if (patternHashes.some((value) => !isSha256(value))) {
      reasons.push(`ReasonBlocks decision at sequence ${event.sequence} has invalid pattern hashes`);
    }
    if (
      event.action === "emit" &&
      (event.tokenEstimate ?? 0) > 0 &&
      (Number(event.metadata?.pendingInjectionCount) < 1 || patternHashes.length < 1)
    ) {
      reasons.push(`ReasonBlocks emission at sequence ${event.sequence} lacks structured pending-pattern identity`);
    }
  }

  if (publicationRanker && expectedKairn) {
    for (const event of kairn) {
      const status = rankerStatusFromTraceEvent(event);
      if (!status) {
        reasons.push(`Kairn provider decision at sequence ${event.sequence} is missing structured ranker status`);
        continue;
      }
      if (status.requestedMode !== "calibrated") {
        reasons.push(`Kairn provider decision at sequence ${event.sequence} did not request calibrated mode`);
      }
      if (status.servedMode !== "calibrated") {
        reasons.push(`Kairn provider decision at sequence ${event.sequence} did not serve calibrated mode`);
      }
      if (status.modelId !== publicationRanker.modelId) {
        reasons.push(`Kairn provider decision at sequence ${event.sequence} used an unexpected ranker model`);
      }
      if (status.featureSchemaVersion !== publicationRanker.featureSchemaVersion) {
        reasons.push(`Kairn provider decision at sequence ${event.sequence} used an unexpected feature schema`);
      }
      if (nonEmptyString(status.fallbackReason)) {
        reasons.push(`Kairn provider decision at sequence ${event.sequence} recorded a ranker fallback`);
      }
    }
  }

  for (const request of events.filter((event) => event.kind === "model_request")) {
    const step = request.modelStep;
    const sameStep = events.filter((event) =>
      event.kind === "provider_injection" &&
      event.turn === request.turn &&
      event.modelStep === step &&
      event.sequence < request.sequence
    );
    const k = sameStep.filter((event) => event.provider === "kairn");
    const rb = sameStep.filter((event) => event.provider === "reasonblocks");
    if (expectedKairn && k.length !== 1) reasons.push(`model step ${String(step)} has ${k.length} Kairn decisions; expected one`);
    if (expectedReasonBlocks && rb.length !== 1) reasons.push(`model step ${String(step)} has ${rb.length} ReasonBlocks decisions; expected one`);
    if (!expectedKairn && k.length > 0) reasons.push(`model step ${String(step)} has unexpected Kairn guidance`);
    if (!expectedReasonBlocks && rb.length > 0) reasons.push(`model step ${String(step)} has unexpected ReasonBlocks guidance`);
    if (expectedKairn && expectedReasonBlocks && k[0] && rb[0] && k[0].sequence > rb[0].sequence) {
      reasons.push(`combined provider order reversed at model step ${String(step)}`);
    }
  }
  for (const response of events.filter((event) => event.kind === "model_response")) {
    if (response.metadata?.resolvedModel !== model) {
      reasons.push(`model response ${String(response.modelStep)} resolved to an unexpected model`);
    }
  }
  return [...new Set(reasons)];
}

type TraceRankerStatus = {
  requestedMode?: unknown;
  servedMode?: unknown;
  modelId?: unknown;
  featureSchemaVersion?: unknown;
  fallbackReason?: unknown;
};

function rankerStatusFromTraceEvent(event: ExperimentTraceEvent): TraceRankerStatus | undefined {
  const candidate = event.metadata?.rankerStatus ?? event.metadata?.ranker;
  return isRecord(candidate) ? candidate : undefined;
}

function plannedAttempt(attempt: ExperimentAttemptPlan, task: ExperimentTask, runId: string): ExperimentAttemptResult {
  const now = new Date().toISOString();
  return {
    attempt,
    task: taskIdentity(task),
    runId,
    status: "planned",
    startedAt: now,
    endedAt: now,
    workspaceSetupMs: 0,
    providerSetupMs: 0,
    onlineMs: 0,
    totalMs: 0,
    traceValid: false,
    invalidReasons: [],
    metrics: emptyAttemptMetrics()
  };
}

function taskIdentity(task: ExperimentTask): ExperimentAttemptResult["task"] {
  return { id: task.id, language: task.language, taskClass: task.taskClass, repoUrl: task.repoUrl, ref: task.ref };
}

type AttemptCacheIntegrity = {
  planHash: string;
  seed: number;
  model: string;
  runId: string;
  harnessHash: string;
  campaignFingerprintHash: string;
  environmentFingerprintHash: string;
  executionEnvironmentHash: string;
  publicationRanker?: PublicationRankerExpectation | undefined;
  taskHash: string;
  attemptId: string;
};

type AttemptCacheEnvelope = {
  schemaVersion: 5;
  integrity: AttemptCacheIntegrity;
  executionId: string;
  resultHash: string;
  result: ExperimentAttemptResult;
};

type ExperimentRunState = {
  schemaVersion: 3;
  runId: string;
  planHash: string;
  seed: number;
  model: string;
  repeats: number;
  scheduleDigest: string;
  externalTrajectoryAllowed: boolean;
  harnessHash: string;
  campaignFingerprintHash: string;
  executionEnvironmentHash: string;
};

function prepareRunState(input: {
  outDir: string;
  resume: boolean;
  planHash: string;
  seed: number;
  model: string;
  repeats: number;
  scheduleDigest: string;
  externalTrajectoryAllowed: boolean;
  harnessHash: string;
  campaignFingerprintHash: string;
  executionEnvironmentHash: string;
}): ExperimentRunState {
  const target = path.join(input.outDir, "run-state.json");
  const expected = {
    planHash: input.planHash,
    seed: input.seed,
    model: input.model,
    repeats: input.repeats,
    scheduleDigest: input.scheduleDigest,
    externalTrajectoryAllowed: input.externalTrajectoryAllowed,
    harnessHash: input.harnessHash,
    campaignFingerprintHash: input.campaignFingerprintHash,
    executionEnvironmentHash: input.executionEnvironmentHash
  };
  if (input.resume && fs.existsSync(target)) {
    const state = JSON.parse(fs.readFileSync(target, "utf8")) as ExperimentRunState;
    if (state.schemaVersion !== 3) throw new Error("Experiment resume state schema is unsupported.");
    for (const [key, value] of Object.entries(expected)) {
      if (state[key as keyof ExperimentRunState] !== value) {
        throw new Error(`Experiment resume state mismatch for ${key}; use a new output directory.`);
      }
    }
    if (!state.runId) throw new Error("Experiment resume state is missing runId.");
    return state;
  }
  const state: ExperimentRunState = {
    schemaVersion: 3,
    runId: `${Date.now().toString(36)}-${randomUUID()}`,
    ...expected
  };
  fs.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

function readCachedAttempt(
  outDir: string,
  expectedIntegrity: AttemptCacheIntegrity,
  attempt: ExperimentAttemptPlan
): ExperimentAttemptResult | undefined {
  const target = path.join(outDir, "attempts", `${attempt.id}.json`);
  if (!fs.existsSync(target)) return undefined;
  try {
    const envelope = JSON.parse(fs.readFileSync(target, "utf8")) as AttemptCacheEnvelope;
    if (envelope.schemaVersion !== 5) throw new Error("cache schema is stale");
    if (JSON.stringify(envelope.integrity) !== JSON.stringify(expectedIntegrity)) throw new Error("cache integrity metadata changed");
    if (sha256(JSON.stringify(envelope.result)) !== envelope.resultHash) throw new Error("cached attempt result hash mismatch");
    if (envelope.result.attempt.id !== attempt.id || envelope.result.runId !== expectedIntegrity.runId) {
      throw new Error("cached attempt identity mismatch");
    }
    if (envelope.result.status !== "passed" && envelope.result.status !== "failed") return undefined;
    if (!envelope.executionId || envelope.result.executionId !== envelope.executionId) {
      throw new Error("cached attempt execution identity is missing or inconsistent");
    }
    if (envelope.result.executionEnvironmentHash !== expectedIntegrity.executionEnvironmentHash) {
      throw new Error("cached attempt execution environment is missing or inconsistent");
    }
    const expectedTracePath = path.join(outDir, "traces", `${attempt.id}.jsonl`);
    if (path.resolve(envelope.result.tracePath ?? "") !== path.resolve(expectedTracePath) || !fs.existsSync(expectedTracePath)) {
      throw new Error("cached attempt trace is missing or outside the campaign trace directory");
    }
    const digest = sha256(fs.readFileSync(expectedTracePath));
    if (digest !== envelope.result.traceDigest) throw new Error("cached attempt trace digest mismatch");
    const events = readTrace(expectedTracePath);
    const traceReasons = [
      ...validateExperimentTrace({ attemptId: attempt.id, events }),
      ...validateConditionTrace(
        attempt,
        events,
        expectedIntegrity.model,
        expectedIntegrity.runId,
        envelope.executionId,
        expectedIntegrity.environmentFingerprintHash,
        expectedIntegrity.executionEnvironmentHash,
        expectedIntegrity.publicationRanker
      )
    ];
    if (traceReasons.length > 0) throw new Error(`cached trace is invalid: ${traceReasons[0]}`);
    const workspaceTreeDigest = scalarStringMetadata(
      events.find((event) => event.kind === "assistance_start")?.metadata?.workspaceTreeDigest
    );
    if (envelope.result.workspaceTreeDigest !== workspaceTreeDigest) {
      throw new Error("cached attempt workspace tree digest does not match its trace");
    }
    return envelope.result;
  } catch (error) {
    throw new Error(`Cannot resume cached attempt '${attempt.id}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeCachedAttempt(outDir: string, result: ExperimentAttemptResult, integrity: AttemptCacheIntegrity): void {
  const envelope: AttemptCacheEnvelope = {
    schemaVersion: 5,
    integrity,
    executionId: result.executionId ?? "planned",
    resultHash: sha256(JSON.stringify(result)),
    result
  };
  fs.writeFileSync(
    path.join(outDir, "attempts", `${result.attempt.id}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function currentGitCommit(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: resolvePackageRoot() });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function currentGitDirty(): boolean | undefined {
  const result = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: resolvePackageRoot() });
  return result.status === 0 ? result.stdout.trim().length > 0 : undefined;
}

function currentPackageVersion(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(resolvePackageRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function resolvePackageRoot(): string {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(current, "../.."), path.resolve(current, ".."), process.cwd()];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json"))) ?? process.cwd();
}

function workspaceGitCommit(workspacePath: string): string | undefined {
  if (!workspacePath) return undefined;
  const result = spawnSync("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 && /^[a-f0-9]{40,64}$/i.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
}

function localFileHash(value: string | undefined): string | undefined {
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  const resolved = path.resolve(value);
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? sha256(fs.readFileSync(resolved)) : undefined;
}

type HarnessFingerprint = {
  hash: string;
  files: Record<string, string>;
  complete: boolean;
  missing: string[];
};

type CommandFingerprint = {
  command: string;
  commandHash: string;
  files: Array<{ path: string; hash: string }>;
  packages: Array<{ path: string; version: string; hash: string }>;
  runtimePackage?: {
    name: string;
    version: string;
    manifestHash: string;
    dependencyTreeHash?: string | undefined;
  } | undefined;
  runtimeFiles: Array<{ path: string; hash: string }>;
  complete: boolean;
  hash: string;
};

function fingerprintHarnessSources(hostPath: string): HarnessFingerprint {
  const root = resolvePackageRoot();
  const groups: Array<{ id: string; candidates: string[] }> = [
    { id: "python-host", candidates: [hostPath] },
    { id: "agent-host", candidates: ["src/bench/agent.ts", "dist/bench/agent.js"] },
    { id: "experiment-runner", candidates: ["src/bench/experiment.ts", "dist/bench/experiment.js"] },
    { id: "experiment-metrics", candidates: ["src/bench/experimentMetrics.ts", "dist/bench/experimentMetrics.js"] },
    { id: "experiment-plan", candidates: ["src/bench/experimentPlan.ts", "dist/bench/experimentPlan.js"] },
    { id: "experiment-report", candidates: ["src/bench/experimentReport.ts", "dist/bench/experimentReport.js"] },
    { id: "benchmark-types", candidates: ["src/types/bench.ts", "dist/types/bench.js"] },
    { id: "experiment-types", candidates: ["src/types/experiment.ts", "dist/types/experiment.js"] },
    { id: "ranker-model", candidates: ["src/retrieval/evidenceModel.ts", "dist/retrieval/evidenceModel.js"] },
    { id: "ranker-inference", candidates: ["src/retrieval/evidenceRanker.ts", "dist/retrieval/evidenceRanker.js"] },
    { id: "ranker-signals", candidates: ["src/retrieval/evidenceSignals.ts", "dist/retrieval/evidenceSignals.js"] },
    { id: "ranker-types", candidates: ["src/types/evidence.ts", "dist/types/evidence.js"] },
    { id: "runtime", candidates: ["src/runtime/KairnRuntime.ts", "dist/runtime/KairnRuntime.js"] },
    { id: "mcp", candidates: ["src/server/mcp.ts", "dist/server/mcp.js"] },
    { id: "cli", candidates: ["src/cli.ts", "dist/cli.js"] },
    { id: "package-manifest", candidates: ["package.json"] },
    { id: "dependency-lock", candidates: ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json"] },
    { id: "python-dependencies", candidates: ["benchmarks/requirements.txt", "benchmarks/requirements-comparison.txt"] }
  ];
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const group of groups) {
    const found = group.candidates
      .map((candidate) => path.isAbsolute(candidate) ? candidate : path.join(root, candidate))
      .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (found.length === 0) {
      missing.push(group.id);
      continue;
    }
    for (const candidate of found) {
      files[fingerprintPath(candidate, root)] = sha256(fs.readFileSync(candidate));
    }
  }
  for (const directory of [path.join(root, "src"), path.join(root, "dist")]) {
    for (const candidate of recursiveFiles(directory, (file) => /\.(?:ts|js|cjs|mjs)$/.test(file))) {
      files[fingerprintPath(candidate, root)] = sha256(fs.readFileSync(candidate));
    }
  }
  for (const candidate of recursiveFiles(path.join(root, "benchmarks"), (file) => file.endsWith(".py"))) {
    files[fingerprintPath(candidate, root)] = sha256(fs.readFileSync(candidate));
  }
  const orderedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  return {
    hash: sha256(JSON.stringify(orderedFiles)),
    files: orderedFiles,
    complete: missing.length === 0,
    missing
  };
}

function recursiveFiles(directory: string, accepts: (file: string) => boolean): string[] {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  const found: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__pycache__") pending.push(target);
      } else if (entry.isFile() && accepts(target)) {
        found.push(target);
      }
    }
  }
  return found.sort();
}

function fingerprintCommand(command: string): CommandFingerprint {
  const root = resolvePackageRoot();
  const tokens = splitCommand(command);
  const candidates = new Set<string>();
  const executable = tokens[0] ? resolveCommandFile(tokens[0], root) : undefined;
  if (executable) candidates.add(executable);
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) continue;
    const resolved = resolveCommandFile(token, root);
    if (resolved) candidates.add(resolved);
  }
  const files = [...candidates]
    .map((candidate) => {
      const real = fs.realpathSync(candidate);
      return { path: fingerprintPath(real, root), hash: sha256(fs.readFileSync(real)) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const packages = [...new Set([...candidates].map(nearestPackageManifest).filter((value): value is string => Boolean(value)))]
    .map((manifest) => {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown };
      return {
        path: fingerprintPath(manifest, root),
        version: typeof parsed.version === "string" ? parsed.version : "unknown",
        hash: sha256(fs.readFileSync(manifest))
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const runtimeManifest = resolveKairnRuntimeManifest([...candidates], root);
  const runtime = runtimeManifest ? fingerprintRuntimePackage(runtimeManifest) : undefined;
  const commandHash = sha256(command);
  const fingerprint: CommandFingerprint = {
    command,
    commandHash,
    files,
    packages,
    ...(runtime ? { runtimePackage: runtime.package, runtimeFiles: runtime.files } : { runtimeFiles: [] }),
    complete: Boolean(runtime && runtime.package.name === "usekairn" && runtime.files.length > 0),
    hash: ""
  };
  fingerprint.hash = sha256(JSON.stringify({
    commandHash,
    files,
    packages,
    runtimePackage: fingerprint.runtimePackage ?? null,
    runtimeFiles: fingerprint.runtimeFiles,
    complete: fingerprint.complete
  }));
  return fingerprint;
}

function resolveKairnRuntimeManifest(candidates: string[], root: string): string | undefined {
  const manifests = new Set<string>();
  for (const candidate of candidates) {
    const nearest = nearestPackageManifest(candidate);
    if (nearest) manifests.add(nearest);
    const sibling = path.join(path.dirname(candidate), "node_modules", "usekairn", "package.json");
    if (fs.existsSync(sibling) && fs.statSync(sibling).isFile()) manifests.add(sibling);
  }
  const local = path.join(root, "package.json");
  if (fs.existsSync(local) && candidates.some((candidate) => isPathWithin(path.dirname(local), candidate))) {
    manifests.add(local);
  }
  return [...manifests].find((manifest) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
      return parsed.name === "usekairn";
    } catch {
      return false;
    }
  });
}

function fingerprintRuntimePackage(manifestPath: string): {
  package: NonNullable<CommandFingerprint["runtimePackage"]>;
  files: CommandFingerprint["runtimeFiles"];
} {
  const packageRoot = path.dirname(fs.realpathSync(manifestPath));
  const manifestBytes = fs.readFileSync(manifestPath);
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as {
    name?: unknown;
    version?: unknown;
    files?: unknown;
    bin?: unknown;
  };
  const declared = new Set<string>(["package.json"]);
  if (Array.isArray(parsed.files)) {
    for (const item of parsed.files) if (typeof item === "string" && item.trim()) declared.add(item);
  }
  if (typeof parsed.bin === "string") declared.add(parsed.bin);
  if (parsed.bin && typeof parsed.bin === "object" && !Array.isArray(parsed.bin)) {
    for (const item of Object.values(parsed.bin as Record<string, unknown>)) {
      if (typeof item === "string" && item.trim()) declared.add(item);
    }
  }
  const candidates = new Set<string>();
  for (const declaredPath of declared) {
    const target = path.resolve(packageRoot, declaredPath);
    if (!isPathWithin(packageRoot, target) || !fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (stat.isFile()) candidates.add(target);
    if (stat.isDirectory()) {
      for (const file of recursiveFiles(target, () => true)) candidates.add(file);
    }
  }
  const files = [...candidates]
    .map((candidate) => ({
      path: `package:${path.relative(packageRoot, candidate).replace(/\\/g, "/")}`,
      hash: sha256(fs.readFileSync(candidate))
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const dependencyTree = spawnSync("npm", ["ls", "--json", "--all", "--omit=dev"], {
    cwd: packageRoot,
    encoding: "utf8"
  });
  const dependencyTreeHash = dependencyTree.stdout.trim()
    ? sha256(dependencyTree.stdout.trim())
    : undefined;
  return {
    package: {
      name: typeof parsed.name === "string" ? parsed.name : "unknown",
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
      manifestHash: sha256(manifestBytes),
      ...(dependencyTreeHash ? { dependencyTreeHash } : {})
    },
    files
  };
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildCampaignFingerprint(input: {
  harnessFingerprint: HarnessFingerprint;
  kairnCommit?: string | undefined;
  kairnPackageVersion: string;
  kairnCommandFingerprint: CommandFingerprint;
  kairnEnvironmentFingerprint: KairnEnvironmentFingerprint;
  executionEnvironment: ExperimentExecutionEnvironment;
  rankerModelHash?: string | undefined;
  rankerModelId?: string | undefined;
  rankerMode?: string | undefined;
  publicationRanker?: PublicationRankerExpectation | undefined;
}) {
  const components = {
    harnessHash: input.harnessFingerprint.hash,
    kairnCommit: input.kairnCommit ?? null,
    kairnPackageVersion: input.kairnPackageVersion,
    kairnCommand: input.kairnCommandFingerprint,
    kairnEnvironment: input.kairnEnvironmentFingerprint,
    executionEnvironment: input.executionEnvironment,
    ranker: {
      configuredMode: input.rankerMode ?? "legacy",
      configuredModelId: input.rankerModelId ?? null,
      modelHash: input.rankerModelHash ?? null,
      runtimeFeatureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
      runtimeFeatureSchemaHash: EVIDENCE_FEATURE_SCHEMA_HASH,
      publicationExpectation: input.publicationRanker ?? null
    }
  };
  return { ...components, hash: sha256(JSON.stringify(components)) };
}

type DockerRuntimeVersion = {
  clientVersion: string;
  serverVersion: string;
  serverOs: string;
  serverArchitecture: string;
};

const PINNED_EXPERIMENT_IMAGE = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/i;

export function parseDockerImageInspect(
  requestedImage: string,
  raw: string
): ExperimentDockerImageProvenance {
  if (!PINNED_EXPERIMENT_IMAGE.test(requestedImage)) {
    throw new Error(`Sandbox image is not digest-pinned: ${requestedImage}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Docker returned unreadable inspection data for ${requestedImage}.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(`Docker inspection must resolve exactly one image for ${requestedImage}.`);
  }
  const image = parsed[0];
  const id = scalarStringMetadata(image.Id);
  const repoDigests = Array.isArray(image.RepoDigests)
    ? [...new Set(image.RepoDigests.filter((value): value is string => typeof value === "string" && value.trim().length > 0))]
        .sort((left, right) => left.localeCompare(right))
    : [];
  const imageOs = scalarStringMetadata(image.Os);
  const architecture = scalarStringMetadata(image.Architecture);
  if (!id || !/^sha256:[a-f0-9]{64}$/i.test(id)) {
    throw new Error(`Docker inspection did not return a content-addressed image Id for ${requestedImage}.`);
  }
  if (!repoDigests.some((digest) => digest.toLowerCase() === requestedImage.toLowerCase())) {
    throw new Error(`Docker inspection RepoDigests do not contain the requested pin ${requestedImage}.`);
  }
  if (imageOs !== "linux") {
    throw new Error(`Sandbox image ${requestedImage} must resolve to Linux (found ${imageOs ?? "missing"}).`);
  }
  if (!architecture) {
    throw new Error(`Docker inspection did not return an architecture for ${requestedImage}.`);
  }
  const config = isRecord(image.Config) ? image.Config : undefined;
  const volumes = config && isRecord(config.Volumes) ? Object.keys(config.Volumes) : [];
  if (volumes.length > 0) {
    throw new Error(`Sandbox image ${requestedImage} declares writable VOLUME paths.`);
  }
  return { requestedImage, id, repoDigests, os: imageOs, architecture };
}

export function parseDockerRuntimeVersion(raw: string): DockerRuntimeVersion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Docker returned unreadable runtime-version data.");
  }
  if (!isRecord(parsed) || !isRecord(parsed.Client) || !isRecord(parsed.Server)) {
    throw new Error("Docker runtime-version data is incomplete.");
  }
  const clientVersion = scalarStringMetadata(parsed.Client.Version);
  const serverVersion = scalarStringMetadata(parsed.Server.Version);
  const serverOs = scalarStringMetadata(parsed.Server.Os);
  const serverArchitecture = scalarStringMetadata(parsed.Server.Arch);
  if (!clientVersion || !serverVersion || !serverOs || !serverArchitecture) {
    throw new Error("Docker runtime-version data is missing client/server version or platform fields.");
  }
  return { clientVersion, serverVersion, serverOs, serverArchitecture };
}

export function buildExecutionEnvironmentFingerprint(
  hostRuntime: ExperimentHostRuntimeFingerprint,
  dockerImages: ExperimentDockerImageProvenance[],
  verified: boolean
): ExperimentExecutionEnvironment {
  const normalizedImages = [...dockerImages]
    .map((image) => ({ ...image, repoDigests: [...image.repoDigests].sort((left, right) => left.localeCompare(right)) }))
    .sort((left, right) => left.requestedImage.localeCompare(right.requestedImage));
  const payload = {
    schemaVersion: 1 as const,
    verified,
    hostRuntime: { ...hostRuntime },
    dockerImages: normalizedImages
  };
  return { ...payload, hash: sha256(canonicalFingerprintJson(payload)) };
}

function collectExecutionEnvironment(input: {
  plan: ExperimentPlan;
  requireResolvedImages: boolean;
}): ExperimentExecutionEnvironment {
  const pythonVersion = commandVersion(input.plan.pythonCommand ?? "python3");
  if (input.requireResolvedImages && pythonVersion === "unavailable") {
    throw new Error("The frozen experiment Python runtime is unavailable.");
  }
  const dockerRuntime = input.requireResolvedImages ? inspectDockerRuntimeVersion() : undefined;
  const cpu = os.cpus();
  const hostRuntime: ExperimentHostRuntimeFingerprint = {
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    endianness: os.endianness(),
    cpuModel: cpu[0]?.model.trim() || "unknown",
    logicalCpuCount: cpu.length,
    pythonVersion,
    ...(dockerRuntime
      ? {
          dockerClientVersion: dockerRuntime.clientVersion,
          dockerServerVersion: dockerRuntime.serverVersion,
          dockerServerOs: dockerRuntime.serverOs,
          dockerServerArchitecture: dockerRuntime.serverArchitecture
        }
      : {})
  };
  const requestedImages = [...new Set(input.plan.tasks.map((task) => task.sandboxImage).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right));
  const dockerImages = input.requireResolvedImages
    ? requestedImages.map(inspectDockerImage)
    : [];
  return buildExecutionEnvironmentFingerprint(
    hostRuntime,
    dockerImages,
    input.requireResolvedImages && dockerImages.length === requestedImages.length
  );
}

function inspectDockerRuntimeVersion(): DockerRuntimeVersion {
  const result = spawnSync("docker", ["version", "--format", "{{json .}}"], {
    env: scrubCredentials(process.env),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker runtime inspection failed: ${dockerFailureDetail(result)}.`);
  }
  return parseDockerRuntimeVersion(result.stdout);
}

function inspectDockerImage(requestedImage: string): ExperimentDockerImageProvenance {
  const result = spawnSync("docker", ["image", "inspect", requestedImage], {
    env: scrubCredentials(process.env),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Pinned sandbox image is unavailable locally (${requestedImage}): ${dockerFailureDetail(result)}.`);
  }
  return parseDockerImageInspect(requestedImage, result.stdout);
}

function dockerFailureDetail(result: ReturnType<typeof spawnSync>): string {
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return [stderr, stdout, result.error?.message].filter(Boolean).join("\n").trim().slice(-1000) || "command failed";
}

function commandVersion(command: string): string {
  const tokens = splitCommand(command);
  if (!tokens[0]) return "unavailable";
  const result = spawnSync(tokens[0], [...tokens.slice(1), "--version"], {
    env: scrubCredentials(process.env),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024
  });
  if (result.error || result.status !== 0) return "unavailable";
  return [result.stdout, result.stderr].filter(Boolean).join(" ").trim().replace(/\s+/g, " ") || "unavailable";
}

function canonicalFingerprintJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFingerprintJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalFingerprintJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type KairnEnvironmentFingerprint = {
  values: Record<string, unknown>;
  unknownKeys: string[];
  hash: string;
};

const FROZEN_KAIRN_ENVIRONMENT_KEYS = [
  "KAIRN_BENCH_KAIRN_CMD",
  "KAIRN_CODEX_CMD",
  "KAIRN_CMD",
  "KAIRN_COMMIT",
  "KAIRN_DISABLE_BACKGROUND_INDEX",
  "KAIRN_DISABLE_DAEMON",
  "KAIRN_DISABLE_WASM_PARSER",
  "KAIRN_EVIDENCE_ARTIFACT_URL",
  "KAIRN_GOVERNOR_MODEL",
  "KAIRN_PARSER_BACKEND",
  "KAIRN_PYTHON",
  "KAIRN_RANKER_MODE",
  "KAIRN_RANKER_MODEL",
  "KAIRN_RANKER_MODEL_ID",
  "KAIRN_TELEMETRY_ENDPOINT",
  "KAIRN_WIZARD_WASM_INDEX"
] as const;

function fingerprintKairnEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { publication: boolean }
): KairnEnvironmentFingerprint {
  const known = new Set<string>(FROZEN_KAIRN_ENVIRONMENT_KEYS);
  const presentKairnKeys = Object.keys(environment)
    .filter((key) => key.startsWith("KAIRN_") && typeof environment[key] === "string")
    .sort();
  const unknownKeys = presentKairnKeys.filter((key) => !known.has(key));
  if (options.publication && unknownKeys.length > 0) {
    throw new Error(`Publication experiments reject unknown KAIRN_* environment controls: ${unknownKeys.join(", ")}.`);
  }
  if (options.publication && environment.KAIRN_TELEMETRY_ENDPOINT?.trim()) {
    throw new Error("Publication experiments require Kairn telemetry to remain unconfigured.");
  }
  if (options.publication && environment.KAIRN_GOVERNOR_MODEL?.trim()) {
    throw new Error("Publication experiments do not permit a separate learned governor model.");
  }
  const pathKeys = new Set(["KAIRN_GOVERNOR_MODEL", "KAIRN_RANKER_MODEL"]);
  const secretLikeKeys = new Set(["KAIRN_EVIDENCE_ARTIFACT_URL"]);
  const values: Record<string, unknown> = {};
  for (const key of FROZEN_KAIRN_ENVIRONMENT_KEYS) {
    const value = environment[key]?.trim();
    values[key] = !value
      ? null
      : pathKeys.has(key)
        ? { configured: true, fileHash: localFileHash(value) ?? "unreadable" }
        : secretLikeKeys.has(key)
          ? { configured: true, valueHash: sha256(value) }
          : value;
  }
  for (const key of unknownKeys) {
    values[key] = { configured: true, valueHash: sha256(environment[key] ?? "") };
  }
  return { values, unknownKeys, hash: sha256(JSON.stringify(values)) };
}

function splitCommand(command: string): string[] {
  const values: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(expression)) {
    values.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\"/g, '"'));
  }
  return values.filter(Boolean);
}

function resolveCommandFile(token: string, root: string, searchPath = true): string | undefined {
  const direct = path.isAbsolute(token) ? token : path.resolve(root, token);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!searchPath || token.includes("/") || token.includes("\\")) return undefined;
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [token], { encoding: "utf8" });
  const located = result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined;
  return located && fs.existsSync(located) && fs.statSync(located).isFile() ? located : undefined;
}

function nearestPackageManifest(value: string): string | undefined {
  let current = path.dirname(fs.realpathSync(value));
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function fingerprintPath(value: string, root: string): string {
  const relative = path.relative(root, value).replace(/\\/g, "/");
  return relative && !relative.startsWith("../") && relative !== ".."
    ? relative
    : `external:${path.basename(value)}`;
}

export type WorkspaceTreeParityBlock = {
  blockId: string;
  consistent: boolean;
  digest?: string | undefined;
  attemptIds: string[];
  missingConditions: string[];
  duplicateConditions: string[];
  invalidDigestAttemptIds: string[];
  reasons: string[];
};

export type WorkspaceTreeParity = {
  consistent: boolean;
  blocks: WorkspaceTreeParityBlock[];
};

export function evaluateWorkspaceTreeParity(attempts: ExperimentAttemptResult[]): WorkspaceTreeParity {
  const grouped = new Map<string, ExperimentAttemptResult[]>();
  for (const attempt of attempts) {
    grouped.set(attempt.attempt.blockId, [...(grouped.get(attempt.attempt.blockId) ?? []), attempt]);
  }
  const blocks = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([blockId, entries]): WorkspaceTreeParityBlock => {
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.attempt.condition, (counts.get(entry.attempt.condition) ?? 0) + 1);
      const missingConditions = EXPERIMENT_CONDITIONS.filter((condition) => !counts.has(condition));
      const duplicateConditions = [...counts.entries()]
        .filter(([, count]) => count !== 1)
        .map(([condition]) => condition)
        .sort();
      const invalidDigestAttemptIds = entries
        .filter((entry) => !isSha256(entry.workspaceTreeDigest))
        .map((entry) => entry.attempt.id)
        .sort();
      const digests = new Set(entries.map((entry) => entry.workspaceTreeDigest).filter(isSha256));
      const reasons: string[] = [];
      if (missingConditions.length > 0) reasons.push(`missing arms: ${missingConditions.join(", ")}`);
      if (duplicateConditions.length > 0) reasons.push(`duplicate arms: ${duplicateConditions.join(", ")}`);
      if (invalidDigestAttemptIds.length > 0) {
        reasons.push(`missing or invalid workspace digest: ${invalidDigestAttemptIds.join(", ")}`);
      }
      if (digests.size > 1) reasons.push("workspace digests differ across arms");
      const consistent = reasons.length === 0 && entries.length === EXPERIMENT_CONDITIONS.length && digests.size === 1;
      return {
        blockId,
        consistent,
        ...(consistent ? { digest: [...digests][0] } : {}),
        attemptIds: entries.map((entry) => entry.attempt.id).sort(),
        missingConditions,
        duplicateConditions,
        invalidDigestAttemptIds,
        reasons
      };
    });
  return { consistent: blocks.length > 0 && blocks.every((block) => block.consistent), blocks };
}

function applyWorkspaceTreeParityFailures(
  attempts: ExperimentAttemptResult[],
  parity: WorkspaceTreeParity
): void {
  const failures = new Map(
    parity.blocks
      .filter((block) => !block.consistent)
      .map((block) => [block.blockId, `workspace tree parity failed: ${block.reasons.join("; ")}`])
  );
  for (const attempt of attempts) {
    const failure = failures.get(attempt.attempt.blockId);
    if (!failure) continue;
    attempt.traceValid = false;
    if (!attempt.invalidReasons.includes(failure)) attempt.invalidReasons.push(failure);
    if (attempt.status === "passed" || attempt.status === "failed") attempt.status = "invalid";
  }
}

function assertPublicationSchedule(plan: ExperimentPlan, schedule: ExperimentAttemptPlan[], repeats: number): void {
  const counts = new Map(EXPERIMENT_CONDITIONS.map((condition) => [condition, 0]));
  for (const attempt of schedule) counts.set(attempt.condition, (counts.get(attempt.condition) ?? 0) + 1);
  const balanced = EXPERIMENT_CONDITIONS.every((condition) => counts.get(condition) === 150);
  if (
    plan.tasks.length !== 30 ||
    repeats !== 5 ||
    schedule.length !== 600 ||
    new Set(schedule.map((attempt) => attempt.id)).size !== 600 ||
    !balanced
  ) {
    throw new Error("Publication schedule is frozen at 30 tasks x 5 repeats x 4 arms (600 unique attempts; 150 per arm).");
  }
}

function validatePublicRepositoryUrlShape(value: string): void {
  const parsed = new URL(value);
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1] ?? "";
  const explicitPort = /:\d+$/.test(authority);
  if (explicitPort || value.includes("?") || value.includes("#") || parsed.username || parsed.password) {
    throw new Error(`Public repository URL must not contain credentials, a port, query, or fragment: ${value}`);
  }
}

function resolveEvidenceArtifactUrl(
  value: string | undefined,
  options: { required: boolean }
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    if (options.required) {
      throw new Error("Publication attempts require KAIRN_EVIDENCE_ARTIFACT_URL for the immutable raw artifact bundle.");
    }
    return undefined;
  }
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("KAIRN_EVIDENCE_ARTIFACT_URL must be a public HTTPS URL without credentials or a fragment.");
  }
  return parsed.toString();
}

function snapshotSetupPatchFiles(plan: ExperimentPlan): ExperimentPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      if (!task.setupPatchFile) return task;
      if (!fs.existsSync(task.setupPatchFile) || !fs.statSync(task.setupPatchFile).isFile()) {
        throw new Error(`${task.id}: setupPatchFile is missing or is not a regular file.`);
      }
      const { setupPatchFile: _setupPatchFile, ...withoutFile } = task;
      return {
        ...withoutFile,
        setupPatch: fs.readFileSync(task.setupPatchFile, "utf8")
      };
    })
  };
}

type PublicationRankerExpectation = {
  modelId: string;
  modelHash: string;
  artifactChecksum: string;
  featureSchemaVersion: string;
  featureSchemaHash: string;
};

function validatePublicationModelLineage(
  modelPath: string,
  expectedModelId: string,
  repositoryUrls: string[]
): PublicationRankerExpectation {
  const artifactPath = path.resolve(modelPath);
  const artifact = loadEvidenceRankerArtifact(artifactPath);
  if (artifact.modelId !== expectedModelId) {
    throw new Error("Publication ranker model id/checksum does not match KAIRN_RANKER_MODEL_ID.");
  }
  if (!nonEmptyString(artifact.trainingManifest) || path.basename(artifact.trainingManifest) !== artifact.trainingManifest) {
    throw new Error("Publication ranker artifact must name a sibling training manifest.");
  }
  const manifestPath = path.join(path.dirname(artifactPath), artifact.trainingManifest);
  if (!fs.existsSync(manifestPath)) throw new Error("Publication ranker training manifest is missing beside the model artifact.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    publicDataOnly?: unknown;
    repositoryLineages?: Record<string, unknown>;
    artifactChecksum?: unknown;
  };
  if (manifest.publicDataOnly !== true || manifest.artifactChecksum !== artifact.checksum) {
    throw new Error("Publication ranker training manifest lacks public-data or artifact-checksum provenance.");
  }
  if (!isRecord(manifest.repositoryLineages)) {
    throw new Error("Publication ranker training manifest must declare repositoryLineages.");
  }
  const lineageBySplit = new Map<string, Set<string>>();
  for (const split of ["train", "calibration", "holdout"] as const) {
    const raw = manifest.repositoryLineages[split];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`Publication ranker training manifest requires a nonempty ${split} repository lineage array.`);
    }
    const normalized = raw.map((value) => {
      if (typeof value !== "string") {
        throw new Error(`Publication ranker ${split} lineage entries must be HTTPS repository URLs.`);
      }
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`Publication ranker ${split} lineage entries must be stable public HTTPS repository URLs.`);
      }
      return canonicalRepositoryUrl(value);
    });
    lineageBySplit.set(split, new Set(normalized));
  }
  const lineageOwners = new Map<string, string[]>();
  for (const [split, values] of lineageBySplit) {
    for (const value of values) lineageOwners.set(value, [...(lineageOwners.get(value) ?? []), split]);
  }
  const crossSplitOverlap = [...lineageOwners].filter(([, splits]) => splits.length > 1);
  if (crossSplitOverlap.length > 0) {
    throw new Error(
      `Publication ranker train/calibration/holdout lineages overlap: ${crossSplitOverlap.map(([repo]) => repo).join(", ")}`
    );
  }
  const lineages = [...lineageOwners.keys()];
  const publicationRepositories = new Set(repositoryUrls.map(canonicalRepositoryUrl));
  const overlap = [...new Set(lineages)].filter((lineage) => publicationRepositories.has(lineage));
  if (overlap.length > 0) {
    throw new Error(`Publication repositories overlap ranker training/calibration/holdout lineages: ${overlap.join(", ")}`);
  }
  return {
    modelId: artifact.modelId,
    modelHash: sha256(fs.readFileSync(artifactPath)),
    artifactChecksum: artifact.checksum,
    featureSchemaVersion: artifact.featureSchemaVersion,
    featureSchemaHash: artifact.featureSchemaHash
  };
}

function canonicalRepositoryUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\.git\/?$/, "").replace(/\/$/, "");
}

type TraceProvenance = {
  consistent: boolean;
  toolSchemaHash?: string | undefined;
  anthropicVersion?: string | undefined;
  reasonblocksVersion?: string | undefined;
  reasonblocksServiceVersion?: string | undefined;
  reasonblocksServiceVersionSource?: "operator_asserted" | undefined;
  pythonVersion?: string | undefined;
  hostProtocolVersion?: string | undefined;
  resolvedModel?: string | undefined;
  rankerRequestedMode?: string | undefined;
  rankerServedMode?: string | undefined;
  rankerModelId?: string | undefined;
  rankerFeatureSchemaVersion?: string | undefined;
};

function collectTraceProvenance(attempts: ExperimentAttemptResult[]): TraceProvenance {
  const values = {
    toolSchemaHash: new Set<string>(),
    anthropicVersion: new Set<string>(),
    reasonblocksVersion: new Set<string>(),
    reasonblocksServiceVersion: new Set<string>(),
    reasonblocksServiceVersionSource: new Set<string>(),
    pythonVersion: new Set<string>(),
    hostProtocolVersion: new Set<string>(),
    resolvedModel: new Set<string>(),
    rankerRequestedMode: new Set<string>(),
    rankerServedMode: new Set<string>(),
    rankerModelId: new Set<string>(),
    rankerFeatureSchemaVersion: new Set<string>()
  };
  let completeTraceCount = 0;
  let kairnDecisionCount = 0;
  let rankerStatusCount = 0;
  for (const attempt of attempts) {
    if (!attempt.tracePath || !fs.existsSync(attempt.tracePath)) continue;
    const events = readTrace(attempt.tracePath);
    const start = events.find((event) => event.kind === "attempt_start")?.metadata;
    const end = events.find((event) => event.kind === "attempt_end");
    if (!start || !end) continue;
    completeTraceCount += 1;
    addMetadataString(values.toolSchemaHash, start.toolSchemaHash);
    addMetadataString(values.anthropicVersion, start.anthropicVersion);
    addMetadataString(values.reasonblocksVersion, start.reasonblocksVersion);
    addMetadataString(values.reasonblocksServiceVersion, start.reasonblocksServiceVersion);
    if (nonEmptyString(start.reasonblocksServiceVersion) && start.reasonblocksServiceVersion !== "unavailable") {
      addMetadataString(values.reasonblocksServiceVersionSource, start.reasonblocksServiceVersionSource);
    }
    addMetadataString(values.pythonVersion, start.pythonVersion);
    addMetadataString(values.hostProtocolVersion, start.hostProtocolVersion);
    for (const response of events.filter((event) => event.kind === "model_response")) {
      addMetadataString(values.resolvedModel, response.metadata?.resolvedModel);
    }
    for (const decision of events.filter((event) => event.kind === "provider_injection" && event.provider === "kairn")) {
      kairnDecisionCount += 1;
      const ranker = rankerStatusFromTraceEvent(decision);
      if (!ranker) continue;
      rankerStatusCount += 1;
      addMetadataString(values.rankerRequestedMode, ranker.requestedMode);
      addMetadataString(values.rankerServedMode, ranker.servedMode);
      addMetadataString(values.rankerModelId, ranker.modelId);
      addMetadataString(values.rankerFeatureSchemaVersion, ranker.featureSchemaVersion);
    }
  }
  const first = (set: Set<string>): string | undefined => set.values().next().value as string | undefined;
  const singular = Object.values(values).every((set) => set.size <= 1);
  const allCompletedTracesPresent = completeTraceCount === attempts.length && attempts.length > 0;
  const requiredPresent = values.toolSchemaHash.size === 1 &&
    values.anthropicVersion.size === 1 &&
    values.pythonVersion.size === 1 &&
    values.hostProtocolVersion.size === 1 &&
    values.resolvedModel.size === 1 &&
    values.reasonblocksServiceVersion.size === 1 &&
    values.reasonblocksServiceVersionSource.size === 1 &&
    kairnDecisionCount > 0 &&
    rankerStatusCount === kairnDecisionCount &&
    values.rankerRequestedMode.size === 1 &&
    values.rankerServedMode.size === 1 &&
    values.rankerModelId.size === 1 &&
    values.rankerFeatureSchemaVersion.size === 1;
  return {
    consistent: singular && allCompletedTracesPresent && requiredPresent,
    ...(first(values.toolSchemaHash) ? { toolSchemaHash: first(values.toolSchemaHash) } : {}),
    ...(first(values.anthropicVersion) ? { anthropicVersion: first(values.anthropicVersion) } : {}),
    ...(first(values.reasonblocksVersion) ? { reasonblocksVersion: first(values.reasonblocksVersion) } : {}),
    ...(first(values.reasonblocksServiceVersion) ? { reasonblocksServiceVersion: first(values.reasonblocksServiceVersion) } : {}),
    ...(first(values.reasonblocksServiceVersionSource) === "operator_asserted"
      ? { reasonblocksServiceVersionSource: "operator_asserted" as const }
      : {}),
    ...(first(values.pythonVersion) ? { pythonVersion: first(values.pythonVersion) } : {}),
    ...(first(values.hostProtocolVersion) ? { hostProtocolVersion: first(values.hostProtocolVersion) } : {}),
    ...(first(values.resolvedModel) ? { resolvedModel: first(values.resolvedModel) } : {}),
    ...(first(values.rankerRequestedMode) ? { rankerRequestedMode: first(values.rankerRequestedMode) } : {}),
    ...(first(values.rankerServedMode) ? { rankerServedMode: first(values.rankerServedMode) } : {}),
    ...(first(values.rankerModelId) ? { rankerModelId: first(values.rankerModelId) } : {}),
    ...(first(values.rankerFeatureSchemaVersion) ? { rankerFeatureSchemaVersion: first(values.rankerFeatureSchemaVersion) } : {})
  };
}

function addMetadataString(target: Set<string>, value: unknown): void {
  if (nonEmptyString(value)) target.add(value);
}

function scrubCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safeKeys = new Set([
    "PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
    "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "TMP", "TEMP", "TMPDIR",
    "SHELL", "USER", "USERNAME", "LOGNAME", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"
  ]);
  const scrubbed: NodeJS.ProcessEnv = {
    CI: "true",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
  };
  for (const key of safeKeys) {
    const value = environment[key];
    if (typeof value === "string") scrubbed[key] = value;
  }
  return scrubbed;
}

function stringMetadata(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function scalarStringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanMetadata(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalizedFile = normalizePatternPath(filePath);
  return patterns.some((pattern) => {
    const normalized = normalizePatternPath(pattern);
    if (!normalized.includes("*")) {
      return normalizedFile === normalized || normalizedFile.startsWith(`${normalized.replace(/\/$/, "")}/`);
    }
    const expression = normalized
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${expression}$`).test(normalizedFile);
  });
}

function normalizePatternPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function removeBenchmarkWorkspace(workspacePath: string): void {
  if (!workspacePath) return;
  const resolved = path.resolve(workspacePath);
  const temp = path.resolve(os.tmpdir());
  const name = path.basename(resolved);
  if (path.dirname(resolved) !== temp || !name.startsWith("kairn-bench-")) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

function numberMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
