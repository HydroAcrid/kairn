# PR #3 Full Merge Proof Plan

## Objective

Prove `fix/governance-routing-followup` is merge-ready and superior to current
`main` before merging PR #3.

This is not a small proof loop. The branch must beat or match current Kairn and
direct baseline across official SWE-Pro rows, while preserving MCP behavior.

Current status:

- PR branch is rebased on current `origin/main`.
- Proxy gate passed for prior failure controls and the fresh 12-row slice.
- A previous live attempt under `live-pr-fresh-12/` is invalid because Codex CLI
  was failing from local config before patch generation. Treat that folder as
  diagnostic only and do not count it.
- Codex CLI and Docker are now healthy enough to begin live reruns.

## Merge Gates

PR #3 can merge only if all gates pass:

- PR official pass rate is at least current `main` Kairn pass rate.
- PR official pass rate is at least direct baseline pass rate.
- PR pass/pass median token savings is positive.
- PR has no repeated harmful-assist class.
- PR has no repeated scope-violation class.
- PR has no unresolved `quality_incomplete` rows in the final counted set.
- Token regressions are isolated and not repeated by behavior class.
- MCP repeat-3 gate passes with useful attribution.
- Only safe summaries, manifests, and CSVs are tracked.

## Branch Hygiene

- Keep PR #3 draft until all gates pass.
- Rebase the branch onto latest `origin/main`.
- Build and record two CLIs:
  - current main: `/Users/kevindotel/Documents/Projects/kairn-npm-beta/dist/cli.js`
  - PR branch: `/Users/kevindotel/Documents/Projects/kairn/dist/cli.js`
- Record SHAs for both in the final evidence report.

## Local Validation

Run before live spend:

```bash
pnpm vitest run tests/bench.test.ts tests/runtime.test.ts tests/semantic.test.ts tests/scope.test.ts tests/campaign.test.ts tests/cli.test.ts
pnpm vitest run tests/mcp.test.ts tests/watch.test.ts tests/bench.test.ts --testNamePattern "MCP|mcp"
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Failure here blocks live campaigns.

Already completed after the proxy-parallelism harness fix:

- `pnpm vitest run tests/campaign.test.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

Run the narrower focused suites again after any code fix before resuming live
campaigns.

## Proxy Gate

Proxy checks run before Codex/Docker spend.

Required proxy rows:

- Prior failing/fixed classes:
  - OpenLibrary paired source / request body token regression.
  - Vuls converter/output-adapter routing.
  - Element DeviceListener ownership.
  - Element discovery/listener ownership.
- Unresolved quality-incomplete rows from prior slices:
  - `20260610/swe-pro-official-fresh-slice-governance-pr`: rows 2, 6, 12.
  - `20260610/swe-pro-post-fix-10-row-recheck`: rows 1, 4, 6.
- Controls:
  - at least four prior clean savings rows.
  - at least two quality/source-focus rescue controls.

Proxy failures block live spend unless the failure is clearly an intended
`evidence_needed` or `suppression_expected` behavior with a documented reason.

Completed proxy artifacts:

- `proxy-pr-prior-failure-controls`: 4/4 passed.
- `proxy-pr-fresh-12-serialized`: 12/12 passed.

Do not use `proxy-pr-fresh-12` as final evidence because it was interrupted
before summary generation during the old CPU-bound proxy parallel behavior.

## Execution Sequence

Run the proof in this order:

1. Rebuild the PR CLI after any code changes.
2. Run PR live fresh-12 into a clean outdir:
   `live-pr-fresh-12-after-codex-config`.
3. Run current-main live fresh-12 from the same manifest using
   `KAIRN_CLI_PATH=/Users/kevindotel/Documents/Projects/kairn-npm-beta/dist/cli.js`.
4. Run official evaluator for direct baseline, current-main Kairn, and PR Kairn
   patches.
5. Aggregate PR versus main versus baseline:
   - official pass rate;
   - pass/pass median savings;
   - token regressions by behavior class;
   - quality rescues;
   - harmful assists;
   - scope violations;
   - quality-incomplete rows.
6. If the fresh-12 proof passes, run the additional 10-row confirmation.
7. Run MCP smoke and repeat-3 endurance gate.
8. Write the final report and only then move the PR out of draft.

If a live row is `quality_incomplete`, has no patch, has missing token data, or
is interrupted, rerun it. Do not count it as proof.

## Official SWE-Pro A/B/C Campaign

Run the same row set against:

- `baseline`: direct Codex, no Kairn.
- `main_kairn`: current `main` Kairn CLI.
- `pr_kairn`: PR #3 Kairn CLI.

The current campaign harness does not have separate `main_kairn` and `pr_kairn`
modes, so run two identical Kairn campaigns with different `KAIRN_CLI_PATH`
values, then compare against the same direct baseline row set.

Minimum row set:

- 15 fresh official SWE-Pro rows.
- all unresolved prior rows listed above.
- at least five controls from earlier campaigns.

Target counted set: 20-25 official rows.

Every counted row must include:

- official evaluator result for baseline;
- official evaluator result for current main Kairn;
- official evaluator result for PR Kairn;
- local scope result;
- observed token counts;
- classification.

Rows with harness failures or missing token data must be rerun or excluded with
an explicit reason. They cannot be silently counted as proof.

## MCP Gate

Run MCP after the CLI official gate is locally promising:

- MCP smoke records real MCP calls.
- Click endurance repeat-3 passes.
- Fastify endurance repeat-3 passes.
- At least one non-Python suite passes.
- Actual MCP calls and useful returned/attributed files are recorded.
- No repeated MCP broad-fanout, missing-attribution, quality-drop, or scope
  violation class appears.

MCP proof should use the current branch, not prior stale artifacts, unless the
final report clearly labels older artifacts as historical/supporting only.

## Fix Loop

If any repeated failure class appears:

1. Pause the campaign.
2. Implement the smallest general governance/routing/sizing fix.
3. Run local validation.
4. Rerun affected rows.
5. Rerun at least two unaffected clean controls.
6. Resume the full gate only after the behavior is stable.

No repo-specific gates, row-specific hacks, or public claim changes are allowed.

Do not keep iterating forever on isolated noise. A single isolated token
regression can be accepted only if:

- quality passes;
- local scope passes;
- the behavior class does not repeat;
- pass/pass median savings remains positive;
- PR pass rate still matches or beats current main and direct baseline.

Repeated token regressions in the same behavior class require a fix and rerun.

## Final Report

Write the final tracked report under:

`docs/publication-evidence-20260622/governance-routing-final-pr-proof/`

Tracked files:

- `campaign-manifest.json`
- `campaign-summary.json`
- `results.csv`
- `failures.csv`
- `proxy-results.csv`
- `kairn_governance_routing_final_pr_proof_2026-06-22.md`

Do not track raw prompts, patches, source, diffs, branch names, repo workspaces,
official evaluator raw output, or private telemetry.

## Final Merge Decision

Merge PR #3 only when the final report can state all of the following:

- PR pass rate is at least current main Kairn pass rate.
- PR pass rate is at least direct baseline pass rate.
- PR pass/pass median token savings is positive.
- Current-main comparison does not show a better quality/savings tradeoff than
  the PR.
- MCP repeat-3 gate passes with real calls and useful attribution.
- The counted evidence set has no unresolved quality-incomplete rows.
- Safe tracked artifacts are complete and raw/private artifacts remain ignored.
