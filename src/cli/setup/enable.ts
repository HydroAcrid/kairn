// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DoctorReport } from "../../doctor/doctor.js";
import { runDoctor } from "../../doctor/doctor.js";
import { KairnRuntime } from "../../runtime/KairnRuntime.js";
import { writeCodexSetup } from "./codexSetup.js";
import { existingCopilotServerNameForRoot, isKairnOwnedMcpServer, writeMcpClientSetup, type McpClientSetupTarget } from "./mcpSetup.js";
import { runSetupWizard, type SetupWizardTarget } from "./wizard.js";
import { getSemanticModelState, installSemanticModel } from "../../semantic/modelManager.js";
import {
  DEFAULT_SEMANTIC_MODEL_ID,
  getSemanticModelManifest,
  semanticModelBytes
} from "../../semantic/modelRegistry.js";
import { writeSemanticRetrieverConfig } from "../../config/semantic.js";
import { ensureKairnInternalStateExcluded } from "../helpers.js";

export type EnableTarget = Exclude<SetupWizardTarget, "doctor">;
export type EnableAgentStatus = "configured" | "already-configured" | "planned" | "skipped" | "action-required";

export type EnableAgent = {
  target: EnableTarget;
  detected: boolean;
  configuredBefore: boolean;
  status: EnableAgentStatus;
  detail: string;
};

export type EnablePlan = {
  rootPath: string;
  homeDir?: string | undefined;
  targets: EnableTarget[];
  agents: EnableAgent[];
  writesUserConfig: boolean;
  semanticPreview: boolean;
  manualConfigs: Array<{ target: "generic"; clientConfig: Record<string, unknown> }>;
  semanticModel: ReturnType<typeof getSemanticModelState>;
  semanticModelDownload: {
    modelId: string;
    bytes: number;
    license: string;
    upstreamRepository: string;
    upstreamRevision: string;
    required: boolean;
  };
};

export type EnableResult = EnablePlan & {
  dryRun: boolean;
  cancelled: boolean;
  indexed: boolean;
  indexMode: "inventory" | "reuse" | "skip";
  deepIndexStarted: boolean;
  deepIndexLog?: string | undefined;
  indexError?: string | undefined;
  semanticModelInstalled: boolean;
  semanticModelError?: string | undefined;
  doctor?: DoctorReport | undefined;
};

const TARGETS: EnableTarget[] = ["codex", "claude-code", "copilot-cli", "gemini-cli", "vscode", "generic"];

export function planKairnEnable(input: {
  root: string;
  agents?: string | undefined;
  semanticPreview?: boolean | undefined;
  pathValue?: string | undefined;
  homeDir?: string | undefined;
}): EnablePlan {
  const rootPath = path.resolve(input.root);
  const homeDir = input.homeDir ?? os.homedir();
  const explicitTargets = input.agents ? parseEnableTargets(input.agents) : undefined;
  const states = TARGETS.map((target) => detectTarget({
    target,
    rootPath,
    homeDir,
    pathValue: input.pathValue ?? process.env.PATH ?? ""
  }));
  const detectedTargets = states
    .filter((agent) => agent.detected || agent.configuredBefore)
    .map((agent) => agent.target);
  // A bare enable must remain useful even when Kairn cannot identify the
  // caller's MCP client. The generic target prints a copy-ready local server
  // configuration while the normal enable path still builds the inventory.
  const targets = explicitTargets ?? (detectedTargets.length > 0 ? detectedTargets : ["generic"]);
  const selected = new Set(targets);
  const agents = states.map((agent): EnableAgent => {
    if (!selected.has(agent.target)) {
      return { ...agent, status: "skipped", detail: agent.detected ? "detected but not selected" : "not detected" };
    }
    if (agent.target === "generic") {
      return { ...agent, detected: true, status: "action-required", detail: "Kairn will print MCP JSON for manual client configuration" };
    }
    return {
      ...agent,
      status: agent.configuredBefore ? "already-configured" : "planned",
      detail: agent.configuredBefore ? "Kairn configuration will be refreshed" : "Kairn configuration will be added"
    };
  });
  const semanticModel = getSemanticModelState({
    modelId: DEFAULT_SEMANTIC_MODEL_ID,
    homeDir
  });
  const semanticManifest = getSemanticModelManifest(DEFAULT_SEMANTIC_MODEL_ID);
  return {
    rootPath,
    ...(input.homeDir ? { homeDir } : {}),
    targets,
    agents,
    writesUserConfig: targets.includes("copilot-cli"),
    semanticPreview: Boolean(input.semanticPreview),
    manualConfigs: targets.includes("generic")
      ? [{
          target: "generic",
          clientConfig: writeMcpClientSetup({ root: rootPath, client: "generic", writeInstructions: false }).clientConfig
        }]
      : [],
    semanticModel,
    semanticModelDownload: {
      modelId: semanticManifest.modelId,
      bytes: semanticModelBytes(semanticManifest),
      license: semanticManifest.license,
      upstreamRepository: semanticManifest.upstreamRepository,
      upstreamRevision: semanticManifest.upstreamRevision,
      required: Boolean(input.semanticPreview) && semanticModel.status !== "ready"
    }
  };
}

