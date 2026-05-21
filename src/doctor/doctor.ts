import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getKairnPaths } from "../config/paths.js";
import { loadTelemetryConfig } from "../telemetry/config.js";
import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import { commandInvocation, commandSpawnInvocation } from "../utils/command.js";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  summary: string;
  fix?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type DoctorReport = {
  generatedAt: string;
  rootPath: string;
  status: DoctorCheckStatus;
  checks: DoctorCheck[];
};

export type DoctorTarget = "all" | "codex" | "claude-code" | "copilot-cli" | "gemini-cli" | "vscode" | "generic";

export function runDoctor(input: {
  rootPath: string;
  runtime: KairnRuntime;
  codexCommand?: string | undefined;
  target?: DoctorTarget | undefined;
}): DoctorReport {
  const rootPath = path.resolve(input.rootPath);
  const target = input.target ?? "all";
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkKairnCommand(),
    checkKairnState(rootPath),
    checkIndex(input.runtime),
    checkWindowsFriction(rootPath),
    ...targetedChecks({ rootPath, runtime: input.runtime, target, codexCommand: input.codexCommand ?? process.env.KAIRN_CODEX_CMD ?? "codex" }),
    checkDaemon(rootPath),
    checkTelemetry(rootPath)
  ];
  return {
    generatedAt: new Date().toISOString(),
    rootPath,
    status: rollupStatus(checks),
    checks
  };
}

function targetedChecks(input: {
  rootPath: string;
  runtime: KairnRuntime;
  target: DoctorTarget;
  codexCommand: string;
}): DoctorCheck[] {
  if (input.target === "codex") {
    return [
      checkCodex(input.codexCommand),
      checkCodexHooks(input.rootPath, input.runtime),
      checkMcpConfig(input.rootPath, "codex")
    ];
  }
  if (input.target === "claude-code") {
    return [checkBinary("claude", "claude_binary", "Claude Code"), checkMcpConfig(input.rootPath, "claude-code"), checkClaudeHooks(input.rootPath)];
  }
  if (input.target === "copilot-cli") {
    return [checkBinary("copilot", "copilot_binary", "Copilot CLI"), checkMcpConfig(input.rootPath, "copilot-cli")];
  }
  if (input.target === "gemini-cli") {
    return [checkBinary("gemini", "gemini_binary", "Gemini CLI"), checkMcpConfig(input.rootPath, "gemini-cli")];
  }
  if (input.target === "vscode") {
    return [checkMcpConfig(input.rootPath, "vscode")];
  }
  if (input.target === "generic") {
    return [checkMcpConfig(input.rootPath, "generic")];
  }
  return [
    checkCodex(input.codexCommand),
    checkCodexHooks(input.rootPath, input.runtime),
    checkMcpConfig(input.rootPath)
  ];
}

function checkNodeVersion(): DoctorCheck {
  const { supported } = currentNodeSupport();
  return {
    id: "node_version",
    status: supported ? "ok" : "fail",
    summary: `Node ${process.versions.node}`,
    fix: supported ? undefined : "Install Node 20.19 or newer, below Node 26. Node 22 or 24 LTS is recommended for beta."
  };
}

function checkWindowsFriction(rootPath: string): DoctorCheck {
  if (process.platform !== "win32") {
    return {
      id: "platform_friction",
      status: "ok",
      summary: "No Windows-specific setup friction detected."
    };
  }
  const warnings: string[] = [];
  const { major, supported } = currentNodeSupport();
  if (!supported) warnings.push(`Node ${process.versions.node} is outside Kairn's supported beta range.`);
  if (supported && ![22, 24].includes(major)) warnings.push(`Node ${process.versions.node} is supported, but Node 22 or 24 LTS is recommended for beta.`);
  if (/OneDrive/i.test(rootPath)) warnings.push("Repo is under OneDrive, which can slow or lock local index files.");
  if (/[&|;<>()]/.test(rootPath)) warnings.push("Repo path contains shell metacharacters; quote paths in PowerShell/CMD.");
  return {
    id: "platform_friction",
    status: warnings.length > 0 ? "warn" : "ok",
    summary: warnings.length > 0 ? warnings.join(" ") : "Windows setup path looks normal.",
    fix: warnings.length > 0 ? "Use quoted paths, prefer Node 22 or 24 LTS for beta, and use WSL if native Windows indexing remains unstable." : undefined
  };
}

