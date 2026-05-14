import { createInterface } from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { checkbox, confirm, select } from "@inquirer/prompts";
import pc from "picocolors";
import { runDoctor } from "../../doctor/doctor.js";
import { KairnRuntime } from "../../runtime/KairnRuntime.js";
import { enableTelemetry, getTelemetryStatus } from "../../telemetry/config.js";
import type { CodexSetupMode } from "../../types.js";
import { writeClaudeHooksSetup } from "./claudeSetup.js";
import { writeCodexSetup } from "./codexSetup.js";
import { writeMcpClientSetup, type McpClientSetupTarget } from "./mcpSetup.js";

export type SetupWizardChoice = "codex" | "mcp" | "both" | "hybrid" | "doctor";
export type SetupWizardTarget = "codex" | "claude-code" | "copilot-cli" | "gemini-cli" | "vscode" | "generic" | "doctor";
export type SetupWizardIndexMode = "safe" | "full" | "skip";

export type SetupWizardResult = {
  rootPath: string;
  choice: SetupWizardChoice;
  targets: SetupWizardTarget[];
  indexMode: SetupWizardIndexMode;
  indexed: boolean;
  indexError?: string | undefined;
  integrations: Array<{
    kind: "codex" | "mcp" | "hybrid" | "claude-hooks";
    target?: SetupWizardTarget | undefined;
    mode?: CodexSetupMode | undefined;
    configPath?: string | undefined;
    hooksPath?: string | undefined;
    instructionsPath?: string | undefined;
    installCommand?: string | undefined;
    userConfigWriteSkipped?: boolean | undefined;
  }>;
  telemetry: ReturnType<typeof getTelemetryStatus>;
  doctor: ReturnType<typeof runDoctor>;
  nextSteps: string[];
};

const KAIRN_WIZARD_BANNER = [
  " _                            _.-._",
  "| | ____ (_) _ __ _ __       /_____\\",
  "| |/ / _` | || '__| '_ \\      /_\\",
  "|   < (_| | || |  | | | |    _/___\\_",
  "|_|\\_\\__,_|_||_|  |_| |_|   /_______\\"
].join("\n");

