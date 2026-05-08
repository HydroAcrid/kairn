import { Command, Option } from "commander";
import type { CodexSetupMode, HookOutputProfile, PrimeProfile } from "../../types.js";
import { writeCodexSetup } from "../setup/codexSetup.js";
import { writeMcpInstructionsSetup } from "../setup/mcpInstructions.js";
import { parsePositiveInt } from "../helpers.js";
import { printJson } from "../output.js";

export function registerSetupCommands(program: Command): void {
  const setup = program
    .command("setup")
    .description("Install local agent integration files for a target repo.");

  setup
    .command("codex")
    .description("Install Codex hook config that lets Kairn prime prompts automatically.")
    .option("--root <path>", "target repository root", process.cwd())
    .addOption(new Option("--mode <mode>", "Codex hook setup mode").choices(["savings", "observe", "debug", "mcp-first", "hybrid"]).default("savings"))
    .addOption(new Option("--prime-profile <profile>", "prompt-submit prime profile").choices(["auto", "ui", "workflow", "backend", "test", "generic"]).default("auto"))
    .addOption(new Option("--hook-output <profile>", "prompt-submit hook output profile").choices(["full-prime", "tiny-directive", "failure-only", "mcp-brief"]).default("full-prime"))
    .addOption(new Option("--post-tool-hook-output <profile>", "post-tool hook output profile").choices(["full-prime", "tiny-directive", "failure-only", "mcp-brief"]).default("failure-only"))
    .option("--prime-budget <tokens>", "prompt-submit prime token budget", parsePositiveInt, 900)
    .option("--json", "print JSON output")
    .action((options: {
      root: string;
      mode: CodexSetupMode;
      primeProfile: PrimeProfile;
      hookOutput: HookOutputProfile;
      postToolHookOutput: HookOutputProfile;
      primeBudget: number;
      json?: boolean;
    }) => {
      const result = writeCodexSetup({
        root: options.root,
        mode: options.mode,
        primeProfile: options.primeProfile,
        hookOutput: options.mode === "hybrid" ? "mcp-brief" : options.hookOutput,
        postToolHookOutput: options.postToolHookOutput,
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
          result.mcpConfigured ? `MCP: ${result.mcpServerName}` : "",
          result.instructionsPath ? `Instructions: ${result.instructionsPath}` : "",
          `Mode: ${result.mode}`,
          `Hook output: ${result.hookOutput}`,
          `Post-tool hook output: ${result.postToolHookOutput}`,
          result.mode === "mcp-first"
            ? "No prompt hook was installed; Codex should use Kairn through MCP-first instructions."
            : "Codex UserPromptSubmit hooks will request proactive Kairn context without KAIRN_SESSION.",
          result.mcpConfigured ? `${result.mode} mode writes a Kairn MCP server config and AGENTS.md guidance.` : "",
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
