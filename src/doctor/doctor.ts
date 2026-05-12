import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getKairnPaths } from "../config/paths.js";
import { loadTelemetryConfig } from "../telemetry/config.js";
import type { KairnRuntime } from "../runtime/KairnRuntime.js";

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

export function runDoctor(input: {
  rootPath: string;
  runtime: KairnRuntime;
  codexCommand?: string | undefined;
}): DoctorReport {
  const rootPath = path.resolve(input.rootPath);
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkKairnCommand(),
    checkKairnState(rootPath),
    checkIndex(input.runtime),
    checkCodex(input.codexCommand ?? process.env.KAIRN_CODEX_CMD ?? "codex"),
    checkCodexHooks(rootPath, input.runtime),
    checkMcpConfig(rootPath),
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

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    id: "node_version",
    status: major >= 20 ? "ok" : "fail",
    summary: `Node ${process.versions.node}`,
    fix: major >= 20 ? undefined : "Install Node 20 or newer."
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
    return {
      id: "index_state",
      status: status.totalSizeBytes <= status.hardMaxStateBytes ? "ok" : "fail",
      summary: `Index has ${status.fileCount} files and uses ${stateMb}MB.`,
      fix: status.totalSizeBytes <= status.hardMaxStateBytes ? undefined : "Run kairn index compact --root <repo>.",
      metadata: { stateMb, softMb, graphEdges: status.graphEdgeCount, semanticChunks: status.semanticChunkCount }
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
  const result = spawnSync(`${command} --version`, { encoding: "utf8", shell: true });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    id: "codex_binary",
    status: result.status === 0 ? "ok" : "warn",
    summary: result.status === 0 ? `Codex available: ${output || command}` : `Codex command not verified: ${command}`,
    fix: result.status === 0 ? undefined : "Install Codex CLI or set KAIRN_CODEX_CMD to the correct command."
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

function checkMcpConfig(rootPath: string): DoctorCheck {
  const configPath = path.join(rootPath, ".codex", "config.toml");
  const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const codexConfigured = config.includes("[mcp_servers.kairn]");
  const vscodeConfigPath = path.join(rootPath, ".vscode", "mcp.json");
  const vscodeConfigured = hasVscodeMcpServer(vscodeConfigPath);
  const configured = codexConfigured || vscodeConfigured;
  return {
    id: "mcp_config",
    status: configured ? "ok" : "warn",
    summary: configured
      ? `Kairn MCP server is configured${codexConfigured && vscodeConfigured ? " for Codex and VS Code" : codexConfigured ? " for Codex" : " for VS Code"}.`
      : "Kairn MCP server is not configured.",
    fix: configured ? undefined : "Run kairn setup mcp --client vscode --root <repo> or kairn setup codex --mode mcp-first --root <repo>.",
    metadata: {
      codexConfigured,
      vscodeConfigured
    }
  };
}

function hasVscodeMcpServer(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "servers" in parsed &&
        parsed.servers &&
        typeof parsed.servers === "object" &&
        !Array.isArray(parsed.servers) &&
        "kairn" in parsed.servers
    );
  } catch {
    return false;
  }
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
