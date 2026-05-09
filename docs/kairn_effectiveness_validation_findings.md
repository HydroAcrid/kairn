# Kairn Effectiveness Validation Findings

Date: 2026-05-07

## Summary

Kairn is now strong enough to validate with deterministic replay benchmarks before spending more live Codex quota. The replay results show that Kairn can usually surface the right implementation files early, separate UI intent from backend/parser intent, find related tests, and link synthetic hook failures to relevant files.

The main remaining weaknesses are retrieval ordering for workflow-specific queries and response-size control. The clearest example is the job tracker sync/review queue query: Kairn found all expected files, but ranked broader Gmail/job-domain files above the review queue/API files.

No live Codex agent benchmark was run during this pass.

## Verification

The Kairn repo was clean from a build/test perspective before benchmark validation:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Results:

- `pnpm test`: passed, 10 test files, 48 tests.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.

## Benchmark Runs

### Kairn Self Replay

Command:

```bash
pnpm kairn bench run --root /Users/kevindotel/Documents/Projects/kairn --mode replay --json
```

Run id:

```text
bench_50e7a67b-8dd4-4fd8-8394-dffcdbd9c597
```

Result:

- Overall score: `79.97`
- Acceptance threshold: `>= 75`
- Status: pass

Notable cases:

- `parser-backend-context`: `99.9`
- `related-tests`: `100`
- `hook-failure-linking`: `100`
- `diff-review`: `20`

Finding:

The weak `diff-review` result is mostly a suite expectation problem. The default suite expected `src/bench/agent.ts`, but the actual dirty diff involved benchmark/eval implementation files such as `README.md`, `src/cli.ts`, `src/runtime/KairnRuntime.ts`, `src/store/sqliteStore.ts`, and `src/types.ts`.

### Job Tracker Default Replay

Target repo:

```bash
TARGET_REPO="/Users/kevindotel/Documents/Projects/new-site/my-portfolio"
```

Commands:

```bash
pnpm kairn init --root "$TARGET_REPO"
pnpm kairn bench run --root "$TARGET_REPO" --mode replay --json
```

Run id:

```text
bench_dc6ee91c-eb09-4fa7-ba4c-f6468e49dd12
```

Result:

- Overall score: `82.28`
- Acceptance threshold: `>= 70`
- Status: pass

Notable cases:

- `ui-layout-context`: `99.9`
- `parser-backend-context`: `99.9`
- `owner-auth-context`: `73.9`
- `related-tests`: `100`
- `diff-review`: `20`
- `hook-failure-linking`: `100`

Findings:

- The UI layout case correctly ranked `src/app/private/jobs/JobsApplicationsTable.tsx` and `src/app/private/jobs/JobsDashboardTabs.tsx` first.
- The parser/backend case correctly surfaced backend job files and did not invert into UI files.
- The hook failure case linked a synthetic failure to the expected auth test file.
- `owner-auth-context` found `src/lib/jobs/access.ts`, but missed `src/app/api/auth/[...nextauth]/route.ts`. This may be partly a default-suite expectation issue because the query was about job owner scoping, and the returned files were mostly job access/API files.
- `diff-review` again appears to reflect stale or overly generic suite expectations rather than a core retrieval failure.

### Job Tracker Focused Replay

Suite:

```text
/tmp/kairn-job-tracker-suite.json
```

Command:

```bash
pnpm kairn bench run --root "$TARGET_REPO" --suite /tmp/kairn-job-tracker-suite.json --mode replay --json
```

Run id:

```text
bench_f704b821-ce80-448d-8f63-f022c9969d33
```

Report:

```text
/tmp/kairn-job-tracker-focused-report.md
```

Result:

- Overall score: `93.65`
- Compared to default job tracker replay: `+11.37`
- Status: pass

Cases:

| Case | Score | Recall | Top-K | Finding |
| --- | ---: | ---: | ---: | --- |
| `job-mobile-layout` | `98.23` | `100%` | `100%` | Correctly found mobile UI files first. |
| `gmail-parser-rental-filter` | `98.23` | `100%` | `100%` | Correctly found parser/test files, but one UI file appeared later. |
| `owner-scoping-access` | `99.9` | `100%` | `100%` | Correctly found access, private page, and applications API files. |
| `sync-review-queue` | `71.9` | `100%` | `0%` | Found all expected files, but ranked broader Gmail/job-domain files first. |
| `job-tests` | `100` | `100%` | `100%` | Correctly found related job tests. |

## Strong Signals

- UI intent scoring is working for mobile/layout queries.
- Backend/parser intent is working for Gmail/parser/rental filtering queries.
- Owner scoping is discoverable when query terms include `ownerEmail`, `resolveJobsAccess`, and API language.
- Test discovery is strong for the job tracker repo.
- Hook failure linking works in deterministic replay.
- Focused suites give more actionable evidence than the default suite.

## Weak Signals

### Sync Review Queue Ordering

Query:

```text
gmail_job_sync_attempts sync attempts review queue retry ignore add to tracker needs_review requeued
```

Expected files:

- `src/app/private/jobs/JobsReviewPanel.tsx`
- `src/app/api/jobs/sync-attempts/route.ts`
- `src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts`
- `src/lib/jobs/repository.ts`

Actual early files:

- `src/lib/jobs/gmail.ts`
- `src/lib/jobs/types.ts`
- `src/app/private/jobs/JobsSyncButton.tsx`
- `src/lib/jobs/parser.ts`
- `supabase/migrations/20260502000000_job_tracker_resumable_sync_attempts.sql`

Interpretation:

Kairn understands the job/Gmail/sync domain, but does not yet distinguish a review-queue workflow query from general Gmail sync infrastructure. Terms such as `review queue`, `retry`, `ignore`, `add to tracker`, `needs_review`, and `requeued` should create stronger boosts for review-panel, sync-attempt API, attempt-status repository methods, and route files.

### Response Budget Noise

Several context replay cases produced:

```text
Response exceeded the benchmark budget; tune response routing or snippets.
```

Interpretation:

Kairn is finding useful files, but snippets mode still returns too much context. This weakens the token-savings proof because the benchmark can pass file ranking while still producing larger-than-expected responses.

### Default Suite Expectations

The default `diff-review` cases often fail because expected files are static while the real working tree diff changes over time.

Interpretation:

Default diff benchmarks need either fixture-controlled diffs or dynamic expected files generated from the actual dirty diff. Otherwise they measure suite staleness more than Kairn quality.

## Recommended Improvement Areas

Prioritize these before larger architecture changes:

1. Add workflow intent scoring.
   - Detect workflow terms such as `review queue`, `retry`, `ignore`, `add to tracker`, `needs_review`, `requeued`, `attempts`, `sync status`, and `manual correction`.
   - Boost route/UI files that directly implement those workflows.

2. Improve status/value-term matching.
   - Values like `needs_review`, `ignored`, `requeued`, and `sourceEmailId` should strongly boost files containing exact enum/status/API route usage.

3. Tighten snippet budgets.
   - Enforce hard snippet counts or token caps in benchmark mode.
   - Prefer top-ranked file snippets rather than spreading across many adjacent files.

4. Make default benchmark diff cases fixture-backed.
   - Avoid static expected files for live working tree diffs.
   - Use controlled temp repos for diff replay scoring.

5. Add a live Codex validation pass after tuning.
   - Run 2-3 small Codex tasks with hooks enabled.
   - Ingest actual Codex token footers.
   - Compare actual token usage and whether Codex reads/touches Kairn-ranked files.

## Current Conclusion

Kairn is already useful as a deterministic context router. The current evidence supports continuing refinement around scoring and response routing rather than starting a new large subsystem.

The next improvement plan should focus on:

- workflow-aware retrieval,
- tighter snippets,
- better benchmark diff reliability,
- then a small live Codex validation pass.

## Post-Tuning Results

After adding workflow-aware retrieval, stricter snippet budgeting, and informational default diff replay, the validation benchmarks improved:

| Run | Score | Notes |
| --- | ---: | --- |
| `bench_47eb01b6-80a4-4a48-b7bb-a81e68f0f35a` | `100` | Kairn self replay; no recommendations. |
| `bench_eb45ebd8-1f61-4413-b374-9e52b25d747c` | `95.67` | Job tracker default replay; diff case no longer fails on stale expected files. |
| `bench_c2cff1c3-7e61-4413-b374-9e52b25d747c` | `99.33` | Focused job tracker replay; `sync-review-queue` scored `100`. |

The focused `sync-review-queue` case now places all expected files in the top five:

1. `src/lib/jobs/repository.ts`
2. `src/lib/jobs/types.ts`
3. `src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts`
4. `src/app/private/jobs/JobsReviewPanel.tsx`
5. `src/app/api/jobs/sync-attempts/route.ts`

Response-budget warnings were eliminated in the replay output. Remaining default-suite noise is mostly the broad owner/auth expectation around `src/app/api/auth/[...nextauth]/route.ts`, which is not part of the workflow tuning pass.

## Live Codex Validation

Three read-only Codex `exec` probes were run in disposable copies of the job tracker repo:

| Probe | Result | Codex-selected primary files |
| --- | --- | --- |
| Mobile UI | Pass | `JobsApplicationsTable.tsx`, `JobsDashboardTabs.tsx`, `page.tsx`, and optionally `JobsReviewPanel.tsx`. |
| Sync review queue | Pass | `JobsReviewPanel.tsx`, sync-attempt API route, repository, page wiring, dashboard tabs, and ingest. |
| Parser/backend | Pass | `parser.ts`, `parser.test.ts`, `repository.ts`, and `ingest.ts`. |

The first two live runs exposed a Codex hook command issue: hooks were attempted, but every hook failed before Kairn recorded an event. Root cause was the example command:

```json
"command": "${KAIRN_CMD:-kairn} hook ..."
```

Codex executes project hooks under `zsh`; zsh does not split a scalar like `KAIRN_CMD="node /path/to/cli.js"` into command arguments. The hook tried to execute one filename containing a space. The example hook command was updated to use `eval`:

```json
"command": "eval \"${KAIRN_CMD:-kairn} hook ...\""
```

After that fix, all three live Codex probes recorded Kairn hook activity:

| Probe | Hook events | Failures | Metric events | Output tokens | Estimated savings rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mobile UI | `16` | `0` | `40` | `10,672` | `97.8%` |
| Sync review queue | `37` | `0` | `87` | `18,795` | `97.38%` |
| Parser/backend | `30` | `0` | `76` | `21,363` | `97.89%` |

The sync-review run emitted one useful hook recommendation near a linked test/source event.

Live Codex also surfaced a product finding in the sync-review flow: the review panel copy mentions skipped candidates, but the default queue only loads `needs_review` and `error` attempts.

## Observed Usage Follow-Up

The first live Codex numbers showed very high Kairn-estimated savings, but those estimates alone do not answer whether Kairn improves or degrades Codex performance. A clean answer needs observed Codex token usage from paired baseline and Kairn-assisted runs.

Implemented follow-up:

- Agent benchmark runs now parse Codex terminal footers automatically when the command output includes `Token usage: total=... input=... output=...`.
- Benchmark reports now aggregate observed Codex token totals separately from Kairn's estimated savings.
- `kairn bench ab` runs baseline and Kairn-assisted agent commands against the same agent cases in disposable workspaces, then reports observed token deltas.
- Failed agent commands still preserve stdout/stderr enough to parse a Codex footer if Codex printed one before exiting.
- `examples/bench/job-tracker-agent-light.json` provides three read-only live-agent cases matching the current validation areas: mobile UI, sync review queue, and parser/backend.

This makes the next validation pass more credible: replay benchmarks still prove retrieval quality, while live A/B benchmark runs can now show actual Codex token movement.

## First Clean A/B Result

After updating the benchmark runner to capture Codex stderr and parse the current `tokens used` footer, a real three-case `kairn bench ab` pass was run against `new-site/my-portfolio` with the light job-tracker agent suite.

Report file:

```text
/tmp/kairn-real-ab-20260507105143.json
```

Observed Codex usage:

| Case | Baseline tokens | Kairn-hook tokens | Delta | Hook completions | Outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Mobile UI | `65,338` | `87,261` | `-21,923` (`-33.6%`) | `21` | pass/pass |
| Sync review queue | `58,100` | `59,584` | `-1,484` (`-2.6%`) | `26` | pass/pass |
| Parser/backend | `67,935` | `59,717` | `+8,218` (`+12.1%`) | `15` | pass/pass |
| Total | `191,373` | `206,562` | `-15,189` (`-7.94%`) | `62` | pass/pass |

