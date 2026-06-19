#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..", "..");
const args = parseArgs(process.argv.slice(2));
const target = args.target ?? `${process.platform}-${process.arch}`;
const out = path.resolve(args.out ?? path.join(root, ".release", "binaries", target, target.startsWith("win32-") ? "kairn.exe" : "kairn"));
const localTarget = `${process.platform}-${process.arch}`;
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

if (target !== localTarget) {
  fail(`target ${target} must be built on matching host ${localTarget} because Kairn ships native assets`);
}

const pkgTarget = toPkgTarget(target);
const bundleDir = path.join(root, ".release", "pkg-build", target);
const bundlePath = path.join(bundleDir, "cli.cjs");

fs.rmSync(bundleDir, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });
fs.mkdirSync(path.dirname(out), { recursive: true });

run(pnpmCommand, [
  "exec",
  "esbuild",
  "src/cli.ts",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node20",
  `--outfile=${bundlePath}`,
  "--external:better-sqlite3",
  "--external:typescript"
]);

run(pnpmCommand, [
  "dlx",
  "@yao-pkg/pkg@6.20.0",
  bundlePath,
  "--targets",
  pkgTarget,
  "--output",
  out
]);

if (!target.startsWith("win32-")) fs.chmodSync(out, 0o755);
copyRuntimeAssets(path.join(path.dirname(out), "assets"));

console.log(JSON.stringify({ target, out, assets: path.join(path.dirname(out), "assets"), builder: "pkg" }, null, 2));

function copyRuntimeAssets(assetDir) {
  fs.rmSync(assetDir, { recursive: true, force: true });
  fs.mkdirSync(assetDir, { recursive: true });

  copyFile(
    require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
    path.join(assetDir, "web-tree-sitter", "web-tree-sitter.wasm")
  );

  const grammarDir = path.dirname(require.resolve("@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm"));
  const grammarOutDir = path.join(assetDir, "tree-sitter-wasms", "out");
  fs.mkdirSync(grammarOutDir, { recursive: true });
  for (const file of fs.readdirSync(grammarDir)) {
    if (file.endsWith(".wasm")) copyFile(path.join(grammarDir, file), path.join(grammarOutDir, file));
  }

  const sqlitePackageRoot = path.dirname(path.dirname(require.resolve("better-sqlite3")));
  copyFile(
    path.join(sqlitePackageRoot, "build", "Release", "better_sqlite3.node"),
    path.join(assetDir, "better-sqlite3", "better_sqlite3.node")
  );
}

function copyFile(from, to) {
  if (!fs.existsSync(from)) fail(`release asset missing: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function toPkgTarget(targetName) {
  const [platform, arch] = targetName.split("-");
  const pkgPlatform = platform === "darwin" ? "macos" : platform === "win32" ? "win" : platform;
  if (!pkgPlatform || !arch) fail(`invalid target: ${targetName}`);
  return `node24-${pkgPlatform}-${arch}`;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32"
  });
  if (result.error) {
    fail(`failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(" ")} failed with exit ${result.status ?? 1}`);
  }
}

function parseArgs(raw) {
  const parsed = {};
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item?.startsWith("--")) continue;
    const key = item.slice(2);
    const value = raw[i + 1];
    if (!value || value.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(`build-pkg-binary: ${message}`);
  process.exit(1);
}
