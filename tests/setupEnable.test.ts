import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enableKairn, planKairnEnable } from "../src/cli/setup/enable.js";
import { writeCodexSetup } from "../src/cli/setup/codexSetup.js";
import { writeClaudeHooksSetup } from "../src/cli/setup/claudeSetup.js";
import { copilotServerNameForRoot, writeMcpClientSetup } from "../src/cli/setup/mcpSetup.js";
import { removeKairnSetup } from "../src/cli/setup/remove.js";
import { runDoctor } from "../src/doctor/doctor.js";
import { fixDoctorIssues } from "../src/doctor/fix.js";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { resolveSemanticRetrieverConfig } from "../src/config/semantic.js";
import { createFixtureRepo } from "./helpers.js";
import { ensureKairnInternalStateExcluded } from "../src/cli/helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("source-first setup and enable", () => {
  it("reads the CLI version from package metadata", () => {
    const packageVersion = (JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { version: string }).version;
    const cliVersion = execFileSync(CLI[0]!, [...CLI.slice(1), "--version"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();

    expect(cliVersion).toBe(packageVersion);
  });

  it("accepts the deprecated savings alias but returns canonical source-first mode", () => {
    const root = createFixtureRepo();
    const result = writeCodexSetup({
      root,
      mode: "savings",
      primeProfile: "auto",
      hookOutput: "full-prime",
      postToolHookOutput: "failure-only",
      primeBudget: 900
    });

    expect(result.mode).toBe("source-first");
    expect(result.deprecatedModeAlias).toBe("savings");
    expect(fs.readFileSync(result.hooksPath, "utf8")).toContain("Priming Kairn context");

    const cliResult = spawnSync(
      CLI[0]!,
      [...CLI.slice(1), "setup", "codex", "--root", root, "--mode", "savings", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    expect(cliResult.status).toBe(0);
    expect(JSON.parse(cliResult.stdout) as { mode: string }).toHaveProperty("mode", "source-first");
    expect(cliResult.stderr).toContain("--mode savings is deprecated");
  });

  it("keeps dry-run read-only", async () => {
    const root = createFixtureRepo();
    const plan = planKairnEnable({ root, agents: "codex,vscode,generic", pathValue: "" });
    const result = await enableKairn({ plan, dryRun: true });

    expect(result.targets).toEqual(["codex", "vscode", "generic"]);
    expect(result.agents.find((agent) => agent.target === "generic")?.status).toBe("action-required");
    expect(result.manualConfigs[0]?.clientConfig).toHaveProperty("mcpServers.kairn");
    expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".vscode"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".kairn"))).toBe(false);
  });

  it("keeps normal enable deterministic and never installs a semantic model", async () => {
    const root = createFixtureRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-enable-model-home-"));
    const plan = planKairnEnable({ root, agents: "codex", pathValue: "", homeDir });
    const result = await enableKairn({ plan, index: false, installModel: true });

    expect(result.semanticPreview).toBe(false);
    expect(result.semanticModelInstalled).toBe(false);
    expect(result.semanticModelDownload.required).toBe(false);
    expect(resolveSemanticRetrieverConfig(root).mode).toBe("legacy");
    expect(fs.existsSync(path.join(homeDir, ".kairn", "models"))).toBe(false);
  });

  it("enables semantic shadow evaluation only when preview is explicit", async () => {
    const root = createFixtureRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-preview-model-home-"));
    const plan = planKairnEnable({
      root,
      agents: "codex",
      pathValue: "",
      homeDir,
      semanticPreview: true
    });
    const result = await enableKairn({ plan, index: false, installModel: false });

    expect(result.semanticPreview).toBe(true);
    expect(result.semanticModelInstalled).toBe(false);
    expect(result.semanticModelDownload.required).toBe(true);
    expect((JSON.parse(fs.readFileSync(path.join(root, ".kairn", "config.json"), "utf8")) as {
      semantic: { mode: string };
    }).semantic.mode).toBe("shadow");
  });

  it("fails closed before setup writes when semantic serving has no local model", async () => {
    const root = createFixtureRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-serving-model-home-"));
    const plan = planKairnEnable({
      root,
      agents: "codex",
      pathValue: "",
      homeDir,
      semanticServing: true
    });

    expect(plan.semanticMode).toBe("semantic");
    await expect(enableKairn({ plan, index: false, installModel: false }))
      .rejects.toThrow(/requires the local model/i);
    expect(fs.existsSync(path.join(root, ".kairn"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
  });

  it("falls back to generic MCP guidance and still indexes when no supported client is detected", async () => {
    const root = createFixtureRepo();
    const instructionsPath = path.join(root, "AGENTS.md");
    const originalInstructions = "# Existing repository instructions\n\nKeep this file unchanged.\n";
    fs.writeFileSync(instructionsPath, originalInstructions, "utf8");
    const gitStatusBefore = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
    const plan = planKairnEnable({ root, pathValue: "" });

    expect(plan.targets).toEqual(["generic"]);
    expect(plan.manualConfigs).toHaveLength(1);
    expect(plan.manualConfigs[0]?.clientConfig).toHaveProperty("mcpServers.kairn");

    const result = await enableKairn({ plan });

    expect(result.indexed).toBe(true);
    expect(result.indexMode).toBe("inventory");
    expect(result.doctor?.checks.some((check) => check.id === "index_state")).toBe(true);
    expect(result.agents.find((agent) => agent.target === "generic")).toEqual(expect.objectContaining({
      detected: true,
      status: "action-required"
    }));
    expect(fs.existsSync(path.join(root, ".kairn"))).toBe(true);
    expect(fs.readFileSync(instructionsPath, "utf8")).toBe(originalInstructions);
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" })).toBe(gitStatusBefore);
  });

  it("keeps explicit generic enable read-only outside Kairn state without indexing", async () => {
    const root = createFixtureRepo();
    const instructionsPath = path.join(root, "AGENTS.md");
    const originalInstructions = "# Existing repository instructions\n";
    fs.writeFileSync(instructionsPath, originalInstructions, "utf8");
    const plan = planKairnEnable({ root, agents: "generic", pathValue: "" });

    const result = await enableKairn({ plan, index: false });

    expect(result.agents.find((agent) => agent.target === "generic")?.status).toBe("action-required");
    expect(fs.readFileSync(instructionsPath, "utf8")).toBe(originalInstructions);
    expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".vscode"))).toBe(false);
  });

  it("builds an immediately usable inventory and returns doctor results by default", async () => {
    const root = createFixtureRepo();
    const plan = planKairnEnable({ root, agents: "codex", pathValue: "" });
    const result = await enableKairn({ plan });

    expect(result.indexMode).toBe("inventory");
    expect(result.indexed).toBe(true);
    expect(result.deepIndexStarted).toBe(false);
    expect(result.doctor?.checks.some((check) => check.id === "index_state")).toBe(true);
    expect(fs.existsSync(path.join(root, ".kairn"))).toBe(true);
  });

  it("reuses a fresh full index instead of replacing it with an inventory on repeat enable", async () => {
    const root = createFixtureRepo();
    ensureKairnInternalStateExcluded(root);
    const runtime = new KairnRuntime(root);
    let fullStatus: ReturnType<KairnRuntime["getIndexStatus"]>;
    try {
      await runtime.init();
      fullStatus = runtime.getIndexStatus();
    } finally {
      runtime.close();
    }
    expect(fullStatus.symbolCount).toBeGreaterThan(0);
    expect(fullStatus.freshness).toEqual(expect.objectContaining({ stale: false }));

    const plan = planKairnEnable({ root, agents: "generic", pathValue: "" });
    const result = await enableKairn({ plan });

    expect(result.indexed).toBe(true);
    expect(result.indexMode).toBe("reuse");
    expect(result.deepIndexStarted).toBe(false);
    const reopened = new KairnRuntime(root);
    try {
      const repeatedStatus = reopened.getIndexStatus();
      expect(repeatedStatus.symbolCount).toBe(fullStatus.symbolCount);
      expect(repeatedStatus.semanticChunkCount).toBe(fullStatus.semanticChunkCount);
    } finally {
      reopened.close();
    }
  });

  it("exposes idempotent top-level enable and disable commands", () => {
    const root = createFixtureRepo();
    const args = [...CLI.slice(1), "enable", "--root", root, "--agents", "codex,vscode", "--yes", "--no-index", "--json"];
    const first = JSON.parse(execFileSync(CLI[0]!, args, { cwd: process.cwd(), encoding: "utf8" })) as {
      agents: Array<{ target: string; status: string }>;
      indexed: boolean;
    };
    const second = JSON.parse(execFileSync(CLI[0]!, args, { cwd: process.cwd(), encoding: "utf8" })) as {
      agents: Array<{ target: string; status: string }>;
    };
    const vscodeConfig = JSON.parse(fs.readFileSync(path.join(root, ".vscode", "mcp.json"), "utf8")) as {
      servers: Record<string, unknown>;
    };

    expect(first.indexed).toBe(false);
    expect(first.agents.filter((agent) => ["codex", "vscode"].includes(agent.target)).every((agent) => agent.status === "configured")).toBe(true);
    expect(second.agents.filter((agent) => ["codex", "vscode"].includes(agent.target)).every((agent) => agent.status === "configured")).toBe(true);
    expect(Object.keys(vscodeConfig.servers)).toEqual(["kairn"]);

    const removed = JSON.parse(execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "disable", "--root", root, "--delete-state", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    )) as { removed: string[]; stateDeleted: boolean };

    expect(removed.removed).toContain(path.join(".vscode", "mcp.json"));
    expect(removed.stateDeleted).toBe(true);
    expect(fs.existsSync(path.join(root, ".codex", "hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codex", "config.toml"))).toBe(false);
  });

  it("restores a pre-existing disabled Codex hooks flag on disable", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[features]\nhooks = false\n");
    const plan = planKairnEnable({ root, agents: "codex", pathValue: "" });

    await enableKairn({ plan, index: false });
    expect(fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8")).toContain("kairn:previous=false");

    execFileSync(CLI[0]!, [...CLI.slice(1), "disable", "--root", root], { cwd: process.cwd(), encoding: "utf8" });
    expect(fs.readFileSync(path.join(root, ".codex", "config.toml"), "utf8")).toBe("[features]\nhooks = false\n");
  });

  it("merges and rolls back Codex hooks without changing unrelated entries", () => {
    const root = createFixtureRepo();
    const hooksPath = path.join(root, ".codex", "hooks.json");
    const unrelatedPrompt = { hooks: [{ type: "command", command: "echo keep-prompt" }] };
    const unrelatedStop = { hooks: [{ type: "command", command: "echo keep-stop" }] };
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, `${JSON.stringify({
      metadata: { owner: "user" },
      hooks: {
        UserPromptSubmit: [unrelatedPrompt],
        Stop: [unrelatedStop]
      }
    }, null, 2)}\n`);

    const setup = writeCodexSetup({
      root,
      mode: "source-first",
      primeProfile: "auto",
      hookOutput: "full-prime",
      postToolHookOutput: "failure-only",
      primeBudget: 900
    });
    expect(setup.configConflict).toBeUndefined();
    const enabled = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      metadata: { owner: string };
      hooks: { UserPromptSubmit: unknown[]; Stop: unknown[] };
    };
    expect(enabled.metadata.owner).toBe("user");
    expect(enabled.hooks.UserPromptSubmit).toContainEqual(unrelatedPrompt);
    expect(enabled.hooks.UserPromptSubmit).toHaveLength(2);
    expect(enabled.hooks.Stop).toEqual([unrelatedStop]);

    const removed = removeKairnSetup({ root });
    const rolledBack = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      metadata: { owner: string };
      hooks: { UserPromptSubmit: unknown[]; Stop: unknown[] };
    };
    expect(removed.changed).toContain(".codex/hooks.json");
    expect(removed.removed).not.toContain(".codex/hooks.json");
    expect(rolledBack).toEqual({
      metadata: { owner: "user" },
      hooks: {
        UserPromptSubmit: [unrelatedPrompt],
        Stop: [unrelatedStop]
      }
    });
  });

  it("leaves a foreign same-key MCP server unchanged and reports action required", async () => {
    const root = createFixtureRepo();
    const configPath = path.join(root, ".vscode", "mcp.json");
    const original = `${JSON.stringify({
      servers: {
        kairn: { type: "stdio", command: "custom-context-server", args: ["serve"] },
        existing: { type: "stdio", command: "example", args: [] }
      }
    }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);

    const plan = planKairnEnable({ root, agents: "vscode", pathValue: "" });
    const result = await enableKairn({ plan, index: false });
    expect(result.agents.find((agent) => agent.target === "vscode")?.status).toBe("action-required");
    expect(result.agents.find((agent) => agent.target === "vscode")?.detail).toContain("non-Kairn command");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);

    const fixed = fixDoctorIssues({ rootPath: root, target: "all" });
    expect(fixed.skipped).toContainEqual(expect.objectContaining({ target: "vscode" }));
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    const removed = removeKairnSetup({ root });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(removed.skipped).toContainEqual(expect.objectContaining({ path: ".vscode/mcp.json" }));
  });

  it("keeps Copilot CLI user config isolated across two enabled repositories", async () => {
    const rootA = createFixtureRepo();
    const rootB = createFixtureRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-copilot-home-"));
    const configPath = path.join(homeDir, ".copilot", "mcp-config.json");
    const foreignLegacy = { type: "local", command: "foreign-context-server", args: ["serve"], tools: ["*"] };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ mcpServers: { kairn: foreignLegacy } }, null, 2)}\n`);

    const planA = planKairnEnable({ root: rootA, agents: "copilot-cli", pathValue: "", homeDir });
    await enableKairn({ plan: planA, index: false });
    const planB = planKairnEnable({ root: rootB, agents: "copilot-cli", pathValue: "", homeDir });
    await enableKairn({ plan: planB, index: false });

    const keyA = copilotServerNameForRoot(rootA);
    const keyB = copilotServerNameForRoot(rootB);
    const enabled = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { args?: string[]; command?: string }>;
    };
    expect(keyA).not.toBe(keyB);
    expect(enabled.mcpServers[keyA]?.args).toContain(rootA);
    expect(enabled.mcpServers[keyB]?.args).toContain(rootB);
    expect(enabled.mcpServers.kairn).toEqual(foreignLegacy);
    expect(planA.agents.find((agent) => agent.target === "copilot-cli")?.configuredBefore).toBe(false);
    expect(planB.agents.find((agent) => agent.target === "copilot-cli")?.configuredBefore).toBe(false);
    expect(planKairnEnable({ root: rootA, agents: "copilot-cli", pathValue: "", homeDir }).agents
      .find((agent) => agent.target === "copilot-cli")?.configuredBefore).toBe(true);
    expect(planKairnEnable({ root: rootB, agents: "copilot-cli", pathValue: "", homeDir }).agents
      .find((agent) => agent.target === "copilot-cli")?.configuredBefore).toBe(true);

    const runtime = new KairnRuntime(rootA);
    try {
      await runtime.initInventory();
      const report = runDoctor({ rootPath: rootA, runtime, target: "copilot-cli", homeDir });
      expect(report.checks.find((check) => check.id === "mcp_config")?.status).toBe("ok");
    } finally {
      runtime.close();
    }

    const entryBBeforeFix = enabled.mcpServers[keyB];
    const fixed = fixDoctorIssues({ rootPath: rootA, target: "copilot-cli", homeDir });
    expect(fixed.repaired).toContain("mcp:copilot-cli");
    const afterFix = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(afterFix.mcpServers[keyB]).toEqual(entryBBeforeFix);
    expect(afterFix.mcpServers.kairn).toEqual(foreignLegacy);

    removeKairnSetup({ root: rootB, homeDir });
    const afterRemovingB = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(afterRemovingB.mcpServers[keyA]).toBeTruthy();
    expect(afterRemovingB.mcpServers[keyB]).toBeUndefined();
    expect(afterRemovingB.mcpServers.kairn).toEqual(foreignLegacy);

    removeKairnSetup({ root: rootA, homeDir });
    const afterRemovingA = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(afterRemovingA.mcpServers).toEqual({ kairn: foreignLegacy });
  });

  it("recognizes and preserves a root-matching legacy Copilot kairn entry", async () => {
    const root = createFixtureRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-copilot-legacy-home-"));
    const configPath = path.join(homeDir, ".copilot", "mcp-config.json");
    const generated = writeMcpClientSetup({ root, client: "copilot-cli", writeInstructions: false, homeDir });
    const legacyEntry = {
      type: "local",
      command: generated.serverConfig.command,
      args: generated.serverConfig.args,
      env: generated.serverConfig.env,
      tools: ["*"]
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ mcpServers: { kairn: legacyEntry } }, null, 2)}\n`);

    const plan = planKairnEnable({ root, agents: "copilot-cli", pathValue: "", homeDir });
    expect(plan.agents.find((agent) => agent.target === "copilot-cli")?.configuredBefore).toBe(true);
    await enableKairn({ plan, index: false });

    const refreshed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(refreshed.mcpServers)).toEqual(["kairn"]);
    expect(refreshed.mcpServers.kairn).toEqual(legacyEntry);
  });

  it("does not overwrite a foreign Copilot entry at the repository key", async () => {
    const root = createFixtureRepo();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-copilot-conflict-home-"));
    const configPath = path.join(homeDir, ".copilot", "mcp-config.json");
    const repositoryKey = copilotServerNameForRoot(root);
    const original = `${JSON.stringify({
      mcpServers: {
        [repositoryKey]: { type: "local", command: "foreign-context-server", args: ["serve"], tools: ["*"] }
      }
    }, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);

    const plan = planKairnEnable({ root, agents: "copilot-cli", pathValue: "", homeDir });
    const result = await enableKairn({ plan, index: false });
    expect(result.agents.find((agent) => agent.target === "copilot-cli")?.status).toBe("action-required");
    expect(result.agents.find((agent) => agent.target === "copilot-cli")?.detail).toContain("non-Kairn command");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);

    const removed = removeKairnSetup({ root, homeDir });
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(removed.skipped).toContainEqual(expect.objectContaining({ path: configPath }));
  });

  it("does not replace a foreign Codex mcp_servers.kairn table", () => {
    const root = createFixtureRepo();
    const configPath = path.join(root, ".codex", "config.toml");
    const original = "[mcp_servers.kairn]\ncommand = \"foreign-context-server\"\nargs = [\"serve\"]\n";
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original);

    const setup = writeCodexSetup({
      root,
      mode: "hybrid",
      primeProfile: "auto",
      hookOutput: "mcp-brief",
      postToolHookOutput: "failure-only",
      primeBudget: 900
    });

    expect(setup.configConflict?.reason).toContain("non-Kairn command");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(root, ".codex", "hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "AGENTS.md"))).toBe(false);
  });

  it("advanced Claude setup replaces only structurally owned hook blocks", () => {
    const root = createFixtureRepo();
    const configPath = path.join(root, ".claude", "settings.local.json");
    const foreignMention = { hooks: [{ type: "command", command: "echo kairn is available" }] };
    const foreignEnvMention = { hooks: [{ type: "command", command: "printf '%s' \"$KAIRN_CMD\"" }] };
    const legacyOwned = {
      hooks: [{
        type: "command",
        command: "kairn hook --source claude --root \"${CLAUDE_PROJECT_DIR:-$PWD}\" --event UserPromptSubmit --hook-output full-prime"
      }]
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { UserPromptSubmit: [foreignMention, foreignEnvMention, legacyOwned] }
    }, null, 2)}\n`);

    writeClaudeHooksSetup({ root });
    const configured = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      permissions: unknown;
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };

    expect(configured.permissions).toEqual({ allow: ["Read"] });
    expect(configured.hooks.UserPromptSubmit).toContainEqual(foreignMention);
    expect(configured.hooks.UserPromptSubmit).toContainEqual(foreignEnvMention);
    expect(configured.hooks.UserPromptSubmit).toHaveLength(3);
    expect(configured.hooks.UserPromptSubmit.some((entry) =>
      entry.hooks[0]?.command.includes("KAIRN_HOOK_OWNER=kairn-claude-v1")
    )).toBe(true);
  });

  it.each([
    ["array", []],
    ["string", "run-my-hook"],
    ["null", null]
  ])("advanced Claude setup preserves and rejects a non-object hooks %s value", (_label, hooks) => {
    const root = createFixtureRepo();
    const configPath = path.join(root, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = `${JSON.stringify({ theme: "dark", hooks }, null, 2)}\n`;
    fs.writeFileSync(configPath, original);

    expect(() => writeClaudeHooksSetup({ root })).toThrow(/hooks.*must contain a JSON object.*left unchanged/i);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("disable removes exact Claude ownership while preserving foreign Kairn mentions", () => {
    const root = createFixtureRepo();
    const configPath = path.join(root, ".claude", "settings.local.json");
    writeClaudeHooksSetup({ root });
    const configured = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    const foreignMention = { hooks: [{ type: "command", command: "echo Kairn diagnostics" }] };
    const foreignEnvMention = { hooks: [{ type: "command", command: "echo $KAIRN_CMD" }] };
    configured.hooks.UserPromptSubmit = [
      foreignMention,
      foreignEnvMention,
      ...(configured.hooks.UserPromptSubmit ?? [])
    ];
    const foreignEvent = { hooks: [{ type: "command", command: "notify --topic kairn" }] };
    configured.hooks.Stop = [foreignEvent];
    fs.writeFileSync(configPath, `${JSON.stringify({ theme: "dark", ...configured }, null, 2)}\n`);

    const removed = removeKairnSetup({ root });
    const remaining = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      theme: string;
      hooks: Record<string, unknown[]>;
    };

    expect(removed.changed).toContain(".claude/settings.local.json");
    expect(remaining.theme).toBe("dark");
    expect(remaining.hooks.UserPromptSubmit).toEqual([foreignMention, foreignEnvMention]);
    expect(remaining.hooks.Stop).toEqual([foreignEvent]);
    expect(remaining.hooks.PostToolUse).toBeUndefined();
    expect(remaining.hooks.PostToolUseFailure).toBeUndefined();
    expect(remaining.hooks.PreCompact).toBeUndefined();
  });

  it("reports and clears deprecated savings setup metadata", () => {
    const root = createFixtureRepo();
    const codexDir = path.join(root, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), "# kairn:setup-mode=savings\n[features]\nhooks = true\n");
    fs.writeFileSync(path.join(codexDir, "hooks.json"), "{\"hooks\":{}}\n");

    const before = JSON.parse(execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "doctor", "--root", root, "--target", "codex", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    )) as { checks: Array<{ id: string; status: string; metadata?: { canonicalMode?: string } }> };
    expect(before.checks.find((check) => check.id === "setup_mode_migration")).toEqual(expect.objectContaining({
      status: "warn",
      metadata: expect.objectContaining({ canonicalMode: "source-first" })
    }));

    writeCodexSetup({
      root,
      mode: "source-first",
      primeProfile: "auto",
      hookOutput: "full-prime",
      postToolHookOutput: "failure-only",
      primeBudget: 900
    });
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8")).not.toContain("setup-mode=savings");
  });
});