export async function runSetupWizard(inputOptions: {
  root: string;
  choice?: SetupWizardChoice | undefined;
  targets?: string | undefined;
  yes?: boolean | undefined;
  index?: boolean | undefined;
  indexMode?: SetupWizardIndexMode | undefined;
  telemetry?: boolean | undefined;
  telemetryEndpoint?: string | undefined;
  interactive?: boolean | undefined;
}): Promise<SetupWizardResult> {
  const rootPath = path.resolve(inputOptions.root);
  const interactive = inputOptions.interactive ?? process.stdin.isTTY;
  const answers = (inputOptions.choice || inputOptions.targets) && inputOptions.index !== undefined
    ? {
        choice: inputOptions.choice ?? choiceFromTargets(parseTargets(inputOptions.targets)),
        targets: inputOptions.targets ? parseTargets(inputOptions.targets) : targetsFromChoice(inputOptions.choice),
        index: inputOptions.index,
        indexMode: inputOptions.index ? inputOptions.indexMode ?? defaultWizardIndexMode() : "skip",
        telemetry: Boolean(inputOptions.telemetry),
        codexMode: inputOptions.choice === "hybrid" ? "hybrid" as const : "savings" as const,
        claudeHooks: false,
        copilotWriteUser: false
      }
    : await collectWizardAnswers({
        choice: inputOptions.choice,
        targets: inputOptions.targets,
        index: inputOptions.index,
        indexMode: inputOptions.indexMode,
        telemetry: inputOptions.telemetry,
        yes: inputOptions.yes,
        interactive
      });

  const runtime = new KairnRuntime(rootPath);
  try {
    const integrations: SetupWizardResult["integrations"] = [];
    let indexed = false;
    let indexError: string | undefined;
    if (answers.index) {
      const restoreParserEnv = useSafeWizardIndexing(answers.indexMode);
      try {
        if (interactive) output.write(pc.dim(`Indexing repo (${answers.indexMode})...\n`));
        await runtime.init();
        indexed = true;
      } catch (error) {
        indexError = error instanceof Error ? error.message : String(error);
      } finally {
        restoreParserEnv();
      }
    }

    if (answers.targets.includes("codex")) {
      const setup = writeCodexSetup({
        root: rootPath,
        mode: answers.codexMode,
        primeProfile: "auto",
        hookOutput: answers.codexMode === "hybrid" ? "mcp-brief" : "full-prime",
        postToolHookOutput: "failure-only",
        primeBudget: 900
      });
      integrations.push({
        kind: answers.codexMode === "hybrid" ? "hybrid" : "codex",
        target: "codex",
        mode: setup.mode,
        configPath: setup.configPath,
        hooksPath: setup.hooksPath,
        instructionsPath: setup.instructionsPath
      });
    }

    for (const target of answers.targets.filter(isMcpTarget)) {
      const setup = writeMcpClientSetup({
        root: rootPath,
        client: target,
        writeInstructions: true,
        writeUserConfig: target === "copilot-cli" ? answers.copilotWriteUser : undefined
      });
      integrations.push({
        kind: "mcp",
        target,
        configPath: setup.configPath,
        instructionsPath: setup.instructionsPath,
        installCommand: setup.installCommand,
        userConfigWriteSkipped: setup.userConfigWriteSkipped
      });
    }

    if (answers.targets.includes("claude-code") && answers.claudeHooks) {
      const setup = writeClaudeHooksSetup({ root: rootPath });
      integrations.push({
        kind: "claude-hooks",
        target: "claude-code",
        configPath: setup.configPath,
        hooksPath: setup.configPath
      });
    }

    if (answers.telemetry) {
      enableTelemetry({
        rootPath,
        destination: "supabase",
        endpoint: inputOptions.telemetryEndpoint
      });
    }

    const doctor = runDoctor({ rootPath, runtime });
    return {
      rootPath,
      choice: answers.choice,
      targets: answers.targets,
      indexMode: answers.indexMode,
      indexed,
      indexError,
      integrations,
      telemetry: getTelemetryStatus(rootPath),
      doctor,
      nextSteps: buildNextSteps(answers, rootPath)
    };
  } finally {
    runtime.close();
  }
}

export function formatSetupWizardResult(result: SetupWizardResult): string {
  const integrationLines = result.integrations.length > 0
    ? result.integrations.map((integration) => {
        const target = integration.target ? ` [${integration.target}]` : "";
        const mode = integration.mode ? ` (${integration.mode})` : "";
        const config = integration.configPath ? `\n  config: ${integration.configPath}` : "";
        const hooks = integration.hooksPath ? `\n  hooks: ${integration.hooksPath}` : "";
        const instructions = integration.instructionsPath ? `\n  instructions: ${integration.instructionsPath}` : "";
        const install = integration.installCommand ? `\n  install: ${integration.installCommand}` : "";
        const skipped = integration.userConfigWriteSkipped ? "\n  user config not written; copy clientConfig or rerun with --install-user" : "";
        return `- ${integration.kind}${target}${mode}${config}${hooks}${instructions}${install}${skipped}`;
      })
    : ["- diagnostics only"];

  const indexWarning = result.indexError ? [`Index warning: ${result.indexError}`] : [];

  return [
    KAIRN_WIZARD_BANNER,
    "",
    "Kairn setup wizard complete.",
    `Root: ${result.rootPath}`,
    `Choice: ${result.choice}`,
    `Targets: ${result.targets.join(", ") || "none"}`,
    `Index mode: ${result.indexMode}`,
    `Indexed now: ${result.indexed}`,
    ...indexWarning,
    `Doctor status: ${result.doctor.status}`,
    `Telemetry upload: ${result.telemetry.enabled ? "enabled" : "disabled"}`,
    "",
    "Configured",
    ...integrationLines,
    "",
    "Next steps",
    ...result.nextSteps.map((step) => `- ${step}`),
    ""
  ].join("\n");
}

