# Kairn Publication Evidence Report

Generated: 2026-05-15T14:18:27.099Z
Plan: /tmp/kairn-zod-mcp-recheck-plan.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 2
- Quality pass rate: 100.00%
- Median valid active savings: 0.00%
- Active median savings >= 15%: false
- MCP evidence present: true
- Endurance repeat evidence present: false

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| zod-mcp-cheap-recheck | zod | cheap_single_source | baseline | fail | 0 |  |  |
| zod-mcp-cheap-recheck | zod | cheap_single_source | real_mcp_first | pass | 0 | missed_quality_opportunity | Kairn suppressed while baseline failed quality; this is a missed quality opportunity. |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| real_mcp_first | 1 | 100.00% | 0 | 0 | 1311 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cheap_single_source | 2 | 50.00% | 0 | 2.15% | 0 | 1 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| Kairn suppressed while baseline failed quality; this is a missed quality opportunity. | 1 | zod-mcp-cheap-recheck:real_mcp_first |
| quality gate failed | 1 | zod-mcp-cheap-recheck:baseline |

## Improvement Recommendations

- Active median savings did not reach 15%; inspect missed opportunities and over-assist classes before increasing live spend.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.
- Investigate repeated pattern "Kairn suppressed while baseline failed quality; this is a missed quality opportunity." across 1 row(s).
- Investigate repeated pattern "quality gate failed" across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
