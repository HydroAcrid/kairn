import fs from "node:fs";
import path from "node:path";

export function writeMcpInstructionsSetup(input: { root: string }) {
  const rootPath = path.resolve(input.root);
  const instructionsPath = path.join(rootPath, "AGENTS.md");
  const block = [
    "<!-- kairn:mcp-first:start -->",
    "## Kairn MCP-First Workflow",
    "",
    "- Before broad file scans, call `kairn_prepare_task` with the user task.",
    "- For follow-up reads, call `kairn_get_next_context` before reading large files.",
    "- For failures, call `kairn_get_failure_context` before broad debugging searches.",
    "- Prefer the smallest Kairn-recommended read that can answer the immediate question.",
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
