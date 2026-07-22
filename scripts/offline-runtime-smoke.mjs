#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const blockerPath = path.join(repositoryRoot, "scripts", "deny-network.cjs");
if (!existsSync(cliPath)) throw new Error("dist/cli.js is missing; run pnpm build before the offline smoke test");

const sandbox = mkdtempSync(path.join(os.tmpdir(), "kairn-offline-smoke-"));
const fixture = path.join(sandbox, "repository");
const home = path.join(sandbox, "home");
const attemptLog = path.join(sandbox, "network-attempts.log");
const guardProbeLog = path.join(sandbox, "network-guard-probe.log");

try {
  mkdirSync(path.join(fixture, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(fixture, "package.json"), '{"name":"offline-fixture","private":true}\n');
  writeFileSync(
    path.join(fixture, "src", "handler.ts"),
    "export function handleRequest(value: string): string { return value.trim(); }\n",
  );
  verifyNetworkGuard();

  const primeOutput = runKairn([
    "prime",
    "Find the production request handler",
    "--root",
    fixture,
    "--budget",
    "300",
    "--json",
  ]);
  const sessionId = JSON.parse(primeOutput).session?.id;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("prime output did not include a sessionId");
  runKairn([
    "context",
    "--session",
    sessionId,
    "--root",
    fixture,
    "--query",
    "handleRequest production source",
    "--budget",
    "300",
    "--json",
  ]);

  if (existsSync(attemptLog) && readFileSync(attemptLog, "utf8").trim()) {
    throw new Error(readFileSync(attemptLog, "utf8").trim());
  }
  process.stdout.write("Offline runtime smoke passed: indexing and retrieval completed with Node networking blocked.\n");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function runKairn(args) {
  const result = spawnSync(process.execPath, ["--require", blockerPath, cliPath, ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KAIRN_NETWORK_ATTEMPT_LOG: attemptLog,
      KAIRN_TELEMETRY_ENABLED: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(`kairn ${args[0]} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  if (!result.stdout.trim()) throw new Error(`kairn ${args[0]} returned no output`);
  return result.stdout;
}

function verifyNetworkGuard() {
  const result = spawnSync(process.execPath, [
    "--require",
    blockerPath,
    "--eval",
    'fetch("https://offline-smoke.invalid")',
  ], {
    encoding: "utf8",
    env: { ...process.env, KAIRN_NETWORK_ATTEMPT_LOG: guardProbeLog },
  });
  const probe = existsSync(guardProbeLog) ? readFileSync(guardProbeLog, "utf8") : "";
  if (result.status === 0 || !probe.includes("Blocked outbound network operation")) {
    throw new Error("offline smoke network guard probe did not reject and record a fetch attempt");
  }
}
