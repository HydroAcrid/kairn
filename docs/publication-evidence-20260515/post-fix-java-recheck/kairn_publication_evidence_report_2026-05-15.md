# Kairn Publication Evidence Report

Generated: 2026-05-15T15:27:00.479Z
Plan: /tmp/kairn-post-fix-java-recheck-plan.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 2
- Quality pass rate: 100.00%
- Median valid active savings: 64.22%
- Active median savings >= 15%: true
- MCP evidence present: false
- Endurance repeat evidence present: false

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| post-fix-java-routing-repeat2 | seeded-fresh-holdout-v2-subset | source_rescue | baseline | pass | 0 |  |  |
| post-fix-java-routing-repeat2 | seeded-fresh-holdout-v2-subset | source_rescue | kairn_codex_session | pass | 35934 | valid_assist |  |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 100.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 1 | 100.00% | 1 | 35934 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| source_rescue | 2 | 100.00% | 1 | 32.11% | 0 | 0 | 0 |

## Failure Patterns

No repeated failure patterns recorded.

## Improvement Recommendations

- No real MCP evidence was recorded; run the MCP smoke or a live MCP subset before making MCP claims.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
