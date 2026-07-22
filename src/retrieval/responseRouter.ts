// SPDX-License-Identifier: Apache-2.0

import type { ContextQueryMode, ContextRequestType, ResponseDecision } from "../types.js";

export function decideResponse(input: {
  requestType: ContextRequestType;
  explicitMode?: ContextQueryMode;
  budget?: number;
  query?: string;
  topScore?: number;
  repeatedFiles?: number;
  graphAvailable?: boolean;
}): ResponseDecision {
  const warnings: string[] = [];

  if ((input.repeatedFiles ?? 0) > 0) {
    warnings.push("Some top results were already shown in this session.");
  }

  if (input.graphAvailable === false) {
    warnings.push("No graph edges are available yet; related context is using lexical retrieval only.");
  }

  if ((input.topScore ?? 0) > 0 && (input.topScore ?? 0) < 10) {
    warnings.push("Retrieval confidence is low. Use a more specific file, symbol, or task query.");
  }

  if (input.explicitMode) {
    return {
      mode: explicitModeToResponseMode(input.explicitMode),
      reason: `explicit ${input.explicitMode} mode requested`,
      warnings
    };
  }

  if (input.requestType === "file" || input.requestType === "symbol") {
    return {
      mode: "exact_code",
      reason: "explicit source read",
      warnings
    };
  }

  if (input.requestType === "related") {
    return {
      mode: "graph_neighbors",
      reason: "related-file request",
      warnings
    };
  }

  if (input.requestType === "tests") {
    return {
      mode: "verification_plan",
      reason: "test discovery request",
      warnings
    };
  }

  if (input.requestType === "error") {
    return {
      mode: "failure_context",
      reason: "failure context request",
      warnings
    };
  }

  if (input.requestType === "verify_plan" || input.requestType === "diff") {
    return {
      mode: "verification_plan",
      reason: "verification-oriented request",
      warnings
    };
  }

  if ((input.budget ?? 1600) <= 900) {
    return {
      mode: "snippets",
      reason: "tight token budget",
      warnings
    };
  }

  if (isImplementationIntent(input.query ?? "")) {
    return {
      mode: "exact_code",
      reason: "implementation-like query",
      warnings
    };
  }

  if (isVagueQuery(input.query ?? "")) {
    return {
      mode: "snippets",
      reason: "discovery query",
      warnings
    };
  }

  return {
    mode: "brief",
    reason: "ranked context brief",
    warnings
  };
}

function explicitModeToResponseMode(mode: ContextQueryMode): ResponseDecision["mode"] {
  if (mode === "exact") return "exact_code";
  if (mode === "summary") return "compressed_summary";
  if (mode === "snippets") return "snippets";
  return "brief";
}

function isVagueQuery(query: string): boolean {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  return terms.length <= 3;
}

function isImplementationIntent(query: string): boolean {
  return /\b(add|build|change|edit|fix|implement|refactor|replace|update|wire)\b/i.test(query);
}
