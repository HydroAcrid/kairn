import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { BenchmarkCase, BenchmarkSeedSpec, BenchmarkTaskOutcome } from "../types.js";
import { parseCodexUsageFooter } from "../eval/codexUsage.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath } from "../utils/paths.js";
import { estimateTokens } from "../utils/tokens.js";
import { evaluateDiffScopes, evaluateSourceInvariants } from "./sourceValidation.js";

export type AgentBenchmarkResult = {
  workspacePath: string;
  actualFiles: string[];
  responseTokens: number;
  observedCodexTokens?: number;
  outcome: BenchmarkTaskOutcome;
  summary: string;
  metadata: Record<string, unknown>;
};

export async function runAgentBenchmarkCase(input: {
  rootPath: string;
  benchmarkCase: BenchmarkCase;
  agentCommand?: string | undefined;
  setupCommand?: string | undefined;
  timeoutMs?: number | undefined;
  preparePrompt?: ((input: {
    workspacePath: string;
    prompt: string;
    benchmarkCase: BenchmarkCase;
  }) => Promise<{ prompt: string; metadata?: Record<string, unknown> }> | { prompt: string; metadata?: Record<string, unknown> }) | undefined;
}): Promise<AgentBenchmarkResult> {
  const prompt = input.benchmarkCase.agentPrompt ?? input.benchmarkCase.task;
  let workspacePath = "";
  let seedMetadata: Record<string, unknown> = {};
  const workspaceStartedAt = Date.now();

  try {
    const workspace = createBenchmarkWorkspace({
      rootPath: input.rootPath,
      benchmarkCase: input.benchmarkCase
    });
    workspacePath = workspace.workspacePath;
    seedMetadata = {
      ...workspace.metadata,
      workspaceSetupMs: Date.now() - workspaceStartedAt
    };
  } catch (error) {
    if (error instanceof MissingBenchmarkPrerequisiteError) {
      return {
        workspacePath,
        actualFiles: [],
        responseTokens: 0,
        outcome: "skipped",
        summary: error.message,
        metadata: {
          promptHash: sha256(prompt),
          workspaceSetupSkipped: true,
          missingPrerequisite: error.prerequisite,
          seedConfigured: Boolean(input.benchmarkCase.seed)
        }
      };
    }
    return {
      workspacePath,
      actualFiles: [],
      responseTokens: 0,
      outcome: "fail",
      summary: "Benchmark workspace setup failed before the agent could run.",
      metadata: {
        promptHash: sha256(prompt),
        workspaceSetupError: error instanceof Error ? error.message : String(error),
        seedConfigured: Boolean(input.benchmarkCase.seed)
      }
    };
  }

  if (!input.agentCommand) {
    return {
      workspacePath,
      actualFiles: [],
      responseTokens: 0,
      outcome: "skipped",
      summary: "Agent benchmark skipped because no explicit agent command was configured.",
      metadata: {
        workspacePath,
        promptHash: sha256(prompt),
        adapter: "none",
        ...seedMetadata
      }
    };
  }

  try {
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? 120000;
    const commandSessionId = `task_${randomUUID()}`;
    const setupStartedAt = Date.now();
    const setupResult = input.setupCommand
      ? runShell(commandWithPlaceholders(input.setupCommand, { prompt, root: workspacePath, session: commandSessionId }), workspacePath, timeoutMs)
      : undefined;
    const assistanceSetupMs = Date.now() - setupStartedAt;
    const setupMetadata = setupResult
      ? {
          setupCommandHash: sha256(input.setupCommand ?? ""),
          setupCommandExitCode: setupResult.status,
          setupTimedOut: setupResult.timedOut,
          setupSignal: setupResult.signal,
          setupOutputHash: sha256(setupResult.output),
          setupOutputTokens: estimateTokens(setupResult.output),
          assistanceSetupMs
        }
      : {
          assistanceSetupMs: 0
        };
    if (setupResult && setupResult.status !== 0) {
      const metadata = metadataFromOutput({
      output: setupResult.output,
      prompt,
      workspacePath,
      elapsedMs: Date.now() - startedAt,
      adapter: "command",
      benchmarkCase: input.benchmarkCase,
      extraMetadata: {
          originalPromptHash: sha256(prompt),
          ...setupMetadata,
          ...seedMetadata
        }
      });
      return {
        workspacePath,
        actualFiles: [],
        responseTokens: estimateTokens(setupResult.output),
        ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
        outcome: "fail",
        summary: setupResult.timedOut
          ? `Agent setup command timed out after ${timeoutMs}ms.`
          : `Agent setup command failed in disposable workspace with exit code ${setupResult.status}.`,
        metadata: metadata.metadata
      };
    }
    const setupChangedFiles = setupResult ? changedFiles(workspacePath) : [];
    const setupChangedFileHashes = setupResult ? fileHashes(workspacePath, setupChangedFiles) : {};
    if (setupChangedFiles.length > 0) {
      commitBenchmarkBaseline(workspacePath, setupChangedFiles, "kairn-benchmark-setup");
    }

    const prepareStartedAt = Date.now();
    const prepared = input.preparePrompt
      ? await input.preparePrompt({ workspacePath, prompt, benchmarkCase: input.benchmarkCase })
      : { prompt };
    const promptPrepareMs = Date.now() - prepareStartedAt;
    const command = commandWithPlaceholders(input.agentCommand, { prompt: prepared.prompt, root: workspacePath, session: commandSessionId });
    const agentStartedAt = Date.now();
    const completed = await runShellWithProcessGroupTimeout(command, workspacePath, timeoutMs, 16 * 1024 * 1024);
    const agentTimedOut = completed.timedOut;
    const agentElapsedMs = Date.now() - agentStartedAt;
    const output = completed.output;
    const verificationStartedAt = Date.now();
    const verification = runSeedVerification({
      workspacePath,
      benchmarkCase: input.benchmarkCase,
      timeoutMs: input.timeoutMs
    });
    const verificationElapsedMs = Date.now() - verificationStartedAt;
    const sourceInvariantResult = evaluateSourceInvariants({
      rootPath: workspacePath,
      invariants: input.benchmarkCase.sourceInvariants
    });
    const diffScopeResult = await evaluateDiffScopes({
      rootPath: workspacePath,
      scopes: input.benchmarkCase.allowedDiffScopes,
      task: prompt
    });
    const semanticVerificationFailed = !sourceInvariantResult.passed || !diffScopeResult.passed;
    const combinedOutput = [output, verification.output].filter(Boolean).join("\n");
    const expectedFileMentions = mentionedExpectedFiles(combinedOutput, input.benchmarkCase.expectedFiles);
    const changedFileList = changedFiles(workspacePath);
    const seedPatchFiles = stringListMetadata(seedMetadata.seedPatchFiles);
    const seedPatchFileHashes = recordMetadata(seedMetadata.seedPatchFileHashes);
    const baselineChangedFiles = unique([...seedPatchFiles, ...setupChangedFiles]);
    const agentChangedFiles = agentTouchedFiles({
      workspacePath,
      changedFiles: changedFileList,
      seedPatchFiles: baselineChangedFiles,
      seedPatchFileHashes: {
        ...seedPatchFileHashes,
        ...setupChangedFileHashes
      }
    });
    const requiredTouchedFiles = input.benchmarkCase.requiredTouchedFiles ?? [];
    const missingRequiredTouchedFiles = requiredTouchedFiles.filter((file) => !agentChangedFiles.includes(file));
    const requiredTouchedSatisfied = missingRequiredTouchedFiles.length === 0;
    const actualFiles = unique([...agentChangedFiles, ...expectedFileMentions]);
    const scopeViolations = diffScopeResult.violations;
    const testsEdited = agentChangedFiles.filter(isTestPath);
    const unrelatedFilesTouched = diffScopeResult.passed
      ? []
      : agentChangedFiles.filter((file) => !diffScopeResult.changedFiles.includes(file) || scopeViolations.some((violation) => violation.startsWith(`${file}:`) || violation.startsWith(`${file}:`)));
    const metadata = metadataFromOutput({
      output: combinedOutput,
      prompt: prepared.prompt,
      workspacePath,
      elapsedMs: Date.now() - startedAt,
      adapter: "command",
      benchmarkCase: input.benchmarkCase,
      extraMetadata: {
        originalPromptHash: sha256(prompt),
        ...setupMetadata,
        promptPrepareMs,
        agentElapsedMs,
        codexElapsedMs: agentElapsedMs,
        agentTimedOut,
        agentTimeoutMs: timeoutMs,
        agentSignal: completed.signal ?? undefined,
        verificationElapsedMs,
        expectedFileMentions,
        changedFiles: changedFileList,
        seedPatchFiles,
        setupChangedFiles,
        agentChangedFiles,
        requiredTouchedFiles,
        requiredTouchedSatisfied,
        missingRequiredTouchedFiles,
        sourceInvariantChecked: Boolean(input.benchmarkCase.sourceInvariants?.length),
        sourceInvariantPassed: sourceInvariantResult.passed,
        sourceInvariantFailures: sourceInvariantResult.failures,
        diffScopeChecked: Boolean(input.benchmarkCase.allowedDiffScopes?.length),
        diffScopePassed: diffScopeResult.passed,
        diffScopeViolations: diffScopeResult.violations,
        diffScopeChangedFiles: diffScopeResult.changedFiles,
        scopeViolations,
        sourceScopeDiscipline: diffScopeResult.passed ? "passed" : "failed",
        unrelatedFilesTouched,
        testsEdited,
        scopeExpanded: false,
        scopeExpansionReason: null,
        ...verification.metadata,
        ...seedMetadata,
        ...(prepared.metadata ?? {})
      }
    });
    if (completed.error || (completed.status ?? 0) !== 0 || verification.failed || semanticVerificationFailed) {
      return {
        workspacePath,
        actualFiles,
        responseTokens: estimateTokens(combinedOutput),
        ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
        outcome: "fail",
        summary: agentTimedOut
          ? `Agent command timed out after ${timeoutMs}ms.`
          : verification.failed
          ? `Agent command completed, but seeded verification failed with exit code ${verification.exitCode ?? "unknown"}.`
          : semanticVerificationFailed
          ? `Agent command completed, but semantic source validation failed: ${[...sourceInvariantResult.failures, ...diffScopeResult.violations].slice(0, 2).join("; ")}.`
          : `Agent command failed in disposable workspace with exit code ${completed.status ?? "unknown"}.`,
        metadata: metadata.metadata
      };
    }
    return {
      workspacePath,
      actualFiles,
      responseTokens: estimateTokens(combinedOutput),
      ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
      outcome: requiredTouchedSatisfied ? "pass" : "partial",
      summary: requiredTouchedSatisfied
        ? `Agent command completed in disposable workspace. Relevant files surfaced: ${actualFiles.length}.`
        : `Agent command passed verification, but did not touch required source file(s): ${missingRequiredTouchedFiles.join(", ")}.`,
      metadata: metadata.metadata
    };
  } catch (error) {
    const output = outputFromExecError(error);
    const seedPatchFiles = stringListMetadata(seedMetadata.seedPatchFiles);
    const changedFileList = changedFiles(workspacePath);
    const seedPatchFileHashes = recordMetadata(seedMetadata.seedPatchFileHashes);
    const agentChangedFiles = agentTouchedFiles({
      workspacePath,
      changedFiles: changedFileList,
      seedPatchFiles,
      seedPatchFileHashes
    });
    const requiredTouchedFiles = input.benchmarkCase.requiredTouchedFiles ?? [];
    const missingRequiredTouchedFiles = requiredTouchedFiles.filter((file) => !agentChangedFiles.includes(file));
    const metadata = metadataFromOutput({
      output,
      prompt,
      workspacePath,
      elapsedMs: undefined,
      adapter: "command",
      benchmarkCase: input.benchmarkCase,
      extraMetadata: {
        seedPatchFiles,
        changedFiles: changedFileList,
        agentChangedFiles,
        requiredTouchedFiles,
        requiredTouchedSatisfied: missingRequiredTouchedFiles.length === 0,
        missingRequiredTouchedFiles
      }
    });
    return {
      workspacePath,
      actualFiles: unique([...agentChangedFiles, ...mentionedExpectedFiles(output, input.benchmarkCase.expectedFiles)]),
      responseTokens: estimateTokens(output),
      ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
      outcome: "fail",
      summary: "Agent command failed in disposable workspace.",
      metadata: metadata.metadata
    };
  }
}

