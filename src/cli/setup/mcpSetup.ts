import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveKairnMcpCommand } from "./codexSetup.js";
import { writeMcpInstructionsSetup } from "./mcpInstructions.js";

export type McpClientSetupTarget = "vscode" | "claude-code" | "copilot-cli" | "gemini-cli" | "generic";

export type McpClientSetupResult = {
  rootPath: string;
  client: McpClientSetupTarget;
  serverName: "kairn";
  serverConfig: {
    type: "stdio";
    command: string;
    args: string[];
  };
  clientConfig: Record<string, unknown>;
  configPath?: string | undefined;
  instructionsPath?: string | undefined;
  installCommand?: string | undefined;
  userConfigWriteSkipped?: boolean | undefined;
};

export function writeMcpClientSetup(input: {
  root: string;
  client: McpClientSetupTarget;
  writeInstructions?: boolean | undefined;
  writeUserConfig?: boolean | undefined;
}): McpClientSetupResult {
  const rootPath = path.resolve(input.root);
  const serverConfig = buildMcpServerConfig(rootPath);
  const instructions = input.writeInstructions === false
    ? undefined
    : writeMcpInstructionsSetup({ root: rootPath, mode: "mcp-first" });
  const clientConfig = clientConfigFor(input.client, rootPath, serverConfig);

  if (input.client === "generic") {
    return {
      rootPath,
      client: input.client,
      serverName: "kairn",
      serverConfig,
      clientConfig,
      instructionsPath: instructions?.instructionsPath
    };
  }

  if (input.client === "claude-code") {
    const configPath = path.join(rootPath, ".mcp.json");
    upsertMcpServersConfig(configPath, clientConfig);
    return {
      rootPath,
      client: input.client,
      serverName: "kairn",
      serverConfig,
      clientConfig,
      configPath,
      instructionsPath: instructions?.instructionsPath,
      installCommand: `claude mcp add-json kairn '${JSON.stringify(serverEntry(clientConfig, "mcpServers") ?? {})}' --scope project`
    };
  }

  if (input.client === "copilot-cli") {
    const configPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
    if (input.writeUserConfig) {
      upsertMcpServersConfig(configPath, clientConfig);
    }
    return {
      rootPath,
      client: input.client,
      serverName: "kairn",
      serverConfig,
      clientConfig,
      configPath: input.writeUserConfig ? configPath : undefined,
      instructionsPath: instructions?.instructionsPath,
      userConfigWriteSkipped: !input.writeUserConfig
    };
  }

  if (input.client === "gemini-cli") {
    const configPath = path.join(rootPath, ".gemini", "settings.json");
    upsertMcpServersConfig(configPath, clientConfig);
    return {
      rootPath,
      client: input.client,
      serverName: "kairn",
      serverConfig,
      clientConfig,
      configPath,
      instructionsPath: instructions?.instructionsPath
    };
  }

  const vscodeDir = path.join(rootPath, ".vscode");
  const configPath = path.join(vscodeDir, "mcp.json");
  upsertMcpServersConfig(configPath, clientConfig);

  return {
    rootPath,
    client: input.client,
    serverName: "kairn",
    serverConfig,
    clientConfig,
    configPath,
    instructionsPath: instructions?.instructionsPath
  };
}

function buildMcpServerConfig(rootPath: string): McpClientSetupResult["serverConfig"] {
  const command = resolveKairnMcpCommand();
  return {
    type: "stdio",
    command: command.command,
    args: [...command.argsPrefix, "serve", "--mcp", "--root", rootPath]
  };
}

function clientConfigFor(
  client: McpClientSetupTarget,
  rootPath: string,
  serverConfig: McpClientSetupResult["serverConfig"]
): Record<string, unknown> {
  if (client === "vscode") {
    return {
      servers: {
        kairn: serverConfig
      }
    };
  }

  if (client === "copilot-cli") {
    return {
      mcpServers: {
        kairn: {
          type: "local",
          command: serverConfig.command,
          args: serverConfig.args,
          env: {},
          tools: ["*"]
        }
      }
    };
  }

  if (client === "gemini-cli") {
    return {
      mcpServers: {
        kairn: {
          command: serverConfig.command,
          args: serverConfig.args,
          cwd: rootPath,
          timeout: 30000,
          trust: false
        }
      }
    };
  }

  if (client === "claude-code") {
    return {
      mcpServers: {
        kairn: {
          command: serverConfig.command,
          args: serverConfig.args,
          env: {}
        }
      }
    };
  }

  return {
    mcpServers: {
      kairn: serverConfig
    }
  };
}

function upsertMcpServersConfig(configPath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const existing = readJsonObject(configPath);
  const next = mergeMcpConfig(existing, config);
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
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
