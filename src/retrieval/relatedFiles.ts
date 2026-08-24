// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { FileRecord } from "../types.js";
import { extractImports, readTextFile, resolveImportCandidates } from "./readSource.js";

export function findRelatedFiles(rootPath: string, files: FileRecord[], target: string): FileRecord[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const related = new Map<string, FileRecord>();
  const targetRecord = byPath.get(target);

  if (!targetRecord) {
    return [];
  }

  const targetContent = readTextFile(rootPath, target);
  const imports = extractImports(targetContent);

  for (const specifier of imports) {
    for (const candidate of resolveImportCandidates(target, specifier)) {
      const record = byPath.get(candidate);
      if (record) related.set(record.path, record);
    }
  }

  for (const file of files) {
    if (file.path === target) continue;

    if (isLikelyTestFor(file.path, target)) {
      related.set(file.path, file);
      continue;
    }

    if (path.posix.dirname(file.path) === path.posix.dirname(target) && file.importance >= 4) {
      related.set(file.path, file);
    }
  }

  for (const file of files) {
    if (!isSourceLike(file.path)) continue;
    try {
      const content = readTextFile(rootPath, file.path);
      const importsTarget = extractImports(content).some((specifier) =>
        resolveImportCandidates(file.path, specifier).includes(target)
      );

      if (importsTarget) {
        related.set(file.path, file);
      }
    } catch {
      // Ignore unreadable files during best-effort graph discovery.
    }
  }

  return [...related.values()].sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path));
}

export function findTestsFor(files: FileRecord[], target?: string): FileRecord[] {
  const tests = files.filter((file) => file.kind === "test");

  if (!target) {
    return tests.sort((a, b) => a.path.localeCompare(b.path));
  }

  return tests
    .filter((file) => isLikelyTestFor(file.path, target) || path.posix.dirname(file.path) === path.posix.dirname(target))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function isLikelyTestFor(testPath: string, target: string): boolean {
  const targetBase = path.posix.basename(target).replace(/\.[^.]+$/, "").toLowerCase();
  const testBase = path.posix.basename(testPath).toLowerCase();
  const normalizedTest = testPath.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  const targetDirectory = path.posix.dirname(normalizedTarget);
  const testDirectory = path.posix.dirname(normalizedTest);

  return (
    testBase.includes(targetBase) ||
    normalizedTest.includes(targetBase) ||
    testDirectory === targetDirectory ||
    testDirectory.endsWith("/tests") && normalizedTest.includes(targetBase) ||
    normalizedTest.includes("/src/test/java/") && normalizedTarget.includes("/src/main/java/") && testBase.includes(targetBase)
  );
}

function isSourceLike(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(filePath);
}
