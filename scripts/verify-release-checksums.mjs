#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(repositoryRoot, "scripts", "generate-release-checksums.mjs");
const sandbox = mkdtempSync(path.join(os.tmpdir(), "kairn-release-checksum-smoke-"));

try {
  const payload = path.join(sandbox, "candidate.tgz");
  writeFileSync(payload, "deterministic candidate bytes\n", "utf8");
  run([]);
  run(["--check"]);

  const manifest = JSON.parse(readFileSync(path.join(sandbox, "release-integrity.json"), "utf8"));
  if (manifest.files.length !== 1 || manifest.files[0].path !== "candidate.tgz") {
    throw new Error("release integrity manifest did not describe the exact candidate payload");
  }

  writeFileSync(payload, "tampered candidate bytes\n", "utf8");
  const tamperCheck = invoke(["--check"]);
  if (tamperCheck.status === 0) throw new Error("release checksum verification accepted a modified payload");
  process.stdout.write("Release checksum generation, verification, and tamper detection passed.\n");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function invoke(extraArgs) {
  return spawnSync(process.execPath, [generator, "--root", sandbox, ...extraArgs], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, GITHUB_SHA: "0000000000000000000000000000000000000000" },
  });
}

function run(extraArgs) {
  const result = invoke(extraArgs);
  if (result.status !== 0) {
    throw new Error(`release checksum command failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
}
