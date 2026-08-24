// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { CanonicalCodexSetupMode, CodexSetupMode, HookOutputProfile, PrimeProfile } from "../../types.js";
import { commandInvocation } from "../../utils/command.js";
import { writeMcpInstructionsSetup } from "./mcpInstructions.js";

export function writeCodexSetup(input: {
  root: string;
  mode: CodexSetupMode;
  primeProfile: PrimeProfile;
  hookOutput: HookOutputProfile;
  postToolHookOutput: HookOutputProfile;
  primeBudget: number;
  sessionId?: string | undefined;
}) {
  const rootPath = path.resolve(input.root);
  const mode = normalizeCodexSetupMode(input.mode);
  const codexDir = path.join(rootPath, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const hasMcp = mode === "mcp-first" || mode === "hybrid";
  const existingMcpBlock = hasMcp ? findTomlTableBlock(existingConfig, "mcp_servers.kairn") : undefined;
  const hooksMerge = mergeCodexHooksConfig(
    fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, "utf8") : "",
    buildCodexHooksConfig({ ...input, mode })
  );
  const configConflict = existingMcpBlock && !isKairnOwnedCodexMcpBlock(existingMcpBlock)
    ? {
        path: configPath,
        reason: "Codex already defines mcp_servers.kairn with a non-Kairn command; the existing table was left unchanged."
      }
    : hooksMerge.conflict
      ? { path: hooksPath, reason: hooksMerge.conflict }
      : undefined;

  if (configConflict) {
    return {
      rootPath,
      configPath,
      hooksPath,
      mcpConfigured: false,
      mcpServerName: undefined,
      instructionsPath: undefined,
      mode,
      deprecatedModeAlias: input.mode === "savings" ? "savings" as const : undefined,
      primeProfile: input.primeProfile,
      hookOutput: input.hookOutput,
      postToolHookOutput: input.postToolHookOutput,
      primeBudget: input.primeBudget,
      sessionId: input.sessionId,
      configConflict
    };
  }

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configPath, buildCodexConfig({ ...input, mode, rootPath, existingConfig }));
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooksMerge.value, null, 2)}\n`);
  const instructions = hasMcp ? writeMcpInstructionsSetup({ root: rootPath, mode: mode === "hybrid" ? "hybrid" : "mcp-first" }) : undefined;

  return {
    rootPath,
    configPath,
    hooksPath,
    mcpConfigured: hasMcp,
    mcpServerName: hasMcp ? "kairn" : undefined,
    instructionsPath: instructions?.instructionsPath,
    mode,
    deprecatedModeAlias: input.mode === "savings" ? "savings" as const : undefined,
    primeProfile: input.primeProfile,
    hookOutput: input.hookOutput,
    postToolHookOutput: input.postToolHookOutput,
    primeBudget: input.primeBudget,
    sessionId: input.sessionId,
    configConflict: undefined
  };
}

export function normalizeCodexSetupMode(mode: CodexSetupMode): CanonicalCodexSetupMode {
  return mode === "savings" ? "source-first" : mode;
}

function buildCodexConfig(input: {
  rootPath: string;
  mode: CanonicalCodexSetupMode;
  existingConfig: string;
}): string {
  let config = removeDeprecatedSetupModeMetadata(input.existingConfig);
  config = removeFeatureFlag(config, "codex_hooks");
  config = upsertFeatureFlag(config, "hooks", true, true);
  if (input.mode === "mcp-first" || input.mode === "hybrid") {
    const mcpCommand = resolveKairnMcpCommand();
    const mcpArgs = [...mcpCommand.argsPrefix, "serve", "--mcp", "--root", input.rootPath];
    config = upsertTomlTable(config, "mcp_servers.kairn", [
      `[mcp_servers.kairn]`,
      `# kairn:owned`,
      `command = ${JSON.stringify(mcpCommand.command)}`,
      `args = ${JSON.stringify(mcpArgs)}`,
      `startup_timeout_sec = 20`,
      `tool_timeout_sec = 60`,
      `enabled = true`
    ]);
  }
  return config.endsWith("\n") ? config : `${config}\n`;
}

