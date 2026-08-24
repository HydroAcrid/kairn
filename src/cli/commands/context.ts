// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import type { ContextQueryMode, OutputKind } from "../../types.js";
import { parsePositiveInt, withRuntime } from "../helpers.js";
import { printContextResponse, printJson, readStdin } from "../output.js";

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

export function registerContextCommands(program: Command): void {
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
}
