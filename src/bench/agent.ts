import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { BenchmarkCase, BenchmarkSeedSpec, BenchmarkTaskOutcome } from "../types.js";
import { parseCodexUsageFooter } from "../eval/codexUsage.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath } from "../utils/paths.js";
import { estimateTokens } from "../utils/tokens.js";

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

  try {
    const workspace = createBenchmarkWorkspace({
      rootPath: input.rootPath,
      benchmarkCase: input.benchmarkCase
    });
    workspacePath = workspace.workspacePath;
    seedMetadata = workspace.metadata;
  } catch (error) {
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
    const prepared = input.preparePrompt
      ? await input.preparePrompt({ workspacePath, prompt, benchmarkCase: input.benchmarkCase })
      : { prompt };
    const command = input.agentCommand
      .replaceAll("{prompt}", shellQuote(prepared.prompt))
      .replaceAll("{root}", shellQuote(workspacePath));
    const completed = spawnSync(command, {
      cwd: workspacePath,
      shell: true,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120000,
      maxBuffer: 16 * 1024 * 1024
    });
    const output = [completed.stdout, completed.stderr, completed.error?.message].filter(Boolean).join("\n");
    const verification = runSeedVerification({
      workspacePath,
      benchmarkCase: input.benchmarkCase,
      timeoutMs: input.timeoutMs
    });
    const combinedOutput = [output, verification.output].filter(Boolean).join("\n");
    const expectedFileMentions = mentionedExpectedFiles(combinedOutput, input.benchmarkCase.expectedFiles);
    const actualFiles = unique([...changedFiles(workspacePath), ...expectedFileMentions]);
    const metadata = metadataFromOutput({
      output: combinedOutput,
      prompt: prepared.prompt,
      workspacePath,
      elapsedMs: Date.now() - startedAt,
      adapter: "command",
      extraMetadata: {
        originalPromptHash: sha256(prompt),
        expectedFileMentions,
        ...verification.metadata,
        ...seedMetadata,
        ...(prepared.metadata ?? {})
      }
    });
    if (completed.error || (completed.status ?? 0) !== 0 || verification.failed) {
      return {
        workspacePath,
        actualFiles,
        responseTokens: estimateTokens(combinedOutput),
        ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
        outcome: "fail",
        summary: verification.failed
          ? `Agent command completed, but seeded verification failed with exit code ${verification.exitCode ?? "unknown"}.`
          : `Agent command failed in disposable workspace with exit code ${completed.status ?? "unknown"}.`,
        metadata: metadata.metadata
      };
    }
    return {
      workspacePath,
      actualFiles,
      responseTokens: estimateTokens(combinedOutput),
      ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
      outcome: "pass",
      summary: `Agent command completed in disposable workspace. Relevant files surfaced: ${actualFiles.length}.`,
      metadata: metadata.metadata
    };
  } catch (error) {
    const output = outputFromExecError(error);
    const metadata = metadataFromOutput({
      output,
      prompt,
      workspacePath,
      elapsedMs: undefined,
      adapter: "command"
    });
    return {
      workspacePath,
      actualFiles: unique([...changedFiles(workspacePath), ...mentionedExpectedFiles(output, input.benchmarkCase.expectedFiles)]),
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

function createBenchmarkWorkspace(input: {
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
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bench-seed-"));
  const cloneDepth = seed.cloneDepth ?? 1;

  if (seed.ref) {
    runRequired("git", ["init"], { cwd: workspacePath, label: "git init" });
    runRequired("git", ["remote", "add", "origin", seed.repoUrl], { cwd: workspacePath, label: "git remote add" });
    runRequired("git", ["fetch", ...depthArgs(cloneDepth), "origin", seed.ref], {
      cwd: workspacePath,
      label: `git fetch ${seed.ref}`
    });
    runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: workspacePath, label: "git checkout" });
  } else {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    runRequired("git", ["clone", ...depthArgs(cloneDepth), seed.repoUrl, workspacePath], {
      cwd: os.tmpdir(),
      label: "git clone"
    });
  }

  applySeedPatch({ workspacePath, seed });
  for (const command of seed.setupCommands ?? []) {
    runRequired(command, [], { cwd: workspacePath, label: `setup command: ${command}`, shell: true });
  }

  const expectedFailure = seed.expectedFailureCommand ? runShell(seed.expectedFailureCommand, workspacePath, 120000) : undefined;

  return {
    workspacePath,
    metadata: {
      seedConfigured: true,
      seedRepoUrl: seed.repoUrl,
      ...(seed.ref ? { seedRef: seed.ref } : {}),
      seedCloneDepth: cloneDepth,
      seedSetupCommandCount: seed.setupCommands?.length ?? 0,
      seedHasPatch: Boolean(seed.setupPatch || seed.setupPatchFile),
      ...(expectedFailure
        ? {
            seedExpectedFailureCommandHash: sha256(seed.expectedFailureCommand ?? ""),
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

function runSeedVerification(input: {
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
  const result = runShell(command, input.workspacePath, input.timeoutMs ?? 120000);
  return {
    failed: result.status !== 0,
    exitCode: result.status,
    output: result.output,
    metadata: {
      seedTestCommandHash: sha256(command),
      seedTestExitCode: result.status,
      seedTestOutputHash: sha256(result.output),
      seedTestOutputTokens: estimateTokens(result.output)
    }
  };
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

function runShell(command: string, cwd: string, timeoutMs: number): { status: number; output: string } {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n")
  };
}

function depthArgs(depth: number): string[] {
  return depth > 0 ? ["--depth", String(Math.floor(depth))] : [];
}

function changedFiles(workspacePath: string): string[] {
  if (!workspacePath) return [];
  try {
    return execFileSync("git", ["-C", workspacePath, "diff", "--name-only"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mentionedExpectedFiles(output: string, expectedFiles: string[]): string[] {
  return expectedFiles.filter((file) => output.includes(file));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function metadataFromOutput(input: {
  output: string;
  prompt: string;
  workspacePath: string;
  elapsedMs: number | undefined;
  adapter: string;
  extraMetadata?: Record<string, unknown> | undefined;
}): {
  observedCodexTokens?: number;
  metadata: Record<string, unknown>;
} {
  const usage = parseCodexUsageFooter(input.output);
  const hookCompleted = countMatches(input.output, /\bhook \(completed\)|hook:\s*[\w.-]+\s+Completed\b|hook context:/gi);
  const hookFailed = countMatches(input.output, /\bhook \(failed\)|error:\s*hook exited with code/gi);
  const metadata: Record<string, unknown> = {
    workspacePath: input.workspacePath,
    promptHash: sha256(input.prompt),
    outputHash: sha256(input.output),
    adapter: input.adapter,
    hookCompleted,
    hookFailed,
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
