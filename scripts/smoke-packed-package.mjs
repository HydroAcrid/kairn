#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packageRoot = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-packed-package-"));
const installRoot = path.join(smokeRoot, "consumer");
const repoRoot = path.join(smokeRoot, "repository");
const isolatedHome = path.join(smokeRoot, "home");
fs.mkdirSync(installRoot, { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });
fs.mkdirSync(isolatedHome, { recursive: true });
fs.writeFileSync(path.join(installRoot, "package.json"), "{\"private\":true}\n", "utf8");
fs.writeFileSync(path.join(repoRoot, "package.json"), "{\"private\":true}\n", "utf8");
fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
fs.writeFileSync(path.join(repoRoot, "src", "app.ts"), "export const ready = true;\n", "utf8");

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pack = run(npmCommand, ["pack", "--json", "--pack-destination", smokeRoot], packageRoot);
const packRows = JSON.parse(pack.stdout);
const tarballName = packRows[0]?.filename;
if (!tarballName) fail("npm pack did not report a tarball filename.");
const tarballPath = path.join(smokeRoot, tarballName);

run(npmCommand, ["install", "--no-audit", "--no-fund", tarballPath], installRoot);
const kairnCommand = path.join(
  installRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "kairn.cmd" : "kairn"
);
const environment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  KAIRN_DISABLE_BACKGROUND_INDEX: "1"
};
const version = run(kairnCommand, ["--version"], installRoot, environment).stdout.trim();
if (version !== packageJson.version) {
  fail(`Packed CLI version mismatch: expected ${packageJson.version}, received ${version}.`);
}

const dryRun = JSON.parse(run(kairnCommand, [
  "enable",
  "--root", repoRoot,
  "--agents", "generic",
  "--dry-run",
  "--offline",
  "--json"
], installRoot, environment).stdout);
if (!dryRun.dryRun || dryRun.semanticPreview || fs.existsSync(path.join(repoRoot, ".kairn"))) {
  fail("Packed CLI dry run was not read-only or did not use the deterministic default.");
}

const enabled = JSON.parse(run(kairnCommand, [
  "enable",
  "--root", repoRoot,
  "--agents", "generic",
  "--yes",
  "--no-index",
  "--offline",
  "--json"
], installRoot, environment).stdout);
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".kairn", "config.json"), "utf8"));
if (enabled.semanticModelInstalled || config.semantic?.mode !== "legacy") {
  fail("Packed CLI attempted semantic installation or did not persist the deterministic default.");
}

run(kairnCommand, ["disable", "--root", repoRoot, "--delete-state", "--json"], installRoot, environment);
if (fs.existsSync(path.join(repoRoot, ".kairn"))) {
  fail("Packed CLI disable did not remove Kairn state.");
}

process.stdout.write(`Packed usekairn@${packageJson.version} install/enable/disable smoke passed.\n`);

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    fail([
      `Command failed (${result.status}): ${command} ${args.join(" ")}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
