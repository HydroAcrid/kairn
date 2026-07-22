#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
if (!existsSync(cliPath)) throw new Error("dist/cli.js is missing; run pnpm build before the setup smoke test");

const sandbox = mkdtempSync(path.join(os.tmpdir(), "kairn-setup-smoke-"));
const fixture = path.join(sandbox, "repository");
const home = path.join(sandbox, "home");

try {
  mkdirSync(path.join(fixture, "src"), { recursive: true });
  mkdirSync(path.join(fixture, ".vscode"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(fixture, "src", "sentinel.ts"), "export const sentinel = true;\n");
  writeFileSync(path.join(fixture, "AGENTS.md"), "# Existing project instructions\n\nKeep this text.\n");
  writeFileSync(path.join(fixture, ".vscode", "settings.json"), '{"editor.tabSize":2}\n');
  writeFileSync(
    path.join(fixture, ".mcp.json"),
    '{"mcpServers":{"unrelated":{"command":"unrelated-tool"}}}\n',
  );
  const baseline = snapshotState();

  const enableArgs = [
    "enable",
    "--root",
    fixture,
    "--agents",
    "codex,claude-code,copilot-cli,gemini-cli,vscode,generic",
    "--yes",
    "--no-index",
    "--json",
  ];
  runKairn(enableArgs);
  const firstEnable = snapshotState();
  runKairn(enableArgs);
  const secondEnable = snapshotState();
  assertEqualSnapshots(firstEnable, secondEnable, "re-running kairn enable changed repository files");

  runKairn(["disable", "--root", fixture, "--json"]);
  const disabled = snapshotState();
  assertEqualSnapshots(
    normalizeConfigurationSnapshot(baseline),
    normalizeConfigurationSnapshot(disabled),
    "kairn disable did not restore the repository configuration baseline",
  );
  process.stdout.write(`Enable/disable smoke passed on ${process.platform}/${process.arch}.\n`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function runKairn(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, KAIRN_TELEMETRY_ENABLED: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`kairn ${args[0]} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
}

function snapshotState() {
  return new Map([
    ...[...snapshotFiles(fixture).entries()].map(([name, value]) => [`repository/${name}`, value]),
    ...[...snapshotFiles(home).entries()].map(([name, value]) => [`home/${name}`, value]),
  ]);
}

function snapshotFiles(root) {
  const snapshot = new Map();
  visit(root);
  return snapshot;

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && statSync(absolute).size <= 1024 * 1024) {
        snapshot.set(path.relative(root, absolute).split(path.sep).join("/"), readFileSync(absolute, "utf8"));
      }
    }
  }
}

function assertEqualSnapshots(expected, actual, message) {
  const expectedValue = JSON.stringify([...expected.entries()]);
  const actualValue = JSON.stringify([...actual.entries()]);
  if (expectedValue !== actualValue) {
    const expectedFiles = [...expected.keys()].join(", ");
    const actualFiles = [...actual.keys()].join(", ");
    throw new Error(`${message}. Expected [${expectedFiles}], received [${actualFiles}]`);
  }
}

function normalizeConfigurationSnapshot(snapshot) {
  return new Map([...snapshot.entries()].map(([name, contents]) => {
    if (!name.endsWith(".json")) return [name, contents];
    return [name, JSON.stringify(sortJson(JSON.parse(contents)))];
  }));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, child]) => [key, sortJson(child)],
    ));
  }
  return value;
}
