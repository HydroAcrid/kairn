import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepo } from "../src/scanner/scanRepo.js";
import { createFixtureRepo } from "./helpers.js";

describe("scanRepo", () => {
  it("respects gitignore and classifies files", async () => {
    const root = createFixtureRepo();
    const scan = await scanRepo(root);
    const paths = scan.files.map((file) => file.path);

    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("src/app.test.ts");
    expect(paths).not.toContain("ignored.txt");
    expect(scan.files.find((file) => file.path === "src/app.test.ts")?.kind).toBe("test");
    expect(scan.files.find((file) => file.path === "package.json")?.kind).toBe("config");
  });

  it("assigns adaptive index tiers while keeping source files hot", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-large-scan-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/important.ts"), "export function important() { return true; }\n");
      for (let index = 0; index < 120; index += 1) {
        fs.writeFileSync(path.join(root, "docs", `guide-${index}.md`), `# Guide ${index}\n`);
      }

      const scan = await scanRepo(root);
      const important = scan.files.find((file) => file.path === "src/important.ts");
      const guide = scan.files.find((file) => file.path === "docs/guide-0.md");

      expect(scan.skippedByLimit).toBe(0);
      expect(important?.indexTier).toBe("tier3");
      expect(guide?.indexTier).toBe("tier0");
      expect(scan.indexTiers?.tier3).toBeGreaterThan(0);
      expect(scan.indexTiers?.tier0).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains complete path inventory when content enrichment limits are reached", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bounded-enrichment-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "alpha.ts"), "export const alpha = true;\n");
      fs.writeFileSync(path.join(root, "src", "beta.ts"), "export const beta = true;\n");
      fs.writeFileSync(path.join(root, "src", "oversized.ts"), "x".repeat(256));

      const scan = await scanRepo(root, {
        enrichmentLimits: { maxFiles: 1, maxFileBytes: 64 }
      });

      expect(scan.files.map((file) => file.path)).toEqual([
        "src/alpha.ts",
        "src/beta.ts",
        "src/oversized.ts"
      ]);
      expect(scan.files.filter((file) => file.indexTier !== "tier0")).toHaveLength(1);
      expect(scan.files.find((file) => file.path === "src/oversized.ts")?.indexTier).toBe("tier0");
      expect(scan.skippedByLimit).toBe(2);
      expect(scan.inventoryOnlyCount).toBe(2);
      expect(scan.contentIndexedCount).toBe(1);
      expect(scan.ignoredCount).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