function removeDeprecatedSetupModeMetadata(config: string): string {
  return config
    .replace(/^\s*#\s*kairn:setup-mode\s*=\s*["']?savings["']?\s*\n?/gim, "")
    .replace(/^\s*kairn_setup_mode\s*=\s*["']?savings["']?\s*\n?/gim, "");
}

export function hasKairnOwnedCodexMcpConfig(config: string): boolean {
  const block = findTomlTableBlock(config, "mcp_servers.kairn");
  return Boolean(block && isKairnOwnedCodexMcpBlock(block));
}

export function removeKairnOwnedCodexMcpConfig(config: string): string {
  const block = findTomlTableBlock(config, "mcp_servers.kairn");
  if (!block || !isKairnOwnedCodexMcpBlock(block)) return config;
  return config.replace(block, block.startsWith("\n") ? "\n" : "");
}

export function isKairnOwnedCodexHookEntry(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isKairnOwnedCodexHookEntry);
  if (!isRecord(value)) return false;
  if (typeof value.command === "string" && isKairnCodexHookCommand(value.command)) return true;
  return Object.values(value).some(isKairnOwnedCodexHookEntry);
}

function mergeCodexHooksConfig(
  existingRaw: string,
  generated: { hooks: Record<string, unknown> }
): { value: Record<string, unknown>; conflict?: undefined } | { value?: undefined; conflict: string } {
  let existing: Record<string, unknown> = {};
  if (existingRaw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingRaw);
    } catch {
      return { conflict: ".codex/hooks.json is not valid JSON; fix it or remove it before enabling Kairn." };
    }
    if (!isRecord(parsed)) {
      return { conflict: ".codex/hooks.json must contain a JSON object; the existing file was left unchanged." };
    }
    existing = parsed;
  }

  if (existing.hooks !== undefined && !isRecord(existing.hooks)) {
    return { conflict: ".codex/hooks.json has a non-object hooks value; the existing file was left unchanged." };
  }

  const currentHooks = isRecord(existing.hooks) ? existing.hooks : {};
  const nextHooks: Record<string, unknown> = {};
  const eventNames = new Set([...Object.keys(currentHooks), ...Object.keys(generated.hooks)]);
  for (const eventName of eventNames) {
    const current = currentHooks[eventName];
    const additions = generated.hooks[eventName];
    if (additions !== undefined && !Array.isArray(additions)) {
      return { conflict: `Generated Codex hook ${eventName} is not an array.` };
    }
    if (additions !== undefined && current !== undefined && !Array.isArray(current)) {
      return { conflict: `.codex/hooks.json has a non-array ${eventName} hook; the existing hook was left unchanged.` };
    }

    if (Array.isArray(current)) {
      const kept = current.filter((entry) => !isKairnOwnedCodexHookEntry(entry));
      const merged = [...kept, ...(additions ?? [])];
      if (merged.length > 0) nextHooks[eventName] = merged;
      continue;
    }
    if (current !== undefined && !isKairnOwnedCodexHookEntry(current)) {
      nextHooks[eventName] = current;
      continue;
    }
    if (additions && additions.length > 0) nextHooks[eventName] = additions;
  }

  const next: Record<string, unknown> = { ...existing, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0) delete next.hooks;
  return { value: next };
}

function findTomlTableBlock(config: string, table: string): string | undefined {
  const escaped = escapeRegExp(`[${table}]`);
  const pattern = new RegExp(`(^|\\n)${escaped}[^\\n]*(?:\\n[\\s\\S]*?(?=\\n\\[|$)|$)`);
  return config.match(pattern)?.[0];
}

