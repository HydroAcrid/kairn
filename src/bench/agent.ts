import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BenchmarkCase, BenchmarkTaskOutcome } from "../types.js";
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

export function runAgentBenchmarkCase(input: {
  rootPath: string;
  benchmarkCase: BenchmarkCase;
  agentCommand?: string | undefined;
  timeoutMs?: number | undefined;
}): AgentBenchmarkResult {
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
    const command = input.agentCommand
      .replaceAll("{prompt}", shellQuote(prompt))
      .replaceAll("{root}", shellQuote(workspacePath));
    const output = execFileSync(command, {
      cwd: workspacePath,
      shell: true,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120000,
      maxBuffer: 1024 * 1024
    });
    const actualFiles = changedFiles(workspacePath);
    return {
      workspacePath,
      actualFiles,
      responseTokens: estimateTokens(output),
      outcome: "pass",
      summary: `Agent command completed in disposable workspace. Changed files: ${actualFiles.length}.`,
      metadata: {
        workspacePath,
        promptHash: sha256(prompt),
        outputHash: sha256(output),
        adapter: "command"
      }
    };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    return {
      workspacePath,
      actualFiles: changedFiles(workspacePath),
      responseTokens: estimateTokens(output),
      outcome: "fail",
      summary: "Agent command failed in disposable workspace.",
      metadata: {
        workspacePath,
        promptHash: sha256(prompt),
        outputHash: sha256(output),
        adapter: "command"
      }
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
