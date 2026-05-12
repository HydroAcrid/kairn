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
    const indexStatus = execFileSync(CLI[0]!, [...CLI.slice(1), "index", "status", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const indexCompact = execFileSync(CLI[0]!, [...CLI.slice(1), "index", "compact", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const doctor = execFileSync(CLI[0]!, [...CLI.slice(1), "doctor", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const telemetryStatus = execFileSync(CLI[0]!, [...CLI.slice(1), "telemetry", "status", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    execFileSync(CLI[0]!, [...CLI.slice(1), "telemetry", "enable", "--root", root, "--destination", "supabase"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const betaReport = execFileSync(CLI[0]!, [...CLI.slice(1), "beta", "report", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const parsedMetrics = JSON.parse(metrics) as {
      totals: { events: number; savedTokens: number };
      bySource: Record<string, { events: number }>;
    };
    const parsedStatus = JSON.parse(indexStatus) as { fileCount: number; graphEdgeCount: number; tiers: Record<string, number> };
    const parsedCompact = JSON.parse(indexCompact) as { after: { fileCount: number }; walCheckpointed: boolean };
    const parsedDoctor = JSON.parse(doctor) as { checks: Array<{ id: string; status: string }> };
    const parsedTelemetry = JSON.parse(telemetryStatus) as { enabled: boolean; queueLength: number };
    const parsedBetaReport = JSON.parse(betaReport) as { sessions: number; verdict: string };

    expect(init).toContain("Kairn initialized");
    expect(context).toContain("renderDashboard");
    expect(semanticContext).toContain("Response Mode: snippets");
    expect(semanticContext).toContain("DashboardMetrics");
    expect(diff).toContain("src/app.ts");
    expect(compressed).toContain("FAIL src/app.test.ts");
    expect(parsedMetrics.totals.events).toBeGreaterThan(0);
    expect(parsedMetrics.totals.savedTokens).toBeGreaterThanOrEqual(0);
    expect(parsedMetrics.bySource.cli?.events).toBe(1);
    expect(parsedStatus.fileCount).toBeGreaterThan(0);
    expect(parsedStatus.graphEdgeCount).toBeGreaterThanOrEqual(0);
    expect(parsedStatus.tiers.tier0).toBeGreaterThanOrEqual(0);
    expect(parsedCompact.after.fileCount).toBe(parsedStatus.fileCount);
    expect(parsedCompact.walCheckpointed).toBe(true);
    expect(parsedDoctor.checks.some((check) => check.id === "kairn_state")).toBe(true);
    expect(parsedTelemetry.enabled).toBe(false);
    expect(parsedTelemetry.queueLength).toBe(0);
    expect(parsedBetaReport.sessions).toBeGreaterThan(0);
    expect(parsedBetaReport.verdict).toBeTruthy();
  });
});
