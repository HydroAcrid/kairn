// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BENCHMARK_CACHE_MAX_BYTES = 8 * 1024 ** 3;
export const DEFAULT_BENCHMARK_CACHE_TARGET_RATIO = 0.8;
export const DEFAULT_BENCHMARK_CACHE_WARNING_RATIO = 0.8;
export const DEFAULT_BENCHMARK_CACHE_MIN_FREE_BYTES = 2 * 1024 ** 3;

export type BenchmarkCacheEntryKind =
  | "repository"
  | "repository_index_snapshot"
  | "semantic_embedding_snapshot"
  | "semantic_embedding_lineage";

export type BenchmarkCachePolicy = {
  schemaVersion: "benchmark-cache-policy.v1";
  maxBytes: number;
  targetBytes: number;
  warningBytes: number;
  minimumFreeBytes: number;
};

type BenchmarkCacheLease = {
  token: string;
  expiresAt: string;
};

export type BenchmarkCacheLedgerEntry = {
  id: string;
  kind: BenchmarkCacheEntryKind;
  paths: string[];
  bytes: number;
  createdAt: string;
  lastAccessedAt: string;
  contentSha256?: string;
  lease?: BenchmarkCacheLease;
};

type BenchmarkCacheLedger = {
  schemaVersion: "benchmark-cache-ledger.v1";
  entries: BenchmarkCacheLedgerEntry[];
};

export type BenchmarkCacheStatus = {
  schemaVersion: "benchmark-cache-status.v1";
  cacheRoot: string;
  totalBytes: number;
  managedBytes: number;
  unmanagedBytes: number;
  protectedBytes: number;
  entryCount: number;
  duplicateBytesSaved: number;
  maxBytes: number;
  targetBytes: number;
  warningBytes: number;
  warning: boolean;
  overLimit: boolean;
  entries: BenchmarkCacheLedgerEntry[];
};

export type BenchmarkCacheEviction = {
  id: string;
  kind: BenchmarkCacheEntryKind;
  bytesFreed: number;
  pathsRemoved: string[];
};

const LEDGER_NAME = "cache-ledger.v1.json";
const LOCK_NAME = "cache-retention.lease.json";
const LOCK_TTL_MS = 5 * 60_000;

export function benchmarkCachePolicy(environment: NodeJS.ProcessEnv = process.env): BenchmarkCachePolicy {
  const maxBytes = parsePositiveByteOverride(
    environment.KAIRN_BENCHMARK_CACHE_MAX_BYTES,
    "KAIRN_BENCHMARK_CACHE_MAX_BYTES"
  ) ?? DEFAULT_BENCHMARK_CACHE_MAX_BYTES;
  const targetRatio = parseRatioOverride(
    environment.KAIRN_BENCHMARK_CACHE_TARGET_RATIO,
    "KAIRN_BENCHMARK_CACHE_TARGET_RATIO"
  ) ?? DEFAULT_BENCHMARK_CACHE_TARGET_RATIO;
  const warningRatio = parseRatioOverride(
    environment.KAIRN_BENCHMARK_CACHE_WARNING_RATIO,
    "KAIRN_BENCHMARK_CACHE_WARNING_RATIO"
  ) ?? DEFAULT_BENCHMARK_CACHE_WARNING_RATIO;
  const minimumFreeBytes = parsePositiveByteOverride(
    environment.KAIRN_BENCHMARK_CACHE_MIN_FREE_BYTES,
    "KAIRN_BENCHMARK_CACHE_MIN_FREE_BYTES"
  ) ?? DEFAULT_BENCHMARK_CACHE_MIN_FREE_BYTES;
  return {
    schemaVersion: "benchmark-cache-policy.v1",
    maxBytes,
    targetBytes: Math.floor(maxBytes * targetRatio),
    warningBytes: Math.floor(maxBytes * warningRatio),
    minimumFreeBytes
  };
}

export function benchmarkCacheRootForPath(cachePath: string): string {
  const recognized = new Set([
    "repository-index-snapshots",
    "semantic-embedding-cache",
    "semantic-embedding-lineage-cache",
    "repositories"
  ]);
  const directParent = path.resolve(path.dirname(cachePath));
  let current = directParent;
  while (true) {
    if (recognized.has(path.basename(current))) return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) {
      // Standalone fixture and library callers may provide one flat cache
      // directory rather than the production ranker-checkouts hierarchy.
      return directParent;
    }
    current = parent;
  }
}

