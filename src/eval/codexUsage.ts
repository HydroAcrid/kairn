import fs from "node:fs";
import type { CodexUsageRecord } from "../types.js";
import { sha256 } from "../utils/hash.js";

type TranscriptMetadata = {
  model?: string;
  hostSessionId?: string;
  turnId?: string;
};

export type CodexTranscriptFeedback = {
  filesRead: string[];
  filesEdited: string[];
  commands: string[];
  testsRun: string[];
  outcome?: "pass" | "fail" | "partial";
};

export function parseCodexUsageFooter(input: string): Omit<CodexUsageRecord, "source"> | undefined {
  const normalized = input.replace(/\s+/g, " ").trim();
  const match = normalized.match(
    /Token usage:\s*total=([\d,]+)\s+input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s+cached\))?\s+output=([\d,]+)/i
  );
  if (!match) {
    const totalOnlyMatch = normalized.match(/\btokens used\s+([\d,]+)/i);
    if (!totalOnlyMatch) return undefined;
    return {
      totalTokens: parseTokenNumber(totalOnlyMatch[1]),
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0
    };
  }

  return {
    totalTokens: parseTokenNumber(match[1]),
    inputTokens: parseTokenNumber(match[2]),
    cachedInputTokens: parseTokenNumber(match[3] ?? "0"),
    outputTokens: parseTokenNumber(match[4])
  };
}

export function readCodexTranscript(input: {
  transcriptPath: string;
}): {
  usage?: Omit<CodexUsageRecord, "source">;
  metadata: TranscriptMetadata;
  feedback: CodexTranscriptFeedback;
  transcriptPath: string;
  transcriptHash: string;
} {
  const content = fs.readFileSync(input.transcriptPath, "utf8");
  const metadata = extractTranscriptMetadata(content);
  const usage = parseCodexUsageFooter(content) ?? extractUsageFromJsonl(content);
  const feedback = extractTranscriptFeedback(content);

  return {
    ...(usage ? { usage } : {}),
    metadata,
    feedback,
    transcriptPath: input.transcriptPath,
    transcriptHash: sha256(content)
  };
}

export function mergeCodexUsage(input: {
  footerUsage?: Omit<CodexUsageRecord, "source"> | undefined;
  transcriptUsage?: Omit<CodexUsageRecord, "source"> | undefined;
  transcriptMetadata?: TranscriptMetadata | undefined;
  transcriptPath?: string | undefined;
  transcriptHash?: string | undefined;
}): CodexUsageRecord | undefined {
  const usage = input.footerUsage ?? input.transcriptUsage;
  if (!usage) return undefined;

  const source =
    input.footerUsage && input.transcriptUsage
      ? "footer+transcript"
      : input.footerUsage
        ? "footer"
        : "transcript";

  return {
    ...usage,
    ...(input.transcriptMetadata?.model ? { model: input.transcriptMetadata.model } : {}),
    ...(input.transcriptMetadata?.hostSessionId ? { hostSessionId: input.transcriptMetadata.hostSessionId } : {}),
    ...(input.transcriptMetadata?.turnId ? { turnId: input.transcriptMetadata.turnId } : {}),
    ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
    ...(input.transcriptHash ? { transcriptHash: input.transcriptHash } : {}),
    source
  };
}

function extractUsageFromJsonl(input: string): Omit<CodexUsageRecord, "source"> | undefined {
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const usage = findUsageObject(parsed);
      if (usage) return usage;
    } catch {
      // Transcript parsing is best-effort; malformed lines are ignored.
    }
  }
  return undefined;
}

function findUsageObject(value: unknown): Omit<CodexUsageRecord, "source"> | undefined {
  if (!isRecord(value)) return undefined;
  const candidates = [value.usage, value.token_usage, value.tokenUsage, value.metrics, value];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const total = numberValue(candidate.total_tokens) ?? numberValue(candidate.totalTokens) ?? numberValue(candidate.total);
    const input = numberValue(candidate.input_tokens) ?? numberValue(candidate.inputTokens) ?? numberValue(candidate.input);
    const output = numberValue(candidate.output_tokens) ?? numberValue(candidate.outputTokens) ?? numberValue(candidate.output);
    if (total !== undefined && input !== undefined && output !== undefined) {
      return {
        totalTokens: total,
        inputTokens: input,
        cachedInputTokens:
          numberValue(candidate.cached_input_tokens) ??
          numberValue(candidate.cachedInputTokens) ??
          numberValue(candidate.cached) ??
          0,
        outputTokens: output
      };
    }
  }

  for (const candidate of Object.values(value)) {
    const nested = findUsageObject(candidate);
    if (nested) return nested;
  }

  return undefined;
}

