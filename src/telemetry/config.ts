// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureKairnDir, getKairnPaths } from "../config/paths.js";
import type { TelemetryConfig, TelemetryDestination, TelemetryStatus } from "../types.js";

export const DEFAULT_SUPABASE_TELEMETRY_ENDPOINT = "https://umefcjkwnphqzxkjwpgx.functions.supabase.co/kairn-telemetry-ingest";

export function telemetryPaths(rootPath: string) {
  const paths = getKairnPaths(rootPath);
  return {
    ...paths,
    queuePath: path.join(paths.kairnDir, "telemetry-queue.jsonl")
  };
}

export function loadTelemetryConfig(rootPath: string): TelemetryConfig {
  const paths = getKairnPaths(rootPath);
  const config = readKairnConfig(paths.configPath);
  const telemetry = recordValue(config.telemetry);
  return {
    enabled: telemetry.enabled === true,
    ...(telemetry.destination === "supabase" ? { destination: "supabase" as const } : {}),
    ...(typeof telemetry.endpoint === "string" ? { endpoint: telemetry.endpoint } : {}),
    ...(typeof telemetry.installationId === "string" ? { installationId: telemetry.installationId } : {}),
    ...(typeof telemetry.repoSalt === "string" ? { repoSalt: telemetry.repoSalt } : {}),
    ...(typeof telemetry.updatedAt === "string" ? { updatedAt: telemetry.updatedAt } : {})
  };
}

export function writeTelemetryConfig(rootPath: string, input: Partial<TelemetryConfig>): TelemetryConfig {
  const paths = ensureKairnDir(rootPath);
  const config = readKairnConfig(paths.configPath);
  const current = loadTelemetryConfig(rootPath);
  const next: TelemetryConfig = {
    ...current,
    ...input,
    updatedAt: new Date().toISOString()
  };
  const nextConfig = {
    ...config,
    telemetry: next
  };
  fs.writeFileSync(paths.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return next;
}

export function enableTelemetry(input: {
  rootPath: string;
  destination: TelemetryDestination;
  endpoint?: string | undefined;
}): TelemetryConfig {
  const current = loadTelemetryConfig(input.rootPath);
  return writeTelemetryConfig(input.rootPath, {
    enabled: true,
    destination: input.destination,
    endpoint: input.endpoint ?? process.env.KAIRN_TELEMETRY_ENDPOINT ?? current.endpoint ?? DEFAULT_SUPABASE_TELEMETRY_ENDPOINT,
    installationId: current.installationId ?? `kairn_${crypto.randomUUID()}`,
    repoSalt: current.repoSalt ?? crypto.randomBytes(32).toString("hex")
  });
}

export function disableTelemetry(rootPath: string): TelemetryConfig {
  return writeTelemetryConfig(rootPath, { enabled: false });
}

export function ensureTelemetryIdentity(rootPath: string): Required<Pick<TelemetryConfig, "installationId" | "repoSalt">> & TelemetryConfig {
  const current = loadTelemetryConfig(rootPath);
  if (current.installationId && current.repoSalt) {
    return current as Required<Pick<TelemetryConfig, "installationId" | "repoSalt">> & TelemetryConfig;
  }
  const next = writeTelemetryConfig(rootPath, {
    installationId: current.installationId ?? `kairn_${crypto.randomUUID()}`,
    repoSalt: current.repoSalt ?? crypto.randomBytes(32).toString("hex")
  });
  return next as Required<Pick<TelemetryConfig, "installationId" | "repoSalt">> & TelemetryConfig;
}

export function getTelemetryStatus(rootPath: string): TelemetryStatus {
  const paths = telemetryPaths(rootPath);
  const config = loadTelemetryConfig(rootPath);
  return {
    enabled: config.enabled,
    ...(config.destination ? { destination: config.destination } : {}),
    endpointConfigured: Boolean(config.endpoint || process.env.KAIRN_TELEMETRY_ENDPOINT),
    ...(config.installationId ? { installationId: config.installationId } : {}),
    queueLength: countQueueEntries(paths.queuePath),
    queuePath: paths.queuePath,
    configPath: paths.configPath
  };
}

function readKairnConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return recordValue(parsed);
  } catch {
    return {};
  }
}

function countQueueEntries(queuePath: string): number {
  if (!fs.existsSync(queuePath)) return 0;
  return fs.readFileSync(queuePath, "utf8").split("\n").filter((line) => line.trim()).length;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