export function registerBenchmarkCacheEntry(
  cacheRoot: string,
  input: {
    id: string;
    kind: BenchmarkCacheEntryKind;
    paths: string[];
    contentSha256?: string;
  },
  now = new Date()
): BenchmarkCacheLedgerEntry {
  return withCacheLock(cacheRoot, () => {
    const ledger = readAndReconcileLedger(cacheRoot, now);
    const normalizedPaths = [...new Set(input.paths.map((target) => relativeCachePath(cacheRoot, target)))].sort();
    if (normalizedPaths.length === 0) throw new Error("cache entry must own at least one path");
    for (const relative of normalizedPaths) {
      if (!fs.existsSync(resolveCachePath(cacheRoot, relative))) {
        throw new Error(`cache entry path does not exist: ${relative}`);
      }
    }
    const previous = ledger.entries.find((entry) => entry.id === input.id);
    const timestamp = now.toISOString();
    const entry: BenchmarkCacheLedgerEntry = {
      id: input.id,
      kind: input.kind,
      paths: normalizedPaths,
      bytes: uniquePathBytes(cacheRoot, normalizedPaths),
      createdAt: previous?.createdAt ?? timestamp,
      lastAccessedAt: timestamp,
      ...(input.contentSha256 ? { contentSha256: input.contentSha256 } : {}),
      ...(previous?.lease && Date.parse(previous.lease.expiresAt) > now.getTime()
        ? { lease: previous.lease }
        : {})
    };
    ledger.entries = [...ledger.entries.filter((item) => item.id !== input.id), entry]
      .sort((left, right) => left.id.localeCompare(right.id));
    writeLedger(cacheRoot, ledger);
    return entry;
  });
}

export function touchBenchmarkCacheEntry(cacheRoot: string, id: string, now = new Date()): void {
  withCacheLock(cacheRoot, () => {
    const ledger = readAndReconcileLedger(cacheRoot, now);
    const entry = ledger.entries.find((item) => item.id === id);
    if (!entry) return;
    entry.lastAccessedAt = now.toISOString();
    writeLedger(cacheRoot, ledger);
  });
}

export function leaseBenchmarkCacheEntry(
  cacheRoot: string,
  id: string,
  ttlMs = 60 * 60_000,
  now = new Date()
): { token: string; release: () => void } {
  const token = crypto.randomUUID();
  withCacheLock(cacheRoot, () => {
    const ledger = readAndReconcileLedger(cacheRoot, now);
    const entry = ledger.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`cannot lease unknown cache entry '${id}'`);
    entry.lastAccessedAt = now.toISOString();
    entry.lease = { token, expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    writeLedger(cacheRoot, ledger);
  });
  let released = false;
  return {
    token,
    release: () => {
      if (released) return;
      released = true;
      withCacheLock(cacheRoot, () => {
        const ledger = readAndReconcileLedger(cacheRoot, new Date());
        const entry = ledger.entries.find((item) => item.id === id);
        if (entry?.lease?.token === token) delete entry.lease;
        writeLedger(cacheRoot, ledger);
      });
    }
  };
}

export function inspectBenchmarkCacheRetention(
  cacheRoot: string,
  policy = benchmarkCachePolicy(),
  now = new Date()
): BenchmarkCacheStatus {
  fs.mkdirSync(cacheRoot, { recursive: true });
  return withCacheLock(cacheRoot, () => {
    const ledger = readAndReconcileLedger(cacheRoot, now);
    writeLedger(cacheRoot, ledger);
    return buildStatus(cacheRoot, ledger, policy, now);
  });
}

