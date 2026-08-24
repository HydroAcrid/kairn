// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import crypto from "node:crypto";
import { ensureKairnDir } from "../config/paths.js";
import type { TelemetryFlushResult, TelemetryPayload, TelemetryQueueEntry } from "../types.js";
import { getTelemetryStatus, loadTelemetryConfig, telemetryPaths } from "./config.js";
import { assertSafeTelemetryPayload } from "./sanitize.js";

export function enqueueTelemetryPayload(input: {
  rootPath: string;
  payload: TelemetryPayload;
}): TelemetryQueueEntry {
  assertSafeTelemetryPayload(input.payload);
  ensureKairnDir(input.rootPath);
  const paths = telemetryPaths(input.rootPath);
  const entry: TelemetryQueueEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    payload: input.payload,
    attempts: 0
  };
  fs.appendFileSync(paths.queuePath, `${JSON.stringify(entry)}\n`);
  return entry;
}

export function readTelemetryQueue(rootPath: string): TelemetryQueueEntry[] {
  const { queuePath } = telemetryPaths(rootPath);
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryQueueEntry);
}

export function writeTelemetryQueue(rootPath: string, entries: TelemetryQueueEntry[]): void {
  ensureKairnDir(rootPath);
  const { queuePath } = telemetryPaths(rootPath);
  fs.writeFileSync(queuePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
}

export async function flushTelemetryQueue(input: {
  rootPath: string;
  dryRun?: boolean | undefined;
  endpoint?: string | undefined;
}): Promise<TelemetryFlushResult> {
  const config = loadTelemetryConfig(input.rootPath);
  const entries = readTelemetryQueue(input.rootPath);
  const endpoint = input.endpoint ?? config.endpoint ?? process.env.KAIRN_TELEMETRY_ENDPOINT;
  if (!config.enabled) {
    return {
      enabled: false,
      dryRun: Boolean(input.dryRun),
      ...(endpoint ? { endpoint } : {}),
      attempted: 0,
      sent: 0,
      retained: entries.length,
      failures: ["Telemetry is disabled."]
    };
  }
  if (input.dryRun) {
    return {
      enabled: true,
      dryRun: true,
      ...(endpoint ? { endpoint } : {}),
      attempted: entries.length,
      sent: 0,
      retained: entries.length,
      failures: []
    };
  }
  if (!endpoint) {
    return {
      enabled: true,
      dryRun: false,
      attempted: 0,
      sent: 0,
      retained: entries.length,
      failures: ["No telemetry endpoint configured. Set KAIRN_TELEMETRY_ENDPOINT or enable with an endpoint."]
    };
  }

  const retained: TelemetryQueueEntry[] = [];
  const failures: string[] = [];
  let sent = 0;
  for (const entry of entries) {
    try {
      assertSafeTelemetryPayload(entry.payload);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kairn-telemetry-schema": "1"
        },
        body: JSON.stringify(entry.payload)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      sent += 1;
    } catch (error) {
      retained.push({
        ...entry,
        attempts: entry.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error)
      });
      failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  writeTelemetryQueue(input.rootPath, retained);
  return {
    enabled: getTelemetryStatus(input.rootPath).enabled,
    dryRun: false,
    endpoint,
    attempted: entries.length,
    sent,
    retained: retained.length,
    failures
  };
}