Interpretation:

- Passive hook mode alone did not prove token savings on read-only discovery tasks.
- Kairn degraded observed token usage overall in this run, mostly from the mobile UI case.
- Parser/backend improved, but one improved case is not enough to claim system-wide benefit.
- Hooks completed reliably with zero hook failures, so the integration works mechanically.
- The result suggests Kairn's next validation should test proactive context delivery, not just passive post-tool hooks.

Likely cause:

- Codex was not instructed to ask Kairn for context before scanning, so it still performed broad file discovery and large source reads.
- Passive hooks observe/compress after tools run; they do not stop the first expensive reads.
- For read-only discovery, hook overhead can add transcript/workflow cost without changing Codex's file-selection behavior.

Next improvement direction:

- Add a benchmark mode that injects Kairn's ranked context before Codex starts, or exposes an MCP-first prompt path where Codex is explicitly told to use Kairn before broad scans.
- Add hook throttling for successful read-only commands; post-tool hooks should be reserved for failures, diffs, edits, and high-signal command outputs.
- Compare three modes separately: baseline, passive hooks, and proactive Kairn context.

## Proactive Context Implementation

Implemented next:

- `kairn prime "<task>"` now generates a reusable proactive context brief before an agent starts scanning.
- `prime` uses the existing retrieval stack, includes ranked files/snippets/related files/tests, records `prime_context` metrics, and avoids temp absolute paths in agent-facing output.
- `kairn bench prove` compares three live-agent modes: baseline, passive hooks, and proactive Kairn-preloaded context.
- Proactive benchmark mode generates the prime brief inside the same disposable temp clone that Codex will inspect, then prepends it to the agent prompt.

The next real validation should rerun `examples/bench/job-tracker-agent-light.json` with `bench prove` and judge proactive mode against baseline, not passive hooks.

## First Proactive Proof Result

`kairn bench prove` was run against `new-site/my-portfolio` with the light job-tracker live-agent suite.

Report file:

```text
/tmp/kairn-real-prove-20260507111621.json
```

Observed Codex usage:

| Case | Baseline | Passive hooks | Proactive context | Proactive savings vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Mobile UI | `64,709` | `68,393` | `47,037` | `17,672` |
| Sync review queue | `64,167` | `64,874` | `50,324` | `13,843` |
| Parser/backend | `58,855` | `77,794` | `41,072` | `17,783` |
| Total | `187,731` | `211,061` | `138,433` | `49,298` (`26.26%`) |

Interpretation:

- Proactive context beat baseline in all three cases and saved `26.26%` observed Codex tokens overall.
- Passive hooks again increased observed usage, this time by `12.43%` versus baseline.
- Proactive context saved `34.41%` versus passive hooks.
- All three modes completed with pass outcomes, so token reduction did not come from failed/short-circuited runs.

Conclusion:

- The core Kairn value path is proactive context delivery, not passive hook observation.
- Hooks should remain useful for failures, edits, diffs, and live session telemetry.
- Future optimization should reduce prime brief size and improve response-budget routing, since the proof report still flagged benchmark budget pressure.

## Prompt-Submit Proactive Hook Direction

The next implementation moves proactive context from a wrapper/benchmark path into normal Codex usage:

- `kairn setup codex` installs sessionless Codex hooks in `.codex/`.
- `UserPromptSubmit` can create or reuse a Kairn session from Codex `session_id`.
- High-confidence prompts call `primeContext` with a smaller default budget and return the brief as Codex `additionalContext`.
- Duplicate prompt/turn payloads are suppressed so Codex does not receive repeated prime context.
- `PostToolUse` remains reactive and quiet, focused on failures, linked files, meaningful command output, and telemetry.

This is the product path closest to the intended experience: users install Kairn once, open normal Codex CLI, submit a normal task, and receive proactive context before broad scanning begins.

## First Prompt-Submit Hook Proof Result

After implementing sessionless prompt-submit priming, `kairn bench prove` was run again with the light job-tracker live-agent suite. The "passive hooks" column in this run used the new `kairn setup codex` config inside each disposable benchmark workspace, so it represents normal Codex with prompt-submit proactive hooks enabled.

Report file:

```text
/tmp/kairn-prompt-hook-prove-20260507120631.json
```

Observed Codex usage:

| Case | Baseline | Prompt-submit hook | Manual prime | Prompt-hook savings vs baseline |
| --- | ---: | ---: | ---: | ---: |
| Mobile UI | `44,501` | `48,262` | `68,631` | `-3,761` |
| Sync review queue | `69,132` | `72,702` | `70,935` | `-3,570` |
| Parser/backend | `58,131` | `41,237` | `53,549` | `16,894` |
| Total | `171,764` | `162,201` | `193,115` | `9,563` (`5.57%`) |

Interpretation:

- Prompt-submit hooks beat baseline overall by `5.57%` observed tokens with all cases passing.
- The benefit was concentrated in parser/backend; UI and sync-review were slightly worse than baseline.
- Manual prime lost in this run, which conflicts with the previous `26.26%` proactive win and confirms high live-Codex variance.
- Hooks completed reliably with zero failures, so the setup path works mechanically.

Conclusion:

- Normal Codex plus Kairn prompt hooks is now viable, but not yet consistently high-savings.
- The next optimization should tune prompt-hook prime budget/content by intent and reduce post-tool hook noise during read-only discovery tasks.
- Savings claims should be based on repeated benchmark runs, not a single live pass.

## Substantial Savings Improvement Pass

Implemented next:

- Codex setup is now mode-based: `savings` installs prompt-submit only, `observe` adds useful post-tool hooks, and `debug` installs broad diagnostic hooks.
- Prime context is now profile-based: `ui`, `workflow`, `backend`, `test`, and `generic` profiles use smaller default budgets and compact sectioned output.
- Prompt-submit hooks no longer suppress read-only prompts containing "Do not edit files"; benchmark discovery prompts can now receive proactive context.
- Prompt-submit hooks emit the prime brief directly as additional context instead of wrapping it in a hook recommendation.
- Live-agent benchmark scoring now counts expected files mentioned in agent output, so read-only runs can prove that the model found the right files.
- `bench prove` supports repeated runs, shuffled mode order, and separate prompt-only, prompt+hooks, and manual-prime modes.

Expected next validation:

- Run at least three repeats against `examples/bench/job-tracker-agent-light.json`.
- Treat median observed token savings as the headline number.
- Require expected-file mentions before considering a token-saving run useful.

## First Savings-Mode Proof After Tuning

A one-repeat prompt-only proof was run after profile budgeting and the prompt confidence fix.

Report file:

```text
/tmp/kairn-prompt-only-proof-20260507130649.json
```

Observed Codex usage:

| Mode | Tokens |
| --- | ---: |
| Baseline | `219,259` |
| Prompt-only savings hooks | `163,832` |
| Savings | `55,427` (`25.28%`) |

Per-case result:

- Mobile UI: saved `48,100` tokens and mentioned both expected UI files.
- Sync review queue: increased by `7,111` tokens but mentioned all expected review/API/repository files.
- Parser/backend: saved `14,438` tokens and mentioned all expected parser/ingest/repository/test files.

Interpretation:

- The high-confidence prompt gate fix mattered: read-only prompts containing "Do not edit files" now receive proactive context.
- Quality evidence improved because the live suite now verifies expected file mentions.
- This is promising but still one repeat; the product claim should wait for a repeated median proof.

## Seeded Large-Repo Harness

Kairn now supports seeded agent benchmark cases for harder debugging validation:

- Clone a pinned repo into a disposable temp workspace.
- Apply an optional setup patch or patch file.
- Run setup commands.
- Optionally confirm the seeded failure with `expectedFailureCommand`.
- Run baseline/prompt-only/prompt+hooks/manual-prime Codex commands.
- Run a final `testCommand` to decide whether the agent actually fixed the seeded failure.
- Score observed Codex tokens, expected-file mentions, changed files, excluded-file drift, hook metrics, elapsed time, and pass/fail.

This is the right next validation path because simple discovery tasks are where modern Codex is already efficient. Seeded failures in large JS/TS repos should give Kairn more leverage: failure hooks, expected files, test output, graph neighbors, and proactive context can all work together.

The first implementation is intentionally case-driven through benchmark JSON, not a new benchmark product surface. `examples/bench/seeded-large-js-ts-template.json` documents the shape for large public repositories. Real seeded suites should pin exact commits and keep tests narrow enough to run repeatedly.

Next validation should add at least one real seeded JS/TS debugging suite before making broader savings claims.

## First Real Seeded Large-Repo Codex Runs

Kairn was tested against a pinned `TanStack/query` clone:

- Repo: `https://github.com/TanStack/query.git`
- Ref: `9d1ce70b39d91271356432147d16f5441f9fa892`
- Seeded patch: changed `packages/query-core/src/utils.ts` from `.sort()` to `.reverse()` inside `hashKey`.
- Verification: `grep -q '\\.sort()' packages/query-core/src/utils.ts`

The first attempt failed before Codex ran because the setup patch was malformed. After regenerating the patch from `git diff`, the harness successfully cloned the public repo, applied the patch, ran Codex in disposable workspaces, and verified the final file.

### Exact-Path Prompt

Report:

```text
/tmp/kairn-tanstack-real-codex-write-proof-20260507141837.json
```

Prompt included the exact file path and verification command. All modes fixed the seeded failure:

| Mode | Outcome | Observed tokens | Delta vs baseline | Prime/hook signal |
| --- | --- | ---: | ---: | --- |
| Baseline | pass | `17,723` | - | none |
| Prompt-only savings hook | pass | `19,931` | `-12.46%` | `primeEmitted=1`, `primeTokens=928`, `hookInvocations=1` |
| Prompt + observe hooks | pass | `19,211` | `-8.40%` | `primeEmitted=1`, `primeTokens=928`, `hookInvocations=7` |

Interpretation: this task is too easy for Kairn to help because the prompt already names the exact file and verification command. Kairn adds context overhead.

### Hidden-Path Prompt

Report:

```text
/tmp/kairn-tanstack-hidden-real-codex-proof-20260507142507.json
```

Prompt described the hashing behavior but did not name the exact file path or verification command. All modes still fixed the seeded failure:

| Mode | Outcome | Observed tokens | Delta vs baseline | Prime/hook signal |
| --- | --- | ---: | ---: | --- |
| Baseline | pass | `29,870` | - | none |
| Prompt-only savings hook | pass | `39,579` | `-32.50%` | `primeEmitted=1`, `primeTokens=1001`, `hookInvocations=1` |
| Prompt + observe hooks | pass | `32,343` | `-8.28%` | `primeEmitted=1`, `primeTokens=1001`, `hookInvocations=19` |

The hidden-path prime was actively weak. It did not include `packages/query-core/src/utils.ts`; it ranked broad `useQuery` tests and query-related files instead. Codex found and fixed the correct file without Kairn.

Concrete retrieval failure:

- Query terms such as "stable hashing", "object query keys", and "same properties in different orders" should strongly boost `hashKey`, `hashQueryKeyByOptions`, `partialMatchKey`, and `packages/query-core/src/utils.ts`.
- Broad repo/domain terms like `query`, `query-core`, and `useQuery` overwhelmed exact behavior terms.
- Test-heavy results were over-prioritized even though the task requested a production-source fix.

Conclusion from these real runs:

- The seeded harness works mechanically.
- Modern Codex is strong at repository search on this class of bug.
- Kairn should not claim savings from this seeded class yet.
- The next useful implementation is behavior/symbol-aware retrieval for bug descriptions, especially mapping natural-language behavior to symbols such as `hashKey`.

## Behavior Retrieval Patch

Implemented after the first seeded TanStack runs.

What changed:

- Added behavior-aware scoring for natural-language bug descriptions.
- Detects behavior terms such as `stable`, `hash`, `object`, `same`, `different order`, `sort`, `match`, and `consistent`.
- Boosts matching production symbols such as `hashKey`, `hashQueryKeyByOptions`, and `partialMatchKey`.
- Downranks broad test files when the prompt asks for a production-source fix and does not explicitly ask for tests.
- Adds `behaviorScore` to ranked context output so failures are easier to inspect.
- Preserves ranked file order in prime briefs instead of alphabetizing de-duplicated paths.

