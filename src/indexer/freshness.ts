// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IndexFreshnessMetadata, IndexFreshnessStatus } from "../types.js";
import { createRepoIgnore } from "../scanner/scanRepo.js";
import { sha256 } from "../utils/hash.js";
import { nowIso } from "../utils/time.js";

// Increment whenever parser, graph, or other non-file-derived index semantics
// change. Existing embeddings remain reusable through their own content/model
// hashes, but structural records must be rebuilt before they are served.
export const INDEX_FRESHNESS_SCHEMA_VERSION = 5;

const MAX_CONTENT_IDENTITY_BYTES_PER_FILE = 256 * 1024;
const MAX_CONTENT_IDENTITY_BYTES_TOTAL = 2 * 1024 * 1024;
const MAX_FALLBACK_FILES = 8_192;
const MAX_FALLBACK_DIRECTORIES = 1_024;
const MAX_FALLBACK_ENTRIES = 12_288;
const FALLBACK_PRUNED_DIRECTORIES = new Set([
  ".git",
  ".kairn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  "vendor"
]);

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
      gitAvailable: current.gitAvailable,
      fallbackTruncated: current.fallbackTruncated ?? false
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

  if (input.stored.schemaVersion !== INDEX_FRESHNESS_SCHEMA_VERSION) {
    return { ...base, stale: true, reason: "index_schema_changed" };
  }
  // A bounded non-Git walk cannot prove that content beyond its cap is
  // unchanged. Treat that state as stale instead of silently serving old
  // evidence from a large checkout.
  if (current.fallbackTruncated) return { ...base, stale: true, reason: "unknown" };
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
  fallbackTruncated?: boolean;
} {
  const status = git(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === undefined) {
    return fingerprintFilesystemState(rootPath);
  }
  const gitHead = git(rootPath, ["rev-parse", "HEAD"])?.trim();
  const gitBranch = git(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  const trackedFiles = git(rootPath, ["ls-files", "-z"]);
  const dirtyFiles = parseDirtyPaths(status);
  return {
    gitAvailable: true,
    ...(gitHead ? { gitHead } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    dirtyFingerprint: fingerprintDirtyState(rootPath, status, dirtyFiles),
    dirtyFileCount: dirtyFiles.length,
    ...(trackedFiles !== undefined ? { currentFileCount: trackedFiles.split("\0").filter(Boolean).length } : {})
  };
}

function fingerprintFilesystemState(rootPath: string): {
  gitAvailable: false;
  dirtyFingerprint: string;
  dirtyFileCount: 0;
  currentFileCount?: number;
  fallbackTruncated?: boolean;
} {
  const absoluteRoot = path.resolve(rootPath);
  const repoIgnore = createRepoIgnore(absoluteRoot);
  const directories = [""];
  const identities: string[] = [];
  let directoryIndex = 0;
  let visitedDirectories = 0;
  let visitedEntries = 0;
  let fileCount = 0;
  let contentBytesRead = 0;
  let truncated = false;

  while (directoryIndex < directories.length && visitedDirectories < MAX_FALLBACK_DIRECTORIES) {
    const relativeDirectory = directories[directoryIndex++]!;
    const absoluteDirectory = path.join(absoluteRoot, relativeDirectory);
    visitedDirectories += 1;
    identities.push(directoryIdentity(relativeDirectory, absoluteDirectory));

    let directoryRead: { entries: fs.Dirent[]; truncated: boolean };
    try {
      directoryRead = readDirectoryEntriesBounded(
        absoluteDirectory,
        MAX_FALLBACK_ENTRIES - visitedEntries
      );
    } catch {
      identities.push(`${relativeDirectory || "."}\0unreadable-directory`);
      continue;
    }

    const entries = directoryRead.entries;
    if (directoryRead.truncated) truncated = true;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visitedEntries >= MAX_FALLBACK_ENTRIES) {
        truncated = true;
        break;
      }
      visitedEntries += 1;

      const relativePath = path.posix.join(relativeDirectory.replace(/\\/g, "/"), entry.name);
      if (shouldIgnoreFallbackPath(repoIgnore, relativePath, entry.isDirectory())) continue;

      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        if (directories.length >= MAX_FALLBACK_DIRECTORIES) {
          truncated = true;
          continue;
        }
        directories.push(relativePath);
        continue;
      }

      if (fileCount >= MAX_FALLBACK_FILES) {
        truncated = true;
        continue;
      }
      fileCount += 1;
      const identity = filesystemEntryIdentity({
        relativePath,
        absolutePath,
        contentBytesRead
      });
      contentBytesRead = identity.contentBytesRead;
      identities.push(identity.value);
    }

    if (visitedEntries >= MAX_FALLBACK_ENTRIES) break;
  }

  if (directoryIndex < directories.length) truncated = true;
  return {
    gitAvailable: false,
    dirtyFingerprint: sha256([
      "nogit-filesystem-v1",
      truncated ? "truncated" : "complete",
      String(visitedDirectories),
      String(visitedEntries),
      String(fileCount),
      ...identities
    ].join("\0")),
    dirtyFileCount: 0,
    ...(truncated ? { fallbackTruncated: true } : {}),
    ...(!truncated ? { currentFileCount: fileCount } : {})
  };
}

