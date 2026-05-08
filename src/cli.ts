#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import { KairnRuntime } from "./runtime/KairnRuntime.js";
import { startMcpServer } from "./server/mcp.js";
import type {
  BenchmarkComparison,
  BenchmarkProofReport,
  BenchmarkReport,
  BenchmarkRunMode,
  CodexSetupMode,
  ContextPrime,
  ContextQueryMode,
  EvalComparison,
  EvalRunMode,
  EvalRunReport,
  MetricsSummary,
  OutputKind,
  PrimeProfile,
  WatchEventSource,
  WatchSnapshot
} from "./types.js";
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
  .command("prime")
  .description("Generate proactive task context before an agent starts scanning.")
  .argument("<task>", "task description")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--session <id>", "reuse an existing Kairn task session")
  .addOption(new Option("--profile <profile>", "prime profile").choices(["auto", "ui", "workflow", "backend", "test", "generic"]).default("auto"))
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

const setup = program
  .command("setup")
  .description("Install local agent integration files for a target repo.");

setup
  .command("codex")
  .description("Install Codex hook config that lets Kairn prime prompts automatically.")
  .option("--root <path>", "target repository root", process.cwd())
  .addOption(new Option("--mode <mode>", "Codex hook setup mode").choices(["savings", "observe", "debug", "mcp-first"]).default("savings"))
  .addOption(new Option("--prime-profile <profile>", "prompt-submit prime profile").choices(["auto", "ui", "workflow", "backend", "test", "generic"]).default("auto"))
  .option("--prime-budget <tokens>", "prompt-submit prime token budget", parsePositiveInt, 1200)
  .option("--json", "print JSON output")
  .action((options: { root: string; mode: CodexSetupMode; primeProfile: PrimeProfile; primeBudget: number; json?: boolean }) => {
    const result = writeCodexSetup({
      root: options.root,
      mode: options.mode,
      primeProfile: options.primeProfile,
      primeBudget: options.primeBudget
    });
    if (options.json) {
      printJson(result);
      return;
    }

    process.stdout.write(
      [
        "Kairn Codex setup written.",
        `Root: ${result.rootPath}`,
        `Config: ${result.configPath}`,
        `Hooks: ${result.hooksPath}`,
        `Mode: ${result.mode}`,
        "Codex UserPromptSubmit hooks will request proactive Kairn context without KAIRN_SESSION.",
        result.mode === "mcp-first" ? "MCP-first mode also writes savings hooks; configure Codex MCP manually with `kairn serve --mcp --root <repo>`." : "",
        ""
      ].filter(Boolean).join("\n")
    );
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
  .command("failure")
  .description("Build failure-first context from test, lint, typecheck, or generic output.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .addOption(
    new Option("--type <type>", "output kind")
      .choices(["test", "lint", "typecheck", "generic"])
      .default("generic")
  )
  .option("--output <text>", "failure output text; stdin is used when omitted")
  .option("--output-file <path>", "read failure output from a local file")
  .option("--command <command>", "command that produced the failure")
  .option("--budget <tokens>", "approximate response token budget", parsePositiveInt)
  .option("--json", "print JSON output")
  .action(
    async (options: {
      session: string;
      root: string;
      type: OutputKind;
      output?: string;
      outputFile?: string;
      command?: string;
      budget?: number;
      json?: boolean;
    }) => {
      await withRuntime(options.root, async (runtime) => {
        const output =
          options.output ??
          (options.outputFile ? fs.readFileSync(path.resolve(options.outputFile), "utf8") : await readStdin());
        const context = await runtime.getFailureContext({
          sessionId: options.session,
          type: options.type,
          output,
          command: options.command,
          budget: options.budget,
          source: "cli"
        });
        if (options.json) {
          printJson(context);
          return;
        }
        process.stdout.write(`${context.content}\n`);
      });
    }
  );

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
  .option("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .addOption(new Option("--source <source>", "hook source").choices(["generic", "claude", "codex"]).default("generic"))
  .option("--event <name>", "override hook event name")
  .addOption(new Option("--prime-profile <profile>", "prompt-submit prime profile").choices(["auto", "ui", "workflow", "backend", "test", "generic"]).default("auto"))
  .option("--prime-budget <tokens>", "prompt-submit prime token budget", parsePositiveInt, 1200)
  .option("--json", "print JSON output")
  .action(
    async (options: {
      session?: string;
      root: string;
      source: WatchEventSource;
      event?: string;
      primeProfile: PrimeProfile;
      primeBudget: number;
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
          event,
          primeProfile: options.primeProfile,
          primeBudget: options.primeBudget
        });

        if (options.json) {
          printJson(result);
          return;
        }

        const output = hostHookOutput({
          source: options.source,
          eventName: event.eventName,
          content: result.prime?.content ?? result.failureContext?.content ?? result.recommendation?.content,
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

const evalCommand = program
  .command("eval")
  .description("Record and compare local proof metrics for Codex/Kairn eval runs.");

evalCommand
  .command("start")
  .description("Start an eval run for a manual baseline or Kairn-assisted session.")
  .option("--root <path>", "target repository root", process.cwd())
  .requiredOption("--task <task>", "task being evaluated")
  .requiredOption("--label <label>", "human-readable run label")
  .addOption(new Option("--mode <mode>", "eval run mode").choices(["baseline", "kairn", "manual"]).makeOptionMandatory())
  .option("--session <id>", "optional Kairn task session ID")
  .option("--json", "print JSON output")
  .action(async (options: { root: string; task: string; label: string; mode: EvalRunMode; session?: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const run = runtime.startEvalRun({
        task: options.task,
        label: options.label,
        mode: options.mode,
        sessionId: options.session
      });
      if (options.json) {
        printJson(run);
        return;
      }
      process.stdout.write(
        [
          "Kairn eval run started.",
          `Run: ${run.id}`,
          run.sessionId ? `Session: ${run.sessionId}` : undefined,
          `Mode: ${run.mode}`,
          `Label: ${run.label}`,
          ""
        ].filter(Boolean).join("\n")
      );
    });
  });

evalCommand
  .command("ingest-codex")
  .description("Ingest a Codex token-usage footer or transcript metadata into an eval run.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--run <id>", "eval run ID; defaults to latest run for the session")
  .option("--transcript <path>", "Codex transcript path to parse best-effort metadata from")
  .option("--usage <text>", "Codex token usage footer text; stdin is used when omitted")
  .option("--json", "print JSON output")
  .action(
    async (options: {
      session: string;
      root: string;
      run?: string;
      transcript?: string;
      usage?: string;
      json?: boolean;
    }) => {
      await withRuntime(options.root, async (runtime) => {
        const usageText = options.usage ?? (process.stdin.isTTY ? undefined : await readStdin());
        const observation = runtime.ingestCodexUsage({
          sessionId: options.session,
          runId: options.run,
          usageText,
          transcriptPath: options.transcript
        });
        if (options.json) {
          printJson(observation);
          return;
        }
        process.stdout.write(
          [
            "Codex usage ingested.",
            `Run: ${observation.runId}`,
            `Session: ${observation.sessionId ?? options.session}`,
            observation.summary,
            ""
          ].join("\n")
        );
      });
    }
  );

evalCommand
  .command("note")
  .description("Attach a manual outcome note to an eval run.")
  .requiredOption("--run <id>", "eval run ID")
  .option("--root <path>", "target repository root", process.cwd())
  .addOption(new Option("--outcome <outcome>", "manual outcome").choices(["pass", "fail", "partial"]).makeOptionMandatory())
  .requiredOption("--summary <text>", "short outcome summary")
  .option("--files <csv>", "comma-separated files involved in the outcome")
  .option("--json", "print JSON output")
  .action(
    async (options: {
      run: string;
      root: string;
      outcome: "pass" | "fail" | "partial";
      summary: string;
      files?: string;
      json?: boolean;
    }) => {
      await withRuntime(options.root, async (runtime) => {
        const observation = runtime.addEvalNote({
          runId: options.run,
          outcome: options.outcome,
          summary: options.summary,
          files: parseCsv(options.files)
        });
        if (options.json) {
          printJson(observation);
          return;
        }
        process.stdout.write(["Eval note recorded.", `Run: ${observation.runId}`, observation.summary, ""].join("\n"));
      });
    }
  );

evalCommand
  .command("report")
  .description("Report eval evidence for a run or target repo.")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--session <id>", "filter runs by Kairn task session ID")
  .option("--run <id>", "eval run ID")
  .option("--json", "print JSON output")
  .action(async (options: { root: string; session?: string; run?: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const report = runtime.getEvalReport({
        runId: options.run,
        sessionId: options.session
      });
      if (options.json) {
        printJson(report);
        return;
      }
      printEvalReport(report);
    });
  });

evalCommand
  .command("compare")
  .description("Compare a baseline eval run against a Kairn-assisted eval run.")
  .requiredOption("--baseline <id>", "baseline eval run ID")
  .requiredOption("--kairn <id>", "Kairn-assisted eval run ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--json", "print JSON output")
  .action(async (options: { baseline: string; kairn: string; root: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const comparison = runtime.compareEvalRuns({
        baselineRunId: options.baseline,
        kairnRunId: options.kairn
      });
      if (options.json) {
        printJson(comparison);
        return;
      }
      printEvalComparison(comparison);
    });
  });

evalCommand
  .command("feedback")
  .description("Compare Kairn-recommended files against ingested Codex transcript file usage.")
  .requiredOption("--session <id>", "Kairn task session ID")
  .option("--root <path>", "target repository root", process.cwd())
  .option("--json", "print JSON output")
  .action(async (options: { session: string; root: string; json?: boolean }) => {
    await withRuntime(options.root, async (runtime) => {
      const observation = runtime.getEvalFeedback({ sessionId: options.session });
      if (options.json) {
        printJson(observation);
        return;
      }
      process.stdout.write(["Kairn eval feedback recorded.", `Session: ${options.session}`, observation.summary, ""].join("\n"));
    });
  });

const benchCommand = program
  .command("bench")
  .description("Run deterministic and optional live-agent benchmarks for Kairn retrieval quality.");

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
  .option("--prompt-only-command <command>", "prompt-submit-only live-agent command with {prompt} and {root} placeholders")
  .option("--prompt-plus-hooks-command <command>", "prompt and post-tool hook live-agent command with {prompt} and {root} placeholders")
  .option("--manual-prime-command <command>", "manual-prime live-agent command with {prompt} and {root} placeholders")
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
      promptOnlyCommand?: string;
      promptPlusHooksCommand?: string;
      manualPrimeCommand?: string;
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
          promptOnlyCommand: options.promptOnlyCommand,
          promptPlusHooksCommand: options.promptPlusHooksCommand,
          manualPrimeCommand: options.manualPrimeCommand,
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

function writeCodexSetup(input: { root: string; mode: CodexSetupMode; primeProfile: PrimeProfile; primeBudget: number }) {
  const rootPath = path.resolve(input.root);
  const codexDir = path.join(rootPath, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configPath, "[features]\ncodex_hooks = true\n");
  fs.writeFileSync(
    hooksPath,
    `${JSON.stringify(buildCodexHooksConfig(input), null, 2)}\n`
  );

  return {
    rootPath,
    configPath,
    hooksPath,
    mode: input.mode,
    primeProfile: input.primeProfile,
    primeBudget: input.primeBudget
  };
}

function buildCodexHooksConfig(input: { mode: CodexSetupMode; primeProfile: PrimeProfile; primeBudget: number }) {
  const command = `eval "\${KAIRN_CMD:-kairn} hook --source codex --root \\"$PWD\\" --prime-profile ${input.primeProfile} --prime-budget ${input.primeBudget}"`;
  const hooks: Record<string, unknown> = {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command,
            statusMessage: "Priming Kairn context"
          }
        ]
      }
    ]
  };

  if (input.mode === "observe" || input.mode === "debug") {
    hooks.PostToolUse = [
      {
        matcher: input.mode === "debug" ? ".*" : "Bash|apply_patch|mcp__.*",
        hooks: [
          {
            type: "command",
            command,
            statusMessage: input.mode === "debug" ? "Sending debug hook output to Kairn" : "Sending useful tool output to Kairn"
          }
        ]
      }
    ];
  }

  if (input.mode === "debug") {
    hooks.Stop = [
        {
          hooks: [
            {
              type: "command",
              command,
              statusMessage: "Recording Codex stop event in Kairn"
            }
          ]
        }
      ];
  }

  return {
    hooks
  };
}

