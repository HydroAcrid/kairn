import { performance } from "node:perf_hooks";
import type {
  CompressionAnchorCategory,
  CompressionMetadata,
  CompressionReasonCode,
  CompressionStatus,
  EvidenceClass,
  OutputKind
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";

const DEFAULT_BUDGET = 1200;
const MINIMUM_TOKEN_SAVINGS = 128;
const MINIMUM_SAVINGS_RATE = 0.1;
const HEAD_LINES = 6;
const TAIL_LINES = 10;

const ANCHOR_CATEGORIES: CompressionAnchorCategory[] = [
  "path_location",
  "test_identifier",
  "error_code",
  "exception_type",
  "stack_frame",
  "command_status"
];

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const DIRECTORY_PATH_PATTERN = /(?:[A-Za-z]:[\\/](?:[A-Za-z0-9_.@+ -]+[\\/])*[A-Za-z0-9_.@+ -]+\.[A-Za-z0-9]{1,12}|(?:\.{1,2}[\\/]|[\\/])?(?:[A-Za-z0-9_.@+-]+[\\/])+[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]{1,12})(?::\d+(?::\d+)?)?/g;
const BARE_PATH_LOCATION_PATTERN = /\b[A-Za-z0-9_.@+-]+\.[A-Za-z0-9]{1,12}:\d+(?::\d+)?\b/g;
const TEST_SELECTOR_PATTERN = /[A-Za-z0-9_.@+\\/-]+\.[A-Za-z0-9]{1,12}(?:::[A-Za-z_][A-Za-z0-9_.-]*)+/g;
const ERROR_CODE_PATTERN = /\b(?:TS\d{3,5}|E[A-Z][A-Z0-9_]{2,}|ERR_[A-Z0-9_]+)\b|@[a-z0-9_-]+\/[a-z0-9_-]+|(?<=\s)[a-z][a-z0-9_-]+\/[a-z0-9_-]+(?=\s|$)/g;
const EXCEPTION_PATTERN = /\b[A-Z][A-Za-z0-9]*(?:Error|Exception|Failure|Fault)\b/g;

type AnchorSets = Record<CompressionAnchorCategory, Set<string>>;

type EvidenceCompressionResult = {
  content: string;
  files: string[];
  metadata: CompressionMetadata;
};

export function routeEvidenceCompression(input: {
  output: string;
  type: OutputKind;
  budget?: number | undefined;
  rootPath?: string | undefined;
}): EvidenceCompressionResult {
  const startedAt = performance.now();
  const budget = Math.max(1, Math.floor(input.budget ?? DEFAULT_BUDGET));
  const inputTokens = estimateTokens(input.output);

  try {
    const normalized = normalizeEvidence(input.output);
    const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
    const anchorsByLine = lines.map(extractLineAnchors);
    const anchors = mergeAnchors(anchorsByLine);
    const evidenceClass = classifyEvidence(input.type, lines, anchors);
    const signalByLine = lines.map((line, index) =>
      isSignalLine(line, input.type) || anchorsByLine[index]!.stack_frame.size > 0
    );
    const files = filesFromAnchors(anchors.path_location, input.rootPath);

    if (normalized.trim().length === 0) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "skipped",
        reason: "empty_input",
        startedAt
      });
    }

    if (inputTokens <= budget) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "skipped",
        reason: "within_budget",
        startedAt
      });
    }

    if (looksLikeSource(lines, signalByLine)) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "skipped",
        reason: "source_like_input",
        startedAt
      });
    }

    const selection = selectEvidenceLines(lines, anchorsByLine, signalByLine);
    const candidate = buildCandidate(lines, selection.indices, evidenceClass, selection.collapsedRepetitionCount);
    const candidateTokens = estimateTokens(candidate);

    if (!validateAnchorSets(anchors, extractAnchors(candidate))) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "failed_open",
        reason: "anchor_validation_failed",
        collapsedRepetitionCount: selection.collapsedRepetitionCount,
        startedAt
      });
    }

    if (candidateTokens >= inputTokens) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "skipped",
        reason: "candidate_not_smaller",
        collapsedRepetitionCount: selection.collapsedRepetitionCount,
        startedAt
      });
    }

    if (candidateTokens >= budget) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "failed_open",
        reason: countAnchors(anchors) > 0 ? "anchor_budget_exceeded" : "candidate_budget_exceeded",
        collapsedRepetitionCount: selection.collapsedRepetitionCount,
        startedAt
      });
    }

    const savedTokens = inputTokens - candidateTokens;
    if (savedTokens < MINIMUM_TOKEN_SAVINGS || savedTokens / inputTokens < MINIMUM_SAVINGS_RATE) {
      return unchangedResult({
        input: input.output,
        budget,
        inputTokens,
        evidenceClass,
        anchors,
        files,
        status: "skipped",
        reason: "insufficient_savings",
        collapsedRepetitionCount: selection.collapsedRepetitionCount,
        startedAt
      });
    }

    return {
      content: candidate,
      files,
      metadata: buildMetadata({
        status: "compressed",
        reason: "compressed",
        evidenceClass,
        budget,
        input: input.output,
        output: candidate,
        anchors,
        collapsedRepetitionCount: selection.collapsedRepetitionCount,
        startedAt
      })
    };
  } catch {
    const emptyAnchors = createAnchorSets();
    return unchangedResult({
      input: input.output,
      budget,
      inputTokens,
      evidenceClass: input.type === "test" ? "test" : input.type,
      anchors: emptyAnchors,
      files: [],
      status: "failed_open",
      reason: "internal_error",
      startedAt
    });
  }
}

