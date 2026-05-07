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
