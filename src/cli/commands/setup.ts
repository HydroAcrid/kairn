// SPDX-License-Identifier: Apache-2.0

import { Command, Option } from "commander";
import { confirm } from "@inquirer/prompts";
import type { CodexSetupMode, HookOutputProfile, PrimeProfile } from "../../types.js";
import { writeClaudeHooksSetup } from "../setup/claudeSetup.js";
import { writeCodexSetup } from "../setup/codexSetup.js";
import { writeMcpClientSetup, type McpClientSetupTarget } from "../setup/mcpSetup.js";
import { writeMcpInstructionsSetup } from "../setup/mcpInstructions.js";
import { formatSetupRemoveResult, removeKairnSetup } from "../setup/remove.js";
import { enableKairn, formatEnableResult, planKairnEnable } from "../setup/enable.js";
import { formatSetupWizardResult, runSetupWizard, type SetupWizardChoice } from "../setup/wizard.js";
import { parsePositiveInt } from "../helpers.js";
import { printJson } from "../output.js";

export function registerSetupCommands(program: Command): void {
  program
    .command("enable")
    .description("Detect supported local agents and enable Kairn for this repository.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--agents <agents>", "comma-separated targets: codex,claude-code,copilot-cli,gemini-cli,vscode,generic")
    .option("--yes", "confirm all planned repository and user-level configuration changes")
    .option("--dry-run", "show detected agents and intended changes without writing files")
    .option("--semantic-preview", "opt into local semantic shadow evaluation without changing served results")
    .option("--offline", "do not download the semantic preview model")
    .option("--no-index", "skip the initial safe repository index")
    .option("--json", "print JSON output")
    .action(async (options: {
      root: string;
      agents?: string;
      yes?: boolean;
      dryRun?: boolean;
      semanticPreview?: boolean;
      offline?: boolean;
      index?: boolean;
      json?: boolean;
    }) => {
      const plan = planKairnEnable({
        root: options.root,
        agents: options.agents,
        semanticPreview: options.semanticPreview
      });
      if (options.dryRun) {
        const result = await enableKairn({
          plan,
          dryRun: true,
          index: options.index,
          installModel: Boolean(options.semanticPreview) && !options.offline
        });
        if (options.json) printJson(result);
        else process.stdout.write(formatEnableResult(result));
        return;
      }

      let approved = Boolean(options.yes);
      if (!approved) {
        if (!process.stdin.isTTY) {
          throw new Error("kairn enable requires confirmation. Re-run with --yes or inspect changes with --dry-run.");
        }
        process.stdout.write(formatEnableResult(await enableKairn({
          plan,
          dryRun: true,
          index: options.index,
          installModel: Boolean(options.semanticPreview) && !options.offline
        })));
        approved = await confirm({
          message: plan.writesUserConfig
            ? "Apply these changes, including ~/.copilot/mcp-config.json?"
            : "Apply these repository-local Kairn changes?",
          default: true
        });
      }
      const result = await enableKairn({
        plan,
        cancelled: !approved,
        index: options.index,
        installModel: Boolean(options.semanticPreview) && !options.offline
      });
      if (options.json) printJson(result);
      else process.stdout.write(formatEnableResult(result));
    });

  program
    .command("disable")
    .description("Remove Kairn-owned agent configuration from this repository.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--delete-state", "also delete .kairn indexes, metrics, ledger, and telemetry queue")
    .option("--json", "print JSON output")
    .action((options: { root: string; deleteState?: boolean; json?: boolean }) => {
      const result = removeKairnSetup({ root: options.root, deleteState: options.deleteState });
      if (options.json) printJson(result);
      else process.stdout.write(formatSetupRemoveResult(result));
    });

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
    .option("--targets <targets>", "comma-separated setup targets: codex,claude-code,copilot-cli,gemini-cli,vscode,generic")
    .option("--yes", "accept defaults for non-interactive setup")
    .option("--no-index", "skip indexing during setup")
    .addOption(new Option("--index-mode <mode>", "indexing mode during setup").choices(["safe", "full", "skip"]))
    .option("--telemetry", "enable opt-in sanitized telemetry upload")
    .option("--telemetry-endpoint <url>", "telemetry ingest endpoint override")
    .option("--json", "print JSON output")
    .action(async (options: {
      root: string;
      choice?: SetupWizardChoice;
      targets?: string;
      yes?: boolean;
      index?: boolean;
      indexMode?: "safe" | "full" | "skip";
      telemetry?: boolean;
      telemetryEndpoint?: string;
      json?: boolean;
    }, command: Command) => {
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
    });

  setup
    .command("mcp")
    .description("Install a Kairn MCP server config for editor/app clients.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--client <client>", "MCP client config format").choices(["vscode", "claude-code", "copilot-cli", "gemini-cli", "generic"]).default("vscode"))
    .option("--install-user", "write user-level config when the selected client requires it, such as Copilot CLI")
    .option("--no-instructions", "do not write AGENTS.md MCP guidance")
    .option("--json", "print JSON output")
    .action((options: {
      root: string;
      client: McpClientSetupTarget;
      installUser?: boolean;
      instructions?: boolean;
      json?: boolean;
    }) => {
      const result = writeMcpClientSetup({
        root: options.root,
        client: options.client,
        writeInstructions: options.instructions,
        writeUserConfig: options.installUser
      });
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(
        [
          result.configConflict ? "Kairn MCP setup needs attention." : "Kairn MCP setup written.",
          `Root: ${result.rootPath}`,
          `Client: ${result.client}`,
          result.configConflict
            ? `Config unchanged: ${result.configConflict.path}`
            : result.configPath ? `Config: ${result.configPath}` : "Config: not written; use the JSON clientConfig/serverConfig for your MCP client.",
          `Server: ${result.serverName}`,
          result.configConflict ? `Action required: ${result.configConflict.reason}` : "",
          result.installCommand ? `Install command: ${result.installCommand}` : "",
          result.userConfigWriteSkipped ? "User config was not written. Re-run with --install-user to write it." : "",
          result.instructionsPath ? `Instructions: ${result.instructionsPath}` : "",
          "MCP is best for editor/app integrations where prompt hooks are unavailable or not trusted.",
          ""
        ].filter(Boolean).join("\n")
      );
    });

  setup
    .command("claude")
    .description("Install advanced Claude Code hooks in .claude/settings.local.json.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action((options: { root: string; json?: boolean }) => {
      const result = writeClaudeHooksSetup({ root: options.root });
      if (options.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        [
          "Kairn Claude Code hooks written.",
          `Root: ${result.rootPath}`,
          `Config: ${result.configPath}`,
          `Hooks: ${result.hooksInstalled.join(", ")}`,
          "Claude MCP remains the recommended Claude path; hooks are advanced.",
          ""
        ].join("\n")
      );
    });

  setup
    .command("codex")
    .description("Install Codex hook config that lets Kairn prime prompts automatically.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--mode <mode>", "Codex hook setup mode").choices(["source-first", "savings", "observe", "debug", "mcp-first", "hybrid"]).default("source-first"))
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
      if (result.deprecatedModeAlias) {
        process.stderr.write("kairn: --mode savings is deprecated; using --mode source-first.\n");
      }
      if (options.json) {
        printJson(result);
        return;
      }

      process.stdout.write(
        [
          result.configConflict ? "Kairn Codex setup needs attention." : "Kairn Codex setup written.",
          `Root: ${result.rootPath}`,
          result.configConflict ? `Config unchanged: ${result.configConflict.path}` : `Config: ${result.configPath}`,
          result.configConflict ? "" : `Hooks: ${result.hooksPath}`,
          result.configConflict ? `Action required: ${result.configConflict.reason}` : "",
          result.mcpConfigured ? `MCP: ${result.mcpServerName}` : "",
          result.instructionsPath ? `Instructions: ${result.instructionsPath}` : "",
          `Mode: ${result.mode}`,
          `Hook output: ${result.hookOutput}`,
          `Post-tool hook output: ${result.postToolHookOutput}`,
          options.session ? `Session-bound hooks: ${options.session}` : "",
          result.configConflict ? "" : result.mode === "mcp-first"
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
