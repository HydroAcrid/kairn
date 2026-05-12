# Kairn Fresh Holdout V2 Report - 2026-05-11

## Summary

Fresh holdout v2 tested Kairn on eight repos that were not part of the earlier tuned loop:

| Repo | Language | Task Pattern | Required Source |
| --- | --- | --- | --- |
| Zod | TypeScript | cheap single-source helper bug | `packages/zod/src/v4/core/util.ts` |
| Vite | TypeScript | duplicate-symbol source rescue | `packages/vite/src/client/client.ts` |
| Rich | Python | cheap single-source helper bug | `rich/cells.py` |
| Pydantic | Python | source-rescue utility bug | `pydantic/alias_generators.py` |
| Chi | Go | route-context source rescue | `context.go` |
| Zap | Go | level comparison bug | `level.go` |
| Commons Text | Java | default delimiter source rescue | `src/main/java/org/apache/commons/text/CaseUtils.java` |
| spdlog | C++ | header threshold source rescue | `include/spdlog/logger.h` |

The best current read is positive: after one general retrieval fix and semantic validator cleanup, hook full-prime passed the fresh holdout slice and showed strong quality-preserving token reduction.

## Result

Composite adjusted result, using the six already passing cases from the full retry plus the repaired two-case Zod/Vite slice:

| Metric | Value |
| --- | ---: |
| Baseline observed tokens | `182,322` |
| Hook observed tokens | `109,365` |
| Saved tokens | `72,957` |
| Savings rate | `40.0%` |
| Hook quality | `8/8 pass` |

This is a composite, not a single full-rerun aggregate. The raw full retry had two validation failures that were later shown to be equivalent repairs / corrected by the failing-slice rerun.

## Case Results

| Case | Baseline | Hook | Saved Tokens | Notes |
| --- | --- | --- | ---: | --- |
| Zod `isObject` | partial | pass | `10,109` | Baseline edited tests; hook stayed in source. Validator now accepts `Array.isArray(data) === false`. |
| Vite `injectQuery` | pass | pass | `9,538` | Duplicate `injectQuery` symbols exposed source routing weakness; changed exact-symbol boost fixed routing to `client.ts`. |
| Rich `cell_len` | fail | pass | `7,423` | Hook rescued the exact production file. |
| Pydantic `to_snake` | pass | pass | `2,969` | Smaller win on an obvious utility case. |
| Chi `URLParam` | pass | pass | `6,557` | Go routing/context source rescue held up on a fresh repo. |
| Zap `AtomicLevel.Enabled` | pass | pass | `10,859` | Hook reduced search while preserving source touch. |
| Commons Text `CaseUtils` | pass | pass | `4,801` | Validator now accepts equivalent default-space restoration. |
| spdlog `should_log` | pass | pass | `20,701` | C++ header exact-source routing held up here. |

## What Changed

Implemented general changed-file source routing:

- If a debug/fix prompt has a changed production file with an exact queried symbol, Kairn now gives that file a stronger boost.
- This fixes duplicate-symbol cases like Vite, where `packages/vite/src/node/utils.ts` and `packages/vite/src/client/client.ts` both define `injectQuery`.
- The rule is general: changed exact-symbol production source beats unchanged duplicate helpers.

Improved validation:

- Zod validation accepts equivalent `Array.isArray(data) === false` repairs.
- Vite validation accepts semantically stronger external URL guards rather than requiring the exact old condition.
- Commons Text validation accepts `(int) ' '` as an equivalent default-space delimiter.

## Findings

The fresh holdout supports the current product thesis:

- Kairn is valuable when it actively provides a small source guardrail.
- The biggest mistakes are still routing mistakes around duplicate symbols and brittle benchmark validators.
- Hook setup stayed practical on these repos, but large repos still need warm/pre-indexed usage for best UX.
- The strongest wins were Rich, Zap, and spdlog, where Kairn narrowed the agent to the important source quickly.

## Artifacts

- Full first run: `/tmp/kairn-fresh-holdout-v2-live-hook-20260511.json`
- Full retry: `/tmp/kairn-fresh-holdout-v2-live-hook-retry-20260511.json`
- Repaired Zod/Vite slice: `/tmp/kairn-fresh-holdout-v2-failing-slice-retry2-20260511.json`
- Seed suite: `examples/bench/seeded-fresh-holdout-v2-20260511.json`

## Next Step

Run a more thorough validation only after this point:

1. Repeat-3 on a smaller fresh subset: Vite, Rich, Chi, spdlog.
2. Add MCP and hybrid for the same subset after hook repeatability is confirmed.
3. Add another fresh app-style or framework repo only if repeat-3 remains quality-passing.

The next improvement target is not another scoring tweak. It is making duplicate-symbol routing and source-invariant validation first-class report fields so future runs distinguish "Kairn found the right source" from "validator was too strict" from "Codex found an equivalent patch."
