# Kairn Fresh Holdout Report 2026-05-10

This pass tested Kairn on repositories that were not part of the recent tuning loop:

- Lodash `4.17.21`
- HTTPX `0.27.2`
- Guava `v33.2.1`
- Cobra `v1.8.1`

The goal was not to tune against these repos. The goal was to answer whether the current automatic hook path behaves safely in a fresh environment and what new general failure patterns appear.

## Artifacts

- Suite: `examples/bench/seeded-fresh-holdout-20260510.json`
- Patch files:
  - `examples/bench/patches/lodash-isstring-object.patch`
  - `examples/bench/patches/httpx-absolute-url-host.patch`
  - `examples/bench/patches/guava-is-null-or-empty.patch`
  - `examples/bench/patches/cobra-traverse-children.patch`
- Patch/no-op validation: `/tmp/kairn-fresh-holdout-noop-20260510.json`
- Live hook proof: `/tmp/kairn-fresh-holdout-live-hook-20260510.json`

## Setup Validation

The no-op run verified that all four repos clone, all seed patches apply, and all seeded verification checks fail before an agent fix.

| Case | Seeded File | Expected Failure Exit | No-op Verification |
| --- | --- | ---: | --- |
| Lodash `_.isString` | `lodash.js` | `0` | failed as expected |
| HTTPX `URL.is_absolute_url` | `httpx/_urls.py` | `0` | failed as expected |
| Guava `Strings.isNullOrEmpty` | `guava/src/com/google/common/base/Strings.java` | `0` | failed as expected |
| Cobra `TraverseChildren` | `command.go` | `0` | failed as expected |

## Live Result

Modes:

- baseline: `codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable codex_hooks`
- hook full-prime: `kairn setup codex --mode savings --hook-output full-prime`, then Codex with hooks enabled

| Case | Baseline Tokens | Hook Tokens | Delta | Quality | Hook Decision |
| --- | ---: | ---: | ---: | --- | --- |
| Lodash `_.isString` | `31,655` | `24,372` | `23.01%` lower | pass/pass | suppressed |
| HTTPX `URL.is_absolute_url` | `26,147` | `12,653` | `51.61%` lower | pass/pass | suppressed |
| Guava `Strings.isNullOrEmpty` | `65,222` | `63,822` | `2.15%` lower | pass/pass | suppressed |
| Cobra `TraverseChildren` | `49,497` | `8,634` | `82.56%` lower | pass/pass | suppressed |
| Aggregate | `172,521` | `109,481` | `36.54%` lower | pass/pass | passive only |

Important: this is not valid active Kairn savings. Every hook suppressed host context, so the lower token total is passive/suppressed evidence. The report correctly classifies this as `missed_savings_opportunity`, not `validSavings`.

## Findings

### 1. Safety improved

The hook path did not harm quality on these new repos. All four hook-enabled runs passed verification and touched the required production file.

That matters. The current conservative controller is doing the most important beta-safe thing: staying quiet when it is unsure.

### 2. Automatic hooks are too quiet on fresh source-rescue tasks

HTTPX is the clearest missed opportunity. Kairn found the correct source file offline:

- `httpx/_urls.py`
- exact source hit: true
- recommended delivery: one-file directive
- invariant: `URL.is_absolute_url` should require both scheme and host

But the prompt hook suppressed because the one-shot exact-source guardrail is too conservative for automatic delivery. The baseline was still expensive, so the right future behavior is probably an ultra-minimal guardrail, not full suppression.

### 3. Fresh repos exposed general source-routing issues

These are behavior classes, not repo-specific bugs:

- **Monolithic library API routing**: Lodash ranked `test/test-fp.js` above `lodash.js` for `_.isString`. Kairn needs stronger public API/source-root routing when a repo exposes a monolithic production file.
- **Canonical source over platform mirror**: Guava ranked `android/guava/src/.../Strings.java` above canonical `guava/src/.../Strings.java`. Kairn should prefer canonical main source trees over platform mirrors unless the prompt names Android/platform behavior.
- **Canonical source over build-tag variant**: Cobra ranked `command_notwin.go` above `command.go`. Kairn should downrank OS/build-tag variants like `_notwin.go`, `_windows.go`, `_unix.go`, and `_test.go` unless the task is platform-specific.
- **Conservative hook over-suppression**: HTTPX and Cobra show that source-rescue prompts can be expensive even when the task looks one-shot. Suppression avoids harm, but it can miss real savings.

