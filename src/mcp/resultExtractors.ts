import { estimateTokens } from "../utils/tokens.js";
import { uniquePaths } from "../utils/collections.js";
import type { ContextResponseMode } from "../types.js";

export function sessionIdFromMcpValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId === "string") return record.sessionId;
  const session = record.session;
  if (session && typeof session === "object" && typeof (session as Record<string, unknown>).id === "string") {
    return (session as Record<string, string>).id;
  }
  return undefined;
}

export function filesFromMcpValue(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const attributedFiles = attributedFilesFromMcpValue(value);
  if (record.contextSuppressed === true) {
    return attributedFiles;
  }
  const fields = [record.files, record.related, record.suggestedNextContext, record.failureFiles, record.testFiles, attributedFiles];
  return uniquePaths(
    fields.flatMap((field) => Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [])
  );
}

export function attributedFilesFromMcpValue(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const attributedFiles = (value as Record<string, unknown>).attributedFiles;
  return Array.isArray(attributedFiles)
    ? uniquePaths(attributedFiles.filter((item): item is string => typeof item === "string"))
    : [];
}

export function tokenEstimateFromMcpValue(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.tokenEstimate === "number") return Math.max(0, Math.round(record.tokenEstimate));
  if (typeof record.content === "string") return estimateTokens(record.content);
  return 0;
}

const RESPONSE_MODES = new Set<ContextResponseMode>([
  "brief",
  "exact_code",
  "compressed_summary",
  "snippets",
  "graph_neighbors",
  "failure_context",
  "verification_plan"
]);

export function responseModeFromMcpValue(value: unknown): ContextResponseMode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mode = (value as Record<string, unknown>).mode;
  return typeof mode === "string" && RESPONSE_MODES.has(mode as ContextResponseMode)
    ? mode as ContextResponseMode
    : undefined;
}
