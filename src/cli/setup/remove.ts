import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getKairnPaths } from "../../config/paths.js";
import { disableTelemetry } from "../../telemetry/config.js";

export type SetupRemoveResult = {
  rootPath: string;
  removed: string[];
  changed: string[];
  skipped: Array<{ path: string; reason: string }>;
  stateDeleted: boolean;
  telemetryDisabled: boolean;
};

export function removeKairnSetup(input: {
  root: string;
  deleteState?: boolean | undefined;
}): SetupRemoveResult {
  const rootPath = path.resolve(input.root);
  const result: SetupRemoveResult = {
    rootPath,
    removed: [],
    changed: [],
    skipped: [],
    stateDeleted: false,
    telemetryDisabled: false
  };

  removeCodexHooks(rootPath, result);
  removeCodexMcpConfig(rootPath, result);
  removeVscodeMcp(rootPath, result);
  removeProjectMcp(rootPath, result);
  removeGeminiMcp(rootPath, result);
  removeCopilotMcp(rootPath, result);
  removeClaudeHooks(rootPath, result);
  removeAgentsInstructions(rootPath, result);

  const kairnDir = getKairnPaths(rootPath).kairnDir;
  if (input.deleteState) {
    if (fs.existsSync(kairnDir)) {
      fs.rmSync(kairnDir, { recursive: true, force: true });
      result.removed.push(relative(rootPath, kairnDir));
      result.stateDeleted = true;
    }
  } else if (fs.existsSync(kairnDir)) {
    disableTelemetry(rootPath);
    result.telemetryDisabled = true;
    result.changed.push(".kairn/config.json");
  }

  cleanupEmptyDir(path.join(rootPath, ".codex"), rootPath, result);
  cleanupEmptyDir(path.join(rootPath, ".vscode"), rootPath, result);
  cleanupEmptyDir(path.join(rootPath, ".claude"), rootPath, result);
  cleanupEmptyDir(path.join(rootPath, ".gemini"), rootPath, result);

  return result;
}

export function formatSetupRemoveResult(result: SetupRemoveResult): string {
  return [
    "Kairn setup removed.",
    `Root: ${result.rootPath}`,
    "",
    "Removed",
    ...(result.removed.length ? result.removed.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Changed",
    ...(result.changed.length ? result.changed.map((item) => `- ${item}`) : ["- none"]),
    "",
    "Skipped",
    ...(result.skipped.length ? result.skipped.map((item) => `- ${item.path}: ${item.reason}`) : ["- none"]),
    "",
    result.stateDeleted
      ? "Local .kairn state was deleted."
      : "Local .kairn state was kept. Use --delete-state to remove indexes, metrics, ledger, and telemetry queue.",
    ""
  ].join("\n");
}

function removeCodexHooks(rootPath: string, result: SetupRemoveResult): void {
  const hooksPath = path.join(rootPath, ".codex", "hooks.json");
  if (!fs.existsSync(hooksPath)) return;
  const raw = fs.readFileSync(hooksPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (/kairn|KAIRN_CMD/i.test(raw)) {
      result.skipped.push({ path: ".codex/hooks.json", reason: "contains Kairn text but is not valid JSON; edit manually" });
    }
    return;
  }

  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return;
  const nextHooks: Record<string, unknown[]> = {};
  for (const [eventName, value] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[eventName] = [value];
      continue;
    }
    const kept = value.filter((entry) => !containsKairnCommand(entry));
    if (kept.length > 0) nextHooks[eventName] = kept;
  }

  if (Object.keys(nextHooks).length === Object.keys(parsed.hooks).length && JSON.stringify(nextHooks) === JSON.stringify(parsed.hooks)) {
    return;
  }

  if (Object.keys(nextHooks).length === 0) {
    fs.rmSync(hooksPath, { force: true });
    result.removed.push(".codex/hooks.json");
    return;
  }

  fs.writeFileSync(hooksPath, `${JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2)}\n`);
  result.changed.push(".codex/hooks.json");
}