function currentNodeSupport(): { major: number; minor: number; supported: boolean } {
  const [majorRaw, minorRaw] = process.versions.node.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  return {
    major,
    minor,
    supported: Number.isFinite(major) && Number.isFinite(minor) && major < 26 && (major > 20 || (major === 20 && minor >= 19))
  };
}

function checkKairnCommand(): DoctorCheck {
  const command = process.env.KAIRN_CMD || process.argv[1] || "kairn";
  return {
    id: "kairn_command",
    status: command ? "ok" : "warn",
    summary: process.env.KAIRN_CMD ? `KAIRN_CMD is set.` : `Kairn entrypoint: ${command}`,
    fix: process.env.KAIRN_CMD ? undefined : "Set KAIRN_CMD only when hooks need a specific local development command."
  };
}

function checkKairnState(rootPath: string): DoctorCheck {
  const paths = getKairnPaths(rootPath);
  try {
    fs.mkdirSync(paths.kairnDir, { recursive: true });
    fs.accessSync(paths.kairnDir, fs.constants.W_OK);
    return {
      id: "kairn_state",
      status: "ok",
      summary: ".kairn state is writable."
    };
  } catch (error) {
    return {
      id: "kairn_state",
      status: "fail",
      summary: ".kairn state is not writable.",
      fix: `Check permissions for ${paths.kairnDir}.`,
      metadata: { error: error instanceof Error ? error.message : String(error) }
    };
  }
}

function checkIndex(runtime: KairnRuntime): DoctorCheck {
  try {
    const status = runtime.getIndexStatus();
    const stateMb = Math.round((status.totalSizeBytes / (1024 * 1024)) * 10) / 10;
    const softMb = Math.round((status.maxStateBytes / (1024 * 1024)) * 10) / 10;
    const stale = status.freshness?.stale === true;
    const overLimit = status.totalSizeBytes > status.hardMaxStateBytes;
    return {
      id: "index_state",
      status: overLimit ? "fail" : stale ? "warn" : "ok",
      summary: `Index has ${status.fileCount} files, uses ${stateMb}MB, and is ${stale ? `stale (${status.freshness?.reason})` : "fresh"}.`,
      fix: overLimit ? "Run kairn index compact --root <repo>." : stale ? "Run kairn index refresh --root <repo>." : undefined,
      metadata: { stateMb, softMb, graphEdges: status.graphEdgeCount, semanticChunks: status.semanticChunkCount, freshness: status.freshness }
    };
  } catch (error) {
    return {
      id: "index_state",
      status: "warn",
      summary: "Index status is unavailable; run kairn init.",
      fix: "Run kairn init --root <repo>.",
      metadata: { error: error instanceof Error ? error.message : String(error) }
    };
  }
}

function checkCodex(command: string): DoctorCheck {
  const invocation = commandSpawnInvocation(commandInvocation(command, ["--version"]));
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: invocation.env ? { ...process.env, ...invocation.env } : undefined
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    id: "codex_binary",
    status: result.status === 0 ? "ok" : "warn",
    summary: result.status === 0 ? `Codex available: ${output || command}` : `Codex command not verified: ${command}`,
    fix: result.status === 0 ? undefined : "Install Codex CLI or set KAIRN_CODEX_CMD to the correct command."
  };
}

function checkBinary(command: string, id: string, label: string): DoctorCheck {
  const invocation = commandSpawnInvocation(commandInvocation(command, ["--version"]));
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: invocation.env ? { ...process.env, ...invocation.env } : undefined
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    id,
    status: result.status === 0 ? "ok" : "warn",
    summary: result.status === 0 ? `${label} available: ${output || command}` : `${label} command not verified: ${command}`,
    fix: result.status === 0 ? undefined : `Install ${label} or configure Kairn using generic MCP JSON.`
  };
}

