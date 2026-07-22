// SPDX-License-Identifier: Apache-2.0

import type {
  BenchmarkAssistClassification,
  BenchmarkAssistanceStatus,
  BenchmarkBehaviorTargetOutcome,
  BenchmarkContextBehavior
} from "../types.js";

const CHEAP_SINGLE_SOURCE_MAX_HARM_RATE = 0.05;
const CHEAP_SINGLE_SOURCE_MAX_HARM_TOKENS = 1_500;
const SOURCE_RESCUE_MIN_SAVINGS_RATE = 0.15;
const HARD_DEBUG_MIN_SAVINGS_RATE = 0.3;

export type BehaviorTargetInput = {
  caseId: string;
  behavior?: BenchmarkContextBehavior | undefined;
  assistanceStatus: BenchmarkAssistanceStatus;
  assistClassification: BenchmarkAssistClassification;
  qualityGatePassed: boolean;
  baselineQualityGatePassed?: boolean | undefined;
  baselineTokens?: number | undefined;
  afterTokens?: number | undefined;
  savedTokens?: number | undefined;
};

export type BehaviorTargetResult = {
  caseId: string;
  behavior: BenchmarkContextBehavior;
  outcome: BenchmarkBehaviorTargetOutcome;
  reason: string;
  assistanceStatus: BenchmarkAssistanceStatus;
  assistClassification: BenchmarkAssistClassification;
  baselineTokens?: number;
  afterTokens?: number;
  savedTokens?: number;
  savingsRate?: number;
};

export function evaluateBehaviorTarget(input: BehaviorTargetInput): BehaviorTargetResult | undefined {
  if (!input.behavior) return undefined;
  const savingsRate = input.baselineTokens && input.baselineTokens > 0 && input.savedTokens !== undefined
    ? Number((input.savedTokens / input.baselineTokens).toFixed(4))
    : undefined;
  const base = {
    caseId: input.caseId,
    behavior: input.behavior,
    assistanceStatus: input.assistanceStatus,
    assistClassification: input.assistClassification,
    ...(input.baselineTokens !== undefined ? { baselineTokens: input.baselineTokens } : {}),
    ...(input.afterTokens !== undefined ? { afterTokens: input.afterTokens } : {}),
    ...(input.savedTokens !== undefined ? { savedTokens: input.savedTokens } : {}),
    ...(savingsRate !== undefined ? { savingsRate } : {})
  };

  switch (input.behavior) {
    case "cheap_single_source":
      return {
        ...base,
        ...cheapSingleSourceOutcome(input)
      };
    case "source_rescue":
      return {
        ...base,
        ...activeSavingsOrQualityOutcome(input, SOURCE_RESCUE_MIN_SAVINGS_RATE, "source rescue")
      };
    case "multi_file_debug":
      return {
        ...base,
        ...activeSavingsOrQualityOutcome(input, HARD_DEBUG_MIN_SAVINGS_RATE, "multi-file debug")
      };
    case "failure_first":
      return {
        ...base,
        ...activeSavingsOrQualityOutcome(input, HARD_DEBUG_MIN_SAVINGS_RATE, "failure-first")
      };
    case "session_repeat":
      return {
        ...base,
        ...sessionRepeatOutcome(input)
      };
    case "weak_signal":
      return {
        ...base,
        ...weakSignalOutcome(input)
      };
    default:
      return {
        ...base,
        outcome: "not_applicable",
        reason: "No behavior target rule is defined for this case."
      };
  }
}

export function summarizeBehaviorTargets(
  outcomes: BehaviorTargetResult[]
): Partial<Record<BenchmarkContextBehavior, { cases: number; met: number; missed: number }>> {
  const summary: Partial<Record<BenchmarkContextBehavior, { cases: number; met: number; missed: number }>> = {};
  for (const item of outcomes) {
    const bucket = summary[item.behavior] ?? { cases: 0, met: 0, missed: 0 };
    bucket.cases += 1;
    if (item.outcome === "met") bucket.met += 1;
    if (item.outcome === "missed") bucket.missed += 1;
    summary[item.behavior] = bucket;
  }
  return summary;
}