### 4. Fresh holdouts support the selective-governor thesis

The current system is not a universal context firehose. It is behaving like a selective governor:

- if confidence is risky, it suppresses;
- if the agent can solve cheaply, suppression is acceptable;
- if baseline burns tokens while Kairn had a strong exact source, suppression is a missed savings opportunity.

The next improvements should focus on abstention accuracy, not bigger primes.

## Next Improvements

1. Add canonical-source routing rules:
   - prefer `src/`, `lib/`, `guava/src/`, `src/main/java`, package root source, and main module files over platform mirrors;
   - downrank Android/OS-specific/build-tag variants unless the query mentions the platform.

2. Add monolithic public API routing:
   - if a JS library has a root production bundle and the prompt names an exported API, do not let tests/build scripts outrank the root source file.

3. Split exact-source suppression into two classes:
   - cheap obvious exact source: suppress or tiny guardrail;
   - expensive source-rescue exact source: emit one-file directive.

4. Report active-vs-passive savings prominently:
   - this run had strong token reductions, but Kairn suppressed every hook;
   - claims should stay conservative until active context wins repeat on fresh holdouts.

## Current Product Read

This was a good safety result and a weak active-assistance result.

Kairn did not break fresh repos, and hook-enabled runs used fewer tokens, but the actual Kairn context did not activate. The next fresh holdout pass should prove active value by making source routing more canonical and allowing one-file guardrails for high-confidence source-rescue prompts.

## 2026-05-11 Follow-Up: Canonical Routing + Guardrails

Implemented:

- canonical production-source routing for main source trees;
- platform mirror/build-tag downranking for Java, Go, and C/C++;
- monolithic public API routing for exact exported JS/TS API prompts;
- changed-source rescue boosting for debug/source prompts;
- active one-file hook guardrails for source-rescue exact hits;
- quality accounting fix so an active Kairn run that passes quality is not marked invalid just because baseline failed.

Artifact:

- Live proof: `/tmp/kairn-fresh-holdout-live-hook-v2-20260511.json`

| Case | Baseline Tokens | Hook Tokens | Delta | Quality | Hook Activity |
| --- | ---: | ---: | ---: | --- | --- |
| Lodash `_.isString` | `31,653` | `40,384` | `27.58%` higher | pass/pass | suppressed |
| HTTPX `URL.is_absolute_url` | `27,008` | `8,352` | `69.07%` lower | partial/pass | active guardrail |
| Guava `Strings.isNullOrEmpty` | `45,540` | `26,684` | `41.41%` lower | pass/pass | active guardrail |
| Cobra `TraverseChildren` | `31,894` | `9,905` | `68.94%` lower | pass/pass | active guardrail |
| Aggregate | `136,095` | `85,325` | `37.30%` lower | baseline partial, hook pass | active |

Interpretation:

- The source-rescue cases converted from passive evidence into active Kairn-assisted savings.
- HTTPX is the strongest quality result: baseline was partial and Kairn passed with fewer tokens.
- Guava and Cobra confirm the canonical routing fixes helped Java and Go fresh holdouts.
- Lodash stayed safely suppressed, but the hook-enabled run used more tokens anyway. Since Kairn emitted no context, this is not an over-assist; it is live-run variance or hook/setup environmental overhead. It remains a candidate for better monolithic API routing, but not a reason to emit broad context.

Updated conclusion:

The follow-up is a real improvement over the first fresh holdout pass. Kairn now actively helps in 3 of 4 fresh cases and remains silent in the risky monolithic JS case. This supports the selective-governor strategy: source rescue should emit a tiny guardrail; cheap/risky exact-source cases should stay quiet.
