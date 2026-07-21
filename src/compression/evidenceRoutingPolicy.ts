import { performance } from "node:perf_hooks";
import type {
  EvidenceClass,
  EvidenceRoutingAction,
  EvidenceRoutingReasonCode,
  EvidenceRoutingShadowReceipt,
  OutputKind,
  WatchEventKind
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";
import { routeEvidenceCompression } from "./routeEvidence.js";

export const EVIDENCE_ROUTING_SHADOW_BUDGET = 1200;
export const EVIDENCE_ROUTING_PREVIEW_MAX_BYTES = 1024 * 1024;

export function evaluateEvidenceRoutingShadow(input: {
  output: string;
  type: OutputKind;
  rootPath: string;
  linkedFiles: string[];
  eventKind: WatchEventKind;
  exitCode?: number | undefined;
  trivialSuccessfulOutput: boolean;
  currentDeliveryTokens: number;
  budget?: number | undefined;
}): { receipt: EvidenceRoutingShadowReceipt } {
  const startedAt = performance.now();
  const budget = Math.max(1, Math.floor(input.budget ?? EVIDENCE_ROUTING_SHADOW_BUDGET));
  const inputBytes = Buffer.byteLength(input.output, "utf8");

  if (inputBytes > EVIDENCE_ROUTING_PREVIEW_MAX_BYTES) {
    const inputTokens = estimateTokens(input.output);
    const inputHash = sha256(input.output);
    return {
      receipt: buildReceipt({
        action: "exact",
        reason: "input_limit_exceeded",
        type: input.type,
        evidenceClass: evidenceClassForType(input.type),
        budget,
        inputBytes,
        inputTokens,
        currentDeliveryTokens: input.currentDeliveryTokens,
        candidateTokens: inputTokens,
        inputHash,
        candidateHash: inputHash,
        attributedFileCount: uniqueFiles(input.linkedFiles).length,
        compressionStatus: "not_run",
        compressionReason: "input_limit_exceeded",
        startedAt
      })
    };
  }

  const preview = routeEvidenceCompression({
    output: input.output,
    type: input.type,
    rootPath: input.rootPath,
    budget
  });
  const inputTokens = preview.metadata.inputTokens;
  const inputHash = preview.metadata.inputHash;
  const files = uniqueFiles([...input.linkedFiles, ...preview.files]);
  const sourceLikeInput =
    preview.metadata.reason === "source_like_input" ||
    (input.trivialSuccessfulOutput && looksLikeSourceSnippet(input.output));
  const failureLike = isFailureLike(input);
  const lacksFailureAttribution =
    failureLike &&
    files.length === 0 &&
    preview.metadata.anchors.byCategory.path_location === 0 &&
    preview.metadata.anchors.byCategory.test_identifier === 0 &&
    preview.metadata.anchors.byCategory.stack_frame === 0;
  const lowSignalOutput =
    !failureLike &&
    preview.metadata.evidenceClass === "generic" &&
    preview.metadata.anchors.total === 0 &&
    inputTokens > budget;
  const decision = chooseDecision({
    compressionStatus: preview.metadata.status,
    compressionReason: preview.metadata.reason,
    sourceLikeInput,
    lacksFailureAttribution,
    trivialSuccessfulOutput: input.trivialSuccessfulOutput,
    lowSignalOutput
  });

  return {
    receipt: buildReceipt({
      action: decision.action,
      reason: decision.reason,
      type: input.type,
      evidenceClass: preview.metadata.evidenceClass,
      budget,
      inputBytes,
      inputTokens,
      currentDeliveryTokens: input.currentDeliveryTokens,
      candidateTokens: preview.metadata.outputTokens,
      inputHash,
      candidateHash: preview.metadata.outputHash,
      attributedFileCount: files.length,
      compressionStatus: preview.metadata.status,
      compressionReason: preview.metadata.reason,
      startedAt
    })
  };
}

function chooseDecision(input: {
  compressionStatus: "compressed" | "skipped" | "failed_open";
  compressionReason: string;
  sourceLikeInput: boolean;
  lacksFailureAttribution: boolean;
  trivialSuccessfulOutput: boolean;
  lowSignalOutput: boolean;
}): { action: EvidenceRoutingAction; reason: EvidenceRoutingReasonCode } {
  if (input.sourceLikeInput) {
    return { action: "exact", reason: "source_like_input" };
  }
  if (input.compressionStatus === "failed_open") {
    return { action: "exact", reason: "unsafe_compression" };
  }
  if (input.lacksFailureAttribution) {
    return { action: "request_more", reason: "missing_repository_attribution" };
  }
  if (input.trivialSuccessfulOutput) {
    return { action: "suppress", reason: "trivial_success" };
  }
  if (input.lowSignalOutput) {
    return { action: "suppress", reason: "low_signal_output" };
  }
  if (input.compressionStatus === "compressed") {
    return { action: "compress", reason: "safe_compression_candidate" };
  }
  return { action: "exact", reason: "existing_delivery_preferred" };
}

function buildReceipt(input: {
  action: EvidenceRoutingAction;
  reason: EvidenceRoutingReasonCode;
  type: OutputKind;
  evidenceClass: EvidenceClass;
  budget: number;
  inputBytes: number;
  inputTokens: number;
  currentDeliveryTokens: number;
  candidateTokens: number;
  inputHash: string;
  candidateHash: string;
  attributedFileCount: number;
  compressionStatus: EvidenceRoutingShadowReceipt["compression"]["status"];
  compressionReason: EvidenceRoutingShadowReceipt["compression"]["reason"];
  startedAt: number;
}): EvidenceRoutingShadowReceipt {
  const savedTokens = Math.max(0, input.inputTokens - input.candidateTokens);
  return {
    schemaVersion: 1,
    mode: "shadow",
    action: input.action,
    reason: input.reason,
    outputKind: input.type,
    evidenceClass: input.evidenceClass,
    budget: input.budget,
    inputBytes: input.inputBytes,
    inputTokens: input.inputTokens,
    currentDeliveryTokens: Math.max(0, Math.round(input.currentDeliveryTokens)),
    candidateTokens: input.candidateTokens,
    candidateVsInputSavedTokens: savedTokens,
    candidateVsInputSavingsRate: input.inputTokens > 0 ? savedTokens / input.inputTokens : 0,
    candidateVsCurrentTokenDelta: input.candidateTokens - Math.max(0, Math.round(input.currentDeliveryTokens)),
    inputHash: input.inputHash,
    candidateHash: input.candidateHash,
    attributedFileCount: input.attributedFileCount,
    compression: {
      status: input.compressionStatus,
      reason: input.compressionReason
    },
    elapsedMs: Math.round((performance.now() - input.startedAt) * 1000) / 1000
  };
}

function isFailureLike(input: {
  output: string;
  eventKind: WatchEventKind;
  exitCode?: number | undefined;
}): boolean {
  return input.eventKind === "failure" ||
    (input.exitCode !== undefined && input.exitCode !== 0) ||
    /\b(error|failed|failure|exception|traceback|timeout|cannot|not found|TS\d{3,5})\b/i.test(input.output);
}

function evidenceClassForType(type: OutputKind): EvidenceClass {
  return type === "test" ? "test" : type;
}

function looksLikeSourceSnippet(output: string): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const sourceLines = lines.filter((line) =>
    /^(?:import|export|const|let|var|function|async function|class|interface|type|enum|def|async def|from|package|func|struct|namespace|public|private|protected)\b/.test(line) ||
    /^(?:if|for|while|switch|try|catch)\s*[({]/.test(line) ||
    /^(?:[}\])];?|else\b)/.test(line) ||
    /^['"][^'"]+['"]\s*:\s*/.test(line) ||
    /[;{}]$/.test(line)
  ).length;
  return sourceLines / lines.length >= 0.55;
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files.filter(Boolean))];
}
