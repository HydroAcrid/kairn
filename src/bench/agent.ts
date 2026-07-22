// SPDX-License-Identifier: Apache-2.0

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
  /** Environment for public-repository setup and verification commands. */
  untrustedEnvironment?: NodeJS.ProcessEnv | undefined;
  /** Environment for the explicitly configured agent host. */
  agentEnvironment?: NodeJS.ProcessEnv | undefined;
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
      benchmarkCase: input.benchmarkCase,
      environment: input.untrustedEnvironment
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
      ? runShell(
          commandWithPlaceholders(input.setupCommand, { prompt, root: workspacePath, session: commandSessionId }),
          workspacePath,
          timeoutMs,
          input.agentEnvironment
        )
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

    const prepareStartedAt = Date.now();
    const prepared = input.preparePrompt
      ? await input.preparePrompt({ workspacePath, prompt, benchmarkCase: input.benchmarkCase })
      : { prompt };
    const promptPrepareMs = Date.now() - prepareStartedAt;
    const command = commandWithPlaceholders(input.agentCommand, { prompt: prepared.prompt, root: workspacePath, session: commandSessionId });
    const agentStartedAt = Date.now();
    const completed = await runShellWithProcessGroupTimeout(
      command,
      workspacePath,
      timeoutMs,
      16 * 1024 * 1024,
      input.agentEnvironment
    );
    const agentTimedOut = completed.timedOut;
    const agentElapsedMs = Date.now() - agentStartedAt;
    const output = completed.output;
    const verificationStartedAt = Date.now();
    const verification = runSeedVerification({
      workspacePath,
      benchmarkCase: input.benchmarkCase,
      timeoutMs: input.timeoutMs,
      environment: input.untrustedEnvironment
    });
    const verificationElapsedMs = Date.now() - verificationStartedAt;
    const sourceInvariantResult = evaluateSourceInvariants({
      rootPath: workspacePath,
      invariants: input.benchmarkCase.sourceInvariants
    });
    const diffScopeResult = await evaluateDiffScopes({
      rootPath: workspacePath,
      scopes: input.benchmarkCase.allowedDiffScopes
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
        missingRequiredTouchedFiles,
        ...(error instanceof SandboxInfrastructureError
          ? {
              sandboxInfrastructureFailure: true,
              // The controlled experiment runner already classifies this
              // established setup-error field as infrastructure, including
              // failures discovered by the redundant final verifier.
              workspaceSetupError: error.message
            }
          : {})
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
        !normalized.includes("/node_modules/") &&
        normalized !== "node_modules";
    }
  });
  return workspacePath;
}

export function createBenchmarkWorkspace(input: {
  rootPath: string;
  benchmarkCase: BenchmarkCase;
  environment?: NodeJS.ProcessEnv | undefined;
}): { workspacePath: string; metadata: Record<string, unknown> } {
  if (input.benchmarkCase.seed) {
    return createSeededWorkspace(input.benchmarkCase.seed, input.environment);
  }
  return {
    workspacePath: createTempWorkspace(input.rootPath),
    metadata: {
      seedConfigured: false
    }
  };
}

