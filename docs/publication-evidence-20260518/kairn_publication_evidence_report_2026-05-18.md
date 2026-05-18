# Kairn Publication Evidence Report

Generated: 2026-05-18T15:19:30.143Z
Plan: /Users/kevindotel/Documents/Projects/kairn/examples/bench/publication-plan-v3.json
Model: gpt-5.4-mini
Dry run: true

## Summary

- Entries: 0
- Result rows: 0
- Quality pass rate: 0.00%
- Median valid active savings: 0.00%
- Active median savings >= 15%: false
- MCP evidence present: false
- Endurance repeat evidence present: false
- Net token savings after emitted Kairn context estimate: 0

## Entry Results

| Entry | Repo | Task Class | Mode | Quality | Valid Savings | Classification | Failure Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Mode Results

| Mode | Rows | Quality | Active | Valid Savings | Passive | Invalid | MCP Calls | Over | Harmful | Missed | Abstain | Evidence | Scope Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Overhead

| Metric | Value |
| --- | --- |
| Median setup time | 0ms |
| Median index refresh time | 0ms |
| Median hook/prompt latency | 0ms |
| p95 hook/MCP latency | 0ms |
| Median MCP calls per successful run | 0 |
| Median Kairn context tokens emitted | 0 |
| Net token savings after Kairn output estimate | 0 |

## Task Class Results

| Task Class | Rows | Quality | Active | Median Savings | Harmful | Missed | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Failure Patterns

No repeated failure patterns recorded.

## Improvement Recommendations

- Active median savings did not reach 15%; inspect missed opportunities and over-assist classes before increasing live spend.
- No real MCP evidence was recorded; run the MCP smoke or a live MCP subset before making MCP claims.
- No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.
- Suppressed/passive savings are reported separately as abstention evidence.
- Official SWE-Pro savings are invalid until the official evaluator passes.
