#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const launcherRequire = createRequire(__filename);
const launcherPackage = "usekairn@0.1.2";

const platformPackages = {
  "darwin-arm64": "usekairn-darwin-arm64",
  "darwin-x64": "usekairn-darwin-x64",
  "linux-arm64": "usekairn-linux-arm64",
  "linux-x64": "usekairn-linux-x64"
};

function main() {
  const target = `${process.platform}-${process.arch}`;
  const binary = resolveBinary(target);
  const result = spawnSync(binary.path, process.argv.slice(2), {
    stdio: "inherit",
    env: {
      ...process.env,
      KAIRN_INSTALL_CHANNEL: process.env.KAIRN_INSTALL_CHANNEL || "npm-beta",
      KAIRN_BUILD_TARGET: process.env.KAIRN_BUILD_TARGET || target,
      KAIRN_PLATFORM_PACKAGE: process.env.KAIRN_PLATFORM_PACKAGE || binary.packageName,
      KAIRN_LAUNCHER_PACKAGE: process.env.KAIRN_LAUNCHER_PACKAGE || launcherPackage
    }
  });

  if (result.error) {
    console.error(`kairn: failed to launch ${binary.path}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

function resolveBinary(target) {
  if (process.env.KAIRN_BINARY_PATH) {
    const override = path.resolve(process.env.KAIRN_BINARY_PATH);
    if (!fs.existsSync(override)) {
      fail(`KAIRN_BINARY_PATH does not exist: ${override}`);
    }
    return { path: override, packageName: "KAIRN_BINARY_PATH" };
  }

  const packageName = platformPackages[target];
  if (!packageName) {
    fail(
      [
        `Unsupported npm beta platform: ${target}.`,
        "",
        "This beta currently supports macOS arm64/x64 and Linux arm64/x64.",
        "Windows users should use WSL during beta.",
        "",
        "Docs: https://usekairn.com/docs/install-and-update"
      ].join("\n")
    );
  }

  const binaryName = process.platform === "win32" ? "kairn.exe" : "kairn";
  try {
    return {
      path: launcherRequire.resolve(`${packageName}/bin/${binaryName}`),
      packageName
    };
  } catch {
    fail(
      [
        `The platform package ${packageName} is missing for ${target}.`,
        "",
        "Try reinstalling:",
        "  npm install -g usekairn@beta",
        "",
        "If npm omitted optional dependencies, install the platform package explicitly:",
        `  npm install -g usekairn@beta ${packageName}@0.1.2`,
        "",
        "Docs: https://usekairn.com/docs/install-and-update"
      ].join("\n")
    );
  }
}

function fail(message) {
  console.error(`kairn: ${message}`);
  process.exit(1);
}

main();