function readDirectoryEntriesBounded(
  absoluteDirectory: string,
  limit: number
): { entries: fs.Dirent[]; truncated: boolean } {
  const directory = fs.opendirSync(absoluteDirectory);
  const entries: fs.Dirent[] = [];
  try {
    while (entries.length < limit) {
      const entry = directory.readSync();
      if (!entry) return { entries, truncated: false };
      entries.push(entry);
    }
    return {
      entries,
      truncated: directory.readSync() !== null
    };
  } finally {
    directory.closeSync();
  }
}

function shouldIgnoreFallbackPath(
  repoIgnore: ReturnType<typeof createRepoIgnore>,
  relativePath: string,
  directory: boolean
): boolean {
  if (directory && FALLBACK_PRUNED_DIRECTORIES.has(path.posix.basename(relativePath))) return true;
  return repoIgnore.ignores(directory ? `${relativePath}/` : relativePath);
}

function directoryIdentity(relativePath: string, absolutePath: string): string {
  try {
    const stat = fs.lstatSync(absolutePath, { bigint: true });
    return `${relativePath || "."}\0directory\0${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return `${relativePath || "."}\0missing-directory`;
  }
}

function filesystemEntryIdentity(input: {
  relativePath: string;
  absolutePath: string;
  contentBytesRead: number;
}): { value: string; contentBytesRead: number } {
  try {
    const stat = fs.lstatSync(input.absolutePath, { bigint: true });
    const metadata = [
      stat.mode.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
      stat.ctimeNs.toString()
    ].join(":");

    if (stat.isSymbolicLink()) {
      return {
        value: `${input.relativePath}\0symlink\0${metadata}\0${fs.readlinkSync(input.absolutePath)}`,
        contentBytesRead: input.contentBytesRead
      };
    }

    const size = Number(stat.size);
    if (
      stat.isFile() &&
      size <= MAX_CONTENT_IDENTITY_BYTES_PER_FILE &&
      input.contentBytesRead + size <= MAX_CONTENT_IDENTITY_BYTES_TOTAL
    ) {
      return {
        value: `${input.relativePath}\0file\0${metadata}\0${sha256(fs.readFileSync(input.absolutePath))}`,
        contentBytesRead: input.contentBytesRead + size
      };
    }

    return {
      value: `${input.relativePath}\0metadata\0${metadata}`,
      contentBytesRead: input.contentBytesRead
    };
  } catch {
    return {
      value: `${input.relativePath}\0missing`,
      contentBytesRead: input.contentBytesRead
    };
  }
}

function fingerprintDirtyState(rootPath: string, status: string, dirtyFiles: string[]): string {
  let contentBytesRead = 0;
  const identities = [...new Set(dirtyFiles)].sort().map((filePath) => {
    const absolutePath = containedPath(rootPath, filePath);
    if (!absolutePath) return `${filePath}\0unsafe`;

    try {
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      const metadata = [
        stat.mode.toString(),
        stat.size.toString(),
        stat.mtimeNs.toString(),
        stat.ctimeNs.toString()
      ].join(":");

      if (stat.isSymbolicLink()) {
        return `${filePath}\0symlink\0${metadata}\0${fs.readlinkSync(absolutePath)}`;
      }

      const size = Number(stat.size);
      if (
        stat.isFile() &&
        size <= MAX_CONTENT_IDENTITY_BYTES_PER_FILE &&
        contentBytesRead + size <= MAX_CONTENT_IDENTITY_BYTES_TOTAL
      ) {
        const contentHash = sha256(fs.readFileSync(absolutePath));
        contentBytesRead += size;
        return `${filePath}\0file\0${metadata}\0${contentHash}`;
      }

      return `${filePath}\0metadata\0${metadata}`;
    } catch {
      return `${filePath}\0missing`;
    }
  });

  return sha256([status, ...identities].join("\0"));
}

function parseDirtyPaths(status: string): string[] {
  const fields = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4) continue;
    const state = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/.test(state)) {
      const originalPath = fields[index + 1];
      if (originalPath) paths.push(originalPath);
      index += 1;
    }
  }
  return paths;
}

function containedPath(rootPath: string, filePath: string): string | undefined {
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, filePath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return undefined;
  return absolutePath;
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
