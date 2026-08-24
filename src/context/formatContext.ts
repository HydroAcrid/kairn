// SPDX-License-Identifier: Apache-2.0

import type { ContextResponse, HybridScoredResult } from "../types.js";
import type { QueryIntent } from "../retrieval/queryIntent.js";
import { estimateTokens, truncateToBudget } from "../utils/tokens.js";

export function formatContextResults(input: {
  title: string;
  task: string;
  query: string;
  decisionReason: string;
  mode: ContextResponse["mode"];
  intent: QueryIntent;
  scored: HybridScoredResult[];
  budget?: number | undefined;
}): string {
  const highConfidence =
    input.scored.length > 0
      ? input.scored
          .map((file) => {
            if ((file.rankerMode === "calibrated" || file.rankerMode === "fallback") && file.relevanceProbability !== undefined) {
              const evidenceReasons = file.evidenceReasons?.map((reason) => reason.replaceAll("_", " ")).join(", ") || "bounded repository evidence";
              return `- ${file.path} (${file.kind}, probability ${file.relevanceProbability.toFixed(3)}, ${file.delivery ?? "path_hint"}): ${evidenceReasons}`;
            }
            const scoreBreakdown = [
              `bm25 ${file.bm25Score}`,
              `semantic ${file.semanticScore}`,
              `keyword ${file.keywordScore}`,
              `behavior ${file.behaviorScore}`,
              `intent ${file.intentScore}`,
              `graph ${file.graphScore}`,
              `git ${file.gitScore}`
            ].join(", ");
            return `- ${file.path} (${file.kind}, score ${file.score}; ${scoreBreakdown}): ${file.reasons.join("; ")}`;
          })
          .join("\n")
      : "No high-confidence files found from hybrid retrieval.";

  const sections = [
    `# ${input.title}`,
    "",
    `Task: ${input.task}`,
    `Query: ${input.query}`,
    `Response Mode: ${input.mode}`,
    `Detected Intent: ${input.intent.primary}${input.intent.matchedTerms.length > 0 ? ` (${input.intent.matchedTerms.join(", ")})` : ""}`,
    `Selection: ${input.decisionReason}`,
    "",
    "## Ranked Files",
    highConfidence
  ];

  if (input.mode === "snippets" || input.mode === "exact_code") {
    const contentEligible = input.scored.filter((file) => file.delivery !== "path_hint");
    const snippetFiles = contentEligible.filter((file) => file.intentScore > 0 || !file.reasons.includes("graph neighbor"));
    const files = (snippetFiles.length > 0 ? snippetFiles : contentEligible).slice(0, 5);
    sections.push("", "## Matched Snippets", formatMatchedSnippets(files, Math.max(180, Math.floor((input.budget ?? 1600) * 0.42))));
  }

  if (input.mode === "compressed_summary") {
    sections.push("", "## Compact Summary", formatCompactSummary(input.scored.slice(0, 6)));
  }

  sections.push(
    "",
    "## Suggested Next Context",
    input.scored
      .slice(0, 5)
      .map((file) => `- Read ${file.path}`)
      .join("\n") || "Run a more specific context query."
  );

  return sections.join("\n");
}

function formatMatchedSnippets(files: HybridScoredResult[], budget = 700): string {
  const snippets: string[] = [];
  let usedTokens = 0;
  let omitted = 0;

  for (const file of files) {
    for (const chunk of file.chunks.slice(0, 2)) {
      const title = chunk.symbol
        ? `${file.path} :: ${chunk.symbol} (${chunk.startLine ?? "?"}-${chunk.endLine ?? "?"})`
        : file.path;
      const block = [
        `### ${title}`,
        "",
        "```",
        chunk.text.split(/\r?\n/).slice(0, 60).join("\n"),
        "```"
      ].join("\n");
      const blockTokens = estimateTokens(block);
      if (usedTokens + blockTokens > budget) {
        omitted += 1;
        if (snippets.length === 0) {
          snippets.push(truncateToBudget(block, budget));
          usedTokens = budget;
        }
        continue;
      }
      snippets.push(block);
      usedTokens += blockTokens;
    }
  }

  if (snippets.length === 0) return "No semantic snippets were available within the response budget.";
  const budgetNote =
    omitted > 0 ? `\n\nSnippet budget reached; omitted ${omitted} lower-priority snippet${omitted === 1 ? "" : "s"}.` : "";
  return `${snippets.join("\n\n")}${budgetNote}`;
}

function formatCompactSummary(files: HybridScoredResult[]): string {
  if (files.length === 0) return "No matching files to summarize.";
  return files
    .map((file) => {
      const chunkSummary = file.chunks
        .slice(0, 2)
        .map((chunk) => chunk.symbol ?? chunk.kind)
        .join(", ");
      return `- ${file.path}: ${file.reasons.slice(0, 3).join("; ")}${chunkSummary ? ` (${chunkSummary})` : ""}`;
    })
    .join("\n");
}
