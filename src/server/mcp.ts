import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { OutputKind } from "../types.js";

const outputKindSchema = z.enum(["test", "lint", "typecheck", "generic"]);
const contextModeSchema = z.enum(["brief", "snippets", "summary", "exact"]);
const primeProfileSchema = z.enum(["auto", "ui", "workflow", "backend", "test", "generic"]);

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
    "kairn_prepare_task",
    {
      title: "Prepare Kairn task",
      description: "Start or reuse a task session and return proactive context plus recommended next Kairn tool calls.",
      inputSchema: {
        task: z.string().min(1),
        sessionId: z.string().optional(),
        budget: z.number().int().positive().optional(),
        profile: primeProfileSchema.optional()
      }
    },
    async ({ task, sessionId, budget, profile }) => {
      const prime = await runtime.primeContext({ task, sessionId, budget: budget ?? 900, profile });
      return mcpToolResult(runtime, "kairn_prepare_task", { task, sessionId, budget, profile }, {
        session: prime.session,
        task: prime.task,
        profile: prime.profile,
        content: prime.content,
        startFiles: prime.files.slice(0, 4),
        files: prime.files.slice(0, 4),
        quality: prime.quality,
        warnings: prime.warnings,
        suggestedCommands: prime.suggestedCommands.slice(0, 3),
        tokenEstimate: prime.tokenEstimate,
        recommendedToolCalls: [
          ...(prime.files[0] ? [{ tool: "kairn_read_file", input: { sessionId: prime.session.id, target: prime.files[0], mode: "summary", budget: 700 } }] : []),
          ...(prime.files[0] ? [{ tool: "kairn_get_next_context", input: { sessionId: prime.session.id, budget: 700 } }] : []),
          ...(prime.files[0] ? [{ tool: "kairn_find_tests", input: { sessionId: prime.session.id, target: prime.files[0], budget: 600 } }] : [])
        ]
      });
    }
  );

  server.registerTool(
    "kairn_start_task",
    {
      title: "Start Kairn task",
      description: "Start a Kairn task session for the target repo.",
      inputSchema: {
        task: z.string().min(1)
      }
    },
    async ({ task }) => mcpToolResult(runtime, "kairn_start_task", { task }, await runtime.startTask(task))
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
      mcpToolResult(
        runtime,
        "kairn_find_context",
        { sessionId, query, mode, budget },
        await runtime.findContext({ sessionId, query, mode, requestType: "find_context", budget })
      )
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
      mcpToolResult(runtime, "kairn_read_file", { sessionId, target, mode, budget }, await runtime.readFile({ sessionId, target, mode, budget }))
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
      mcpToolResult(
        runtime,
        "kairn_read_symbol",
        { sessionId, target, symbol, budget },
        await runtime.readSymbol({ sessionId, target, symbol, budget })
      )
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
    async ({ sessionId, target, budget }) =>
      mcpToolResult(runtime, "kairn_get_related_files", { sessionId, target, budget }, await runtime.getRelatedFiles({ sessionId, target, budget }))
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
    async ({ sessionId, target, budget }) =>
      mcpToolResult(runtime, "kairn_find_tests", { sessionId, target, budget }, await runtime.findTests({ sessionId, target, budget }))
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
    async ({ sessionId, budget }) => mcpToolResult(runtime, "kairn_review_diff", { sessionId, budget }, await runtime.reviewDiff({ sessionId, budget }))
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
      mcpToolResult(
        runtime,
        "kairn_compress_output",
        { sessionId, type, budget },
        runtime.compressOutput({ sessionId, type: type as OutputKind, output, budget, source: "mcp" })
      )
  );

  server.registerTool(
    "kairn_get_next_context",
    {
      title: "Get next context",
      description: "Recommend the next smallest useful context from session history, failures, and diff state.",
      inputSchema: {
        sessionId: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, budget }) =>
      mcpToolResult(runtime, "kairn_get_next_context", { sessionId, budget }, await runtime.getNextContext({ sessionId, budget }))
  );

  server.registerTool(
    "kairn_get_failure_context",
    {
      title: "Get failure context",
      description: "Build failure-first context from test, lint, typecheck, or generic command output.",
      inputSchema: {
        sessionId: z.string().min(1),
        type: outputKindSchema,
        output: z.string().optional(),
        command: z.string().optional(),
        files: z.array(z.string()).optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, type, output, command, files, budget }) =>
      mcpToolResult(
        runtime,
        "kairn_get_failure_context",
        { sessionId, type, command, files, budget },
        await runtime.getFailureContext({ sessionId, type: type as OutputKind, output, command, files, budget, source: "mcp" })
      )
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
    ({ sessionId }) => mcpToolResult(runtime, "kairn_get_session_state", { sessionId }, runtime.getSession(sessionId))
  );

  return server;
}

function mcpToolResult(runtime: KairnRuntime, toolName: string, input: unknown, value: unknown) {
  runtime.recordMcpToolCall({
    toolName,
    input,
    result: value
  });
  return toolResult(value);
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
