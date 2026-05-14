import fs from "node:fs";
import path from "node:path";
import { resolveKairnMcpCommand } from "./codexSetup.js";

export type ClaudeSetupResult = {
  rootPath: string;
  configPath: string;
  hooksInstalled: string[];
};

export function writeClaudeHooksSetup(input: { root: string }): ClaudeSetupResult {
  const rootPath = path.resolve(input.root);
  const claudeDir = path.join(rootPath, ".claude");
  const configPath = path.join(claudeDir, "settings.local.json");
  fs.mkdirSync(claudeDir, { recursive: true });

  const existing = readJsonObject(configPath);
  const hooks = isRecord(existing.hooks) ? existing.hooks : {};
  const nextHooks = {
    ...hooks,
    UserPromptSubmit: mergeHookEntries(hooks.UserPromptSubmit, hookGroup("UserPromptSubmit")),
    PostToolUse: mergeHookEntries(hooks.PostToolUse, hookGroup("PostToolUse", "*")),
    PostToolUseFailure: mergeHookEntries(hooks.PostToolUseFailure, hookGroup("PostToolUseFailure", "*")),
    PreCompact: mergeHookEntries(hooks.PreCompact, hookGroup("PreCompact"))
  };
  const next = {
    ...existing,
    hooks: nextHooks
  };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);

  return {
    rootPath,
    configPath,
    hooksInstalled: ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PreCompact"]
  };
}

function hookGroup(eventName: string, matcher?: string): Record<string, unknown> {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: buildClaudeHookCommand(eventName)
      }
    ]
  };
}

function buildClaudeHookCommand(eventName: string): string {
  const kairnCommand = resolveKairnMcpCommand();
  const command = shellCommand([kairnCommand.command, ...kairnCommand.argsPrefix]);
  return `${command} hook --source claude --root "\${CLAUDE_PROJECT_DIR:-$PWD}" --event ${shellQuote(eventName)} --hook-output ${
    eventName === "UserPromptSubmit" ? "full-prime" : "failure-only"
  }`;
}

function mergeHookEntries(existing: unknown, entry: Record<string, unknown>): unknown[] {
  const entries = Array.isArray(existing) ? existing.filter((item) => !containsKairnCommand(item)) : [];
  return [...entries, entry];
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

function containsKairnCommand(value: unknown): boolean {
  if (typeof value === "string") return /kairn|KAIRN_CMD/i.test(value);
  if (Array.isArray(value)) return value.some(containsKairnCommand);
  if (isRecord(value)) return Object.values(value).some(containsKairnCommand);
  return false;
}

function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
