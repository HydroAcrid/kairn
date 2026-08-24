// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/iu;
const MAX_LICENSE_FILE_BYTES = 1024 * 1024;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function loadProductionLicenseInventory(options = {}) {
  const args = ["licenses", "list", "--json", ...(options.productionOnly === false ? [] : ["--prod"])];
  const pnpmEntrypoint = process.env.npm_execpath?.toLowerCase().includes("pnpm")
    ? process.env.npm_execpath
    : undefined;

  const output = pnpmEntrypoint
    ? execFileSync(process.execPath, [pnpmEntrypoint, ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      })
    : execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });

  return JSON.parse(output);
}

export function normalizeProductionDependencies(rawInventory) {
  const dependencies = new Map();

  for (const [licenseGroup, packages] of Object.entries(rawInventory)) {
    for (const dependency of packages) {
      const installed = installedPackageVariants(dependency);
      for (const variant of installed) {
        const key = `${dependency.name}@${variant.version}`;
        const current = dependencies.get(key) ?? {
          name: dependency.name,
          version: variant.version,
          license: dependency.license ?? licenseGroup,
          homepage: validHttpUrl(dependency.homepage) ? dependency.homepage : undefined,
          licenseFiles: [],
        };

        const files = variant.packagePath ? readLicenseFiles(variant.packagePath) : [];
        for (const file of files) {
          if (!current.licenseFiles.some((candidate) => candidate.sha256 === file.sha256)) {
            current.licenseFiles.push(file);
          }
        }
        dependencies.set(key, current);
      }
    }
  }

  return [...dependencies.values()]
    .map((dependency) => ({
      ...dependency,
      licenseFiles: dependency.licenseFiles
        .sort((left, right) => left.name.localeCompare(right.name) || left.sha256.localeCompare(right.sha256)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

export function unresolvedLicenseDependencies(dependencies) {
  return dependencies.filter((dependency) =>
    !dependency.license
    || /^(?:unknown|unlicensed|none)$/iu.test(dependency.license.trim())
    || /^see license in\b/iu.test(dependency.license.trim()),
  );
}

function installedPackageVariants(dependency) {
  const variants = [];
  for (const packagePath of dependency.paths ?? []) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(packagePath, "package.json"), "utf8"));
      if (typeof manifest.version === "string" && manifest.version) {
        variants.push({ version: manifest.version, packagePath });
      }
    } catch {
      // Fall back to the version metadata reported by pnpm below. The report
      // remains useful while making missing license text visible to reviewers.
    }
  }

  for (const version of dependency.versions ?? []) {
    if (!variants.some((variant) => variant.version === version)) {
      variants.push({ version, packagePath: undefined });
    }
  }
  return variants;
}

function readLicenseFiles(packagePath) {
  if (!existsSync(packagePath)) return [];
  const candidates = readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return candidates.flatMap((name) => {
    const bytes = readFileSync(path.join(packagePath, name));
    if (bytes.length > MAX_LICENSE_FILE_BYTES) return [];
    return [{ name, sha256: sha256(bytes), text: bytes.toString("utf8").replace(/\r\n/gu, "\n").trimEnd() }];
  });
}

function validHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//u.test(value);
}
