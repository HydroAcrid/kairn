import type { FailureContext, WatchRecommendation } from "../types.js";

export function failureRecommendation(context: FailureContext): WatchRecommendation {
  return {
    summary: `Failure context linked ${context.failureFiles.length} failure file(s).`,
    files: context.files,
    suggestedNextContext: context.files.slice(0, 5),
    warnings: context.warnings,
    content: context.content
  };
}