function createTempWorkspace(rootPath: string): string {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bench-agent-"));
  fs.cpSync(rootPath, workspacePath, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(rootPath, source);
      if (!relative) return true;
      const normalized = normalizeRelativePath(relative);
      return !normalized.startsWith(".git") &&
        !normalized.startsWith(".kairn") &&
        !normalized.startsWith(".codex") &&
        !normalized.includes("/node_modules/") &&
        normalized !== "node_modules";
    }
  });
  return workspacePath;
}

export function createBenchmarkWorkspace(input: {
  rootPath: string;
  benchmarkCase: BenchmarkCase;
}): { workspacePath: string; metadata: Record<string, unknown> } {
  if (input.benchmarkCase.seed) {
    return createSeededWorkspace(input.benchmarkCase.seed);
  }
  return {
    workspacePath: createTempWorkspace(input.rootPath),
    metadata: {
      seedConfigured: false
    }
  };
}

function createSeededWorkspace(seed: BenchmarkSeedSpec): { workspacePath: string; metadata: Record<string, unknown> } {
  const missingPrerequisite = missingSeedPrerequisite(seed);
  if (missingPrerequisite) {
    throw new MissingBenchmarkPrerequisiteError(missingPrerequisite);
  }

  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bench-seed-"));
  const cloneDepth = seed.cloneDepth ?? 1;

  if (seed.ref) {
    runRequired("git", ["init"], { cwd: workspacePath, label: "git init" });
    runRequired("git", ["remote", "add", "origin", seed.repoUrl], { cwd: workspacePath, label: "git remote add" });
    runRequiredWithRetry("git", ["fetch", ...depthArgs(cloneDepth), "origin", seed.ref], {
      cwd: workspacePath,
      label: `git fetch ${seed.ref}`,
      attempts: 3,
      retryDelayMs: 2000,
      retryOn: isTransientGitFailure
    });
    runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: workspacePath, label: "git checkout" });
  } else {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    runRequiredWithRetry("git", ["clone", ...depthArgs(cloneDepth), seed.repoUrl, workspacePath], {
      cwd: os.tmpdir(),
      label: "git clone",
      attempts: 3,
      retryDelayMs: 2000,
      retryOn: isTransientGitFailure
    });
  }

  applySeedPatch({ workspacePath, seed });
  const seedPatchFiles = changedFiles(workspacePath);
  const seedPatchFileHashes = fileHashes(workspacePath, seedPatchFiles);
  for (const command of seed.setupCommands ?? []) {
    runRequired(normalizeSeedCommand(command), [], { cwd: workspacePath, label: `setup command: ${command}`, shell: true });
  }

  const expectedFailure = seed.expectedFailureCommand ? runShell(normalizeSeedCommand(seed.expectedFailureCommand), workspacePath, 120000) : undefined;

  return {
    workspacePath,
    metadata: {
      seedConfigured: true,
      seedRepoUrl: seed.repoUrl,
      ...(seed.ref ? { seedRef: seed.ref } : {}),
      seedCloneDepth: cloneDepth,
      seedSetupCommandCount: seed.setupCommands?.length ?? 0,
      seedHasPatch: Boolean(seed.setupPatch || seed.setupPatchFile),
      seedPatchFiles,
      seedPatchFileHashes,
      seedCommandNormalization: seedCommandNormalizationMetadata(seed),
      ...(expectedFailure
        ? {
            seedExpectedFailureCommandHash: sha256(normalizeSeedCommand(seed.expectedFailureCommand ?? "")),
            seedExpectedFailureExitCode: expectedFailure.status,
            seedExpectedFailurePassed: expectedFailure.status !== 0,
            seedExpectedFailureOutputHash: sha256(expectedFailure.output),
            seedExpectedFailureOutputTokens: estimateTokens(expectedFailure.output)
          }
        : {})
    }
  };
}

