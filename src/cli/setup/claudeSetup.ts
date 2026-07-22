// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { splitCommandLine } from "../../utils/command.js";
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
  if (existing.hooks !== undefined && !isRecord(existing.hooks)) {
    throw new Error(`${configPath} field "hooks" must contain a JSON object; the existing file was left unchanged.`);
  }
  const hooks = existing.hooks ?? {};
  const nextHooks = {
    ...hooks,
    UserPromptSubmit: mergeHookEntries(hooks.UserPromptSubmit, hookGroup("UserPromptSubmit"), "UserPromptSubmit"),
    PostToolUse: mergeHookEntries(hooks.PostToolUse, hookGroup("PostToolUse", "*"), "PostToolUse"),
    PostToolUseFailure: mergeHookEntries(hooks.PostToolUseFailure, hookGroup("PostToolUseFailure", "*"), "PostToolUseFailure"),
    PreCompact: mergeHookEntries(hooks.PreCompact, hookGroup("PreCompact"), "PreCompact")
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
  return `KAIRN_HOOK_OWNER=kairn-claude-v1 ${command} hook --source claude --root "\${CLAUDE_PROJECT_DIR:-$PWD}" --event ${shellQuote(eventName)} --hook-output ${
    eventName === "UserPromptSubmit" ? "full-prime" : "failure-only"
  }`;
}

function mergeHookEntries(existing: unknown, entry: Record<string, unknown>, eventName: string): unknown[] {
  const entries = Array.isArray(existing)
    ? existing.filter((item) => !isKairnOwnedClaudeHookEntry(item, eventName))
    : existing === undefined ? [] : [existing];
  return [...entries, entry];
}

export function isKairnOwnedClaudeHookEntry(value: unknown, eventName: string): boolean {
  const spec = claudeHookSpec(eventName);
  if (!spec || !isRecord(value)) return false;
  const expectedGroupKeys = spec.matcher ? ["hooks", "matcher"] : ["hooks"];
  if (!hasExactKeys(value, expectedGroupKeys)) return false;
  if (spec.matcher && value.matcher !== spec.matcher) return false;
  if (!Array.isArray(value.hooks) || value.hooks.length !== 1) return false;

  const hook = value.hooks[0];
  return isRecord(hook) &&
    hasExactKeys(hook, ["command", "type"]) &&
    hook.type === "command" &&
    typeof hook.command === "string" &&
    isKairnOwnedClaudeHookCommand(hook.command, eventName, spec.output);
}

export function hasKairnOwnedClaudeHooks(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([eventName, configured]) => {
    const entries = Array.isArray(configured) ? configured : [configured];
    return entries.some((entry) => isKairnOwnedClaudeHookEntry(entry, eventName));
  });
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

function isKairnOwnedClaudeHookCommand(command: string, eventName: string, output: string): boolean {
  const tokens = splitCommandLine(command);
  const hookIndex = tokens.indexOf("hook");
  if (hookIndex < 1 || tokens.lastIndexOf("hook") !== hookIndex) return false;
  const expectedTail = [
    "hook",
    "--source", "claude",
    "--root", "${CLAUDE_PROJECT_DIR:-$PWD}",
    "--event", eventName,
    "--hook-output", output
  ];
  if (tokens.length - hookIndex !== expectedTail.length) return false;
  if (!expectedTail.every((token, index) => tokens[hookIndex + index] === token)) return false;

  const invocation = tokens.slice(0, hookIndex);
  if (invocation[0] === "KAIRN_HOOK_OWNER=kairn-claude-v1") return invocation.length >= 2;
  return isLegacyKairnInvocation(invocation);
}

function isLegacyKairnInvocation(tokens: string[]): boolean {
  if (tokens.length === 1) return isKairnExecutable(tokens[0]!);
  if (tokens.length !== 2) return false;

  const executable = executableBase(tokens[0]!);
  if (["npm", "npx", "pnpm", "yarn"].includes(executable)) return isKairnExecutable(tokens[1]!);
  if (!["bun", "deno", "node", "nodejs", "tsx"].includes(executable)) return false;
  const entrypoint = tokens[1]!.replace(/\\/g, "/").toLowerCase();
  return /\/(?:kairn|usekairn)(?:\/|$)/.test(entrypoint) && /\/cli\.(?:cjs|js|mjs|ts|tsx)$/.test(entrypoint);
}

function isKairnExecutable(value: string): boolean {
  const executable = executableBase(value);
  return executable === "kairn" || executable === "usekairn";
}

function executableBase(value: string): string {
  return path.basename(value.replace(/\\/g, "/")).toLowerCase().replace(/\.(?:bat|cmd|com|exe)$/i, "");
}

function claudeHookSpec(eventName: string): { matcher?: string; output: "failure-only" | "full-prime" } | undefined {
  if (eventName === "UserPromptSubmit") return { output: "full-prime" };
  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return { matcher: "*", output: "failure-only" };
  if (eventName === "PreCompact") return { output: "failure-only" };
  return undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
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
