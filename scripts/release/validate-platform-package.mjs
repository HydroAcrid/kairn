#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const packageDir = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
const isWindows = pkg.os?.includes("win32");
const binaryPath = path.join(packageDir, "bin", isWindows ? "kairn.exe" : "kairn");
const checksumPath = path.join(packageDir, "checksums.txt");
const requiredAssets = [
  path.join(packageDir, "bin", "assets", "better-sqlite3", "better_sqlite3.node"),
  path.join(packageDir, "bin", "assets", "web-tree-sitter", "web-tree-sitter.wasm"),
  path.join(packageDir, "bin", "assets", "tree-sitter-wasms", "out", "tree-sitter-typescript.wasm")
];

const failures = [];
if (!fs.existsSync(binaryPath)) failures.push(`missing binary ${path.relative(packageDir, binaryPath)}`);
if (!fs.existsSync(checksumPath)) failures.push("missing checksums.txt");
for (const asset of requiredAssets) {
  if (!fs.existsSync(asset)) failures.push(`missing runtime asset ${path.relative(packageDir, asset)}`);
}

if (fs.existsSync(binaryPath)) {
  const mode = fs.statSync(binaryPath).mode;
  if (!isWindows && (mode & 0o111) === 0) failures.push("binary must be executable");
}

if (fs.existsSync(checksumPath)) {
  for (const line of fs.readFileSync(checksumPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) {
      failures.push(`invalid checksum line: ${line}`);
      continue;
    }
    const [, expected, relativePath] = match;
    const file = path.join(packageDir, relativePath);
    if (!fs.existsSync(file)) {
      failures.push(`checksum references missing file ${relativePath}`);
      continue;
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== expected) failures.push(`checksum mismatch for ${relativePath}`);
  }
}

if (failures.length > 0) {
  console.error(`${pkg.name} is not publishable:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`${pkg.name} package validation passed.`);
