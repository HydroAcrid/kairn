#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const skippedPrefixes = ["docs/publication-evidence-", "dist/", "node_modules/"];
const reviewedFixtures = new Set([
  // Public SWE-Atlas security fixture containing documented fake credential examples.
  "examples/bench/swe-atlas-qna-publication/swe-atlas-qna-pilot-raw.jsonl"
]);
const patterns = [
  { name: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "AWS access key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "Anthropic API key", expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ }
];
const scanHistory = process.argv.includes("--history");

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter((file) => !skippedPrefixes.some((prefix) => file.startsWith(prefix)))
  .filter((file) => !reviewedFixtures.has(file));
const findings = [];

for (const file of files) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) findings.push(`${file}: possible ${pattern.name}`);
  }
}

if (scanHistory) scanGitHistory(findings);

if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked ${files.length} tracked and untracked repository files${scanHistory ? " plus reachable Git history" : ""}; no high-confidence secret patterns found.\n`
  );
}

function scanGitHistory(targetFindings) {
  const objects = execFileSync("git", ["rev-list", "--objects", "--all"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator < 0
        ? { object: line, file: "(unpathed)" }
        : { object: line.slice(0, separator), file: line.slice(separator + 1) };
    });
  const byObject = new Map();
  for (const entry of objects) {
    if (!byObject.has(entry.object)) byObject.set(entry.object, entry.file);
  }
  const objectIds = [...byObject.keys()];
  if (objectIds.length === 0) return;
  const checks = execFileSync(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: `${objectIds.join("\n")}\n`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  ).split(/\r?\n/);
  for (const row of checks) {
    const [object, type, sizeText] = row.split(" ");
    const size = Number(sizeText);
    if (!object || type !== "blob" || !Number.isFinite(size) || size > 5 * 1024 * 1024) continue;
    const file = byObject.get(object) ?? "(unpathed)";
    if (skippedPrefixes.some((prefix) => file.startsWith(prefix)) || reviewedFixtures.has(file)) continue;
    let content;
    try {
      content = execFileSync("git", ["cat-file", "blob", object], {
        encoding: "utf8",
        maxBuffer: Math.max(1024 * 1024, size + 1024)
      });
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    for (const pattern of patterns) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(content)) {
        targetFindings.push(`history:${file}@${object.slice(0, 12)}: possible ${pattern.name}`);
      }
    }
  }
}
