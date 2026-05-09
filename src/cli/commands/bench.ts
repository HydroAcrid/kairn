import { Command, Option } from "commander";
import type { BenchmarkReport, BenchmarkRunMode } from "../../types.js";
import {
  formatBenchmarkMarkdown,
  printBenchmarkComparison,
  printBenchmarkMatrixReport,
  printBenchmarkProof,
  printBenchmarkReport
} from "../formatters.js";
import { runBenchmarkRepoMatrix } from "../../bench/matrix.js";
import { parsePositiveInt, withRuntime } from "../helpers.js";
import { printJson } from "../output.js";

export function registerBenchCommands(program: Command): void {
  const benchCommand = program
    .command("bench")
    .description("Run deterministic and optional live-agent benchmarks for Kairn retrieval quality.");

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
