import path from "node:path";
import { normalizeRelativePath } from "../utils/paths.js";

const FILE_REF_PATTERNS = [
  /(?:^|\s|["'([])((?:[A-Za-z]:)?[^ "'()\n\r]+?\.[cm]?[jt]sx?|[^ "'()\n\r]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|mdx)):(\d+)(?::(\d+))?/gm,
  /(?:^|\s|["'([])((?:[A-Za-z]:)?[^ "'()\n\r]+?\.[cm]?[jt]sx?|[^ "'()\n\r]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|mdx))\((\d+),(\d+)\)/gm
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
    if (normalized && (known.size === 0 || known.has(normalized))) {
      files.add(normalized);
    }
  }

  const output = input.output ?? "";
  for (const pattern of FILE_REF_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const normalized = normalizeCandidate(match[1] ?? "", input.rootPath);
      if (!normalized) continue;
      if (known.size === 0 || known.has(normalized)) {
        files.add(normalized);
      }
    }
  }

  return [...files].sort();
}

function normalizeCandidate(candidate: string, rootPath: string): string | undefined {
  const trimmed = candidate.trim().replace(/^file:\/\//, "");
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
