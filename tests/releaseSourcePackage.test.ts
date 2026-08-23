// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("source npm distribution", () => {
  it("publishes usekairn as the direct Node CLI package", () => {
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      publishConfig: { access: string; provenance: boolean };
    };

    expect(manifest.name).toBe("usekairn");
    expect(manifest.version).toMatch(/^0\.2\.0-beta\./u);
    expect(manifest.bin).toEqual({ kairn: "./dist/cli.js" });
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
    expect(fs.existsSync("packages/npm/kairn/package.json")).toBe(false);
  });
});
