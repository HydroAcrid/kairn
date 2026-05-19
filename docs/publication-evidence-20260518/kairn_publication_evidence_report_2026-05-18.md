# Kairn Publication Evidence Report

Generated: 2026-05-19T15:03:29.353Z
Plan: /tmp/kairn-publication-plan-v3-completed.json
Model: gpt-5.4-mini
Dry run: false

## Summary

- Entries: 7
- Result rows: 29
- Quality pass rate: 60.00%
- Median valid active savings: 23.25%
- Active median savings >= 15%: true
- MCP evidence present: true
- Endurance repeat evidence present: false
- Net token savings after emitted Kairn context estimate: 146452

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-publication-v3-preflight | fresh-publication-v3 | fresh_preflight | matrix_preflight | pass | 0 |  |  |
| fresh-live-repeat3-canary | seeded-fresh-holdout-v2 | source_rescue | baseline | fail | 0 |  |  |
| fresh-live-repeat3-canary | seeded-fresh-holdout-v2 | source_rescue | kairn_codex_session | pass | 2430 | quality_rescue |  |
| ablation-proof-repeat3 | seeded-ablation-canary | ablation | baseline | pass | 0 |  |  |
| ablation-proof-repeat3 | seeded-ablation-canary | ablation | kairn_codex_session | pass | 12606 | valid_assist |  |
| ablation-proof-repeat3 | seeded-ablation-canary | ablation | kairn_codex_session_no_governor | pass | 22846 | valid_assist |  |
| httpcore-mcp-endurance-repeat3 | httpcore | session_repeat | baseline | pass | 0 | none |  |
| httpcore-mcp-endurance-repeat3 | httpcore | session_repeat | real_mcp_first | pass | 8889 | active |  |
| requests-mcp-endurance-repeat3 | requests | session_repeat | baseline | pass | 0 | none |  |
| requests-mcp-endurance-repeat3 | requests | session_repeat | real_mcp_first | pass | 83807 | active |  |
| requests-mcp-endurance-repeat3 | requests | session_repeat | hybrid_mcp_brief | pass | 78274 | active |  |
| local-mcp-smoke-v3 | local | mcp_delivery | mcp_smoke | pass | 0 |  |  |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |
| swe-pro-official-eval-v3 | swe-bench-pro | official_patch | official_evaluator | fail | 0 |  | Official SWE-Pro evaluator did not pass. |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matrix_preflight | 8 | 100.00% | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| baseline | 4 | 75.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session | 2 | 100.00% | 2 | 15036 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kairn_codex_session_no_governor | 1 | 100.00% | 1 | 22846 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| real_mcp_first | 2 | 100.00% | 2 | 92696 | 0 | 0 | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| hybrid_mcp_brief | 1 | 100.00% | 1 | 78274 | 0 | 0 | 3 | 1 | 0 | 0 | 0 | 0 | 0 |
| mcp_smoke | 1 | 100.00% | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| official_evaluator | 10 | 0.00% | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Overhead

| Metric | Value |
| --- | --- |
| Median setup time | 532ms |
| Median index refresh time | 0ms |
| Median hook/prompt latency | 748ms |
| p95 hook/MCP latency | 8488ms |
| Median MCP calls per successful run | 3 |
| Median Kairn context tokens emitted | 1000 |
| Net token savings after Kairn output estimate | 146452 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fresh_preflight | 8 | 100.00% | 6 | 0.00% | 0 | 0 | 1 |
| source_rescue | 2 | 50.00% | 1 | 0.83% | 0 | 0 | 0 |
| ablation | 3 | 100.00% | 2 | 17.85% | 0 | 0 | 0 |
| session_repeat | 5 | 100.00% | 3 | 18.46% | 0 | 0 | 0 |
| mcp_delivery | 1 | 100.00% | 1 | 0.00% | 0 | 0 | 0 |
| official_patch | 10 | 0.00% | 0 | 0.00% | 0 | 0 | 0 |

## Failure Patterns

| Pattern | Count | Examples |
| --- | --- | --- |
| Official SWE-Pro evaluator did not pass. | 10 | swe-pro-official-eval-v3:official_evaluator, swe-pro-official-eval-v3:official_evaluator, swe-pro-official-eval-v3:official_evaluator, swe-pro-official-eval-v3:official_evaluator, swe-pro-official-eval-v3:official_evaluator |
| over-assist | 1 | requests-mcp-endurance-repeat3:hybrid_mcp_brief |
| quality gate failed | 1 | fresh-live-repeat3-canary:baseline |

## Improvement Recommendations

- Quality pass rate fell more than five percentage points below baseline; treat savings as blocked until failure patterns are addressed.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.
- Investigate repeated pattern "Official SWE-Pro evaluator did not pass." across 10 row(s).
- Investigate repeated pattern "over-assist" across 1 row(s).
- Investigate repeated pattern "quality gate failed" across 1 row(s).

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