export async function enableKairn(input: {
  plan: EnablePlan;
  dryRun?: boolean | undefined;
  cancelled?: boolean | undefined;
  index?: boolean | undefined;
  installModel?: boolean | undefined;
}): Promise<EnableResult> {
  const index = input.index !== false;
  if (input.dryRun || input.cancelled) {
    return {
      ...input.plan,
      dryRun: Boolean(input.dryRun),
      cancelled: Boolean(input.cancelled),
      indexed: false,
      indexMode: "skip",
      deepIndexStarted: false,
      semanticModelInstalled: false
    };
  }

  // Keep local runtime state out of Git dirtiness and freshness calculations
  // before setup writes .kairn/config.json or builds either index stage.
  ensureKairnInternalStateExcluded(input.plan.rootPath);

  const configuredTargets = input.plan.targets.filter((target) => target !== "generic");
  const setup = index && configuredTargets.length > 0
    ? await runSetupWizard({
        root: input.plan.rootPath,
        targets: configuredTargets.join(","),
        yes: true,
        interactive: false,
        index: false,
        homeDir: input.plan.homeDir,
        installUser: input.plan.writesUserConfig
      })
    : undefined;
  const directIntegrations = setup ? [] : configureWithoutIndex(input.plan);
  const integrations = new Map((setup?.integrations ?? directIntegrations).map((integration) => [integration.target, integration]));
  let indexed = false;
  let indexMode: EnableResult["indexMode"] = index ? "inventory" : "skip";
  let indexError: string | undefined;
  let doctor = setup?.doctor;
  let deepIndexStarted = false;
  let deepIndexLog: string | undefined;
  let semanticModel = input.plan.semanticModel;
  let semanticModelInstalled = false;
  let semanticModelError: string | undefined;
  if (input.plan.semanticPreview && input.installModel && semanticModel.status !== "ready") {
    try {
      semanticModel = await installSemanticModel({
        modelId: DEFAULT_SEMANTIC_MODEL_ID,
        ...(input.plan.homeDir ? { homeDir: input.plan.homeDir } : {})
      });
      semanticModelInstalled = semanticModel.status === "ready";
    } catch (error) {
      semanticModelError = error instanceof Error ? error.message : String(error);
    }
  }
  writeSemanticRetrieverConfig(input.plan.rootPath, {
    mode: input.plan.semanticPreview ? "shadow" : "legacy",
    modelId: DEFAULT_SEMANTIC_MODEL_ID
  });
  if (index) {
    const runtime = new KairnRuntime(input.plan.rootPath);
    let needsDeepIndex = false;
    try {
      const existing = runtime.getIndexStatus();
      const hasFreshIndex = existing.fileCount > 0 && existing.freshness?.stale === false;
      const semanticIndexRequired = input.plan.semanticPreview
        && semanticModel.status === "ready"
        && existing.semanticEmbeddingCount === 0;
      const hasFreshFullIndex = hasFreshIndex
        && !runtime.isInventoryIndex()
        && !semanticIndexRequired;
      if (hasFreshIndex) {
        indexMode = "reuse";
      } else {
        await runtime.initInventory();
        indexMode = "inventory";
      }
      indexed = true;
      needsDeepIndex = !hasFreshFullIndex;
      doctor = runDoctor({ rootPath: input.plan.rootPath, runtime, homeDir: input.plan.homeDir });
    } catch (error) {
      indexError = error instanceof Error ? error.message : String(error);
    } finally {
      runtime.close();
    }
    if (indexed && needsDeepIndex) {
      const background = startDeepIndex(input.plan.rootPath);
      deepIndexStarted = background.started;
      deepIndexLog = background.logPath;
    }
  }
  const agents = input.plan.agents.map((agent): EnableAgent => {
    if (!input.plan.targets.includes(agent.target)) return agent;
    const integration = integrations.get(agent.target);
    if (agent.target === "generic") {
      return { ...agent, status: "action-required", detail: "Copy the returned MCP client configuration into the client" };
    }
    if (!integration) {
      return { ...agent, status: "action-required", detail: "No integration file was written; inspect doctor output" };
    }
    if (integration.actionRequired) {
      return { ...agent, status: "action-required", detail: integration.actionRequired };
    }
    if (integration.userConfigWriteSkipped) {
      return { ...agent, status: "action-required", detail: "User-level configuration was not written" };
    }
    return { ...agent, status: "configured", detail: integration.configPath ?? integration.hooksPath ?? "configured" };
  });
  return {
    ...input.plan,
    agents,
    dryRun: false,
    cancelled: false,
    indexed,
    indexMode,
    deepIndexStarted,
    semanticModel,
    semanticModelInstalled,
    ...(semanticModelError ? { semanticModelError } : {}),
    ...(deepIndexLog ? { deepIndexLog } : {}),
    ...(indexError ? { indexError } : {}),
    doctor
  };
}

