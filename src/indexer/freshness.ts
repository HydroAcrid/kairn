import { execFileSync } from "node:child_process";
import type { IndexFreshnessMetadata, IndexFreshnessStatus } from "../types.js";
import { sha256 } from "../utils/hash.js";
import { nowIso } from "../utils/time.js";

export const INDEX_FRESHNESS_SCHEMA_VERSION = 1;

export function captureIndexFreshnessMetadata(input: {
  rootPath: string;
  fileCount: number;
}): IndexFreshnessMetadata {
  const current = readCurrentIndexState(input.rootPath);
  return {
    rootPath: input.rootPath,
    ...(current.gitHead ? { gitHead: current.gitHead } : {}),
    ...(current.gitBranch ? { gitBranch: current.gitBranch } : {}),
    dirtyFingerprint: current.dirtyFingerprint,
    fileCount: current.currentFileCount ?? input.fileCount,
    schemaVersion: INDEX_FRESHNESS_SCHEMA_VERSION,
    indexedAt: nowIso(),
    metadata: {
      dirtyFileCount: current.dirtyFileCount,
      currentFileCount: current.currentFileCount,
      gitAvailable: current.gitAvailable
    }
  };
}

export function evaluateIndexFreshness(input: {
  rootPath: string;
  stored?: IndexFreshnessMetadata | undefined;
}): IndexFreshnessStatus {
  const current = readCurrentIndexState(input.rootPath);
  if (!input.stored) {
    return {
      stale: true,
      reason: "missing_metadata",
      currentGitHead: current.gitHead,
      currentGitBranch: current.gitBranch,
      dirtyFileCount: current.dirtyFileCount,
      currentFileCount: current.currentFileCount
    };
  }

  const base = {
    indexedAt: input.stored.indexedAt,
    gitHead: input.stored.gitHead,
    gitBranch: input.stored.gitBranch,
    currentGitHead: current.gitHead,
    currentGitBranch: current.gitBranch,
    dirtyFileCount: current.dirtyFileCount,
    indexedFileCount: input.stored.fileCount,
    currentFileCount: current.currentFileCount
  };

  if (input.stored.schemaVersion !== INDEX_FRESHNESS_SCHEMA_VERSION) return { ...base, stale: true, reason: "unknown" };
  if (input.stored.gitHead && current.gitHead && input.stored.gitHead !== current.gitHead) return { ...base, stale: true, reason: "git_head_changed" };
  if (input.stored.gitBranch && current.gitBranch && input.stored.gitBranch !== current.gitBranch) return { ...base, stale: true, reason: "git_branch_changed" };
  if (input.stored.dirtyFingerprint !== current.dirtyFingerprint) return { ...base, stale: true, reason: "dirty_state_changed" };
  if (current.currentFileCount !== undefined && input.stored.fileCount !== current.currentFileCount) return { ...base, stale: true, reason: "file_count_changed" };
  return { ...base, stale: false, reason: "fresh" };
}

function readCurrentIndexState(rootPath: string): {
  gitAvailable: boolean;
  gitHead?: string;
  gitBranch?: string;
  dirtyFingerprint: string;
  dirtyFileCount: number;
  currentFileCount?: number;
} {
  const status = git(rootPath, ["status", "--porcelain=v1", "-z"]);
  if (status === undefined) {
    return {
      gitAvailable: false,
      dirtyFingerprint: "nogit",
      dirtyFileCount: 0
    };
  }
  const gitHead = git(rootPath, ["rev-parse", "HEAD"])?.trim();
  const gitBranch = git(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  const trackedFiles = git(rootPath, ["ls-files", "-z"]);
  const dirtyFiles = status.split("\0").filter(Boolean);
  return {
    gitAvailable: true,
    ...(gitHead ? { gitHead } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    dirtyFingerprint: sha256(status),
    dirtyFileCount: dirtyFiles.length,
    ...(trackedFiles !== undefined ? { currentFileCount: trackedFiles.split("\0").filter(Boolean).length } : {})
  };
}

function git(rootPath: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return undefined;
  }
}