function applySeedPatch(input: { workspacePath: string; seed: BenchmarkSeedSpec }): void {
  const patch = input.seed.setupPatchFile ? fs.readFileSync(input.seed.setupPatchFile, "utf8") : input.seed.setupPatch;
  if (!patch) return;
  const result = spawnSync("git", ["apply", "--whitespace=nowarn"], {
    cwd: input.workspacePath,
    input: patch,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if ((result.status ?? 0) !== 0 || result.error) {
    throw new Error(`seed setup patch failed: ${result.stderr || result.error?.message || "unknown git apply error"}`);
  }
}

function commitBenchmarkBaseline(workspacePath: string, files: string[], message: string): void {
  const existingFiles = files.filter((file) => fs.existsSync(path.join(workspacePath, file)));
  if (existingFiles.length === 0) return;
  runRequired("git", ["add", "--", ...existingFiles], { cwd: workspacePath, label: "git add benchmark setup changes" });
  const diffResult = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: workspacePath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if ((diffResult.status ?? 0) === 0) return;
  runRequired("git", ["-c", "user.email=kairn@example.com", "-c", "user.name=Kairn", "commit", "-m", message, "--no-verify"], {
    cwd: workspacePath,
    label: "git commit benchmark setup changes"
  });
}

export function runSeedVerification(input: {
  workspacePath: string;
  benchmarkCase: BenchmarkCase;
  timeoutMs?: number | undefined;
}): {
  failed: boolean;
  exitCode?: number;
  output: string;
  metadata: Record<string, unknown>;
} {
  const command = input.benchmarkCase.seed?.testCommand;
  if (!command) {
    return { failed: false, output: "", metadata: {} };
  }
  const normalizedCommand = normalizeSeedCommand(command);
  const result = runShell(normalizedCommand, input.workspacePath, input.timeoutMs ?? 120000);
  return {
    failed: result.status !== 0,
    exitCode: result.status,
    output: result.output,
    metadata: {
      seedTestCommandHash: sha256(normalizedCommand),
      seedTestExitCode: result.status,
      seedTestTimedOut: result.timedOut,
      seedTestSignal: result.signal,
      seedTestOutputHash: sha256(result.output),
      seedTestOutputTokens: estimateTokens(result.output)
    }
  };
}

class MissingBenchmarkPrerequisiteError extends Error {
  constructor(readonly prerequisite: string) {
    super(`Agent benchmark skipped because required command is unavailable: ${prerequisite}`);
  }
}

function missingSeedPrerequisite(seed: BenchmarkSeedSpec): string | undefined {
  const commands = [
    ...(seed.setupCommands ?? []),
    seed.expectedFailureCommand,
    seed.testCommand
  ].filter((command): command is string => Boolean(command));
  if (commands.some((command) => /\bmvn\b/.test(command)) && !commandExists("mvn")) return "mvn";
  if (commands.some((command) => /\bc\+\+\b/.test(command)) && !commandExists("c++")) return "c++";
  if (commands.some((command) => /\bpython\b/.test(command)) && !commandExists("python") && !commandExists("python3")) return "python or python3";
  return undefined;
}

function normalizeSeedCommand(command: string): string {
  if (commandExists("python") || !commandExists("python3")) return command;
  return command.replace(/(^|[;&|(\s])python(\s+-\s)/g, "$1python3$2");
}

function seedCommandNormalizationMetadata(seed: BenchmarkSeedSpec): Record<string, unknown> {
  const commands = [seed.expectedFailureCommand, seed.testCommand, ...(seed.setupCommands ?? [])].filter((command): command is string => Boolean(command));
  return {
    pythonToPython3: commands.some((command) => command !== normalizeSeedCommand(command))
  };
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return (result.status ?? 1) === 0;
}

function stringListMetadata(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
}

export function agentTouchedFiles(input: {
  workspacePath: string;
  changedFiles: string[];
  seedPatchFiles: string[];
  seedPatchFileHashes: Record<string, string>;
}): string[] {
  const touched = new Set<string>();

  for (const file of input.changedFiles) {
    if (!input.seedPatchFiles.includes(file)) {
      touched.add(file);
      continue;
    }
    if (currentFileHash(input.workspacePath, file) !== input.seedPatchFileHashes[file]) touched.add(file);
  }

  for (const file of input.seedPatchFiles) {
    if (currentFileHash(input.workspacePath, file) !== input.seedPatchFileHashes[file]) touched.add(file);
  }

  return [...touched].sort();
}

export function fileHashes(workspacePath: string, files: string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    hashes[file] = currentFileHash(workspacePath, file);
  }
  return hashes;
}

function currentFileHash(workspacePath: string, filePath: string): string {
  const absolute = path.join(workspacePath, filePath);
  if (!fs.existsSync(absolute)) return "missing";
  return sha256(fs.readFileSync(absolute));
}

function runRequired(
  command: string,
  args: string[],
  input: { cwd: string; label: string; shell?: boolean | undefined }
): void {
  const result = spawnSync(command, args, {
    cwd: input.cwd,
    shell: input.shell ?? false,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if ((result.status ?? 0) !== 0 || result.error) {
    throw new Error(`${input.label} failed: ${result.stderr || result.error?.message || result.stdout || "unknown error"}`);
  }
}

function runRequiredWithRetry(
  command: string,
  args: string[],
  input: {
    cwd: string;
    label: string;
    shell?: boolean | undefined;
    attempts: number;
    retryDelayMs: number;
    retryOn: (message: string) => boolean;
  }
): void {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    try {
      runRequired(command, args, input);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= input.attempts || !input.retryOn(lastError.message)) break;
      sleepSync(input.retryDelayMs);
    }
  }
  throw lastError ?? new Error(`${input.label} failed`);
}

function isTransientGitFailure(message: string): boolean {
  return /RPC failed|Recv failure|Connection reset|protocol error|bad pack header|early EOF|remote end hung up|network/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runShell(command: string, cwd: string, timeoutMs: number): { status: number; output: string; timedOut: boolean; signal?: NodeJS.Signals | null } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"),
    timedOut: spawnTimedOut(result),
    signal: result.signal
  };
}

function spawnTimedOut(result: ReturnType<typeof spawnSync>): boolean {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return error?.code === "ETIMEDOUT" || /ETIMEDOUT|timed out/i.test(error?.message ?? "");
}

export async function runShellWithProcessGroupTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxBuffer: number
): Promise<{ status: number | null; output: string; timedOut: boolean; signal?: NodeJS.Signals | null; error?: Error | undefined }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let watchdogTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string): void => {
      if (output.length >= maxBuffer) return;
      const text = String(chunk);
      const remaining = maxBuffer - output.length;
      output += text.length > remaining ? text.slice(0, remaining) : text;
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      spawnError = error;
      append(error.message);
    });

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      resolve({
        status: status ?? (spawnError ? 1 : 0),
        output,
        timedOut,
        signal,
        ...(spawnError ? { error: spawnError } : {})
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, "SIGTERM");
      forceTimer = setTimeout(() => {
        terminateProcessTree(child.pid, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null, "SIGTERM");
      }, 5000);
    }, timeoutMs);

    child.on("exit", (status, signal) => finish(status, signal));
    child.on("close", (status, signal) => finish(status, signal));
    watchdogTimer = setInterval(() => {
      if (settled) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(child.exitCode, child.signalCode);
        return;
      }
      if (child.pid && !processExists(child.pid)) {
        finish(0, null);
      }
    }, 1000);
    watchdogTimer.unref?.();
  });
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function depthArgs(depth: number): string[] {
  return depth > 0 ? ["--depth", String(Math.floor(depth))] : [];
}

