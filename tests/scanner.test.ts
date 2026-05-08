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

  it("caps very large repositories while keeping source files first", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-large-scan-"));
    try {
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/important.ts"), "export function important() { return true; }\n");
      for (let index = 0; index < 8050; index += 1) {
        fs.writeFileSync(path.join(root, "docs", `guide-${index}.md`), `# Guide ${index}\n`);
      }

      const scan = await scanRepo(root);
      const paths = scan.files.map((file) => file.path);

      expect(scan.files.length).toBe(8000);
      expect(scan.skippedByLimit).toBeGreaterThan(0);
      expect(paths).toContain("src/important.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