export function enforceBenchmarkCacheRetention(
  cacheRoot: string,
  options: { policy?: BenchmarkCachePolicy; additionalBytes?: number; now?: Date } = {}
): { status: BenchmarkCacheStatus; evictions: BenchmarkCacheEviction[] } {
  const policy = options.policy ?? benchmarkCachePolicy();
  const additionalBytes = options.additionalBytes ?? 0;
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
    throw new Error("additional cache bytes must be a non-negative safe integer");
  }
  if (additionalBytes > policy.maxBytes) {
    throw new Error(
      `single cache entry (${formatBytes(additionalBytes)}) exceeds the ${formatBytes(policy.maxBytes)} cache limit`
    );
  }
  const now = options.now ?? new Date();
  fs.mkdirSync(cacheRoot, { recursive: true });
  return withCacheLock(cacheRoot, () => {
    const ledger = readAndReconcileLedger(cacheRoot, now);
    const evictions: BenchmarkCacheEviction[] = [];
    let status = buildStatus(cacheRoot, ledger, policy, now);
    const requiredLimit = additionalBytes > 0
      ? Math.min(policy.targetBytes, policy.maxBytes - additionalBytes)
      : policy.targetBytes;
    const mustPrune = status.totalBytes + additionalBytes > policy.maxBytes;
    if (mustPrune) {
      const candidates = ledger.entries
        .filter((entry) => !isLeaseActive(entry, now))
        .sort((left, right) =>
          Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt) ||
          left.id.localeCompare(right.id)
        );
      for (const entry of candidates) {
        if (status.totalBytes <= requiredLimit) break;
        const remaining = ledger.entries.filter((item) => item.id !== entry.id);
        const referenced = new Set(remaining.flatMap((item) => item.paths));
        const removed: string[] = [];
        let bytesFreed = 0;
        for (const relative of [...entry.paths].sort((left, right) => right.length - left.length)) {
          if (referenced.has(relative)) continue;
          const target = resolveCachePath(cacheRoot, relative);
          if (!fs.existsSync(target)) continue;
          bytesFreed += fileTreeBytes(target);
          fs.rmSync(target, { recursive: true, force: true });
          removed.push(relative);
        }
        ledger.entries = remaining;
        evictions.push({ id: entry.id, kind: entry.kind, bytesFreed, pathsRemoved: removed.sort() });
        status = buildStatus(cacheRoot, ledger, policy, now);
      }
    }
    writeLedger(cacheRoot, ledger);
    status = buildStatus(cacheRoot, ledger, policy, now);
    if (status.totalBytes + additionalBytes > policy.maxBytes) {
      throw new Error(
        `benchmark cache cannot satisfy its ${formatBytes(policy.maxBytes)} limit: ` +
        `${formatBytes(status.totalBytes)} retained, ${formatBytes(additionalBytes)} requested, ` +
        `${formatBytes(status.protectedBytes)} protected, ${formatBytes(status.unmanagedBytes)} unmanaged`
      );
    }
    return { status, evictions };
  });
}

export function benchmarkCachePreflight(
  cacheRoot: string,
  policy = benchmarkCachePolicy()
): { status: BenchmarkCacheStatus; availableBytes: number; warning?: string } {
  const { status } = enforceBenchmarkCacheRetention(cacheRoot, { policy });
  const statfs = fs.statfsSync(cacheRoot);
  const availableBytes = Number(statfs.bavail) * Number(statfs.bsize);
  if (availableBytes < policy.minimumFreeBytes) {
    throw new Error(
      `benchmark cache preflight requires ${formatBytes(policy.minimumFreeBytes)} free; ` +
      `${formatBytes(availableBytes)} is available`
    );
  }
  const warning = status.warning
    ? `benchmark cache is ${formatBytes(status.totalBytes)} of ${formatBytes(policy.maxBytes)}; ` +
      `LRU eviction begins before another entry can exceed the limit`
    : undefined;
  return { status, availableBytes, ...(warning ? { warning } : {}) };
}

function buildStatus(
  cacheRoot: string,
  ledger: BenchmarkCacheLedger,
  policy: BenchmarkCachePolicy,
  now: Date
): BenchmarkCacheStatus {
  const totalBytes = fileTreeBytes(cacheRoot, new Set([LOCK_NAME]));
  const uniqueManagedPaths = [...new Set(ledger.entries.flatMap((entry) => entry.paths))];
  const managedBytes = uniquePathBytes(cacheRoot, uniqueManagedPaths);
  const logicalBytes = ledger.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const protectedPaths = [...new Set(
    ledger.entries.filter((entry) => isLeaseActive(entry, now)).flatMap((entry) => entry.paths)
  )];
  const protectedBytes = uniquePathBytes(cacheRoot, protectedPaths);
  return {
    schemaVersion: "benchmark-cache-status.v1",
    cacheRoot: path.resolve(cacheRoot),
    totalBytes,
    managedBytes,
    unmanagedBytes: Math.max(0, totalBytes - managedBytes),
    protectedBytes,
    entryCount: ledger.entries.length,
    duplicateBytesSaved: Math.max(0, logicalBytes - managedBytes),
    maxBytes: policy.maxBytes,
    targetBytes: policy.targetBytes,
    warningBytes: policy.warningBytes,
    warning: totalBytes >= policy.warningBytes,
    overLimit: totalBytes > policy.maxBytes,
    entries: ledger.entries.map((entry) => ({ ...entry, paths: [...entry.paths] }))
  };
}

