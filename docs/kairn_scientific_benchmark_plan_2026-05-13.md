# Kairn Scientific Benchmark Plan - 2026-05-13

## Summary

Kairn should not optimize official benchmarks by making them easier. It should make official benchmark rows measurable for Kairn's actual claim: local context governance that routes agents to the smallest useful source evidence, abstains when context is not useful, and preserves quality.

The benchmark harness now stratifies official rows before live spend. Each row receives:

- source: `swe_atlas_qna`, `swe_bench_pro`, or `kairn_native`
- task class
- evaluator
- Kairn applicability level
- live-risk level
- reasons and recommended modes

This lets reports separate clean Kairn evidence from runtime/procedural tasks that primarily test environment setup and agent exploration.

## Task Classes

| Class | Kairn Measurement |
| --- | --- |
| `source_grounded_explanation` | Measures source routing plus concise answer grounding. |
| `patch_verification` | Measures source routing, edit quality, and verification. |
| `multi_file_debug` | Measures companion routing and structured multi-file shrink. |
| `failure_first_debug` | Measures failure-output routing and smallest useful repair context. |
| `cheap_single_source` | Measures abstention or ultra-small guardrails. |
| `source_rescue` | Measures whether Kairn prevents broad search when the source is not obvious. |
| `runtime_procedural` | Not a clean Kairn savings metric; track separately because runtime setup dominates. |
| `weak_signal` | Measures abstention accuracy, not active savings. |

## Evaluators

| Evaluator | Used For |
| --- | --- |
| `source_grounded_answer` | QnA rows where a source-backed answer is the product. |
| `patch_verification` | SWE-Pro or seeded repair tasks with verification. |
| `runtime_procedural_answer` | Rows requiring service boot, live logs, probes, or environment observation. |
| `retrieval_preflight` | Static preflight before live agent spend. |

## Kairn Applicability

| Level | Meaning |
| --- | --- |
| `strong` | Count in headline Kairn effectiveness metrics if quality passes. |
| `partial` | Useful diagnostic evidence, but not a clean headline metric. |
| `weak` | Mostly abstention or low-signal evidence. |
| `not_applicable` | Exclude from Kairn effectiveness claims. |

`runtime_procedural` rows are deliberately not headline Kairn metrics. Kairn can still provide useful source evidence, but token usage and quality are dominated by whether the agent successfully runs services, probes runtime state, and interprets logs.

## Scientific Reporting Rules

Headline claims should report each task class separately:

- quality pass rate
- observed token savings
- valid savings only when quality passes
- active/passive/suppressed split
- harmful assist count
- missed opportunity count
- latency and timeout rate
- MCP calls per useful file

Aggregate claims must exclude rows where `kairnMetricEligible` is false. Those rows still appear in appendix tables as stress-test evidence.

## Control Rules

- Freeze classifier/evaluator logic before live runs.
- Use the same model and same repo commit per comparison.
- Randomize mode order or use repeat runs when practical.
- Keep reference answers/golden patch paths out of prompts.
- Use official setup/evaluator paths before counting SWE-Pro token reductions as valid.
- Never count lower tokens as a win when quality fails.

## Immediate Workflow

1. Generate official pilot suites.
2. Inspect class/evaluator distribution.
3. Run repo-matrix preflight only to select source-grounded or patch-verification candidates.
4. Run baseline vs `kairn_codex_session` first.
5. Add MCP/hybrid only for broad, multi-file, failure-driven, or source-rescue classes.
6. Report by class before making any aggregate claim.

## Current Implementation

- SWE-Atlas/QnA rows classify into source-grounded, runtime-procedural, multi-file, cheap-source, rescue, and weak-signal classes.
- SWE-Pro rows classify into patch-verification-compatible classes.
- Benchmark result metadata includes official source, task class, evaluator, Kairn applicability, metric eligibility, and live risk.
- Benchmark reports aggregate official results by task class, evaluator, and applicability.