Regression target:

```text
Debug a seeded regression in TanStack Query query-core: object query keys with the same properties in different orders no longer hash consistently. Fix the production source.
```

Expected first file:

```text
packages/query-core/src/utils.ts
```

Validation:

- Added a fixture regression test in `tests/semantic.test.ts`.
- Re-ran `kairn prime` against the previous hidden-path TanStack disposable workspace.
- The prime brief now lists `packages/query-core/src/utils.ts` first in both `Start Here` and `Ranked Files`.

This does not prove observed Codex savings yet. It fixes the known retrieval miss that made Kairn harmful on the hidden-path seeded run. The next live Codex proof should rerun the same hidden-path TanStack case and compare against the previous reports.

## Context Quality Layer Patch

Implemented after the behavior patch to address the broader reasons Kairn can still lose to modern Codex.

What changed:

- Added TypeScript language-service graph enrichment on top of Tree-sitter parsing.
- Added persisted BM25 lexical indexing for exact identifiers and status terms.
- Added size guards so TypeScript enrichment and lexical persistence stay best-effort on large monorepos instead of blocking prime.
- Added failure-first context for test/lint/typecheck failures, including CLI and MCP surfaces.
- Routed hook failures through failure context instead of generic compression.
- Added prime quality scoring so exact-path or low-confidence prompts shrink or suppress proactive context.
- Added MCP-first helper tools: `kairn_prepare_task`, `kairn_get_next_context`, and `kairn_get_failure_context`.
- Added transcript-aware feedback extraction for files read, files edited, commands, test commands, and outcome hints without storing raw transcripts.

Validation:

- Added unit/integration tests for TypeScript graph enrichment, BM25 exact matches, failure-first context, prime suppression, MCP tools, and transcript feedback.
- Verification passed with `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- Re-ran `kairn prime` against the previous hidden-path TanStack workspace. It completed without launching Codex, emitted `quality.action = emit`, and ranked `packages/query-core/src/utils.ts` first.

Next validation should rerun the seeded TanStack hidden-path proof. Success means Kairn no longer loses tokens on the hidden-path case; the stronger target is at least 20% median observed token savings on repeated debugging cases.

## Context Quality Layer Live Proof

Report:

```text
/tmp/kairn-tanstack-hidden-hash-live-proof-20260507204224.json
```

After the context quality layer, the same hidden-path TanStack regression was rerun against real Codex agents in disposable workspaces.

| Mode | Outcome | Observed tokens | Delta vs baseline | Prime/hook signal |
| --- | --- | ---: | ---: | --- |
| Baseline | pass | `62,629` | - | none |
| Prompt-only savings hook | pass | `76,343` | `-21.90%` | `primeEmitted=1`, `primeTokens=971`, `hookInvocations=1` |
| Prompt + observe hooks | timeout/fail | unavailable | unavailable | `primeEmitted=1`, `primeTokens=971`, `hookInvocations=20`; seeded verification passed before timeout |
| Manual prime | pass | `40,942` | `+34.63%` | `primeEmitted=1`, `primeTokens=883`, `hookInvocations=0` |

What improved:

- Manual proactive context now works on the hidden-path debugging task.
- Kairn ranked `packages/query-core/src/utils.ts` first and the agent fixed the seeded failure.
- Manual prime saved `21,687` observed Codex tokens versus baseline, roughly `35%`.

What still failed:

- Sessionless `UserPromptSubmit` prompt-hook delivery is not equivalent to prepending the same prime brief to the prompt. It emitted context, but Codex used more tokens than baseline.
- Prompt + observe hooks are still too heavy for savings-oriented usage. The run fixed the seeded file according to verification, but the agent process hit the timeout after `20` hook invocations.
- The benchmark still flags response-budget issues because live agent output is much larger than the benchmark case budget.

Current product implication:

- `kairn prime` / manual preloading is the proven savings path.
- Prompt-submit hooks are mechanically working but behaviorally weaker than manual prime.
- Observe hooks should stay out of the default savings path until they prove a net benefit.

Next implementation target:

- Make normal Codex usage behave closer to manual prime, not just emit hook context.
- Investigate why Codex treats hook `additionalContext` differently from prompt-prepended context.
- Consider a `kairn codex "<task>"` wrapper or setup-generated shell alias that prepends `kairn prime` directly before launching Codex.
- Keep prompt hooks as a fallback, but do not position them as the primary savings interface until repeated proofs show positive median savings.

### Manual Prime Confirmation Pass

Report:

```text
/tmp/kairn-tanstack-hidden-hash-manual-confirm-20260507205523.json
```

A second smaller proof ran only baseline vs manual prime to isolate the proven path.

| Mode | Outcome | Observed tokens | Delta vs baseline | Prime signal |
| --- | --- | ---: | ---: | --- |
| Baseline | pass | `111,959` | - | none |
| Manual prime | pass | `37,820` | `+66.22%` | `primeEmitted=1`, `primeTokens=883`, `hookInvocations=0` |

Combined live result across the two post-quality-layer hidden-path proofs:

- Baseline observed tokens: `62,629`, `111,959`
- Manual-prime observed tokens: `40,942`, `37,820`
- Manual-prime savings: `34.63%`, `66.22%`
- Both baseline and manual-prime runs fixed the seeded failure.
- Manual-prime consistently touched or mentioned `packages/query-core/src/utils.ts`.

Updated interpretation:

- The context quality layer fixed the original hidden-path retrieval failure.
- Manual prime is now a credible savings surface on this debugging class.
- Savings variance is large because baseline Codex behavior varies heavily across runs.
- Product claims should use repeated medians, not single-run highs.
- The next product feature should make the ergonomic default use prompt-prepended prime context, because hook `additionalContext` has not yet matched manual-prime behavior.

## Automatic Mode Matrix Attempt

Artifacts:

```text
/tmp/kairn-auto-mode-matrix-20260507223026.json
/tmp/kairn-auto-mode-baseline-only-20260507224733.json
```

The all-mode matrix process was stopped after four completed modes because the later `manual_prime` leg hung without producing a result. The matrix JSON artifact is empty, so the partial mode results below were recovered from `.kairn/kairn.sqlite`. A baseline-only control was then run separately and completed successfully.

Quality rule for this pass: token savings only count when the seeded verification passes, the expected file is used or mentioned, the run avoids timeouts, and hook failures do not appear. We are not accepting lower-quality behavior just because it uses fewer tokens.

| Mode | Outcome | Observed tokens | Delta vs baseline | Expected file used | Hooks / MCP signal | Notes |
| --- | --- | ---: | ---: | --- | --- | --- |
| Baseline | pass | `67,106` | - | yes | none | Separate control run; touched `packages/query-core/src/utils.ts` and nearby test. |
| Hook tiny directive | pass | `91,668` | `-36.60%` | yes | `1` hook, `587` prime tokens | Too small/directive appears worse than baseline for this case. |
| Hook full prime | pass | `51,548` | `+23.18%` | yes | `1` hook, `883` prime tokens | First hook mode to beat baseline while preserving quality. |
| Hook tiny + failures | timeout/fail | unavailable | unavailable | yes | `43` hook invocations | Seeded verification passed, but agent command timed out; not viable as a savings default. |
| MCP-first | pass | `35,588` | `+46.97%` | yes | `6` Kairn MCP mentions, no hooks | Strongest result in this partial matrix; needs repeat validation and real MCP-call confirmation. |
| Manual prime | no result | unavailable | unavailable | unknown | none | Harness leg hung before a result; this is a harness reliability issue, not a model-quality conclusion. |

Findings:

- `MCP-first` is the most interesting automatic-path result so far: it passed, used the expected file, had no hook overhead, and beat baseline by about `47%` in this run.
- `hook_full_prime` suggests Codex hook delivery can work when the hook receives a rich enough prime. This contradicts the earlier hook-only failure and means the delivery mechanism is not hopeless.
- `hook_tiny_directive` was too weak for this hidden-path debugging task. It passed, but Codex spent substantially more tokens than baseline.
- Failure-only post-tool hooks are still dangerous in live runs. The `hook_tiny_with_failures` leg emitted too many hooks and timed out despite the seed verification passing.
- The benchmark harness needs better isolation and timeout handling around `manual_prime`; the current all-mode run can be blocked by a single stuck leg.

Next test recommendation:

- Run repeated median validation for only the viable modes first: `baseline`, `hook_full_prime`, `mcp_first`, and `manual_prime`.
- Keep `hook_tiny_directive` and `hook_tiny_with_failures` out of default setup until they show repeated quality-preserving savings.
- Treat `mcp_first` as the next serious product direction, but verify whether the agent actually calls MCP tools or is mainly following the instruction text.

## Real MCP Setup Proof

Report:

```text
/tmp/kairn-real-mcp-proof-20260507231627.json
```

After adding real Codex MCP setup, MCP call telemetry, and full-prime hook defaults, the TanStack hidden-hash seeded regression was rerun with real Codex agents in disposable workspaces.

Quality rule remained unchanged: token savings only count when the seeded verification passes, the expected file is used or mentioned, the run avoids timeouts, and hook failures do not appear.

| Mode | Outcome | Observed tokens | Delta vs baseline | Expected file used | Hook signal | MCP signal |
| --- | --- | ---: | ---: | --- | --- | --- |
| Baseline | pass | `97,045` | - | yes | none | none |
| Manual prime | pass | `83,253` | `+14.21%` | yes | none | `0` MCP calls |
| Hook full prime | pass | `46,859` | `+51.71%` | yes | `1` hook, `0` failures, `883` prime tokens | `0` MCP calls |
| Real MCP-first | pass | `56,750` | `+41.52%` | yes | none | `6` MCP mentions, `0` recorded MCP calls |
| MCP-first + full-prime hook | pass | `52,905` | `+45.48%` | yes | `1` hook, `0` failures, `884` prime tokens | `3` MCP mentions, `0` recorded MCP calls |

Interpretation:

- The new defaults produced the cleanest hook result so far: `hook_full_prime` saved about `52%` while preserving quality.
- MCP-first still performed strongly, saving about `42%`, but Kairn recorded `0` actual MCP tool calls in the disposable workspace.
- The current MCP result is therefore not proof that Codex used the Kairn MCP server. It is proof that MCP-first setup/instructions changed Codex behavior enough to reduce tokens on this run.
- `mcp_first_plus_hook_full_prime` saved less than hook-only full-prime in this run, so combining MCP-first text with hook context is not automatically better.
- Manual prime underperformed compared with earlier runs, reinforcing that single-run live Codex numbers are high variance.

Product implication:

- The best currently proven automatic path is full-prime prompt hooks, not MCP tool usage.
- MCP-first remains strategically important, but the immediate blocker is tool invocation reliability: Codex mentioned Kairn tool names but did not produce Kairn-side `mcp_tool_call` metrics.
- Do not claim "MCP saved 42%" yet. The accurate claim is: "MCP-first instructions/config saved 42% in one run; actual MCP tool calls were not confirmed."

Next implementation target:

- Make Codex MCP usage observable end-to-end by forcing or strongly prompting an actual `kairn_prepare_task` call in the benchmark prompt.
- Add a benchmark quality gate: `real_mcp_first` should fail the MCP-specific criterion if `mcpToolCalls === 0`.
- Investigate whether the Codex MCP server config shape is correct for project-local MCP, or whether Codex requires a different config location/field for tool availability.
- Keep `hook_full_prime` as the current default savings path while MCP tool-call reliability is being fixed.

## MCP Failure Investigation

Date: 2026-05-07

Question: why did the MCP proof show Kairn MCP mentions but `0` recorded Kairn MCP calls?

Findings:

- Codex project MCP config is valid in principle. Official Codex docs say MCP servers can be configured in `~/.codex/config.toml` or project-local `.codex/config.toml` for trusted projects.
- Codex's native project instruction file is `AGENTS.md`. Copilot's equivalent is `.github/copilot-instructions.md`, but Codex reads `AGENTS.md` before work starts.
- Kairn's generated MCP config was brittle because it wrote `command = "kairn"`.
- On this machine, `kairn` is not on `PATH`; hooks still worked because the benchmark supplied `KAIRN_CMD`, but MCP config did not use that fallback.
- A contained smoke test using an absolute MCP command proved the Kairn MCP server is discoverable by Codex:
  - Codex emitted a real JSONL `mcp_tool_call` item for server `kairn`, tool `kairn_prepare_task`.
  - Without approval bypass, noninteractive `codex exec` cancelled the MCP call with `user cancelled MCP tool call`.
  - With `--dangerously-bypass-approvals-and-sandbox` in a disposable `/tmp` workspace, the same MCP tool call completed and returned Kairn context.

Conclusion:

- MCP did not fail because Kairn's MCP server is broken.
- It failed because setup and benchmark execution were not actually allowing a Kairn MCP tool call to complete:
  1. The generated project MCP command could not resolve `kairn` unless Kairn was globally installed.
  2. Noninteractive Codex proof runs require an MCP approval/trust path; otherwise Codex may see the tool but cancel the call.

Patch applied:

- `kairn setup codex --mode mcp-first` now writes a concrete executable command for the MCP server when possible, such as `node /path/to/kairn/dist/cli.js`, instead of always writing `command = "kairn"`.
- Existing hook behavior remains unchanged.

Next MCP proof requirements:

- Treat `mcpToolCalls === 0` as an MCP-specific failure, even if token savings are good.
- Run MCP proof with a trusted project and an approval path that permits Kairn MCP calls.
- Parse Codex JSONL for actual `mcp_tool_call` events, not just final text mentions.
- Keep `hook_full_prime` as the current default automatic savings path while MCP is being hardened.

## Full Real Proof After MCP Setup Fix

Reports:

```text
/tmp/kairn-full-real-proof-20260508001013.json
/tmp/kairn-full-real-proof-tokens-20260508001805.json
```

The TanStack hidden-hash seeded regression was rerun after fixing MCP setup to write a concrete executable command. The first pass used Codex JSONL to verify MCP behavior; the second pass used normal Codex output so the harness could parse observed token footers.

Quality rule remained unchanged: a result only counts if the seeded verification passes, the expected production file is used or mentioned, hook failures are absent, and unrelated docs/examples are not touched.

### MCP JSONL Evidence

The JSONL pass proved the corrected MCP setup is now usable:

- `real_mcp_first` recorded `3` actual Kairn MCP tool calls.
- `real_mcp_first` returned `packages/query-core/src/utils.ts` through MCP.
- The run passed seeded verification.
- This fixes the previous `0`-MCP-call blocker.

One harness issue surfaced: Codex JSONL currently reports `input_tokens`, `cached_input_tokens`, and `output_tokens` without `total_tokens`, so the benchmark parser missed observed totals in the JSONL pass. The parser was patched to compute `totalTokens = inputTokens + outputTokens` when total is omitted.

### Token-Footer Evidence

| Mode | Outcome | Observed tokens | Delta vs baseline | Expected file used | Hook signal | MCP signal |
| --- | --- | ---: | ---: | --- | --- | --- |
| Baseline | pass | `37,583` | - | yes | none | none |
| Hook full prime | pass | `17,663` | `+53.00%` | yes | `1` hook, `0` failures, `884` prime tokens | `0` MCP calls |
| Manual prime | pass | `20,483` | `+45.50%` | yes | none, `884` prime tokens | `0` MCP calls |
| Real MCP-first | pass | `24,288` | `+35.38%` | yes | none | `3` MCP calls |
| MCP-first + full-prime hook | pass | `24,824` | `+33.95%` | yes | `1` hook, `0` failures, `1,736` prime tokens | `2` MCP calls |

Findings:

- The corrected MCP path is real now: Codex can call Kairn MCP tools in a disposable repo when the server command is absolute and approvals are bypassed/trusted for the benchmark.
- `hook_full_prime` is still the strongest automatic path in this run, saving `53%` observed tokens while preserving quality.
- `real_mcp_first` is also effective, saving `35%` with actual MCP calls, but it currently returns too many secondary files. That likely explains why it trails full-prime hooks.
- Combining MCP-first and full-prime hooks did not help. It emitted duplicated Kairn context (`1,736` prime tokens) and saved less than hook-only or MCP-only.
- Manual prime remains strong, but hook full-prime outperformed it in this run. This suggests Codex is accepting `UserPromptSubmit` additional context well when the prime is rich and high-confidence.

Product implication:

- Default automatic path should remain `hook_full_prime` for now.
- MCP-first is no longer blocked mechanically, but it needs response slimming before it becomes the primary path.
- The next MCP improvement should make `kairn_prepare_task` and `kairn_get_next_context` return fewer files, tighter reasons, and one or two concrete next reads instead of broad neighbor lists.

## Post-Modularization Hook/MCP Proof + Python Cross-Language Pass

Date: 2026-05-08

After the modularization refactor and Hook+MCP coordination work, the full static verification suite was rerun:

```text
pnpm test
pnpm typecheck
pnpm build
```

All passed.

Two live Codex proof matrices were then run in disposable seeded workspaces:

```text
/tmp/kairn-ts-hook-mcp-proof-20260508102931.json
/tmp/kairn-python-hook-mcp-proof-20260508103821.json
```

The TypeScript case reused the TanStack Query hidden-hash regression. The Python case added a new public-repo seed using `pallets/click`, with a regression in ANSI-aware terminal width calculation:

- Repo: `https://github.com/pallets/click.git`
- Ref: `fc6c7c47edd6110b6bd5a1a5297b2035214b0cd1`
- Seeded patch: changed `src/click/_compat.py` so `term_len` counts raw ANSI escape codes.
- Verification: `term_len("\033[31mred\033[0m") == 3`

