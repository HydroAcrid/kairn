#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
const npmEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
  "npm_config_verify_deps_before_run",
  "npm_config_npm_globalconfig",
  "npm_config__jsr_registry",
].includes(key.toLowerCase())));
const report = JSON.parse(reportPath
  ? readFileSync(reportPath, "utf8")
  : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: npmEnvironment,
    }));
const files = new Set((report[0]?.files ?? []).map((entry) => entry.path));
const required = [
  "dist/cli.js",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "benchmarks/anthropic_messages_host.py",
  "benchmarks/evidence-training.sample.jsonl",
  "scripts/train-evidence-ranker.py",
  "scripts/evidence-artifact-checksum.mjs",
];
const missing = required.filter((file) => !files.has(file));
const forbidden = [...files].filter((file) =>
  /(?:^|\/)(?:\.env(?:\..*)?|\.kairn|__pycache__)(?:\/|$)/u.test(file)
  || /\.pyc$/iu.test(file),
);

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) process.stderr.write(`Required npm package files missing: ${missing.join(", ")}\n`);
  if (forbidden.length > 0) process.stderr.write(`Forbidden npm package files present: ${forbidden.join(", ")}\n`);
  process.exit(1);
}

process.stdout.write(`npm package contents verified (${files.size} files, ${required.length} required integrity files).\n`);
