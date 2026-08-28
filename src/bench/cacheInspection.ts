// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type BenchmarkCacheFinding = {
  id: string;
  kind: "partial" | "stale_lease" | "orphan_worktree" | "corrupt_run";
  path: string;
  recoverable: true;
  detail: string;
};

export function inspectBenchmarkCache(repositoryRoot: string, now = Date.now()): BenchmarkCacheFinding[] {
  const root = path.resolve(repositoryRoot);
  const artifacts = path.join(root, "artifacts");
  if (!fs.existsSync(artifacts)) return [];
  const findings: BenchmarkCacheFinding[] = [];
  inspectRepositoryIndexSnapshots(root, artifacts, findings);
  walkBounded(artifacts, 4, (target, entry) => {
    const relative = path.relative(root, target).replace(/\\/g, "/");
    if (entry.isFile() && (/\.partial(?:-|$)/.test(entry.name) || entry.name.endsWith(".progress.json"))) {
      let complete = false;
      if (entry.name.endsWith(".progress.json")) {
        try { complete = JSON.parse(fs.readFileSync(target, "utf8")).complete === true; } catch { /* corrupt is incomplete */ }
      }
      if (!complete) findings.push(finding("partial", relative, "Incomplete atomic or resumable artifact."));
    }
    if (entry.isFile() && entry.name.endsWith(".lease.json")) {
      try {
        const lease = JSON.parse(fs.readFileSync(target, "utf8")) as { expiresAt?: string };
        if (!lease.expiresAt || Date.parse(lease.expiresAt) < now) findings.push(finding("stale_lease", relative, "Lease is missing an expiry or has expired."));
      } catch { findings.push(finding("stale_lease", relative, "Lease file is corrupt.")); }
    }
  });
  const worktrees = path.join(artifacts, "ranker-checkouts", "worktrees");
  if (fs.existsSync(worktrees)) {
    for (const entry of fs.readdirSync(worktrees, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(worktrees, entry.name);
      if (!fs.existsSync(path.join(target, ".git"))) {
        findings.push(finding("orphan_worktree", path.relative(root, target).replace(/\\/g, "/"), "Worktree directory has no Git administrative link."));
      }
    }
  }
  const runs = path.join(artifacts, "runs");
  if (fs.existsSync(runs)) {
    for (const campaign of fs.readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const campaignPath = path.join(runs, campaign.name);
      for (const run of fs.readdirSync(campaignPath, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        const runPath = path.join(campaignPath, run.name);
        for (const required of ["run-manifest.json", "artifact-index.json"]) {
          const target = path.join(runPath, required);
          try { JSON.parse(fs.readFileSync(target, "utf8")); }
          catch { findings.push(finding("corrupt_run", path.relative(root, runPath).replace(/\\/g, "/"), `Missing or invalid ${required}.`)); break; }
        }
      }
    }
  }
  return deduplicate(findings);
}

function inspectRepositoryIndexSnapshots(
  repositoryRoot: string,
  artifactsRoot: string,
  findings: BenchmarkCacheFinding[]
): void {
  const snapshotRoot = path.join(artifactsRoot, "ranker-checkouts", "repository-index-snapshots");
  if (!fs.existsSync(snapshotRoot)) return;
  const entries = fs.readdirSync(snapshotRoot, { withFileTypes: true });
  const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const referencedBlobs = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
    const databasePath = path.join(snapshotRoot, entry.name);
    const manifestName = `${entry.name}.manifest.json`;
    if (!names.has(manifestName)) {
      findings.push(finding("partial", relative(repositoryRoot, databasePath), "Repository index snapshot is missing its manifest."));
      continue;
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sqlite.manifest.json")) continue;
    const databaseName = entry.name.slice(0, -".manifest.json".length);
    const manifestPath = path.join(snapshotRoot, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        formatVersion?: number;
        databaseSha256?: string;
        databaseBlobPath?: string;
        databaseBytes?: number;
        cacheKey?: string;
      };
      const expectedKey = databaseName.slice(0, -".sqlite".length);
      if (manifest.cacheKey !== expectedKey || (manifest.formatVersion !== 1 && manifest.formatVersion !== 2)) {
        throw new Error("identity mismatch");
      }
      let databasePath: string;
      if (manifest.formatVersion === 1) {
        databasePath = path.join(snapshotRoot, databaseName);
        if (!names.has(databaseName)) throw new Error("legacy database is missing");
      } else {
        if (!manifest.databaseBlobPath || path.isAbsolute(manifest.databaseBlobPath)) {
          throw new Error("content blob path is invalid");
        }
        const cacheRoot = path.join(artifactsRoot, "ranker-checkouts");
        const blobRoot = path.resolve(cacheRoot, "content-blobs", "sha256");
        databasePath = path.resolve(cacheRoot, manifest.databaseBlobPath);
        if (!databasePath.startsWith(`${blobRoot}${path.sep}`)) throw new Error("content blob escapes cache");
        referencedBlobs.add(databasePath);
      }
      if (!fs.existsSync(databasePath)) throw new Error("database is missing");
      if (manifest.formatVersion === 2 && manifest.databaseBytes !== fs.statSync(databasePath).size) {
        throw new Error("database size mismatch");
      }
      const hash = crypto.createHash("sha256").update(fs.readFileSync(databasePath)).digest("hex");
      if (manifest.databaseSha256 !== hash) throw new Error("checksum mismatch");
    } catch {
      findings.push(finding("partial", relative(repositoryRoot, manifestPath), "Repository index snapshot manifest, database, or checksum is invalid."));
    }
  }
  const blobRoot = path.join(artifactsRoot, "ranker-checkouts", "content-blobs", "sha256");
  if (fs.existsSync(blobRoot)) {
    for (const entry of fs.readdirSync(blobRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
      const blobPath = path.resolve(blobRoot, entry.name);
      if (!referencedBlobs.has(blobPath)) {
        findings.push(finding("partial", relative(repositoryRoot, blobPath), "Content-addressed repository snapshot has no manifest reference."));
      }
    }
  }
}

export function quarantineBenchmarkCacheFinding(repositoryRoot: string, finding: BenchmarkCacheFinding): string {
  const root = path.resolve(repositoryRoot);
  const artifactsRoot = path.join(root, "artifacts");
  const source = path.resolve(root, finding.path);
  assertWithin(artifactsRoot, source);
  if (!fs.existsSync(source)) throw new Error(`cache finding no longer exists: ${finding.path}`);
  const quarantineRoot = path.join(artifactsRoot, "cache-quarantine");
  fs.mkdirSync(quarantineRoot, { recursive: true });
  const target = path.join(quarantineRoot, `${Date.now()}-${path.basename(source)}`);
  assertWithin(quarantineRoot, target);
  fs.renameSync(source, target);
  return target;
}

function walkBounded(root: string, maxDepth: number, visit: (target: string, entry: fs.Dirent) => void, depth = 0): void {
  if (depth > maxDepth) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name); visit(target, entry);
    if (entry.isDirectory() && entry.name !== "ranker-checkouts" && entry.name !== ".git") walkBounded(target, maxDepth, visit, depth + 1);
  }
}
function finding(kind: BenchmarkCacheFinding["kind"], relativePath: string, detail: string): BenchmarkCacheFinding { return { id: `${kind}:${relativePath}`, kind, path: relativePath, recoverable: true, detail }; }
function deduplicate(findings: BenchmarkCacheFinding[]): BenchmarkCacheFinding[] { return [...new Map(findings.map((item) => [item.id, item])).values()].sort((left, right) => left.id.localeCompare(right.id)); }
function relative(root: string, target: string): string { return path.relative(root, target).replace(/\\/g, "/"); }
function assertWithin(root: string, target: string): void { const normalizedRoot = path.resolve(root); const normalizedTarget = path.resolve(target); if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) throw new Error("cache target escapes artifacts root"); }
