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

export function evaluateDiffScopes(input: {
  rootPath: string;
  scopes?: BenchmarkDiffScope[] | undefined;
}): DiffScopeResult {
  const scopes = input.scopes ?? [];
  if (scopes.length === 0) {
    return {
      passed: true,
      violations: [],
      changedFiles: []
    };
  }

  const changedFiles = gitChangedFiles(input.rootPath);
  const scopeByFile = new Map(scopes.map((scope) => [normalizeRelativePath(scope.file), scope]));
  const violations: string[] = [];

  for (const file of changedFiles) {
    const scope = scopeByFile.get(file);
    if (!scope) {
      violations.push(`${file}: changed outside allowed diff scopes`);
      continue;
    }
    if (scope.allowWholeFile || !scope.symbols || scope.symbols.length === 0) continue;

    const changedLines = changedLinesForFile(input.rootPath, file);
    const symbols = symbolsForFile(input.rootPath, file);
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
    return execFileSync("git", ["diff", "--name-only"], { cwd: rootPath, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => normalizeRelativePath(line.trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
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

function symbolsForFile(rootPath: string, file: string): SymbolRecord[] {
  const absolute = path.join(rootPath, file);
  if (!fs.existsSync(absolute)) return [];
  const content = fs.readFileSync(absolute, "utf8");
  return parseSourceFile({
    rootPath,
    filePath: file,
    content,
    language: detectLanguage(file)
  }).symbols;
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
