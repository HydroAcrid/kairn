// SPDX-License-Identifier: Apache-2.0

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
  const pythonImportPattern = /^\s*import\s+([.\w]+)(?:\s+as\s+\w+)?(?:\s*,\s*([.\w]+)(?:\s+as\s+\w+)?)*\s*$/gm;
  const pythonFromPattern = /^\s*from\s+([.\w]+)\s+import\s+/gm;
  const javaImportPattern = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
  const cIncludePattern = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/gm;
  const goSingleImportPattern = /^\s*import\s+(?:[._A-Za-z][\w.]*\s+)?["`]([^"`]+)["`]\s*$/gm;
  const goImportBlockPattern = /^\s*import\s*\(([^)]*)\)/gms;
  const goImportBlockItemPattern = /^\s*(?:[._A-Za-z][\w.]*\s+)?["`]([^"`]+)["`]\s*$/gm;

  for (const match of content.matchAll(importPattern)) {
    if (match[1]) imports.add(match[1]);
  }

  for (const match of content.matchAll(requirePattern)) {
    if (match[1]) imports.add(match[1]);
  }

  for (const match of content.matchAll(pythonImportPattern)) {
    const line = match[0].replace(/^\s*import\s+/, "");
    for (const item of line.split(",")) {
      const specifier = item.trim().replace(/\s+as\s+.+$/, "");
      if (specifier) imports.add(specifier);
    }
  }

  for (const match of content.matchAll(pythonFromPattern)) {
    if (match[1]) imports.add(match[1].startsWith(".") ? match[1].replace(/^\.+/, "./") : match[1]);
  }

  for (const match of content.matchAll(javaImportPattern)) {
    if (match[1]) imports.add(match[1]);
  }

  for (const match of content.matchAll(cIncludePattern)) {
    if (match[1]) imports.add(match[1]);
  }

  for (const match of content.matchAll(goSingleImportPattern)) {
    if (match[1]) imports.add(match[1]);
  }

  for (const block of content.matchAll(goImportBlockPattern)) {
    for (const match of (block[1] ?? "").matchAll(goImportBlockItemPattern)) {
      if (match[1]) imports.add(match[1]);
    }
  }

  return [...imports];
}

export function resolveImportCandidates(fromFile: string, specifier: string): string[] {
  const candidates: string[] = [];

  if (specifier.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    candidates.push(
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
      `${base}.py`,
      `${base}.pyi`,
      `${base}.go`,
      `${base}.java`,
      `${base}.c`,
      `${base}.cc`,
      `${base}.cpp`,
      `${base}.cxx`,
      `${base}.h`,
      `${base}.hh`,
      `${base}.hpp`,
      `${base}.hxx`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.tsx"),
    path.posix.join(base, "index.js"),
      path.posix.join(base, "index.jsx"),
      path.posix.join(base, "__init__.py")
    );
  }

  if (/^[A-Za-z_][\w.]*$/.test(specifier)) {
    const modulePath = specifier.replaceAll(".", "/");
    candidates.push(
      `${modulePath}.py`,
      path.posix.join(modulePath, "__init__.py"),
      path.posix.join("src", `${modulePath}.py`),
      path.posix.join("src", modulePath, "__init__.py"),
      path.posix.join("src/main/java", `${modulePath}.java`),
      path.posix.join("src/test/java", `${modulePath}.java`)
    );
  }

  if (/^[^/].*\.(h|hh|hpp|hxx)$/.test(specifier)) {
    candidates.push(
      specifier,
      path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)),
      path.posix.join("include", specifier),
      path.posix.join("src", specifier)
    );
  }

  return [...new Set(candidates)];
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
