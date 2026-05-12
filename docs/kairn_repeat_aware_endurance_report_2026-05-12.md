# Kairn Repeat-Aware Endurance Report - 2026-05-12

## Summary

Kairn now has repeat-aware endurance aggregation. A single endurance run can still be useful for debugging, but it should not drive product claims. The new repeat layer reports median observed tokens, quality pass counts, active/passive assistance counts, classification counts, and a verdict per mode.

This is meant to answer:

- Does a mode repeatedly help, or was it a lucky live run?
- Does it pass quality every time?
- Was Kairn actually active, or did it merely stay passive?
- Did passive suppression avoid harm, or did integration overhead still increase tokens?

## Why Known Suites Still Matter

Using Requests, Gin, Axios, Flask, and similar suites is not the same as optimizing for those repos. They are regression canaries for known behavior classes:

- Requests: multi-turn source focus where Kairn has historically helped.
- Gin: cheap single-source abstention and hook over-assist canary.
- Axios/Flask: companion/source-invariant and cleanup discipline.
- Fastify: fresh JS framework-style exact-source endurance case.

The rule is: tune broad behavior classes, not repo names. Repeat aggregation should be reused on fresh holdouts after canaries pass.

## Implementation

Added:

- `kairn bench endurance --repeat <n>`
- `runBenchmarkEnduranceRepeats(...)`
- `BenchmarkEnduranceRepeatReport`
- per-mode aggregate fields:
  - median observed Codex tokens,
  - median saved tokens,
  - median savings rate,
  - quality pass count,
  - active/passive count,
  - valid savings count,
  - over-assist count,
  - harmful count,
  - missed opportunity count,
  - classification counts,
  - verdict.

Verdicts:

- `consistent_win`
- `mixed`
- `consistent_loss`
- `passive_only`
- `quality_risk`
- `insufficient_data`

Also fixed classification:

- Passive/suppressed modes that use more tokens than baseline now classify as `passive_token_regression`, not `missed_savings_opportunity`.

## Fastify Repeat-2 Holdout

Artifact:

- `/tmp/kairn-endurance-fastify-repeat2-20260512.json`

Model:

- `gpt-5.4-mini`

Modes:

- baseline
- direct Kairn
- hook full-prime

Aggregate result:

| Mode | Quality | Median Tokens | Median Savings | Active | Passive | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 2/2 | 120,194.5 | control | 0 | 0 | baseline |
| direct Kairn | 2/2 | 67,063 | 45.64% | 2 | 0 | consistent_win |
| hook full-prime | 2/2 | 140,585.5 | -17.15% | 0 | 2 | passive token regression after classification fix |

Per-repeat tokens:

| Repeat | baseline | direct Kairn | hook full-prime |
| ---: | ---: | ---: | ---: |
| 1 | 137,250 | 88,466 | 158,997 |
| 2 | 103,139 | 45,660 | 122,174 |

Interpretation:

- Direct Kairn produced a real repeat-positive result on a fresh framework-style endurance suite.
- Hook was correctly quiet/passive, but the installed hook mode still had higher observed tokens than baseline. That is not an active Kairn failure, but it is product overhead/variance that must be tracked as negative passive evidence.
- This supports the selective-governor direction: direct/session-bound Kairn can be very strong; automatic hook needs stricter activation and overhead discipline before beta claims.

## Current Beta Read

Positive:

- Repeat-aware endurance aggregation is now available.
- Direct Kairn beat baseline on Fastify repeat-2 with quality passing.
- The report separates active wins from passive/suppressed evidence.
- Classification now distinguishes passive token regression from missed savings opportunity.

Not enough yet:

- One fresh repeat-2 suite is not enough for a broad beta claim.
- Hook full-prime still needs better product overhead control.
- MCP/hybrid should be rerun through the repeat aggregator after hook/direct are stable.

## Next Validation Slice

Run repeat-2 or repeat-3 with:

- Requests: known positive canary.
- Gin: cheap single-source abstention canary.
- Fastify: fresh JS framework-style source invariant.
- Axios or Flask: companion/source-invariant cleanup canary.

Recommended modes:

- baseline
- direct Kairn
- hook full-prime
- real MCP-first, after hook overhead is understood
- hybrid, after MCP is understood

Success standard:

- quality passes,
- active Kairn wins outnumber active over-assists,
- passive/suppressed runs do not get counted as wins,
- passive token regressions are visible,
- improvements are framed by behavior class, not repo name.
