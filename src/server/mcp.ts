import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { OutputKind } from "../types.js";

const outputKindSchema = z.enum(["test", "lint", "typecheck", "generic"]);
const contextModeSchema = z.enum(["brief", "snippets", "summary", "exact"]);

export async function startMcpServer(options: { root?: string }): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export function createMcpServer(options: { root?: string }): McpServer {
  const server = new McpServer({
    name: "kairn",
    version: "0.1.0"
  });

  const runtime = new KairnRuntime(options.root);

  server.registerTool(
    "kairn_start_task",
    {
      title: "Start Kairn task",
      description: "Start a Kairn task session for the target repo.",
      inputSchema: {
        task: z.string().min(1)
      }
    },
    async ({ task }) => toolResult(await runtime.startTask(task))
  );

  server.registerTool(
    "kairn_find_context",
    {
      title: "Find context",
      description: "Find high-confidence files for the active task or query.",
      inputSchema: {
        sessionId: z.string().min(1),
        query: z.string().optional(),
        mode: contextModeSchema.optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, query, mode, budget }) =>
      toolResult(await runtime.findContext({ sessionId, query, mode, requestType: "find_context", budget }))
  );

  server.registerTool(
    "kairn_read_file",
    {
      title: "Read file",
      description: "Read exact source or compressed context for a file.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().min(1),
        mode: z.enum(["exact", "summary"]).optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, mode, budget }) =>
      toolResult(await runtime.readFile({ sessionId, target, mode, budget }))
  );

  server.registerTool(
    "kairn_read_symbol",
    {
      title: "Read symbol",
      description: "Read a symbol from a file with the lightweight V1 extractor.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().min(1),
        symbol: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, symbol, budget }) =>
      toolResult(await runtime.readSymbol({ sessionId, target, symbol, budget }))
  );

  server.registerTool(
    "kairn_get_related_files",
    {
      title: "Get related files",
      description: "Find related files with deterministic import/path/test heuristics.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, budget }) => toolResult(await runtime.getRelatedFiles({ sessionId, target, budget }))
  );

  server.registerTool(
    "kairn_find_tests",
    {
      title: "Find tests",
      description: "Find test files and package scripts related to a file or task.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, budget }) => toolResult(await runtime.findTests({ sessionId, target, budget }))
  );

  server.registerTool(
    "kairn_review_diff",
    {
      title: "Review diff",
      description: "Review the current git diff against the task session context.",
      inputSchema: {
        sessionId: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, budget }) => toolResult(await runtime.reviewDiff({ sessionId, budget }))
  );

  server.registerTool(
    "kairn_compress_output",
    {
      title: "Compress output",
      description: "Compress test, lint, typecheck, or generic command output for the active task.",
      inputSchema: {
        sessionId: z.string().min(1),
        type: outputKindSchema,
        output: z.string(),
        budget: z.number().int().positive().optional()
      }
    },
    ({ sessionId, type, output, budget }) =>
      toolResult(runtime.compressOutput({ sessionId, type: type as OutputKind, output, budget, source: "mcp" }))
  );

  server.registerTool(
    "kairn_get_metrics",
    {
      title: "Get metrics",
      description: "Return session token-savings and hook/watch metrics.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    ({ sessionId }) => toolResult(runtime.getMetrics(sessionId))
  );

  server.registerTool(
    "kairn_get_session_state",
    {
      title: "Get session state",
      description: "Return Kairn's stored task session state.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    ({ sessionId }) => toolResult(runtime.getSession(sessionId))
  );

  return server;
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
