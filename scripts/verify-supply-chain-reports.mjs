#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [licensePath, sbomPath] = process.argv.slice(2);
if (Boolean(licensePath) !== Boolean(sbomPath)) {
  process.stderr.write("Usage: node scripts/verify-supply-chain-reports.mjs <licenses.prod.json> <sbom.cdx.json>\n");
  process.exit(2);
}
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const licenseReport = JSON.parse(licensePath
  ? readFileSync(licensePath, "utf8")
  : execFileSync(process.execPath, [path.join(scriptDirectory, "generate-license-report.mjs")], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }));
const sbom = JSON.parse(sbomPath
  ? readFileSync(sbomPath, "utf8")
  : execFileSync(process.execPath, [path.join(scriptDirectory, "generate-sbom.mjs")], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }));
if (licenseReport.schemaVersion !== 1 || !Array.isArray(licenseReport.dependencies)) {
  throw new Error("production license report schema is invalid");
}
if (licenseReport.unresolvedLicenseCount !== 0) {
  throw new Error(`production license report contains ${licenseReport.unresolvedLicenseCount} unresolved declarations`);
}
if (licenseReport.dependencyCount !== licenseReport.dependencies.length) {
  throw new Error("production license report dependencyCount does not match its rows");
}
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5" || !Array.isArray(sbom.components)) {
  throw new Error("SBOM is not a CycloneDX 1.5 component inventory");
}

const licensed = new Set(licenseReport.dependencies.map((dependency) => `${dependency.name}@${dependency.version}`));
const components = new Set(sbom.components.map((component) => `${component.name}@${component.version}`));
const licenseOnly = [...licensed].filter((key) => !components.has(key));
const sbomOnly = [...components].filter((key) => !licensed.has(key));
if (licenseOnly.length > 0 || sbomOnly.length > 0) {
  throw new Error(
    `license/SBOM component mismatch; license-only=[${licenseOnly.join(", ")}], sbom-only=[${sbomOnly.join(", ")}]`,
  );
}

for (const [name, serialized] of [
  ["license report", JSON.stringify(licenseReport)],
  ["SBOM", JSON.stringify(sbom)],
]) {
  if (/(?:[A-Za-z]:\\|\/home\/|\/Users\/|node_modules[\\/])/u.test(serialized)) {
    throw new Error(`${name} leaks a local workspace or dependency-install path`);
  }
}

process.stdout.write(
  `Supply-chain reports agree on ${licensed.size} production components; no unresolved licenses or local paths found.\n`,
);