Quality rule remained unchanged: a mode only counts if the seeded verification passes, the expected file is used or mentioned, hook failures are absent, and excluded docs/examples are not touched.

### TypeScript: TanStack Hidden Hash

| Mode | Outcome | Observed tokens | Delta vs baseline | Expected file used | Hook signal | MCP signal |
| --- | --- | ---: | ---: | --- | --- | --- |
| Baseline | pass | `50,722` | - | yes | none | none |
| Manual prime | pass | `51,075` | `-0.70%` | yes | none, `971` prime tokens | `0` MCP calls |
| Hook full prime | pass | `38,177` | `+24.73%` | yes | `1` hook, `0` failures, `883` prime tokens | `0` MCP calls |
| Real MCP-first | pass | `33,564` | `+33.83%` | yes | none | `3` MCP calls |
| Hybrid MCP brief | pass | `31,883` | `+37.14%` | yes | `1` hook, `0` failures, `1,143` prime tokens | `3` MCP calls |

Findings:

- The coordinated `hybrid_mcp_brief` mode beat hook-only and MCP-only in this run.
- Real MCP-first is now genuinely using Kairn tools, not just mentioning them.
- MCP still returned too many secondary files in TypeScript: `real_mcp_first` returned `utils.ts`, but also broad query-codemod/devtools/angular files.
- Manual prime underperformed in this specific run, reinforcing that single-run live Codex numbers are high variance.

### Python: Click ANSI Width

| Mode | Outcome | Observed tokens | Delta vs baseline | Expected file used | Hook signal | MCP signal |
| --- | --- | ---: | ---: | --- | --- | --- |
| Baseline | pass | `60,271` | - | yes | none | none |
| Manual prime | pass | `36,795` | `+38.95%` | yes | none, `567` prime tokens | `0` MCP calls |
| Hook full prime | pass | `23,217` | `+61.48%` | yes | `1` hook, `0` failures, `567` prime tokens | `0` MCP calls |
| Real MCP-first | pass | `52,001` | `+13.72%` | yes | none | `3` MCP calls |
| Hybrid MCP brief | pass | `26,189` | `+56.55%` | yes | `1` hook, `0` failures, `1,091` prime tokens | `2` MCP calls |

Findings:

- Kairn’s universal retrieval layer works on Python well enough to produce meaningful savings, even without a Python language-service graph.
- Hook full-prime was strongest on Python, saving `61.48%` while preserving quality.
- Hybrid also worked well, saving `56.55%`, but MCP-only was much weaker at `13.72%`.
- The Python prime quality is still noisy: manual prime initially surfaced `docs/utils.md` and examples before the correct `src/click/_compat.py`, yet Codex still reached the right file. This points to a clear Python retrieval improvement opportunity.
- MCP returned Python docs/examples too often. Cross-language MCP needs stronger source-vs-doc/example filtering.

### Cross-Language Interpretation

- Hook full-prime remains the safest default automatic mode because it performed well on both TypeScript and Python.
- Hybrid MCP-brief is now worth taking seriously. It beat hook-only on the TypeScript case and nearly matched it on Python, with real MCP calls recorded.
- MCP-only is not ready as the default. It is real and useful, but too broad, especially outside TypeScript.
- Python support is already viable through universal scan/chunk/BM25/context priming, but deeper Python adapter work should target symbol extraction, import relationships, test association, and better source/doc/example ranking.

Next improvement target:

1. Slim MCP returned file sets further, especially docs/examples/codemod/devtools drift.
2. Add language-aware source priority for Python: `src/**/*.py` and package modules should outrank docs/examples unless the prompt asks for docs or examples.
3. Add Python symbol extraction beyond generic chunks so prompts like `terminal width`, `ANSI`, and `visible characters` bind more directly to `term_len` and `strip_ansi`.
4. Keep `hook_full_prime` as the default savings path, but continue benchmarking `hybrid_mcp_brief` because it may become the best long-task mode once MCP context is less noisy.

## Cross-Language Adapter Proof After Parser Expansion

Date: 2026-05-08

After adding Python, Java, and C/C++ parser adapters plus source-vs-noise ranking rules, the static verification suite passed again:

```text
pnpm test
pnpm typecheck
pnpm build
```

The new seeded suite was added at:

```text
examples/bench/seeded-cross-language.json
```

The Java live case could not be run on this machine because Maven is not installed:

```text
mvn: command not found
```

Two live attempts were made. The first broad TypeScript/Python/C++ matrix is not a valid quality proof because the live Codex commands did not explicitly set a writable sandbox and the Python verification command used `python`, while this machine only has `python3`. That run is still useful as a harness finding: benchmark suites must force `--sandbox workspace-write` for fixing tasks and must use portable interpreter commands.

The corrected quality proof used Python and C++ only:

```text
/tmp/kairn-py-cpp-write-proof-20260508114528.json
```

It ran with:

```text
codex exec --model gpt-5.4-mini --sandbox workspace-write
```

Quality rule remained unchanged: a mode only counts if seeded verification passes, the expected production file is used or mentioned, hook failures are absent, and excluded docs/examples are not touched.

### Corrected Python + C++ Proof

| Mode | Case | Outcome | Observed tokens | Delta vs baseline | Expected file used | Hook signal | MCP signal |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| Baseline | Python Click ANSI width | pass | `30,569` | - | yes | none | none |
| Hook full prime | Python Click ANSI width | pass | `20,977` | `+31.38%` | yes | `1` hook, `0` failures | none |
| Real MCP-first | Python Click ANSI width | pass | `25,267` | `+17.34%` | yes | none | `7` MCP mentions |
| Baseline | C++ fmt starts_with | pass | `13,222` | - | yes | none | none |
| Hook full prime | C++ fmt starts_with | pass | `13,512` | `-2.19%` | yes | no completed hook recorded | none |
| Real MCP-first | C++ fmt starts_with | pass | `18,745` | `-41.77%` | yes | none | `5` MCP mentions |

Aggregate observed token deltas:

| Mode | Baseline tokens | Assisted tokens | Savings |
| --- | ---: | ---: | ---: |
| Hook full prime | `43,791` | `34,489` | `21.24%` |
| Real MCP-first | `43,791` | `44,012` | `-0.50%` |

Findings:

- The expanded parser/indexing work did not break quality: Python and C++ both passed verification in baseline, hook full-prime, and real MCP-first.
- Hook full-prime is still the better automatic path across this corrected cross-language proof, but the savings came almost entirely from Python.
- C++ currently does not benefit from Kairn on this small seeded case. Hook full-prime was roughly flat, and MCP-first was substantially worse.
- MCP-first is not ready as the cross-language default. It can steer Codex to the right file, but it adds enough process/tool overhead that it loses on small Python/C++ fixes.
- The benchmark harness needs two fixes before broader claims:
  - fixing tasks must run Codex with an explicit writable sandbox;
  - seeded benchmark `actualFiles` should distinguish seed-patch files from agent-touched files.
- The first invalid matrix showed every case "used" the expected file even when Codex did not edit it, because the seed patch itself made the expected file dirty. That must be corrected before scoring expected-file usage.

Product implication:

