# Kairn Publication Evidence Report

Generated: 2026-05-15T14:05:47.857Z
Plan: /tmp/kairn-campaign-live-continuation-plan.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 3
- Quality pass rate: 100.00%
- Median valid active savings: 4.99%
- Active median savings >= 15%: false
- MCP evidence present: true
- Endurance repeat evidence present: false

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| campaign-live-continuation-repeat2 | seeded-fresh-holdout-v2-subset | mixed | baseline | pass | 0 |  |  |
| campaign-live-continuation-repeat2 | seeded-fresh-holdout-v2-subset | mixed | kairn_codex_session | pass | 2381 | valid_assist |  |
| campaign-live-continuation-repeat2 | seeded-fresh-holdout-v2-subset | mixed | real_mcp_first | pass | 0 | over_assist | Kairn was active, but used at least as many observed tokens as baseline. |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 100.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 1 | 100.00% | 1 | 2381 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| real_mcp_first | 1 | 100.00% | 1 | 0 | 0 | 0 | 4 | 1 | 0 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mixed | 3 | 100.00% | 2 | 0.00% | 0 | 0 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| Kairn was active, but used at least as many observed tokens as baseline. | 1 | campaign-live-continuation-repeat2:real_mcp_first |

## Improvement Recommendations

- Active median savings did not reach 15%; inspect missed opportunities and over-assist classes before increasing live spend.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.
- Investigate repeated pattern "Kairn was active, but used at least as many observed tokens as baseline." across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
