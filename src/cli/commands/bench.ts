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
import { prepareSweProOfficialEvaluator } from "../../bench/sweProOfficial.js";
import { buildSweAtlasQnaPilot, fetchSweAtlasQnaRows, loadSweAtlasQnaRows, writeSweAtlasQnaPilot } from "../../bench/sweAtlasQna.js";
import { buildSweContextBenchPilot, loadSweContextBenchRows, writeSweContextBenchPilot } from "../../bench/sweContextBench.js";
import { runBenchmarkMcpSmoke } from "../../bench/mcpSmoke.js";
import { runPublicationCampaign } from "../../bench/publication.js";
import { parsePositiveInt, withRuntime } from "../helpers.js";
import { printJson } from "../output.js";

export function registerBenchCommands(program: Command): void {
  const benchCommand = program
    .command("bench")
    .description("Run deterministic and optional live-agent benchmarks for Kairn retrieval quality.");

  benchCommand
    .command("swe-atlas-qna-pilot")
    .description("Generate a SWE-Atlas/QnA pilot suite and repo-matrix preflight sample.")
    .option("--input <path>", "local SWE-Atlas/QnA rows JSON/JSONL export; fetches public rows when omitted")
    .option("--out-dir <path>", "directory for generated suite/matrix files", "examples/bench/swe-atlas-qna-pilot")
    .option("--offset <n>", "public dataset row offset", parseNonNegativeInt, 0)
    .option("--limit <n>", "maximum selected tasks", parsePositiveInt, 30)
    .option("--fetch-length <n>", "number of public rows to fetch before filtering", parsePositiveInt, 50)
    .option("--languages <csv>", "optional comma-separated language filter, for example python,typescript,go")
    .option("--repos <csv>", "optional comma-separated repo filter, for example kovidgoyal/kitty")
    .option("--categories <csv>", "optional comma-separated category filter")
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
        categories?: string;
        json?: boolean;
      }) => {
        const rows = options.input
          ? loadSweAtlasQnaRows(options.input)
          : await fetchSweAtlasQnaRows({ offset: options.offset, length: options.fetchLength });
        const pilot = buildSweAtlasQnaPilot({
          rows,
          limit: options.limit,
          languages: csvList(options.languages),
          repos: csvList(options.repos),
          categories: csvList(options.categories)
        });
        const outputs = writeSweAtlasQnaPilot({ pilot, outDir: options.outDir });
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
        console.log(`Generated SWE-Atlas/QnA pilot with ${pilot.rows} tasks.`);
        console.log(`Suite: ${outputs.suitePath}`);
        console.log(`Matrix: ${outputs.matrixPath}`);
        console.log(`Summary: ${outputs.summaryPath}`);
        for (const warning of pilot.summary.warnings) {
          console.log(`Warning: ${warning}`);
        }
      }
    );

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
    .command("swe-pro-official")
    .description("Prepare or run SWE-Bench Pro official evaluator inputs for a selected row slice.")
    .requiredOption("--input <path>", "local SWE-Bench Pro rows JSON/JSONL export")
    .option("--out-dir <path>", "directory for official evaluator inputs and outputs", "docs/publication-evidence-20260518/swe-pro-official")
    .option("--official-repo <path>", "local scaleapi/SWE-bench_Pro-os checkout", ".kairn/eval/SWE-bench_Pro-os")
    .option("--row-ids <csv>", "comma-separated SWE-Pro instance ids to select")
    .option("--limit <n>", "maximum selected rows", parsePositiveInt, 1)
    .addOption(new Option("--patch-mode <mode>", "generated patch mode").choices(["empty", "gold"]).default("empty"))
    .option("--patch-path <path>", "existing patch JSON in official evaluator format")
    .option("--python <cmd>", "Python command for the official evaluator", "python3")
    .option("--dockerhub-username <name>", "Docker Hub username/repository namespace for SWE-Pro images", "jefzda")
    .option("--num-workers <n>", "official evaluator workers", parsePositiveInt, 1)
    .option("--use-local-docker", "run evaluator locally with Docker instead of Modal")
    .option("--docker-platform <platform>", "Docker platform override, for example linux/amd64")
    .option("--run", "actually run the official evaluator; otherwise prepare files and print command")
    .option("--redo", "pass --redo to the official evaluator")
    .option("--json", "print JSON output")
    .action((options: {
      input: string;
      outDir: string;
      officialRepo: string;
      rowIds?: string;
      limit: number;
      patchMode: "empty" | "gold";
      patchPath?: string;
      python: string;
      dockerhubUsername: string;
      numWorkers: number;
      useLocalDocker?: boolean;
      dockerPlatform?: string;
      run?: boolean;
      redo?: boolean;
      json?: boolean;
    }) => {
      const report = prepareSweProOfficialEvaluator({
        rowsPath: options.input,
        rowIds: csvList(options.rowIds),
        limit: options.limit,
        outputDir: options.outDir,
        officialRepoPath: options.officialRepo,
        patchPath: options.patchPath,
        patchMode: options.patchMode,
        pythonCommand: options.python,
        dockerhubUsername: options.dockerhubUsername,
        numWorkers: options.numWorkers,
        useLocalDocker: options.useLocalDocker ?? true,
        dockerPlatform: options.dockerPlatform,
        run: Boolean(options.run),
        redo: Boolean(options.redo)
      });
      if (options.json) {
        printJson(report);
        return;
      }
      console.log(`SWE-Pro official evaluator ${report.status}.`);
      console.log(`Rows: ${report.rowsSelected}`);
      console.log(`Raw sample: ${report.rawSamplePath}`);
      console.log(`Patch JSON: ${report.patchPath}`);
      console.log(`Evaluator output: ${report.evaluatorOutputDir}`);
      console.log(`Command: ${report.commands[0]}`);
      for (const warning of report.warnings) {
        console.log(`Warning: ${warning}`);
      }
      if (report.evaluator?.ran) {
        console.log(`Evaluator exit code: ${report.evaluator.exitCode ?? "unknown"}`);
        console.log(`Evaluator results: ${report.evaluator.evalResultsPath ?? "none"}`);
      }
    });

  benchCommand
    .command("mcp-smoke")
    .description("Start Kairn over MCP stdio and verify prepare-task tool-call delivery.")
    .option("--root <path>", "target repository root", process.cwd())
    .requiredOption("--task <task>", "task prompt to send through kairn_prepare_task")
    .option("--budget <tokens>", "prepare-task budget", parsePositiveInt, 700)
    .addOption(new Option("--detail <detail>", "prepare-task detail").choices(["compact", "full"]).default("compact"))
    .option("--json", "print JSON output")
    .action(async (options: { root: string; task: string; budget: number; detail: "compact" | "full"; json?: boolean }) => {
      const report = await runBenchmarkMcpSmoke({
        rootPath: options.root,
        task: options.task,
        budget: options.budget,
        detail: options.detail
      });
      if (options.json) {
        printJson(report);
        return;
      }
      console.log("Kairn MCP smoke passed.");
      console.log(`Root: ${report.rootPath}`);
      console.log(`Session: ${report.sessionId ?? "unknown"}`);
      console.log(`Tools listed: ${report.tools.length}`);
      console.log(`MCP tool calls recorded: ${report.metrics.mcpToolCalls}`);
      console.log(`Start files: ${report.prepare.startFiles.join(", ") || "none"}`);
      console.log(`Stop condition: ${report.prepare.stopCondition ?? "none"}`);
    });

  benchCommand
    .command("swe-context-pilot")
    .description("Generate a SWE-ContextBench pilot suite and repo-matrix preflight sample from local metadata.")
    .requiredOption("--input <path>", "local SWE-ContextBench metadata JSON/JSONL export")
    .option("--out-dir <path>", "directory for generated suite/matrix files", "examples/bench/swe-contextbench-pilot")
    .option("--limit <n>", "maximum selected tasks", parsePositiveInt, 30)
    .option("--languages <csv>", "optional comma-separated language filter")
    .option("--repos <csv>", "optional comma-separated repo filter")
    .option("--json", "print JSON output")
    .action((options: { input: string; outDir: string; limit: number; languages?: string; repos?: string; json?: boolean }) => {
      const rows = loadSweContextBenchRows(options.input);
      const pilot = buildSweContextBenchPilot({
        rows,
        limit: options.limit,
        languages: csvList(options.languages),
        repos: csvList(options.repos)
      });
      const outputs = writeSweContextBenchPilot({ pilot, outDir: options.outDir });
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
      console.log(`Generated SWE-ContextBench pilot with ${pilot.rows} tasks and ${pilot.pairs.length} related-task pair(s).`);
      console.log(`Suite: ${outputs.suitePath}`);
      console.log(`Matrix: ${outputs.matrixPath}`);
      console.log(`Summary: ${outputs.summaryPath}`);
      for (const warning of pilot.summary.warnings) {
        console.log(`Warning: ${warning}`);
      }
    });

  benchCommand
    .command("publication")
    .description("Run a publication-grade evidence campaign and write reproducible aggregate artifacts.")
    .requiredOption("--plan <path>", "publication plan JSON path")
    .requiredOption("--out-dir <path>", "directory for raw artifacts, CSVs, manifest, and Markdown report")
    .option("--model <model>", "live-agent model override")
    .option("--repeat <n>", "default repeat count for entries that do not override it", parsePositiveInt)
    .option("--resume", "skip completed valid raw artifacts")
    .option("--only <id-or-class>", "run only one entry id, kind, repo id, task class, or context behavior")
    .option("--dry-run", "write planned commands and report skeleton without running benchmarks")
    .option("--json", "print JSON output")
    .action(
      async (options: {
        plan: string;
        outDir: string;
        model?: string;
        repeat?: number;
        resume?: boolean;
        only?: string;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        const report = await runPublicationCampaign({
          planPath: options.plan,
          outDir: options.outDir,
          model: options.model,
          repeat: options.repeat,
          resume: Boolean(options.resume),
          only: options.only,
          dryRun: Boolean(options.dryRun),
          onProgress: options.json ? undefined : (message) => process.stderr.write(`${message}\n`)
        });
        if (options.json) {
          printJson(report);
          return;
        }
        console.log(`Publication campaign: ${report.name}`);
        console.log(`Entries: ${report.artifacts.length}${report.dryRun ? " planned" : ""}`);
        console.log(`Rows: ${report.aggregate.resultRows}`);
        console.log(`Quality pass rate: ${(report.aggregate.qualityPassRate * 100).toFixed(2)}%`);
        console.log(`Median valid active savings: ${(report.aggregate.medianValidSavingsRate * 100).toFixed(2)}%`);
        console.log(`Markdown: ${report.outputs.markdownPath}`);
        console.log(`Results CSV: ${report.outputs.resultsCsvPath}`);
        console.log(`Manifest: ${report.outputs.manifestPath}`);
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
    .option("--kairn-codex-session-no-governor-command <command>", "benchmark-only Kairn session ablation command with governor disabled")
    .option("--kairn-codex-session-no-governor-setup-command <command>", "benchmark-only no-governor setup command timed separately before endurance turns")
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
        kairnCommand?: string;
        mcpCommand?: string;
        hookFullPrimeCommand?: string;
        hookFullPrimeSetupCommand?: string;
        kairnCodexSessionCommand?: string;
        kairnCodexSessionSetupCommand?: string;
        kairnCodexSessionNoGovernorCommand?: string;
        kairnCodexSessionNoGovernorSetupCommand?: string;
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
          kairnCodexSessionNoGovernorCommand: options.kairnCodexSessionNoGovernorCommand,
          kairnCodexSessionNoGovernorSetupCommand: options.kairnCodexSessionNoGovernorSetupCommand,
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
    .option("--kairn-codex-session-command <command>", "session-bound kairn codex wrapper command with {prompt} and {root} placeholders")
    .option("--kairn-codex-session-setup-command <command>", "session-bound kairn codex setup command timed separately before the live-agent command")
    .option("--kairn-codex-session-no-governor-command <command>", "benchmark-only Kairn session command with suppression/evidence governor disabled")
    .option("--kairn-codex-session-no-governor-setup-command <command>", "benchmark-only no-governor setup command timed separately before the live-agent command")
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
    .option("--out <path>", "write proof JSON to this file after each completed mode and at the end")
    .option("--no-progress", "disable stderr progress messages for long live proof runs")
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
        kairnCodexSessionCommand?: string;
        kairnCodexSessionSetupCommand?: string;
        kairnCodexSessionNoGovernorCommand?: string;
        kairnCodexSessionNoGovernorSetupCommand?: string;
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
        out?: string;
        progress?: boolean;
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
            kairnCodexSessionCommand: options.kairnCodexSessionCommand,
            kairnCodexSessionSetupCommand: options.kairnCodexSessionSetupCommand,
            kairnCodexSessionNoGovernorCommand: options.kairnCodexSessionNoGovernorCommand,
            kairnCodexSessionNoGovernorSetupCommand: options.kairnCodexSessionNoGovernorSetupCommand,
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
            shuffleOrder: Boolean(options.shuffleOrder),
            proofOutputPath: options.out,
            onProgress: options.progress === false ? undefined : (message) => process.stderr.write(`${message}\n`)
          });
          if (options.out && options.progress !== false) {
            process.stderr.write(`[bench prove] wrote proof JSON to ${options.out}\n`);
          }
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
