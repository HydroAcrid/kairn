// SPDX-License-Identifier: Apache-2.0

import type {
  ExperimentAttemptMetrics,
  ExperimentTask,
  ExperimentTraceEvent,
  ExperimentTraceFile
} from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";

const ALLOWED_TOOLS = new Set(["list_files", "search_repo", "read_file", "apply_patch", "run_verification"]);
const EVENT_KINDS = new Set([
  "attempt_start", "assistance_start", "turn_start", "provider_injection", "model_request", "model_response",
  "tool_call", "tool_result", "file_edit", "failure", "verification", "turn_end", "attempt_end"
]);

export function validateExperimentTrace(input: {
  attemptId: string;
  events: ExperimentTraceEvent[];
}): string[] {
  const reasons: string[] = [];
  if (input.events.length === 0) return ["trace is empty"];
  if (input.events[0]?.kind !== "attempt_start") reasons.push("trace does not start with attempt_start");
  if (input.events.at(-1)?.kind !== "attempt_end") reasons.push("trace does not end with attempt_end");

  let previousSequence = -1;
  let previousMonotonicMs = -1;
  let attemptStarts = 0;
  let assistanceStarts = 0;
  let attemptEnds = 0;
  let activeTurn: number | undefined;
  const modelRequests = new Map<string, number>();
  const modelResponses = new Set<string>();
  const modelResponseSequences = new Map<string, number>();
  const pendingTools = new Map<string, number>();
  for (const [eventIndex, event] of input.events.entries()) {
    if (!event || typeof event !== "object") {
      reasons.push(`trace event ${eventIndex} is not an object`);
      continue;
    }
    if (event.schemaVersion !== 1) reasons.push(`unsupported trace schema at sequence ${event.sequence}`);
    if (event.attemptId !== input.attemptId) reasons.push(`attempt id mismatch at sequence ${event.sequence}`);
    if (!Number.isInteger(event.sequence) || event.sequence !== previousSequence + 1) {
      reasons.push(`trace sequence is not contiguous at ${String(event.sequence)}`);
    }
    if (!Number.isFinite(event.monotonicMs) || event.monotonicMs < 0 || event.monotonicMs < previousMonotonicMs) {
      reasons.push(`trace time moved backwards at sequence ${event.sequence}`);
    }
    if (Number.isInteger(event.sequence)) previousSequence = event.sequence;
    if (Number.isFinite(event.monotonicMs)) previousMonotonicMs = event.monotonicMs;
    if (!EVENT_KINDS.has(event.kind)) reasons.push(`unsupported event kind '${String(event.kind)}' at sequence ${event.sequence}`);
    if (!Number.isInteger(event.turn) || event.turn < 0) reasons.push(`invalid turn at sequence ${event.sequence}`);
    if (event.modelStep !== undefined && (!Number.isInteger(event.modelStep) || event.modelStep < 0)) {
      reasons.push(`invalid modelStep at sequence ${event.sequence}`);
    }

    if (event.kind === "attempt_start") attemptStarts += 1;
    if (event.kind === "assistance_start") assistanceStarts += 1;
    if (event.kind === "attempt_end") attemptEnds += 1;
    if (event.kind === "turn_start") {
      if (activeTurn !== undefined) reasons.push(`turn ${event.turn} started before turn ${activeTurn} ended`);
      activeTurn = event.turn;
    } else if (event.kind === "turn_end") {
      if (activeTurn !== event.turn) reasons.push(`turn_end ${event.turn} does not match active turn ${String(activeTurn)}`);
      activeTurn = undefined;
    } else if (
      ["provider_injection", "model_request", "model_response", "tool_call", "tool_result", "file_edit"].includes(event.kind) &&
      activeTurn !== event.turn
    ) {
      reasons.push(`${event.kind} occurred outside active turn ${event.turn} at sequence ${event.sequence}`);
    }

    const stepKey = `${event.turn}:${String(event.modelStep)}`;
    if (event.kind === "model_request") {
      if (event.modelStep === undefined) reasons.push(`model_request lacks modelStep at sequence ${event.sequence}`);
      if (modelRequests.has(stepKey)) reasons.push(`duplicate model_request for ${stepKey}`);
      modelRequests.set(stepKey, event.sequence);
    }
    if (event.kind === "model_response") {
      if (event.modelStep === undefined) reasons.push(`model_response lacks modelStep at sequence ${event.sequence}`);
      const requestSequence = modelRequests.get(stepKey);
      if (requestSequence === undefined || requestSequence >= event.sequence) reasons.push(`model_response has no preceding request for ${stepKey}`);
      if (modelResponses.has(stepKey)) reasons.push(`duplicate model_response for ${stepKey}`);
      modelResponses.add(stepKey);
      modelResponseSequences.set(stepKey, event.sequence);
      for (const [name, value] of [
        ["inputTokens", event.inputTokens],
        ["cachedInputTokens", event.cachedInputTokens],
        ["cacheCreationInputTokens", event.cacheCreationInputTokens],
        ["outputTokens", event.outputTokens]
      ] as const) {
        if (!Number.isInteger(value) || (value ?? -1) < 0) reasons.push(`${name} is missing or invalid at sequence ${event.sequence}`);
      }
      if (
        Number.isInteger(event.inputTokens) &&
        nonNegative(event.cachedInputTokens) + nonNegative(event.cacheCreationInputTokens) > nonNegative(event.inputTokens)
      ) {
        reasons.push(`cache token buckets exceed inputTokens at sequence ${event.sequence}`);
      }
    }

    if (event.kind === "tool_call" || event.kind === "tool_result") {
      if (!event.tool) reasons.push(`${event.kind} lacks tool name at sequence ${event.sequence}`);
      else if (!ALLOWED_TOOLS.has(event.tool)) reasons.push(`uninstrumented tool call '${event.tool}' at sequence ${event.sequence}`);
      const toolKey = `${stepKey}:${String(event.tool)}`;
      if (event.kind === "tool_call") {
        const responseSequence = modelResponseSequences.get(stepKey);
        if (responseSequence === undefined || responseSequence >= event.sequence) {
          reasons.push(`tool_call has no preceding model_response for ${stepKey}`);
        }
        pendingTools.set(toolKey, (pendingTools.get(toolKey) ?? 0) + 1);
      } else {
        const count = pendingTools.get(toolKey) ?? 0;
        if (count < 1) reasons.push(`tool_result has no matching tool_call for ${toolKey}`);
        else pendingTools.set(toolKey, count - 1);
        if (!Number.isInteger(event.tokenEstimate) || (event.tokenEstimate ?? -1) < 0) {
          reasons.push(`tool_result lacks estimated token size at sequence ${event.sequence}`);
        }
      }
    }
    if (event.kind === "provider_injection") {
      if (event.provider !== "kairn" && event.provider !== "reasonblocks") reasons.push(`provider_injection lacks provider at sequence ${event.sequence}`);
      if (!event.action) reasons.push(`provider_injection lacks action at sequence ${event.sequence}`);
      if (!Number.isInteger(event.tokenEstimate) || (event.tokenEstimate ?? -1) < 0) {
        reasons.push(`provider_injection lacks estimated token size at sequence ${event.sequence}`);
      }
    }
    for (const file of event.files ?? []) {
      const normalized = safeNormalize(file.path);
      if (!normalized || normalized !== file.path.replace(/\\/g, "/").replace(/^\.\//, "")) {
        reasons.push(`unsafe or non-normalized path '${file.path}' at sequence ${event.sequence}`);
      }
      if (file.delivery !== "content" && file.delivery !== "path_hint") {
        reasons.push(`invalid delivery for '${file.path}' at sequence ${event.sequence}`);
      }
      if (file.delivery === "content" && !/^[a-f0-9]{64}$/i.test(file.contentHash ?? "")) {
        reasons.push(`content event for '${file.path}' lacks a content hash at sequence ${event.sequence}`);
      }
      if (file.tokenEstimate !== undefined && (!Number.isInteger(file.tokenEstimate) || file.tokenEstimate < 0)) {
        reasons.push(`invalid file token estimate for '${file.path}' at sequence ${event.sequence}`);
      }
    }
  }
  if (attemptStarts !== 1) reasons.push(`trace contains ${attemptStarts} attempt_start events`);
  if (assistanceStarts !== 1) reasons.push(`trace contains ${assistanceStarts} assistance_start events`);
  if (attemptEnds !== 1) reasons.push(`trace contains ${attemptEnds} attempt_end events`);
  if (activeTurn !== undefined) reasons.push(`trace ended with turn ${activeTurn} still active`);
  for (const key of modelRequests.keys()) if (!modelResponses.has(key)) reasons.push(`model_request has no response for ${key}`);
  for (const [key, count] of pendingTools) if (count > 0) reasons.push(`${count} tool call(s) lack results for ${key}`);
  return unique(reasons);
}

export function deriveExperimentMetrics(input: {
  task: ExperimentTask;
  events: ExperimentTraceEvent[];
  externalQualityGatePassed: boolean;
  externalFinalVerifierPassed: boolean;
  externalRequiredTouchedPassed?: boolean | undefined;
  externalSourceInvariantPassed?: boolean | undefined;
  externalDiffScopePassed?: boolean | undefined;
  externalVerificationTokens?: number | undefined;
  excludedTouchedFiles?: string[] | undefined;
}): ExperimentAttemptMetrics {
  const required = new Set(input.task.requiredSourceFiles.map(normalizeExpectedPath));
  const allowed = new Set([
    ...required,
    ...(input.task.allowedSupportFiles ?? []).map(normalizeExpectedPath)
  ]);
  const requiredContent = new Set<string>();
  const requiredToolRead = new Set<string>();
  const explicitNoise = new Set<string>();
  const extraneous = new Set<string>();
  const priorReads = new Map<string, ReadObservation[]>();
  const interveningEvents: Intervention[] = [];

  let firstPathHint: ExperimentTraceEvent | undefined;
  let firstContent: ExperimentTraceEvent | undefined;
  let assistanceStartedAt: number | undefined;
  let modelTokensBeforeFirstRequiredPathHint: number | undefined;
  let firstEvidencePayloadTokens: number | undefined;
  let cumulativeModelTokens = 0;
  let modelTokensBeforeFirstRequiredContent: number | undefined;
  let modelCalls = 0;
  let modelCallsBeforeFirstRequiredContent = 0;
  let searchCalls = 0;
  let searchCallsBeforeFirstRequiredContent = 0;
  let uncachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let toolResultTokens = 0;
  let repositoryContentTokens = 0;
  let providerInjectionTokens = 0;
  let kairnGuidanceTokens = 0;
  let reasonblocksGuidanceTokens = 0;
  let verificationTokens = nonNegative(input.externalVerificationTokens);
  let explicitNoiseReadEvents = 0;
  let unnecessaryEmissionTokens = 0;
  let emissions = 0;
  let suppressions = 0;
  let providerDecisions = 0;
  let crossTurnRepeatReadEvents = 0;
  let avoidableCrossTurnRepeatReadEvents = 0;
  let avoidableRepeatReadTokens = 0;
  const kairnLatencies: number[] = [];
  let coldIndexingMs: number | undefined;
  let kairnSetupMs: number | undefined;
  let reasonblocksSetupMs: number | undefined;
  let kairnStateBytes: number | undefined;
  let hostCpuMs: number | undefined;
  let hostPeakRssBytes: number | undefined;
  let directChildCpuMs: number | undefined;
  let directChildPeakRssBytes: number | undefined;

  for (const event of input.events) {
    // Starts after preregistered failure setup and immediately before either
    // provider is constructed, so provider latency is symmetric across arms.
    if (event.kind === "assistance_start" && assistanceStartedAt === undefined) assistanceStartedAt = event.monotonicMs;
    if (event.kind === "model_response") {
      const inputTokens = nonNegative(event.inputTokens);
      const cached = Math.min(inputTokens, nonNegative(event.cachedInputTokens));
      const cacheCreation = Math.min(Math.max(0, inputTokens - cached), nonNegative(event.cacheCreationInputTokens));
      uncachedInputTokens += Math.max(0, inputTokens - cached);
      cacheCreationInputTokens += cacheCreation;
      cachedInputTokens += cached;
      outputTokens += nonNegative(event.outputTokens);
      cumulativeModelTokens += inputTokens + nonNegative(event.outputTokens);
      modelCalls += 1;
    }
    if (event.kind === "tool_call" && event.tool === "search_repo") searchCalls += 1;
    if (event.kind === "tool_result") toolResultTokens += nonNegative(event.tokenEstimate);

    if (event.kind === "provider_injection") {
      providerDecisions += 1;
      const tokens = nonNegative(event.tokenEstimate);
      if (event.action === "suppress") {
        suppressions += 1;
      } else if (tokens > 0 || (event.files?.length ?? 0) > 0) {
        emissions += 1;
        providerInjectionTokens += tokens;
        if (event.provider === "kairn") kairnGuidanceTokens += tokens;
        if (event.provider === "reasonblocks") reasonblocksGuidanceTokens += tokens;
        if (firstEvidencePayloadTokens === undefined) firstEvidencePayloadTokens = tokens;
        if (expectationForTurn(input.task, event.turn) === "abstain") unnecessaryEmissionTokens += tokens;
      }
      if (event.provider === "kairn" && event.metadata?.refreshed === true) {
        kairnLatencies.push(nonNegative(event.latencyMs));
        const indexingMs = numberMetadata(event.metadata?.coldIndexingMs);
        if (indexingMs !== undefined && coldIndexingMs === undefined) coldIndexingMs = indexingMs;
        const stateBytes = numberMetadata(event.metadata?.kairnStateBytes);
        if (stateBytes !== undefined) kairnStateBytes = Math.max(kairnStateBytes ?? 0, stateBytes);
      }
    }

    if (event.kind === "tool_result" && event.tool === "run_verification") {
      verificationTokens += nonNegative(event.tokenEstimate);
    }
    if (event.kind === "attempt_end") {
      hostCpuMs = numberMetadata(event.metadata?.hostCpuMs) ?? hostCpuMs;
      hostPeakRssBytes = numberMetadata(event.metadata?.hostPeakRssBytes) ?? hostPeakRssBytes;
      directChildCpuMs = numberMetadata(event.metadata?.directChildCpuMs) ?? directChildCpuMs;
      directChildPeakRssBytes = numberMetadata(event.metadata?.directChildPeakRssBytes) ?? directChildPeakRssBytes;
      kairnStateBytes = numberMetadata(event.metadata?.kairnStateBytes) ?? kairnStateBytes;
      kairnSetupMs = numberMetadata(event.metadata?.kairnSetupMs) ?? kairnSetupMs;
      reasonblocksSetupMs = numberMetadata(event.metadata?.reasonblocksSetupMs) ?? reasonblocksSetupMs;
    }

    if (event.kind === "file_edit" || event.kind === "failure" || (event.kind === "verification" && event.passed === false)) {
      interveningEvents.push({
        sequence: event.sequence,
        kind: event.kind,
        files: new Set((event.files ?? []).map((file) => normalizeExpectedPath(file.path)))
      });
    }

    const deliveredEvidence = event.kind === "turn_start" || event.kind === "provider_injection" || event.kind === "tool_result";
    for (const file of event.files ?? []) {
      const normalized = normalizeExpectedPath(file.path);
      const isRequired = required.has(normalized);
      const assistanceActive = assistanceStartedAt !== undefined && event.monotonicMs >= assistanceStartedAt;
      if (deliveredEvidence && assistanceActive && isRequired && !firstPathHint) {
        firstPathHint = event;
        modelTokensBeforeFirstRequiredPathHint = cumulativeModelTokens;
      }
      if (!deliveredEvidence || file.delivery !== "content") continue;

      if (event.kind === "tool_result") repositoryContentTokens += nonNegative(file.tokenEstimate);
      if (assistanceActive && isRequired) {
        requiredContent.add(normalized);
        if (event.kind === "tool_result" && event.tool === "read_file") {
          requiredToolRead.add(normalized);
        }
        if (!firstContent) {
          firstContent = event;
          modelTokensBeforeFirstRequiredContent = cumulativeModelTokens;
          modelCallsBeforeFirstRequiredContent = modelCalls;
          searchCallsBeforeFirstRequiredContent = searchCalls;
        }
      }
      if (assistanceActive && matchesAny(normalized, input.task.explicitNoisePatterns ?? [])) {
        explicitNoise.add(normalized);
        explicitNoiseReadEvents += 1;
      }
      if (assistanceActive && !allowed.has(normalized)) extraneous.add(normalized);

      if (!assistanceActive) continue;
      const observations = priorReads.get(normalized) ?? [];
      const previous = [...observations].reverse().find((item) => item.turn < event.turn && sameContent(item, file));
      if (previous) {
        crossTurnRepeatReadEvents += 1;
        const exempt = interveningEvents.some((candidate) =>
          candidate.sequence > previous.sequence &&
          candidate.sequence < event.sequence &&
          (candidate.files.size === 0 || candidate.files.has(normalized))
        );
        if (!exempt) {
          avoidableCrossTurnRepeatReadEvents += 1;
          avoidableRepeatReadTokens += nonNegative(file.tokenEstimate);
        }
      }
      observations.push({
        sequence: event.sequence,
        turn: event.turn,
        contentHash: file.contentHash ?? "",
        startLine: file.startLine,
        endLine: file.endLine
      });
      priorReads.set(normalized, observations);
    }
  }

  const requiredCount = required.size;
  const requiredSourceContentRecall = requiredCount === 0 ? 1 : ratio(requiredContent.size, requiredCount);
  const requiredSourceFound = requiredCount === 0 || requiredContent.size === requiredCount;
  return {
    requiredSourceFound,
    requiredSourceMissRate: Number((1 - requiredSourceContentRecall).toFixed(4)),
    ...(firstPathHint ? { timeToFirstRequiredPathHintMs: firstPathHint.monotonicMs - (assistanceStartedAt ?? 0) } : {}),
    ...(firstContent ? { timeToFirstRequiredContentMs: firstContent.monotonicMs - (assistanceStartedAt ?? 0) } : {}),
    ...(modelTokensBeforeFirstRequiredPathHint !== undefined ? { modelTokensBeforeFirstRequiredPathHint } : {}),
    ...(modelTokensBeforeFirstRequiredContent !== undefined ? { modelTokensBeforeFirstRequiredContent } : {}),
    modelCallsBeforeFirstRequiredContent,
    searchCallsBeforeFirstRequiredContent,
    ...(firstEvidencePayloadTokens !== undefined ? { estimatedFirstEvidencePayloadTokens: firstEvidencePayloadTokens } : {}),
    totalModelTokens: uncachedInputTokens + cachedInputTokens + outputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    outputTokens,
    estimatedToolResultTokens: toolResultTokens,
    estimatedRepositoryContentTokens: repositoryContentTokens,
    estimatedProviderInjectionTokens: providerInjectionTokens,
    estimatedKairnGuidanceTokens: kairnGuidanceTokens,
    estimatedReasonblocksGuidanceTokens: reasonblocksGuidanceTokens,
    estimatedVerificationTokens: verificationTokens,
    requiredSourceContentRecall,
    requiredSourceToolReadRecall: requiredCount === 0 ? 1 : ratio(requiredToolRead.size, requiredCount),
    explicitNoiseFilesOpened: explicitNoise.size,
    excludedFilesTouched: new Set(input.excludedTouchedFiles ?? []).size,
    extraneousFilesOpened: extraneous.size,
    explicitNoiseReadEvents,
    estimatedUnnecessaryEmissionTokens: unnecessaryEmissionTokens,
    emissionRate: providerDecisions === 0 ? 0 : ratio(emissions, providerDecisions),
    suppressionRate: providerDecisions === 0 ? 0 : ratio(suppressions, providerDecisions),
    crossTurnRepeatReadEvents,
    avoidableCrossTurnRepeatReadEvents,
    estimatedAvoidableRepeatReadTokens: avoidableRepeatReadTokens,
    ...(coldIndexingMs !== undefined ? { coldIndexingMs } : {}),
    ...(kairnSetupMs !== undefined ? { kairnSetupMs } : {}),
    ...(reasonblocksSetupMs !== undefined ? { reasonblocksSetupMs } : {}),
    ...(kairnLatencies.length > 0 ? { coldKairnResponseMs: kairnLatencies[0] } : {}),
    ...(kairnLatencies.length > 1 ? { medianWarmKairnResponseMs: median(kairnLatencies.slice(1)) } : {}),
    ...(kairnStateBytes !== undefined ? { kairnStateBytes } : {}),
    ...(hostCpuMs !== undefined ? { hostCpuMs } : {}),
    ...(hostPeakRssBytes !== undefined ? { hostPeakRssBytes } : {}),
    ...(directChildCpuMs !== undefined ? { directChildCpuMs } : {}),
    ...(directChildPeakRssBytes !== undefined ? { directChildPeakRssBytes } : {}),
    finalVerifierPassed: input.externalFinalVerifierPassed,
    requiredTouchedPassed: input.externalRequiredTouchedPassed ?? input.externalQualityGatePassed,
    sourceInvariantPassed: input.externalSourceInvariantPassed ?? input.externalQualityGatePassed,
    diffScopePassed: input.externalDiffScopePassed ?? input.externalQualityGatePassed,
    qualityGatePassed: input.externalQualityGatePassed
  };
}

type ReadObservation = {
  sequence: number;
  turn: number;
  contentHash: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
};

type Intervention = {
  sequence: number;
  kind: "file_edit" | "failure" | "verification";
  files: Set<string>;
};

function expectationForTurn(task: ExperimentTask, turn: number): "required" | "optional" | "abstain" {
  return task.turns?.[turn]?.assistanceExpectation ?? task.assistanceExpectation ?? "optional";
}

function sameContent(previous: ReadObservation, current: ExperimentTraceFile): boolean {
  if (!current.contentHash || previous.contentHash !== current.contentHash) return false;
  if (
    previous.startLine === undefined ||
    previous.endLine === undefined ||
    current.startLine === undefined ||
    current.endLine === undefined
  ) return true;
  const overlap = Math.max(0, Math.min(previous.endLine, current.endLine) - Math.max(previous.startLine, current.startLine) + 1);
  const smaller = Math.min(previous.endLine - previous.startLine + 1, current.endLine - current.startLine + 1);
  return smaller > 0 && overlap / smaller >= 0.5;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = normalizeExpectedPath(pattern);
    if (!normalized.includes("*")) return filePath === normalized || filePath.startsWith(`${normalized.replace(/\/$/, "")}/`);
    const escaped = normalized
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  });
}

function normalizeExpectedPath(value: string): string {
  return safeNormalize(value) ?? value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function safeNormalize(value: string): string | undefined {
  try {
    if (/^(?:[a-z]:[\\/]|[/\\]{1,2})/i.test(value)) return undefined;
    const normalized = normalizeRelativePath(value);
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function ratio(value: number, total: number): number {
  return Number((value / total).toFixed(4));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
