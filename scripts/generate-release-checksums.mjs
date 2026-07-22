#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(valueAfter("--root") ?? path.join(repositoryRoot, "artifacts", "release"));
const checksumsPath = path.resolve(valueAfter("--checksums") ?? path.join(root, "SHA256SUMS"));
const manifestPath = path.resolve(valueAfter("--manifest") ?? path.join(root, "release-integrity.json"));
const check = process.argv.includes("--check");
assertInside(root, checksumsPath);
assertInside(root, manifestPath);

const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const lockfile = readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"));
const excluded = new Set([relative(checksumsPath), relative(manifestPath)]);
const payload = listFiles(root)
  .filter((file) => !excluded.has(file))
  .map((file) => ({ path: file, sha256: digest(path.join(root, file)), bytes: statSync(path.join(root, file)).size }));
if (payload.length === 0) throw new Error(`release root contains no payload files: ${root}`);
const manifest = {
  schemaVersion: 1,
  package: { name: packageJson.name, version: packageJson.version },
  sourceCommit: process.env.GITHUB_SHA || currentCommit(),
  lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  files: payload,
};
const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
const checksumContents = [
  ...payload.map((entry) => `${entry.sha256}  ${entry.path}`),
  `${createHash("sha256").update(manifestContents).digest("hex")}  ${relative(manifestPath)}`,
].sort().join("\n") + "\n";

if (check) {
  assertExact(manifestPath, manifestContents);
  assertExact(checksumsPath, checksumContents);
  process.stdout.write(`Verified ${payload.length} release payload files and the integrity manifest.\n`);
} else {
  mkdirSync(root, { recursive: true });
  writeFileSync(manifestPath, manifestContents, "utf8");
  writeFileSync(checksumsPath, checksumContents, "utf8");
  process.stdout.write(`Wrote ${relative(manifestPath)} and ${relative(checksumsPath)} for ${payload.length} files.\n`);
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  visit(directory);
  return files.sort((left, right) => left.localeCompare(right));

  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(absolute));
    }
  }
}

function digest(target) {
  return createHash("sha256").update(readFileSync(target)).digest("hex");
}

function relative(target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function assertInside(directory, target) {
  const relation = path.relative(directory, target);
  if (!relation || (!relation.startsWith("..") && !path.isAbsolute(relation))) return;
  throw new Error(`${target} must be inside release root ${directory}`);
}

function assertExact(target, expected) {
  if (!existsSync(target) || readFileSync(target, "utf8").replace(/\r\n/gu, "\n") !== expected) {
    throw new Error(`${relative(target)} is missing, stale, or does not match the release payload`);
  }
}