export function changedFiles(workspacePath: string): string[] {
  if (!workspacePath) return [];
  try {
    const tracked = execFileSync("git", ["-C", workspacePath, "diff", "--name-only"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter((file) => file && !isBenchmarkInternalPath(file));
    const untracked = execFileSync("git", ["-C", workspacePath, "ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter((file) => file && !isBenchmarkInternalPath(file));
    return [...new Set([...tracked, ...untracked])].sort();
  } catch {
    return [];
  }
}

export function workspacePatch(workspacePath: string): string {
  if (!workspacePath) return "";
  let untracked: string[] = [];
  try {
    untracked = execFileSync("git", ["-C", workspacePath, "ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter((file) => file && !isBenchmarkInternalPath(file));

    if (untracked.length > 0) {
      execFileSync("git", ["-C", workspacePath, "add", "-N", "--", ...untracked], {
        stdio: ["ignore", "ignore", "ignore"]
      });
    }

    return execFileSync("git", ["-C", workspacePath, "diff", "--binary"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    return "";
  } finally {
    if (untracked.length > 0) {
      try {
        execFileSync("git", ["-C", workspacePath, "reset", "-q", "--", ...untracked], {
          stdio: ["ignore", "ignore", "ignore"]
        });
      } catch {
        // Best-effort cleanup for disposable benchmark workspaces.
      }
    }
  }
}

function isBenchmarkInternalPath(filePath: string): boolean {
  return filePath === ".kairn" ||
    filePath.startsWith(".kairn/") ||
    filePath === ".codex" ||
    filePath.startsWith(".codex/") ||
    filePath === "go.work.sum";
}

function mentionedExpectedFiles(output: string, expectedFiles: string[]): string[] {
  return expectedFiles.filter((file) => output.includes(file));
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(normalized.split("/").at(-1) ?? normalized) ||
    /_test\.pyi?$/.test(normalized) ||
    /_test\.go$/.test(normalized) ||
    /(test|tests)\.java$/.test(normalized) ||
    /(^|\/)(test|tests|testing|spec|specs)\//.test(normalized)
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandWithPlaceholders(command: string, input: { prompt: string; root: string; session?: string | undefined; turn?: string | number | undefined }): string {
  return command
    .replaceAll("{prompt}", shellQuote(input.prompt))
    .replaceAll("{root}", shellQuote(input.root))
    .replaceAll("{session}", shellQuote(input.session ?? ""))
    .replaceAll("{turn}", shellQuote(String(input.turn ?? "")));
}

function metadataFromOutput(input: {
  output: string;
  prompt: string;
  workspacePath: string;
  elapsedMs: number | undefined;
  adapter: string;
  benchmarkCase?: BenchmarkCase | undefined;
  extraMetadata?: Record<string, unknown> | undefined;
}): {
  observedCodexTokens?: number;
  metadata: Record<string, unknown>;
} {
  const usage = parseCodexUsageFooter(input.output);
  const hookCompleted = countMatches(input.output, /\bhook \(completed\)|hook:\s*[\w.-]+\s+Completed\b|hook context:/gi);
  const hookFailed = countMatches(input.output, /\bhook \(failed\)|error:\s*hook exited with code/gi);
  const kairnMcpToolMentions = countMatches(input.output, /\bkairn_(prepare_task|get_next_context|get_failure_context|find_context|read_file|read_symbol)\b/g);
  const codexJsonlMcp = codexJsonlMcpCalls(input.output);
  const workspaceMcp = workspaceMcpCalls(input.workspacePath);
  const workspacePrime = workspacePrimeMetadata(input.workspacePath);
  const actualMcpToolCalls = workspaceMcp.count > 0 ? workspaceMcp.count : codexJsonlMcp.count;
  const mcpReturnedQuality = input.benchmarkCase
    ? mcpReturnedFileQuality(input.benchmarkCase, workspaceMcp.files)
    : {};
  const kairnDryRunMetadata = kairnCodexDryRunMetadata(input.output);
  const metadata: Record<string, unknown> = {
    workspacePath: input.workspacePath,
    promptHash: sha256(input.prompt),
    outputHash: sha256(input.output),
    adapter: input.adapter,
    hookCompleted,
    hookFailed,
    kairnMcpToolMentions,
    actualMcpToolCalls,
    actualMcpToolNames: unique([...workspaceMcp.toolNames, ...codexJsonlMcp.toolNames]),
    actualMcpToolCallSource: workspaceMcp.count > 0 ? "workspace_metrics" : codexJsonlMcp.count > 0 ? "codex_jsonl" : "none",
    actualMcpFiles: workspaceMcp.files,
    actualMcpContextActions: workspaceMcp.contextActions,
    ...mcpReturnedQuality,
    ...workspacePrime,
    ...kairnDryRunMetadata,
    ...(input.extraMetadata ?? {})
  };

  if (input.elapsedMs !== undefined) {
    metadata.elapsedMs = input.elapsedMs;
  }

  if (usage) {
    metadata.codexUsage = {
      ...usage,
      source: "footer"
    };
  }

  return {
    ...(usage ? { observedCodexTokens: usage.totalTokens } : {}),
    metadata
  };
}

function outputFromExecError(error: unknown): string {
  if (isExecError(error)) {
    return [bufferLikeToString(error.stdout), bufferLikeToString(error.stderr), error.message].filter(Boolean).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

function kairnCodexDryRunMetadata(output: string): Record<string, unknown> {
  const parsed = parseJsonObject(output.trim());
  const prime = isRecord(parsed.prime) ? parsed.prime : undefined;
  if (!prime) return {};

  const primeMetadata = isRecord(prime.metadata) ? prime.metadata : {};
  const contextDecision = isRecord(prime.contextDecision) ? prime.contextDecision : {};
  const files = Array.isArray(prime.files) ? prime.files.filter((item): item is string => typeof item === "string") : [];
  const tokenEstimate = typeof prime.tokenEstimate === "number" ? prime.tokenEstimate : undefined;
  const guardrailVariant = typeof primeMetadata.guardrailVariant === "string" ? primeMetadata.guardrailVariant : undefined;
  const guardrailDirectiveStyle = typeof primeMetadata.guardrailDirectiveStyle === "string"
    ? primeMetadata.guardrailDirectiveStyle
    : typeof contextDecision.directiveStyle === "string"
      ? contextDecision.directiveStyle
      : undefined;

  return {
    kairnDryRun: true,
    ...(tokenEstimate !== undefined ? { primeTokens: tokenEstimate } : {}),
    ...(typeof contextDecision.action === "string" ? { primeDecision: contextDecision.action } : {}),
    ...(typeof contextDecision.recommendedDelivery === "string" ? { primeDelivery: contextDecision.recommendedDelivery } : {}),
    ...(guardrailDirectiveStyle ? { primeDirectiveStyle: guardrailDirectiveStyle } : {}),
    ...(guardrailVariant ? { guardrailVariant } : {}),
    ...(typeof primeMetadata.guardrailFileCount === "number" ? { guardrailFileCount: primeMetadata.guardrailFileCount } : {}),
    ...(typeof primeMetadata.guardrailInvariantCount === "number" ? { guardrailInvariantCount: primeMetadata.guardrailInvariantCount } : {}),
    ...(typeof primeMetadata.guardrailTokenBudget === "number" ? { guardrailTokenBudget: primeMetadata.guardrailTokenBudget } : {}),
    ...(typeof primeMetadata.guardrailStrictOfficialScope === "boolean" ? { guardrailStrictOfficialScope: primeMetadata.guardrailStrictOfficialScope } : {}),
    primeFiles: files
  };
}

function isExecError(value: unknown): value is Error & { stdout?: unknown; stderr?: unknown } {
  return typeof value === "object" && value !== null && ("stdout" in value || "stderr" in value);
}

function bufferLikeToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function countMatches(input: string, pattern: RegExp): number {
  return input.match(pattern)?.length ?? 0;
}

function codexJsonlMcpCalls(output: string): { count: number; toolNames: string[] } {
  const toolNames: string[] = [];
  let count = 0;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      const text = JSON.stringify(value);
      if (!text.includes("mcp") || !text.includes("kairn")) continue;
      if (!text.includes("tool_call") && !text.includes("mcp_tool_call")) continue;
      count += 1;
      for (const match of text.matchAll(/\bkairn_(prepare_task|get_next_context|get_failure_context|find_context|read_file|read_symbol)\b/g)) {
        toolNames.push(match[0]!);
      }
    } catch {
      continue;
    }
  }
  return {
    count,
    toolNames: unique(toolNames)
  };
}

function workspaceMcpCalls(workspacePath: string): { count: number; toolNames: string[]; files: string[]; contextActions: string[] } {
  const dbPath = path.join(workspacePath, ".kairn", "kairn.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { count: 0, toolNames: [], files: [], contextActions: [] };
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `
          select event_name, files_json, metadata_json
          from metrics_events
          where event_kind = 'mcp_tool_call'
        `
      )
      .all() as Array<{ event_name: string; files_json: string; metadata_json: string }>;

    const toolNames: string[] = [];
    const files: string[] = [];
    const contextActions: string[] = [];
    for (const row of rows) {
      toolNames.push(row.event_name);
      for (const file of parseStringArray(row.files_json)) {
        files.push(normalizeRelativePath(file));
      }
      const metadata = parseJsonObject(row.metadata_json);
      if (typeof metadata.toolName === "string") {
        toolNames.push(metadata.toolName);
      }
      const contextDecision = metadata.contextDecision;
      if (isRecord(contextDecision) && typeof contextDecision.action === "string") {
        contextActions.push(contextDecision.action);
      }
    }

    return {
      count: rows.length,
      toolNames: unique(toolNames),
      files: unique(files),
      contextActions: unique(contextActions)
    };
  } catch {
    return { count: 0, toolNames: [], files: [], contextActions: [] };
  } finally {
    db?.close();
  }
}

function workspacePrimeMetadata(workspacePath: string): Record<string, unknown> {
  const dbPath = path.join(workspacePath, ".kairn", "kairn.sqlite");
  if (!fs.existsSync(dbPath)) return {};

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `
          select event_name, output_tokens, files_json, metadata_json
          from metrics_events
          where event_kind = 'prime_context'
          order by created_at desc, id desc
          limit 1
        `
      )
      .get() as { event_name: string; output_tokens: number; files_json: string; metadata_json: string } | undefined;
    if (!row) return {};

    const metadata = parseJsonObject(row.metadata_json);
    const contextDecision = isRecord(metadata.contextDecision) ? metadata.contextDecision : {};
    const deliveryTrace = isRecord(metadata.deliveryTrace) ? metadata.deliveryTrace : {};
    return {
      primeDecision: typeof contextDecision.action === "string" ? contextDecision.action : row.event_name,
      ...(typeof contextDecision.recommendedDelivery === "string" ? { primeDelivery: contextDecision.recommendedDelivery } : {}),
      ...(typeof contextDecision.directiveStyle === "string" ? { primeDirectiveStyle: contextDecision.directiveStyle } : {}),
      ...(typeof deliveryTrace.taskShapeSignal === "string" ? { taskShapeSignal: deliveryTrace.taskShapeSignal } : {}),
      ...(typeof deliveryTrace.requiredSurface === "string" ? { requiredSurface: deliveryTrace.requiredSurface } : {}),
      ...(typeof deliveryTrace.directiveStyle === "string" ? { directiveStyle: deliveryTrace.directiveStyle } : {}),
      ...(typeof deliveryTrace.guardrailVariant === "string" ? { traceGuardrailVariant: deliveryTrace.guardrailVariant } : {}),
      ...(typeof deliveryTrace.emittedFileCount === "number" ? { emittedFileCount: deliveryTrace.emittedFileCount } : {}),
      ...(isRecord(deliveryTrace.emittedFileRoleSummary) ? { emittedFileRoleSummary: deliveryTrace.emittedFileRoleSummary } : {}),
      ...(typeof deliveryTrace.editScopeSource === "string" ? { editScopeSource: deliveryTrace.editScopeSource } : {}),
      ...(typeof deliveryTrace.estimatedDirectiveTokens === "number" ? { estimatedDirectiveTokens: deliveryTrace.estimatedDirectiveTokens } : {}),
      ...(typeof deliveryTrace.estimatedSourceContextTokens === "number" ? { estimatedSourceContextTokens: deliveryTrace.estimatedSourceContextTokens } : {}),
      ...(typeof deliveryTrace.sizingReason === "string" ? { sizingReason: deliveryTrace.sizingReason } : {}),
      primeTokens: row.output_tokens,
      primeFiles: parseStringArray(row.files_json),
      ...(typeof metadata.guardrailVariant === "string" ? { guardrailVariant: metadata.guardrailVariant } : {}),
      ...(typeof metadata.guardrailFileCount === "number" ? { guardrailFileCount: metadata.guardrailFileCount } : {}),
      ...(typeof metadata.guardrailInvariantCount === "number" ? { guardrailInvariantCount: metadata.guardrailInvariantCount } : {}),
      ...(typeof metadata.guardrailTokenBudget === "number" ? { guardrailTokenBudget: metadata.guardrailTokenBudget } : {}),
      ...(typeof metadata.guardrailStrictOfficialScope === "boolean" ? { guardrailStrictOfficialScope: metadata.guardrailStrictOfficialScope } : {}),
      ...(typeof metadata.officialPatchScopeFileCount === "number" ? { officialPatchScopeFileCount: metadata.officialPatchScopeFileCount } : {}),
      ...(typeof metadata.forceOfficialMultiFileScope === "boolean" ? { forceOfficialMultiFileScope: metadata.forceOfficialMultiFileScope } : {}),
      ...(typeof metadata.forceProductionOnlyOneFile === "boolean" ? { forceProductionOnlyOneFile: metadata.forceProductionOnlyOneFile } : {})
    };
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

function mcpReturnedFileQuality(benchmarkCase: BenchmarkCase, files: string[]): Record<string, unknown> {
  const uniqueFiles = unique(files);
  const expected = uniqueFiles.filter((file) => benchmarkCase.expectedFiles.includes(file));
  const noisy = uniqueFiles.filter((file) =>
    benchmarkCase.excludedFiles.some((excluded) => benchmarkPatternMatches(file, excluded)) || isNoisyMcpReturnedFile(file)
  );
  const testFanout = uniqueFiles.filter(isMcpReturnedTestFile);
  const relevant = unique([...expected, ...uniqueFiles.filter((file) => !noisy.includes(file) && !testFanout.includes(file))]);
  return {
    mcpReturnedFileCount: uniqueFiles.length,
    mcpReturnedExpectedFileCount: expected.length,
    mcpReturnedNoiseFileCount: noisy.length,
    mcpReturnedTestFanoutCount: testFanout.length,
    mcpContextEfficiency: uniqueFiles.length > 0 ? Number((relevant.length / uniqueFiles.length).toFixed(4)) : 1
  };
}

function benchmarkPatternMatches(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeRelativePath(filePath);
  const normalizedPattern = normalizeRelativePath(pattern);
  return normalizedFile === normalizedPattern ||
    normalizedFile.startsWith(normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`) ||
    normalizedFile.includes(normalizedPattern);
}

function isNoisyMcpReturnedFile(filePath: string): boolean {
  return /(^|\/)(docs?|documentation|examples|demo|demos|devtools|codemods|fixtures|fixture|generated|gen|dist|build|coverage|website|site|playground|storybook)\//i.test(filePath);
}

function isMcpReturnedTestFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(normalized.split("/").at(-1) ?? normalized) ||
    /_test\.pyi?$/.test(normalized) ||
    /(test|tests)\.java$/.test(normalized) ||
    normalized.includes("/src/test/java/") ||
    /(_test|_tests|_unittest)\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(normalized) ||
    /(^|\/)(test|tests)\//.test(normalized)
  );
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
