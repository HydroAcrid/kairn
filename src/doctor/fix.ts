// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasKairnOwnedClaudeHooks, writeClaudeHooksSetup } from "../cli/setup/claudeSetup.js";
import { hasKairnOwnedCodexMcpConfig, writeCodexSetup } from "../cli/setup/codexSetup.js";
import { existingCopilotServerNameForRoot, writeMcpClientSetup, type McpClientSetupTarget } from "../cli/setup/mcpSetup.js";
import type { CodexSetupMode } from "../types.js";
import type { DoctorTarget } from "./doctor.js";

export type DoctorFixResult = {
  rootPath: string;
  target: DoctorTarget;
  repaired: string[];
  skipped: Array<{ target: string; reason: string }>;
};

export function fixDoctorIssues(input: { rootPath: string; target?: DoctorTarget | undefined; homeDir?: string | undefined }): DoctorFixResult {
  const rootPath = path.resolve(input.rootPath);
  const target = input.target ?? "all";
  const result: DoctorFixResult = {
    rootPath,
    target,
    repaired: [],
    skipped: []
  };

  if (target === "generic") {
    result.skipped.push({
      target: "generic",
      reason: "Generic MCP config is not persisted; run kairn setup mcp --client generic --json and copy the config."
    });
    return result;
  }

  repairCodexIfNeeded(rootPath, target, result);
  repairMcpIfNeeded(rootPath, target, "vscode", result);
  repairMcpIfNeeded(rootPath, target, "claude-code", result);
  repairClaudeHooksIfNeeded(rootPath, target, result);
  repairMcpIfNeeded(rootPath, target, "gemini-cli", result);
  repairCopilotIfNeeded(rootPath, target, result, input.homeDir ?? os.homedir());

  if (target === "all" && result.repaired.length === 0 && result.skipped.length === 0) {
    result.skipped.push({
      target: "all",
      reason: "No Kairn-owned setup was found. Run kairn init to install an integration."
    });
  }

  return result;
}

function repairCodexIfNeeded(rootPath: string, target: DoctorTarget, result: DoctorFixResult): void {
  const explicit = target === "codex";
  if (!explicit && target !== "all") return;
  const state = getCodexState(rootPath);
  if (!explicit && !state.owned) return;
  if (state.hooksExists && !state.hooksOwned) {
    result.skipped.push({
      target: "codex",
      reason: "Refusing to rewrite .codex/hooks.json because it does not look Kairn-owned."
    });
    return;
  }

  const setup = writeCodexSetup({
    root: rootPath,
    mode: state.mode,
    primeProfile: "auto",
    hookOutput: state.mode === "hybrid" ? "mcp-brief" : "full-prime",
    postToolHookOutput: "failure-only",
    primeBudget: 900
  });
  if (setup.configConflict) {
    result.skipped.push({ target: "codex", reason: setup.configConflict.reason });
    return;
  }
  result.repaired.push(`codex:${state.mode}`);
}

function repairMcpIfNeeded(
  rootPath: string,
  target: DoctorTarget,
  client: Exclude<McpClientSetupTarget, "copilot-cli" | "generic">,
  result: DoctorFixResult
): void {
  const explicit = target === client;
  if (!explicit && target !== "all") return;
  if (!explicit && !hasClientMcpEntry(rootPath, client)) return;
  const setup = writeMcpClientSetup({
    root: rootPath,
    client,
    writeInstructions: true
  });
  if (setup.configConflict) {
    result.skipped.push({ target: client, reason: setup.configConflict.reason });
    return;
  }
  result.repaired.push(`mcp:${client}`);
}

function repairClaudeHooksIfNeeded(rootPath: string, target: DoctorTarget, result: DoctorFixResult): void {
  const explicit = false;
  if (!explicit && target !== "all" && target !== "claude-code") return;
  if (!hasKairnClaudeHooks(path.join(rootPath, ".claude", "settings.local.json"))) return;
  writeClaudeHooksSetup({ root: rootPath });
  result.repaired.push("claude-hooks");
}

function repairCopilotIfNeeded(rootPath: string, target: DoctorTarget, result: DoctorFixResult, homeDir: string): void {
  const explicit = target === "copilot-cli";
  if (!explicit && target !== "all") return;
  const configured = hasCopilotKairnForRoot(rootPath, homeDir);
  if (!configured) {
    if (explicit) {
      result.skipped.push({
        target: "copilot-cli",
        reason: "Copilot CLI MCP is user-level. Run kairn setup mcp --client copilot-cli --install-user to write it."
      });
    }
    return;
  }
  const setup = writeMcpClientSetup({
    root: rootPath,
    client: "copilot-cli",
    writeInstructions: true,
    homeDir,
    writeUserConfig: true
  });
  if (setup.configConflict) {
    result.skipped.push({ target: "copilot-cli", reason: setup.configConflict.reason });
    return;
  }
  result.repaired.push("mcp:copilot-cli");
}

function getCodexState(rootPath: string): {
  owned: boolean;
  hooksExists: boolean;
  hooksOwned: boolean;
  mode: CodexSetupMode;
} {
  const configPath = path.join(rootPath, ".codex", "config.toml");
  const hooksPath = path.join(rootPath, ".codex", "hooks.json");
  const config = readText(configPath);
  const hooks = readText(hooksPath);
  const hasMcp = hasKairnOwnedCodexMcpConfig(config);
  const hasPromptHook = /UserPromptSubmit/.test(hooks);
  const hooksOwned = !hooks || /kairn|KAIRN_CMD/i.test(hooks);
  return {
    owned: hasMcp || /KAIRN_CMD|(?:use)?kairn[^\n]*\bhook\b/i.test(hooks) || /codex_hooks|kairn:(?:owned|previous=false)/i.test(config),
    hooksExists: fs.existsSync(hooksPath),
    hooksOwned,
    mode: hasMcp ? hasPromptHook ? "hybrid" : "mcp-first" : "source-first"
  };
}

function hasClientMcpEntry(rootPath: string, client: Exclude<McpClientSetupTarget, "copilot-cli" | "generic">): boolean {
  if (client === "vscode") return hasMcpServerEntry(path.join(rootPath, ".vscode", "mcp.json"), "servers");
  if (client === "claude-code") return hasMcpServerEntry(path.join(rootPath, ".mcp.json"), "mcpServers");
  return hasMcpServerEntry(path.join(rootPath, ".gemini", "settings.json"), "mcpServers");
}

function hasMcpServerEntry(filePath: string, key: "servers" | "mcpServers"): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return Boolean(isRecord(parsed) && isRecord(parsed[key]) && "kairn" in parsed[key]);
  } catch {
    return false;
  }
}

function hasCopilotKairnForRoot(rootPath: string, homeDir: string): boolean {
  const filePath = path.join(homeDir, ".copilot", "mcp-config.json");
  return existingCopilotServerNameForRoot(filePath, rootPath) !== undefined;
}

function hasKairnClaudeHooks(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) && hasKairnOwnedClaudeHooks(parsed.hooks);
  } catch {
    return false;
  }
}

function readText(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
