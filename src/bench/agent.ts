import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { BenchmarkCase, BenchmarkTaskOutcome } from "../types.js";
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
  const workspacePath = createTempWorkspace(input.rootPath);
  const prompt = input.benchmarkCase.agentPrompt ?? input.benchmarkCase.task;

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
        adapter: "none"
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
    const expectedFileMentions = mentionedExpectedFiles(output, input.benchmarkCase.expectedFiles);
    const actualFiles = unique([...changedFiles(workspacePath), ...expectedFileMentions]);
    const metadata = metadataFromOutput({
      output,
      prompt: prepared.prompt,
      workspacePath,
      elapsedMs: Date.now() - startedAt,
      adapter: "command",
      extraMetadata: {
        originalPromptHash: sha256(prompt),
        expectedFileMentions,
        ...(prepared.metadata ?? {})
      }
    });
    if (completed.error || (completed.status ?? 0) !== 0) {
      return {
        workspacePath,
        actualFiles,
        responseTokens: estimateTokens(output),
        ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
        outcome: "fail",
        summary: `Agent command failed in disposable workspace with exit code ${completed.status ?? "unknown"}.`,
        metadata: metadata.metadata
      };
    }
    return {
      workspacePath,
      actualFiles,
      responseTokens: estimateTokens(output),
      ...(metadata.observedCodexTokens !== undefined ? { observedCodexTokens: metadata.observedCodexTokens } : {}),
      outcome: "pass",
      summary: `Agent command completed in disposable workspace. Changed files: ${actualFiles.length}.`,
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

function changedFiles(workspacePath: string): string[] {
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