- Keep `hook_full_prime` as the default savings mode.
- Keep MCP-first/hybrid experimental for now; it may still be valuable on long multi-step sessions, but this proof says it is not automatically better for small cross-language fixes.
- Prioritize harness reliability before running larger Java/C++ proof claims.
- Next cross-language retrieval work should improve C/C++ exact symbol targeting and make MCP responses smaller than hook primes, not larger.

## 60%+ Savings Pass: Harness Fixes And Cross-Language Smoke

Date: 2026-05-08

This pass implemented the quality-first improvements before making any larger savings claim. Static verification is green after the changes:

```text
pnpm test
pnpm typecheck
pnpm build
```

Implemented changes:

- Added a `failure_debug` prime profile for seeded debugging prompts. It emits a smaller, sharper brief: one primary source file, focused symbol hints, one likely check/test, and a direct instruction to inspect the source before broad searching.
- Added language-aware debug budgets: TypeScript backend/debug around `900` tokens, Python around `650`, C++ around `550`, and Java around `750`.
- Improved cross-language exact retrieval signals for Python ANSI/visible length, C++ `starts_with`/`string_view`, and Java blank/whitespace prompts.
- Reduced BM25 noise from generic words like `debug`, `seeded`, `failing`, and `regression` so exact identifiers matter more.
- Slimmed compact MCP prepare output toward one primary source file, one symbol hint, one likely check/test, and one next tool call.
- Fixed live-agent proof scoring so seeded patch files are tracked separately from agent-touched files.
- Added workspace `.kairn` metrics extraction for actual MCP tool calls, so MCP success can be measured from Kairn-side telemetry, not just text mentions.
- Updated benchmark examples to run Codex fixing tasks with `--sandbox workspace-write`.
- Updated the Python seeded suite to use `python3`.

A corrected Python + C++ exploratory smoke was run with writable Codex workspaces:

```text
/tmp/kairn-py-cpp-smoke-20260508120836.json
```

This was a single-repeat smoke, not a product claim.

| Mode | Aggregate observed tokens | Delta vs baseline | Quality |
| --- | ---: | ---: | --- |
| Baseline | `49,032` | - | both cases passed |
| Hook full-prime | `49,610` | `-1.18%` | both cases passed |
| Real MCP-first | `51,880` | `-5.81%` | both cases passed, but `actualMcpToolCalls = 0` |

Per-case observations:

| Mode | Case | Outcome | Observed tokens | Agent-touched files | Expected-file mentions | Actual MCP calls |
| --- | --- | --- | ---: | --- | --- | ---: |
| Baseline | Python Click ANSI width | pass | `32,135` | `tests/test_compat.py` | `src/click/_compat.py` | `0` |
| Hook full-prime | Python Click ANSI width | pass | `30,109` | none | `src/click/_compat.py` | `0` |
| Real MCP-first | Python Click ANSI width | pass | `17,102` | none | `src/click/_compat.py` | `0` |
| Baseline | C++ fmt starts_with | pass | `16,897` | none | `include/fmt/base.h` | `0` |
| Hook full-prime | C++ fmt starts_with | pass | `19,501` | none | `include/fmt/base.h` | `0` |
| Real MCP-first | C++ fmt starts_with | pass | `34,778` | none | `include/fmt/base.h` | `0` |

Findings:

- The harness fix worked: seed-patch files are no longer counted as agent-touched files. This exposed a real scoring problem from earlier runs.
- The Python baseline passed by changing `tests/test_compat.py` while only mentioning `src/click/_compat.py`. That means expected-file mention is too weak for seeded bug-fix quality. Future seeded cases should require the expected production source file to be touched or should validate behavior in a way that cannot be solved by test-only edits.
- MCP-first still did not produce actual Kairn MCP tool calls in this smoke. Its result must be treated as instructions-only, not MCP success.
- The new failure-debug profile did not produce a cross-language savings win in this smoke. It preserved quality, but did not beat baseline on aggregate tokens.
- The path to `60%+` savings is likely harder seeded failures where the expected source edit is enforced, not small cases where Codex can already infer or bypass the source quickly.

Next required harness improvement:

- Add a seeded-case quality gate for expected production source edits. `expectedFiles` can continue to allow read/mention scoring, but seeded bug-fix suites need a stricter field such as `requiredTouchedFiles` or `requiredSourceFiles` so a test-only workaround does not count as a full-quality pass.
- MCP/hybrid modes should only count as MCP success when workspace metrics or JSONL show `actualMcpToolCalls > 0`.

## Adaptive Context Controller Implementation

Date: 2026-05-08

This pass implemented the adaptive solution from the post-C++ analysis: Kairn should not always inject context. It should emit context when it has high-confidence leverage, shrink when value is uncertain, and suppress when Codex is likely cheaper without help.

Static verification passed:

```text
pnpm test
pnpm typecheck
pnpm build
```

Result:

```text
11 test files passed
99 tests passed
```

Implemented changes:

- Added a central context-value decision layer with `emit`, `shrink`, and `suppress` actions.
- Wired the decision into `primeContext`, prompt hooks, MCP prepare responses, metrics, and benchmark metadata.
- Exact-path prompts now suppress proactive context instead of spending extra tokens.
- Low-confidence C/C++ prompts shrink instead of emitting full-prime context.
- MCP compact prepare now suppresses start files when Kairn has no high-confidence context and tells the agent to call Kairn again after a failure, diff, or more specific target.
- Added `requiredTouchedFiles` to seeded benchmark cases.
- Seeded bug-fix runs now count as full-quality only when required production source files are touched, not merely mentioned.
- MCP benchmark modes now fail the MCP-specific quality gate when no actual Kairn MCP tool call is recorded.
- Updated `examples/bench/seeded-cross-language.json` so TypeScript, Python, Java, and C++ seeded cases require the intended production source file to be touched.

Important behavior change:

- `expectedFiles` still measures retrieval/read/mention quality.
- `requiredTouchedFiles` measures seeded bug-fix correctness.
- A run can pass verification but still be marked `partial` if it only edits tests or mentions the source file without touching the required production file.

This directly addresses the previous smoke-test flaw where Python baseline passed by editing `tests/test_compat.py` while only mentioning `src/click/_compat.py`.

Product implication:

- Kairn's default direction is now adaptive, not always-on.
- Hook full-prime remains the main automatic path, but it can now be suppressed or shrunk when the controller predicts low marginal value.
- Future 60%+ claims should be based only on repeated runs where `qualityGatePassed = true`, `requiredTouchedSatisfied = true`, and MCP modes have actual tool-call evidence.

## Large Repo Proof: Django And Next.js

Date: 2026-05-08

This pass tested the current Kairn system against larger repositories instead of small or medium fixture-style cases. The goal was to check the hypothesis that Kairn's savings should improve as repository size and task complexity grow.

Repos selected:

| Repo | Commit | Approx files | Case |
| --- | --- | ---: | --- |
| `django/django` | `e7f539f813bd56a71ca3c1fbf379f47691002086` | `7,066` | seeded `slugify` lowercase regression |
| `vercel/next.js` | `8f132ea9848b52e6717959d9ced4efda44ab430d` | `28,866` | seeded `isLocalURL` relative URL regression |

The Next.js-scale run was stopped before completion. The disposable workspace `.kairn` directory grew to roughly `8GB`, and the indexing/proof process became CPU-bound. This is a product issue, not a Codex issue: Kairn needs index-size controls, storage compaction, and large-monorepo limits before we can honestly claim it scales cleanly to Next.js-sized repositories.

The first Django run was also invalid because the verification command imported `django.utils.text` without the external `asgiref` dependency available. A second Django run installed `asgiref` into a temp target and produced a valid quality-gated proof.

Valid Django proof file:

```text
/tmp/kairn-large-django-valid-proof-20260508130529.json
```

All three modes passed the task and touched the required production source file, `django/utils/text.py`:

| Mode | Quality | Observed tokens | Delta vs baseline | Elapsed | Required source touched |
| --- | --- | ---: | ---: | ---: | --- |
| Baseline | pass | `15,341` | - | `32.5s` | yes |
| Manual prime | pass | `19,932` | `-29.93%` | `115.6s` | yes |
| Hook full-prime | pass | `36,085` | `-135.22%` | `166.7s` | yes |

The important finding is that Kairn made the large Django case worse even though quality was preserved. The manual prime selected these starting files:

```text
tests/asgi/urls.py
tests/admin_scripts/tests.py
```

Those files were wrong for the seeded regression. The required fix was in:

```text
django/utils/text.py
```

Why this matters:

- Large-repo complexity did not automatically make Kairn better. Bad retrieval scales harm because the assistant spends extra tokens reconciling misleading context.
- The adaptive controller was necessary, but not sufficient. It allowed a prime that looked compact but pointed at the wrong part of the repository.
- Failure/debug prompts are currently too vulnerable to generic terms like `test`, `hello-world`, and failure language. Those terms can over-rank arbitrary tests instead of the production source named by the behavior under test.
- The benchmark harness fix worked: seeded files are now counted as agent-touched only when Codex changes them after the seed patch, and this proof correctly shows `requiredTouchedSatisfied = true`.

Next improvements before more large-repo claims:

- Add hard large-index limits: cap indexed files/chunks/vectors per repo by default, compact SQLite writes, and skip generated/vendor/docs/examples aggressively unless requested.
- Add source-targeting failure routing: for seeded debug prompts, Kairn should prefer production source files with exact behavior/symbol matches over test files unless the failure output explicitly names the test path.
- Add a "wrong-context risk" controller feature: suppress or shrink when top-ranked files are tests/docs and the prompt asks for a production behavior fix.
- Improve Python exact behavior retrieval: `slugify`, `lowercase`, `allow_unicode`, and return-value behavior should beat unrelated test paths.
- Keep the large-repo proof claim honest: current evidence says Kairn can save a lot on some tasks, but it does not yet universally improve large repos.

## Large-Repo Safety And Source-Targeting Fix

Date: 2026-05-08

This pass directly addressed the two failures from the Django/Next.js proof:

1. Next.js-scale indexing created an oversized `.kairn` state directory.
2. Django `slugify` retrieval let example literals and generic test/failure terms outrank the production source file.

Implemented changes:

- Added a default scan cap of `8,000` indexed files. Candidate files are prioritized before hashing/indexing so source, routes, components, schemas, configs, `src/`, `packages/`, `include/`, and package-like modules are kept before docs/examples/generated/test-heavy surfaces.
- Added a semantic chunk cap of `7,500` chunks so vectors and lexical documents cannot grow unbounded on large monorepos.
- `kairn init` now reports when files were skipped by the index cap.
- Retrieval now strips quoted/example literals before keyword, BM25, semantic, and source-priority scoring. This prevents strings like `'Hello World'` and `'hello-world'` from making unrelated `hello` tests look like the best context.
- Behavior routing now understands case/lowercase/slugify regressions and avoids treating generic `case` symbols like `CheckTestCase` as strong production-source evidence.
- Exact-symbol scoring now filters low-value symbols such as `lower`, `upper`, `input`, `output`, and `case` when a more specific query symbol exists.
- Source priority now boosts core utility modules such as `utils`, `helpers`, `core`, `text`, `string`, `common`, and `shared` when they contain exact symbol matches.
- The context-value controller now marks test/doc/non-source top results as `wrongContextRisk` for production-source fixes. In large repos, that suppresses or shrinks the prime instead of emitting confident but misleading context.

Regression check:

```text
kairn prime "Debug a seeded regression in Django slugify: uppercase input no longer lowercases. Fix the production source so slugify('Hello World') returns 'hello-world'." --root /tmp/kairn-large-django --json
```

Before:

```text
tests/asgi/urls.py
tests/admin_scripts/tests.py
```

Intermediate controller-only fix:

```text
tests/modeladmin/test_checks.py
tests/admin_widgets/tests.py
action: suppress
wrongContextRisk: true
```

After source-targeting fix:

```text
django/utils/text.py
tests/admin_widgets/tests.py
action: emit
wrongContextRisk: false
```

The second file is still an imperfect likely-test guess, but the primary context is now the required production source. That is the key correction.

Static verification for the targeted pass:

```text
pnpm exec vitest run tests/semantic.test.ts tests/bench.test.ts tests/scanner.test.ts
pnpm typecheck
pnpm build
```

Large-repo index cap check:

```text
node dist/cli.js init --root /tmp/kairn-large-next
Files indexed: 8000
Ignored candidates: 19801
Skipped by index cap: 19176
.kairn size: 208M
elapsed: 30.46s
```