function configureWithoutIndex(plan: EnablePlan): Array<{
  target: EnableTarget;
  configPath?: string | undefined;
  hooksPath?: string | undefined;
  userConfigWriteSkipped?: boolean | undefined;
  actionRequired?: string | undefined;
}> {
  return plan.targets.map((target) => {
    if (target === "codex") {
      const setup = writeCodexSetup({
        root: plan.rootPath,
        mode: "source-first",
        primeProfile: "auto",
        hookOutput: "full-prime",
        postToolHookOutput: "failure-only",
        primeBudget: 900
      });
      return {
        target,
        configPath: setup.configPath,
        hooksPath: setup.hooksPath,
        actionRequired: setup.configConflict?.reason
      };
    }
    const setup = writeMcpClientSetup({
      root: plan.rootPath,
      client: target as McpClientSetupTarget,
      // The generic target only prints copy-ready MCP configuration. It does
      // not know which client, instruction format, or tracked repository file
      // the user wants to modify, so it must remain read-only outside .kairn.
      writeInstructions: target !== "generic",
      homeDir: plan.homeDir,
      writeUserConfig: target === "copilot-cli" ? plan.writesUserConfig : undefined
    });
    return {
      target,
      configPath: setup.configPath,
      userConfigWriteSkipped: setup.userConfigWriteSkipped,
      actionRequired: setup.configConflict?.reason
    };
  });
}

