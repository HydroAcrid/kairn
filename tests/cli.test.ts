import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
    const mcpSetup = execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "vscode", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const doctorAfterMcp = execFileSync(CLI[0]!, [...CLI.slice(1), "doctor", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const setupWizard = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "wizard", "--root", root, "--choice", "both", "--yes", "--no-index", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    const betaReport = execFileSync(CLI[0]!, [...CLI.slice(1), "beta", "report", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    execFileSync(CLI[0]!, [...CLI.slice(1), "telemetry", "enable", "--root", root, "--destination", "supabase"], {
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
    const parsedDoctorAfterMcp = JSON.parse(doctorAfterMcp) as { checks: Array<{ id: string; status: string; metadata?: Record<string, unknown> }> };
    const parsedMcpSetup = JSON.parse(mcpSetup) as { configPath: string; serverConfig: { args: string[] } };
    const parsedSetupWizard = JSON.parse(setupWizard) as {
      choice: string;
      indexed: boolean;
      integrations: Array<{ kind: string; configPath?: string; hooksPath?: string }>;
      nextSteps: string[];
    };
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
    expect(parsedMcpSetup.configPath.endsWith(".vscode/mcp.json")).toBe(true);
    expect(parsedMcpSetup.serverConfig.args).toContain("serve");
    expect(parsedSetupWizard.choice).toBe("both");
    expect(parsedSetupWizard.indexed).toBe(false);
    expect(parsedSetupWizard.integrations.some((integration) => integration.kind === "codex" && integration.hooksPath?.endsWith(".codex/hooks.json"))).toBe(true);
    expect(parsedSetupWizard.integrations.some((integration) => integration.kind === "mcp" && integration.configPath?.endsWith(".vscode/mcp.json"))).toBe(true);
    expect(parsedSetupWizard.nextSteps.some((step) => step.includes("kairn codex"))).toBe(true);
    expect(parsedDoctorAfterMcp.checks.find((check) => check.id === "mcp_config")?.status).toBe("ok");
    expect(parsedDoctorAfterMcp.checks.find((check) => check.id === "mcp_config")?.metadata?.vscodeConfigured).toBe(true);
    expect(parsedTelemetry.enabled).toBe(false);
    expect(parsedTelemetry.queueLength).toBe(0);
    expect(parsedBetaReport.sessions).toBeGreaterThan(0);
    expect(parsedBetaReport.verdict).toBeTruthy();
  }, 30_000);

  it("removes Kairn-owned setup without removing unrelated client config", () => {
    const root = createFixtureRepo();
    const vscodeDir = path.join(root, ".vscode");
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(vscodeDir, "mcp.json"),
      `${JSON.stringify({ servers: { existing: { type: "stdio", command: "example", args: [] } } }, null, 2)}\n`
    );

    execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "wizard", "--root", root, "--choice", "both", "--yes", "--no-index"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const removed = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "remove", "--root", root, "--delete-state", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const parsed = JSON.parse(removed) as { removed: string[]; changed: string[]; stateDeleted: boolean };
    const mcpJson = JSON.parse(fs.readFileSync(path.join(vscodeDir, "mcp.json"), "utf8")) as {
      servers?: Record<string, unknown>;
    };

    expect(parsed.removed).toContain(".codex/hooks.json");
    expect(parsed.removed).toContain("AGENTS.md");
    expect(parsed.changed).toContain(".vscode/mcp.json");
    expect(parsed.stateDeleted).toBe(true);
    expect(fs.existsSync(path.join(root, ".kairn"))).toBe(false);
    expect(mcpJson.servers?.existing).toBeTruthy();
    expect(mcpJson.servers?.kairn).toBeUndefined();
  });
});
