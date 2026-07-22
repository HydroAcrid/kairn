#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefixFlag = process.argv.indexOf("--prefix");
const prefix = path.resolve(root, prefixFlag >= 0
  ? process.argv[prefixFlag + 1] ?? ".kairn/tools/codex-0.145.0"
  : ".kairn/tools/codex-0.145.0");
const version = "0.145.0";
const expectedIntegrity = "sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==";

run("npm", [
  "install", "--prefix", prefix, "--package-lock=true", "--save-exact", `@openai/codex@${version}`
]);
const lockPath = path.join(prefix, "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const installed = lock.packages?.["node_modules/@openai/codex"];
if (installed?.version !== version || installed?.integrity !== expectedIntegrity) {
  throw new Error("installed Codex package does not match the sealed version/integrity pin");
}
const executable = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
const check = spawnSync(executable, ["--version"], { cwd: root, encoding: "utf8" });
if (check.status !== 0 || !String(check.stdout).includes(version)) {
  throw new Error(`installed Codex executable did not report ${version}`);
}
process.stdout.write(`${JSON.stringify({
  package: "@openai/codex",
  version,
  integrity: expectedIntegrity,
  executable,
  codexHome: path.join(root, ".kairn", "codex-pilot-home"),
  authSerialized: false
}, null, 2)}\n`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? "unknown"}`);
}