export function formatEnableResult(result: EnableResult): string {
  const rows = result.agents.map((agent) => [
    agent.target,
    agent.detected ? "yes" : "no",
    agent.status,
    agent.detail
  ]);
  const widths = [
    Math.max("Agent".length, ...rows.map((row) => row[0]!.length)),
    Math.max("Detected".length, ...rows.map((row) => row[1]!.length)),
    Math.max("Status".length, ...rows.map((row) => row[2]!.length))
  ];
  const rowText = (row: string[]) => `${row[0]!.padEnd(widths[0]!)}  ${row[1]!.padEnd(widths[1]!)}  ${row[2]!.padEnd(widths[2]!)}  ${row[3]}`;
  const heading = result.cancelled ? "Kairn enable cancelled." : result.dryRun ? "Kairn enable dry run." : "Kairn enabled.";
  const manualConfigs = result.manualConfigs.flatMap((config) => [
    "",
    `Manual MCP config [${config.target}]`,
    JSON.stringify(config.clientConfig, null, 2)
  ]);
  return [
    heading,
    `Root: ${result.rootPath}`,
    `Index: ${result.indexed ? `inventory ready (${result.indexMode})` : result.indexMode === "skip" ? "not changed" : "not built"}`,
    `Candidate generator: ${result.semanticPreview ? "semantic preview (shadow; deterministic results served)" : "deterministic (default)"}`,
    result.semanticPreview
      ? `Semantic model: ${result.semanticModel.status}${result.semanticModelInstalled ? " (installed)" : ""}`
      : "Semantic model: not required",
    result.semanticPreview && result.semanticModelDownload.required
      ? `Model download: ${result.semanticModelDownload.modelId}, ${(result.semanticModelDownload.bytes / 1024 / 1024).toFixed(1)} MB, ${result.semanticModelDownload.license}, ${result.semanticModelDownload.upstreamRepository}@${result.semanticModelDownload.upstreamRevision}`
      : result.semanticPreview ? "Model download: not required" : "",
    result.semanticModelError ? `Semantic model warning: ${result.semanticModelError}` : "",
    result.deepIndexStarted ? `Deep index: started in background${result.deepIndexLog ? ` (${result.deepIndexLog})` : ""}` : "",
    result.indexError ? `Index warning: ${result.indexError}` : "",
    result.writesUserConfig ? "User config: ~/.copilot/mcp-config.json" : "",
    "",
    rowText(["Agent", "Detected", "Status", "Detail"]),
    rowText(["-".repeat(widths[0]!), "-".repeat(widths[1]!), "-".repeat(widths[2]!), "------"]),
    ...rows.map(rowText),
    ...manualConfigs,
    ""
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
}

function startDeepIndex(rootPath: string): { started: boolean; logPath?: string | undefined } {
  if (/^(1|true|yes)$/i.test(process.env.KAIRN_DISABLE_BACKGROUND_INDEX ?? "")) return { started: false };
  const invokedEntry = process.argv[1];
  if (!invokedEntry) return { started: false };
  let entry: string;
  try {
    // Global npm installs invoke the CLI through a `kairn` symlink. Resolve it
    // before validating and spawning so the installed path behaves like a
    // direct `node dist/cli.js` invocation.
    entry = fs.realpathSync(invokedEntry);
  } catch {
    return { started: false };
  }
  if (!/cli\.(?:[cm]?js|ts)$/i.test(path.basename(entry))) return { started: false };
  const logPath = path.join(rootPath, ".kairn", "deep-index.log");
  const descriptor = fs.openSync(logPath, "w");
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, entry, "init", "--state-only", "--root", rootPath, "--json"],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", descriptor, descriptor],
        env: { ...process.env, KAIRN_BACKGROUND_INDEX: "1" }
      }
    );
    child.unref();
    return { started: true, logPath };
  } catch {
    return { started: false, logPath };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function parseEnableTargets(value: string): EnableTarget[] {
  const aliases: Record<string, EnableTarget> = {
    codex: "codex",
    claude: "claude-code",
    "claude-code": "claude-code",
    copilot: "copilot-cli",
    "copilot-cli": "copilot-cli",
    gemini: "gemini-cli",
    "gemini-cli": "gemini-cli",
    vscode: "vscode",
    generic: "generic",
    mcp: "generic"
  };
  const entries = value.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const invalid = entries.find((entry) => !aliases[entry]);
  if (invalid) throw new Error(`Unknown agent target: ${invalid}`);
  const targets = [...new Set(entries.map((entry) => aliases[entry]!))];
  if (targets.length === 0) throw new Error("--agents must name at least one supported target.");
  return targets;
}

function detectTarget(input: {
  target: EnableTarget;
  rootPath: string;
  homeDir: string;
  pathValue: string;
}): Omit<EnableAgent, "status" | "detail"> {
  const configuredBefore = isConfigured(input.target, input.rootPath, input.homeDir);
  const commands: Record<EnableTarget, string[]> = {
    codex: ["codex"],
    "claude-code": ["claude"],
    "copilot-cli": ["copilot"],
    "gemini-cli": ["gemini"],
    vscode: ["code", "code-insiders"],
    generic: []
  };
  return {
    target: input.target,
    detected: configuredBefore || commands[input.target].some((command) => executableOnPath(command, input.pathValue)),
    configuredBefore
  };
}

function isConfigured(target: EnableTarget, rootPath: string, homeDir: string): boolean {
  if (target === "codex") {
    return hasKairnText(path.join(rootPath, ".codex", "hooks.json")) || hasKairnText(path.join(rootPath, ".codex", "config.toml"));
  }
  if (target === "vscode") return hasMcpServer(path.join(rootPath, ".vscode", "mcp.json"), "servers");
  if (target === "claude-code") return hasMcpServer(path.join(rootPath, ".mcp.json"), "mcpServers");
  if (target === "gemini-cli") return hasMcpServer(path.join(rootPath, ".gemini", "settings.json"), "mcpServers");
  if (target === "copilot-cli") {
    const configPath = path.join(homeDir, ".copilot", "mcp-config.json");
    return existingCopilotServerNameForRoot(configPath, rootPath) !== undefined;
  }
  return false;
}

function executableOnPath(command: string, pathValue: string): boolean {
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((value) => value.toLowerCase())]
    : [""];
  return pathValue.split(path.delimiter).filter(Boolean).some((directory) => extensions.some((extension) => {
    const filePath = path.join(directory, `${command}${extension}`);
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

function hasMcpServer(filePath: string, key: "servers" | "mcpServers"): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return Boolean(isRecord(parsed) && isRecord(parsed[key]) && "kairn" in parsed[key] && isKairnOwnedMcpServer(parsed[key].kairn));
  } catch {
    return false;
  }
}

function hasKairnText(filePath: string): boolean {
  return fs.existsSync(filePath) && /kairn|KAIRN_CMD/i.test(fs.readFileSync(filePath, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
