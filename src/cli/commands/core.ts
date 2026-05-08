import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command, Option } from "commander";
import { startKairnDaemon } from "../../daemon/server.js";
import { startMcpServer } from "../../server/mcp.js";
import type { IndexStateStats, PrimeProfile } from "../../types.js";
import { printContextPrime } from "../formatters.js";
import { codexExecArgs, parsePositiveInt, shellQuote, waitForShutdown, withRuntime } from "../helpers.js";
import { printContextResponse, printJson } from "../output.js";

export function registerCoreCommands(program: Command): void {
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
            result.scan.skippedByLimit ? `Skipped by index cap: ${result.scan.skippedByLimit}` : "",
            ""
          ].filter(Boolean).join("\n") + "\n"
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
    .command("prime")
    .description("Generate proactive task context before an agent starts scanning.")
    .argument("<task>", "task description")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--session <id>", "reuse an existing Kairn task session")
    .addOption(new Option("--profile <profile>", "prime profile").choices(["auto", "ui", "workflow", "backend", "test", "failure_debug", "generic"]).default("auto"))
    .option("--budget <tokens>", "prime response token budget", parsePositiveInt)
    .option("--json", "print JSON output")
    .action(async (task: string, options: { root: string; session?: string; profile: PrimeProfile; budget?: number; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const prime = await runtime.primeContext({
          task,
          sessionId: options.session,
          profile: options.profile,
          budget: options.budget
        });
        if (options.json) {
          printJson(prime);
          return;
        }
        printContextPrime(prime);
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
    .command("daemon")
    .description("Keep a warm Kairn runtime available for hook requests.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--port <port>", "daemon port override", parsePositiveInt)
    .option("--json", "print JSON output")
    .action(async (options: { root: string; port?: number; json?: boolean }) => {
      const daemon = await startKairnDaemon({ root: options.root, port: options.port });
      const result = {
        rootPath: daemon.rootPath,
        port: daemon.port,
        url: daemon.url
      };
      if (options.json) {
        printJson(result);
      } else {
        process.stdout.write(
          [
            "Kairn daemon listening.",
            `Root: ${result.rootPath}`,
            `URL: ${result.url}`,
            "Press Ctrl+C to stop.",
            ""
          ].join("\n")
        );
      }

      await waitForShutdown(async () => {
        await daemon.close();
      });
    });

  const index = program
    .command("index")
    .description("Inspect and compact Kairn index state.");

  index
    .command("status")
    .description("Show index tier and storage state.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action(async (options: { root: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const status = runtime.getIndexStatus();
        if (options.json) {
          printJson(status);
          return;
        }
        process.stdout.write(formatIndexStatus(status));
      });
    });

  index
    .command("compact")
    .description("Checkpoint WAL and prune low-value index state to configured limits.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action(async (options: { root: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const result = runtime.compactIndex();
        if (options.json) {
          printJson(result);
          return;
        }
        process.stdout.write(
          [
            "Kairn index compacted.",
            `Before: ${formatBytes(result.before.totalSizeBytes)} (${result.before.graphEdgeCount} edges, ${result.before.semanticChunkCount} chunks)`,
            `After: ${formatBytes(result.after.totalSizeBytes)} (${result.after.graphEdgeCount} edges, ${result.after.semanticChunkCount} chunks)`,
            `Deleted graph edges: ${result.graphEdgesDeleted}`,
            `Deleted semantic chunks: ${result.semanticChunksDeleted}`,
            ""
          ].join("\n")
        );
      });
    });

  program
    .command("codex")
    .description("Launch Codex with Kairn prime context prepended to the task prompt.")
    .argument("<task...>", "task to pass to Codex")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--profile <profile>", "prime profile").choices(["auto", "ui", "workflow", "backend", "test", "failure_debug", "generic"]).default("auto"))
    .option("--budget <tokens>", "prime response token budget", parsePositiveInt)
    .option("--codex-command <command>", "Codex command to execute", process.env.KAIRN_CODEX_CMD ?? "codex")
    .option("--model <model>", "Codex model")
    .addOption(new Option("--sandbox <mode>", "Codex sandbox mode").choices(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"))
    .option("--dry-run", "print the prepared prompt/command without launching Codex")
    .option("--json", "print JSON output")
    .action(async (taskParts: string[], options: {
      root: string;
      profile: PrimeProfile;
      budget?: number;
      codexCommand: string;
      model?: string;
      sandbox: string;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const task = taskParts.join(" ").trim();
      await withRuntime(options.root, async (runtime) => {
        const prime = await runtime.primeContext({
          task,
          profile: options.profile,
          budget: options.budget
        });
        const prompt = [
          prime.content,
          "",
          "User task:",
          task,
          "",
          "Use the Kairn context above first. Avoid broad scans unless the provided files are insufficient."
        ].join("\n");
        const result = {
          rootPath: path.resolve(options.root),
          codexCommand: options.codexCommand,
          args: codexExecArgs({ root: options.root, prompt, model: options.model, sandbox: options.sandbox }),
          prompt,
          prime
        };

        if (options.dryRun || options.json) {
          printJson(result);
          return;
        }

        const command = [options.codexCommand, ...result.args.map(shellQuote)].join(" ");
        const completed = spawnSync(command, {
          cwd: result.rootPath,
          shell: true,
          stdio: "inherit"
        });
        process.exitCode = completed.status ?? (completed.error ? 1 : 0);
      });
    });
}

function formatIndexStatus(status: IndexStateStats): string {
  return [
    "Kairn index status.",
    `Root: ${status.rootPath}`,
    `Database: ${status.databasePath}`,
    `State size: ${formatBytes(status.totalSizeBytes)} (db ${formatBytes(status.dbSizeBytes)}, wal ${formatBytes(status.walSizeBytes)})`,
    `Soft limit: ${formatBytes(status.maxStateBytes)}`,
    `Hard limit: ${formatBytes(status.hardMaxStateBytes)}`,
    `Files: ${status.fileCount}`,
    `Symbols: ${status.symbolCount}`,
    `Graph edges: ${status.graphEdgeCount}`,
    `Semantic chunks: ${status.semanticChunkCount}`,
    `Semantic vectors: ${status.semanticVectorCount}`,
    `Lexical documents: ${status.lexicalDocumentCount}`,
    `Lexical terms: ${status.lexicalTermCount}`,
    `Tiers: tier0=${status.tiers.tier0}, tier1=${status.tiers.tier1}, tier2=${status.tiers.tier2}, tier3=${status.tiers.tier3}, tier4=${status.tiers.tier4}`,
    ""
  ].join("\n");
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
