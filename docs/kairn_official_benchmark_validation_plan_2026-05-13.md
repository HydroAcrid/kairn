# Kairn Official Benchmark Validation Plan - 2026-05-13

## Goal

Use official benchmark-shaped tasks to test whether Kairn generalizes beyond curated seeded suites, while keeping evidence honest.

## Order

1. **SWE-Atlas/QnA pilot**
   - Generate 20-30 public QnA tasks.
   - Use reference answers only offline to extract expected source files.
   - Run repo-matrix preflight first.
   - Compare baseline vs `kairn_codex_session` only after preflight passes.

2. **SWE-Pro clean setup pilot**
   - Use full official artifacts, not truncated row API patches.
   - Prefer `before_repo_set_cmd` and official evaluator setup.
   - Do not count token savings unless official Docker evaluation passes.

3. **SWE-Pro live comparison**
   - Start with baseline vs `kairn_codex_session`.
   - Add MCP/hybrid only on broad, failure-driven, or multi-file tasks.

4. **MCP validation**
   - Run `kairn bench mcp-smoke` before live MCP spend.
   - Track actual MCP calls, returned source roles, stop conditions, and repeated-call avoidance.

## Evidence Rules

- QnA is retrieval/grounding evidence, not patch correctness.
- SWE-Pro is patch-quality evidence only when the official evaluator passes.
- MCP claims require actual MCP tool calls.
- Kairn-assisted savings require active context, not suppress-only passive evidence.
- Improvements must target behavior classes: `source_rescue`, `multi_file_debug`, `failure_first`, `cheap_single_source`, `session_repeat`, and `weak_signal`.
