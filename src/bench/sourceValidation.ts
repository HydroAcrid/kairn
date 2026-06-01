import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BenchmarkDiffScope, BenchmarkSourceInvariant, SymbolRecord } from "../types.js";
import { parseSourceFile } from "../parser/parseFile.js";
import { detectLanguage } from "../scanner/classifyFile.js";
import { normalizeRelativePath } from "../utils/paths.js";

export type SourceInvariantResult = {
  passed: boolean;
  failures: string[];
  checked: Array<{ id?: string; file: string; passed: boolean; failures: string[] }>;
};

export type DiffScopeResult = {
  passed: boolean;
  violations: string[];
  changedFiles: string[];
};

type ChangedLine = {
  file: string;
  line: number;
};

export function evaluateSourceInvariants(input: {
  rootPath: string;
  invariants?: BenchmarkSourceInvariant[] | undefined;
}): SourceInvariantResult {
  const invariants = input.invariants ?? [];
  const checked = invariants.map((invariant) => evaluateSourceInvariant(input.rootPath, invariant));
  const failures = checked.flatMap((item) => item.failures);
  return {
    passed: failures.length === 0,
    failures,
    checked
  };
}

export async function evaluateDiffScopes(input: {
  rootPath: string;
  scopes?: BenchmarkDiffScope[] | undefined;
  ignoreFiles?: string[] | undefined;
  task?: string | undefined;
}): Promise<DiffScopeResult> {
  const scopes = input.scopes ?? [];
  if (scopes.length === 0) {
    return {
      passed: true,
      violations: [],
      changedFiles: []
    };
  }

  const ignored = new Set((input.ignoreFiles ?? []).map(normalizeRelativePath));
  const changedFiles = gitChangedFiles(input.rootPath).filter((file) => !ignored.has(file));
  const scopeByFile = new Map(scopes.map((scope) => [normalizeRelativePath(scope.file), scope]));
  const violations: string[] = [];

  for (const file of changedFiles) {
    const scope = scopeByFile.get(file);
    if (!scope) {
      if (isPromptRequiredConfigSchemaCompanion(file, input.task)) continue;
      if (isPromptNamedProductionCompanion(file, input.task, [...scopeByFile.keys()])) continue;
      violations.push(`${file}: changed outside allowed diff scopes`);
      continue;
    }
    if (scope.allowWholeFile || !scope.symbols || scope.symbols.length === 0) continue;

    const changedLines = changedLinesForFile(input.rootPath, file);
    const symbols = await symbolsForFile(input.rootPath, file);
    const allowedSymbols = symbols.filter((symbol) => scope.symbols?.includes(symbol.name));
    if (allowedSymbols.length === 0 && changedLines.length > 0) {
      violations.push(`${file}: none of the allowed symbols were found (${scope.symbols.join(", ")})`);
      continue;
    }

    for (const line of changedLines) {
      if (!allowedSymbols.some((symbol) => line.line >= symbol.startLine && line.line <= symbol.endLine)) {
        violations.push(`${file}:${line.line}: changed outside allowed symbols (${scope.symbols.join(", ")})`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    changedFiles
  };
}

function isPromptRequiredConfigSchemaCompanion(filePath: string, task: string | undefined): boolean {
  if (!task) return false;
  const normalizedPath = normalizeRelativePath(filePath).toLowerCase();
  if (!/(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.(ya?ml|json|toml)$/.test(normalizedPath)) {
    return false;
  }
  const normalizedTask = task.toLowerCase();
  return (
    /\b(config|configuration|setting|settings|option|options|workaround|workarounds)\b/.test(normalizedTask) &&
    /\b(named|must exist|exists?|accept|values?|valid values?|default|required|restart|backend|metadata|schema|define|add|support)\b/.test(normalizedTask) &&
    /\b(setting|option|values?|default|restart|backend|schema|metadata)\b/.test(normalizedTask)
  );
}

function isPromptNamedProductionCompanion(filePath: string, task: string | undefined, scopedFiles: string[]): boolean {
  if (!task) return false;
  const file = normalizeRelativePath(filePath);
  if (!isProductionSourceCandidate(file)) return false;
  if (!isNearScopedProductionSurface(file, scopedFiles)) return false;

  const normalizedTask = normalizePromptText(task);
  if (normalizedTask.includes(normalizePromptText(file))) return true;

  const baseName = path.basename(file).replace(/\.[^.]+$/, "");
  const compactBase = compactIdentifier(baseName);
  if (compactBase.length < 5) return false;
  return compactIdentifier(task).includes(compactBase);
}

function isProductionSourceCandidate(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  if (/(^|\/)(test|tests|__tests__|__snapshots__|fixtures?|docs?|examples?|generated|dist|build|node_modules)\//.test(normalized)) {
    return false;
  }
  if (/\.(test|spec|snap|md|mdx|rst|txt|jsonl?)$/.test(normalized)) return false;
  return /\.(c|cc|cpp|cs|go|java|js|jsx|kt|py|rb|rs|scala|swift|ts|tsx|ya?ml|toml)$/.test(normalized);
}

function isNearScopedProductionSurface(filePath: string, scopedFiles: string[]): boolean {
  const file = normalizeRelativePath(filePath);
  return scopedFiles.some((scopedFile) => {
    const root = productionSurfaceRoot(normalizeRelativePath(scopedFile));
    return root.length > 0 && file.startsWith(`${root}/`);
  });
}

function productionSurfaceRoot(filePath: string): string {
  const parts = normalizeRelativePath(filePath).split("/").filter(Boolean);
  if (parts.length < 2) return "";
  if (parts[0] === "src" && parts.length >= 3) return parts.slice(0, 2).join("/");
  if ((parts[0] === "lib" || parts[0] === "app" || parts[0] === "packages") && parts.length >= 3) return parts.slice(0, 3).join("/");
  return parts.slice(0, 2).join("/");
}

function normalizePromptText(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/");
}

function compactIdentifier(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function evaluateSourceInvariant(rootPath: string, invariant: BenchmarkSourceInvariant): SourceInvariantResult["checked"][number] {
  const file = normalizeRelativePath(invariant.file);
  const absolute = path.join(rootPath, file);
  const failures: string[] = [];
  const content = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";

  if (!content) failures.push(`${file}: file is missing or empty`);

  for (const needle of invariant.requiredPresent ?? []) {
    if (!content.includes(needle)) failures.push(`${file}: missing required text ${JSON.stringify(needle)}`);
  }
  for (const needle of invariant.requiredAbsent ?? []) {
    if (content.includes(needle)) failures.push(`${file}: forbidden text remains ${JSON.stringify(needle)}`);
  }
  for (const pattern of invariant.requiredRegex ?? []) {
    if (!regexFromString(pattern).test(content)) failures.push(`${file}: missing required pattern ${pattern}`);
  }
  if ((invariant.requiredAny ?? []).length > 0 && !invariant.requiredAny!.some((needle) => content.includes(needle))) {
    failures.push(`${file}: none of the required alternatives were present`);
  }
  if ((invariant.requiredAnyRegex ?? []).length > 0 && !invariant.requiredAnyRegex!.some((pattern) => regexFromString(pattern).test(content))) {
    failures.push(`${file}: none of the required regex alternatives matched`);
  }

  return {
    ...(invariant.id ? { id: invariant.id } : {}),
    file,
    passed: failures.length === 0,
    failures
  };
}

function regexFromString(pattern: string): RegExp {
  const literal = pattern.match(/^\/(.*)\/([dgimsuvy]*)$/);
  if (literal) return new RegExp(literal[1]!, literal[2]);
  return new RegExp(pattern, "m");
}

function gitChangedFiles(rootPath: string): string[] {
  try {
    const tracked = execFileSync("git", ["diff", "--name-only"], { cwd: rootPath, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter((file) => file && !isBenchmarkInternalPath(file));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: rootPath, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter((file) => file && !isBenchmarkInternalPath(file));
    return [...new Set([...tracked, ...untracked])].sort();
  } catch {
    return [];
  }
}

function isBenchmarkInternalPath(filePath: string): boolean {
  return filePath === ".kairn" ||
    filePath.startsWith(".kairn/") ||
    filePath === ".codex" ||
    filePath.startsWith(".codex/") ||
    filePath === "go.work.sum";
}

function changedLinesForFile(rootPath: string, file: string): ChangedLine[] {
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--unified=0", "--", file], { cwd: rootPath, encoding: "utf8" });
  } catch {
    return [];
  }

  const lines: ChangedLine[] = [];
  let newLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) {
      lines.push({ file, line: Math.max(1, newLine) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ file, line: Math.max(1, newLine) });
      continue;
    }
    if (raw.length > 0) newLine += 1;
  }
  return dedupeChangedLines(lines);
}

async function symbolsForFile(rootPath: string, file: string): Promise<SymbolRecord[]> {
  const absolute = path.join(rootPath, file);
  if (!fs.existsSync(absolute)) return [];
  const content = fs.readFileSync(absolute, "utf8");
  return (await parseSourceFile({
    rootPath,
    filePath: file,
    content,
    language: detectLanguage(file)
  })).symbols;
}

function dedupeChangedLines(lines: ChangedLine[]): ChangedLine[] {
  const seen = new Set<string>();
  const output: ChangedLine[] = [];
  for (const line of lines) {
    const key = `${line.file}:${line.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(line);
  }
  return output;
}
