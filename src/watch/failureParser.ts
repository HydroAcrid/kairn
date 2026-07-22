// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { normalizeRelativePath } from "../utils/paths.js";

const FAILURE_FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|mdx|py|pyi|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|txt";

const FILE_REF_PATTERNS = [
  // Python: File "/repo/pkg/service.py", line 42, in handle
  new RegExp(`\\bFile\\s+["']([^"']+?\\.(?:${FAILURE_FILE_EXTENSIONS}))["']\\s*,\\s*line\\s+\\d+`, "gim"),
  // TypeScript, Go, GCC/Clang, pytest, and most compiler output.
  new RegExp(`(?:^|\\s|["'(\\[])((?:[A-Za-z]:)?[^\\s"'()\\[\\]{}]+?\\.(?:${FAILURE_FILE_EXTENSIONS})):\\d+(?::\\d+)?`, "gim"),
  // TypeScript/MSVC: src/app.ts(4,2), source.cpp(10,7)
  new RegExp(`(?:^|\\s|["'(\\[])((?:[A-Za-z]:)?[^\\s"'()\\[\\]{}]+?\\.(?:${FAILURE_FILE_EXTENSIONS}))\\(\\d+(?:,\\d+)?\\)`, "gim"),
  // Java/JUnit: at com.example.Service.run(Service.java:42)
  new RegExp(`\\(([^()\\s]+?\\.(?:java|kt|kts)):\\d+(?::\\d+)?\\)`, "gim"),
  // Tool prefixes such as FAIL, Error:, CMake Error at, and test runners.
  new RegExp(`(?:^|\\s)(?:FAIL|PASS|Test Files?|at|file|File|Error:|CMake Error at)\\s+((?:[A-Za-z]:)?[^\\s"'()]+?\\.(?:${FAILURE_FILE_EXTENSIONS}))`, "gim"),
  // Last-resort extension match, filtered against the repository inventory.
  new RegExp(`(?:^|\\s|["'(\\[])((?:[A-Za-z]:)?[^\\s"'()\\[\\]{}]+?\\.(?:${FAILURE_FILE_EXTENSIONS}))(?=$|[\\s"'),:;\\]}.#])`, "gim")
];

export function extractFailureFiles(input: {
  output?: string | undefined;
  rootPath: string;
  knownFiles: string[];
  explicitFiles?: string[] | undefined;
}): string[] {
  const known = new Set(input.knownFiles.map((filePath) => normalizeRelativePath(filePath)));
  const files = new Set<string>();

  for (const explicit of input.explicitFiles ?? []) {
    const normalized = normalizeCandidate(explicit, input.rootPath);
    const resolved = normalized ? resolveKnownCandidate(normalized, known) : undefined;
    if (resolved) files.add(resolved);
  }

  const output = input.output ?? "";
  for (const pattern of FILE_REF_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of output.matchAll(pattern)) {
      const normalized = normalizeCandidate(match[1] ?? "", input.rootPath);
      if (!normalized) continue;
      const resolved = resolveKnownCandidate(normalized, known);
      if (resolved) files.add(resolved);
    }
  }

  return [...files].sort();
}

function normalizeCandidate(candidate: string, rootPath: string): string | undefined {
  const trimmed = candidate.trim().replace(/^file:\/\//, "").replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("node_modules")) return undefined;

  const absoluteRoot = path.resolve(rootPath);
  const normalized = path.isAbsolute(trimmed)
    ? path.relative(absoluteRoot, trimmed)
    : trimmed;

  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return undefined;
  }

  return normalizeRelativePath(normalized.replace(/^\.\//, ""));
}

function resolveKnownCandidate(candidate: string, known: Set<string>): string | undefined {
  const normalized = normalizeRelativePath(candidate);
  if (known.size === 0) return normalized;
  if (known.has(normalized)) return normalized;

  const lowerCandidate = normalized.toLowerCase();
  const matches = [...known].filter((knownFile) => {
    const lowerKnown = knownFile.toLowerCase();
    return (
      lowerKnown.endsWith(`/${lowerCandidate}`) ||
      lowerCandidate.endsWith(`/${lowerKnown}`) ||
      (!lowerCandidate.includes("/") && path.posix.basename(lowerKnown) === lowerCandidate)
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
