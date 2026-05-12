import { Command, Option } from "commander";
import type { CodexSetupMode, HookOutputProfile, PrimeProfile } from "../../types.js";
import { writeCodexSetup } from "../setup/codexSetup.js";
import { writeMcpClientSetup, type McpClientSetupTarget } from "../setup/mcpSetup.js";
import { writeMcpInstructionsSetup } from "../setup/mcpInstructions.js";
import { formatSetupRemoveResult, removeKairnSetup } from "../setup/remove.js";
import { formatSetupWizardResult, runSetupWizard, type SetupWizardChoice } from "../setup/wizard.js";
import { parsePositiveInt } from "../helpers.js";
import { printJson } from "../output.js";

export function registerSetupCommands(program: Command): void {
  const setup = program
    .command("setup")
    .description("Install local agent integration files for a target repo.");

  setup
    .command("remove")
    .description("Remove Kairn-owned hook/MCP setup from a target repo.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--delete-state", "also delete .kairn indexes, metrics, ledger, and telemetry queue")
    .option("--json", "print JSON output")
    .action((options: { root: string; deleteState?: boolean; json?: boolean }) => {
      const result = removeKairnSetup({
        root: options.root,
        deleteState: options.deleteState
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(formatSetupRemoveResult(result));
    });

  setup
    .command("wizard")
    .description("Run the guided Kairn setup wizard for Codex CLI, VS Code MCP, or both.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--choice <choice>", "non-interactive setup choice").choices(["codex", "mcp", "both", "hybrid", "doctor"]))
    .option("--yes", "accept defaults for non-interactive setup")
    .option("--no-index", "skip indexing during setup")
    .option("--telemetry", "enable opt-in sanitized telemetry upload")
    .option("--telemetry-endpoint <url>", "telemetry ingest endpoint override")
    .option("--json", "print JSON output")
    .action(async (options: {
      root: string;
      choice?: SetupWizardChoice;
      yes?: boolean;
      index?: boolean;
      telemetry?: boolean;
      telemetryEndpoint?: string;
      json?: boolean;
    }, command: Command) => {
      const indexSource = command.getOptionValueSource("index");
      const result = await runSetupWizard({
        root: options.root,
        choice: options.choice,
        yes: options.yes,
        index: indexSource === "default" ? undefined : options.index,
        telemetry: options.telemetry,
        telemetryEndpoint: options.telemetryEndpoint
      });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(formatSetupWizardResult(result));
    });

  setup
    .command("mcp")
    .description("Install a Kairn MCP server config for editor/app clients such as VS Code.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--client <client>", "MCP client config format").choices(["vscode", "generic"]).default("vscode"))
    .option("--no-instructions", "do not write AGENTS.md MCP guidance")
    .option("--json", "print JSON output")
    .action((options: {
      root: string;
      client: McpClientSetupTarget;
      instructions?: boolean;
      json?: boolean;
    }) => {
      const result = writeMcpClientSetup({
        root: options.root,
        client: options.client,
        writeInstructions: options.instructions
      });
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(
        [
          "Kairn MCP setup written.",
          `Root: ${result.rootPath}`,
          `Client: ${result.client}`,
          result.configPath ? `Config: ${result.configPath}` : "Config: not written; use the JSON serverConfig for your MCP client.",
          `Server: ${result.serverName}`,
          result.instructionsPath ? `Instructions: ${result.instructionsPath}` : "",
          "MCP is best for editor/app integrations where prompt hooks are unavailable or not trusted.",
          ""
        ].filter(Boolean).join("\n")
      );
    });

  setup
    .command("codex")
    .description("Install Codex hook config that lets Kairn prime prompts automatically.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--mode <mode>", "Codex hook setup mode").choices(["savings", "observe", "debug", "mcp-first", "hybrid"]).default("savings"))
    .addOption(new Option("--prime-profile <profile>", "prompt-submit prime profile").choices(["auto", "ui", "workflow", "backend", "test", "failure_debug", "generic"]).default("auto"))
    .addOption(new Option("--hook-output <profile>", "prompt-submit hook output profile").choices(["full-prime", "tiny-directive", "failure-only", "mcp-brief"]).default("full-prime"))
    .addOption(new Option("--post-tool-hook-output <profile>", "post-tool hook output profile").choices(["full-prime", "tiny-directive", "failure-only", "mcp-brief"]).default("failure-only"))
    .option("--prime-budget <tokens>", "prompt-submit prime token budget", parsePositiveInt, 900)
    .option("--session <id>", "bind generated hook commands to an existing Kairn session")
    .option("--json", "print JSON output")
    .action((options: {
      root: string;
      mode: CodexSetupMode;
      primeProfile: PrimeProfile;
      hookOutput: HookOutputProfile;
      postToolHookOutput: HookOutputProfile;
      primeBudget: number;
      session?: string;
      json?: boolean;
    }) => {
      const result = writeCodexSetup({
        root: options.root,
        mode: options.mode,
        primeProfile: options.primeProfile,
        hookOutput: options.mode === "hybrid" ? "mcp-brief" : options.hookOutput,
        postToolHookOutput: options.postToolHookOutput,
        primeBudget: options.primeBudget,
        sessionId: options.session
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
          result.mcpConfigured ? `MCP: ${result.mcpServerName}` : "",
          result.instructionsPath ? `Instructions: ${result.instructionsPath}` : "",
          `Mode: ${result.mode}`,
          `Hook output: ${result.hookOutput}`,
          `Post-tool hook output: ${result.postToolHookOutput}`,
          options.session ? `Session-bound hooks: ${options.session}` : "",
          result.mode === "mcp-first"
            ? "No prompt hook was installed; Codex should use Kairn through MCP-first instructions."
            : "Codex UserPromptSubmit hooks will request proactive Kairn context without KAIRN_SESSION.",
          result.mcpConfigured ? `${result.mode} mode writes a Kairn MCP server config and AGENTS.md guidance.` : "",
          result.mcpConfigured
            ? "MCP proof note: noninteractive codex exec may cancel project MCP calls under workspace-write; in disposable benchmark clones use `codex -a never exec --sandbox danger-full-access ...` and require actualMcpToolCalls > 0."
            : "",
          ""
        ].filter(Boolean).join("\n")
      );
    });

  setup
    .command("mcp-instructions")
    .description("Install MCP-first agent instructions for a target repo without overwriting unrelated content.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action((options: { root: string; json?: boolean }) => {
      const result = writeMcpInstructionsSetup({ root: options.root });
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(
        [
          "Kairn MCP-first instructions written.",
          `Root: ${result.rootPath}`,
          `Instructions: ${result.instructionsPath}`,
          ""
        ].join("\n")
      );
    });
}
