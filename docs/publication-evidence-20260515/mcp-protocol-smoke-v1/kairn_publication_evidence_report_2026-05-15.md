# Kairn Publication Evidence Report

Generated: 2026-05-16T14:27:43.227Z
Plan: /Users/kevindotel/Documents/Projects/kairn/examples/bench/publication-plan-v2.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 1
- Quality pass rate: 100.00%
- Median valid active savings: 0.00%
- Active median savings >= 15%: false
- MCP evidence present: true
- Endurance repeat evidence present: false

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| local-mcp-smoke-v2 | local | mcp_delivery | mcp_smoke | pass | 0 |  |  |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mcp_smoke | 1 | 100.00% | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mcp_delivery | 1 | 100.00% | 1 | 0.00% | 0 | 0 | 0 |

## Failure Patterns

No repeated failure patterns recorded.

## Improvement Recommendations

- Active median savings did not reach 15%; inspect missed opportunities and over-assist classes before increasing live spend.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