function readAndReconcileLedger(cacheRoot: string, now: Date): BenchmarkCacheLedger {
  const ledgerPath = path.join(cacheRoot, LEDGER_NAME);
  let ledger: BenchmarkCacheLedger = { schemaVersion: "benchmark-cache-ledger.v1", entries: [] };
  if (fs.existsSync(ledgerPath)) {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Partial<BenchmarkCacheLedger>;
    if (parsed.schemaVersion !== "benchmark-cache-ledger.v1" || !Array.isArray(parsed.entries)) {
      throw new Error(`benchmark cache ledger has an unsupported schema: ${ledgerPath}`);
    }
    ledger = { schemaVersion: "benchmark-cache-ledger.v1", entries: parsed.entries };
  }
  ledger.entries = ledger.entries.flatMap((entry) => {
    if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.paths)) {
      throw new Error(`benchmark cache ledger contains an invalid entry: ${ledgerPath}`);
    }
    const paths = [...new Set(entry.paths.map((relative) => {
      if (typeof relative !== "string") throw new Error(`benchmark cache ledger path is invalid: ${ledgerPath}`);
      resolveCachePath(cacheRoot, relative);
      return relative;
    }))].sort();
    if (paths.length === 0 || paths.every((relative) => !fs.existsSync(resolveCachePath(cacheRoot, relative)))) {
      return [];
    }
    const lease = entry.lease && Date.parse(entry.lease.expiresAt) > now.getTime()
      ? entry.lease
      : undefined;
    const reconciled: BenchmarkCacheLedgerEntry = {
      ...entry,
      paths,
      bytes: uniquePathBytes(cacheRoot, paths)
    };
    if (lease) reconciled.lease = lease;
    else delete reconciled.lease;
    return [reconciled];
  });
  discoverUnregisteredCacheEntries(cacheRoot, ledger);
  return ledger;
}

function discoverUnregisteredCacheEntries(cacheRoot: string, ledger: BenchmarkCacheLedger): void {
  const knownIds = new Set(ledger.entries.map((entry) => entry.id));
  const referencedBlobs = new Set<string>();
  const add = (
    id: string,
    kind: BenchmarkCacheEntryKind,
    targets: string[],
    contentSha256?: string
  ): void => {
    if (knownIds.has(id) || targets.some((target) => !fs.existsSync(target))) return;
    const paths = targets.map((target) => relativeCachePath(cacheRoot, target)).sort();
    const timestamp = new Date(Math.max(...targets.map((target) => fs.statSync(target).mtimeMs))).toISOString();
    ledger.entries.push({
      id,
      kind,
      paths,
      bytes: uniquePathBytes(cacheRoot, paths),
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      ...(contentSha256 ? { contentSha256 } : {})
    });
    knownIds.add(id);
  };

  const repositories = path.join(cacheRoot, "repositories");
  if (fs.existsSync(repositories)) {
    for (const entry of fs.readdirSync(repositories, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".git") || entry.name.includes(".tmp-")) continue;
      add(`repository:${entry.name.slice(0, -4)}`, "repository", [path.join(repositories, entry.name)]);
    }
  }

  for (const [directoryName, kind, prefix] of [
    ["semantic-embedding-cache", "semantic_embedding_snapshot", "semantic_embedding_snapshot"],
    ["semantic-embedding-lineage-cache", "semantic_embedding_lineage", "semantic_embedding_lineage"]
  ] as const) {
    const directory = path.join(cacheRoot, directoryName);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".tmp-")) continue;
      const target = path.join(directory, entry.name);
      add(`${prefix}:${entry.name.slice(0, -5)}`, kind, [target]);
    }
  }

  const snapshots = path.join(cacheRoot, "repository-index-snapshots");
  if (fs.existsSync(snapshots)) {
    for (const entry of fs.readdirSync(snapshots, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sqlite.manifest.json")) continue;
      const manifestPath = path.join(snapshots, entry.name);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          formatVersion?: number;
          cacheKey?: string;
          databaseSha256?: string;
          databaseBlobPath?: string;
        };
        if (
          (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) ||
          !manifest.cacheKey ||
          !manifest.databaseSha256
        ) continue;
        const databasePath = manifest.formatVersion === 2 && manifest.databaseBlobPath
          ? resolveDiscoveredBlobPath(cacheRoot, manifest.databaseBlobPath)
          : path.join(snapshots, `${manifest.cacheKey}.sqlite`);
        if (manifest.formatVersion === 2) referencedBlobs.add(databasePath);
        add(
          `repository_index_snapshot:${manifest.cacheKey}`,
          "repository_index_snapshot",
          [manifestPath, databasePath],
          manifest.databaseSha256
        );
      } catch {
        // Corrupt manifests stay unmanaged so inspection reports them and
        // retention fails closed rather than deleting ambiguous data.
      }
    }
  }

  const blobs = path.join(cacheRoot, "content-blobs", "sha256");
  if (fs.existsSync(blobs)) {
    for (const entry of fs.readdirSync(blobs, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sqlite") || entry.name.startsWith(".snapshot-")) continue;
      const target = path.resolve(blobs, entry.name);
      if (referencedBlobs.has(target)) continue;
      add(
        `orphan_repository_index_blob:${entry.name}`,
        "repository_index_snapshot",
        [target],
        entry.name.slice(0, -".sqlite".length)
      );
    }
  }
  ledger.entries.sort((left, right) => left.id.localeCompare(right.id));
}