This does not prove Next.js task quality yet, but it confirms the previous `~8GB` indexing blow-up is now bounded in the same clone.

Next validation step:

- Re-run the valid Django proof and confirm the new source-targeted prime no longer regresses baseline as badly.
- Re-run a Next.js-scale Codex proof now that initialization remains bounded.
- Do not claim large-repo savings until repeated proofs pass quality gates and observed tokens improve.

## Large Repo Retest After Source-Targeting Fix

Date: 2026-05-08

This pass reran the large-repo proofs after adding index caps, example-literal stripping, source-targeting, and wrong-context-risk suppression.

Verification before live tests:

```text
pnpm build
```

### Django Retake

Result file:

```text
/tmp/kairn-large-django-retake-20260508140726.json
```

Quality gate:

- all modes passed verification
- all modes touched `django/utils/text.py`
- no docs/tests/examples were touched

| Mode | Quality | Required source touched | Observed tokens | Delta vs baseline | Elapsed |
| --- | --- | --- | ---: | ---: | ---: |
| Baseline | pass | yes | `20,305` | - | `28.7s` |
| Manual prime | pass | yes | `16,682` | `+17.84%` | `86.1s` |
| Hook full-prime | pass | yes | `26,292` | `-29.49%` | `102.1s` |

Interpretation:

- The catastrophic previous result was fixed. Kairn no longer produced a `-135%` token regression on Django.
- Manual prime was quality-valid and saved `3,623` observed Codex tokens in this single run.
- This is still not a clean “Kairn source prime solved it” result. With the suite's exact prompt wording, Kairn classified the prime as risky and produced a compact suppressed-context brief. The recorded candidate files were still test-heavy:

```text
tests/template_tests/filter_tests/test_slugify.py
tests/admin_scripts/tests.py
```

- The controller did the right thing by suppressing risky context instead of force-feeding the wrong files. The single-run token win may come from lower variance, the suppressive instruction, or Codex taking a shorter path.
- Hook full-prime is still problematic on large repos. Even with only a small prime payload, the automatic hook path increased observed tokens by `5,987` and took longer. Large-repo hook mode needs a warm daemon/pre-indexed state and stricter hook emission rules.

### Next.js Retake

Result file:

```text
/tmp/kairn-large-next-retake-20260508141503.json
```

The Next.js retake is **not a valid savings win** because every mode failed verification.

| Mode | Quality | Required source touched | Observed tokens | Delta vs baseline | Elapsed |
| --- | --- | --- | ---: | ---: | ---: |
| Baseline | fail | no | `81,377` | - | `87.2s` |
| Manual prime | fail | yes | `43,162` | invalid `+46.96%` | `204.0s` |
| Hook full-prime | fail | no | `39,171` | invalid `+51.86%` | `221.7s` |

Important details:

- Baseline mentioned the expected file but did not modify it.
- Manual prime touched `packages/next/src/shared/lib/router/utils/is-local-url.ts`, but the edit failed verification. It removed the `isAbsoluteUrl` early return instead of restoring `if (!isAbsoluteUrl(url)) return true`.
- Hook full-prime saved tokens relative to baseline, but did not touch the required source file and failed verification.
- Therefore the large Next.js token reductions cannot be claimed as product savings. They are quality failures.

Indexing result:

- The previous Next.js indexing attempt ballooned `.kairn` toward `8GB`.
- After the cap, the proof workspace stayed bounded; observed `.kairn` size during the hook leg was about `240MB`.
- The full disposable workspace was about `527MB`, mostly the cloned repo plus `.kairn`.

### Conclusions From The Retake

What improved:

- Large-repo indexing is bounded now.
- Django no longer shows catastrophic Kairn harm.
- Manual/suppressed context can beat baseline on a valid large Python repo case.

What is still broken:

- Hook full-prime is not production-ready for large repos. It can add latency and token cost even when the payload is small.
- The controller suppresses risky context, but retrieval still needs to get the primary source candidate right for more prompt phrasings.
- Next.js showed token savings without quality, which must count as failure.
- The benchmark still reports high response-token counts, which suggests the agent/harness transcript output is large even when the Kairn prime itself is small.

Next improvement priorities:

1. Add warm hook/daemon reuse for large repos so `UserPromptSubmit` does not build an index during the Codex turn.
2. Make hook savings mode more conservative than manual prime. If prime quality is suppressed, the hook should usually emit nothing, not a suppression brief.
3. Add a source-candidate rescue step: if top context is test/doc but an exact production file is mentioned elsewhere in ranked results, promote the production file.
4. Improve Next.js router utility retrieval so `is-local-url.ts` outranks broader `router.ts`.
5. Treat quality-failing token reductions as negative evidence, not savings.

## 2026-05-08 Full Test Flow After Large-Repo Reliability Pass

Local verification:

- `pnpm test`: pass, `106` tests across `11` files.
- `pnpm typecheck`: pass.
- `pnpm build`: pass.
- Replay smoke on Kairn itself: pass, overall score `100`.

Replay artifact:

```text
/tmp/kairn-replay-smoke-20260508155403.json
```

### Django Large-Repo Proof

Suite:

```text
/tmp/kairn-large-django-valid-suite.json
```

Result:

```text
/tmp/kairn-django-fullflow-20260508155640.json
```

This run compared baseline, manual prime, and a pre-indexed `hook_full_prime` path. The hook path ran `kairn init` before Codex so the prompt hook could use existing `.kairn` state instead of indexing during the Codex turn.

| Mode | Quality | Required source touched | Observed tokens | Delta vs baseline | Hook status |
| --- | --- | --- | ---: | ---: | --- |
| Baseline | pass | yes | `23,104` | - | none |
| Manual prime | fail/partial | no | `26,100` | `-12.97%` | none |
| Hook full-prime | pass | yes | `18,897` | `+18.21%` | `1` completed, `0` failed |

Interpretation:

- The pre-indexed hook path is materially better than the previous large-Django hook result.
- `hook_full_prime` passed the quality gate, touched `django/utils/text.py`, and saved about `4,207` observed Codex tokens.
- Manual prime was correctly marked invalid/negative because it did not touch the required production file.
- The new quality-gated reporting is working: lower or higher tokens no longer matter unless the production source gate passes.

### Next.js Large-Repo Proof

Suite:

```text
/tmp/kairn-large-next-valid-suite.json
```

Attempted result:

```text
/tmp/kairn-next-fullflow-20260508160016.json
```

The Next proof did not produce a valid JSON report. The Node process hit a heap OOM during the benchmark:

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

Observed state from the disposable Next workspace:

- Workspace size: `7.3GB`.
- `.kairn/kairn.sqlite`: `3.5GB`.
- `.kairn/kairn.sqlite-wal`: `6.4GB`.
- File inventory rows: `27,176`.
- Symbol rows: `136,702`.
- Semantic chunks: `7,500`.
- Semantic vectors: `7,500`.
- Lexical docs: `937`.
- Graph edges: `5,824,479`.

A targeted `kairn prime` against the same Next workspace was manually stopped after several minutes without returning. This means the issue is not just live Codex overhead; the Kairn large-repo state itself is too expensive to load/query at this scale.

Interpretation:

- The immediate hook fixes improved Django, but Next still exposes a deeper architecture problem.
- The first tiered indexing pass did not prevent graph-edge explosion. The emergency chunk caps bounded semantic chunks, but graph edges still grew into millions.
- The database/WAL size is unacceptable for normal use. Kairn needs edge budgets, relation pruning, lazy graph loading, and query-local expansion before another Next live proof.
- This result supports the tiered adaptive indexing plan, but also shows that tiering must apply to graph edges and runtime loading, not just semantic chunks.

### Current Conclusion

What is now verified:

- Local correctness is green.
- Replay benchmark path is green.
- Pre-indexed prompt hooks can produce quality-valid savings on a large Python repo.
- Quality-gated reports are correctly rejecting invalid savings.

What is still blocking:

- Next-scale graph persistence and loading can OOM.
- Tiered indexing is incomplete because graph edges are still effectively unbounded.
- Targeted context commands can hang on huge workspaces if they load too much state.

Next implementation priorities:

1. Add graph-edge budgets and relationship pruning.
2. Avoid loading all graph edges/vectors for `prime` and prompt hooks; use query-local retrieval first, then expand only the top candidates.
3. Make SQLite WAL checkpointing/cleanup part of indexing completion.
4. Add a large-repo max-state-size guard that aborts indexing with a useful warning before producing multi-GB `.kairn` state.
5. Re-run Next only after the state-size and edge-explosion issue is fixed.

## 2026-05-08 Full Test Flow After Query-Local Indexing

Local verification:

- `pnpm test`: pass, `107` tests across `11` files.
- `pnpm typecheck`: pass.
- `pnpm build`: pass.

### Large-Repo State Bound

Synthetic repo:

```text
/tmp/kairn-synthetic-large-fulltest
```

Shape:

- `25,002` indexed files.
- `12,000` source files.
- `6,000` test files.
- `7,000` extra cold inventory files.

Result:

| Metric | Value |
| --- | ---: |
| Init time | `3.21s` |
| Prime time | `1.16s` |
| Graph edges | `12,001` |
| Semantic chunks | `7,500` |
| State size | `33.0MB` |
| WAL size | `0MB` |

Prime selected:

```text
src/module-5999.ts
tests/module-5999.test.ts
```

Interpretation:

- The O(test × source) edge problem is fixed for this synthetic stress case.
- Query-local prime works from existing state and returns quickly.
- WAL checkpointing is working in this case.

### Cross-Language Exact Source Targeting

Fixture:

```text
/tmp/kairn-crosslang-targeting
```

| Language | Expected source | Result |
| --- | --- | --- |
| TypeScript | `packages/query-core/src/utils.ts` | top file |
| Python | `src/click/_compat.py` | top file |
| Java | `src/main/java/org/apache/commons/lang3/StringUtils.java` | top file |
| C++ | `include/fmt/base.h` | top file |

Weak prompt test:

```text
make this project better maybe improve stuff
```

Result:

- `prime` decision: `suppress`.
- Codex `UserPromptSubmit` hook output: `0` bytes.
- Strong Python prompt hook output: emitted Kairn proactive context.

Interpretation:

- Exact source targeting improved across JS/TS, Python, Java, and C++ without benchmark-specific symbol rules.
- Weak-signal suppression works in the actual Codex hook path, not just CLI prime.

### Django Live Proof

Result:

```text
/tmp/kairn-django-post-tiered-20260508171944.json
```

| Mode | Quality | Required source touched | Observed tokens | Delta vs baseline | Hook status |
| --- | --- | --- | ---: | ---: | --- |
| Baseline | pass | yes | `22,866` | - | none |
| Hook full-prime | pass | yes | `16,393` | `+28.31%` | `1` completed, `0` failed |

Interpretation:

- Automatic hook full-prime produced valid savings on Django after pre-indexing.
- The run touched `django/utils/text.py` and passed verification.
- This is a quality-valid token reduction.

### Next.js Live Proof

Result:

```text
/tmp/kairn-next-post-tiered-20260508172119.json
```

Index state during hook leg:

| Metric | Before | After query-local indexing |
| --- | ---: | ---: |
| Graph edges | `5,824,479` | `10,877` |
| SQLite DB | `3.5GB` | `261.0MB` |
| SQLite WAL | `6.4GB` | `0MB` |
| Semantic chunks | `7,500` | `7,500` |

Live proof:

| Mode | Quality | Required source touched | Observed tokens | Evidence |
| --- | --- | --- | ---: | --- |
| Baseline | fail | yes | `35,387` | invalid |
| Hook full-prime | fail | yes | `36,498` | invalid/negative |

Interpretation:

- The state explosion is fixed enough for Next to complete without OOM.
- Exact source targeting improved: both modes touched `packages/next/src/shared/lib/router/utils/is-local-url.ts`.
- Verification still failed, so no token savings can be claimed.
- Hook full-prime slightly increased tokens on this failed Next case. This is negative evidence for this prompt/task shape, not a product win.
- The DB is just over the `250MB` soft target (`261MB`) but far below the `1GB` hard guard; the next state pass should shave more symbol/chunk/lexical storage.

### Current Answer To The Four Questions

