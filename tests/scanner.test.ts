import { describe, expect, it } from "vitest";
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
});
