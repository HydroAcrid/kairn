import fs from "node:fs";
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
    telemetry: redactTelemetryStatus(getTelemetryStatus(input.rootPath)),
    ...(input.doctor ? { doctor: input.doctor } : {}),
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
  fs.writeFileSync(input.outPath, `${JSON.stringify(input.exportData, null, 2)}\n`);
}
