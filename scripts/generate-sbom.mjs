#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function npmPurl(name, version) {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    const scope = name.slice(1, slash);
    const packageName = name.slice(slash + 1);
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }

  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function loadLicenseInventory() {
  const args = ["licenses", "list", "--json", "--prod"];
  const pnpmEntrypoint = process.env.npm_execpath?.toLowerCase().includes("pnpm")
    ? process.env.npm_execpath
    : undefined;

  const output = pnpmEntrypoint
    ? execFileSync(process.execPath, [pnpmEntrypoint, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
    : execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });

  return JSON.parse(output);
}

const componentsByRef = new Map();
for (const [licenseGroup, packages] of Object.entries(loadLicenseInventory())) {
  for (const dependency of packages) {
    for (const version of dependency.versions ?? []) {
      const purl = npmPurl(dependency.name, version);
      const existing = componentsByRef.get(purl) ?? {
        type: "library",
        "bom-ref": purl,
        name: dependency.name,
        version,
        purl,
        licenseNames: new Set(),
        homepage: dependency.homepage,
      };

      existing.licenseNames.add(dependency.license ?? licenseGroup);
      componentsByRef.set(purl, existing);
    }
  }
}

const components = [...componentsByRef.values()]
  .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]))
  .map(({ licenseNames, homepage, ...component }) => ({
    ...component,
    licenses: [...licenseNames]
      .sort()
      .map((name) => ({ license: { name } })),
    ...(typeof homepage === "string" && /^https?:\/\//u.test(homepage)
      ? { externalReferences: [{ type: "website", url: homepage }] }
      : {}),
  }));

const rootPurl = npmPurl(packageJson.name, packageJson.version);
const bom = {
  $schema: "https://cyclonedx.org/schema/bom-1.5.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": rootPurl,
      name: packageJson.name,
      version: packageJson.version,
      purl: rootPurl,
      licenses: [{ license: { id: packageJson.license } }],
    },
  },
  components,
};

process.stdout.write(`${JSON.stringify(bom, null, 2)}\n`);
