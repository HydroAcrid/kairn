// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

type PackageMetadata = {
  version?: unknown;
};

export function getKairnVersion(): string {
  const packagePath = new URL("../package.json", import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageMetadata;
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error(`Invalid Kairn package version in ${packagePath.pathname}`);
  }
  return metadata.version;
}

/** @deprecated Prefer getKairnVersion(); retained for v0.1 integrations. */
export const KAIRN_VERSION = getKairnVersion();
