# Kairn SWE-Pro Fresh Slice Post-Governor Report - 2026-05-30

## Summary

This fresh SWE-Pro official slice tested the current governance/routing branch after the command/export companion, exact-source guardrail, backend parity, selected-test owner, and source-scope fixes.

The branch is materially stronger on accuracy and scope than the prior run:

- Kairn local quality: `10/10`.
- Kairn official evaluator: `9/9` valid official evaluations passed.
- One row was excluded from official counting because the official evaluator/image path failed, even though Kairn passed local quality.
- Clean official pass/pass savings: 3 rows.
- Clean official pass/pass median reduction: `9.3%`.
- Clean official pass/pass aggregate reduction: `11.4%`.
- Supporting local pass/pass reduction including the NodeBB backend-parity row: `18.0%` aggregate.
- Token regressions: `0`.
- Harmful assists: `0`.

The main conclusion is not a bigger public savings claim. The main conclusion is that the new governance/routing branch preserved quality, fixed several source-focus failures, and eliminated the pass/pass regression pattern in this slice.

## Classification

| Row | Workflow | Baseline | Kairn | Tokens | Classification |
| --- | --- | --- | --- | --- | --- |
| 1 | Teleport kubectl session uploader | Local fail | Official pass | `203k -> 176k` | Quality/scope rescue |
| 2 | OpenLibrary list request handling | Official pass | Official pass | `61k -> 58k` | Clean official pass/pass savings |
| 3 | Vuls trivy converter | Official pass | Official pass | `77k -> 70k` | Clean official pass/pass savings |
| 4 | Vuls Alpine package mapping | Official fail | Official pass | `99k -> 90k` | Official quality rescue |
| 5 | Teleport session renewal | Not run | Local pass | `n/a -> 123k` | Official harness/image issue |
| 6 | OpenLibrary Solr refactor | Not run | Official pass | `n/a -> 35k` | Kairn-only official pass |
| 7 | NodeBB list backend parity | Local pass | Official pass | `61k -> 39k` | Local pass/pass supporting savings |
| 8 | NodeBB upload directory check | Local fail | Official pass | `62k -> 35k` | Quality/scope rescue |
| 9 | Element device notifications | Local fail | Official pass | `106k -> 52k` | Quality/scope rescue |
| 10 | Element delegated auth metadata | Official pass | Official pass | `37k -> 27k` | Clean official pass/pass savings |

## What Improved

- Backend parity handling now kept the three backend surfaces together and dropped unrelated same-name client files.
- Test-to-source owner handling stopped the Element row from failing official evaluation after the earlier command-contract misclassification.
- Patch extraction now includes untracked files, which fixed an official pass artifact issue on the OpenLibrary Solr row.
- Official patch scopes are stricter when benchmark metadata names concrete production files.
- Scope discipline held across the final Kairn rows.

## Caveats

- Row 5 is excluded from official pass-rate counting because the official evaluator/image path failed.
- Row 7 has local pass/pass savings and Kairn official pass, but baseline official was not rerun after Docker image cleanup.
- Row 9 now passes official evaluation, but Kairn still requested evidence rather than emitting a useful compact selected-test-owner guardrail. That should be a next optimization target.
- Row 10 is a valid pass/pass token result, but Kairn's source hint was weak, so it should not be treated as strong source-routing evidence.

## Recommendation

This branch is merge-candidate quality from a product-behavior perspective, pending review of the changed routing/governor code and artifact hygiene. It should not be used to strengthen public headline savings yet. Public-safe framing is:

> In a fresh 10-row SWE-Pro official slice, Kairn passed every valid official evaluation we completed and showed positive clean pass/pass savings on the rows where both baseline and Kairn passed. The strongest signal was improved source/scope discipline, not a larger headline savings number.