export function validateEvidenceAnchorPreservation(original: string, candidate: string): boolean {
  return validateAnchorSets(extractAnchors(normalizeEvidence(original)), extractAnchors(normalizeEvidence(candidate)));
}

function normalizeEvidence(output: string): string {
  return output.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
}

function classifyEvidence(type: OutputKind, lines: string[], anchors: AnchorSets): EvidenceClass {
  const text = lines.slice(0, 240).join("\n");
  if (/##\[(?:error|warning)\]|\b(?:github actions|buildkite|circleci|pipeline|job (?:failed|cancelled)|runner)\b/i.test(text)) {
    return "ci";
  }
  if (anchors.stack_frame.size >= 2) return "stack_trace";
  if (type === "test") return "test";
  if (type === "lint") return "lint";
  if (type === "typecheck") return "typecheck";
  return "generic";
}

function looksLikeSource(lines: string[], signalByLine: boolean[]): boolean {
  if (lines.length < 12) return false;
  const evidenceLines = signalByLine.filter(Boolean).length;
  if (evidenceLines > Math.max(2, Math.floor(lines.length * 0.05))) return false;

  const sourceLines = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      /^(?:import|export|const|let|var|function|async function|class|interface|type|enum|def|async def|from|package|func|struct|namespace|public|private|protected)\b/.test(trimmed) ||
      /^(?:if|for|while|switch|try|catch)\s*[({]/.test(trimmed) ||
      /^(?:[}\])];?|else\b)/.test(trimmed) ||
      /^["'][^"']+["']\s*:\s*/.test(trimmed) ||
      /[;{}]$/.test(trimmed)
    );
  }).length;

  return sourceLines / lines.length >= 0.55;
}

function selectEvidenceLines(
  lines: string[],
  anchorsByLine: AnchorSets[],
  signalByLine: boolean[]
): { indices: number[]; collapsedRepetitionCount: number } {
  const selected = new Set<number>();
  const repeated = new Set<number>();
  let collapsedRepetitionCount = 0;

  for (let index = 0; index < Math.min(HEAD_LINES, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - TAIL_LINES); index < lines.length; index += 1) selected.add(index);

  const templates = lines.map(repetitionTemplate);
  for (let start = 0; start < lines.length;) {
    const template = templates[start]!;
    let end = start + 1;
    while (end < lines.length && templates[end] === template) end += 1;
    const length = end - start;
    const exactDuplicate = length >= 2 && lines[start] === lines[end - 1];
    if ((exactDuplicate && length >= 2) || (!exactDuplicate && length >= 3)) {
      const representatives = new Set<number>([start, end - 1]);
      for (let index = start; index < end; index += 1) repeated.add(index);

      const coveredAnchors = new Set<string>();
      for (const representative of representatives) {
        for (const key of anchorKeys(anchorsByLine[representative]!)) coveredAnchors.add(key);
      }
      for (let index = start; index < end; index += 1) {
        const keys = anchorKeys(anchorsByLine[index]!);
        if (keys.some((key) => !coveredAnchors.has(key))) {
          representatives.add(index);
          for (const key of keys) coveredAnchors.add(key);
        }
      }

      for (const representative of representatives) selected.add(representative);
      collapsedRepetitionCount += Math.max(0, length - representatives.size);
    }
    start = end;
  }

  const coveredAnchors = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const keys = anchorKeys(anchorsByLine[index]!);
    if (keys.some((key) => !coveredAnchors.has(key))) selected.add(index);
    for (const key of keys) coveredAnchors.add(key);
  }

  const selectedSignals = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!repeated.has(index) && signalByLine[index] && !selectedSignals.has(lines[index]!)) {
      selected.add(index);
      selectedSignals.add(lines[index]!);
    }
  }

  return {
    indices: [...selected].sort((left, right) => left - right),
    collapsedRepetitionCount
  };
}

