#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..", "..");

const targets = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64"
]);

const args = parseArgs(process.argv.slice(2));
const target = args.target;
const binary = args.binary;
const assets = args.assets;
const outDir = path.resolve(args["out-dir"] ?? path.join(root, ".release", "npm"));

if (!target || !targets.has(target)) {
  fail(`--target must be one of: ${[...targets].join(", ")}`);
}
if (!binary) fail("--binary is required");

const binaryPath = path.resolve(binary);
if (!fs.existsSync(binaryPath)) fail(`binary does not exist: ${binaryPath}`);

const packageSlug = `kairn-${target}`;
const sourceDir = path.join(root, "packages", "npm", "platforms", packageSlug);
const stageDir = path.join(outDir, packageSlug);
const stagedBinaryName = target.startsWith("win32-") ? "kairn.exe" : "kairn";
const stagedBinaryPath = path.join(stageDir, "bin", stagedBinaryName);
const sourceAssetsDir = assets ? path.resolve(assets) : path.join(path.dirname(binaryPath), "assets");
const stagedAssetsDir = path.join(stageDir, "bin", "assets");

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(stagedBinaryPath), { recursive: true });
for (const name of ["package.json", "README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(sourceDir, name), path.join(stageDir, name));
}
const stagedPackagePath = path.join(stageDir, "package.json");
const stagedPackage = JSON.parse(fs.readFileSync(stagedPackagePath, "utf8"));
stagedPackage.scripts = {
  ...stagedPackage.scripts,
  prepack: "node ./validate-platform-package.mjs"
};
fs.writeFileSync(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
fs.copyFileSync(path.join(root, "scripts", "release", "validate-platform-package.mjs"), path.join(stageDir, "validate-platform-package.mjs"));
fs.copyFileSync(binaryPath, stagedBinaryPath);
if (!target.startsWith("win32-")) fs.chmodSync(stagedBinaryPath, 0o755);
if (fs.existsSync(sourceAssetsDir)) {
  fs.cpSync(sourceAssetsDir, stagedAssetsDir, { recursive: true });
}

const checksumLines = checksumFiles(stageDir, [stagedBinaryPath, ...listFiles(stagedAssetsDir)]);
fs.writeFileSync(path.join(stageDir, "checksums.txt"), `${checksumLines.join("\n")}\n`);

console.log(JSON.stringify({ target, stageDir, binary: stagedBinaryPath, assets: fs.existsSync(stagedAssetsDir) ? stagedAssetsDir : null }, null, 2));

function checksumFiles(baseDir, files) {
  return files.map((file) => {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return `${sha}  ${path.relative(baseDir, file).split(path.sep).join("/")}`;
  });
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(fullPath));
    else if (entry.isFile()) output.push(fullPath);
  }
  return output.sort();
}

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

function fail(message) {
  console.error(`stage-platform-package: ${message}`);
  process.exit(1);
}
