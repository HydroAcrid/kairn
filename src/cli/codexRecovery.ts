// SPDX-License-Identifier: Apache-2.0

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
    .filter((line) => line.trim().length > 0)
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

export function missingRequiredScopeFiles(input: {
  task: string;
  interactive: boolean;
  exitCode: number | null;
  prime?: ContextPrime | undefined;
  changedFiles: string[];
}): string[] {
  if (input.interactive) return [];
  if ((input.exitCode ?? 1) !== 0) return [];
  if (!taskIsOfficialProductionPatchPrompt(input.task)) return [];
  if (input.prime?.editScope?.strictBoundary !== true) return [];
  if (input.prime.editScope.scopeSource !== "official_harness") return [];
  const required = uniquePaths(input.prime.editScope.initialEditFiles ?? []);
  if (required.length < 2) return [];
  if (input.changedFiles.length === 0) return [];
  const changed = new Set(input.changedFiles);
  return required.filter((file) => !changed.has(file));
}

export function extraStrictScopeFiles(input: {
  task: string;
  interactive: boolean;
  exitCode: number | null;
  prime?: ContextPrime | undefined;
  changedFiles: string[];
}): string[] {
  if (input.interactive) return [];
  if ((input.exitCode ?? 1) !== 0) return [];
  if (!taskIsOfficialProductionPatchPrompt(input.task)) return [];
  if (input.prime?.editScope?.strictBoundary !== true) return [];
  if (input.prime.editScope.scopeSource !== "official_harness") return [];
  const required = new Set(uniquePaths(input.prime.editScope.initialEditFiles ?? []));
  if (required.size === 0) return [];
  return uniquePaths(input.changedFiles).filter((file) => !required.has(file));
}

export function shouldRetryCodexPartialScope(input: {
  task: string;
  interactive: boolean;
  exitCode: number | null;
  prime?: ContextPrime | undefined;
  changedFiles: string[];
}): boolean {
  return missingRequiredScopeFiles(input).length > 0 || extraStrictScopeFiles(input).length > 0;
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

export function buildCodexPartialScopeRecoveryPrompt(input: {
  task: string;
  prime?: ContextPrime | undefined;
  changedFiles: string[];
  missingFiles?: string[] | undefined;
  extraFiles?: string[] | undefined;
}): string {
  const scopedFiles = uniquePaths(input.prime?.editScope?.initialEditFiles ?? []);
  const changedFiles = uniquePaths(input.changedFiles);
  const missingFiles = uniquePaths(input.missingFiles ?? scopedFiles.filter((file) => !changedFiles.includes(file)));
  const extraFiles = uniquePaths(input.extraFiles ?? changedFiles.filter((file) => !scopedFiles.includes(file)));
  const invariant = input.prime?.invariants?.[0]?.statement;
  return [
    "# Kairn Required-Scope Recovery",
    "",
    extraFiles.length > 0
      ? "The previous agent run touched source outside the strict edit scope."
      : "The previous agent run produced a partial production diff but missed required source surfaces.",
    extraFiles.length > 0
      ? "First revert/remove every out-of-scope edit below. Then add only the smallest missing required edits needed for the original task."
      : "Keep the existing patch unless it is wrong. Add the smallest missing production edits needed for the original task.",
    "",
    changedFiles.length > 0 ? `Already changed: ${changedFiles.slice(0, 6).join(", ")}` : "Already changed: none detected.",
    extraFiles.length > 0 ? `Out-of-scope edits to revert: ${extraFiles.slice(0, 6).join(", ")}` : "",
    missingFiles.length > 0 ? `Missing required edits: ${missingFiles.slice(0, 6).join(", ")}` : "Missing required edits: any strict edit-scope file not yet touched.",
    scopedFiles.length > 0 ? `Full required scope: ${scopedFiles.slice(0, 8).join(", ")}` : "Full required scope: the strict production source scope.",
    invariant ? `Preserve: ${invariant}` : "Preserve the behavior described by the task.",
    "",
    "Do not edit tests, docs, examples, generated files, or unrelated sibling source.",
    extraFiles.length > 0 ? "Final diff must contain only files in the full required scope." : "",
    "Do not restart from scratch. Patch the missing required files and any minimal already-changed in-scope integration point only if needed.",
    "If a listed required file is genuinely unnecessary, say why with evidence instead of leaving it silently untouched.",
    "",
    "Original task:",
    input.task
  ].filter((line) => line !== "").join("\n");
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
