import fs from "node:fs";
import path from "node:path";
import type { FileRecord } from "../types.js";
import { resolveInsideRoot } from "../utils/paths.js";

export function readTextFile(rootPath: string, target: string): string {
  const absolutePath = resolveInsideRoot(rootPath, target);
  const buffer = fs.readFileSync(absolutePath);

  if (buffer.includes(0)) {
    throw new Error(`Refusing to read binary file: ${target}`);
  }

  return buffer.toString("utf8");
}

export function summarizeFile(file: FileRecord, content: string): string {
  const lines = content.split(/\r?\n/);
  const imports = lines.filter((line) => /^\s*import\s/.test(line)).slice(0, 12);
  const exports = lines
    .filter((line) => /^\s*export\s/.test(line) || /^\s*(export\s+)?(async\s+)?function\s+/.test(line))
    .slice(0, 20);

  return [
    `# ${file.path}`,
    "",
    `Language: ${file.language}`,
    `Kind: ${file.kind}`,
    `Size: ${file.size} bytes`,
    "",
    "## Imports",
    imports.length > 0 ? imports.join("\n") : "No top-level imports detected.",
    "",
    "## Key Declarations",
    exports.length > 0 ? exports.join("\n") : "No exported declarations detected by the lightweight summarizer.",
    "",
    "## First Lines",
    lines.slice(0, 40).join("\n")
  ].join("\n");
}

export function extractSymbol(content: string, symbol: string): { snippet: string; startLine: number; endLine: number } | null {
  const lines = content.split(/\r?\n/);
  const escaped = escapeRegex(symbol);
  const declarationPattern = new RegExp(
    `(^|\\s)(export\\s+)?(default\\s+)?(async\\s+)?(function|class|interface|type|const|let|var)\\s+${escaped}(\\b|\\s|<|=|\\()`
  );

  const startIndex = lines.findIndex((line) => declarationPattern.test(line));
  if (startIndex === -1) {
    return null;
  }

  const endIndex = findLikelyBlockEnd(lines, startIndex);
  return {
    snippet: lines.slice(startIndex, endIndex + 1).join("\n"),
    startLine: startIndex + 1,
    endLine: endIndex + 1
  };
}

export function extractImports(content: string): string[] {
  const imports = new Set<string>();
  const importPattern = /import(?:["'\s\w{},*]+from\s*)?["']([^"']+)["']/g;
  const requirePattern = /require\(["']([^"']+)["']\)/g;

  for (const match of content.matchAll(importPattern)) {
    if (match[1]) imports.add(match[1]);
  }

  for (const match of content.matchAll(requirePattern)) {
    if (match[1]) imports.add(match[1]);
  }

  return [...imports];
}

export function resolveImportCandidates(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) {
    return [];
  }

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
    path.posix.join(base, "index.js"),
    path.posix.join(base, "index.jsx")
  ];

  return candidates;
}

function findLikelyBlockEnd(lines: string[], startIndex: number): number {
  let braceDepth = 0;
  let sawBrace = false;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const char of line) {
      if (char === "{") {
        braceDepth += 1;
        sawBrace = true;
      } else if (char === "}") {
        braceDepth -= 1;
      }
    }

    if (sawBrace && braceDepth <= 0 && index > startIndex) {
      return index;
    }

    if (!sawBrace && index > startIndex && line.trim() === "") {
      return index - 1;
    }
  }

  return Math.min(lines.length - 1, startIndex + 80);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