function cheapSingleSourceOutcome(input: BehaviorTargetInput): Pick<BehaviorTargetResult, "outcome" | "reason"> {
  if (!input.qualityGatePassed) {
    return { outcome: "missed", reason: "Cheap single-source run failed quality; abstention/guardrail did not preserve correctness." };
  }
  if (input.assistanceStatus === "passive_suppressed") {
    return { outcome: "met", reason: "Kairn correctly stayed silent on a cheap single-source task." };
  }
  if (input.assistanceStatus === "none") {
    return { outcome: "not_applicable", reason: "No Kairn assistance mode was active for this case." };
  }
  if (input.savedTokens === undefined || input.baselineTokens === undefined) {
    return { outcome: "not_applicable", reason: "Observed token data is unavailable for cheap single-source scoring." };
  }
  if (input.savedTokens >= 0) {
    return { outcome: "met", reason: "Minimal guardrail preserved quality and did not increase token usage." };
  }
  const allowedHarm = Math.max(CHEAP_SINGLE_SOURCE_MAX_HARM_TOKENS, input.baselineTokens * CHEAP_SINGLE_SOURCE_MAX_HARM_RATE);
  if (Math.abs(input.savedTokens) <= allowedHarm) {
    return { outcome: "met", reason: "Minimal guardrail caused only near-zero token harm while preserving quality." };
  }
  return { outcome: "missed", reason: "Kairn over-assisted a cheap single-source task; it should have suppressed or emitted a smaller guardrail." };
}

function activeSavingsOrQualityOutcome(
  input: BehaviorTargetInput,
  minSavingsRate: number,
  label: string
): Pick<BehaviorTargetResult, "outcome" | "reason"> {
  if (input.assistanceStatus !== "active") {
    return { outcome: "missed", reason: `Kairn was not active for a ${label} case.` };
  }
  if (!input.qualityGatePassed) {
    return { outcome: "missed", reason: `Kairn was active for ${label}, but quality failed.` };
  }
  if (input.baselineQualityGatePassed === false) {
    return { outcome: "met", reason: `Kairn improved quality on a ${label} case where baseline failed.` };
  }
  if (input.savedTokens === undefined || input.baselineTokens === undefined || input.baselineTokens <= 0) {
    return { outcome: "not_applicable", reason: `Observed token data is unavailable for ${label} scoring.` };
  }
  const rate = input.savedTokens / input.baselineTokens;
  if (rate >= minSavingsRate) {
    return { outcome: "met", reason: `Kairn met the ${Math.round(minSavingsRate * 100)}% ${label} savings target.` };
  }
  return { outcome: "missed", reason: `Kairn did not meet the ${Math.round(minSavingsRate * 100)}% ${label} savings target.` };
}

function sessionRepeatOutcome(input: BehaviorTargetInput): Pick<BehaviorTargetResult, "outcome" | "reason"> {
  if (!input.qualityGatePassed) {
    return { outcome: "missed", reason: "Long-session run failed quality." };
  }
  if (input.assistanceStatus !== "active" && input.assistanceStatus !== "passive_suppressed") {
    return { outcome: "not_applicable", reason: "No Kairn session behavior was active." };
  }
  if (input.savedTokens === undefined || input.savedTokens >= 0) {
    return { outcome: "met", reason: "Session policy preserved quality while avoiding repeated context or not increasing tokens." };
  }
  return { outcome: "missed", reason: "Session policy increased tokens without an offsetting quality win." };
}

function weakSignalOutcome(input: BehaviorTargetInput): Pick<BehaviorTargetResult, "outcome" | "reason"> {
  if (input.assistanceStatus === "active") {
    return { outcome: "missed", reason: "Kairn emitted context for a weak-signal case that should usually stay silent." };
  }
  if (!input.qualityGatePassed && input.baselineQualityGatePassed === true) {
    return { outcome: "missed", reason: "Weak-signal Kairn-mode quality regressed despite staying silent." };
  }
  return { outcome: "met", reason: "Kairn stayed silent for a weak-signal case." };
}
