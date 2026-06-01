# Kairn SWE-Pro Fresh Slice Check - 2026-05-27

## Summary

This run tested the post-guardrail Kairn build on the 12 SWE-Pro rows from the 2026-05-24 candidate set that were not part of the guardrail recheck. It should not be used as a public improvement claim.

Result: the slice failed the gate.

- Rows: 12
- Kairn official evaluator passes: 3/12
- Existing baseline official passes on the same rows: 5/12
- Clean pass/pass savings rows: 0
- Pass/pass token regressions: 2
- Quality/source-focus rescue rows: 1
- Harmful/quality regression rows versus existing baseline: 3

Artifacts:

- `docs/publication-evidence-20260527/swe-pro-official-fresh-slice/fresh-12-summary.json`
- `docs/publication-evidence-20260527/swe-pro-official-fresh-slice/fresh-12-results.csv`
- `docs/publication-evidence-20260527/swe-pro-official-fresh-slice/kairn-live-12.json`
- `docs/publication-evidence-20260527/swe-pro-official-fresh-slice/kairn-live-12.patches.json`
- `docs/publication-evidence-20260527/swe-pro-official-fresh-slice/official-kairn-live-12.stdout.json`

## What This Means

The conditional exact-source guardrail work remains promising on the targeted recheck, but this fresh official slice does not show a stable general improvement yet. The right interpretation is:

- Do not update public SWE-Pro claims from this run.
- Do not run a larger official campaign until the failure classes below are addressed.
- Keep the 25-row campaign and the post-guardrail recheck separated from this failed fresh-slice gate.

## Findings

### Multi-file discovery is still weak

Several official tasks require multiple production files, but normal `kairn codex` runs do not receive hidden golden patch scope. Kairn can still collapse too aggressively toward one visible source surface when the second source file is only implied by behavior.

Implemented follow-up:

- Added benchmark/reporting metadata for prime delivery and guardrail variants.
- Added a general multi-file preservation path when official patch scope metadata is available to the runtime.

Remaining issue:

- Normal user-facing `kairn codex` runs need better prompt-derived multi-file inference without relying on hidden benchmark scope.

### Pass/pass token regressions remain

Two rows passed official evaluation but used more tokens than the existing baseline comparison. This reinforces the earlier conclusion: small official patch tasks and source-focused official rows need conditional sizing, not broad context.

### Large frontend rows remain hard

Element-style frontend rows still failed for both baseline and Kairn in this slice. This is not useful as clean savings evidence, but it remains a product target for better UI ownership inference.

### Reporting needed stronger guardrail metadata

The first live summary did not expose guardrail/delivery metadata from workspace metrics. This is now fixed for future runs by extracting the latest `prime_context` event from the disposable workspace database.

## Next Gate

Before another 10-15 row official slice:

1. Improve prompt-derived multi-file inference for official patch prompts where the task mentions multiple behavioral requirements, interfaces, or selected tests but no second source path.
2. Keep exact-source compact guardrails only when one dominant source is genuinely enough.
3. Add a dry-run audit that flags suspicious one-file delivery when the benchmark row requires multiple production files.
4. Rerun a small control set:
   - 2 rows from this failed slice with hidden multi-file needs,
   - 2 known clean savings rows,
   - 2 known quality/source-focus rows.

Only after that should we run another fresh official slice.
