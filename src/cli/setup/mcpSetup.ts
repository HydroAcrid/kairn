// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveKairnMcpCommand } from "./codexSetup.js";
import { writeMcpInstructionsSetup } from "./mcpInstructions.js";

export type McpClientSetupTarget = "vscode" | "claude-code" | "copilot-cli" | "gemini-cli" | "generic";

export type McpClientSetupResult = {
  rootPath: string;
  client: McpClientSetupTarget;
  serverName: string;
  serverConfig: {
    type: "stdio";
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  clientConfig: Record<string, unknown>;
  configPath?: string | undefined;
  instructionsPath?: string | undefined;
  installCommand?: string | undefined;
  userConfigWriteSkipped?: boolean | undefined;
  configConflict?: { path: string; reason: string } | undefined;
};

const KAIRN_SETUP_OWNER_ENV = "KAIRN_SETUP_OWNER";

export function writeMcpClientSetup(input: {
  root: string;
  client: McpClientSetupTarget;
  writeInstructions?: boolean | undefined;
  writeUserConfig?: boolean | undefined;
  homeDir?: string | undefined;
}): McpClientSetupResult {
  const rootPath = path.resolve(input.root);
  const serverConfig = buildMcpServerConfig(rootPath);
  const copilotConfigPath = path.join(input.homeDir ?? os.homedir(), ".copilot", "mcp-config.json");
  const serverName = input.client === "copilot-cli"
    ? existingCopilotServerNameForRoot(copilotConfigPath, rootPath) ?? copilotServerNameForRoot(rootPath)
    : "kairn";
  const clientConfig = clientConfigFor(input.client, rootPath, serverConfig, serverName);

  if (input.client === "generic") {
    const instructions = writeInstructions(input, rootPath);
    return {
      rootPath,
      client: input.client,
      serverName,
      serverConfig,
      clientConfig,
      instructionsPath: instructions?.instructionsPath,
      configConflict: undefined
    };
  }

  if (input.client === "claude-code") {
    const configPath = path.join(rootPath, ".mcp.json");
    const write = upsertMcpServersConfig(configPath, clientConfig);
    const instructions = write.conflict ? undefined : writeInstructions(input, rootPath);
    return {
      rootPath,
      client: input.client,
      serverName,
      serverConfig,
      clientConfig,
      configPath,
      instructionsPath: instructions?.instructionsPath,
      installCommand: `claude mcp add-json kairn '${JSON.stringify(serverEntry(clientConfig, "mcpServers") ?? {})}' --scope project`,
      configConflict: write.conflict
    };
  }

  if (input.client === "copilot-cli") {
    const configPath = copilotConfigPath;
    const write = input.writeUserConfig ? upsertMcpServersConfig(configPath, clientConfig) : {};
    const instructions = write.conflict ? undefined : writeInstructions(input, rootPath);
    return {
      rootPath,
      client: input.client,
      serverName,
      serverConfig,
      clientConfig,
      configPath: input.writeUserConfig ? configPath : undefined,
      instructionsPath: instructions?.instructionsPath,
      userConfigWriteSkipped: !input.writeUserConfig,
      configConflict: write.conflict
    };
  }

  if (input.client === "gemini-cli") {
    const configPath = path.join(rootPath, ".gemini", "settings.json");
    const write = upsertMcpServersConfig(configPath, clientConfig);
    const instructions = write.conflict ? undefined : writeInstructions(input, rootPath);
    return {
      rootPath,
      client: input.client,
      serverName,
      serverConfig,
      clientConfig,
      configPath,
      instructionsPath: instructions?.instructionsPath,
      configConflict: write.conflict
    };
  }

  const vscodeDir = path.join(rootPath, ".vscode");
  const configPath = path.join(vscodeDir, "mcp.json");
  const write = upsertMcpServersConfig(configPath, clientConfig);
  const instructions = write.conflict ? undefined : writeInstructions(input, rootPath);

  return {
    rootPath,
    client: input.client,
    serverName,
    serverConfig,
    clientConfig,
    configPath,
    instructionsPath: instructions?.instructionsPath,
    configConflict: write.conflict
  };
}

function buildMcpServerConfig(rootPath: string): McpClientSetupResult["serverConfig"] {
  const command = resolveKairnMcpCommand();
  return {
    type: "stdio",
    command: command.command,
    args: [...command.argsPrefix, "serve", "--mcp", "--root", rootPath],
    env: { [KAIRN_SETUP_OWNER_ENV]: "kairn" }
  };
}

function clientConfigFor(
  client: McpClientSetupTarget,
  rootPath: string,
  serverConfig: McpClientSetupResult["serverConfig"],
  serverName: string
): Record<string, unknown> {
  if (client === "vscode") {
    return {
      servers: {
        [serverName]: serverConfig
      }
    };
  }

  if (client === "copilot-cli") {
    return {
      mcpServers: {
        [serverName]: {
          type: "local",
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          tools: ["*"]
        }
      }
    };
  }

  if (client === "gemini-cli") {
    return {
      mcpServers: {
        [serverName]: {
          command: serverConfig.command,
          args: serverConfig.args,
          cwd: rootPath,
          timeout: 30000,
          trust: false,
          env: serverConfig.env
        }
      }
    };
  }

  if (client === "claude-code") {
    return {
      mcpServers: {
        [serverName]: {
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env
        }
      }
    };
  }

  return {
    mcpServers: {
      [serverName]: serverConfig
    }
  };
}

function upsertMcpServersConfig(
  configPath: string,
  config: Record<string, unknown>
): { conflict?: { path: string; reason: string } | undefined } {
  let existing: Record<string, unknown>;
  try {
    existing = readJsonObject(configPath);
  } catch (error) {
    return {
      conflict: {
        path: configPath,
        reason: error instanceof Error ? `${error.message} The existing file was left unchanged.` : "The existing MCP config was left unchanged."
      }
    };
  }
  const conflict = findMcpConflict(existing, config, configPath);
  if (conflict) return { conflict };
  const next = mergeMcpConfig(existing, config);
  if (isDeepStrictEqual(existing, next)) return {};
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return {};
}

function findMcpConflict(
  existing: Record<string, unknown>,
  config: Record<string, unknown>,
  configPath: string
): { path: string; reason: string } | undefined {
  for (const key of ["servers", "mcpServers"] as const) {
    const desiredServers = config[key];
    if (!isRecord(desiredServers)) continue;
    const currentServers = existing[key];
    if (currentServers !== undefined && !isRecord(currentServers)) {
      return { path: configPath, reason: `${key} is not a JSON object; the existing file was left unchanged.` };
    }
    if (!isRecord(currentServers)) continue;
    for (const [serverName, desired] of Object.entries(desiredServers)) {
      if (!(serverName in currentServers)) continue;
      const current = currentServers[serverName];
      if (!isDeepStrictEqual(current, desired) && !isKairnOwnedMcpServer(current)) {
        return {
          path: configPath,
          reason: `${key}.${serverName} already contains a non-Kairn command; rename or remove that entry before enabling Kairn.`
        };
      }
      const desiredRoot = mcpServerRoot(desired);
      if (!isDeepStrictEqual(current, desired) && desiredRoot && !isKairnOwnedMcpServerForRoot(current, desiredRoot)) {
        return {
          path: configPath,
          reason: `${key}.${serverName} is Kairn-owned by a different repository; the existing entry was left unchanged.`
        };
      }
    }
  }
  return undefined;
}

export function isKairnOwnedMcpServer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const env = isRecord(value.env) ? value.env : undefined;
  if (env?.[KAIRN_SETUP_OWNER_ENV] === "kairn") return true;
  const command = typeof value.command === "string" ? value.command : "";
  const args = Array.isArray(value.args) ? value.args.filter((part): part is string => typeof part === "string") : [];
  const invocation = [command, ...args].join(" ");
  return /(?:use)?kairn/i.test(invocation) &&
    args.includes("serve") &&
    args.includes("--mcp") &&
    args.includes("--root");
}

