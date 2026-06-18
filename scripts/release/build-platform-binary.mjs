#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..", "..");
const args = parseArgs(process.argv.slice(2));
const target = args.target ?? `${process.platform}-${process.arch}`;
const out = path.resolve(args.out ?? path.join(".release", "binaries", target, process.platform === "win32" ? "kairn.exe" : "kairn"));

if (process.env.KAIRN_RELEASE_BINARY_PATH) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(path.resolve(process.env.KAIRN_RELEASE_BINARY_PATH), out);
  if (!target.startsWith("win32-")) fs.chmodSync(out, 0o755);
  console.log(JSON.stringify({ target, out, source: "KAIRN_RELEASE_BINARY_PATH" }, null, 2));
  process.exit(0);
}

if (!process.env.KAIRN_BINARY_BUILD_COMMAND) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "release", "build-pkg-binary.mjs"), "--target", target, "--out", out], {
    cwd: root,
    stdio: "inherit",
    env: process.env
  });
  process.exit(result.status ?? 1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const result = spawnSync(process.env.KAIRN_BINARY_BUILD_COMMAND, {
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    KAIRN_RELEASE_TARGET: target,
    KAIRN_RELEASE_OUT: out
  }
});
if (result.status !== 0) process.exit(result.status ?? 1);
if (!fs.existsSync(out)) {
  console.error(`binary builder did not create ${out}`);
  process.exit(1);
}
if (!target.startsWith("win32-")) fs.chmodSync(out, 0o755);
console.log(JSON.stringify({ target, out, source: "KAIRN_BINARY_BUILD_COMMAND" }, null, 2));

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