function checkCodexHooks(rootPath: string, runtime: KairnRuntime): DoctorCheck {
  const configPath = path.join(rootPath, ".codex", "config.toml");
  const hooksPath = path.join(rootPath, ".codex", "hooks.json");
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const hooks = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, "utf8") : "";
  if (!config && !hooks) {
    return {
      id: "codex_hooks",
      status: "warn",
      summary: "Codex hooks are not installed.",
      fix: "Run kairn setup codex --mode savings --root <repo> or use kairn codex."
    };
  }
  if (/\bcodex_hooks\s*=/.test(config)) {
    return {
      id: "codex_hooks",
      status: "warn",
      summary: "Codex config uses deprecated codex_hooks feature flag.",
      fix: "Run kairn setup codex --mode savings --root <repo>."
    };
  }
  if (!/\bhooks\s*=\s*true\b/.test(config)) {
    return {
      id: "codex_hooks",
      status: "warn",
      summary: "Codex hooks feature flag is not enabled.",
      fix: "Enable [features].hooks or run kairn setup codex --mode savings --root <repo>."
    };
  }
  try {
    const parsed = hooks ? JSON.parse(hooks) as { hooks?: Record<string, unknown> } : {};
    const promptHook = parsed.hooks?.UserPromptSubmit;
    const sessionIds = [...hooks.matchAll(/--session\s+['"]?([^'"\s]+)/g)].map((match) => match[1]);
    const badSession = sessionIds.find((sessionId) => sessionId && !sessionExists(runtime, sessionId));
    if (badSession) {
      return {
        id: "codex_hooks",
        status: "warn",
        summary: `Codex hooks reference missing Kairn session ${badSession}.`,
        fix: "Launch a fresh session with kairn codex or rerun kairn setup codex without --session."
      };
    }
    return {
      id: "codex_hooks",
      status: promptHook ? "ok" : "warn",
      summary: promptHook ? "Codex UserPromptSubmit hook is configured." : "Codex hooks file exists but prompt hook is missing.",
      fix: promptHook ? undefined : "Run kairn setup codex --mode savings --root <repo>."
    };
  } catch (error) {
    return {
      id: "codex_hooks",
      status: "fail",
      summary: "Codex hooks.json is invalid JSON.",
      fix: "Run kairn setup codex --mode savings --root <repo>.",
      metadata: { error: error instanceof Error ? error.message : String(error) }
    };
  }
}

function checkMcpConfig(rootPath: string, target: DoctorTarget = "all"): DoctorCheck {
  const configPath = path.join(rootPath, ".codex", "config.toml");
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const codexConfigured = config.includes("[mcp_servers.kairn]");
  const vscodeConfigPath = path.join(rootPath, ".vscode", "mcp.json");
  const vscodeConfigured = hasMcpServer(vscodeConfigPath, "servers");
  const claudeConfigured = hasMcpServer(path.join(rootPath, ".mcp.json"), "mcpServers");
  const geminiConfigured = hasMcpServer(path.join(rootPath, ".gemini", "settings.json"), "mcpServers");
  const copilotConfigured = hasCopilotMcpServer(rootPath);
  const byTarget: Record<DoctorTarget, boolean> = {
    all: codexConfigured || vscodeConfigured || claudeConfigured || geminiConfigured || copilotConfigured,
    codex: codexConfigured,
    "claude-code": claudeConfigured,
    "copilot-cli": copilotConfigured,
    "gemini-cli": geminiConfigured,
    vscode: vscodeConfigured,
    generic: false
  };
  const configured = byTarget[target];
  return {
    id: "mcp_config",
    status: configured ? "ok" : "warn",
    summary: configured
      ? `Kairn MCP server is configured for: ${configuredMcpTargets({ codexConfigured, vscodeConfigured, claudeConfigured, geminiConfigured, copilotConfigured }).join(", ")}.`
      : target === "generic" ? "Generic MCP config is not persisted; run an MCP smoke test with the generated client config." : "Kairn MCP server is not configured for this target.",
    fix: configured ? undefined : target === "generic"
      ? "Run kairn setup mcp --client generic --root <repo> --json, copy the config, then run kairn bench mcp-smoke."
      : `Run kairn setup mcp --client ${target === "all" || target === "codex" ? "vscode" : target} --root <repo>.`,
    metadata: {
      codexConfigured,
      vscodeConfigured,
      claudeConfigured,
      geminiConfigured,
      copilotConfigured
    }
  };
}

function hasMcpServer(filePath: string, key: "servers" | "mcpServers"): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) return false;
    const servers = parsed[key];
    return Boolean(isRecord(servers) && "kairn" in servers);
  } catch {
    return false;
  }
}

