# Kairn Publication Evidence Report

Generated: 2026-05-15T22:16:48.758Z
Plan: /Users/kevindotel/Documents/Projects/kairn/examples/bench/publication-plan-v2.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 4
- Quality pass rate: 66.67%
- Median valid active savings: 35.50%
- Active median savings >= 15%: true
- MCP evidence present: true
- Endurance repeat evidence present: true

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| requests-10turn-repeat3 | requests | session_repeat | baseline | pass | 0 | none |  |
| requests-10turn-repeat3 | requests | session_repeat | kairn_codex_session | fail | 20228 | active |  |
| requests-10turn-repeat3 | requests | session_repeat | real_mcp_first | pass | 0 | active |  |
| requests-10turn-repeat3 | requests | session_repeat | hybrid_mcp_brief | pass | 85911 | active |  |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 100.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 1 | 0.00% | 1 | 20228 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| real_mcp_first | 1 | 100.00% | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| hybrid_mcp_brief | 1 | 100.00% | 1 | 85911 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session_repeat | 4 | 75.00% | 3 | 21.19% | 1 | 0 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| harmful assist | 1 | requests-10turn-repeat3:kairn_codex_session |

## Improvement Recommendations

- Quality pass rate fell more than five percentage points below baseline; treat savings as blocked until failure patterns are addressed.
- Investigate repeated pattern "harmful assist" across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
