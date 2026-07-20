import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexExecArgs } from "../src/cli/helpers.js";
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
    const indexSafeRefresh = execFileSync(CLI[0]!, [...CLI.slice(1), "index", "refresh", "--safe", "--root", root, "--json"], {
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
    const claudeMcpSetup = execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "claude-code", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const geminiMcpSetup = execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "gemini-cli", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const copilotMcpSetup = execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "copilot-cli", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const genericMcpSetup = execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "generic", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const claudeHookSetup = execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "claude", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const doctorAfterMcp = execFileSync(CLI[0]!, [...CLI.slice(1), "doctor", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const doctorGemini = execFileSync(CLI[0]!, [...CLI.slice(1), "doctor", "--root", root, "--target", "gemini-cli", "--json"], {
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
    const setupWizardTargets = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "wizard", "--root", root, "--targets", "claude-code,gemini-cli", "--yes", "--no-index", "--json"],
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
    const parsedSafeRefresh = JSON.parse(indexSafeRefresh) as { fileCount: number };
    const parsedDoctor = JSON.parse(doctor) as { checks: Array<{ id: string; status: string }> };
    const parsedDoctorAfterMcp = JSON.parse(doctorAfterMcp) as { checks: Array<{ id: string; status: string; metadata?: Record<string, unknown> }> };
    const parsedDoctorGemini = JSON.parse(doctorGemini) as { checks: Array<{ id: string; status: string; metadata?: Record<string, unknown> }> };
    const parsedMcpSetup = JSON.parse(mcpSetup) as { configPath: string; serverConfig: { args: string[] } };
    const parsedClaudeMcpSetup = JSON.parse(claudeMcpSetup) as { configPath: string; clientConfig: { mcpServers: Record<string, unknown> }; installCommand: string };
    const parsedGeminiMcpSetup = JSON.parse(geminiMcpSetup) as { configPath: string; clientConfig: { mcpServers: Record<string, { trust?: boolean }> } };
    const parsedCopilotMcpSetup = JSON.parse(copilotMcpSetup) as { configPath?: string; userConfigWriteSkipped: boolean; clientConfig: { mcpServers: Record<string, { type?: string; tools?: string[] }> } };
    const parsedGenericMcpSetup = JSON.parse(genericMcpSetup) as { configPath?: string; clientConfig: { mcpServers: Record<string, unknown> } };
    const parsedClaudeHookSetup = JSON.parse(claudeHookSetup) as { configPath: string; hooksInstalled: string[] };
    const parsedSetupWizard = JSON.parse(setupWizard) as {
      choice: string;
      targets: string[];
      indexed: boolean;
      integrations: Array<{ kind: string; configPath?: string; hooksPath?: string }>;
      nextSteps: string[];
    };
    const parsedSetupWizardTargets = JSON.parse(setupWizardTargets) as {
      targets: string[];
      integrations: Array<{ kind: string; target?: string; configPath?: string }>;
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
    expect(parsedSafeRefresh.fileCount).toBeGreaterThan(0);
    expect(parsedDoctor.checks.some((check) => check.id === "kairn_state")).toBe(true);
    expect(parsedMcpSetup.configPath.endsWith(".vscode/mcp.json")).toBe(true);
    expect(parsedMcpSetup.serverConfig.args).toContain("serve");
    expect(parsedClaudeMcpSetup.configPath.endsWith(".mcp.json")).toBe(true);
    expect(parsedClaudeMcpSetup.clientConfig.mcpServers.kairn).toBeTruthy();
    expect(parsedClaudeMcpSetup.installCommand).toContain("claude mcp add-json kairn");
    expect(parsedGeminiMcpSetup.configPath.endsWith(path.join(".gemini", "settings.json"))).toBe(true);
    expect(parsedGeminiMcpSetup.clientConfig.mcpServers.kairn?.trust).toBe(false);
    expect(parsedCopilotMcpSetup.configPath).toBeUndefined();
    expect(parsedCopilotMcpSetup.userConfigWriteSkipped).toBe(true);
    expect(parsedCopilotMcpSetup.clientConfig.mcpServers.kairn?.type).toBe("local");
    expect(parsedCopilotMcpSetup.clientConfig.mcpServers.kairn?.tools).toEqual(["*"]);
    expect(parsedGenericMcpSetup.configPath).toBeUndefined();
    expect(parsedGenericMcpSetup.clientConfig.mcpServers.kairn).toBeTruthy();
    expect(parsedClaudeHookSetup.configPath.endsWith(path.join(".claude", "settings.local.json"))).toBe(true);
    expect(parsedClaudeHookSetup.hooksInstalled).toContain("UserPromptSubmit");
    expect(parsedSetupWizard.choice).toBe("both");
    expect(parsedSetupWizard.targets).toContain("codex");
    expect(parsedSetupWizard.indexed).toBe(false);
    expect(parsedSetupWizard.integrations.some((integration) => integration.kind === "codex" && integration.hooksPath?.endsWith(".codex/hooks.json"))).toBe(true);
    expect(parsedSetupWizard.integrations.some((integration) => integration.kind === "mcp" && integration.configPath?.endsWith(".vscode/mcp.json"))).toBe(true);
    expect(parsedSetupWizard.nextSteps.some((step) => step.includes("kairn codex"))).toBe(true);
    expect(parsedSetupWizardTargets.targets).toEqual(["claude-code", "gemini-cli"]);
    expect(parsedSetupWizardTargets.integrations.some((integration) => integration.target === "claude-code" && integration.configPath?.endsWith(".mcp.json"))).toBe(true);
    expect(parsedSetupWizardTargets.integrations.some((integration) => integration.target === "gemini-cli" && integration.configPath?.endsWith(path.join(".gemini", "settings.json")))).toBe(true);
    expect(parsedDoctorAfterMcp.checks.find((check) => check.id === "mcp_config")?.status).toBe("ok");
    expect(parsedDoctorAfterMcp.checks.find((check) => check.id === "mcp_config")?.metadata?.vscodeConfigured).toBe(true);
    expect(parsedDoctorAfterMcp.checks.find((check) => check.id === "mcp_config")?.metadata?.claudeConfigured).toBe(true);
    expect(parsedDoctorAfterMcp.checks.find((check) => check.id === "mcp_config")?.metadata?.geminiConfigured).toBe(true);
    expect(parsedDoctorGemini.checks.find((check) => check.id === "mcp_config")?.status).toBe("ok");
    expect(parsedTelemetry.enabled).toBe(false);
    expect(parsedTelemetry.queueLength).toBe(0);
    expect(parsedBetaReport.sessions).toBeGreaterThan(0);
    expect(parsedBetaReport.verdict).toBeTruthy();
  }, 90_000);

  it("accepts whitespace-separated setup wizard targets from PowerShell-style argument lists", () => {
    const root = createFixtureRepo();
    const setupWizardWhitespaceTargets = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "wizard", "--root", root, "--targets", "vscode generic", "--yes", "--no-index", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    const parsed = JSON.parse(setupWizardWhitespaceTargets) as {
      targets: string[];
      integrations: Array<{ kind: string; target?: string; configPath?: string }>;
    };

    expect(parsed.targets).toEqual(["vscode", "generic"]);
    expect(parsed.integrations.some((integration) => integration.target === "vscode" && integration.configPath?.endsWith(".vscode/mcp.json"))).toBe(true);
    expect(parsed.integrations.some((integration) => integration.target === "generic")).toBe(true);
  });

  it("keeps the setup doctor index check fresh after wizard-generated files are written", () => {
    const root = createFixtureRepo();
    const setupWizard = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "wizard", "--root", root, "--targets", "vscode generic", "--yes", "--index-mode", "safe", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    const parsed = JSON.parse(setupWizard) as {
      indexed: boolean;
      doctor: {
        checks: Array<{ id: string; status: string; summary: string }>;
      };
    };
    const indexCheck = parsed.doctor.checks.find((check) => check.id === "index_state");

    expect(parsed.indexed).toBe(true);
    expect(indexCheck?.status).toBe("ok");
    expect(indexCheck?.summary).toContain("fresh");
  });

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
    execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "claude-code"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp", "--root", root, "--client", "gemini-cli"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "claude", "--root", root], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
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
    expect(parsed.removed).toContain(".mcp.json");
    expect(parsed.removed).toContain(path.join(".gemini", "settings.json"));
    expect(parsed.removed).toContain(path.join(".claude", "settings.local.json"));
    expect(parsed.changed).toContain(".vscode/mcp.json");
    expect(parsed.stateDeleted).toBe(true);
    expect(fs.existsSync(path.join(root, ".kairn"))).toBe(false);
    expect(mcpJson.servers?.existing).toBeTruthy();
    expect(mcpJson.servers?.kairn).toBeUndefined();
  });

  it("repairs Kairn-owned setup with doctor --fix", () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".vscode", "mcp.json"),
      `${JSON.stringify({ servers: { kairn: { type: "stdio", command: "/old/kairn", args: ["serve", "--mcp", "--root", root] } } }, null, 2)}\n`
    );
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[features]\ncodex_hooks = false\n");
    fs.writeFileSync(
      path.join(root, ".codex", "hooks.json"),
      `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/old/kairn hook --source codex" }] }] } }, null, 2)}\n`
    );

    const fixedVscode = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "doctor", "--root", root, "--target", "vscode", "--fix", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const fixedCodex = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "doctor", "--root", root, "--target", "codex", "--fix", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const parsedVscode = JSON.parse(fixedVscode) as { fix: { repaired: string[] } };
    const parsedCodex = JSON.parse(fixedCodex) as { fix: { repaired: string[] } };
    const vscodeConfig = JSON.parse(fs.readFileSync(path.join(root, ".vscode", "mcp.json"), "utf8")) as {
      servers: { kairn: { command: string; args: string[] } };
    };
    const codexConfig = fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8");
    const codexHooks = fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8");

    expect(parsedVscode.fix.repaired).toContain("mcp:vscode");
    expect(vscodeConfig.servers.kairn.command).not.toBe("/old/kairn");
    expect(vscodeConfig.servers.kairn.args).toContain("serve");
    expect(parsedCodex.fix.repaired).toContain("codex:savings");
    expect(codexConfig).toContain("hooks = true");
    expect(codexConfig).not.toContain("codex_hooks");
    expect(codexHooks).toContain("Priming Kairn context");
    expect(codexHooks).not.toContain("/old/kairn");
  });

  it("disables Codex hooks for noninteractive direct runs unless explicitly enabled", () => {
    const disabled = codexExecArgs({
      root: "/repo",
      prompt: "fix bug",
      sandbox: "danger-full-access",
      enableHooks: false
    });
    const enabled = codexExecArgs({
      root: "/repo",
      prompt: "fix bug",
      sandbox: "danger-full-access",
      enableHooks: true
    });

    expect(disabled).toContain("--disable");
    expect(disabled).toContain("hooks");
    expect(enabled).toContain("--enable");
    expect(enabled).toContain("hooks");
    expect(enabled).not.toContain("--disable");
  });
});
