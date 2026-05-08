import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { FileRecord, ScanResult } from "../types.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath, resolveRoot } from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { classifyFile, detectLanguage, scoreFileImportance } from "./classifyFile.js";

const MAX_INDEXED_FILES = 8_000;

export const DEFAULT_IGNORE = [
  ".git/**",
  "**/.git/**",
  ".kairn/**",
  "**/.kairn/**",
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
  ".next/**",
  "**/.next/**",
  ".turbo/**",
  "**/.turbo/**",
  ".cache/**",
  "**/.cache/**",
  "coverage/**",
  "**/coverage/**",
  "target/**",
  "**/target/**",
  "vendor/**",
  "**/vendor/**",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.sqlite",
  "*.db"
];

export async function scanRepo(root?: string): Promise<ScanResult> {
  const rootPath = resolveRoot(root);
  const gitignore = createRepoIgnore(rootPath);
  const scannedAt = nowIso();

  const candidates = await fg("**/*", {
    cwd: rootPath,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE,
    unique: true
  });

  let ignoredCount = 0;
  const eligible: Array<{
    path: string;
    absolutePath: string;
    size: number;
    kind: ReturnType<typeof classifyFile>;
    language: string;
    importance: number;
  }> = [];

  for (const candidate of candidates) {
    const relativePath = normalizeRelativePath(candidate);

    if (gitignore.ignores(relativePath)) {
      ignoredCount += 1;
      continue;
    }

    const absolutePath = path.join(rootPath, relativePath);
    const stat = fs.statSync(absolutePath);

    if (stat.size > 400_000) {
      ignoredCount += 1;
      continue;
    }

    const kind = classifyFile(relativePath);
    const language = detectLanguage(relativePath);
    const importance = scoreFileImportance(relativePath, kind);

    eligible.push({
      path: relativePath,
      absolutePath,
      size: stat.size,
      kind,
      language,
      importance
    });
  }

  eligible.sort((a, b) => scanPriority(b) - scanPriority(a) || a.path.localeCompare(b.path));
  const selected = eligible.slice(0, MAX_INDEXED_FILES);
  const skippedByLimit = Math.max(0, eligible.length - selected.length);
  ignoredCount += skippedByLimit;

  const files: FileRecord[] = [];
  for (const item of selected) {
    const content = fs.readFileSync(item.absolutePath);
    files.push({
      rootPath,
      path: item.path,
      language: item.language,
      kind: item.kind,
      size: item.size,
      hash: sha256(content),
      importance: item.importance,
      updatedAt: scannedAt
    });
  }

  return {
    rootPath,
    files,
    ignoredCount,
    candidateCount: candidates.length,
    indexedFileLimit: MAX_INDEXED_FILES,
    skippedByLimit,
    scannedAt
  };
}

export function createRepoIgnore(rootPath: string): ReturnType<typeof ignore> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE);
  const gitignorePath = path.join(rootPath, ".gitignore");

  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  return ig;
}

function scanPriority(file: {
  path: string;
  kind: ReturnType<typeof classifyFile>;
  language: string;
  importance: number;
  size: number;
}): number {
  const normalized = file.path.toLowerCase();
  let score = file.importance;

  if (file.kind === "source" || file.kind === "component" || file.kind === "route") score += 80;
  if (file.kind === "schema" || file.kind === "config") score += 35;
  if (file.kind === "test") score += 18;
  if (file.kind === "doc" || file.kind === "unknown") score -= 35;

  if (normalized.startsWith("src/") || normalized.includes("/src/")) score += 35;
  if (normalized.startsWith("packages/") || normalized.includes("/packages/")) score += 22;
  if (normalized.startsWith("include/") || normalized.includes("/include/")) score += 30;
  if (normalized.startsWith("django/") || normalized.startsWith("lib/")) score += 22;
  if (normalized.startsWith("tests/") || normalized.includes("/tests/")) score -= 12;
  if (
    /(^|\/)(docs?|documentation|examples?|demo|demos|fixtures|fixture|generated|dist|build|coverage|website|site|playground|storybook|codemods?|devtools)\//.test(
      normalized
    )
  ) {
    score -= 80;
  }
  if (/(^|\/)(__snapshots__|snapshots)\//.test(normalized)) score -= 80;
  if (file.size > 120_000) score -= 10;

  return score;
}
