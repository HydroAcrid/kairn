// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type BenchmarkMcpSmokeReport = {
  startedAt: string;
  endedAt: string;
  rootPath: string;
  task: string;
  serverCommand: string;
  serverArgs: string[];
  tools: string[];
  sessionId?: string;
  prepare: {
    startFiles: string[];
    nextToolCalls: string[];
    stopCondition?: string | null;
    contextSuppressed?: boolean;
    exactSourceHit?: boolean;
  };
  metrics: {
    mcpToolCalls: number;
    savedTokens?: number;
  };
};

export async function runBenchmarkMcpSmoke(input: {
  rootPath: string;
  task: string;
  budget?: number | undefined;
  detail?: "compact" | "full" | undefined;
  serverCommand?: string | undefined;
  serverArgs?: string[] | undefined;
}): Promise<BenchmarkMcpSmokeReport> {
  const startedAt = new Date().toISOString();
  const rootPath = path.resolve(input.rootPath);
  const server = resolveServerCommand(rootPath, input.serverCommand, input.serverArgs);
  const client = new Client({
    name: "kairn-benchmark-mcp-smoke",
    version: "0.1.2"
  });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools.map((tool) => tool.name);
    const started = await client.callTool({
      name: "kairn_start_task",
      arguments: {
        task: input.task
      }
    });
    const startedParsed = parseTextJson(started) as { session?: { id?: string } };
    const sessionId = startedParsed.session?.id;
    const prepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: input.task,
        sessionId,
        budget: input.budget ?? 700,
        detail: input.detail ?? "compact"
      }
    });
    const preparedParsed = parseTextJson(prepared) as {
      startFiles?: string[];
      nextToolCalls?: Array<string | { name?: string; tool?: string }>;
      stopCondition?: string | null;
      contextSuppressed?: boolean;
      contextDecision?: { exactSourceHit?: boolean };
    };
    const metricsResult = await client.callTool({
      name: "kairn_get_metrics",
      arguments: {
        sessionId
      }
    });
    const metricsParsed = parseTextJson(metricsResult) as {
      byKind?: Record<string, { events?: number; savedTokens?: number }>;
      totals?: { savedTokens?: number };
    };
    const endedAt = new Date().toISOString();
    return {
      startedAt,
      endedAt,
      rootPath,
      task: input.task,
      serverCommand: server.command,
      serverArgs: server.args,
      tools,
      ...(sessionId ? { sessionId } : {}),
      prepare: {
        startFiles: preparedParsed.startFiles ?? [],
        nextToolCalls: normalizeToolCalls(preparedParsed.nextToolCalls ?? []),
        stopCondition: preparedParsed.stopCondition ?? null,
        contextSuppressed: Boolean(preparedParsed.contextSuppressed),
        exactSourceHit: Boolean(preparedParsed.contextDecision?.exactSourceHit)
      },
      metrics: {
        mcpToolCalls: metricsParsed.byKind?.mcp_tool_call?.events ?? 0,
        ...optionalNumber("savedTokens", metricsParsed.totals?.savedTokens ?? metricsParsed.byKind?.mcp_tool_call?.savedTokens)
      }
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function optionalNumber<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return typeof value === "number" ? { [key]: value } as { [P in K]?: number } : {};
}

function resolveServerCommand(
  rootPath: string,
  serverCommand: string | undefined,
  serverArgs: string[] | undefined
): { command: string; args: string[] } {
  if (serverCommand) {
    return {
      command: serverCommand,
      args: (serverArgs ?? []).map((arg) => arg.replaceAll("{root}", rootPath))
    };
  }

  const rawEntry = process.argv[1] ?? "";
  const entry = rawEntry ? path.resolve(rawEntry) : "";
  if (entry.endsWith(".ts")) {
    return {
      command: resolveLocalTsx(entry),
      args: [entry, "serve", "--mcp", "--root", rootPath]
    };
  }
  if (entry.endsWith(".js") || (entry && fs.existsSync(entry))) {
    return {
      command: process.execPath,
      args: [entry, "serve", "--mcp", "--root", rootPath]
    };
  }
  return {
    command: "kairn",
    args: ["serve", "--mcp", "--root", rootPath]
  };
}

function resolveLocalTsx(entry: string): string {
  const candidates = [
    path.join(process.cwd(), "node_modules/.bin/tsx"),
    path.join(path.dirname(entry), "../node_modules/.bin/tsx"),
    path.join(path.dirname(entry), "../../node_modules/.bin/tsx")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "tsx";
}

function normalizeToolCalls(calls: Array<string | { name?: string; tool?: string }>): string[] {
  return calls
    .map((call) => typeof call === "string" ? call : call.name ?? call.tool ?? "")
    .filter(Boolean);
}

function parseTextJson(result: unknown): unknown {
  const text = firstTextContent(result);
  if (!text) throw new Error("MCP tool result did not include text content.");
  return JSON.parse(text);
}

function firstTextContent(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
