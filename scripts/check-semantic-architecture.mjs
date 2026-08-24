// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const servingModules = [
  "src/retrieval/semanticCandidates.ts",
  "src/retrieval/candidateFusion.ts",
  "src/semantic/modelRuntime.ts"
];
const forbiddenFragments = [
  "../semantic/vector.js",
  "hybridRetrieval",
  "scoreBehaviorMatches",
  "scoreSourcePriority",
  "chunkPriority",
  "filename bonus",
  "path bonus",
  ".match(",
  ".matchAll(",
  "new RegExp("
];
const benchmarkIdentities = [
  "is-local-url",
  "slugify",
  "term_len",
  "starts_with"
];

const violations = [];
for (const relativePath of servingModules) {
  const content = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
  for (const fragment of [...forbiddenFragments, ...benchmarkIdentities]) {
    if (content.includes(fragment)) violations.push(`${relativePath}: contains "${fragment}"`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Semantic serving architecture check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Semantic serving architecture check passed.\n");
}