async function collectWizardAnswers(inputOptions: {
  choice?: SetupWizardChoice | undefined;
  targets?: string | undefined;
  index?: boolean | undefined;
  indexMode?: SetupWizardIndexMode | undefined;
  telemetry?: boolean | undefined;
  yes?: boolean | undefined;
  interactive: boolean;
}): Promise<{
  choice: SetupWizardChoice;
  targets: SetupWizardTarget[];
  index: boolean;
  indexMode: SetupWizardIndexMode;
  telemetry: boolean;
  codexMode: "savings" | "hybrid" | "mcp-first";
  claudeHooks: boolean;
  copilotWriteUser: boolean;
}> {
  const explicitTargets = inputOptions.targets ? parseTargets(inputOptions.targets) : undefined;
  if (inputOptions.yes || !inputOptions.interactive) {
    const targets = explicitTargets ?? targetsFromChoice(inputOptions.choice);
    const index = inputOptions.index ?? inputOptions.indexMode !== "skip";
    return {
      choice: inputOptions.choice ?? choiceFromTargets(targets),
      targets,
      index,
      indexMode: index ? inputOptions.indexMode ?? defaultWizardIndexMode() : "skip",
      telemetry: Boolean(inputOptions.telemetry),
      codexMode: inputOptions.choice === "hybrid" ? "hybrid" : "savings",
      claudeHooks: false,
      copilotWriteUser: false
    };
  }

  if (!inputOptions.choice && !explicitTargets) {
    return collectInteractiveWizardAnswers({
      index: inputOptions.index,
      indexMode: inputOptions.indexMode,
      telemetry: inputOptions.telemetry
    });
  }

  const rl = createInterface({ input, output });
  try {
    output.write(
      [
        "",
        KAIRN_WIZARD_BANNER,
        "",
        "Kairn setup wizard",
        "",
        "Choose how this repo should use Kairn:",
        "  1. Codex CLI session/hooks (recommended for terminal users)",
        "  2. VS Code / editor MCP (no hooks)",
        "  3. Both Codex hooks and VS Code MCP",
        "  4. Advanced Codex hybrid (hook + MCP)",
        "  5. Diagnostics only",
        ""
      ].join("\n")
    );
    const choice = inputOptions.choice ?? parseChoice(await rl.question("Integration [1]: "));
    const targets = explicitTargets ?? targetsFromChoice(choice);
    const index = inputOptions.index ?? parseYesNo(await rl.question("Index this repo now? [Y/n]: "), true);
    const telemetry = inputOptions.telemetry ?? parseYesNo(
      await rl.question("Enable opt-in sanitized telemetry upload? [y/N]: "),
      false
    );
    return {
      choice,
      targets,
      index,
      indexMode: index ? inputOptions.indexMode ?? defaultWizardIndexMode() : "skip",
      telemetry,
      codexMode: choice === "hybrid" ? "hybrid" : "savings",
      claudeHooks: false,
      copilotWriteUser: false
    };
  } finally {
    rl.close();
  }
}

