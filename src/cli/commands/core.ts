import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command, Option } from "commander";
import { startKairnDaemon } from "../../daemon/server.js";
import { formatImpactReportMarkdown, formatImpactStats } from "../../metrics/impact.js";
import { startMcpServer } from "../../server/mcp.js";
import { queueAndFlushTelemetrySnapshot } from "../../telemetry/autoFlush.js";
import type { CodexSetupMode, ContextPrime, HookOutputProfile, IndexStateStats, PrimeProfile } from "../../types.js";
import { commandInvocation, commandSpawnInvocation } from "../../utils/command.js";
import {
  buildCodexNoDiffRecoveryPrompt,
  buildCodexPartialScopeRecoveryPrompt,
  missingRequiredScopeFiles,
  relevantWorkspaceDiffFiles,
  shouldRetryCodexNoDiff,
  shouldRetryCodexPartialScope
} from "../codexRecovery.js";
import { printContextPrime } from "../formatters.js";
import { codexExecArgs, codexInteractiveArgs, parsePositiveInt, waitForShutdown, withKairnInternalStateHidden, withRuntime } from "../helpers.js";
import { printContextResponse, printJson } from "../output.js";
import { writeCodexSetup } from "../setup/codexSetup.js";
import { formatSetupWizardResult, runSetupWizard, type SetupWizardChoice, type SetupWizardIndexMode } from "../setup/wizard.js";

export function formatCodexEditScopeReminder(prime: ContextPrime | undefined): string | undefined {
  if (!prime?.editScope || prime.editScope.strictBoundary !== true || prime.editScope.initialEditFiles.length === 0) return undefined;
  if (typeof prime.metadata?.guardrailVariant === "string") return undefined;
  const files = prime.editScope.initialEditFiles.join(", ");
  const taskShape = prime.contextDecision?.taskShapeSignal;
  if (taskShape === "topic_ordering" || taskShape === "collection_name_validation") {
    return [
      "Kairn focused source candidates for this turn:",
      `- Start with: ${files}`,
      "- Patch the smallest necessary production surface first; touch companions only when the behavior contract requires it.",
      "- Keep tests, docs, generated files, and unrelated sibling source out of scope."
    ].join("\n");
  }
  return [
    "Kairn edit scope is authoritative for this turn:",
    `- Edit only: ${files}`,
    "- If the task appears to require another source file, keep it read-only and report the missing evidence instead of editing it."
  ].join("\n");
}

