import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexNoDiffRecoveryPrompt,
  buildCodexPartialScopeRecoveryPrompt,
  missingRequiredScopeFiles,
  relevantWorkspaceDiffFiles,
  shouldRetryCodexNoDiff,
  shouldRetryCodexPartialScope
} from "../src/cli/codexRecovery.js";
import { formatCodexEditScopeReminder } from "../src/cli/commands/core.js";
import { codexExecArgs, withKairnInternalStateHidden } from "../src/cli/helpers.js";
import { createFixtureRepo } from "./helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("CLI", () => {
  it("hides Kairn internal state from git-aware agent scans", () => {
    const root = createFixtureRepo();
    const excludePath = path.join(root, ".git", "info", "exclude");

    execFileSync(CLI[0]!, [...CLI.slice(1), "init", "--state-only", "--root", root], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    execFileSync(CLI[0]!, [...CLI.slice(1), "start", "Check routing", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    const exclude = fs.readFileSync(excludePath, "utf8");
    expect(exclude.match(/^\.kairn\/$/gm)).toHaveLength(1);
  });

  it("temporarily moves Kairn internal state out of the working tree for no-op Codex runs", () => {
    const root = createFixtureRepo();
    const stateDir = path.join(root, ".kairn");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "kairn.sqlite"), "state");

    let hiddenEntries: string[] = [];
    withKairnInternalStateHidden(root, true, () => {
      expect(fs.existsSync(stateDir)).toBe(false);
      hiddenEntries = fs.readdirSync(path.join(root, ".git")).filter((entry) => entry.startsWith("kairn-state-hidden-"));
      expect(hiddenEntries).toHaveLength(1);
    });

    expect(fs.existsSync(path.join(stateDir, "kairn.sqlite"))).toBe(true);
    for (const entry of hiddenEntries) {
      expect(fs.existsSync(path.join(root, ".git", entry))).toBe(false);
    }
  });

  it("keeps candidate paired scopes soft in Codex wrapper reminders", () => {
    const reminder = formatCodexEditScopeReminder({
      editScope: {
        initialEditFiles: ["src/topics/tools.js", "src/socket.io/topics/tools.js"],
        readOnlyFiles: [],
        allowedExpansionTriggers: [],
        forbiddenEditPatterns: [],
        scopeConfidence: "high",
        scopeSource: "official_harness",
        reason: "test",
        strictBoundary: true,
        dynamic: true
      },
      contextDecision: {
        taskShapeSignal: "topic_ordering"
      }
    } as any);

    expect(reminder).toContain("Kairn focused source candidates");
    expect(reminder).toContain("Start with: src/topics/tools.js, src/socket.io/topics/tools.js");
    expect(reminder).not.toContain("Kairn edit scope is authoritative");
    expect(reminder).not.toContain("Edit only:");
  });

  it("keeps required multi-surface scopes hard in Codex wrapper reminders", () => {
    const reminder = formatCodexEditScopeReminder({
      editScope: {
        initialEditFiles: ["internal/cmd/grpc.go", "internal/server/auth/middleware.go"],
        readOnlyFiles: [],
        allowedExpansionTriggers: [],
        forbiddenEditPatterns: [],
        scopeConfidence: "high",
        scopeSource: "official_harness",
        reason: "test",
        strictBoundary: true,
        dynamic: true
      },
      contextDecision: {
        taskShapeSignal: "grpc_error_policy"
      }
    } as any);

    expect(reminder).toContain("Kairn edit scope is authoritative");
    expect(reminder).toContain("Edit only: internal/cmd/grpc.go, internal/server/auth/middleware.go");
  });

  it("does not append duplicate wrapper reminders when a guardrail prime is already emitted", () => {
    const reminder = formatCodexEditScopeReminder({
      metadata: {
        guardrailVariant: "topic_ordering_compact"
      },
      editScope: {
        initialEditFiles: ["src/topics/tools.js", "src/socket.io/topics/tools.js"],
        readOnlyFiles: [],
        allowedExpansionTriggers: [],
        forbiddenEditPatterns: [],
        scopeConfidence: "high",
        scopeSource: "official_harness",
        reason: "test",
        strictBoundary: true,
        dynamic: true
      },
      contextDecision: {
        taskShapeSignal: "topic_ordering"
      }
    } as any);

    expect(reminder).toBeUndefined();
  });

  it("supports init, start, context, diff, and compress", () => {
    const root = createFixtureRepo();

    const init = execFileSync(CLI[0]!, [...CLI.slice(1), "init", "--state-only", "--root", root], {
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
    const stats = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "stats", "--session", parsed.session.id, "--root", root, "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const statsReportPath = path.join(root, "kairn-impact.md");
    const statsReport = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "stats", "report", "--session", parsed.session.id, "--root", root, "--out", statsReportPath, "--json"],
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
    const parsedStats = JSON.parse(stats) as { countersVersion: number; events: number; estimatedTotalSavedTokens: number };
    const parsedStatsReport = JSON.parse(statsReport) as { outPath: string; impact: { countersVersion: number } };
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
    expect(parsedStats.countersVersion).toBe(1);
    expect(parsedStats.events).toBe(parsedMetrics.totals.events);
    expect(parsedStats.estimatedTotalSavedTokens).toBe(parsedMetrics.totals.savedTokens);
    expect(parsedStatsReport.outPath).toBe(statsReportPath);
    expect(fs.readFileSync(statsReportPath, "utf8")).toContain("Estimated context tokens avoided");
    expect(fs.readFileSync(statsReportPath, "utf8")).not.toContain("src/app.ts");
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
  }, 120_000);

  it("uses init as the friendly guided setup entrypoint", () => {
    const root = createFixtureRepo();
    const init = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "init", "--choice", "codex", "--yes", "--no-index", "--root", root, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    const parsed = JSON.parse(init) as {
      choice: string;
      targets: string[];
      indexed: boolean;
      integrations: Array<{ kind: string; hooksPath?: string }>;
      nextSteps: string[];
    };

    expect(parsed.choice).toBe("codex");
    expect(parsed.targets).toEqual(["codex"]);
    expect(parsed.indexed).toBe(false);
    expect(parsed.integrations.some((integration) => integration.kind === "codex" && integration.hooksPath?.endsWith(".codex/hooks.json"))).toBe(true);
    expect(parsed.nextSteps[0]).toContain("kairn doctor");
  });

  it("supports MCP targets through init", () => {
    const root = createFixtureRepo();
    const init = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "init", "--targets", "vscode", "--yes", "--no-index", "--root", root, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    const parsed = JSON.parse(init) as {
      targets: string[];
      integrations: Array<{ kind: string; target?: string; configPath?: string }>;
    };

    expect(parsed.targets).toEqual(["vscode"]);
    expect(parsed.integrations.some((integration) => integration.kind === "mcp" && integration.target === "vscode" && integration.configPath?.endsWith(".vscode/mcp.json"))).toBe(true);
  });

  it("preserves state-only initialization behind init --state-only", () => {
    const root = createFixtureRepo();
    const init = execFileSync(CLI[0]!, [...CLI.slice(1), "init", "--state-only", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const parsed = JSON.parse(init) as { rootPath: string; kairnDir: string; scan: { files: unknown[] } };

    expect(fs.realpathSync(parsed.rootPath)).toBe(fs.realpathSync(root));
    expect(parsed.kairnDir.endsWith(".kairn")).toBe(true);
    expect(parsed.scan.files.length).toBeGreaterThan(0);
  });

  it("emits wizard-shaped JSON from init by default", () => {
    const root = createFixtureRepo();
    const init = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "init", "--choice", "doctor", "--yes", "--no-index", "--root", root, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );
    const parsed = JSON.parse(init) as { choice?: string; integrations?: unknown[]; scan?: unknown };

    expect(parsed.choice).toBe("doctor");
    expect(Array.isArray(parsed.integrations)).toBe(true);
    expect(parsed.scan).toBeUndefined();
  });

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

  it("passes through Codex skip git repo checks for disposable workspaces", () => {
    const args = codexExecArgs({
      root: "/repo",
      prompt: "identify source files",
      sandbox: "danger-full-access",
      enableHooks: false,
      skipGitRepoCheck: true
    });

    expect(args).toContain("--skip-git-repo-check");
    expect(args.indexOf("--skip-git-repo-check")).toBeLessThan(args.indexOf("--cd"));
  });

  it("builds a bounded official no-diff recovery prompt without widening scope", () => {
    const task = [
      "Selected verification tests from SWE-Bench Pro metadata: tests/test_redhat.py",
      "Fix the issue in production source only. Do not edit tests."
    ].join("\n");
    const session = {
      id: "task_1",
      rootPath: "/repo",
      task,
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      filesShown: [],
      symbolsShown: [],
      commandsRun: [],
      diffsObserved: [],
      watchEvents: [],
      risks: [],
      verificationHints: []
    };
    const prime = {
      task,
      session,
      profile: "generic" as const,
      content: "# Kairn Fix Guardrail",
      files: ["scanner/redhatbase.go"],
      tokenEstimate: 40,
      quality: {
        score: 60,
        action: "shrink" as const,
        reasons: [],
        topScore: 100,
        topGap: 100,
        exactPathMentioned: false,
        expectedSavingsRisk: "low" as const
      },
      contextDecision: {
        action: "shrink" as const,
        score: 60,
        reasons: [],
        topScore: 100,
        topGap: 100,
        language: "go" as const,
        exactPathMentioned: false,
        estimatedContextCost: 400,
        expectedSavingsRisk: "low" as const,
        debugSignal: false,
        easyTaskSignal: false,
        wrongContextRisk: false,
        recommendedDelivery: "one_file_directive" as const,
        taskFrame: "official_patch" as const,
        directiveStyle: "scope_guardrail" as const
      },
      editScope: {
        initialEditFiles: ["scanner/redhatbase.go"],
        readOnlyFiles: ["scanner/redhatbase_test.go"],
        allowedExpansionTriggers: ["only if failure names another production file"],
        forbiddenEditPatterns: ["tests/**", "docs/**"],
        scopeConfidence: "high" as const,
        scopeSource: "official_harness" as const,
        reason: "official metadata supplied production scope",
        strictBoundary: true,
        dynamic: true as const
      },
      warnings: [],
      suggestedCommands: []
    };
    const retry = shouldRetryCodexNoDiff({
      task,
      interactive: false,
      exitCode: 0,
      changedFiles: [],
      prime
    });
    expect(retry).toBe(true);

    const prompt = buildCodexNoDiffRecoveryPrompt({
      task,
      prime
    });
    expect(prompt).toContain("previous agent run exited without a production source diff");
    expect(prompt).toContain("Edit scope: scanner/redhatbase.go");
    expect(prompt).toContain("Do not edit tests");
    expect(prompt).not.toContain("broad scans");
  });

  it("builds a bounded official partial-scope recovery prompt for missing required files", () => {
    const task = [
      "Selected verification tests from SWE-Bench Pro metadata: TestDatabaseFailover",
      "Fix database failover when multiple database services share the same service name.",
      "Fix the issue in production source only. Do not edit tests."
    ].join("\n");
    const session = {
      id: "task_db",
      rootPath: "/repo",
      task,
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      filesShown: [],
      symbolsShown: [],
      commandsRun: [],
      diffsObserved: [],
      watchEvents: [],
      risks: [],
      verificationHints: []
    };
    const prime = {
      task,
      session,
      profile: "generic" as const,
      content: "# Kairn Paired Scope",
      files: [
        "api/types/databaseserver.go",
        "lib/srv/db/proxyserver.go",
        "lib/reversetunnel/fake.go",
        "tool/tsh/db.go"
      ],
      tokenEstimate: 80,
      quality: {
        score: 70,
        action: "shrink" as const,
        reasons: [],
        topScore: 100,
        topGap: 100,
        exactPathMentioned: false,
        expectedSavingsRisk: "low" as const
      },
      contextDecision: {
        action: "shrink" as const,
        score: 70,
        reasons: [],
        topScore: 100,
        topGap: 100,
        language: "go" as const,
        exactPathMentioned: false,
        estimatedContextCost: 500,
        expectedSavingsRisk: "low" as const,
        debugSignal: true,
        easyTaskSignal: false,
        wrongContextRisk: false,
        recommendedDelivery: "multi_file_directive" as const,
        taskFrame: "official_patch" as const,
        directiveStyle: "scope_guardrail" as const
      },
      editScope: {
        initialEditFiles: [
          "api/types/databaseserver.go",
          "lib/srv/db/proxyserver.go",
          "lib/reversetunnel/fake.go",
          "tool/tsh/db.go"
        ],
        readOnlyFiles: [],
        allowedExpansionTriggers: ["only if failure names another production file"],
        forbiddenEditPatterns: ["tests/**", "docs/**"],
        scopeConfidence: "high" as const,
        scopeSource: "official_harness" as const,
        reason: "official metadata supplied production scope",
        strictBoundary: true,
        dynamic: true as const
      },
      warnings: [],
      suggestedCommands: []
    };
    const changedFiles = ["api/types/databaseserver.go", "lib/srv/db/proxyserver.go"];
    const missing = missingRequiredScopeFiles({
      task,
      interactive: false,
      exitCode: 0,
      prime,
      changedFiles
    });

    expect(missing).toEqual(["lib/reversetunnel/fake.go", "tool/tsh/db.go"]);
    expect(shouldRetryCodexPartialScope({
      task,
      interactive: false,
      exitCode: 0,
      prime,
      changedFiles
    })).toBe(true);

    const prompt = buildCodexPartialScopeRecoveryPrompt({
      task,
      prime,
      changedFiles,
      missingFiles: missing
    });
    expect(prompt).toContain("previous agent run produced a partial production diff");
    expect(prompt).toContain("Already changed: api/types/databaseserver.go, lib/srv/db/proxyserver.go");
    expect(prompt).toContain("Missing required edits: lib/reversetunnel/fake.go, tool/tsh/db.go");
    expect(prompt).toContain("Do not restart from scratch");
    expect(prompt).not.toContain("node_modules");
  });

  it("does not widen official no-diff recovery scope with noisy emitted files", () => {
    const task = [
      "Title: HSM/KMS test configuration logic is duplicated across backend test files.",
      "Selected verification tests from SWE-Bench Pro metadata: TestBackends, TestBackends/fake_gcp_kms, TestBackends/fake_aws_kms",
      "Fix the issue in production source only. Avoid broad scans once the relevant source surface is known."
    ].join("\n");
    const session = {
      id: "task_hsm",
      rootPath: "/repo",
      task,
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      filesShown: [],
      symbolsShown: [],
      commandsRun: [],
      diffsObserved: [],
      watchEvents: [],
      risks: [],
      verificationHints: []
    };
    const prompt = buildCodexNoDiffRecoveryPrompt({
      task,
      prime: {
        task,
        session,
        profile: "generic" as const,
        content: "# Kairn Fix Guardrail",
        files: ["lib/auth/keystore/pkcs11.go", "api/utils/sshutils/test.go"],
        tokenEstimate: 40,
        quality: {
          score: 60,
          action: "shrink" as const,
          reasons: [],
          topScore: 100,
          topGap: 100,
          exactPathMentioned: false,
          expectedSavingsRisk: "low" as const
        },
        contextDecision: {
          action: "shrink" as const,
          score: 60,
          reasons: [],
          topScore: 100,
          topGap: 100,
          language: "go" as const,
          exactPathMentioned: false,
          estimatedContextCost: 400,
          expectedSavingsRisk: "low" as const,
          debugSignal: false,
          easyTaskSignal: false,
          wrongContextRisk: false,
          recommendedDelivery: "multi_file_directive" as const,
          taskFrame: "official_patch" as const,
          directiveStyle: "scope_guardrail" as const
        },
        editScope: {
          initialEditFiles: ["lib/auth/keystore/pkcs11.go"],
          readOnlyFiles: ["api/utils/sshutils/test.go"],
          allowedExpansionTriggers: ["only if failure names another production file"],
          forbiddenEditPatterns: ["tests/**", "docs/**"],
          scopeConfidence: "high" as const,
          scopeSource: "official_harness" as const,
          reason: "official metadata supplied production scope",
          strictBoundary: true,
          dynamic: true as const
        },
        warnings: [],
        suggestedCommands: []
      }
    });

    expect(prompt).toContain("Edit scope: lib/auth/keystore/pkcs11.go");
    expect(prompt).not.toContain("Edit scope: lib/auth/keystore/pkcs11.go, api/utils/sshutils/test.go");
  });

  it("ignores Kairn-owned files when checking whether Codex produced a diff", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-cli-diff-"));
    execFileSync("git", ["init"], { cwd: root });
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex/hooks.json"), "{}\n");
    expect(relevantWorkspaceDiffFiles(root)).toEqual([]);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/app.ts"), "export const value = 1;\n");
    expect(relevantWorkspaceDiffFiles(root)).toContain("src/app.ts");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
