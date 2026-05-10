import fs from "node:fs";
import path from "node:path";

export function writeMcpInstructionsSetup(input: { root: string; mode?: "mcp-first" | "hybrid" }) {
  const rootPath = path.resolve(input.root);
  const instructionsPath = path.join(rootPath, "AGENTS.md");
  const mode = input.mode ?? "mcp-first";
  const block = [
    "<!-- kairn:mcp-first:start -->",
    mode === "hybrid" ? "## Kairn Hybrid Workflow" : "## Kairn MCP-First Workflow",
    "",
    ...(mode === "hybrid"
      ? [
          "- If a Kairn prompt hook provides context, use that small context first.",
          "- If no Kairn hook context appears, work normally and do not call Kairn tools on the first turn.",
          "- Treat Kairn MCP as an optional fallback only after the task becomes clearly multi-file, unclear, or failure-driven."
        ]
      : [
          "- For broad, unclear, multi-file, or cross-module tasks, call `kairn_prepare_task` before broad file scans.",
          "- For cheap one-shot source fixes, work normally first. Examples: the prompt names one behavior, asks to fix production source, and says not to edit unrelated files.",
          "- Do not call Kairn solely because a prompt says debug, failing, failure, or regression when the task is otherwise a small one-source fix.",
          "- For exact-file, exact-symbol, or obviously small tasks, work normally unless targeted search fails or the task broadens.",
          "- For real command/test failure output, call `kairn_get_failure_context` once before broad debugging searches."
        ]),
    ...(mode === "hybrid"
      ? ["- Prefer silence over unnecessary Kairn calls when the hook has not supplied useful context."]
      : [
          "- If `kairn_prepare_task` returns `cheap_one_shot_guardrail`, `cheap_one_shot_abstention`, any other `stopCondition`, or no `nextToolCalls`, continue normally and do not call more Kairn unless a check fails, a file changes, or the target changes.",
          "- Only call `kairn_get_next_context` when `kairn_prepare_task` explicitly returns it as a next tool call.",
          "- Prefer the smallest Kairn-recommended read that can answer the immediate question."
        ]),
    "<!-- kairn:mcp-first:end -->",
    ""
  ].join("\n");
  const existing = fs.existsSync(instructionsPath) ? fs.readFileSync(instructionsPath, "utf8") : "";
  const pattern = /<!-- kairn:mcp-first:start -->[\s\S]*?<!-- kairn:mcp-first:end -->\n?/;
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : [existing.trimEnd(), "", block].filter(Boolean).join("\n");
  fs.writeFileSync(instructionsPath, next.endsWith("\n") ? next : `${next}\n`);
  return {
    rootPath,
    instructionsPath
  };
}
