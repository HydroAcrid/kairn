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
});