function hasCopilotMcpServer(rootPath: string): boolean {
  const filePath = path.join(os.homedir(), ".copilot", "mcp-config.json");
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.includes(rootPath)) return false;
    const parsed = JSON.parse(raw) as unknown;
    return Boolean(isRecord(parsed) && isRecord(parsed.mcpServers) && "kairn" in parsed.mcpServers);
  } catch {
    return false;
  }
}

function checkClaudeHooks(rootPath: string): DoctorCheck {
  const filePath = path.join(rootPath, ".claude", "settings.local.json");
  if (!fs.existsSync(filePath)) {
    return {
      id: "claude_hooks",
      status: "warn",
      summary: "Claude Code hooks are not installed.",
      fix: "Use Claude MCP by default, or run kairn setup claude --root <repo> for advanced hooks."
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const configured = Boolean(isRecord(parsed) && isRecord(parsed.hooks) && Object.values(parsed.hooks).some(containsKairnCommand));
    return {
      id: "claude_hooks",
      status: configured ? "ok" : "warn",
      summary: configured ? "Claude Code Kairn hooks are configured." : "Claude settings exist but Kairn hooks are missing.",
      fix: configured ? undefined : "Run kairn setup claude --root <repo>."
    };
  } catch {
    return {
      id: "claude_hooks",
      status: "fail",
      summary: "Claude settings.local.json is invalid JSON.",
      fix: "Fix .claude/settings.local.json or remove it and rerun kairn setup claude."
    };
  }
}

function configuredMcpTargets(input: {
  codexConfigured: boolean;
  vscodeConfigured: boolean;
  claudeConfigured: boolean;
  geminiConfigured: boolean;
  copilotConfigured: boolean;
}): string[] {
  return [
    input.codexConfigured ? "codex" : "",
    input.vscodeConfigured ? "vscode" : "",
    input.claudeConfigured ? "claude-code" : "",
    input.geminiConfigured ? "gemini-cli" : "",
    input.copilotConfigured ? "copilot-cli" : ""
  ].filter(Boolean);
}

function checkDaemon(rootPath: string): DoctorCheck {
  const marker = path.join(rootPath, ".kairn", "daemon.json");
  return {
    id: "daemon",
    status: fs.existsSync(marker) ? "ok" : "warn",
    summary: fs.existsSync(marker) ? "Daemon marker exists." : "No warm daemon marker found.",
    fix: "Run kairn daemon --root <repo> in another terminal for lowest hook latency."
  };
}

function checkTelemetry(rootPath: string): DoctorCheck {
  const config = loadTelemetryConfig(rootPath);
  return {
    id: "telemetry",
    status: config.enabled ? "ok" : "warn",
    summary: config.enabled ? "Telemetry is enabled." : "Telemetry is disabled.",
    fix: config.enabled ? undefined : "Run kairn telemetry enable --destination supabase to opt in."
  };
}

function sessionExists(runtime: KairnRuntime, sessionId: string): boolean {
  try {
    runtime.getSession(sessionId);
    return true;
  } catch {
    return false;
  }
}

function rollupStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}

function containsKairnCommand(value: unknown): boolean {
  if (typeof value === "string") return /kairn|KAIRN_CMD/i.test(value);
  if (Array.isArray(value)) return value.some(containsKairnCommand);
  if (isRecord(value)) return Object.values(value).some(containsKairnCommand);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
