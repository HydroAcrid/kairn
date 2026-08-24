// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { DiagnosticExport, TelemetryStatus } from "../types.js";
import { getTelemetryStatus } from "./config.js";
import { buildTelemetryPayload } from "./payload.js";
import { buildBetaReport } from "./report.js";

export function buildDiagnosticExport(input: {
  runtime: KairnRuntime;
  rootPath: string;
  installationId: string;
  repoSalt: string;
  doctor?: unknown;
}): DiagnosticExport {
  const rootPath = path.resolve(input.rootPath);
  const payloadPreview = buildTelemetryPayload({
    runtime: input.runtime,
    installationId: input.installationId,
    repoSalt: input.repoSalt
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: {
      redacted: true
    },
    telemetry: redactTelemetryStatus(getTelemetryStatus(rootPath)),
    ...(input.doctor ? { doctor: redactDiagnosticValue(input.doctor, rootPath) } : {}),
    betaReport: buildBetaReport({ runtime: input.runtime }),
    payloadPreview
  };
}

function redactTelemetryStatus(status: TelemetryStatus): TelemetryStatus {
  return {
    ...status,
    queuePath: "<redacted>/.kairn/telemetry-queue.jsonl",
    configPath: "<redacted>/.kairn/config.json"
  };
}

export function writeDiagnosticExport(input: {
  outPath: string;
  exportData: DiagnosticExport;
}): void {
  fs.mkdirSync(path.dirname(path.resolve(input.outPath)), { recursive: true });
  fs.writeFileSync(input.outPath, `${JSON.stringify(input.exportData, null, 2)}\n`);
}

function redactDiagnosticValue(value: unknown, rootPath: string): unknown {
  if (typeof value === "string") return redactDiagnosticString(value, rootPath);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, rootPath));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDiagnosticValue(item, rootPath)])
    );
  }
  return value;
}

function redactDiagnosticString(value: string, rootPath: string): string {
  let output = value;
  const markers: Array<readonly [string, string]> = [
    ...rootRedactionAliases(rootPath).map((alias) => [alias, "<redacted-root>"] as const),
    [os.homedir(), "<redacted-home>"],
    [os.homedir().replaceAll("\\", "/"), "<redacted-home>"]
  ];
  for (const [marker, replacement] of markers.sort((left, right) => right[0].length - left[0].length)) {
    if (marker.length > 3) output = output.split(marker).join(replacement);
  }
  return output
    .replace(/(^|[\s"'`])\/[^\s"'`]+/g, "$1<redacted-path>")
    .replace(/[A-Za-z]:\\[^\r\n"'`]+/g, "<redacted-path>");
}

function rootRedactionAliases(rootPath: string): string[] {
  const aliases = new Set<string>([rootPath, rootPath.replaceAll("\\", "/")]);
  try {
    const realPath = fs.realpathSync.native(rootPath);
    aliases.add(realPath);
    aliases.add(realPath.replaceAll("\\", "/"));
  } catch {
    // Best-effort redaction still covers the resolved path and generic absolute paths.
  }
  for (const alias of [...aliases]) {
    if (alias.startsWith("/private/")) aliases.add(alias.slice("/private".length));
    if (alias.startsWith("/var/")) aliases.add(`/private${alias}`);
  }
  return [...aliases];
}
