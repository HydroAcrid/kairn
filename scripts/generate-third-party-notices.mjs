#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProductionLicenseInventory,
  normalizeProductionDependencies,
  sha256,
  unresolvedLicenseDependencies,
} from "./lib/license-inventory.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const outputFlag = process.argv.indexOf("--out");
const outputPath = path.resolve(
  repositoryRoot,
  outputFlag >= 0 ? process.argv[outputFlag + 1] ?? "THIRD_PARTY_NOTICES.md" : "THIRD_PARTY_NOTICES.md",
);
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const lockfile = readFileSync(path.join(repositoryRoot, "pnpm-lock.yaml"));
const dependencies = normalizeProductionDependencies(loadProductionLicenseInventory());
const unresolved = unresolvedLicenseDependencies(dependencies);
const contents = renderNotices({ packageJson, lockfile, dependencies });

if (check) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8").replace(/\r\n/gu, "\n");
  } catch {
    process.stderr.write(`${path.relative(repositoryRoot, outputPath)} is missing. Run pnpm notices:generate.\n`);
    process.exitCode = 1;
  }
  if (current && current !== contents) {
    process.stderr.write(`${path.relative(repositoryRoot, outputPath)} is stale. Run pnpm notices:generate.\n`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, contents, "utf8");
  process.stdout.write(`Wrote ${path.relative(repositoryRoot, outputPath)} (${dependencies.length} production dependencies).\n`);
}

if (unresolved.length > 0) {
  process.stderr.write(
    `Unresolved production dependency licenses: ${unresolved.map(({ name, version }) => `${name}@${version}`).join(", ")}\n`,
  );
  process.exitCode = 1;
}

function renderNotices({ packageJson: manifest, lockfile: lock, dependencies: entries }) {
  const missingRootText = entries.filter((dependency) => dependency.licenseFiles.length === 0).length;
  const lines = [
    "# Third-Party Notices",
    "",
    `This file inventories production dependencies present in the generating install for ${manifest.name}.`,
    "It is generated from the locked production dependency graph and does not replace a legal provenance review.",
    "",
    `- Package: \`${manifest.name}@${manifest.version}\``,
    `- Lockfile SHA-256: \`${sha256(lock)}\``,
    `- Production dependencies: \`${entries.length}\``,
    `- Dependencies without package-root license/notice text: \`${missingRootText}\` (manual review required)`,
    "",
    "Regenerate with `pnpm notices:generate`; verify with `pnpm notices:check`.",
    "",
    "## Dependency inventory",
    "",
    "| Package | Version | Declared license | Project | License/notice text hashes |",
    "|---|---:|---|---|---|",
  ];

  for (const dependency of entries) {
    const hashes = dependency.licenseFiles.length > 0
      ? dependency.licenseFiles.map((file) => `\`${file.sha256}\``).join("<br>")
      : "Not found; manual review required";
    const project = dependency.homepage ? `[link](${dependency.homepage})` : "";
    lines.push(
      `| ${escapeTable(dependency.name)} | ${escapeTable(dependency.version)} | ${escapeTable(dependency.license)} | ${project} | ${hashes} |`,
    );
  }

  const texts = new Map();
  for (const dependency of entries) {
    for (const licenseFile of dependency.licenseFiles) {
      const current = texts.get(licenseFile.sha256) ?? {
        names: new Set(),
        filenames: new Set(),
        text: licenseFile.text,
      };
      current.names.add(`${dependency.name}@${dependency.version}`);
      current.filenames.add(licenseFile.name);
      texts.set(licenseFile.sha256, current);
    }
  }

  lines.push("", "## License and notice texts", "");
  for (const [checksum, licenseText] of [...texts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### SHA-256 \`${checksum}\``, "");
    lines.push(`Files: ${[...licenseText.filenames].sort().map((name) => `\`${name}\``).join(", ")}`);
    lines.push(`Packages: ${[...licenseText.names].sort().map((name) => `\`${name}\``).join(", ")}`, "");
    lines.push(
      ...licenseText.text.split("\n").map((line) => {
        const cleaned = line.trimEnd();
        return cleaned ? `    ${cleaned}` : "";
      }),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeTable(value) {
  return String(value).replace(/\|/gu, "\\|");
}
