// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { FileRecord, IndexedFileTierState, IndexTier, ScanResult } from "../types.js";
import { inventoryBudget } from "../budget/adaptiveBudget.js";
import { loadIndexingConfig } from "../config/indexing.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath, resolveRoot } from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { classifyFile, detectLanguage, scoreFileImportance } from "./classifyFile.js";

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

export type ScanRepoOptions = {
  /** Testable/internal enrichment limits. Every non-ignored path is still inventoried. */
  enrichmentLimits?: {
    maxFiles?: number;
    maxFileBytes?: number;
  };
};

export async function scanRepo(root?: string, options: ScanRepoOptions = {}): Promise<ScanResult> {
  const rootPath = resolveRoot(root);
  const indexingConfig = loadIndexingConfig(rootPath);
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
  const budget = inventoryBudget({
    candidateCount: candidates.length,
    maxStateMb: indexingConfig.maxStateMb
  });
  const inventory = {
    maxInventoryFiles: clampNonNegativeInteger(
      options.enrichmentLimits?.maxFiles ?? budget.maxInventoryFiles
    ),
    maxFileBytes: clampNonNegativeInteger(
      options.enrichmentLimits?.maxFileBytes ?? budget.maxFileBytes
    )
  };

  let ignoredCount = 0;
  const discovered: Array<{
    path: string;
    absolutePath: string;
    size: number;
    mtimeMs: number;
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

    const kind = classifyFile(relativePath);
    const language = detectLanguage(relativePath);
    const importance = scoreFileImportance(relativePath, kind);

    discovered.push({
      path: relativePath,
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      kind,
      language,
      importance
    });
  }

  const ranked = discovered
    .filter((file) => file.size <= inventory.maxFileBytes)
    .map((file) => ({
      ...file,
      tierScore: scanPriority(file)
    }))
    .sort((a, b) => b.tierScore - a.tierScore || a.path.localeCompare(b.path));
  const selected = ranked.slice(0, inventory.maxInventoryFiles);
  const selectedPaths = new Set(selected.map((file) => file.path));
  const skippedByLimit = discovered.filter((file) => !selectedPaths.has(file.path)).length;
  const enrichedTierStates = assignIndexTiers(selected, indexingConfig.maxHotFiles);
  const enrichedTiersByPath = new Map(enrichedTierStates.map((state) => [state.path, state]));
  const tierStates = discovered
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file): IndexedFileTierState => enrichedTiersByPath.get(file.path) ?? {
      path: file.path,
      tier: "tier0",
      score: Number(scanPriority(file).toFixed(3)),
      reasons: [file.size > inventory.maxFileBytes ? "oversized inventory metadata only" : "inventory metadata only"]
    });
  const tiersByPath = new Map(tierStates.map((state) => [state.path, state]));

  const files: FileRecord[] = [];
  for (const item of discovered.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const tier = tiersByPath.get(item.path);
    const hash = tier && tier.tier !== "tier0"
      ? sha256(fs.readFileSync(item.absolutePath))
      : inventoryMetadataHash(item);
    files.push({
      rootPath,
      path: item.path,
      language: item.language,
      kind: item.kind,
      size: item.size,
      hash,
      importance: item.importance,
      ...(tier ? { indexTier: tier.tier, tierScore: tier.score } : {}),
      updatedAt: scannedAt
    });
  }

  return {
    rootPath,
    files,
    ignoredCount,
    candidateCount: candidates.length,
    indexedFileLimit: inventory.maxInventoryFiles,
    skippedByLimit,
    inventoryOnlyCount: tierStates.filter((state) => state.tier === "tier0").length,
    contentIndexedCount: tierStates.filter((state) => state.tier !== "tier0").length,
    indexTiers: countTiers(tierStates),
    tierStates,
    scannedAt
  };
}

function inventoryMetadataHash(file: { path: string; size: number; mtimeMs: number }): string {
  return sha256(`tier0-metadata-v1\0${file.path}\0${file.size}\0${file.mtimeMs}`);
}

function clampNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
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
  if (normalized.startsWith("lib/") || normalized.includes("/lib/")) score += 22;
  if (normalized.startsWith("tests/") || normalized.includes("/tests/")) score -= 12;
  if (
    /(^|\/)(docs?|documentation|examples|demo|demos|fixtures?|__fixtures__|compiled|generated|gen|vendor|third[_-]party|dist|build|coverage|website|site|playground|storybook|codemods?|devtools)\//.test(
      normalized
    )
  ) {
    score -= 80;
  }
  if (/(^|\/)(__snapshots__|snapshots)\//.test(normalized)) score -= 80;
  if (file.size > 120_000) score -= 10;

  return score;
}

function assignIndexTiers(
  files: Array<{
    path: string;
    kind: ReturnType<typeof classifyFile>;
    language: string;
    importance: number;
    size: number;
    tierScore: number;
  }>,
  maxHotFiles: number
): IndexedFileTierState[] {
  return files.map((file, index) => {
    const reasons: string[] = [];
    let tier: IndexTier = "tier0";
    const sourceLike = isSourceLike(file);
    const noisy = isNoisyPath(file.path);

    if (sourceLike && !noisy) {
      tier = "tier1";
      reasons.push("cheap lexical/symbol metadata");
    }
    if (sourceLike && !noisy && (file.tierScore >= 95 || index < maxHotFiles * 3)) {
      tier = "tier2";
      reasons.push("summary candidate");
    }
    if (sourceLike && !noisy && (file.tierScore >= 125 || index < maxHotFiles)) {
      tier = "tier3";
      reasons.push("hot semantic chunk candidate");
    }
    if (file.kind === "config" || file.kind === "schema") {
      tier = "tier2";
      reasons.push("project metadata");
    }
    if (file.kind === "test" && tier === "tier3" && index >= 2_000) {
      tier = "tier2";
      reasons.push("test retained as summary unless strongly hot");
    }
    if (noisy) {
      tier = "tier0";
      reasons.push("docs/examples/generated retained as inventory only");
    }

    return {
      path: file.path,
      tier,
      score: Number(file.tierScore.toFixed(3)),
      reasons: reasons.length > 0 ? reasons : ["inventory metadata"]
    };
  });
}

function countTiers(states: IndexedFileTierState[]): Record<IndexTier, number> {
  return states.reduce<Record<IndexTier, number>>(
    (counts, state) => ({
      ...counts,
      [state.tier]: counts[state.tier] + 1
    }),
    { tier0: 0, tier1: 0, tier2: 0, tier3: 0, tier4: 0 }
  );
}

function isSourceLike(file: { kind: ReturnType<typeof classifyFile>; language: string }): boolean {
  return (
    file.kind === "source" ||
    file.kind === "component" ||
    file.kind === "route" ||
    file.kind === "test" ||
    ["python", "go", "java", "kotlin", "c", "cpp", "csharp", "typescript", "javascript"].includes(file.language)
  );
}

function isNoisyPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return /(^|\/)(docs?|documentation|examples|demo|demos|fixtures?|__fixtures__|compiled|generated|gen|vendor|third[_-]party|dist|build|coverage|website|site|playground|storybook|codemods?|devtools)\//.test(
    normalized
  );
}