function printContextPrime(prime: ContextPrime): void {
  process.stdout.write(`${prime.content}\n`);
  if (prime.warnings.length > 0) {
    process.stdout.write(`\n## Warnings\n${prime.warnings.map((warning) => `- ${warning}`).join("\n")}\n`);
  }
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
    "",
    "Observed Codex usage",
    metrics.observed.latestCodexUsage
      ? `- latest: ${metrics.observed.latestCodexUsage.totalTokens} total (${metrics.observed.latestCodexUsage.inputTokens} input, ${metrics.observed.latestCodexUsage.outputTokens} output)`
      : "- latest: none ingested",
    `- eval runs: ${metrics.observed.evalRuns}`,
    `- eval observations: ${metrics.observed.observations}`,
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function printEvalReport(report: EvalRunReport | { runs: EvalRunReport[] }): void {
  const reports = "runs" in report ? report.runs : [report];
  const lines = ["Kairn eval report."];

  for (const item of reports) {
    lines.push(
      "",
      `Run: ${item.run.id}`,
      `Mode: ${item.run.mode}`,
      `Label: ${item.run.label}`,
      `Task: ${item.run.task}`,
      `Status: ${item.run.status}`,
      item.run.sessionId ? `Session: ${item.run.sessionId}` : "Session: none",
      item.codexUsage
        ? `Observed Codex tokens: ${item.codexUsage.totalTokens} total (${item.codexUsage.inputTokens} input, ${item.codexUsage.outputTokens} output)`
        : "Observed Codex tokens: none",
      `Estimated Kairn saved tokens: ${item.estimatedMetrics?.totals.savedTokens ?? 0}`,
      `Hooks: ${item.watch.hooks}; failures: ${item.watch.failures}; file changes: ${item.watch.fileChanges}`,
      `Observations: ${item.observations.length}`
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function printEvalComparison(comparison: EvalComparison): void {
  const lines = [
    "Kairn eval comparison.",
    `Baseline: ${comparison.baseline.run.id} (${comparison.baseline.run.label})`,
    `Kairn: ${comparison.kairn.run.id} (${comparison.kairn.run.label})`,
    "",
    "Observed Codex usage",
    comparison.observedTokenDelta
      ? `- saved: ${comparison.observedTokenDelta.savedTokens} tokens (${Math.round(comparison.observedTokenDelta.savingsRate * 100)}%)`
      : "- saved: unavailable; ingest Codex usage for both runs",
    comparison.observedTokenDelta
      ? `- baseline: ${comparison.observedTokenDelta.baselineTokens}; kairn: ${comparison.observedTokenDelta.kairnTokens}`
      : "",
    "",
    "Estimated Kairn metrics",
    `- saved: ${comparison.estimatedKairnSavings.savedTokens} tokens (${Math.round(comparison.estimatedKairnSavings.savingsRate * 100)}%)`,
    `- events: ${comparison.estimatedKairnSavings.events}`,
    "",
    "Signals",
    `- kairn hooks: ${comparison.kairn.watch.hooks}`,
    `- kairn failures: ${comparison.kairn.watch.failures}`,
    `- kairn file changes: ${comparison.kairn.watch.fileChanges}`,
    `- outcome notes: ${comparison.outcomeNotes.length}`,
    ""
  ].filter(Boolean);

  process.stdout.write(`${lines.join("\n")}\n`);
}

function printBenchmarkReport(report: BenchmarkReport | { runs: BenchmarkReport[] }): void {
  const reports = "runs" in report ? report.runs : [report];
  const lines = ["Kairn benchmark report."];

  for (const item of reports) {
    lines.push(
      "",
      `Run: ${item.run.id}`,
      `Suite: ${item.run.suiteName}`,
      `Mode: ${item.run.mode}`,
      `Status: ${item.run.status}`,
      `Overall score: ${item.overallScore}`,
      `Cases: ${item.results.length}`,
      item.observed
        ? `Observed Codex tokens: ${item.observed.codexTokens} across ${item.observed.codexCaseCount} case(s)`
        : "Observed Codex tokens: none",
      item.weakestCases.length > 0 ? `Weakest: ${item.weakestCases.map((result) => `${result.caseId} (${result.score})`).join(", ")}` : "Weakest: none",
      item.recommendations.length > 0 ? ["Recommendations", ...item.recommendations.map((entry) => `- ${entry}`)].join("\n") : "Recommendations: none"
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

function printBenchmarkComparison(comparison: BenchmarkComparison): void {
  const lines = [
    "Kairn benchmark comparison.",
    `Before: ${comparison.before.run.id} (${comparison.before.overallScore})`,
    `After: ${comparison.after.run.id} (${comparison.after.overallScore})`,
    `Score delta: ${comparison.scoreDelta}`,
    "",
    "Observed Codex usage",
    comparison.observedTokenDelta
      ? `- saved: ${comparison.observedTokenDelta.savedTokens} tokens (${Math.round(comparison.observedTokenDelta.savingsRate * 100)}%)`
      : "- saved: unavailable; run agent commands that print Codex token footers",
    comparison.observedTokenDelta
      ? `- before: ${comparison.observedTokenDelta.beforeTokens}; after: ${comparison.observedTokenDelta.afterTokens}`
      : "",
    "",
    comparison.improvedCases.length > 0 ? `Improved: ${comparison.improvedCases.join(", ")}` : "Improved: none",
    comparison.regressedCases.length > 0 ? `Regressed: ${comparison.regressedCases.join(", ")}` : "Regressed: none",
    "",
    "Recommendations",
    ...(comparison.recommendations.length > 0 ? comparison.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function printBenchmarkProof(report: BenchmarkProofReport): void {
  const lines = [
    "Kairn benchmark proof.",
    "",
    "Observed Codex usage",
    formatProofDelta("Prompt-only hooks vs baseline", report.observedTokenDeltas.promptOnlyVsBaseline),
    formatProofDelta("Prompt+tool hooks vs baseline", report.observedTokenDeltas.promptPlusHooksVsBaseline),
    formatProofDelta("Manual prime vs baseline", report.observedTokenDeltas.manualPrimeVsBaseline),
    report.aggregate ? `- Repeat count: ${report.aggregate.repeat}` : "",
    report.aggregate?.deltas.promptOnlyVsBaseline?.savingsRate !== undefined
      ? `- Prompt-only median savings: ${Math.round(report.aggregate.deltas.promptOnlyVsBaseline.savingsRate * 100)}%`
      : "",
    "",
    "Cases",
    ...report.caseDeltas.map((item) => {
      const proactiveVsBaseline = item.proactiveVsBaseline !== undefined ? item.proactiveVsBaseline : "n/a";
      const proactiveVsPassive = item.proactiveVsPassive !== undefined ? item.proactiveVsPassive : "n/a";
      return `- ${item.caseId}: baseline ${item.baselineTokens ?? "n/a"}, passive ${item.passiveHooksTokens ?? "n/a"}, proactive ${item.proactiveTokens ?? "n/a"}; proactive-baseline delta ${proactiveVsBaseline}; proactive-passive delta ${proactiveVsPassive}`;
    }),
    "",
    "Recommendations",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function formatProofDelta(label: string, delta: BenchmarkComparison["observedTokenDelta"]): string {
  if (!delta) return `- ${label}: unavailable`;
  return `- ${label}: ${delta.savedTokens} tokens (${Math.round(delta.savingsRate * 100)}%)`;
}

function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  return [
    `# Kairn Benchmark Run ${report.run.id}`,
    "",
    `- Suite: ${report.run.suiteName}`,
    `- Mode: ${report.run.mode}`,
    `- Status: ${report.run.status}`,
    `- Overall score: ${report.overallScore}`,
    report.observed ? `- Observed Codex tokens: ${report.observed.codexTokens} across ${report.observed.codexCaseCount} case(s)` : "- Observed Codex tokens: none",
    "",
    "## Cases",
    ...report.results.map(
      (result) =>
        `- ${result.caseId}: ${result.score} ` +
        `(recall ${Math.round(result.expectedFileRecall * 100)}%, top-k ${Math.round(result.topKHitRate * 100)}%, unexpected ${Math.round(result.unexpectedFileRate * 100)}%, outcome ${result.taskOutcome})`
    ),
    "",
    "## Weakest Cases",
    ...(report.weakestCases.length > 0 ? report.weakestCases.map((result) => `- ${result.caseId}: ${result.score}`) : ["- none"]),
    "",
    "## Recommendations",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  ].join("\n");
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