1. **Does state stay bounded on large repos with many tests?** Mostly yes. Synthetic 25k-file state stayed at `33MB`; real Next stayed at `261MB` instead of multi-GB.
2. **Does exact source targeting improve across JS, Python, C++, Java?** Yes in deterministic tests. Next also touched the correct source file in live runs.
3. **Does Kairn suppress itself when retrieval signal is weak?** Yes. The actual Codex prompt hook emitted no context for a weak prompt.
4. **Does it preserve quality gates while saving tokens?** Mixed. Django passed and saved `28.31%`; Next touched the correct file but failed verification, so it counts as invalid/negative evidence.

Next priorities:

1. Reduce Next state below the `250MB` soft target by trimming symbol/lexical storage and compacting low-value chunks.
2. Investigate why the Next edit fails verification even when the correct file is touched.
3. Keep hook full-prime default only for high-confidence cases; the controller should become more conservative on tasks where Kairn can identify the file but not the exact fix.
4. Add repeated proof runs after the Next quality issue is understood; single-run results are still exploratory.

## 2026-05-08 Follow-Up: Symbol Compaction + Query-Local Retrieval

Implemented the general follow-up from the investigation:

- Added large-repo symbol compaction:
  - preserves exported/public and structural symbols,
  - drops low-value local `const`/`let`/`var` symbols in large repos,
  - caps per-file symbol retention.
- Demoted compiled/generated/vendor/devtool paths to shallow inventory.
- Switched `findContext`/`prime` to query-local symbol and lexical-document loading instead of loading every symbol in the repo.
- Changed semantic chunk selection to preserve at least one high-priority chunk per selected file before filling the remaining budget.
- Added delivered-vs-suppressed hook metadata:
  - `primeAttempted`
  - `primeContextDelivered`
  - `primeSuppressed`
  - `hostAdditionalContextBytes`
- Tightened adaptive suppression for vague broad prompts such as “make this project better maybe improve stuff.”

Validation:

| Check | Result |
| --- | --- |
| Full unit suite | `109` tests passed |
| Typecheck | passed |
| Build | passed |
| Synthetic 25k-file repo | `33.7MB`, `12,000` symbols, `12,001` graph edges, `7,500` chunks |
| Reindexed Next temp repo | `66.9MB`, `23,575` symbols, `10,489` graph edges, `7,500` chunks |
| Next local URL prime | `is-local-url.ts` ranked first, `327` tokens, `shrink` decision |
| Weak Next prompt | `suppress` decision |

Interpretation:

- The prior Next bottleneck was symbol storage, not graph storage.
- Symbol compaction reduced the reindexed Next state from the old `~286MB` state to `66.9MB` in the tested temp workspace.
- Exact utility targeting now works from path/symbol metadata even when no semantic chunk is available.
- Kairn now reports whether hook context was actually delivered, which avoids treating suppressed prompt hooks as successful prime emissions.

## 2026-05-08 Follow-Up: Adaptive Budget Policy

Implemented a central adaptive budget policy so high-impact limits are derived from repo scale, symbol/chunk density, query specificity, and state budget instead of being scattered per module.

Wired policy into:

- inventory scanning,
- symbol compaction,
- lexical/BM25 document and term budgets,
- query-local retrieval expansion,
- default prime budget selection.

Validation:

| Check | Result |
| --- | --- |
| Full unit suite | `113` tests passed |
| Typecheck | passed |
| Build | passed |
| Synthetic 25k-file repo | `51.7MB`, `12,000` symbols, `12,001` graph edges, `90,000` lexical terms |
| Reindexed Next temp repo | `105.9MB`, `22,626` symbols, `10,489` graph edges, `90,000` lexical terms |
| Next local URL prime | `is-local-url.ts` ranked first, `578` tokens, `emit` decision |

Interpretation:

- State remains well below the `250MB` soft target while allowing richer lexical coverage than the fixed `30,000`-term budget.
- Budget decisions are now centralized, which makes future tuning evidence-based instead of hunting scattered constants.
- Safety ceilings still exist, but normal operating budgets now scale with repo/query conditions.

## 2026-05-08 Follow-Up: Repo-Matrix Preflight Harness

Implemented a cheap broad-validation layer before live Codex proofs:

- Added `kairn bench matrix --matrix <path>`.
- Added `examples/bench/repo-matrix.json` covering TypeScript, Python, Java, C++, and a weak-signal control.
- The matrix preflight clones or opens repos, runs Kairn indexing, calls `prime`, and scores:
  - index state size,
  - prime latency,
  - expected source file top-k recall,
  - noisy docs/examples/generated drift,
  - weak-prompt suppression.
- Added repo-matrix types and text/JSON reporting.
- Removed a repo-name-specific source-priority shortcut so future broad tests measure general heuristics rather than Django-specific tuning.

Validation:

| Check | Result |
| --- | --- |
| Bench test suite | `115` tests passed |
| Typecheck | passed |
| Build | passed |
| Local matrix CLI smoke | passed: state `37.21MB`, `bm25.ts` in top 5, no noisy docs |

Interpretation:

- Broad testing can now start with retrieval/state preflight before spending live-agent quota.
- The next broad test should run `examples/bench/repo-matrix.json` first. Live Codex runs should only proceed for repo/case pairs that pass state, recall, suppression, and noise gates.

## 2026-05-08 Broad Repo-Matrix Preflight

Ran the broad retrieval/state preflight before spending live-agent quota.

Commands:

```bash
node dist/cli.js bench matrix --matrix examples/bench/repo-matrix.json --workdir /tmp/kairn-broad-matrix --json
node dist/cli.js bench matrix --matrix /tmp/kairn-large-repo-matrix.json --workdir /tmp/kairn-large-matrix --json
```

Saved result files:

- `/tmp/kairn-broad-repo-matrix-results.json`
- `/tmp/kairn-large-repo-matrix-results.json`

### Fixes During The Run

The first broad pass exposed a general C/C++ indexing bug:

- Duplicate parser captures could generate duplicate BM25 lexical document IDs.
- This caused `fmt` indexing to fail with `UNIQUE constraint failed: lexical_documents.root_path, lexical_documents.id`.

Fix:

- BM25 lexical document IDs are now deduplicated with a content-hash suffix when parser/index input produces duplicate preferred IDs.
- Added a regression test for duplicate symbol/chunk lexical documents.

The broad pass also exposed an intent false positive:

- `basic_string_view` was classified as UI because `view` was an overly broad UI intent term.

Fix:

- Removed bare `view` from UI intent terms.
- Added a regression test so technical `string_view` prompts are not classified as UI.

### Broad Matrix Results

| Repo | Language | State | Case | Decision | Top Source | Gate |
| --- | --- | ---: | --- | --- | --- | --- |
| TanStack Query | TypeScript | `58.46MB` | hidden hash | `emit` | `packages/query-core/src/utils.ts` | pass |
| Click | Python | `26.80MB` | ANSI `term_len` | `emit` | `src/click/_compat.py` | pass |
| Apache Commons Lang | Java | `74.42MB` | `StringUtils.isBlank` | `emit` | `src/main/java/org/apache/commons/lang3/StringUtils.java` | fail: latency |
| fmt | C++ | `33.98MB` | `basic_string_view::starts_with` | `emit` | `include/fmt/base.h` in top 2 | pass |
| Local weak-signal control | Mixed | `37.41MB` | vague prompt | `suppress` | none required | pass |

Broad matrix totals:

- `5` repos
- `5` cases
- `4/5` quality-passing cases
- `5/5` repos within state gate

### Large Matrix Results

| Repo | Language | State | Case | Decision | Top Source | Gate |
| --- | --- | ---: | --- | --- | --- | --- |
| Django | Python | `63.81MB` | `slugify` | `emit` | `django/utils/text.py` | fail: latency |
| Django | Python | `63.81MB` | weak prompt | `suppress` | none required | pass |
| Next.js | TypeScript | `77.34MB` | local URL utility | `suppress` | `packages/next/src/shared/lib/router/utils/is-local-url.ts` | pass |
| Next.js | TypeScript | `77.34MB` | weak prompt | `suppress` | none required | pass |

Large matrix totals:

- `2` repos
- `4` cases
- `3/4` quality-passing cases
- `2/2` repos within state gate

### Interpretation

What looks strong:

- State discipline is now good enough for broad preflight:
  - Next stayed at `77.34MB`, far below the previous multi-GB failure mode.
  - Django stayed at `63.81MB`.
  - All tested repos stayed below the `250MB` state gate.
- Exact source targeting is strong across TypeScript, Python, Java, C++, and large TS/Python repos:
  - TanStack: expected file ranked first.
  - Click: expected file ranked first.
  - Commons Lang: expected file ranked first.
  - Django: expected file ranked first.
  - Next: expected file ranked first.
  - fmt: expected file ranked second.
- Weak-signal suppression is working:
  - local vague prompt suppressed,
  - Django vague prompt suppressed,
  - Next vague prompt suppressed.

What still needs work:

1. **Prime latency is the main broad blocker.**
   - Commons Lang took `11.7s`.
   - Django took `11.0s`.
   - Retrieval quality was correct, but the preflight gate failed on latency.
   - Next was acceptable but still high at `6.9s`.

2. **The adaptive controller is too conservative when retrieval is exact.**
   - Next local URL ranked the exact source file first but chose `suppress`.
   - That is fine for avoiding bad context, but it means automatic hook mode would not help even when Kairn has the right answer.
   - This should likely become `shrink`: one file, one reason, one next read.

3. **C++ source targeting works but still prefers a broader header first.**
   - fmt returned `include/fmt/format.h` before `include/fmt/base.h`.
   - `base.h` was still in top 2, so it passes current top-k gates.
   - The next quality improvement is better exact method/class ownership ranking for C/C++ headers.

4. **No live-agent savings claim should be made from this run.**
   - This was intentionally retrieval/state preflight only.
   - It tells us which cases are worth live testing after latency/controller fixes.

### Next Evolution

The broad test points to general improvements, not repo-specific tuning:

1. Add latency profiling inside `primeContext`:
   - time query-local index loading,
   - hybrid scoring,
   - related files,
   - test discovery,
   - formatting.

2. Make `primeContext` lazy for hook/preflight paths:
   - if top result is high-confidence, do not always compute related files and tests before deciding emit/shrink/suppress.
   - for `shrink`, only need top file and one reason.

3. Change context controller policy:
   - high-confidence exact source result + moderate/high savings risk should `shrink`, not `suppress`.
   - `suppress` should be reserved for low-confidence or vague prompts.

4. Improve C/C++ exact owner ranking:
   - boost files containing the exact method symbol or class method range,
   - reduce broad umbrella headers when a narrower exact header has the target symbol.

5. Run live-agent proofs only after the latency/controller pass:
   - good candidates: TanStack, Click, fmt.
   - hold Commons Lang/Django until prime latency is below the gate.
   - use Next for controller validation, not savings claims, until it emits a small useful brief instead of suppressing exact hits.

## 2026-05-08 Post-Latency/Controller Live Proof

Implemented before this pass:

- Added `primeContext` timing metadata:
  - inventory,
  - index refresh,
  - `findContext`,
  - decision,
  - related/test expansion,
  - formatting,
  - total prime time.
- Made `failure_debug` prompts route earlier and skip broad related-file expansion when the profile does not need it.
- Changed high-confidence exact source hits from `suppress` to a compact/shrunk path where appropriate.
- Reduced BM25 repeated-evidence dominance so one large header cannot win purely by repeating broad terms across many documents.
- Added behavior-symbol de-duplication so repeated class/container matches do not outrank a narrower exact method owner.
- Fixed a macOS root canonicalization bug:
  - benchmark workspaces appeared as both `/var/...` and `/private/var/...`,
  - `kairn init` indexed one path while Codex hooks used the other,
  - hooks therefore saw an empty index and suppressed all context,
  - `resolveRoot()` now canonicalizes with `fs.realpathSync.native()`.

Verification:

```bash
pnpm test
pnpm typecheck
pnpm build
```

All passed.

### Retrieval/State Matrix After Fixes

Reports:

```text
/tmp/kairn-broad-repo-matrix-final.json
/tmp/kairn-large-repo-matrix-final.json
```

Broad repo matrix:

| Repo | Result | State | Prime latency | Top files |
| --- | --- | ---: | ---: | --- |
| TanStack Query | pass | `58.5MB` | `3.15s` | `packages/query-core/src/utils.ts` |
| Click | pass | `26.83MB` | `0.56s` | `src/click/_compat.py` |
| Commons Lang | latency fail only | `74.46MB` | `6.31s` | `StringUtils.java` |
| fmt | pass | `34.01MB` | `3.78s` | `include/fmt/base.h` |
| weak local prompt | pass | `37.7MB` | `0.11s` | suppressed |