async function collectInteractiveWizardAnswers(inputOptions: {
  index?: boolean | undefined;
  indexMode?: SetupWizardIndexMode | undefined;
  telemetry?: boolean | undefined;
}): Promise<{
  choice: SetupWizardChoice;
  targets: SetupWizardTarget[];
  index: boolean;
  indexMode: SetupWizardIndexMode;
  telemetry: boolean;
  codexMode: "savings" | "hybrid" | "mcp-first";
  claudeHooks: boolean;
  copilotWriteUser: boolean;
}> {
  const state = {
    targets: ["codex"] as SetupWizardTarget[],
    codexMode: "savings" as "savings" | "hybrid" | "mcp-first",
    claudeHooks: false,
    copilotWriteUser: false,
    indexMode: inputOptions.index === false ? "skip" as SetupWizardIndexMode : inputOptions.indexMode ?? defaultWizardIndexMode(),
    telemetry: Boolean(inputOptions.telemetry)
  };
  let step = 0;

  output.write(["", pc.cyan(KAIRN_WIZARD_BANNER), "", pc.bold("Kairn setup wizard"), ""].join("\n"));
  while (step < 5) {
    if (step === 0) {
      state.targets = await checkbox<SetupWizardTarget>({
        message: "Choose agents/clients to configure",
        required: true,
        choices: [
          { name: "Codex CLI session/hooks", value: "codex", checked: true },
          { name: "Claude Code MCP", value: "claude-code" },
          { name: "GitHub Copilot CLI MCP", value: "copilot-cli" },
          { name: "Gemini CLI MCP", value: "gemini-cli" },
          { name: "VS Code / Copilot MCP", value: "vscode" },
          { name: "Generic MCP JSON", value: "generic" },
          { name: "Diagnostics only", value: "doctor" }
        ]
      });
      if (state.targets.includes("doctor")) state.targets = ["doctor"];
      step = 1;
      continue;
    }

    if (step === 1) {
      if (state.targets.includes("codex")) {
        const codexMode = await select({
          message: "Codex setup mode",
          choices: [
            { name: "Savings hooks (recommended)", value: "savings" as const },
            { name: "MCP-first", value: "mcp-first" as const },
            { name: "Hybrid hook + MCP", value: "hybrid" as const },
            { name: "Back", value: "back" as const }
          ]
        });
        if (codexMode === "back") {
          step = 0;
          continue;
        }
        state.codexMode = codexMode;
      }
      if (state.targets.includes("claude-code")) {
        const claudeMode = await select({
          message: "Claude Code setup",
          choices: [
            { name: "MCP only (recommended)", value: "mcp" },
            { name: "MCP + advanced Claude hooks", value: "hooks" },
            { name: "Back", value: "back" }
          ]
        });
        if (claudeMode === "back") {
          step = 0;
          continue;
        }
        state.claudeHooks = claudeMode === "hooks";
      }
      if (state.targets.includes("copilot-cli")) {
        state.copilotWriteUser = await confirm({
          message: "Write Kairn to ~/.copilot/mcp-config.json? Choose no to print config only.",
          default: false
        });
      }
      step = 2;
      continue;
    }

    if (step === 2) {
      const indexMode = await select({
        message: "Indexing mode",
        default: state.indexMode,
        choices: indexModeChoices()
      });
      if (indexMode === "back") {
        step = 1;
        continue;
      }
      state.indexMode = indexMode;
      step = 3;
      continue;
    }

    if (step === 3) {
      state.telemetry = await confirm({
        message: "Enable opt-in sanitized telemetry upload?",
        default: state.telemetry
      });
      step = 4;
      continue;
    }

    const confirmed = await confirm({
      message: `Configure ${state.targets.join(", ")} with ${state.indexMode} indexing?`,
      default: true
    });
    if (!confirmed) {
      step = 0;
      continue;
    }
    break;
  }

  return {
    choice: choiceFromTargets(state.targets),
    targets: state.targets,
    index: state.indexMode !== "skip",
    indexMode: state.indexMode,
    telemetry: state.telemetry,
    codexMode: state.codexMode,
    claudeHooks: state.claudeHooks,
    copilotWriteUser: state.copilotWriteUser
  };
}

function parseChoice(answer: string): SetupWizardChoice {
  const value = answer.trim().toLowerCase();
  if (!value || value === "1" || value === "codex") return "codex";
  if (value === "2" || value === "mcp" || value === "vscode") return "mcp";
  if (value === "3" || value === "both") return "both";
  if (value === "4" || value === "hybrid") return "hybrid";
  if (value === "5" || value === "doctor" || value === "diagnostics") return "doctor";
  throw new Error(`Unknown setup choice: ${answer}`);
}

function parseYesNo(answer: string, defaultValue: boolean): boolean {
  const value = answer.trim().toLowerCase();
  if (!value) return defaultValue;
  if (value === "y" || value === "yes") return true;
  if (value === "n" || value === "no") return false;
  throw new Error(`Expected yes or no, received: ${answer}`);
}

function parseTargets(value: string | undefined): SetupWizardTarget[] {
  const targets = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      if (entry === "claude") return "claude-code";
      if (entry === "copilot") return "copilot-cli";
      if (entry === "gemini") return "gemini-cli";
      if (entry === "mcp") return "vscode";
      return entry;
    });
  const allowed = new Set<SetupWizardTarget>(["codex", "claude-code", "copilot-cli", "gemini-cli", "vscode", "generic", "doctor"]);
  const invalid = targets.find((target) => !allowed.has(target as SetupWizardTarget));
  if (invalid) throw new Error(`Unknown setup target: ${invalid}`);
  const parsed = [...new Set(targets as SetupWizardTarget[])];
  if (parsed.includes("doctor")) return ["doctor"];
  return parsed.length > 0 ? parsed : ["codex"];
}

