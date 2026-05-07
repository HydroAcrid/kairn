import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createFixtureRepo } from "./helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("CLI", () => {
  it("supports init, start, context, diff, and compress", () => {
    const root = createFixtureRepo();

    const init = execFileSync(CLI[0]!, [...CLI.slice(1), "init", "--root", root], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const start = execFileSync(CLI[0]!, [...CLI.slice(1), "start", "Update dashboard", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const parsed = JSON.parse(start) as { session: { id: string } };
    const context = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "context", "--session", parsed.session.id, "--file", "src/app.ts", "--root", root],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const semanticContext = execFileSync(
      CLI[0]!,
      [
        ...CLI.slice(1),
        "context",
        "--session",
        parsed.session.id,
        "--query",
        "DashboardMetrics",
        "--mode",
        "snippets",
        "--root",
        root
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const diff = execFileSync(CLI[0]!, [...CLI.slice(1), "diff", "--session", parsed.session.id, "--root", root], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const compressed = execFileSync(
      CLI[0]!,
      [
        ...CLI.slice(1),
        "compress",
        "--session",
        parsed.session.id,
        "--root",
        root,
        "--type",
        "test",
        "--output",
        "FAIL src/app.test.ts"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const metrics = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "metrics", "--session", parsed.session.id, "--root", root, "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const parsedMetrics = JSON.parse(metrics) as {
      totals: { events: number; savedTokens: number };
      bySource: Record<string, { events: number }>;
    };

    expect(init).toContain("Kairn initialized");
    expect(context).toContain("renderDashboard");
    expect(semanticContext).toContain("Response Mode: snippets");
    expect(semanticContext).toContain("DashboardMetrics");
    expect(diff).toContain("src/app.ts");
    expect(compressed).toContain("FAIL src/app.test.ts");
    expect(parsedMetrics.totals.events).toBeGreaterThan(0);
    expect(parsedMetrics.totals.savedTokens).toBeGreaterThanOrEqual(0);
    expect(parsedMetrics.bySource.cli?.events).toBe(1);
  });
});
