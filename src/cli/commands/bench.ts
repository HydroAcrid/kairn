import { Command, Option } from "commander";
import type { BenchmarkReport, BenchmarkRunMode } from "../../types.js";
import {
  formatBenchmarkMarkdown,
  printBenchmarkComparison,
  printBenchmarkMatrixReport,
  printBenchmarkEnduranceReport,
  printBenchmarkEnduranceRepeatReport,
  printBenchmarkProof,
  printBenchmarkReport
} from "../formatters.js";
import { runBenchmarkRepoMatrix } from "../../bench/matrix.js";
import { runBenchmarkEndurance, runBenchmarkEnduranceRepeats } from "../../bench/endurance.js";
import { buildSweBenchProPilot, fetchSweBenchProRows, loadSweBenchProRows, writeSweBenchProPilot } from "../../bench/sweBenchPro.js";
import { parsePositiveInt, withRuntime } from "../helpers.js";
import { printJson } from "../output.js";

export function registerBenchCommands(program: Command): void {
  const benchCommand = program
    .command("bench")
    .description("Run deterministic and optional live-agent benchmarks for Kairn retrieval quality.");

  benchCommand
    .command("swe-pro-pilot")
    .description("Generate a small SWE-Bench Pro pilot suite and repo-matrix preflight sample.")
    .option("--input <path>", "local SWE-Bench Pro rows JSON/JSONL export; fetches public rows when omitted")
    .option("--out-dir <path>", "directory for generated suite/matrix files", "examples/bench/swe-pro-pilot")
    .option("--offset <n>", "public dataset row offset", parseNonNegativeInt, 0)
    .option("--limit <n>", "maximum selected tasks", parsePositiveInt, 20)
    .option("--fetch-length <n>", "number of public rows to fetch before filtering", parsePositiveInt, 50)
    .option("--languages <csv>", "optional comma-separated language filter, for example python,js,go")
    .option("--repos <csv>", "optional comma-separated repo filter, for example qutebrowser/qutebrowser,NodeBB/NodeBB")
    .option("--json", "print JSON output")
    .action(
      async (options: {
        input?: string;
        outDir: string;
        offset: number;
        limit: number;
        fetchLength: number;
        languages?: string;
        repos?: string;
        json?: boolean;
      }) => {
        const rows = options.input
          ? loadSweBenchProRows(options.input)
          : await fetchSweBenchProRows({ offset: options.offset, length: options.fetchLength });
        const pilot = buildSweBenchProPilot({
          rows,
          limit: options.limit,
          languages: csvList(options.languages),
          repos: csvList(options.repos)
        });
        const outputs = writeSweBenchProPilot({ pilot, outDir: options.outDir });
        const result = {
          generatedAt: pilot.generatedAt,
          source: pilot.source,
          rows: pilot.rows,
          summary: pilot.summary,
          outputs
        };
        if (options.json) {
          printJson(result);
          return;
        }
        console.log(`Generated SWE-Bench Pro pilot with ${pilot.rows} tasks.`);
        console.log(`Suite: ${outputs.suitePath}`);
        console.log(`Matrix: ${outputs.matrixPath}`);
        console.log(`Summary: ${outputs.summaryPath}`);
        for (const warning of pilot.summary.warnings) {
          console.log(`Warning: ${warning}`);
        }
      }
    );

  benchCommand
    .command("matrix")
    .description("Run cheap repo-matrix preflight checks before live-agent benchmarking.")
    .requiredOption("--matrix <path>", "repo matrix JSON path")
    .option("--workdir <path>", "workspace for cloned repos")
    .option("--json", "print JSON output")
    .action(async (options: { matrix: string; workdir?: string; json?: boolean }) => {
      const report = await runBenchmarkRepoMatrix({
        matrixPath: options.matrix,
        workdir: options.workdir
      });
      if (options.json) {
        printJson(report);
        return;
      }
      printBenchmarkMatrixReport(report);
    });

  benchCommand
    .command("endurance")
    .description("Run a multi-turn endurance benchmark in one disposable workspace/session.")
    .option("--root <path>", "target repository root", process.cwd())
    .requiredOption("--suite <path>", "endurance suite JSON path")
    .requiredOption("--baseline-command <command>", "baseline live-agent command with {prompt}, {root}, and {turn} placeholders")
    .option("--kairn-command <command>", "direct Kairn prompt-prepend live-agent command with {prompt}, {root}, {session}, and {turn} placeholders")
    .option("--mcp-command <command>", "MCP-assisted live-agent command with {prompt}, {root}, {session}, and {turn} placeholders")
    .option("--hook-full-prime-command <command>", "hook full-prime endurance command with {prompt}, {root}, {session}, and {turn} placeholders")
    .option("--hook-full-prime-setup-command <command>", "hook full-prime setup command timed separately before endurance turns")
    .option("--kairn-codex-session-command <command>", "session-bound kairn codex equivalent command with {prompt}, {root}, {session}, and {turn} placeholders")
    .option("--kairn-codex-session-setup-command <command>", "session-bound kairn codex setup command timed separately before endurance turns")
    .option("--real-mcp-first-command <command>", "real MCP-first endurance command with {prompt}, {root}, {session}, and {turn} placeholders")
    .option("--real-mcp-first-setup-command <command>", "real MCP-first setup command timed separately before endurance turns")
    .option("--hybrid-mcp-brief-command <command>", "hybrid MCP brief endurance command with {prompt}, {root}, {session}, and {turn} placeholders")
    .option("--hybrid-mcp-brief-setup-command <command>", "hybrid MCP brief setup command timed separately before endurance turns")
    .option("--turn-timeout <ms>", "per-turn live-agent command timeout", parsePositiveInt, 180000)
    .option("--repeat <n>", "run the endurance suite multiple times and aggregate median results", parsePositiveInt, 1)
    .option("--json", "print JSON output")
    .action(
      async (options: {
        root: string;
        suite: string;
        baselineCommand: string;
        kairnCommand: string;
        mcpCommand?: string;
        hookFullPrimeCommand?: string;
        hookFullPrimeSetupCommand?: string;
        kairnCodexSessionCommand?: string;
        kairnCodexSessionSetupCommand?: string;
        realMcpFirstCommand?: string;
        realMcpFirstSetupCommand?: string;
        hybridMcpBriefCommand?: string;
        hybridMcpBriefSetupCommand?: string;
        turnTimeout: number;
        repeat: number;
        json?: boolean;
      }) => {
        const input = {
          rootPath: options.root,
          suitePath: options.suite,
          baselineCommand: options.baselineCommand,
          kairnCommand: options.kairnCommand,
          mcpCommand: options.mcpCommand,
          hookFullPrimeCommand: options.hookFullPrimeCommand,
          hookFullPrimeSetupCommand: options.hookFullPrimeSetupCommand,
          kairnCodexSessionCommand: options.kairnCodexSessionCommand,
          kairnCodexSessionSetupCommand: options.kairnCodexSessionSetupCommand,
          realMcpFirstCommand: options.realMcpFirstCommand,
          realMcpFirstSetupCommand: options.realMcpFirstSetupCommand,
          hybridMcpBriefCommand: options.hybridMcpBriefCommand,
          hybridMcpBriefSetupCommand: options.hybridMcpBriefSetupCommand,
          turnTimeoutMs: options.turnTimeout
        };
        const report = options.repeat > 1
          ? await runBenchmarkEnduranceRepeats({ ...input, repeat: options.repeat })
          : await runBenchmarkEndurance(input);
        if (options.json) {
          printJson(report);
          return;
        }
        if ("aggregate" in report) {
          printBenchmarkEnduranceRepeatReport(report);
          return;
        }
        printBenchmarkEnduranceReport(report);
      }
    );

  benchCommand
    .command("run")
    .description("Run a benchmark suite.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--suite <path>", "benchmark suite JSON path or 'default'", "default")
    .addOption(new Option("--mode <mode>", "benchmark mode").choices(["replay", "agent", "hybrid"]).default("hybrid"))
    .option("--agent-command <command>", "explicit live-agent command with {prompt} and {root} placeholders")
    .option("--agent-timeout <ms>", "live-agent command timeout", parsePositiveInt, 120000)
    .option("--json", "print JSON output")
    .action(
      async (options: {
        root: string;
        suite: string;
        mode: BenchmarkRunMode;
        agentCommand?: string;
        agentTimeout: number;
        json?: boolean;
      }) => {
        await withRuntime(options.root, async (runtime) => {
          const report = await runtime.runBenchmark({
            suitePath: options.suite,
            mode: options.mode,
            agentCommand: options.agentCommand,
            agentTimeoutMs: options.agentTimeout
          });
          if (options.json) {
            printJson(report);
            return;
          }
          printBenchmarkReport(report);
        });
      }
    );

  benchCommand
    .command("ab")
    .description("Run baseline and Kairn-assisted live-agent benchmarks, then compare observed usage.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--suite <path>", "benchmark suite JSON path or 'default'", "default")
    .requiredOption("--baseline-command <command>", "baseline live-agent command with {prompt} and {root} placeholders")
    .requiredOption("--kairn-command <command>", "Kairn-assisted live-agent command with {prompt} and {root} placeholders")
    .option("--agent-timeout <ms>", "live-agent command timeout", parsePositiveInt, 120000)
    .option("--json", "print JSON output")
    .action(
      async (options: {
        root: string;
        suite: string;
        baselineCommand: string;
        kairnCommand: string;
        agentTimeout: number;
        json?: boolean;
      }) => {
        await withRuntime(options.root, async (runtime) => {
          const baseline = await runtime.runBenchmark({
            suitePath: options.suite,
            mode: "agent",
            agentCommand: options.baselineCommand,
            agentTimeoutMs: options.agentTimeout
          });
          const kairn = await runtime.runBenchmark({
            suitePath: options.suite,
            mode: "agent",
            agentCommand: options.kairnCommand,
            agentTimeoutMs: options.agentTimeout
          });
          const comparison = runtime.compareBenchmarkRuns({
            beforeRunId: baseline.run.id,
            afterRunId: kairn.run.id
          });
          if (options.json) {
            printJson(comparison);
            return;
          }
          printBenchmarkComparison(comparison);
        });
      }
    );

  benchCommand
    .command("prove")
    .description("Compare baseline, prompt-hook, prompt+tool-hook, and manual-prime live-agent runs.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--suite <path>", "benchmark suite JSON path or 'default'", "default")
    .requiredOption("--baseline-command <command>", "baseline live-agent command with {prompt} and {root} placeholders")
    .option("--baseline-setup-command <command>", "baseline setup command timed separately before the live-agent command")
    .option("--prompt-only-command <command>", "prompt-submit-only live-agent command with {prompt} and {root} placeholders")
    .option("--prompt-only-setup-command <command>", "prompt-only setup command timed separately before the live-agent command")
    .option("--prompt-plus-hooks-command <command>", "prompt and post-tool hook live-agent command with {prompt} and {root} placeholders")
    .option("--prompt-plus-hooks-setup-command <command>", "prompt-plus-hooks setup command timed separately before the live-agent command")
    .option("--manual-prime-command <command>", "manual-prime live-agent command with {prompt} and {root} placeholders")
    .option("--manual-prime-setup-command <command>", "manual-prime setup command timed separately before the live-agent command")
    .option("--hook-full-prime-command <command>", "UserPromptSubmit full-prime live-agent command with {prompt} and {root} placeholders")
    .option("--hook-full-prime-setup-command <command>", "hook full-prime setup/index command timed separately before the live-agent command")
    .option("--hook-tiny-directive-command <command>", "UserPromptSubmit tiny-directive live-agent command with {prompt} and {root} placeholders")
    .option("--hook-tiny-directive-setup-command <command>", "hook tiny-directive setup command timed separately before the live-agent command")
    .option("--hook-tiny-with-failures-command <command>", "tiny prompt hook plus failure-only post-tool hook command with {prompt} and {root} placeholders")
    .option("--hook-tiny-with-failures-setup-command <command>", "hook tiny-with-failures setup command timed separately before the live-agent command")
    .option("--mcp-first-command <command>", "MCP-first live-agent command with {prompt} and {root} placeholders")
    .option("--mcp-first-setup-command <command>", "MCP-first setup command timed separately before the live-agent command")
    .option("--real-mcp-first-command <command>", "real MCP-first live-agent command with {prompt} and {root} placeholders")
    .option("--real-mcp-first-setup-command <command>", "real MCP-first setup command timed separately before the live-agent command")
    .option("--mcp-first-plus-hook-full-prime-command <command>", "MCP-first plus full-prime hook command with {prompt} and {root} placeholders")
    .option("--mcp-first-plus-hook-full-prime-setup-command <command>", "MCP-first plus full-prime setup command timed separately before the live-agent command")
    .option("--hybrid-mcp-brief-command <command>", "hybrid MCP plus mcp-brief hook command with {prompt} and {root} placeholders")
    .option("--hybrid-mcp-brief-setup-command <command>", "hybrid MCP brief setup command timed separately before the live-agent command")
    .option("--passive-command <command>", "legacy alias for --prompt-plus-hooks-command")
    .option("--proactive-command <command>", "legacy alias for --manual-prime-command")
    .option("--agent-timeout <ms>", "live-agent command timeout", parsePositiveInt, 120000)
    .option("--repeat <n>", "number of proof repeats", parsePositiveInt, 1)
    .option("--shuffle-order", "shuffle assistance mode order within each repeat")
    .option("--json", "print JSON output")
    .action(
      async (options: {
        root: string;
        suite: string;
        baselineCommand: string;
        baselineSetupCommand?: string;
        promptOnlyCommand?: string;
        promptOnlySetupCommand?: string;
        promptPlusHooksCommand?: string;
        promptPlusHooksSetupCommand?: string;
        manualPrimeCommand?: string;
        manualPrimeSetupCommand?: string;
        hookFullPrimeCommand?: string;
        hookFullPrimeSetupCommand?: string;
        hookTinyDirectiveCommand?: string;
        hookTinyDirectiveSetupCommand?: string;
        hookTinyWithFailuresCommand?: string;
        hookTinyWithFailuresSetupCommand?: string;
        mcpFirstCommand?: string;
        mcpFirstSetupCommand?: string;
        realMcpFirstCommand?: string;
        realMcpFirstSetupCommand?: string;
        mcpFirstPlusHookFullPrimeCommand?: string;
        mcpFirstPlusHookFullPrimeSetupCommand?: string;
        hybridMcpBriefCommand?: string;
        hybridMcpBriefSetupCommand?: string;
        passiveCommand?: string;
        proactiveCommand?: string;
        agentTimeout: number;
        repeat: number;
        shuffleOrder?: boolean;
        json?: boolean;
      }) => {
        await withRuntime(options.root, async (runtime) => {
          const proof = await runtime.proveBenchmark({
            suitePath: options.suite,
            baselineCommand: options.baselineCommand,
            baselineSetupCommand: options.baselineSetupCommand,
            promptOnlyCommand: options.promptOnlyCommand,
            promptOnlySetupCommand: options.promptOnlySetupCommand,
            promptPlusHooksCommand: options.promptPlusHooksCommand,
            promptPlusHooksSetupCommand: options.promptPlusHooksSetupCommand,
            manualPrimeCommand: options.manualPrimeCommand,
            manualPrimeSetupCommand: options.manualPrimeSetupCommand,
            hookFullPrimeCommand: options.hookFullPrimeCommand,
            hookFullPrimeSetupCommand: options.hookFullPrimeSetupCommand,
            hookTinyDirectiveCommand: options.hookTinyDirectiveCommand,
            hookTinyDirectiveSetupCommand: options.hookTinyDirectiveSetupCommand,
            hookTinyWithFailuresCommand: options.hookTinyWithFailuresCommand,
            hookTinyWithFailuresSetupCommand: options.hookTinyWithFailuresSetupCommand,
            mcpFirstCommand: options.mcpFirstCommand,
            mcpFirstSetupCommand: options.mcpFirstSetupCommand,
            realMcpFirstCommand: options.realMcpFirstCommand,
            realMcpFirstSetupCommand: options.realMcpFirstSetupCommand,
            mcpFirstPlusHookFullPrimeCommand: options.mcpFirstPlusHookFullPrimeCommand,
            mcpFirstPlusHookFullPrimeSetupCommand: options.mcpFirstPlusHookFullPrimeSetupCommand,
            hybridMcpBriefCommand: options.hybridMcpBriefCommand,
            hybridMcpBriefSetupCommand: options.hybridMcpBriefSetupCommand,
            passiveCommand: options.passiveCommand,
            proactiveCommand: options.proactiveCommand,
            agentTimeoutMs: options.agentTimeout,
            repeat: options.repeat,
            shuffleOrder: Boolean(options.shuffleOrder)
          });
          if (options.json) {
            printJson(proof);
            return;
          }
          printBenchmarkProof(proof);
        });
      }
    );

  benchCommand
    .command("report")
    .description("Report benchmark evidence for a run or target repo.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--run <id>", "benchmark run ID")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; run?: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const report = runtime.getBenchmarkReport({ runId: options.run });
        if (options.json) {
          printJson(report);
          return;
        }
        printBenchmarkReport(report);
      });
    });

  benchCommand
    .command("compare")
    .description("Compare two benchmark runs.")
    .requiredOption("--before <id>", "older benchmark run ID")
    .requiredOption("--after <id>", "newer benchmark run ID")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action(async (options: { before: string; after: string; root: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const comparison = runtime.compareBenchmarkRuns({
          beforeRunId: options.before,
          afterRunId: options.after
        });
        if (options.json) {
          printJson(comparison);
          return;
        }
        printBenchmarkComparison(comparison);
      });
    });

  benchCommand
    .command("export")
    .description("Export a benchmark run as JSON or Markdown.")
    .requiredOption("--run <id>", "benchmark run ID")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--format <format>", "export format").choices(["json", "md"]).default("md"))
    .action(async (options: { run: string; root: string; format: "json" | "md" }) => {
      await withRuntime(options.root, async (runtime) => {
        const report = runtime.getBenchmarkReport({ runId: options.run }) as BenchmarkReport;
        if (options.format === "json") {
          printJson(report);
          return;
        }
        process.stdout.write(formatBenchmarkMarkdown(report));
      });
    });
}

function csvList(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function parseNonNegativeInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received: ${value}`);
  }
  return parsed;
}