function targetsFromChoice(choice: SetupWizardChoice | undefined): SetupWizardTarget[] {
  if (choice === "mcp") return ["vscode"];
  if (choice === "both") return ["codex", "vscode"];
  if (choice === "hybrid") return ["codex", "vscode"];
  if (choice === "doctor") return ["doctor"];
  return ["codex"];
}

function choiceFromTargets(targets: SetupWizardTarget[]): SetupWizardChoice {
  if (targets.length === 1 && targets[0] === "doctor") return "doctor";
  if (targets.includes("codex") && targets.some(isMcpTarget)) return "both";
  if (targets.includes("codex")) return "codex";
  return "mcp";
}

function isMcpTarget(target: SetupWizardTarget): target is McpClientSetupTarget {
  return target === "vscode" ||
    target === "claude-code" ||
    target === "copilot-cli" ||
    target === "gemini-cli" ||
    target === "generic";
}

function buildNextSteps(
  answers: {
    choice: SetupWizardChoice;
    targets: SetupWizardTarget[];
    codexMode: "savings" | "hybrid" | "mcp-first";
    claudeHooks: boolean;
    copilotWriteUser: boolean;
  },
  rootPath: string
): string[] {
  const steps: string[] = [];
  if (answers.targets.includes("codex")) {
    steps.push(`For terminal Codex work, run: kairn codex --root ${shellPath(rootPath)}`);
    steps.push("Inside Codex, review/approve the Kairn hook if prompted.");
  }
  if (answers.targets.includes("vscode")) {
    steps.push("Reload VS Code or start the Kairn server from the MCP Servers view.");
  }
  if (answers.targets.includes("claude-code")) {
    steps.push("In Claude Code, run: claude mcp list, then use /mcp to verify the Kairn server.");
    if (answers.claudeHooks) steps.push("In Claude Code, use /hooks to inspect the advanced Kairn hooks.");
  }
  if (answers.targets.includes("copilot-cli")) {
    steps.push(answers.copilotWriteUser ? "In Copilot CLI, run: /mcp show kairn." : "For Copilot CLI, copy the generated clientConfig into ~/.copilot/mcp-config.json or rerun with --install-user.");
  }
  if (answers.targets.includes("gemini-cli")) {
    steps.push("In Gemini CLI, run: /mcp to verify the Kairn server.");
  }
  if (answers.targets.includes("generic")) {
    steps.push("Copy the generated clientConfig/serverConfig into your MCP client's config.");
  }
  if (answers.targets.includes("doctor")) {
    steps.push("Run: kairn doctor --root <repo>");
  }
  steps.push("Run: kairn bench mcp-smoke --root <repo> --task \"Find the main source files\" --json to verify MCP transport.");
  steps.push("Run: kairn beta report --root <repo> after a few sessions to see whether Kairn helped or stayed silent.");
  return steps;
}

function shellPath(value: string): string {
  return /[\s&|;<>()]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function defaultWizardIndexMode(): SetupWizardIndexMode {
  return process.platform === "win32" ? "safe" : "full";
}

function indexModeChoices(): Array<{ name: string; value: SetupWizardIndexMode | "back" }> {
  const safe = {
    name: process.platform === "win32" ? "Safe setup index (recommended on Windows)" : "Safe setup index (Windows fallback)",
    value: "safe" as const
  };
  const full = {
    name: process.platform === "win32" ? "Full AST index" : "Full AST index (recommended)",
    value: "full" as const
  };
  const skip = { name: "Skip indexing for now", value: "skip" as const };
  const back = { name: "Back", value: "back" as const };
  return process.platform === "win32" ? [safe, full, skip, back] : [full, safe, skip, back];
}

function useSafeWizardIndexing(indexMode: SetupWizardIndexMode): () => void {
  if (indexMode !== "safe") return () => {};
  if (/^(1|true|yes)$/i.test(process.env.KAIRN_WIZARD_WASM_INDEX ?? "")) return () => {};

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
