#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import {
  loadProductionLicenseInventory,
  normalizeProductionDependencies,
  sha256,
  unresolvedLicenseDependencies,
} from "./lib/license-inventory.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url));
const productionOnly = !process.argv.includes("--all");
const dependencies = normalizeProductionDependencies(loadProductionLicenseInventory({ productionOnly }));
const unresolved = unresolvedLicenseDependencies(dependencies);

const report = {
  schemaVersion: 1,
  rootPackage: `${packageJson.name}@${packageJson.version}`,
  dependencyScope: productionOnly ? "production" : "all-installed",
  packageManager: packageJson.packageManager,
  lockfileSha256: sha256(lockfile),
  dependencyCount: dependencies.length,
  unresolvedLicenseCount: unresolved.length,
  missingRootLicenseTextCount: dependencies.filter((dependency) => dependency.licenseFiles.length === 0).length,
  dependencies: dependencies.map((dependency) => ({
    name: dependency.name,
    version: dependency.version,
    license: dependency.license,
    ...(dependency.homepage ? { homepage: dependency.homepage } : {}),
    licenseFiles: dependency.licenseFiles.map(({ name, sha256: checksum }) => ({ name, sha256: checksum })),
  })),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (unresolved.length > 0) {
  process.stderr.write(
    `Unresolved ${productionOnly ? "production" : "installed"} dependency licenses: `
      + `${unresolved.map(({ name, version }) => `${name}@${version}`).join(", ")}\n`,
  );
  process.exitCode = 1;
}