function removeCodexMcpConfig(rootPath: string, result: SetupRemoveResult): void {
  const configPath = path.join(rootPath, ".codex", "config.toml");
  if (!fs.existsSync(configPath)) return;
  const raw = fs.readFileSync(configPath, "utf8");
  const next = raw.replace(/(^|\n)\[mcp_servers\.kairn\]\n[\s\S]*?(?=\n\[|$)/, "$1").trimEnd();
  if (next === raw.trimEnd()) return;
  if (!next.trim()) {
    fs.rmSync(configPath, { force: true });
    result.removed.push(".codex/config.toml");
    return;
  }
  fs.writeFileSync(configPath, `${next}\n`);
  result.changed.push(".codex/config.toml");
}

function removeVscodeMcp(rootPath: string, result: SetupRemoveResult): void {
  const configPath = path.join(rootPath, ".vscode", "mcp.json");
  removeMcpServerFromJson({
    rootPath,
    filePath: configPath,
    result,
    serverKey: "servers",
    relativePath: ".vscode/mcp.json"
  });
}

function removeProjectMcp(rootPath: string, result: SetupRemoveResult): void {
  removeMcpServerFromJson({
    rootPath,
    filePath: path.join(rootPath, ".mcp.json"),
    result,
    serverKey: "mcpServers",
    relativePath: ".mcp.json"
  });
}

function removeGeminiMcp(rootPath: string, result: SetupRemoveResult): void {
  removeMcpServerFromJson({
    rootPath,
    filePath: path.join(rootPath, ".gemini", "settings.json"),
    result,
    serverKey: "mcpServers",
    relativePath: ".gemini/settings.json"
  });
}

function removeCopilotMcp(rootPath: string, result: SetupRemoveResult): void {
  const configPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
  if (!fs.existsSync(configPath)) return;
  const raw = fs.readFileSync(configPath, "utf8");
  if (!raw.includes(rootPath)) return;
  removeMcpServerFromJson({
    rootPath,
    filePath: configPath,
    result,
    serverKey: "mcpServers",
    relativePath: configPath
  });
}

function removeMcpServerFromJson(input: {
  rootPath: string;
  filePath: string;
  result: SetupRemoveResult;
  serverKey: "servers" | "mcpServers";
  relativePath: string;
}): void {
  const { filePath, result, serverKey, relativePath } = input;
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (/kairn/i.test(raw)) {
      result.skipped.push({ path: relativePath, reason: "contains Kairn text but is not valid JSON; edit manually" });
    }
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed[serverKey]) || !("kairn" in parsed[serverKey])) return;
  const servers = { ...parsed[serverKey] };
  delete servers.kairn;
  const next: Record<string, unknown> = { ...parsed, [serverKey]: servers };
  if (Object.keys(servers).length === 0) delete next[serverKey];
  if (Object.keys(next).length === 0) {
    fs.rmSync(filePath, { force: true });
    result.removed.push(relativePath);
    return;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  result.changed.push(relativePath);
}

function removeClaudeHooks(rootPath: string, result: SetupRemoveResult): void {
  const configPath = path.join(rootPath, ".claude", "settings.local.json");
  if (!fs.existsSync(configPath)) return;
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (/kairn/i.test(raw)) {
      result.skipped.push({ path: ".claude/settings.local.json", reason: "contains Kairn text but is not valid JSON; edit manually" });
    }
    return;
  }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return;
  const nextHooks: Record<string, unknown[]> = {};
  for (const [eventName, value] of Object.entries(parsed.hooks)) {
    const entries = Array.isArray(value) ? value : [value];
    const kept = entries.filter((entry) => !containsKairnCommand(entry));
    if (kept.length > 0) nextHooks[eventName] = kept;
  }
  const next: Record<string, unknown> = { ...parsed, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0) delete next.hooks;
  if (Object.keys(next).length === 0) {
    fs.rmSync(configPath, { force: true });
    result.removed.push(".claude/settings.local.json");
    return;
  }
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  result.changed.push(".claude/settings.local.json");
}

function removeAgentsInstructions(rootPath: string, result: SetupRemoveResult): void {
  const agentsPath = path.join(rootPath, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) return;
  const raw = fs.readFileSync(agentsPath, "utf8");
  const next = raw.replace(/<!-- kairn:mcp-first:start -->[\s\S]*?<!-- kairn:mcp-first:end -->\n?/g, "").trimEnd();
  if (next === raw.trimEnd()) return;
  if (!next.trim()) {
    fs.rmSync(agentsPath, { force: true });
    result.removed.push("AGENTS.md");
    return;
  }
  fs.writeFileSync(agentsPath, `${next}\n`);
  result.changed.push("AGENTS.md");
}

function cleanupEmptyDir(dirPath: string, rootPath: string, result: SetupRemoveResult): void {
  try {
    if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
      result.removed.push(relative(rootPath, dirPath));
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function containsKairnCommand(value: unknown): boolean {
  if (typeof value === "string") return /kairn|KAIRN_CMD/i.test(value);
  if (Array.isArray(value)) return value.some(containsKairnCommand);
  if (isRecord(value)) return Object.values(value).some(containsKairnCommand);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relative(rootPath: string, filePath: string): string {
  return path.relative(rootPath, filePath) || ".";
}
