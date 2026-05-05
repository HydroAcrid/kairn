#!/usr/bin/env node
import { Command, Option } from "commander";
import { KairnRuntime } from "./runtime/KairnRuntime.js";
import { startMcpServer } from "./server/mcp.js";
import type { OutputKind } from "./types.js";
import { printContextResponse, printJson, readStdin } from "./cli/output.js";

const program = new Command();

program
  .name("kairn")
  .description("Local-first dynamic context runtime for software engineering agents.")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize Kairn state in a target repo.")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--json", "print JSON output")
  .action(async (options: { root: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const result = await runtime.init();
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(
        [
          "Kairn initialized.",
          `Root: ${result.rootPath}`,
          `State: ${result.kairnDir}`,
          `Files indexed: ${result.scan.files.length}`,
          `Ignored candidates: ${result.scan.ignoredCount}`,
          ""
        ].join("\n")
      );
    });
  });

program
  .command("start")
  .description("Start a task session.")
  .argument("<task>", "task description")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--json", "print JSON output")
  .action(async (task: string, options: { root: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const result = await runtime.startTask(task);
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(`Session: ${result.session.id}\n\n`);
      printContextResponse(result.response);
    });
  });

program
  .command("serve")
  .description("Start the local dynamic context runtime.")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--mcp", "serve the MCP stdio transport")
  .action(async (options: { root: string; mcp?: boolean }) => {
    if (!options.mcp) {
      throw new Error("Only MCP stdio mode is implemented in the MVP. Run: kairn serve --mcp");
    }

    await startMcpServer({ root: options.root });
  });

program
  .command("context")
  .description("Query live context from a task session.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--query <query>", "find context for a query")
  .option("--file <path>", "read file context")
  .option("--symbol <symbol>", "read symbol from --file")
  .option("--related <path>", "find related files")
  .option("--tests [path]", "find related tests")
  .option("--summary", "use compressed summary mode for --file")
  .option("--budget <tokens>", "approximate response token budget", parsePositiveInt)
  .option("--json", "print JSON output")
  .action(async (options: ContextOptions) => {
    await withRuntime(options.root, async (runtime) => {
      const budget = options.budget;
      const response =
        options.file && options.symbol
          ? await runtime.readSymbol({
              sessionId: options.session,
              target: options.file,
              symbol: options.symbol,
              budget
            })
          : options.file
            ? await runtime.readFile({
                sessionId: options.session,
                target: options.file,
                mode: options.summary ? "summary" : "exact",
                budget
              })
            : options.related
              ? await runtime.getRelatedFiles({
                  sessionId: options.session,
                  target: options.related,
                  budget
                })
              : typeof options.tests === "string"
                ? await runtime.findTests({
                    sessionId: options.session,
                    target: options.tests,
                    budget
                  })
                : options.tests
                  ? await runtime.findTests({ sessionId: options.session, budget })
                  : await runtime.findContext({
                      sessionId: options.session,
                      query: options.query,
                      requestType: "find_context",
                      budget
                    });

      printContextResponse(response, options.json);
    });
  });

program
  .command("diff")
  .description("Analyze current git diff against a task session.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--budget <tokens>", "approximate response token budget", parsePositiveInt)
  .option("--json", "print JSON output")
  .action(async (options: { session: string; root: string; budget?: number; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const response = await runtime.reviewDiff({ sessionId: options.session, budget: options.budget });
      printContextResponse(response, options.json);
    });
  });

program
  .command("compress")
  .description("Compress command output against a task session.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .addOption(
    new Option("--type <type>", "output kind")
      .choices(["test", "lint", "typecheck", "generic"])
      .default("generic")
  )
  .option("--output <text>", "output text; stdin is used when omitted")
  .option("--budget <tokens>", "approximate response token budget", parsePositiveInt)
  .option("--json", "print JSON output")
  .action(
    async (options: {
      session: string;
      root: string;
      type: OutputKind;
      output?: string;
      budget?: number;
      json?: boolean;
    }) => {
      await withRuntime(options.root, async (runtime) => {
        const output = options.output ?? (await readStdin());
        const response = runtime.compressOutput({
          sessionId: options.session,
          type: options.type,
          output,
          budget: options.budget
        });
        printContextResponse(response, options.json);
      });
    }
  );

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kairn: ${message}\n`);
  process.exitCode = 1;
});

type ContextOptions = {
  session: string;
  root: string;
  query?: string;
  file?: string;
  symbol?: string;
  related?: string;
  tests?: true | string;
  summary?: boolean;
  budget?: number;
  json?: boolean;
};

async function withRuntime<T>(root: string, cb: (runtime: KairnRuntime) => Promise<T>): Promise<T> {
  const runtime = new KairnRuntime(root);
  try {
    return await cb(runtime);
  } finally {
    runtime.close();
  }
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}
