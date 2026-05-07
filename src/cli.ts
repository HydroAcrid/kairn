#!/usr/bin/env node
import { Command, Option } from "commander";
import { KairnRuntime } from "./runtime/KairnRuntime.js";
import { startMcpServer } from "./server/mcp.js";
import type { ContextQueryMode, MetricsSummary, OutputKind, WatchEventSource, WatchSnapshot } from "./types.js";
import { printContextResponse, printJson, readStdin } from "./cli/output.js";
import { normalizeHookPayload, hostHookOutput } from "./watch/normalizeHook.js";
import { runRepoWatcher } from "./watch/watchRepo.js";

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
  .addOption(new Option("--mode <mode>", "response mode for query/file context").choices(["brief", "snippets", "summary", "exact"]))
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
                mode: options.summary || options.mode === "summary" ? "summary" : "exact",
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
                      budget,
                      mode: options.mode
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
          budget: options.budget,
          source: "cli"
        });
        printContextResponse(response, options.json);
      });
    }
  );

program
  .command("watch")
  .description("Watch local work and update a Kairn task session.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--debounce <ms>", "file-change debounce window", parsePositiveInt, 250)
  .option("--poll <ms>", "git diff polling interval", parsePositiveInt, 2000)
  .option("--once", "run one snapshot and exit")
  .option("--json", "print JSON output")
  .action(
    async (options: {
      session: string;
      root: string;
      debounce: number;
      poll: number;
      once?: boolean;
      json?: boolean;
    }) => {
      await withRuntime(options.root, async (runtime) => {
        await runRepoWatcher({
          runtime,
          sessionId: options.session,
          rootPath: options.root,
          debounceMs: options.debounce,
          pollMs: options.poll,
          once: options.once,
          onSnapshot: (snapshot) => printWatchSnapshot(snapshot, Boolean(options.json))
        });
      });
    }
  );

program
  .command("hook")
  .description("Ingest a generic, Claude, or Codex hook payload into a Kairn task session.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .addOption(new Option("--source <source>", "hook source").choices(["generic", "claude", "codex"]).default("generic"))
  .option("--event <name>", "override hook event name")
  .option("--json", "print JSON output")
  .action(
    async (options: {
      session: string;
      root: string;
      source: WatchEventSource;
      event?: string;
      json?: boolean;
    }) => {
      await withRuntime(options.root, async (runtime) => {
        const raw = await readStdin();
        const payload = raw.trim() ? JSON.parse(raw) as unknown : {};
        const event = normalizeHookPayload({
          source: options.source,
          payload,
          eventName: options.event
        });
        const result = await runtime.handleHookEvent({
          sessionId: options.session,
          event
        });

        if (options.json) {
          printJson(result);
          return;
        }

        const output = hostHookOutput({
          source: options.source,
          eventName: event.eventName,
          content: result.recommendation?.content,
          json: false
        });
        if (output) {
          process.stdout.write(`${output}\n`);
        }
      });
    }
  );

program
  .command("metrics")
  .description("Show session token-savings and hook/watch metrics.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--json", "print JSON output")
  .action(async (options: { session: string; root: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const metrics = runtime.getMetrics(options.session);
      if (options.json) {
        printJson(metrics);
        return;
      }

      printMetrics(metrics);
    });
  });

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
  mode?: ContextQueryMode;
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

function printWatchSnapshot(snapshot: WatchSnapshot, json: boolean): void {
  if (json) {
    printJson(snapshot);
    return;
  }

  process.stdout.write(
    [
      "Kairn watch snapshot.",
      `Session: ${snapshot.sessionId}`,
      `Indexed files: ${snapshot.indexedFiles}`,
      `Changed files: ${snapshot.changedFiles.length}`,
      snapshot.changedFiles.length > 0 ? snapshot.changedFiles.map((file) => `- ${file}`).join("\n") : "No git diff detected.",
      snapshot.recommendations.length > 0
        ? ["", "Recommendations", ...snapshot.recommendations.map((item) => `- ${item.summary}`)].join("\n")
        : "",
      ""
    ].filter(Boolean).join("\n")
  );
}

function printMetrics(metrics: MetricsSummary): void {
  const lines = [
    "Kairn metrics.",
    `Session: ${metrics.sessionId}`,
    `Events measured: ${metrics.totals.events}`,
    `Estimated baseline tokens: ${metrics.totals.baselineTokens}`,
    `Kairn output tokens: ${metrics.totals.outputTokens}`,
    `Estimated tokens saved: ${metrics.totals.savedTokens}`,
    `Estimated savings rate: ${Math.round(metrics.totals.savingsRate * 100)}%`,
    "",
    "By kind",
    ...Object.entries(metrics.byKind).map(
      ([kind, bucket]) => `- ${kind}: ${bucket.savedTokens} saved across ${bucket.events} event(s)`
    ),
    "",
    "Watcher/hooks",
    `- events: ${metrics.watch.events}`,
    `- failures: ${metrics.watch.failures}`,
    `- file changes: ${metrics.watch.fileChanges}`,
    `- hook events: ${metrics.watch.hooks}`,
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}
