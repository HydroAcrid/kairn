# Kairn Publication Evidence Report

Generated: 2026-05-15T22:47:03.336Z
Plan: /Users/kevindotel/Documents/Projects/kairn/examples/bench/publication-plan-v2-requests-kairn-recheck.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 1
- Result rows: 2
- Quality pass rate: 100.00%
- Median valid active savings: 31.07%
- Active median savings >= 15%: true
- MCP evidence present: false
- Endurance repeat evidence present: true

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| requests-kairn-session-recheck | requests | session_repeat | baseline | fail | 0 | none |  |
| requests-kairn-session-recheck | requests | session_repeat | kairn_codex_session | pass | 53734 | active |  |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 1 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 1 | 100.00% | 1 | 53734 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| session_repeat | 2 | 50.00% | 1 | 15.54% | 0 | 0 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| quality gate failed | 1 | requests-kairn-session-recheck:baseline |

## Improvement Recommendations

- No real MCP evidence was recorded; run the MCP smoke or a live MCP subset before making MCP claims.
- Investigate repeated pattern "quality gate failed" across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
