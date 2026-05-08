import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { createFixtureRepo } from "./helpers.js";

describe("MCP server", () => {
  it("lists and calls Kairn tools over stdio", async () => {
    const root = createFixtureRepo();
    const client = new Client({
      name: "kairn-test-client",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules/.bin/tsx"),
      args: ["src/cli.ts", "serve", "--mcp", "--root", root],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_start_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_get_metrics");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_prepare_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_get_failure_context");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_get_next_context");

    const started = await client.callTool({
      name: "kairn_start_task",
      arguments: {
        task: "Update dashboard rendering"
      }
    });
    const startedText = firstTextContent(started);
    expect(startedText).toBeTruthy();
    const parsed = JSON.parse(startedText!) as { session: { id: string } };

    const prepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Update dashboard rendering",
        sessionId: parsed.session.id,
        budget: 700
      }
    });
    const preparedText = firstTextContent(prepared);
    expect(preparedText).toContain("recommendedToolCalls");
    const preparedParsed = JSON.parse(preparedText!) as {
      detail: string;
      sessionId: string;
      startFiles: string[];
      nextToolCalls: unknown[];
      content?: string;
    };
    expect(preparedParsed.detail).toBe("compact");
    expect(preparedParsed.sessionId).toBe(parsed.session.id);
    expect(preparedParsed.startFiles.length).toBeLessThanOrEqual(3);
    expect(preparedParsed.nextToolCalls.length).toBeLessThanOrEqual(2);
    expect(preparedParsed.content).toBeUndefined();

    const fullPrepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Update dashboard rendering",
        sessionId: parsed.session.id,
        budget: 700,
        detail: "full"
      }
    });
    const fullPreparedText = firstTextContent(fullPrepared);
    const fullPreparedParsed = JSON.parse(fullPreparedText!) as { detail: string; content?: string };
    expect(fullPreparedParsed.detail).toBe("full");
    expect(fullPreparedParsed.content).toContain("Kairn");

    const file = await client.callTool({
      name: "kairn_read_file",
      arguments: {
        sessionId: parsed.session.id,
        target: "src/app.ts"
      }
    });
    const fileText = firstTextContent(file);
    expect(fileText).toContain("renderDashboard");

    const context = await client.callTool({
      name: "kairn_find_context",
      arguments: {
        sessionId: parsed.session.id,
        query: "DashboardMetrics",
        mode: "snippets"
      }
    });
    const contextText = firstTextContent(context);
    expect(contextText).toContain("DashboardMetrics");
    expect(contextText).toContain("snippets");

    const failure = await client.callTool({
      name: "kairn_get_failure_context",
      arguments: {
        sessionId: parsed.session.id,
        type: "test",
        output: "FAIL src/app.test.ts\nsrc/app.test.ts:4:10 Expected true to be false"
      }
    });
    expect(firstTextContent(failure)).toContain("Kairn Failure Context");

    const metrics = await client.callTool({
      name: "kairn_get_metrics",
      arguments: {
        sessionId: parsed.session.id
      }
    });
    const metricsText = firstTextContent(metrics);
    expect(metricsText).toContain("savedTokens");
    const metricsParsed = JSON.parse(metricsText!) as {
      byKind: Record<string, { events: number }>;
      bySource: Record<string, { events: number }>;
    };
    expect(metricsParsed.byKind.mcp_tool_call?.events).toBeGreaterThan(0);
    expect(metricsParsed.bySource.mcp?.events).toBeGreaterThan(0);

    await client.close();
  });
});

function firstTextContent(result: unknown): string | undefined {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const item = content.find((entry): entry is { type: "text"; text: string } => {
    return (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    );
  });

  return item?.text;
}
