import { Command, Option } from "commander";
import { handleHookWithDaemon } from "../../daemon/server.js";
import type { HookOutputProfile, PrimeProfile, WatchEventSource } from "../../types.js";
import { hostHookOutput, normalizeHookPayload } from "../../watch/normalizeHook.js";
import { runRepoWatcher } from "../../watch/watchRepo.js";
import { printMetrics, printWatchSnapshot } from "../formatters.js";
import { parsePositiveInt, withRuntime } from "../helpers.js";
import { printJson, readStdin } from "../output.js";

export function registerWatchCommands(program: Command): void {
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
    .addOption(new Option("--hook-output <profile>", "hook output profile").choices(["full-prime", "tiny-directive", "failure-only", "mcp-brief"]).default("full-prime"))
    .option("--prime-budget <tokens>", "prompt-submit prime token budget", parsePositiveInt, 1200)
    .option("--json", "print JSON output")
    .action(
      async (options: {
        session?: string;
        root: string;
        source: WatchEventSource;
        event?: string;
        primeProfile: PrimeProfile;
        hookOutput: HookOutputProfile;
        primeBudget: number;
        json?: boolean;
      }) => {
        const raw = await readStdin();
        const payload = raw.trim() ? JSON.parse(raw) as unknown : {};
        const event = normalizeHookPayload({
          source: options.source,
          payload,
          eventName: options.event
        });
        const daemonResult = await handleHookWithDaemon({
          root: options.root,
          sessionId: options.session,
          event,
          primeProfile: options.primeProfile,
          primeBudget: options.primeBudget,
          hookOutput: options.hookOutput
        });
        const result = daemonResult ?? await withRuntime(options.root, async (runtime) =>
          runtime.handleHookEvent({
            sessionId: options.session,
            event,
            primeProfile: options.primeProfile,
            primeBudget: options.primeBudget,
            hookOutput: options.hookOutput,
            transport: "cli",
            daemonAttempted: true,
            daemonHit: false
          })
        );

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
}
