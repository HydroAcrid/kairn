// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import path from "node:path";
import type { MetricsSummary, TelemetryPayload, TaskSession } from "../types.js";

export function assertSafeTelemetryPayload(payload: TelemetryPayload): void {
  scanUnsafeStrings(payload, []);
}

export function hashFileId(input: {
  repoSalt: string;
  filePath: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(`${input.repoSalt}:${normalizeFileSignal(input.filePath)}`)
    .digest("hex")
    .slice(0, 24);
}

export function fileExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext || "none";
}

export function fileRole(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/(^|\/)(docs?|documentation|examples?|demo|demos|website|site)(\/|$)/.test(normalized)) return "docs";
  if (/(^|\/)(generated|dist|build|coverage|vendor)(\/|$)/.test(normalized)) return "generated";
  if (/(^|\/)(tests?|testing|__tests__|spec|specs)(\/|$)/.test(normalized) || /\.(test|spec)\./.test(basename)) return "test";
  return "source";
}

export function repoFileCountBucket(count: number): string {
  if (count < 250) return "lt_250";
  if (count < 1000) return "250_999";
  if (count < 5000) return "1000_4999";
  if (count < 20000) return "5000_19999";
  return "gte_20000";
}

export function stateSizeBucket(bytes: number | undefined): string {
  const mb = (bytes ?? 0) / (1024 * 1024);
  if (mb < 25) return "lt_25mb";
  if (mb < 100) return "25_99mb";
  if (mb < 250) return "100_249mb";
  if (mb < 1000) return "250_999mb";
  return "gte_1000mb";
}

export function summarizeLanguageMix(metrics: MetricsSummary): Record<string, number> {
  const languages = new Map<string, number>();
  for (const event of metrics.recentEvents) {
    for (const file of event.files) {
      const extension = fileExtension(file);
      languages.set(extension, (languages.get(extension) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...languages.entries()].sort());
}

export function summarizeFileSignals(input: {
  repoSalt: string;
  sessions: TaskSession[];
  metrics: MetricsSummary[];
}): {
  hashedFileIds: string[];
  extensionCounts: Record<string, number>;
  roleCounts: Record<string, number>;
} {
  const paths = new Set<string>();
  for (const session of input.sessions) {
    for (const shown of session.filesShown) if (shown.filePath) paths.add(shown.filePath);
    for (const event of session.watchEvents) for (const file of event.files) paths.add(file);
  }
  for (const metrics of input.metrics) {
    for (const event of metrics.recentEvents) for (const file of event.files) paths.add(file);
    for (const file of metrics.coordination.hookFiles) paths.add(file);
    for (const file of metrics.coordination.mcpFiles) paths.add(file);
  }
  const extensionCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  const hashedFileIds: string[] = [];
  for (const file of [...paths].sort()) {
    hashedFileIds.push(hashFileId({ repoSalt: input.repoSalt, filePath: file }));
    const ext = fileExtension(file);
    const role = fileRole(file);
    extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  return {
    hashedFileIds: hashedFileIds.slice(0, 200),
    extensionCounts: Object.fromEntries([...extensionCounts.entries()].sort()),
    roleCounts: Object.fromEntries([...roleCounts.entries()].sort())
  };
}

function scanUnsafeStrings(value: unknown, pathParts: string[]): void {
  if (typeof value === "string") {
    if (isUnsafeTelemetryString(value)) {
      throw new Error(`Unsafe telemetry string at ${pathParts.join(".") || "<root>"}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnsafeStrings(item, [...pathParts, String(index)]));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (isUnsafeTelemetryString(key)) {
        throw new Error(`Unsafe telemetry field name at ${[...pathParts, key].join(".")}`);
      }
      if (/prompt|output|diff|source|path|filename|repoUrl|repository|branch|user|cwd/i.test(key)) {
        if (typeof item === "string" || Array.isArray(item)) {
          throw new Error(`Unsafe telemetry field name at ${[...pathParts, key].join(".")}`);
        }
      }
      scanUnsafeStrings(item, [...pathParts, key]);
    }
  }
}

function isUnsafeTelemetryString(value: string): boolean {
  if (value.length > 240) return true;
  if (value.includes("\n")) return true;
  if (/https?:\/\/|git@|github\.com[:/]|\.git\b/i.test(value)) return true;
  if (/(^|[\s'"])(?:\/Users\/|\/home\/|[A-Za-z]:\\|\.\/|\.\.\/)/.test(value)) return true;
  if (/\b(?:function|class|import|export|const|let|var|def|public|private|package|#include)\b.*[;{]/.test(value)) return true;
  return false;
}

function normalizeFileSignal(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();
}
