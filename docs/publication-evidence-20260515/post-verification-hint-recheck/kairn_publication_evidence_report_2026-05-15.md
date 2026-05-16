# Kairn Publication Evidence Report

Generated: 2026-05-15T19:38:56.418Z
Plan: /tmp/kairn-post-verification-hint-plan.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 2
- Quality pass rate: 100.00%
- Median valid active savings: 76.25%
- Active median savings >= 15%: true
- MCP evidence present: false
- Endurance repeat evidence present: false

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| post-verification-hint-repeat2 | seeded-fresh-holdout-v2-subset | source_rescue | baseline | fail | 0 |  |  |
| post-verification-hint-repeat2 | seeded-fresh-holdout-v2-subset | source_rescue | kairn_codex_session | pass | 148897 | quality_rescue |  |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 1 | 100.00% | 1 | 148897 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| source_rescue | 2 | 50.00% | 1 | 38.13% | 0 | 0 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| quality gate failed | 1 | post-verification-hint-repeat2:baseline |

## Improvement Recommendations

- No real MCP evidence was recorded; run the MCP smoke or a live MCP subset before making MCP claims.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.
- Investigate repeated pattern "quality gate failed" across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
