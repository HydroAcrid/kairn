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