function resolveDiscoveredBlobPath(cacheRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error("snapshot blob path must be relative");
  const root = path.resolve(cacheRoot);
  const blobRoot = path.resolve(root, "content-blobs", "sha256");
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${blobRoot}${path.sep}`)) throw new Error("snapshot blob escapes cache root");
  return target;
}

function writeLedger(cacheRoot: string, ledger: BenchmarkCacheLedger): void {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, LEDGER_NAME);
  const staged = `${target}.tmp-${crypto.randomUUID()}`;
  const backup = `${target}.backup-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(staged, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (!fs.existsSync(target)) {
      fs.renameSync(staged, target);
    } else {
      fs.renameSync(target, backup);
      try {
        fs.renameSync(staged, target);
        fs.rmSync(backup, { force: true });
      } catch (error) {
        if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
        throw error;
      }
    }
  } finally {
    fs.rmSync(staged, { force: true });
    fs.rmSync(backup, { force: true });
  }
}

function withCacheLock<T>(cacheRoot: string, operation: () => T): T {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const lockPath = path.join(cacheRoot, LOCK_NAME);
  const acquire = (): void => {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: "benchmark-cache-retention-lease.v1",
        pid: process.pid,
        expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString()
      })}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      let stale = false;
      try {
        const existing = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { expiresAt?: string };
        stale = !existing.expiresAt || Date.parse(existing.expiresAt) <= Date.now();
      } catch {
        stale = true;
      }
      if (!stale) throw new Error(`benchmark cache is locked by an active retention operation: ${lockPath}`);
      fs.rmSync(lockPath, { force: true });
      fs.writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: "benchmark-cache-retention-lease.v1",
        pid: process.pid,
        expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString()
      })}\n`, { encoding: "utf8", flag: "wx" });
    }
  };
  acquire();
  try {
    return operation();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function relativeCachePath(cacheRoot: string, target: string): string {
  const root = path.resolve(cacheRoot);
  const absolute = path.resolve(target);
  assertWithin(root, absolute);
  if (absolute === root) throw new Error("cache entry cannot own the cache root");
  return path.relative(root, absolute).replace(/\\/g, "/");
}

function resolveCachePath(cacheRoot: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`cache path must be relative: ${relative}`);
  const root = path.resolve(cacheRoot);
  const target = path.resolve(root, relative);
  assertWithin(root, target);
  return target;
}

function assertWithin(root: string, target: string): void {
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("cache target escapes benchmark cache root");
  }
}

function uniquePathBytes(cacheRoot: string, paths: string[]): number {
  const normalized = [...paths]
    .map((relative) => ({ relative, target: resolveCachePath(cacheRoot, relative) }))
    .filter((item) => fs.existsSync(item.target))
    .sort((left, right) => left.target.length - right.target.length);
  const roots: string[] = [];
  for (const item of normalized) {
    if (roots.some((root) => item.target === root || item.target.startsWith(`${root}${path.sep}`))) continue;
    roots.push(item.target);
  }
  return roots.reduce((sum, target) => sum + fileTreeBytes(target), 0);
}

function fileTreeBytes(target: string, ignoredNames = new Set<string>()): number {
  if (!fs.existsSync(target)) return 0;
  const stats = fs.lstatSync(target);
  if (!stats.isDirectory()) return stats.size;
  let total = stats.size;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    total += entry.isDirectory() && !entry.isSymbolicLink()
      ? fileTreeBytes(child)
      : fs.lstatSync(child).size;
  }
  return total;
}

function isLeaseActive(entry: BenchmarkCacheLedgerEntry, now: Date): boolean {
  return Boolean(entry.lease && Date.parse(entry.lease.expiresAt) > now.getTime());
}

function parsePositiveByteOverride(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive byte count`);
  return parsed;
}

function parseRatioOverride(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error(`${label} must be between 0 and 1`);
  return parsed;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

export function formatBenchmarkCacheBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatBytes(bytes: number): string {
  return formatBenchmarkCacheBytes(bytes);
}