function extractTranscriptMetadata(input: string): TranscriptMetadata {
  const metadata: TranscriptMetadata = {};

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      collectMetadata(parsed, metadata);
      if (metadata.model && metadata.hostSessionId && metadata.turnId) break;
    } catch {
      // Metadata extraction is best-effort.
    }
  }

  return metadata;
}

function extractTranscriptFeedback(input: string): CodexTranscriptFeedback {
  const filesRead = new Set<string>();
  const filesEdited = new Set<string>();
  const commands = new Set<string>();
  const testsRun = new Set<string>();
  let passSignals = 0;
  let failSignals = 0;

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (/\b(pass|passed|success|succeeded)\b/.test(lower)) passSignals += 1;
    if (/\b(fail|failed|error|exception)\b/.test(lower)) failSignals += 1;

    if (trimmed.startsWith("{")) {
      try {
        collectFeedback(JSON.parse(trimmed) as unknown, { filesRead, filesEdited, commands, testsRun });
        continue;
      } catch {
        // Fall through to text extraction.
      }
    }
    for (const file of extractFileRefs(trimmed)) filesRead.add(file);
  }

  return {
    filesRead: [...filesRead].sort(),
    filesEdited: [...filesEdited].sort(),
    commands: [...commands].slice(0, 60),
    testsRun: [...testsRun].slice(0, 30),
    ...(failSignals > passSignals ? { outcome: "fail" as const } : passSignals > 0 ? { outcome: "pass" as const } : {})
  };
}

function collectFeedback(
  value: unknown,
  output: {
    filesRead: Set<string>;
    filesEdited: Set<string>;
    commands: Set<string>;
    testsRun: Set<string>;
  },
  parentKey = ""
): void {
  if (typeof value === "string") {
    const key = parentKey.toLowerCase();
    for (const file of extractFileRefs(value)) {
      if (/(patch|edit|write|apply|update|modified|file_change)/.test(key)) output.filesEdited.add(file);
      else output.filesRead.add(file);
    }
    if (/(command|cmd|shell|bash)/.test(key) || looksLikeCommand(value)) {
      output.commands.add(value.trim());
      if (/\b(test|vitest|jest|playwright|cypress|tsc|typecheck|lint)\b/i.test(value)) output.testsRun.add(value.trim());
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectFeedback(item, output, parentKey);
    return;
  }

  if (!isRecord(value)) return;
  const toolName = stringValue(value.tool_name) ?? stringValue(value.toolName) ?? stringValue(value.name) ?? "";
  const editLikeTool = /\b(apply_patch|edit|write|replace|filechanged)\b/i.test(toolName);
  for (const [key, nested] of Object.entries(value).slice(0, 80)) {
    const nextKey = [parentKey, editLikeTool ? `edit ${key}` : key].filter(Boolean).join(" ");
    collectFeedback(nested, output, nextKey);
  }
}

function extractFileRefs(input: string): string[] {
  const files = new Set<string>();
  const pattern = /(?:^|\s|["'([])((?:\.{0,2}\/)?[^ "'()\n\r]+?\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|scss|md|mdx))(?:[:)]|\s|$)/g;
  for (const match of input.matchAll(pattern)) {
    const candidate = match[1]?.replace(/^\.\//, "");
    if (!candidate || candidate.includes("node_modules") || candidate.startsWith("../")) continue;
    files.add(candidate);
  }
  return [...files];
}

function looksLikeCommand(value: string): boolean {
  return /^(pnpm|npm|yarn|bun|npx|node|deno|git|rg|grep|sed|cat|ls|tsx|tsc)\b/.test(value.trim());
}

function collectMetadata(value: unknown, metadata: TranscriptMetadata): void {
  if (!isRecord(value)) return;
  const model = stringValue(value.model);
  if (!metadata.model && model) metadata.model = model;
  if (!metadata.hostSessionId) {
    const hostSessionId = stringValue(value.session_id) ?? stringValue(value.sessionId) ?? stringValue(value.hostSessionId);
    if (hostSessionId) metadata.hostSessionId = hostSessionId;
  }
  const turnId = stringValue(value.turn_id) ?? stringValue(value.turnId);
  if (!metadata.turnId && turnId) metadata.turnId = turnId;

  for (const nested of Object.values(value).slice(0, 20)) {
    if (metadata.model && metadata.hostSessionId && metadata.turnId) return;
    if (typeof nested === "object" && nested !== null) collectMetadata(nested, metadata);
  }
}

function parseTokenNumber(value: string | undefined): number {
  return Number.parseInt((value ?? "0").replace(/,/g, ""), 10);
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