function repetitionTemplate(line: string): string {
  return line
    .trim()
    .replace(/\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|0x[0-9a-f]+|\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?|\d+(?:\.\d+)?(?:ms|s|m|h)?)\b/gi, "<v>")
    .replace(/\s+/g, " ");
}

function buildCandidate(
  lines: string[],
  indices: number[],
  evidenceClass: EvidenceClass,
  collapsedRepetitionCount: number
): string {
  const output = [
    `# Kairn ${evidenceClass.replace("_", " ")} evidence`,
    `Input lines: ${lines.length}`,
    `Preserved lines: ${indices.length}`,
    `Repeated lines collapsed: ${collapsedRepetitionCount}`,
    ""
  ];
  let previous = -1;
  for (const index of indices) {
    const omitted = index - previous - 1;
    if (omitted > 0) output.push(`[... ${omitted} line${omitted === 1 ? "" : "s"} omitted ...]`);
    output.push(lines[index]!);
    previous = index;
  }
  const omittedTail = lines.length - previous - 1;
  if (omittedTail > 0) output.push(`[... ${omittedTail} line${omittedTail === 1 ? "" : "s"} omitted ...]`);
  return output.join("\n");
}

function isSignalLine(line: string, type: OutputKind): boolean {
  const common = /\b(?:error|failed?|failure|exception|warning|timeout|timed out|panic|fatal|expected|received|cannot|not found|denied|assert(?:ion)?|exit(?:ed)?|non-zero)\b/i;
  if (common.test(line)) return true;
  if (type === "test") return /(?:^|\s)(?:FAIL|FAILED|×|✗|●)|snapshot|tests?\s*:/i.test(line);
  if (type === "lint") return /eslint|stylelint|\bproblems?\b|\bfixable\b|\d+:\d+\s+(?:error|warning)/i.test(line);
  if (type === "typecheck") return /\bTS\d{3,5}\b|assignable|does not exist|cannot find|no overload|argument of type/i.test(line);
  return false;
}

