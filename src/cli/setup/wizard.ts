import { createInterface } from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { runDoctor } from "../../doctor/doctor.js";
import { KairnRuntime } from "../../runtime/KairnRuntime.js";
import { enableTelemetry, getTelemetryStatus } from "../../telemetry/config.js";
import type { CodexSetupMode } from "../../types.js";
import { writeCodexSetup } from "./codexSetup.js";
import { writeMcpClientSetup } from "./mcpSetup.js";

export type SetupWizardChoice = "codex" | "mcp" | "both" | "hybrid" | "doctor";

export type SetupWizardResult = {
  rootPath: string;
  choice: SetupWizardChoice;
  indexed: boolean;
  integrations: Array<{
    kind: "codex" | "mcp" | "hybrid";
    mode?: CodexSetupMode | undefined;
    configPath?: string | undefined;
    hooksPath?: string | undefined;
    instructionsPath?: string | undefined;
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
  yes?: boolean | undefined;
  index?: boolean | undefined;
  telemetry?: boolean | undefined;
  telemetryEndpoint?: string | undefined;
  interactive?: boolean | undefined;
}): Promise<SetupWizardResult> {
  const rootPath = path.resolve(inputOptions.root);
  const interactive = inputOptions.interactive ?? process.stdin.isTTY;
  const answers = inputOptions.choice && inputOptions.index !== undefined
    ? {
        choice: inputOptions.choice,
        index: inputOptions.index,
        telemetry: Boolean(inputOptions.telemetry)
      }
    : await collectWizardAnswers({
        choice: inputOptions.choice,
        index: inputOptions.index,
        telemetry: inputOptions.telemetry,
        yes: inputOptions.yes,
        interactive
      });

  const runtime = new KairnRuntime(rootPath);
  try {
    const integrations: SetupWizardResult["integrations"] = [];
    if (answers.index) {
      await runtime.init();
    }

    if (answers.choice === "codex" || answers.choice === "both") {
      const setup = writeCodexSetup({
        root: rootPath,
        mode: "savings",
        primeProfile: "auto",
        hookOutput: "full-prime",
        postToolHookOutput: "failure-only",
        primeBudget: 900
      });
      integrations.push({
        kind: "codex",
        mode: setup.mode,
        configPath: setup.configPath,
        hooksPath: setup.hooksPath
      });
    }

    if (answers.choice === "mcp" || answers.choice === "both") {
      const setup = writeMcpClientSetup({
        root: rootPath,
        client: "vscode",
        writeInstructions: true
      });
      integrations.push({
        kind: "mcp",
        configPath: setup.configPath,
        instructionsPath: setup.instructionsPath
      });
    }

    if (answers.choice === "hybrid") {
      const setup = writeCodexSetup({
        root: rootPath,
        mode: "hybrid",
        primeProfile: "auto",
        hookOutput: "mcp-brief",
        postToolHookOutput: "failure-only",
        primeBudget: 900
      });
      integrations.push({
        kind: "hybrid",
        mode: setup.mode,
        configPath: setup.configPath,
        hooksPath: setup.hooksPath,
        instructionsPath: setup.instructionsPath
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
      indexed: answers.index,
      integrations,
      telemetry: getTelemetryStatus(rootPath),
      doctor,
      nextSteps: buildNextSteps(answers.choice, rootPath)
    };
  } finally {
    runtime.close();
  }
}

export function formatSetupWizardResult(result: SetupWizardResult): string {
  const integrationLines = result.integrations.length > 0
    ? result.integrations.map((integration) => {
        const mode = integration.mode ? ` (${integration.mode})` : "";
        const config = integration.configPath ? `\n  config: ${integration.configPath}` : "";
        const hooks = integration.hooksPath ? `\n  hooks: ${integration.hooksPath}` : "";
        const instructions = integration.instructionsPath ? `\n  instructions: ${integration.instructionsPath}` : "";
        return `- ${integration.kind}${mode}${config}${hooks}${instructions}`;
      })
    : ["- diagnostics only"];

  return [
    KAIRN_WIZARD_BANNER,
    "",
    "Kairn setup wizard complete.",
    `Root: ${result.rootPath}`,
    `Choice: ${result.choice}`,
    `Indexed now: ${result.indexed}`,
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
  index?: boolean | undefined;
  telemetry?: boolean | undefined;
  yes?: boolean | undefined;
  interactive: boolean;
}): Promise<{ choice: SetupWizardChoice; index: boolean; telemetry: boolean }> {
  if (inputOptions.yes || !inputOptions.interactive) {
    return {
      choice: inputOptions.choice ?? "codex",
      index: inputOptions.index ?? true,
      telemetry: Boolean(inputOptions.telemetry)
    };
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
    const index = inputOptions.index ?? parseYesNo(await rl.question("Index this repo now? [Y/n]: "), true);
    const telemetry = inputOptions.telemetry ?? parseYesNo(
      await rl.question("Enable opt-in sanitized telemetry upload? [y/N]: "),
      false
    );
    return { choice, index, telemetry };
  } finally {
    rl.close();
  }
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

function buildNextSteps(choice: SetupWizardChoice, rootPath: string): string[] {
  if (choice === "codex") {
    return [
      `Run: kairn codex --root ${shellPath(rootPath)}`,
      "Inside Codex, review/approve the Kairn hook if prompted.",
      "Run: kairn beta report --root <repo> after a few sessions to see whether Kairn helped or stayed silent."
    ];
  }
  if (choice === "mcp") {
    return [
      "Reload VS Code or your MCP client so it picks up .vscode/mcp.json.",
      "Use the MCP server named kairn for diagnose, investigate, audit, trace, and failing-test tasks.",
      "Run: kairn doctor --root <repo> if the editor does not show the Kairn MCP server."
    ];
  }
  if (choice === "both") {
    return [
      `For terminal work, run: kairn codex --root ${shellPath(rootPath)}`,
      "For editor work, reload VS Code or your MCP client so it picks up .vscode/mcp.json.",
      "Use pure MCP in editors; hybrid is only needed when an agent supports both hooks and MCP."
    ];
  }
  if (choice === "hybrid") {
    return [
      "Use hybrid only for Codex setups where hooks are approved and MCP is available.",
      "If MCP calls are not recorded, switch back to pure Codex session or pure MCP.",
      `For the simpler session-bound path, run: kairn codex --root ${shellPath(rootPath)}`
    ];
  }
  return [
    "Run: kairn doctor --root <repo>",
    "Choose Codex session hooks or MCP later with `kairn setup wizard`."
  ];
}

function shellPath(value: string): string {
  return value.includes(" ") ? `"${value.replaceAll('"', '\\"')}"` : value;
}