export function registerCoreCommands(program: Command): void {
  program
    .command("init")
    .description("Set up Kairn in a target repo.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--choice <choice>", "non-interactive setup choice").choices(["codex", "mcp", "both", "hybrid", "doctor"]))
    .option("--targets <targets>", "comma-separated setup targets: codex,claude-code,copilot-cli,gemini-cli,vscode,generic")
    .option("--yes", "accept defaults for non-interactive setup")
    .option("--no-index", "skip indexing during setup")
    .addOption(new Option("--index-mode <mode>", "indexing mode during setup").choices(["safe", "full", "skip"]))
    .option("--state-only", "only initialize Kairn local state and index, without installing agent integrations")
    .option("--telemetry", "enable opt-in sanitized telemetry upload")
    .option("--telemetry-endpoint <url>", "telemetry ingest endpoint override")
    .option("--json", "print JSON output")
    .action(async (options: {
      root: string;
      choice?: SetupWizardChoice;
      targets?: string;
      yes?: boolean;
      index?: boolean;
      indexMode?: SetupWizardIndexMode;
      stateOnly?: boolean;
      telemetry?: boolean;
      telemetryEndpoint?: string;
      json?: boolean;
    }, command: Command) => {
      if (!options.stateOnly) {
        const indexSource = command.getOptionValueSource("index");
        const indexModeSource = command.getOptionValueSource("indexMode");
        const indexMode = indexModeSource ? options.indexMode : undefined;
        const result = await runSetupWizard({
          root: options.root,
          choice: options.choice,
          targets: options.targets,
          yes: options.yes,
          index: indexMode === "skip" ? false : indexSource === "default" ? undefined : options.index,
          indexMode,
          telemetry: options.telemetry,
          telemetryEndpoint: options.telemetryEndpoint
        });
        if (options.json) {
          printJson(result);
          return;
        }
        process.stdout.write(formatSetupWizardResult(result));
        return;
      }

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

  program
    .command("ledger")
    .description("Show Kairn's durable session context ledger.")
    .requiredOption("--session <id>", "Kairn task session id")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action(async (options: { session: string; root: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const events = runtime.getSessionLedger(options.session);
        const summary = runtime.summarizeSessionLedger(options.session);
        if (options.json) {
          printJson({ summary, events });
          return;
        }
        process.stdout.write(
          [
            "Kairn session ledger.",
            `Session: ${summary.sessionId}`,
            `Events: ${summary.events}`,
            `Current phase: ${summary.currentPhase}`,
            `Recommended files used: ${summary.recommendedFilesUsed.length}`,
            `Repeated files avoided: ${summary.repeatedFilesAvoided}`,
            `Repeated snippets avoided: ${summary.repeatedSnippetsAvoided}`,
            `Unresolved failures: ${summary.unresolvedFailures}`,
            "",
            "Working set",
            `- active files: ${summary.workingSet.activeFiles.slice(0, 8).join(", ") || "none"}`,
            `- recently touched: ${summary.workingSet.recentlyTouchedFiles.slice(0, 8).join(", ") || "none"}`,
            `- ignored recommendations: ${summary.workingSet.ignoredRecommendedFiles.slice(0, 8).join(", ") || "none"}`,
            `- stale files: ${summary.workingSet.staleFiles.slice(0, 8).join(", ") || "none"}`,
            `- next read: ${summary.workingSet.nextSmallestUsefulRead ? `${summary.workingSet.nextSmallestUsefulRead.filePath} (${summary.workingSet.nextSmallestUsefulRead.reason})` : "none"}`,
            `- invariant: ${summary.workingSet.currentInvariant?.statement ?? "none"}`,
            `- open risks: ${summary.workingSet.openRisks.join("; ") || "none"}`,
            "",
            "Recent events",
            ...(summary.recentEvents.length > 0
              ? summary.recentEvents.map((event) => `- ${event.kind}${event.filePath ? ` ${event.filePath}` : ""}: ${event.summary}`)
              : ["- none"]),
            ""
          ].join("\n")
        );
      });
    });

  const stats = program
    .command("stats")
    .description("Show local cumulative Kairn impact stats.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--session <id>", "limit stats to one Kairn task session")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; session?: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const impact = runtime.getImpactStats(options.session);
        if (options.json) {
          printJson(impact);
          return;
        }
        process.stdout.write(`${formatImpactStats(impact)}\n`);
      });
    });

  stats
    .command("report")
    .description("Write a local aggregate Kairn impact report.")
    .requiredOption("--out <path>", "output report path")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--session <id>", "limit stats to one Kairn task session")
    .option("--json", "print JSON output")
    .action(async (options: { out: string; root: string; session?: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const impact = runtime.getImpactStats(options.session);
        const outPath = path.resolve(options.out);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${formatImpactReportMarkdown(impact)}\n`);
        if (options.json || stats.opts<{ json?: boolean }>().json) {
          printJson({ outPath, impact });
          return;
        }
        process.stdout.write(`Wrote Kairn impact report: ${outPath}\n`);
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
    .command("refresh")
    .description("Force-refresh Kairn's index for the target repo.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--safe", "refresh without WASM AST parsing; useful for Windows setup troubleshooting")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; safe?: boolean; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const restoreParserEnv = options.safe ? disableWasmParserForCommand() : () => {};
        let status: IndexStateStats;
        try {
          status = await runtime.refreshIndexNow();
        } finally {
          restoreParserEnv();
        }
        if (options.json) {
          printJson(status);
          return;
        }
        process.stdout.write([options.safe ? "Kairn index refreshed in safe mode." : "Kairn index refreshed.", formatIndexStatus(status)].join("\n"));
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
    .description("Launch Codex through a Kairn session-bound wrapper.")
    .argument("[task...]", "optional task to pass to Codex exec; omit to launch interactive Codex")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--session <id>", "reuse an existing Kairn task session")
    .addOption(new Option("--profile <profile>", "prime profile").choices(["auto", "ui", "workflow", "backend", "test", "failure_debug", "generic"]).default("auto"))
    .option("--budget <tokens>", "prime response token budget", parsePositiveInt)
    .option("--codex-command <command>", "Codex command to execute", process.env.KAIRN_CODEX_CMD ?? "codex")
    .option("--model <model>", "Codex model")
    .addOption(new Option("--sandbox <mode>", "Codex sandbox mode").choices(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"))
    .addOption(new Option("--approval <policy>", "Codex approval policy").choices(["untrusted", "on-failure", "on-request", "never"]))
    .option("--skip-git-repo-check", "pass Codex --skip-git-repo-check for disposable or non-git workspaces")
    .option("--bind-hooks", "install Codex hooks bound to this Kairn session before launching")
    .addOption(new Option("--hook-mode <mode>", "Codex setup mode to use with --bind-hooks").choices(["savings", "hybrid"]).default("savings"))
    .addOption(new Option("--hook-output <profile>", "prompt-submit hook output profile for --bind-hooks").choices(["full-prime", "tiny-directive", "failure-only", "mcp-brief"]).default("full-prime"))
    .option("--dry-run", "print the prepared prompt/command without launching Codex")
    .option("--json", "print JSON output")
    .action(async (taskParts: string[], options: {
      root: string;
      session?: string;
      profile: PrimeProfile;
      budget?: number;
      codexCommand: string;
      model?: string;
      sandbox: string;
      approval?: string;
      skipGitRepoCheck?: boolean;
      bindHooks?: boolean;
      hookMode: "savings" | "hybrid";
      hookOutput: HookOutputProfile;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const task = taskParts.join(" ").trim();
      await withRuntime(options.root, async (runtime) => {
        const interactive = task.length === 0;
        const prime = interactive
          ? undefined
          : await runtime.primeContext({
              task,
              sessionId: options.session,
              profile: options.profile,
              budget: options.budget,
              source: "codex"
            });
        const session = interactive
          ? options.session
            ? runtime.getSession(options.session)
            : (await runtime.startTask("Interactive Codex session")).session
          : prime!.session;
        const sessionId = session.id;
        const hookMode = options.hookMode as CodexSetupMode;
        const bindHooks = interactive || Boolean(options.bindHooks);
        const shouldInstallSessionHooks = Boolean(bindHooks && !options.dryRun && !options.json);
        const hookBackup = shouldInstallSessionHooks ? snapshotCodexConversationFiles(options.root) : undefined;
        const hookSetup = shouldInstallSessionHooks
          ? writeCodexSetup({
              root: options.root,
              mode: hookMode,
              primeProfile: options.profile,
              hookOutput: hookMode === "hybrid" ? "mcp-brief" : options.hookOutput,
              postToolHookOutput: "failure-only",
              primeBudget: options.budget ?? 900,
              sessionId
            })
          : undefined;
        const shouldInjectPrime = Boolean(prime && shouldInjectPrimeIntoCodexPrompt(prime.contextDecision?.action));
        const strictBoundaryReminder = formatCodexEditScopeReminder(prime);
        const approval = options.approval ?? (interactive ? undefined : "never");
        const prompt = interactive
          ? undefined
          : shouldInjectPrime
            ? [
                prime!.content,
                "",
                bindHooks ? `Kairn conversation session: ${sessionId}` : "",
                bindHooks ? "Session-bound hooks are installed for follow-up turns in this conversation." : "",
                bindHooks ? "" : "",
                "User task:",
                task,
                "",
                strictBoundaryReminder ?? "Use the Kairn context above first. Avoid broad scans unless the provided files are insufficient."
              ].join("\n")
            : task;
        const result = {
          rootPath: path.resolve(options.root),
          sessionId,
          codexCommand: options.codexCommand,
          mode: interactive ? "interactive" : "exec",
          args: interactive
            ? codexInteractiveArgs({
                root: options.root,
                model: options.model,
                sandbox: options.sandbox,
                approval,
                enableHooks: bindHooks,
                skipGitRepoCheck: Boolean(options.skipGitRepoCheck)
              })
            : codexExecArgs({
                root: options.root,
                prompt: prompt!,
                model: options.model,
                sandbox: options.sandbox,
                approval,
                enableHooks: bindHooks,
                skipGitRepoCheck: Boolean(options.skipGitRepoCheck)
              }),
          ...(prompt ? { prompt } : {}),
          ...(prime ? { prime } : {}),
          ...(bindHooks
            ? {
                hookBinding: hookSetup ?? {
                  dryRun: true,
                  mode: hookMode,
                  sessionId,
                  hookOutput: hookMode === "hybrid" ? "mcp-brief" : options.hookOutput,
                  primeBudget: options.budget ?? 900
                }
              }
            : {})
        };

        try {
          if (options.dryRun || options.json) {
            printJson(result);
            return;
          }

          if (interactive) {
            process.stdout.write(
              [
                `Kairn Codex session: ${sessionId}`,
                "Session-bound Codex hooks are active for this interactive conversation.",
                "Type normally in Codex. Kairn will stay quiet unless it has useful context.",
                ""
              ].join("\n")
            );
          }
          const invocation = commandSpawnInvocation(commandInvocation(options.codexCommand, result.args));
          const hideInternalState = !interactive && !shouldInjectPrime && !bindHooks;
          const completed = withKairnInternalStateHidden(result.rootPath, hideInternalState, () =>
            spawnSync(invocation.command, invocation.args, {
              cwd: result.rootPath,
              env: invocation.env ? { ...process.env, ...invocation.env } : undefined,
              stdio: "inherit"
            })
          );
          let exitCode = completed.status ?? (completed.error ? 1 : 0);
          if (!interactive && task.length > 0) {
            let changedFiles = relevantWorkspaceDiffFiles(result.rootPath);
            if (
              shouldRetryCodexNoDiff({
                task,
                interactive,
                exitCode,
                prime,
                changedFiles
              })
            ) {
              process.stderr.write("Kairn no-diff recovery: retrying once with a stricter production-edit prompt.\n");
              const recoveryPrompt = buildCodexNoDiffRecoveryPrompt({ task, prime });
              const recoveryInvocation = commandSpawnInvocation(
                commandInvocation(
                  options.codexCommand,
                  codexExecArgs({
                    root: options.root,
                    prompt: recoveryPrompt,
                    model: options.model,
                    sandbox: options.sandbox,
                    approval,
                    enableHooks: bindHooks,
                    skipGitRepoCheck: Boolean(options.skipGitRepoCheck)
                  })
                )
              );
              const recovered = spawnSync(recoveryInvocation.command, recoveryInvocation.args, {
                cwd: result.rootPath,
                env: recoveryInvocation.env ? { ...process.env, ...recoveryInvocation.env } : undefined,
                stdio: "inherit"
              });
              exitCode = recovered.status ?? (recovered.error ? 1 : 0);
              changedFiles = relevantWorkspaceDiffFiles(result.rootPath);
            }
            if (
              shouldRetryCodexPartialScope({
                task,
                interactive,
                exitCode,
                prime,
                changedFiles
              })
            ) {
              const missingFiles = missingRequiredScopeFiles({
                task,
                interactive,
                exitCode,
                prime,
                changedFiles
              });
              process.stderr.write(`Kairn partial-scope recovery: retrying once for missing required file(s): ${missingFiles.join(", ")}.\n`);
              const recoveryPrompt = buildCodexPartialScopeRecoveryPrompt({
                task,
                prime,
                changedFiles,
                missingFiles
              });
              const recoveryInvocation = commandSpawnInvocation(
                commandInvocation(
                  options.codexCommand,
                  codexExecArgs({
                    root: options.root,
                    prompt: recoveryPrompt,
                    model: options.model,
                    sandbox: options.sandbox,
                    approval,
                    enableHooks: bindHooks,
                    skipGitRepoCheck: Boolean(options.skipGitRepoCheck)
                  })
                )
              );
              const recovered = spawnSync(recoveryInvocation.command, recoveryInvocation.args, {
                cwd: result.rootPath,
                env: recoveryInvocation.env ? { ...process.env, ...recoveryInvocation.env } : undefined,
                stdio: "inherit"
              });
              exitCode = recovered.status ?? (recovered.error ? 1 : 0);
            }
          }
          process.exitCode = exitCode;
        } finally {
          if (hookBackup) restoreCodexConversationFiles(hookBackup);
          if (!options.dryRun && !options.json) {
            try {
              const telemetry = await queueAndFlushTelemetrySnapshot({
                rootPath: options.root,
                runtime,
                sessionId
              });
              if (telemetry?.sent) {
                process.stdout.write(`Kairn telemetry uploaded: ${telemetry.sent} snapshot(s).\n`);
              } else if (telemetry?.failures.length) {
                process.stderr.write(`Kairn telemetry upload retained for retry: ${telemetry.failures.join("; ")}\n`);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              process.stderr.write(`Kairn telemetry upload skipped: ${message}\n`);
            }
          }
        }
      });
    });
}

function disableWasmParserForCommand(): () => void {
  const previous = process.env.KAIRN_DISABLE_WASM_PARSER;
  process.env.KAIRN_DISABLE_WASM_PARSER = "1";
  return () => {
    if (previous === undefined) {
      delete process.env.KAIRN_DISABLE_WASM_PARSER;
      return;
    }
    process.env.KAIRN_DISABLE_WASM_PARSER = previous;
  };
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
    status.freshness
      ? `Freshness: ${status.freshness.stale ? `stale (${status.freshness.reason})` : "fresh"}${status.freshness.indexedAt ? `, indexed ${status.freshness.indexedAt}` : ""}`
      : "",
    ""
  ].filter(Boolean).join("\n");
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function snapshotCodexConversationFiles(root: string): {
  codexDir: string;
  files: Array<{ path: string; existed: boolean; content?: string | undefined }>;
} {
  const rootPath = path.resolve(root);
  const codexDir = path.join(rootPath, ".codex");
  const files = [
    path.join(codexDir, "config.toml"),
    path.join(codexDir, "hooks.json"),
    path.join(rootPath, "AGENTS.md")
  ].map((filePath) => ({
    path: filePath,
    existed: fs.existsSync(filePath),
    ...(fs.existsSync(filePath) ? { content: fs.readFileSync(filePath, "utf8") } : {})
  }));
  return { codexDir, files };
}

function shouldInjectPrimeIntoCodexPrompt(action: string | undefined): boolean {
  return action === "emit" || action === "shrink" || action === "request_evidence";
}

function restoreCodexConversationFiles(snapshot: {
  codexDir: string;
  files: Array<{ path: string; existed: boolean; content?: string | undefined }>;
}): void {
  for (const file of snapshot.files) {
    if (file.existed) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content ?? "");
      continue;
    }
    if (fs.existsSync(file.path)) fs.rmSync(file.path, { force: true });
  }
  try {
    if (fs.existsSync(snapshot.codexDir) && fs.readdirSync(snapshot.codexDir).length === 0) {
      fs.rmdirSync(snapshot.codexDir);
    }
  } catch {
    // Best-effort cleanup only; preserving user files is more important than removing an empty directory.
  }
}
