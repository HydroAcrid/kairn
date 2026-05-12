import fs from "node:fs";
import path from "node:path";
import { resolveKairnMcpCommand } from "./codexSetup.js";
import { writeMcpInstructionsSetup } from "./mcpInstructions.js";

export type McpClientSetupTarget = "vscode" | "generic";

export type McpClientSetupResult = {
  rootPath: string;
  client: McpClientSetupTarget;
  serverName: "kairn";
  serverConfig: {
    type: "stdio";
    command: string;
    args: string[];
  };
  configPath?: string | undefined;
  instructionsPath?: string | undefined;
};

export function writeMcpClientSetup(input: {
  root: string;
  client: McpClientSetupTarget;
  writeInstructions?: boolean | undefined;
}): McpClientSetupResult {
  const rootPath = path.resolve(input.root);
  const serverConfig = buildMcpServerConfig(rootPath);
  const instructions = input.writeInstructions === false
    ? undefined
    : writeMcpInstructionsSetup({ root: rootPath, mode: "mcp-first" });

  if (input.client === "generic") {
    return {
      rootPath,
      client: input.client,
      serverName: "kairn",
      serverConfig,
      instructionsPath: instructions?.instructionsPath
    };
  }

  const vscodeDir = path.join(rootPath, ".vscode");
  const configPath = path.join(vscodeDir, "mcp.json");
  fs.mkdirSync(vscodeDir, { recursive: true });
  const existing = readJsonObject(configPath);
  const servers = isRecord(existing.servers) ? existing.servers : {};
  const next = {
    ...existing,
    servers: {
      ...servers,
      kairn: serverConfig
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);

  return {
    rootPath,
    client: input.client,
    serverName: "kairn",
    serverConfig,
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
