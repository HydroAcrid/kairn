// SPDX-License-Identifier: Apache-2.0

import { Command, Option } from "commander";
import type { EvalRunMode } from "../../types.js";
import { printEvalComparison, printEvalReport } from "../formatters.js";
import { parseCsv, withRuntime } from "../helpers.js";
import { printJson, readStdin } from "../output.js";

export function registerEvalCommands(program: Command): void {
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
}
