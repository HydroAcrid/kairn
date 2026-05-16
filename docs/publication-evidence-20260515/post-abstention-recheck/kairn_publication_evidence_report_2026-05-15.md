# Kairn Publication Evidence Report

Generated: 2026-05-15T18:38:38.990Z
Plan: /tmp/kairn-post-abstention-plan.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 2
- Quality pass rate: 0.00%
- Median valid active savings: 0.00%
- Active median savings >= 15%: false
- MCP evidence present: false
- Endurance repeat evidence present: false

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| post-abstention-repeat2 | seeded-fresh-holdout-v2-subset | source_rescue | baseline | pass | 0 |  |  |
| post-abstention-repeat2 | seeded-fresh-holdout-v2-subset | source_rescue | kairn_codex_session | fail | 0 | harmful_invalid_assist | Token reduction is invalid because one or more quality gates failed. |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 100.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 1 | 0.00% | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| source_rescue | 2 | 50.00% | 1 | -14.57% | 1 | 0 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| Token reduction is invalid because one or more quality gates failed. | 1 | post-abstention-repeat2:kairn_codex_session |

## Improvement Recommendations

- Quality pass rate fell more than five percentage points below baseline; treat savings as blocked until failure patterns are addressed.
- Active median savings did not reach 15%; inspect missed opportunities and over-assist classes before increasing live spend.
- No real MCP evidence was recorded; run the MCP smoke or a live MCP subset before making MCP claims.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.
- Investigate repeated pattern "Token reduction is invalid because one or more quality gates failed." across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