function isKairnOwnedCodexMcpBlock(block: string): boolean {
  return /kairn:owned/i.test(block) || (
    /(?:use)?kairn/i.test(block) &&
    /(?:^|[\s"'])serve(?:[\s"',]|$)/i.test(block) &&
    /--mcp/i.test(block)
  );
}

function isKairnCodexHookCommand(command: string): boolean {
  return /KAIRN_CMD|(?:use)?kairn/i.test(command) &&
    /(?:^|\s)hook(?:\s|$)/i.test(command) &&
    /--source\s+["']?codex\b/i.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveKairnMcpCommand(): { command: string; argsPrefix: string[] } {
  const envCommand = process.env.KAIRN_CMD?.trim();
  if (envCommand) return splitCommandForMcp(envCommand);

  const argvEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (argvEntrypoint && fs.existsSync(argvEntrypoint)) {
    if (path.extname(argvEntrypoint) === ".js") {
      return { command: process.execPath, argsPrefix: [argvEntrypoint] };
    }
    if (path.extname(argvEntrypoint) === ".ts" || path.extname(argvEntrypoint) === ".tsx") {
      return {
        command: findExecutableNearEntrypoint("tsx", argvEntrypoint) ?? findExecutableOnPath("tsx") ?? "tsx",
        argsPrefix: [argvEntrypoint]
      };
    }
    return { command: argvEntrypoint, argsPrefix: [] };
  }

  const pathCommand = findExecutableOnPath("kairn");
  if (pathCommand) return { command: pathCommand, argsPrefix: [] };

  return { command: "kairn", argsPrefix: [] };
}

function findExecutableNearEntrypoint(name: string, entrypoint: string): string | undefined {
  let current = path.dirname(entrypoint);
  while (current && current !== path.dirname(current)) {
    for (const executableName of executableNames(name)) {
      const candidate = path.join(current, "node_modules", ".bin", executableName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return path.resolve(candidate);
      } catch {
        // Keep searching this directory.
      }
    }
    current = path.dirname(current);
  }
  return undefined;
}

function splitCommandForMcp(command: string): { command: string; argsPrefix: string[] } {
  try {
    const invocation = commandInvocation(command);
    return { command: invocation.command, argsPrefix: invocation.args };
  } catch {
    return { command: "kairn", argsPrefix: [] };
  }
}

function findExecutableOnPath(name: string): string | undefined {
  const pathDirs = process.env.PATH?.split(path.delimiter) ?? [];
  for (const dir of pathDirs) {
    for (const executableName of executableNames(name)) {
      const candidate = path.join(dir, executableName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return path.resolve(candidate);
      } catch {
        // Keep searching.
      }
    }
  }
  return undefined;
}

function executableNames(name: string): string[] {
  if (path.extname(name) || process.platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function upsertFeatureFlag(config: string, key: string, value: boolean, trackOwnership = false): string {
  const plainFeatureLine = `${key} = ${value ? "true" : "false"}`;
  const ownedFeatureLine = `${plainFeatureLine} # kairn:owned`;
  const featureHeader = "[features]";
  if (!config.trim()) return `${featureHeader}\n${trackOwnership ? ownedFeatureLine : plainFeatureLine}\n`;
  const featurePattern = /(^|\n)\[features\]\n([\s\S]*?)(?=\n\[|$)/;
  const match = config.match(featurePattern);
  if (!match) return `${config.trimEnd()}\n\n${featureHeader}\n${trackOwnership ? ownedFeatureLine : plainFeatureLine}\n`;

  const body = match[2] ?? "";
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  const existingLine = body.match(keyPattern)?.[0];
  const featureLine = existingLine
    ? trackOwnership
      ? /\bfalse\b/.test(existingLine) ? `${plainFeatureLine} # kairn:previous=false` : existingLine
      : plainFeatureLine
    : trackOwnership ? ownedFeatureLine : plainFeatureLine;
  const nextBody = existingLine
    ? body.replace(keyPattern, featureLine)
    : `${body.trimEnd()}\n${featureLine}\n`;
  return config.replace(featurePattern, `${match[1]}${featureHeader}\n${nextBody.trimEnd()}\n`);
}

function removeFeatureFlag(config: string, key: string): string {
  const featureHeader = "[features]";
  const featurePattern = /(^|\n)\[features\]\n([\s\S]*?)(?=\n\[|$)/;
  const match = config.match(featurePattern);
  if (!match) return config;

  const body = match[2] ?? "";
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*\\n?`, "m");
  if (!keyPattern.test(body)) return config;

  const nextBody = body.replace(keyPattern, "").trimEnd();
  return config.replace(
    featurePattern,
    `${match[1]}${featureHeader}\n${nextBody ? `${nextBody}\n` : ""}`
  );
}

function upsertTomlTable(config: string, table: string, lines: string[]): string {
  const escaped = escapeRegExp(`[${table}]`);
  const pattern = new RegExp(`(^|\\n)${escaped}\\n[\\s\\S]*?(?=\\n\\[|$)`);
  const block = lines.join("\n");
  if (pattern.test(config)) return config.replace(pattern, `$1${block}\n`);
  return `${config.trimEnd()}\n\n${block}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCodexHooksConfig(input: {
  mode: CanonicalCodexSetupMode;
  primeProfile: PrimeProfile;
  hookOutput: HookOutputProfile;
  postToolHookOutput: HookOutputProfile;
  primeBudget: number;
  sessionId?: string | undefined;
}) {
  const promptCommand = buildCodexHookCommand({
    primeProfile: input.primeProfile,
    primeBudget: input.primeBudget,
    hookOutput: input.hookOutput,
    sessionId: input.sessionId
  });
  const postToolCommand = buildCodexHookCommand({
    primeProfile: input.primeProfile,
    primeBudget: input.primeBudget,
    hookOutput: input.postToolHookOutput,
    sessionId: input.sessionId
  });
  const hooks: Record<string, unknown> = {};

  if (input.mode !== "mcp-first") {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          {
            type: "command",
            command: promptCommand,
            statusMessage: input.hookOutput === "mcp-brief" ? "Coordinating Kairn MCP context" : "Priming Kairn context"
          }
        ]
      }
    ];
  }

  if (input.mode === "observe" || input.mode === "debug") {
    hooks.PostToolUse = [
      {
        matcher: input.mode === "debug" ? ".*" : "Bash|apply_patch|mcp__.*",
        hooks: [
          {
            type: "command",
            command: postToolCommand,
            statusMessage: input.mode === "debug" ? "Sending debug hook output to Kairn" : "Sending useful tool output to Kairn"
          }
        ]
      }
    ];
  }

  if (input.mode === "debug") {
    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: postToolCommand,
            statusMessage: "Recording Codex stop event in Kairn"
          }
        ]
      }
    ];
  }

  return {
    hooks
  };
}

function buildCodexHookCommand(input: {
  primeProfile: PrimeProfile;
  primeBudget: number;
  hookOutput: HookOutputProfile;
  sessionId?: string | undefined;
}): string {
  const kairnCommand = resolveKairnMcpCommand();
  const defaultCommand = shellCommand([kairnCommand.command, ...kairnCommand.argsPrefix]);
  const sessionArg = input.sessionId ? ` --session ${shellQuote(input.sessionId)}` : "";
  return `eval "\${KAIRN_CMD:-${escapeDoubleQuotedShell(defaultCommand)}} hook --source codex --root \\"$PWD\\"${sessionArg} --prime-profile ${input.primeProfile} --prime-budget ${input.primeBudget} --hook-output ${input.hookOutput}"`;
}

function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuotedShell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}