Large repo matrix:

| Repo | Result | State | Prime latency | Top files |
| --- | --- | ---: | ---: | --- |
| Django slugify | pass | `63.88MB` | `6.32s` | `django/utils/text.py` |
| Django weak prompt | pass | `63.88MB` | `0.27s` | suppressed |
| Next local URL | pass | `77.42MB` | `4.77s` | `is-local-url.ts` |
| Next weak prompt | pass | `77.42MB` | `0.56s` | suppressed |

Interpretation:

- State discipline is now healthy on the broad/large preflight set.
- Exact source targeting improved across JS/TS, Python, Java, and C++.
- fmt now ranks `include/fmt/base.h` first instead of the broader `format.h`.
- Next now ranks `packages/next/src/shared/lib/router/utils/is-local-url.ts` first and emits context instead of suppressing.
- Commons Lang is the only preflight failure, and it is a narrow latency miss, not a retrieval miss.

### Live Proof: TanStack + Click + fmt

Report:

```text
/tmp/kairn-live-ts-py-cpp-proof-rootfix.json
```

Modes:

- `baseline`
- pre-indexed `hook_full_prime`

Aggregate:

| Mode | Observed tokens | Quality-passing report? |
| --- | ---: | --- |
| baseline | `86,201` | no |
| hook_full_prime | `64,261` | no |

Observed token delta:

- `21,940` fewer tokens
- `25.45%` reduction
- **Invalid as a savings claim** because not all quality gates passed.

Case detail:

| Case | Baseline | Hook full-prime | Notes |
| --- | --- | --- | --- |
| TanStack hidden hash | fail, `38,446` tokens | fail, `22,659` tokens | Both surfaced `utils.ts`, but verification timed out/failed and required source was not touched. |
| Click ANSI term length | pass, `34,641` tokens | partial, `23,180` tokens | Hook saved tokens but verification passed without required source touch; quality gate failed for hook. |
| fmt `starts_with` | partial, `13,114` tokens | pass, `18,422` tokens | Hook improved quality and touched `include/fmt/base.h`, but used more tokens than baseline. |

Hook metrics after root canonicalization:

- Hook primes emitted correctly in all three hook cases.
- Prime sizes stayed compact:
  - TanStack: `580` tokens,
  - Click: `575` tokens,
  - fmt: `566` tokens.
- Hook failures: `0`.

### Live Proof: Django + Next

Report:

```text
/tmp/kairn-live-django-next-proof-rootfix.json
```

Modes:

- `baseline`
- pre-indexed `hook_full_prime`

Aggregate:

| Mode | Observed tokens | Quality-passing report? |
| --- | ---: | --- |
| baseline | `54,805` | no |
| hook_full_prime | `46,761` | no |

Observed token delta:

- `8,044` fewer tokens
- `14.68%` reduction
- **Invalid as a savings claim** because the Next case failed verification in both modes.

Case detail:

| Case | Baseline | Hook full-prime | Notes |
| --- | --- | --- | --- |
| Django slugify | pass, `13,184` tokens | pass, `11,936` tokens | Valid quality-preserving savings: `1,248` tokens, about `9.47%`. |
| Next local URL | fail, `41,621` tokens | fail, `34,825` tokens | Both touched `is-local-url.ts`, but both failed verification. Token reduction is negative evidence until the fix quality improves. |

Hook metrics:

- Hook primes emitted correctly in both hook cases.
- Prime sizes:
  - Django: `597` tokens,
  - Next: `610` tokens.
- Hook failures: `0`.

### Current Interpretation

The latest implementation fixed the mechanical blockers:

- hooks no longer silently fail because of temp-path canonicalization,
- primes are compact,
- exact source files are now ranked correctly in the preflight matrix,
- weak prompts suppress,
- state remains bounded.

The main issue is now **agent outcome quality**, not retrieval quality:

- Kairn often points at the right file and reduces tokens.
- But Codex may still fail or solve the seeded check without touching the required production source.
- Those reductions are correctly marked invalid/negative by the quality gate.

The strongest valid result in this pass:

- Django hook full-prime passed and saved `9.47%`.
- fmt hook full-prime passed where baseline did not satisfy the source-touch gate, but used more tokens.

Next improvement direction:

1. Make seeded prompts and quality gates distinguish "verification passes because the source was fixed" from "verification passes by workaround/no-op."
2. Add failure-output-aware primes for live seeded runs so Kairn can include the actual failing assertion/command context, not only the natural-language task.
3. Add optional pre-agent `kairn failure` context when a seed has an expected failing command.
4. Improve TanStack setup/test reliability; current exit `130` makes it hard to judge retrieval quality.
5. For Next, prime should include the exact expected repair shape, not just the target file, because Codex finds the right file but makes the wrong edit.

## 2026-05-08 Benchmark Timing Attribution + MCP Smoke

Implemented before the next full proof:

- Added explicit per-mode setup commands to `bench prove`.
- Setup/index/config commands now run before the live-agent command and are timed separately.
- Agent benchmark metadata now includes:
  - `workspaceSetupMs`,
  - `assistanceSetupMs`,
  - `promptPrepareMs`,
  - `agentElapsedMs`,
  - `codexElapsedMs`,
  - `verificationElapsedMs`,
  - legacy `elapsedMs` as the total harness time for the case.
- This prevents one-time Kairn setup/index work from being mixed into normal Codex wall-clock time.

New proof CLI shape:

```bash
kairn bench prove \
  --baseline-command "<codex command>" \
  --hook-full-prime-setup-command "kairn init --root {root} && kairn setup codex --root {root} --mode savings" \
  --hook-full-prime-command "<codex command>" \
  --real-mcp-first-setup-command "kairn init --root {root} && kairn setup codex --root {root} --mode mcp-first" \
  --real-mcp-first-command "<codex command>" \
  --hybrid-mcp-brief-setup-command "kairn init --root {root} && kairn setup codex --root {root} --mode hybrid" \
  --hybrid-mcp-brief-command "<codex command>"
```

Verification:

```bash
pnpm test
pnpm typecheck
pnpm build
```

All passed.

### MCP Smoke Check

Report:

```text
/tmp/kairn-mcp-smoke-proof.json
```

Smoke setup:

- Created a tiny TypeScript repo under `/tmp/kairn-mcp-smoke-root-*`.
- Started Kairn over stdio MCP.
- Called `kairn_prepare_task`.
- Ran a fake `real_mcp_first` agent command so the benchmark report could inspect workspace metrics.

Result:

```json
{
  "actualMcpToolCalls": 1,
  "actualMcpToolNames": ["kairn_prepare_task"],
  "actualMcpFiles": ["src/app.ts"],
  "mcpSuccess": true,
  "qualityGatePassed": true,
  "setupMs": 603,
  "agentMs": 23,
  "verificationMs": 0,
  "observedTokens": 150
}
```

Interpretation:

- `kairn_prepare_task` is callable through the real MCP server.
- MCP tool calls are recorded in `.kairn` metrics.
- Benchmark scoring sees `actualMcpToolCalls > 0`.
- The next live proof can trust the MCP success gate; MCP modes should still only count when this field is nonzero.

## 2026-05-08 Four-Mode Live Proof: Baseline vs Hook vs MCP vs Hybrid

After the timing-attribution change, ran the requested live matrix:

- `baseline`
- `hook_full_prime`
- `real_mcp_first`
- `hybrid_mcp_brief`

Suite:

```text
/tmp/kairn-seeded-ts-py-cpp-live.json
```

Output:

```text
/tmp/kairn-live-ts-py-cpp-four-mode-rerun.json
```

Before trusting the run, fixed a benchmark scoring bug:

- The harness previously used `git diff` as the primary source-touch signal.
- If the agent correctly restored a seeded file back to the committed clean version, `git diff` became empty.
- That made correct fixes look like "required source was not touched."
- The harness now counts seeded files as agent-touched when their final hash differs from the seeded broken hash, even when the final working tree is clean.

Verification after the fix:

```bash
pnpm test
pnpm typecheck
pnpm build
```

All passed.

### Aggregate Result

| Mode | Observed tokens | Raw delta vs baseline | Report-level quality | Valid savings |
| --- | ---: | ---: | --- | ---: |
| Baseline | `88,394` | - | fail | - |
| Hook full-prime | `60,750` | `31.27%` lower | fail | `0` |
| Real MCP-first | `69,388` | `21.50%` lower | fail | `0` |
| Hybrid MCP-brief | `61,457` | `30.47%` lower | fail | `0` |

Important: report-level quality failed for every mode because the TanStack verification failed in every mode. Token reductions in those aggregate rows are therefore **invalid savings**, not product claims.

### Per-Case Quality

| Case | Baseline | Hook full-prime | Real MCP-first | Hybrid MCP-brief |
| --- | --- | --- | --- | --- |
| TanStack hidden hash | fail, `38,017` tokens | fail, `19,085` tokens | fail, `26,300` tokens | fail, `22,780` tokens |
| Python Click `term_len` | pass, `36,394` tokens | pass, `26,312` tokens | verification passed, MCP gate failed, `24,341` tokens | verification passed, MCP gate failed, `26,465` tokens |
| C++ fmt `starts_with` | pass, `13,983` tokens | pass, `15,353` tokens | verification passed, MCP gate failed, `18,747` tokens | verification passed, MCP gate failed, `12,212` tokens |

Case-level interpretation:

- Hook full-prime produced a valid Python win: `27.70%` lower observed tokens with the required source file fixed.
- Hook full-prime regressed C++: `9.80%` higher observed tokens, despite passing quality.
- Hybrid MCP-brief had the lowest C++ token use, but it did not record an MCP call, so it cannot be treated as MCP evidence.
- TanStack remains the hard failing case; all modes touched `packages/query-core/src/utils.ts`, but verification exited `130`.

### Latency Attribution

Setup is now separated from agent time:

| Mode / Case | Setup time | Codex agent time | Verification time |
| --- | ---: | ---: | ---: |
| Hook TanStack | `4.6s` | `30.8s` | `19.3s` |
| Hook Python | `1.5s` | `50.1s` | `<0.1s` |
| Hook C++ | `2.3s` | `40.8s` | `0.2s` |
| MCP TanStack | `4.7s` | `29.6s` | `19.1s` |
| Hybrid TanStack | `4.6s` | `48.7s` | `19.0s` |

Current latency conclusion:

- Kairn setup/index cost for these seeded repos is roughly `1.5s` to `4.7s`.
- Prompt hook context itself is not the dominant wall-clock cost in this proof.
- Codex agent time dominates and varies heavily by case.

### MCP Finding

`real_mcp_first` and `hybrid_mcp_brief` recorded:

```json
{
  "actualMcpToolCalls": 0
}
```

This means the model did not successfully use Kairn MCP tools during the live proof.

Follow-up MCP smoke with real `codex exec`:

- `codex mcp list` saw the project-local Kairn server when run from an MCP-configured workspace.
- When explicitly prompted to call `kairn_prepare_task`, Codex attempted the MCP tool.
- The MCP call failed before reaching Kairn with:

```text
user cancelled MCP tool call
```

So there are two separate MCP issues:

1. In normal benchmark prompts, Codex does not reliably choose MCP despite instructions.
2. In `codex exec`, an explicit MCP call can be cancelled by the Codex tool layer before Kairn receives it.

Until that is solved, MCP should stay experimental and should not be counted unless `actualMcpToolCalls > 0`.

### Current Product Read

- The hook path is still the only automatic path producing reliable Kairn context in live Codex runs.
- Hook full-prime can reduce tokens while preserving quality on some cases, but not universally.
- MCP is configured correctly enough for Codex to see the server, but it is not yet a dependable savings path in `codex exec`.
- The benchmark quality gate is now stricter and more accurate: clean reverts of seeded files count as source touches, while failed verification still invalidates savings.

Next improvements:

1. Make TanStack verification reliable or replace it with a smaller deterministic TS seeded case.
2. Keep hook full-prime as the main automatic path.
3. Treat MCP as a separate integration issue: first make explicit MCP calls succeed under `codex exec`, then retest MCP-first behavior.
4. Tune language-specific hook decisions: Python benefited; C++ should shrink or suppress unless confidence is very high.