function createSeededWorkspace(
  seed: BenchmarkSeedSpec,
  environment?: NodeJS.ProcessEnv | undefined
): { workspacePath: string; metadata: Record<string, unknown> } {
  const missingPrerequisite = missingSeedPrerequisite(seed);
  if (missingPrerequisite) {
    throw new MissingBenchmarkPrerequisiteError(missingPrerequisite);
  }

  const sandboxImage = seed.sandboxImage;
  if (sandboxImage) assertSandboxImageAvailable(sandboxImage, environment);
  const gitEnvironment = scrubRepositoryHostEnvironment(environment);

  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bench-seed-"));
  const cloneDepth = seed.cloneDepth ?? 1;
  let seedResolvedCommit: string | undefined;

  if (seed.ref) {
    runRequired("git", ["init"], { cwd: workspacePath, label: "git init", environment: gitEnvironment });
    runRequired("git", ["remote", "add", "origin", seed.repoUrl], { cwd: workspacePath, label: "git remote add", environment: gitEnvironment });
    runRequired("git", ["fetch", ...depthArgs(cloneDepth), "origin", seed.ref], {
      cwd: workspacePath,
      label: `git fetch ${seed.ref}`,
      environment: gitEnvironment
    });
    runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: workspacePath, label: "git checkout", environment: gitEnvironment });
    seedResolvedCommit = gitCommit(workspacePath);
  } else {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    runRequired("git", ["clone", ...depthArgs(cloneDepth), seed.repoUrl, workspacePath], {
      cwd: os.tmpdir(),
      label: "git clone",
      environment: gitEnvironment
    });
  }

  applySeedPatch({ workspacePath, seed, environment: gitEnvironment });
  if (sandboxImage) {
    const preflight = runSandboxedRepositoryCommand(":", workspacePath, 60_000, sandboxImage, environment);
    if (preflight.status !== 0) {
      throw new SandboxInfrastructureError(`sandbox preflight failed with exit code ${preflight.status}: ${preflight.output.slice(-1000)}`);
    }
  }
  for (const command of seed.setupCommands ?? []) {
    if (sandboxImage) {
      const result = runSandboxedRepositoryCommand(command, workspacePath, 120_000, sandboxImage, environment);
      if (result.status !== 0) {
        throw new Error(`sandboxed setup command failed with exit code ${result.status}: ${result.output.slice(-4000)}`);
      }
    } else {
      runRequired(normalizeSeedCommand(command), [], {
        cwd: workspacePath,
        label: `setup command: ${command}`,
        shell: true,
        environment
      });
    }
  }
  // The benchmark baseline includes both the seed patch and deterministic
  // setup output. Snapshot only after setup so generated tracked files are
  // never misattributed to the agent under test.
  const seedPatchFiles = changedFiles(workspacePath);
  const seedPatchFileHashes = fileHashes(workspacePath, seedPatchFiles);
  if (seed.commitSetupBaseline) commitBenchmarkBaseline(workspacePath, environment, sandboxImage);

  const expectedFailure = seed.expectedFailureCommand
    ? sandboxImage
      ? runSandboxedRepositoryCommand(seed.expectedFailureCommand, workspacePath, 120_000, sandboxImage, environment)
      : runShell(normalizeSeedCommand(seed.expectedFailureCommand), workspacePath, 120000, environment)
    : undefined;

  return {
    workspacePath,
    metadata: {
      seedConfigured: true,
      seedRepoUrl: seed.repoUrl,
      ...(seed.ref ? { seedRef: seed.ref } : {}),
      ...(seedResolvedCommit ? { seedResolvedCommit } : {}),
      seedCloneDepth: cloneDepth,
      ...(sandboxImage ? { seedSandboxImage: sandboxImage, seedSandboxedRepositoryCode: true } : {}),
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

function commitBenchmarkBaseline(
  workspacePath: string,
  environment?: NodeJS.ProcessEnv | undefined,
  sandboxImage?: string | undefined
): void {
  if (sandboxImage) {
    const command = [
      "git add --all",
      "git -c user.name='Kairn Benchmark' -c user.email='kairn-benchmark@invalid.local' " +
        "-c core.hooksPath=/dev/null commit --allow-empty --no-gpg-sign --no-verify " +
        "-m 'kairn benchmark setup baseline'"
    ].join(" && ");
    const result = runSandboxedRepositoryCommand(command, workspacePath, 120_000, sandboxImage, environment, true);
    if (result.status !== 0) {
      throw new SandboxInfrastructureError(`sandboxed baseline commit failed with exit code ${result.status}: ${result.output.slice(-4000)}`);
    }
    return;
  }
  runRequired("git", ["add", "--all"], {
    cwd: workspacePath,
    label: "benchmark baseline git add",
    environment: scrubGitConfigEnvironment(environment)
  });
  runRequired("git", [
    "-c", "user.name=Kairn Benchmark",
    "-c", "user.email=kairn-benchmark@invalid.local",
    "commit", "--allow-empty", "--no-gpg-sign", "-m", "kairn benchmark setup baseline"
  ], {
    cwd: workspacePath,
    label: "benchmark baseline commit",
    environment: scrubGitConfigEnvironment(environment)
  });
}

function gitCommit(workspacePath: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    env: scrubGitConfigEnvironment(),
    encoding: "utf8"
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return /^[a-f0-9]{40,64}$/i.test(value) ? value : undefined;
}

function applySeedPatch(input: {
  workspacePath: string;
  seed: BenchmarkSeedSpec;
  environment?: NodeJS.ProcessEnv | undefined;
}): void {
  const patch = input.seed.setupPatchFile ? fs.readFileSync(input.seed.setupPatchFile, "utf8") : input.seed.setupPatch;
  if (!patch) return;
  const result = spawnSync("git", ["apply", "--whitespace=nowarn"], {
    cwd: input.workspacePath,
    input: patch,
    ...(input.environment ? { env: input.environment } : {}),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if ((result.status ?? 0) !== 0 || result.error) {
    throw new Error(`seed setup patch failed: ${result.stderr || result.error?.message || "unknown git apply error"}`);
  }
}

export function runSeedVerification(input: {
  workspacePath: string;
  benchmarkCase: BenchmarkCase;
  timeoutMs?: number | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
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
  const sandboxImage = input.benchmarkCase.seed?.sandboxImage;
  const normalizedCommand = sandboxImage ? command : normalizeSeedCommand(command);
  const result = sandboxImage
    ? runSandboxedRepositoryCommand(normalizedCommand, input.workspacePath, input.timeoutMs ?? 120000, sandboxImage, input.environment)
    : runShell(normalizedCommand, input.workspacePath, input.timeoutMs ?? 120000, input.environment);
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
      seedTestOutputTokens: estimateTokens(result.output),
      ...(sandboxImage ? { seedTestSandboxImage: sandboxImage, seedTestSandboxed: true } : {})
    }
  };
}

class MissingBenchmarkPrerequisiteError extends Error {
  constructor(readonly prerequisite: string) {
    super(`Agent benchmark skipped because required command is unavailable: ${prerequisite}`);
  }
}

function missingSeedPrerequisite(seed: BenchmarkSeedSpec): string | undefined {
  if (seed.sandboxImage) return commandExists("docker") ? undefined : "docker";
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
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return (result.status ?? 1) === 0;
  }
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
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(absolute))}`;
  const resolvedRoot = fs.realpathSync(workspacePath);
  const resolved = fs.realpathSync(absolute);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return "outside-workspace";
  return sha256(fs.readFileSync(absolute));
}

class SandboxInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxInfrastructureError";
  }
}

const PINNED_SANDBOX_IMAGE = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/i;

function assertSandboxImageAvailable(image: string, environment?: NodeJS.ProcessEnv | undefined): void {
  if (!PINNED_SANDBOX_IMAGE.test(image)) {
    throw new SandboxInfrastructureError("sandbox image must be pinned by an immutable sha256 digest");
  }
  const result = spawnSync("docker", ["image", "inspect", image], {
    env: scrubRepositoryHostEnvironment(environment),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").slice(-1000);
    throw new SandboxInfrastructureError(
      `digest-pinned sandbox image is unavailable locally; the harness will not pull it (${image}): ${detail || "docker image inspect failed"}`
    );
  }
  try {
    const inspected = JSON.parse(result.stdout) as Array<{ Config?: { Volumes?: Record<string, unknown> | null } }>;
    const volumes = inspected[0]?.Config?.Volumes;
    if (volumes && Object.keys(volumes).length > 0) {
      throw new SandboxInfrastructureError("sandbox images must not declare writable VOLUME paths");
    }
  } catch (error) {
    if (error instanceof SandboxInfrastructureError) throw error;
    throw new SandboxInfrastructureError("Docker returned an unreadable sandbox image inspection result");
  }
}

function runSandboxedRepositoryCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  image: string,
  environment?: NodeJS.ProcessEnv | undefined,
  gitWritable = false
): { status: number; output: string; timedOut: boolean; signal?: NodeJS.Signals | null } {
  if (!PINNED_SANDBOX_IMAGE.test(image)) {
    throw new SandboxInfrastructureError("sandbox image must be pinned by an immutable sha256 digest");
  }
  const resolvedWorkspace = path.resolve(cwd);
  const containerName = `kairn-bench-${randomUUID().replaceAll("-", "")}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : 65532;
  const gid = typeof process.getgid === "function" ? process.getgid() : 65532;
  const args = [
    "run", "--rm", "--pull=never", "--name", containerName,
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "512",
    "--user", `${uid}:${gid}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
    "--mount", `type=bind,source=${resolvedWorkspace},target=/workspace`,
    "--workdir", "/workspace",
    "--env", "HOME=/tmp/kairn-home",
    "--env", "CI=true",
    "--env", "GIT_CONFIG_NOSYSTEM=1",
    "--env", "GIT_CONFIG_GLOBAL=/dev/null",
    "--env", "GIT_TERMINAL_PROMPT=0",
    "--env", "GIT_OPTIONAL_LOCKS=0",
    "--entrypoint", "/bin/sh"
  ];
  const gitDirectory = path.join(resolvedWorkspace, ".git");
  if (!gitWritable && fs.statSync(gitDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    args.push("--mount", `type=bind,source=${gitDirectory},target=/workspace/.git,readonly`);
  }
  args.push(
    image,
    "-c", 'umask 077; mkdir -p "$HOME"; exec /bin/sh -c "$1"', "kairn-bench", command
  );
  const result = spawnSync("docker", args, {
    env: scrubRepositoryHostEnvironment(environment),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  const timedOut = spawnTimedOut(result);
  if (timedOut) cleanupSandboxContainer(containerName, environment);
  const status = result.status ?? (result.error ? 1 : 0);
  const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  if (result.error || timedOut || status === 125 || status === 126 || status === 127) {
    if (!timedOut) cleanupSandboxContainer(containerName, environment);
    throw new SandboxInfrastructureError(
      timedOut
        ? `sandboxed repository command timed out after ${timeoutMs}ms`
        : `sandbox execution failed with exit code ${status}: ${output.slice(-1000)}`
    );
  }
  return { status, output, timedOut, signal: result.signal };
}

function cleanupSandboxContainer(name: string, environment?: NodeJS.ProcessEnv | undefined): void {
  spawnSync("docker", ["rm", "--force", name], {
    env: scrubRepositoryHostEnvironment(environment),
    encoding: "utf8",
    timeout: 30_000,
    stdio: "ignore"
  });
}

function scrubGitConfigEnvironment(environment?: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { ...(environment ?? process.env) };
  const unsafeGitEnvironment = new Set([
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
    "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS",
    "GIT_PROXY_COMMAND", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_SYSTEM"
  ]);
  for (const key of Object.keys(output)) {
    if (
      unsafeGitEnvironment.has(key.toUpperCase()) ||
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/i.test(key) ||
      /^(?:GIT|SSH)_ASKPASS$/i.test(key)
    ) {
      delete output[key];
    }
  }
  output.GIT_CONFIG_NOSYSTEM = "1";
  output.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : os.devNull;
  output.GIT_TERMINAL_PROMPT = "0";
  output.GCM_INTERACTIVE = "Never";
  return output;
}

function scrubRepositoryHostEnvironment(environment?: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const output = scrubGitConfigEnvironment(environment);
  const explicit = new Set([
    "ANTHROPIC_API_KEY", "REASONBLOCKS_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN",
    "GH_TOKEN", "NPM_TOKEN", "PYPI_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET"
  ]);
  const sensitive = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY)(?:$|_)/i;
  for (const key of Object.keys(output)) {
    if (explicit.has(key.toUpperCase()) || sensitive.test(key)) delete output[key];
  }
  return output;
}

function runRequired(
  command: string,
  args: string[],
  input: {
    cwd: string;
    label: string;
    shell?: boolean | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  }
): void {
  const result = spawnSync(command, args, {
    cwd: input.cwd,
    shell: input.shell ?? false,
    ...(input.environment ? { env: input.environment } : {}),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if ((result.status ?? 0) !== 0 || result.error) {
    throw new Error(`${input.label} failed: ${result.stderr || result.error?.message || result.stdout || "unknown error"}`);
  }
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  environment?: NodeJS.ProcessEnv | undefined
): { status: number; output: string; timedOut: boolean; signal?: NodeJS.Signals | null } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    ...(environment ? { env: environment } : {}),
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
  maxBuffer: number,
  environment?: NodeJS.ProcessEnv | undefined
): Promise<{ status: number | null; output: string; timedOut: boolean; signal?: NodeJS.Signals | null; error?: Error | undefined }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      ...(environment ? { env: environment } : {}),
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
      const normalizedStatus =
        timedOut && (status === null || status === 0)
          ? 124
          : status ?? (spawnError ? 1 : 0);
      resolve({
        status: normalizedStatus,
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
      env: scrubGitConfigEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter((file) => file && !isBenchmarkInternalPath(file));
    const untracked = execFileSync("git", ["-C", workspacePath, "ls-files", "--others", "--exclude-standard"], {
      env: scrubGitConfigEnvironment(),
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

function isBenchmarkInternalPath(filePath: string): boolean {
  return filePath === ".kairn" || filePath.startsWith(".kairn/");
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
  const actualMcpToolCalls = workspaceMcp.count > 0 ? workspaceMcp.count : codexJsonlMcp.count;
  const mcpReturnedQuality = input.benchmarkCase
    ? mcpReturnedFileQuality(input.benchmarkCase, workspaceMcp.files)
    : {};
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
