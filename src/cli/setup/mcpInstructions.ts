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
          "- If no Kairn hook context appears, work normally on cheap exact-source tasks and do not call Kairn just to confirm an obvious file.",
          "- For diagnose, investigate, audit, or trace tasks that do not name an exact production path, call `kairn_prepare_task` once before broad/manual source reads.",
          "- Treat Kairn MCP as an optional fallback only after the task becomes clearly multi-file, unclear, or failure-driven."
        ]
      : [
          "- For broad, unclear, multi-file, or cross-module tasks, call `kairn_prepare_task` before broad file scans.",
          "- For diagnose, investigate, audit, or trace tasks that do not name an exact production path, call `kairn_prepare_task` once before broad/manual source reads.",
          "- For cheap one-shot source fixes, work normally first only when the prompt names an exact production file, exact symbol, or exact command owner.",
          "- Do not skip Kairn merely because a task feels small; if the source path is not named and the task is diagnose/source-rescue/failure-driven, call `kairn_prepare_task` once.",
          "- For exact-file or exact-symbol tasks, work normally unless targeted search fails, a check fails, or the task broadens.",
          "- For real command/test failure output, call `kairn_get_failure_context` only when `kairn_prepare_task` did not return a sufficient source surface or the failure output names a new file/symbol outside the returned files."
        ]),
    ...(mode === "hybrid"
      ? ["- Prefer silence over unnecessary Kairn calls when the hook has not supplied useful context."]
      : [
          "- If `kairn_prepare_task` returns `cheap_one_shot_guardrail`, `cheap_one_shot_abstention`, any other `stopCondition`, or no `nextToolCalls`, continue normally and do not call more Kairn unless a check fails with a concrete missing source outside the returned files, a file changes, or the target changes.",
          "- When Kairn has already identified the source file, do not run broad repo search or read unrelated files on repeat, verification, cleanup, or diff-review turns.",
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