/** Stable Copilot server key scoped to one resolved repository path. */
export function copilotServerNameForRoot(rootPath: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const basename = path.basename(resolvedRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "repo";
  const digest = createHash("sha256").update(canonicalRoot(resolvedRoot)).digest("hex").slice(0, 12);
  return `kairn-${basename}-${digest}`;
}

/** Matches only an owned Kairn MCP invocation whose --root value is this repository. */
export function isKairnOwnedMcpServerForRoot(value: unknown, rootPath: string): boolean {
  if (!isKairnOwnedMcpServer(value)) return false;
  const configuredRoot = mcpServerRoot(value);
  if (!configuredRoot) return false;
  return canonicalRoot(configuredRoot) === canonicalRoot(rootPath);
}

/**
 * New Copilot entries are repository-keyed. An exact legacy `kairn` entry is
 * retained only when it is Kairn-owned and already points at this repository.
 */
export function existingCopilotServerNameForRoot(configPath: string, rootPath: string): string | undefined {
  let config: Record<string, unknown>;
  try {
    config = readJsonObject(configPath);
  } catch {
    return undefined;
  }
  const servers = config.mcpServers;
  if (!isRecord(servers)) return undefined;
  const repositoryKey = copilotServerNameForRoot(rootPath);
  if (isKairnOwnedMcpServerForRoot(servers[repositoryKey], rootPath)) return repositoryKey;
  if (isKairnOwnedMcpServerForRoot(servers.kairn, rootPath)) return "kairn";
  return undefined;
}

export function copilotServerNamesForRoot(servers: unknown, rootPath: string): string[] {
  if (!isRecord(servers)) return [];
  return [copilotServerNameForRoot(rootPath), "kairn"]
    .filter((serverName, index, names) => names.indexOf(serverName) === index)
    .filter((serverName) => isKairnOwnedMcpServerForRoot(servers[serverName], rootPath));
}

function writeInstructions(input: { writeInstructions?: boolean | undefined }, rootPath: string) {
  return input.writeInstructions === false
    ? undefined
    : writeMcpInstructionsSetup({ root: rootPath, mode: "mcp-first" });
}

function mergeMcpConfig(existing: Record<string, unknown>, config: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(config)) {
    if (key === "servers" || key === "mcpServers") {
      next[key] = {
        ...(isRecord(next[key]) ? next[key] : {}),
        ...(isRecord(value) ? value : {})
      };
      continue;
    }
    next[key] = value;
  }
  return next;
}

function serverEntry(config: Record<string, unknown>, key: "servers" | "mcpServers"): unknown {
  const servers = config[key];
  return isRecord(servers) ? servers.kairn : undefined;
}

function canonicalRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath).replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function mcpServerRoot(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const args = Array.isArray(value.args) ? value.args.filter((part): part is string => typeof part === "string") : [];
  const rootIndex = args.lastIndexOf("--root");
  return rootIndex >= 0 ? args[rootIndex + 1] : undefined;
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
