import fs from "node:fs";
import path from "node:path";
import type { CodexSetupMode, HookOutputProfile, PrimeProfile } from "../../types.js";
import { writeMcpInstructionsSetup } from "./mcpInstructions.js";

export function writeCodexSetup(input: {
  root: string;
  mode: CodexSetupMode;
  primeProfile: PrimeProfile;
  hookOutput: HookOutputProfile;
  postToolHookOutput: HookOutputProfile;
  primeBudget: number;
}) {
  const rootPath = path.resolve(input.root);
  const codexDir = path.join(rootPath, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  fs.mkdirSync(codexDir, { recursive: true });
  const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  fs.writeFileSync(configPath, buildCodexConfig({ ...input, rootPath, existingConfig }));
  fs.writeFileSync(
    hooksPath,
    `${JSON.stringify(buildCodexHooksConfig(input), null, 2)}\n`
  );
  const hasMcp = input.mode === "mcp-first" || input.mode === "hybrid";
  const instructions = hasMcp ? writeMcpInstructionsSetup({ root: rootPath, mode: input.mode === "hybrid" ? "hybrid" : "mcp-first" }) : undefined;

  return {
    rootPath,
    configPath,
    hooksPath,
    mcpConfigured: hasMcp,
    mcpServerName: hasMcp ? "kairn" : undefined,
    instructionsPath: instructions?.instructionsPath,
    mode: input.mode,
    primeProfile: input.primeProfile,
    hookOutput: input.hookOutput,
    postToolHookOutput: input.postToolHookOutput,
    primeBudget: input.primeBudget
  };
}

function buildCodexConfig(input: {
  rootPath: string;
  mode: CodexSetupMode;
  existingConfig: string;
}): string {
  let config = upsertFeatureFlag(input.existingConfig, "codex_hooks", true);
  if (input.mode === "mcp-first" || input.mode === "hybrid") {
    const mcpCommand = resolveKairnMcpCommand();
    const mcpArgs = [...mcpCommand.argsPrefix, "serve", "--mcp", "--root", input.rootPath];
    config = upsertTomlTable(config, "mcp_servers.kairn", [
      `[mcp_servers.kairn]`,
      `command = ${JSON.stringify(mcpCommand.command)}`,
      `args = ${JSON.stringify(mcpArgs)}`,
      `startup_timeout_sec = 20`,
      `tool_timeout_sec = 60`,
      `enabled = true`
    ]);
  }
  return config.endsWith("\n") ? config : `${config}\n`;
}

function resolveKairnMcpCommand(): { command: string; argsPrefix: string[] } {
  const envCommand = process.env.KAIRN_CMD?.trim();
  if (envCommand) return splitCommandForMcp(envCommand);

  const argvEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (argvEntrypoint && fs.existsSync(argvEntrypoint)) {
    if (path.extname(argvEntrypoint) === ".js") {
      return { command: process.execPath, argsPrefix: [argvEntrypoint] };
    }
    if (path.extname(argvEntrypoint) === ".ts" || path.extname(argvEntrypoint) === ".tsx") {
      return { command: findExecutableOnPath("tsx") ?? "tsx", argsPrefix: [argvEntrypoint] };
    }
    return { command: argvEntrypoint, argsPrefix: [] };
  }

  const pathCommand = findExecutableOnPath("kairn");
  if (pathCommand) return { command: pathCommand, argsPrefix: [] };

  return { command: "kairn", argsPrefix: [] };
}

function splitCommandForMcp(command: string): { command: string; argsPrefix: string[] } {
  const parts = command.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^['"]|['"]$/g, "")) ?? [];
  if (parts.length === 0) return { command: "kairn", argsPrefix: [] };
  return { command: parts[0]!, argsPrefix: parts.slice(1) };
}

function findExecutableOnPath(name: string): string | undefined {
  const pathDirs = process.env.PATH?.split(path.delimiter) ?? [];
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return path.resolve(candidate);
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

function upsertFeatureFlag(config: string, key: string, value: boolean): string {
  const featureLine = `${key} = ${value ? "true" : "false"}`;
  const featureHeader = "[features]";
  if (!config.trim()) return `${featureHeader}\n${featureLine}\n`;
  const featurePattern = /(^|\n)\[features\]\n([\s\S]*?)(?=\n\[|$)/;
  const match = config.match(featurePattern);
  if (!match) return `${config.trimEnd()}\n\n${featureHeader}\n${featureLine}\n`;

  const body = match[2] ?? "";
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  const nextBody = keyPattern.test(body)
    ? body.replace(keyPattern, featureLine)
    : `${body.trimEnd()}\n${featureLine}\n`;
  return config.replace(featurePattern, `${match[1]}${featureHeader}\n${nextBody.trimEnd()}\n`);
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
  mode: CodexSetupMode;
  primeProfile: PrimeProfile;
  hookOutput: HookOutputProfile;
  postToolHookOutput: HookOutputProfile;
  primeBudget: number;
}) {
  const promptCommand = buildCodexHookCommand({
    primeProfile: input.primeProfile,
    primeBudget: input.primeBudget,
    hookOutput: input.hookOutput
  });
  const postToolCommand = buildCodexHookCommand({
    primeProfile: input.primeProfile,
    primeBudget: input.primeBudget,
    hookOutput: input.postToolHookOutput
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
}): string {
  const kairnCommand = resolveKairnMcpCommand();
  const defaultCommand = shellCommand([kairnCommand.command, ...kairnCommand.argsPrefix]);
  return `eval "\${KAIRN_CMD:-${escapeDoubleQuotedShell(defaultCommand)}} hook --source codex --root \\"$PWD\\" --prime-profile ${input.primeProfile} --prime-budget ${input.primeBudget} --hook-output ${input.hookOutput}"`;
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
