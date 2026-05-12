import type {
  BenchmarkAbstentionOutcome,
  BenchmarkAssistClassification,
  BenchmarkAssistanceStatus,
  BenchmarkBaselineDifficulty
} from "../types.js";

const EXPENSIVE_BASELINE_TOTAL_TOKENS = 50_000;
const EXPENSIVE_BASELINE_TOKENS_PER_TURN = 12_000;

export type AssistanceClassificationInput = {
  assistanceStatus: BenchmarkAssistanceStatus;
  qualityGatePassed: boolean;
  savedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  baselineQualityGatePassed?: boolean | undefined;
  turnCount?: number | undefined;
};

export type AssistanceClassificationResult = {
  assistanceEligible: boolean;
  baselineDifficulty: BenchmarkBaselineDifficulty;
  baselineTokenCost?: number | undefined;
  abstentionOutcome: BenchmarkAbstentionOutcome;
  missedOpportunity: boolean;
  overAssist: boolean;
  harmfulAssist: boolean;
  assistClassification: BenchmarkAssistClassification;
};

export function classifyBaselineDifficulty(input: {
  baselineTokens?: number | undefined;
  baselineQualityGatePassed?: boolean | undefined;
  turnCount?: number | undefined;
}): BenchmarkBaselineDifficulty {
  if (input.baselineQualityGatePassed === false) return "quality_fail";
  if (input.baselineTokens === undefined || input.baselineQualityGatePassed === undefined) return "unknown";
  const averageTokens = input.turnCount && input.turnCount > 0 ? input.baselineTokens / input.turnCount : input.baselineTokens;
  return input.baselineTokens >= EXPENSIVE_BASELINE_TOTAL_TOKENS || averageTokens >= EXPENSIVE_BASELINE_TOKENS_PER_TURN
    ? "expensive_pass"
    : "cheap_pass";
}

export function classifyAssistance(input: AssistanceClassificationInput): AssistanceClassificationResult {
  const baselineDifficulty = classifyBaselineDifficulty({
    baselineTokens: input.baselineTokens,
    baselineQualityGatePassed: input.baselineQualityGatePassed,
    turnCount: input.turnCount
  });
  const base = {
    assistanceEligible: input.assistanceStatus === "active",
    baselineDifficulty,
    ...(input.baselineTokens !== undefined ? { baselineTokenCost: input.baselineTokens } : {}),
    abstentionOutcome: "not_applicable" as BenchmarkAbstentionOutcome,
    missedOpportunity: false,
    overAssist: false,
    harmfulAssist: false
  };

  if (input.assistanceStatus === "none") {
    return {
      ...base,
      assistClassification: "neutral"
    };
  }

  if (input.assistanceStatus === "passive_suppressed") {
    if (baselineDifficulty === "quality_fail") {
      return {
        ...base,
        abstentionOutcome: "missed_quality_opportunity",
        missedOpportunity: true,
        assistClassification: "missed_quality_opportunity"
      };
    }
    if (!input.qualityGatePassed && input.baselineQualityGatePassed === true) {
      return {
        ...base,
        abstentionOutcome: "passive_quality_regression",
        harmfulAssist: true,
        assistClassification: "passive_quality_regression"
      };
    }
    if (input.savedTokens !== undefined && input.savedTokens < 0 && input.baselineQualityGatePassed === true && input.qualityGatePassed) {
      return {
        ...base,
        abstentionOutcome: "passive_token_regression",
        overAssist: true,
        assistClassification: "passive_token_regression"
      };
    }
    if (baselineDifficulty === "expensive_pass") {
      return {
        ...base,
        abstentionOutcome: "missed_savings_opportunity",
        missedOpportunity: true,
        assistClassification: "missed_savings_opportunity"
      };
    }
    if (baselineDifficulty === "cheap_pass") {
      return {
        ...base,
        abstentionOutcome: "correct_abstention",
        assistClassification: "correct_abstention"
      };
    }
    return {
      ...base,
      assistClassification: "neutral"
    };
  }

  if (!input.qualityGatePassed) {
    return {
      ...base,
      harmfulAssist: true,
      assistClassification: "harmful_invalid_assist"
    };
  }
  if (input.savedTokens !== undefined && input.savedTokens > 0) {
    return {
      ...base,
      assistClassification: "valid_assist"
    };
  }
  if (input.savedTokens !== undefined && input.savedTokens <= 0) {
    return {
      ...base,
      overAssist: true,
      assistClassification: "over_assist"
    };
  }
  return {
    ...base,
    assistClassification: "neutral"
  };
}

export function classificationNegativeEvidenceReason(input: {
  classification: AssistanceClassificationResult;
  qualityFailureReason?: string | undefined;
}): string | undefined {
  switch (input.classification.assistClassification) {
    case "harmful_invalid_assist":
      return input.qualityFailureReason ?? "Kairn was active, but the quality gate failed.";
    case "over_assist":
      return "Kairn was active, but used at least as many observed tokens as baseline.";
    case "missed_savings_opportunity":
      return "Kairn suppressed while baseline passed with expensive token usage; this is a missed savings opportunity.";
    case "missed_quality_opportunity":
      return "Kairn suppressed while baseline failed quality; this is a missed quality opportunity.";
    case "passive_quality_regression":
      return "Kairn was passive/suppressed, but the assisted run failed quality while baseline passed.";
    case "passive_token_regression":
      return "Kairn was passive/suppressed, but the integration used more observed tokens than baseline.";
    default:
      return undefined;
  }
}
