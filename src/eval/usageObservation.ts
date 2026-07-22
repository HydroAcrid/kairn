// SPDX-License-Identifier: Apache-2.0

import type { CodexUsageRecord, EvalObservationRecord } from "../types.js";

export function codexUsageFromObservation(observation: EvalObservationRecord | undefined): CodexUsageRecord | undefined {
  const value = observation?.metrics.codexUsage;
  if (!isRecord(value)) return undefined;
  const totalTokens = numberField(value.totalTokens);
  const inputTokens = numberField(value.inputTokens);
  const cachedInputTokens = numberField(value.cachedInputTokens);
  const outputTokens = numberField(value.outputTokens);
  const source = stringField(value.source);
  if (
    totalTokens === undefined ||
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    (source !== "footer" && source !== "transcript" && source !== "footer+transcript")
  ) {
    return undefined;
  }
  const model = stringField(value.model);
  const hostSessionId = stringField(value.hostSessionId);
  const turnId = stringField(value.turnId);
  const transcriptPath = stringField(value.transcriptPath);
  const transcriptHash = stringField(value.transcriptHash);

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(model ? { model } : {}),
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(transcriptHash ? { transcriptHash } : {}),
    source
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
