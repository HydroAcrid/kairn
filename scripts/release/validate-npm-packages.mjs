#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..", "..");
const launcherDir = path.join(root, "packages", "npm", "kairn");
const platformDir = path.join(root, "packages", "npm", "platforms");

const expectedPlatforms = new Map([
  ["usekairn-darwin-arm64", { os: "darwin", cpu: "arm64", binary: "bin/kairn" }],
  ["usekairn-darwin-x64", { os: "darwin", cpu: "x64", binary: "bin/kairn" }],
  ["usekairn-linux-arm64", { os: "linux", cpu: "arm64", binary: "bin/kairn" }],
  ["usekairn-linux-x64", { os: "linux", cpu: "x64", binary: "bin/kairn" }]
]);

const failures = [];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

const rootPackage = readJson(path.join(root, "package.json"));
check(rootPackage.private === true, "root package.json must be private to block accidental public JS publication");

const launcherPackage = readJson(path.join(launcherDir, "package.json"));
check(launcherPackage.name === "usekairn", "launcher package must own the public usekairn package name");
check(launcherPackage.bin?.kairn === "./bin/kairn.cjs", "launcher package must expose bin/kairn.cjs");
check(!launcherPackage.scripts?.postinstall, "launcher package must not use postinstall downloads");
check(!launcherPackage.scripts?.install, "launcher package must not use install downloads");

const optionalDeps = launcherPackage.optionalDependencies ?? {};
for (const [name, expected] of expectedPlatforms) {
  check(optionalDeps[name] === launcherPackage.version, `launcher optionalDependencies must include ${name}@${launcherPackage.version}`);
  const packageSlug = name.replace("usekairn-", "kairn-");
  const pkgPath = path.join(platformDir, packageSlug, "package.json");
  check(fs.existsSync(pkgPath), `missing platform package ${pkgPath}`);
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    check(pkg.name === name, `${packageSlug} package name mismatch`);
    check(pkg.version === launcherPackage.version, `${packageSlug} version mismatch`);
    check(pkg.os?.includes(expected.os), `${packageSlug} os must include ${expected.os}`);
    check(pkg.cpu?.includes(expected.cpu), `${packageSlug} cpu must include ${expected.cpu}`);
    check(pkg.files?.includes(expected.binary), `${packageSlug} files must include ${expected.binary}`);
    check(pkg.scripts?.prepack?.includes("validate-platform-package.mjs"), `${packageSlug} must validate binary before pack`);
  }
}

const launcher = fs.readFileSync(path.join(launcherDir, "bin", "kairn.cjs"), "utf8");
check(!/\b(fetch|curl|wget|http\.get|https\.get|request)\b/.test(launcher), "launcher must not download remote code");
check(!/postinstall/i.test(launcher), "launcher must not implement install-time behavior");
for (const name of expectedPlatforms.keys()) {
  check(launcher.includes(name), `launcher must know platform package ${name}`);
}

if (failures.length > 0) {
  console.error("Kairn npm package validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Kairn npm package validation passed.");
