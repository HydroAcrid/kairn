import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ContextPrime } from "../types.js";
import { taskIsOfficialProductionPatchPrompt } from "../prime/contextGovernor.js";
import { uniquePaths } from "../utils/collections.js";

export function relevantWorkspaceDiffFiles(rootPath: string): string[] {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: rootPath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if ((result.status ?? 0) !== 0 || result.error) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeStatusPath(line))
    .filter((file): file is string => Boolean(file))
    .filter((file) => isRelevantDiffPath(file));
}

export function shouldRetryCodexNoDiff(input: {
  task: string;
  interactive: boolean;
  exitCode: number | null;
  prime?: ContextPrime | undefined;
  changedFiles: string[];
}): boolean {
  if (input.interactive) return false;
  if ((input.exitCode ?? 1) !== 0) return false;
  if (input.changedFiles.length > 0) return false;
  if (!taskIsOfficialProductionPatchPrompt(input.task)) return false;
  const action = input.prime?.contextDecision?.action;
  if (action && action !== "shrink" && action !== "request_evidence") return false;
  return true;
}

export function buildCodexNoDiffRecoveryPrompt(input: {
  task: string;
  prime?: ContextPrime | undefined;
}): string {
  const scopedFiles = uniquePaths(input.prime?.editScope?.initialEditFiles ?? []);
  const fallbackFiles = uniquePaths(input.prime?.files ?? []);
  const files = uniquePaths(
    taskIsOfficialProductionPatchPrompt(input.task) && scopedFiles.length > 0
      ? scopedFiles
      : [...scopedFiles, ...fallbackFiles]
  ).slice(0, 4);
  const readOnly = uniquePaths(input.prime?.editScope?.readOnlyFiles ?? []).slice(0, 3);
  const invariant = input.prime?.invariants?.[0]?.statement;
  return [
    "# Kairn No-Diff Recovery",
    "",
    "The previous agent run exited without a production source diff.",
    "Make the smallest production source edit required by the task. Do not stop after analysis if the edit scope below is sufficient.",
    "",
    files.length > 0 ? `Edit scope: ${files.join(", ")}` : "Edit scope: the smallest relevant production source file.",
    readOnly.length > 0 ? `Read-only verification targets: ${readOnly.join(", ")}` : "Verification: use the narrowest relevant check.",
    invariant ? `Preserve: ${invariant}` : "Preserve the behavior described by the task.",
    "",
    "Do not edit tests, docs, examples, generated files, or unrelated sibling source.",
    "If the edit scope is genuinely incomplete, say exactly which production file or runtime evidence is missing instead of broad scanning.",
    "",
    "Original task:",
    input.task
  ].join("\n");
}

function normalizeStatusPath(line: string): string | undefined {
  const renamed = line.match(/^.. (.+?) -> (.+)$/);
  const raw = renamed ? renamed[2] : line.slice(3);
  const normalized = raw?.trim().replaceAll("\\", "/");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isRelevantDiffPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  if (
    normalized.startsWith(".kairn/") ||
    normalized.startsWith(".codex/") ||
    normalized === "AGENTS.md" ||
    normalized === path.normalize("AGENTS.md")
  ) {
    return false;
  }
  return true;
}
