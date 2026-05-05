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

    const started = await client.callTool({
      name: "kairn_start_task",
      arguments: {
        task: "Update dashboard rendering"
      }
    });
    const startedText = firstTextContent(started);
    expect(startedText).toBeTruthy();
    const parsed = JSON.parse(startedText!) as { session: { id: string } };

    const file = await client.callTool({
      name: "kairn_read_file",
      arguments: {
        sessionId: parsed.session.id,
        target: "src/app.ts"
      }
    });
    const fileText = firstTextContent(file);
    expect(fileText).toContain("renderDashboard");

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