function isStackFrame(line: string): boolean {
  return (
    /^\s*at\s+.+(?:\(.+\)|:\d+(?::\d+)?)\s*$/.test(line) ||
    /^\s*File\s+["'].+["'],\s+line\s+\d+/i.test(line) ||
    /^\s*at\s+[\w.$<>]+\(.+:\d+\)\s*$/.test(line)
  );
}

function extractAnchors(text: string): AnchorSets {
  return mergeAnchors(text.split("\n").map(extractLineAnchors));
}

function extractLineAnchors(line: string): AnchorSets {
  const anchors = createAnchorSets();
  if (line.includes("/") || line.includes("\\") || (line.includes(".") && line.includes(":"))) {
    const directoryPaths = [...line.matchAll(DIRECTORY_PATH_PATTERN)].map((match) => match[0]).filter(Boolean);
    for (const value of directoryPaths) anchors.path_location.add(value);
    if (directoryPaths.length === 0) addMatches(anchors.path_location, line, BARE_PATH_LOCATION_PATTERN);
  }
  if (line.includes("::")) addMatches(anchors.test_identifier, line, TEST_SELECTOR_PATTERN);
  if (line.includes("TS") || line.includes("ERR_") || line.includes("@") || line.includes("/") || /\bE[A-Z]/.test(line)) {
    addMatches(anchors.error_code, line, ERROR_CODE_PATTERN);
  }
  if (line.includes("Error") || line.includes("Exception") || line.includes("Failure") || line.includes("Fault")) {
    addMatches(anchors.exception_type, line, EXCEPTION_PATTERN);
  }

  const trimmed = line.trim();
  if (/^(?:FAIL|FAILED|PASS|PASSED|×|✗|●|--- FAIL:)\s+/.test(trimmed)) {
    anchors.test_identifier.add(trimmed);
  }
  const goTest = trimmed.match(/^--- FAIL:\s+([^\s(]+)/);
  if (goTest?.[1]) anchors.test_identifier.add(goTest[1]);
  if (isStackFrame(line)) anchors.stack_frame.add(trimmed);
  if (/\b(?:command|process|exit(?:ed)?(?:\s+with)?|exit code|status|ELIFECYCLE|ERR_PNPM_)\b/i.test(line)) {
    anchors.command_status.add(trimmed);
  }
  return anchors;
}

function addMatches(target: Set<string>, line: string, pattern: RegExp): void {
  for (const match of line.matchAll(pattern)) {
    if (match[0]) target.add(match[0]);
  }
}

function createAnchorSets(): AnchorSets {
  return {
    path_location: new Set<string>(),
    test_identifier: new Set<string>(),
    error_code: new Set<string>(),
    exception_type: new Set<string>(),
    stack_frame: new Set<string>(),
    command_status: new Set<string>()
  };
}

function mergeAnchors(items: AnchorSets[]): AnchorSets {
  const merged = createAnchorSets();
  for (const item of items) {
    for (const category of ANCHOR_CATEGORIES) {
      for (const value of item[category]) merged[category].add(value);
    }
  }
  return merged;
}

function anchorKeys(anchors: AnchorSets): string[] {
  return ANCHOR_CATEGORIES.flatMap((category) => [...anchors[category]].map((value) => `${category}\u0000${value}`));
}

function validateAnchorSets(expected: AnchorSets, actual: AnchorSets): boolean {
  return ANCHOR_CATEGORIES.every((category) =>
    [...expected[category]].every((value) => actual[category].has(value))
  );
}

function countAnchors(anchors: AnchorSets): number {
  return ANCHOR_CATEGORIES.reduce((total, category) => total + anchors[category].size, 0);
}

function filesFromAnchors(paths: Set<string>, rootPath?: string): string[] {
  const normalizedRoot = rootPath?.replace(/\\/g, "/").replace(/\/$/, "");
  const files = [...paths].flatMap((value) => {
    const normalized = value
      .replace(/:\d+(?::\d+)?$/, "")
      .replace(/^\.\//, "")
      .replace(/\\/g, "/");
    if (!normalizedRoot) return [normalized];
    if (isAbsoluteEvidencePath(normalized)) {
      const comparablePath = /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
      const comparableRoot = /^[A-Za-z]:\//.test(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot;
      return comparablePath.startsWith(`${comparableRoot}/`)
        ? [normalized.slice(normalizedRoot.length + 1)]
        : [];
    }
    return normalized === ".." || normalized.startsWith("../") ? [] : [normalized];
  });
  return [...new Set(files)];
}

function isAbsoluteEvidencePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:\//.test(filePath);
}

function unchangedResult(input: {
  input: string;
  budget: number;
  inputTokens: number;
  evidenceClass: EvidenceClass;
  anchors: AnchorSets;
  files: string[];
  status: Exclude<CompressionStatus, "compressed">;
  reason: Exclude<CompressionReasonCode, "compressed">;
  collapsedRepetitionCount?: number | undefined;
  startedAt: number;
}): EvidenceCompressionResult {
  return {
    content: input.input,
    files: input.files,
    metadata: buildMetadata({
      status: input.status,
      reason: input.reason,
      evidenceClass: input.evidenceClass,
      budget: input.budget,
      input: input.input,
      output: input.input,
      anchors: input.anchors,
      collapsedRepetitionCount: input.collapsedRepetitionCount ?? 0,
      startedAt: input.startedAt
    })
  };
}

function buildMetadata(input: {
  status: CompressionStatus;
  reason: CompressionReasonCode;
  evidenceClass: EvidenceClass;
  budget: number;
  input: string;
  output: string;
  anchors: AnchorSets;
  collapsedRepetitionCount: number;
  startedAt: number;
}): CompressionMetadata {
  const inputTokens = estimateTokens(input.input);
  const outputTokens = estimateTokens(input.output);
  const savedTokens = Math.max(0, inputTokens - outputTokens);
  return {
    schemaVersion: 1,
    status: input.status,
    reason: input.reason,
    evidenceClass: input.evidenceClass,
    budget: input.budget,
    inputTokens,
    outputTokens,
    savedTokens,
    savingsRate: inputTokens > 0 ? savedTokens / inputTokens : 0,
    inputHash: sha256(input.input),
    outputHash: sha256(input.output),
    anchors: {
      total: countAnchors(input.anchors),
      byCategory: Object.fromEntries(
        ANCHOR_CATEGORIES.map((category) => [category, input.anchors[category].size])
      ) as Record<CompressionAnchorCategory, number>
    },
    collapsedRepetitionCount: input.collapsedRepetitionCount,
    elapsedMs: Math.round((performance.now() - input.startedAt) * 1000) / 1000
  };
}
