# Kairn Fresh Holdout V2 Repeat-3 Report - 2026-05-12

## Summary

This run repeated a smaller fresh holdout subset three times across baseline, hook full-prime, real MCP-first, and hybrid MCP-brief using `gpt-5.4-mini`.

Subset:

- Vite: `injectQuery` relative/absolute URL behavior
- Rich: `_cell_len` cache invalidation
- Chi: `Context.URLParam` duplicate nested route params
- spdlog: `logger::should_log` threshold comparison

Raw artifact:

- `/tmp/kairn-holdout-v2-repeat3-allmodes-20260512.json`

All modes passed quality on all case-runs: `12/12` per mode.

## Aggregate Results

Repeat medians are the primary evidence.

| Mode | Median Tokens | Mean Tokens | Quality | Median Savings vs Baseline |
| --- | ---: | ---: | --- | ---: |
| Baseline | 93,645 | 108,088 | 3/3 reports pass | baseline |
| Hook full-prime | 83,166 | 75,275 | 3/3 reports pass | 11.19% |
| Real MCP-first | 62,647 | 61,143 | 3/3 reports pass | 33.10% |
| Hybrid MCP-brief | 66,309 | 80,599 | 3/3 reports pass | 29.19% |

MCP activation was real:

- Real MCP-first: `16` actual MCP calls across 12 case-runs.
- Hybrid MCP-brief: `8` actual MCP calls across 12 case-runs.

## Per-Case Repeat Classification

| Mode | Case | Median Savings | Verdict | Notes |
| --- | --- | ---: | --- | --- |
| Hook full-prime | Rich | 66.91% | consistent win | Strong one-file source rescue. |
| Hook full-prime | Chi | 70.35% | consistent win | Hook context was very useful for Go routing source. |
| Hook full-prime | Vite | 15.37% | volatile | Two wins, one over-assist. |
| Hook full-prime | spdlog | 2.36% | volatile | Two wins, one over-assist; effectively neutral. |
| Real MCP-first | Chi | 48.62% | consistent win | Best repeat-stable MCP case. |
| Real MCP-first | Vite | 41.99% | volatile | Useful but still one over-assist repeat. |
| Real MCP-first | Rich | 27.68% | volatile | Two wins, one over-assist. |
| Real MCP-first | spdlog | -10.03% | over-assist | Repeated over-assist on cheap C++ exact-source case. |
| Hybrid MCP-brief | Vite | 42.58% | volatile | Useful but not yet stable. |
| Hybrid MCP-brief | Chi | 42.93% | volatile | Two wins, one over-assist. |
| Hybrid MCP-brief | Rich | -8.90% | over-assist | Hybrid adds overhead on a cheap source-rescue task. |
| Hybrid MCP-brief | spdlog | -10.35% | over-assist | Same cheap C++ exact-source weakness as MCP-first. |

## Findings

1. Real MCP-first was the best aggregate mode on this subset.
   It beat baseline by `33.10%` median while preserving quality and recording actual MCP calls.

2. Hook full-prime remains useful, but less dominant on this subset.
   It won strongly on Rich and Chi, but Vite/spdlog were volatile.

3. Hybrid MCP-brief is not consistently better than MCP-first.
   It saved `29.19%` by median, but over-assisted on Rich and spdlog.

4. The repeated weak behavior class is cheap exact-source C++.
   spdlog passed, but MCP/hybrid repeatedly spent more tokens than baseline. This points to a stronger `cheap_single_source` abstention rule for MCP/hybrid, especially when the primary production header is obvious and no companion evidence is needed.

5. Future large matrices should write partial reports per mode.
   The all-mode repeat-3 live run completed, but took long enough that partial result persistence would make live testing less brittle.

## Next Improvements

- Tighten MCP/hybrid abstention for cheap exact-source tasks:
  - if one production file dominates,
  - no failure stack/test evidence requires companion context,
  - and companion confidence is generic/noisy,
  - return no MCP next call or an ultra-minimal guardrail.

- Keep MCP-first as a serious candidate for long-session/default-agent workflows, but do not promote hybrid until it reduces Rich/spdlog over-assist.

- Add partial-result persistence to `bench prove` repeat mode so long live matrices are recoverable.

- Run a new fresh subset after the MCP/hybrid abstention change, preferably with at least one more C++/Go case to confirm this is behavior-class improvement rather than spdlog-specific tuning.
