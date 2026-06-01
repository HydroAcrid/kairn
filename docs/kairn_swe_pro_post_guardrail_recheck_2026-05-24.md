# Kairn SWE-Pro Post-Guardrail Recheck - 2026-05-24

## Summary

This recheck targeted the four official SWE-Pro pass/pass token regressions from the 25-row campaign plus clean-savings and quality/source-focus controls.

Accepted fix:

- Official exact-source guardrails are no longer auto-suppressed by the Codex runtime path.
- This keeps tiny official patch guardrails available when the governor chooses `shrink` with `scope_guardrail`.

Rejected experiment:

- Skipping first-turn prompt delivery for one-file official guardrails reduced tokens in some rows, but caused scope drift and failures in later reruns.
- That experiment is not treated as a valid improvement.

## Current Valid Recheck

Artifact summary:

- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/recheck-summary.current-valid.json`
- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/recheck-results.current-valid.csv`

Results:

- Rows rechecked: 8
- Kairn official evaluator passes: 8/8
- Kairn local scope passes: 8/8
- Clean official pass/pass savings rows: 3
- Remaining official pass/pass token regressions: 3
- Quality/source-focus controls retained: 2
- Pass/pass total saved tokens across the six pass/pass rows: 40,906

Remaining regressions:

- Ansible dumper/filter row: -1,180 tokens vs baseline (-3.1%).
- Ansible `VarsWithSources` row: -3,990 tokens vs baseline (-16.8%).
- OpenLibrary Amazon language metadata row: -14,215 tokens vs baseline (-74.5%).

## Compact Guardrail Body Recheck

Artifact summary:

- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/recheck-summary.compact-guardrail.json`
- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/recheck-results.compact-guardrail.csv`
- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/official-kairn-post-compact-guardrail.stdout.json`

Results:

- Rows rechecked: 8
- Kairn official evaluator passes: 8/8
- Kairn local scope passes: 8/8
- Clean official pass/pass savings rows: 3
- Remaining official pass/pass token regressions: 3
- Quality/source-focus controls retained: 2
- Pass/pass total saved tokens across the six pass/pass rows: 20,707
- Median pass/pass reduction: -2.4%

What improved:

- Ansible dumper/filter row flipped from a small regression to clean savings: 36,342 Kairn tokens vs 38,649 baseline tokens.
- OpenLibrary improved materially versus the current valid recheck: 26,764 tokens vs 33,298, but it remains a regression versus the 19,083-token baseline.
- One quality/source-focus control improved: Vuls scanner dropped from 30,333 to 28,250 tokens while preserving official pass and local scope.

What regressed:

- Ansible `VarsWithSources` worsened from 27,787 to 42,911 tokens.
- Vuls detector/model row moved from a small clean savings row to a token regression: 52,754 Kairn tokens vs 47,599 baseline tokens.
- Two clean-savings controls still saved tokens but used more than the current valid recheck.
- One Flipt quality/source-focus control stayed valid but used more tokens.

## Interpretation

The runtime suppression fix preserved official quality and scope, and one original regression class flipped to clean savings in the valid recheck. The compact guardrail body recheck also preserved official quality and scope, but it was not a net token improvement. It reduced some exact-source rows, but it worsened multi-file or invariant-sensitive rows and several controls.

The pass/pass regression class is improved but not closed. Remaining regressions show that narrow official patch rows still need a better policy than full context, but first-turn guardrails cannot simply be removed in Codex exec mode, and smaller guardrail text alone is not sufficient.

Next optimization target:

- Keep first-turn scope guardrails for safety.
- Make guardrail body size conditional on task shape instead of globally smaller.
- Preserve invariants for rows that need semantic constraints, even when snippets are omitted.
- Avoid companion/context snippets on narrow official patch tasks when exact-source confidence is high.
- Treat missing or unreliable hook delivery as a hard constraint for non-interactive Codex runs.

## Follow-Up Implementation

After this recheck, Kairn moved from a blanket compact official guardrail to conditional official guardrail formatting:

- True one-file exact-source official patch tasks keep the ultra-compact scope guardrail.
- Multi-file official scope, semantic type/merge/config/auth/logging tasks, or invariant-sensitive tasks use a lean semantic guardrail instead.
- The semantic guardrail still omits source snippets and broad related-file lists, but keeps a compact `Preserve:` line so the agent does not lose the behavioral invariant.

This implementation passed local tests, typecheck, build, and diff checks. It still needs an official recheck before replacing the current valid evidence row.

## Conditional Guardrail Official Recheck

Artifact summary:

- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/recheck-summary.conditional-guardrail.json`
- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/recheck-results.conditional-guardrail.csv`
- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/official-kairn-post-conditional-guardrail.stdout.json`
- `docs/publication-evidence-20260524/swe-pro-post-guardrail-recheck/official-kairn-post-conditional-guardrail-row-a-rerun.stdout.json`

Results after the targeted row-A policy fix:

- Rows rechecked: 8
- Kairn official evaluator passes: 8/8
- Clean official pass/pass savings rows: 3
- Remaining official pass/pass token regressions: 3
- Quality/source-focus controls retained: 2
- Pass/pass total saved tokens across the six pass/pass rows: 51,070
- Median pass/pass reduction: 12.9%

What improved:

- The conditional policy preserved official quality after allowing compact guardrails for trivial two-file exact-source scope.
- Pass/pass total saved tokens improved versus the current valid recheck: 51,070 vs 40,906.
- Vuls detector/model became a strong clean-savings row: 21,437 Kairn tokens vs 47,599 baseline tokens.
- OpenLibrary remained a regression versus baseline, but stayed better than the current valid recheck: 27,388 vs 33,298 Kairn tokens.

What still regressed:

- Three pass/pass rows remain token regressions versus baseline: Ansible dumper/filter, Ansible `VarsWithSources`, and OpenLibrary.
- Six of eight rows used more tokens than the current valid recheck, even though pass/pass aggregate savings improved.
- Quality/source-focus controls stayed valid, but token behavior was noisier than the current valid recheck.

Interpretation:

The conditional policy is quality-safe in this recheck and better than the blanket compact policy. It is also better than the current valid recheck on pass/pass total saved tokens. However, it is not clearly better across the whole control set because several controls became more expensive. Treat this as a promising but not final default: it should be tested on a fresh 10-15 row official slice before updating public claims.
