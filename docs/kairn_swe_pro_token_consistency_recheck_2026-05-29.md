# Kairn SWE-Pro Token Consistency Recheck - 2026-05-29

## Summary

This recheck validates the conditional official-patch sizing changes on the current experimental branch.

Docker was restored and the targeted official rerun is complete. After the follow-up single-file policy fix, the branch clears the targeted recheck gate:

- Official evaluator passes: 5/5.
- Revalidated scope passes: 5/5.
- Clean official savings rows: 4/5.
- Official pass/pass token regressions: 1/5.
- Aggregate pass/pass token delta: 47,105 fewer observed tokens.
- Median pass/pass reduction: 19.2%.

This branch is now ready for a fresh 10-15 row official slice, but it is still not public-claim ready until that fresh slice confirms the improvement.

## Implemented Changes

- Added internal delivery trace metadata for prime outputs:
  - task shape signal,
  - required surface,
  - directive style,
  - guardrail variant,
  - emitted file count,
  - emitted file role summary,
  - edit-scope source,
  - directive/source token estimates,
  - sizing reason.
- Added conditional official guardrail variants:
  - compact exact-source guardrail,
  - lifecycle policy compact guardrail,
  - frontend owner-map compact guardrail,
  - paired-contract compact guardrail.
- Added official paired-row aggregation classification:
  - clean savings,
  - token regression,
  - missing token data,
  - quality rescue,
  - quality drop,
  - scope failure.
- Fixed prompt-required config/schema companion handling:
  - when a task explicitly requires a setting/schema surface, local scope validation allows the declarative config companion alongside the implementation file.
- Fixed prompt-named frontend companion scope validation:
  - when a large frontend task explicitly names feature-local hooks, models, barrel exports, or utilities, local scope validation allows those production companions without allowing unrelated siblings.
- Fixed command/export overclassification:
  - domain phrases like `route-target export` no longer get treated as exporter/CLI command-contract tasks.
- Fixed backend access-policy/frontend overclassification:
  - RBAC/namespace visibility prompts no longer become frontend ownership tasks just because they use words like `view`.
- Added prompt-derived official single-file policy:
  - for official production patch prompts without explicit multi-file, config, lifecycle, or multi-path signals, Kairn now prefers a one-file directive even when retrieval initially finds companions.

## Local Recheck

| Row | Target | Baseline tokens | Prior Kairn tokens | Current Kairn tokens | Reduction | Official result | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 3 | Clean control | 48,151 | 47,978 | 38,922 | 19.2% | pass | One-file policy removed the command/export overclassification regression. |
| 6 | Clean control | 73,083 | 44,709 | 46,114 | 36.9% | pass | Official pass after config-schema companion fix. |
| 8 | Prior regression | 84,330 | 88,264 | 97,704 | -15.9% | pass | Official pass, but lifecycle remains a token regression in the official rerun. |
| 9 | Prior regression | 98,513 | 105,900 | 93,039 | 5.6% | pass | Official pass after frontend companion scope revalidation. |
| 10 | Clean control | 80,593 | 73,333 | 61,786 | 23.3% | pass | One-file policy removed the RBAC/frontend overclassification regression. |

Aggregate official-current rerun:

- Official passes: 5/5.
- Clean-savings rows: 4/5.
- Token-regression rows: 1/5.
- Median pass/pass reduction: 19.2%.
- Total token delta: 47,105 fewer observed tokens.

## Current Read

The quality result is strong: Kairn did not introduce an official failure in this targeted recheck, and the two scope issues found during evaluator reruns were fixed as general companion-surface validation rules.

The token result now clears the targeted gate: row 3 and row 10 moved from official pass/pass token regressions to clean savings after the prompt-derived one-file policy. Row 8 remains the only token regression and should be treated as the next lifecycle/deprecation sizing target.

The next step is a fresh 10-15 row official slice on this branch. Public claims should still wait until that fresh slice confirms pass rate and savings outside the targeted rows.

## Validation

Passed:

- `pnpm vitest run tests/bench.test.ts tests/scope.test.ts`
- `pnpm vitest run tests/bench.test.ts tests/runtime.test.ts`
- `pnpm typecheck`
- `pnpm build`

Official evaluator reruns completed:

- row 3: pass after one-file policy rerun
- row 6: pass after config-schema companion fix
- row 8: pass
- row 9: pass after frontend companion scope fix
- row 10: pass after one-file policy rerun

## Next Steps

1. Run full `pnpm test` and `git diff --check` after the latest scope validation fix.
2. Clean disposable workspaces and confirm Docker/disk health.
3. Run a fresh frozen 10-15 row official slice.
4. Keep row 8 as the next focused optimization target if the fresh slice shows repeated lifecycle/deprecation token regressions.
5. Do not update website or public claims from this branch until the fresh slice passes.
