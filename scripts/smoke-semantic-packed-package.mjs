#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const packageRoot = process.cwd();
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-package-"));
const modelHome = process.env.KAIRN_PACKAGE_SMOKE_MODEL_HOME || os.homedir();

try {
  const pack = run("npm", ["pack", "--json", "--pack-destination", smokeRoot], packageRoot);
  const tarballName = JSON.parse(pack.stdout)[0]?.filename;
  if (!tarballName) throw new Error("npm pack did not report a tarball");
  const tarballPath = path.join(smokeRoot, tarballName);
  const native = installAndVerify("native", tarballPath, []);
  const wasm = installAndVerify("wasm", tarballPath, ["--omit=optional"]);
  if (native.runtimeBackend !== "node" || !native.runtimeId.startsWith("onnxruntime-node@")) {
    throw new Error(`normal install did not select the native CPU runtime (${native.runtimeId})`);
  }
  if (wasm.runtimeBackend !== "wasm" || !wasm.runtimeId.startsWith("onnxruntime-web@")) {
    throw new Error(`optional-free install did not select the WebAssembly fallback (${wasm.runtimeId})`);
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "semantic-packed-package-smoke.v1",
    valid: true,
    modelHome,
    native,
    wasm
  }, null, 2)}\n`);
} finally {
  if (path.dirname(smokeRoot) !== path.resolve(os.tmpdir())) {
    throw new Error(`refusing to clean an unexpected package smoke path: ${smokeRoot}`);
  }
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}

function installAndVerify(name, tarballPath, installFlags) {
  const installRoot = path.join(smokeRoot, name);
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, "package.json"), "{\"private\":true}\n", "utf8");
  run("npm", ["install", "--no-audit", "--no-fund", ...installFlags, tarballPath], installRoot);
  const command = path.join(installRoot, "node_modules", ".bin", "kairn");
  const result = JSON.parse(run(command, ["model", "verify", "--home", modelHome, "--json"], installRoot).stdout);
  if (result.status !== "ready" || result.runtime?.passed !== true) {
    throw new Error(`${name} package install did not verify the local semantic model`);
  }
  return {
    installedBytes: directorySize(path.join(installRoot, "node_modules")),
    runtimeBackend: result.runtime.runtimeBackend,
    runtimeId: result.runtime.runtimeId,
    coldInitializationMs: result.runtime.coldInitializationMs,
    verificationInferenceMs: result.runtime.batchInferenceMs
  };
}

function directorySize(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, KAIRN_TELEMETRY_ENABLED: "0" }
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed (${result.status}): ${command} ${args.join(" ")}`,
      result.error?.message,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return result;
}
