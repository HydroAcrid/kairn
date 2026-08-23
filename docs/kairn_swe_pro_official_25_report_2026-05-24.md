# Kairn SWE-Pro Official 25-Row Evidence Report - 2026-05-24

## Summary

This report combines 5 historical official SWE-Pro seed rows from the 2026-05-18 evidence campaign with a new 20-row official SWE-Pro expansion run on 2026-05-24.

This is **not** presented as one frozen 25-row benchmark. The precise public framing is: **across 25 official SWE-Pro rows from Kairn evidence campaigns**.

## Headline Results

| Metric | Overall 25 rows | New 20-row expansion |
| --- | ---: | ---: |
| Baseline official passes | 15/25 | 13/20 |
| Kairn official passes | 20/25 | 15/20 |
| Clean pass/pass savings rows | 6 | 5 |
| Clean tokens saved | 63,393 | 51,509 |
| Median clean reduction | 22.1% | 21.6% |
| Aggregate clean reduction | 23.8% | 21.1% |
| Quality/source-focus rows | 8 | 4 |
| Pass/pass token regressions | 4 | 4 |
| Harmful assists | 0 | 0 |
| Official-pass scope failures after final reruns | 0 | 0 |

## Classification Counts

| Classification | Count |
| --- | ---: |
| quality_source_focus_rescue | 8 |
| clean_official_savings | 6 |
| both_official_fail | 1 |
| invalid_savings | 4 |
| official_token_regression | 4 |
| official_pass_token_unavailable | 2 |

## Interpretation

Kairn improved the official pass count across this evidence set: 20/25 Kairn official passes versus 15/25 baseline official passes. The clean token-savings claim remains narrower: 6 rows are official pass/pass, local scope pass/pass, and lower-token for Kairn. Those 6 rows saved 63,393 observed tokens with a 22.1% median reduction.

The quality/source-focus result is separate: 8 rows show Kairn passing official evaluation or local source scope where baseline missed. These rows support the source-routing and scope-discipline claim, not the clean savings claim.

The remaining weakness is token regression on some official pass/pass rows. There are 4 pass/pass token regressions totaling 35,525 extra observed tokens. This remains the next optimization target for exact-source and small official patch prompts.

## Clean Pass/Pass Savings Rows

| Group | Repo | Baseline/Kairn official pass | Tokens | Delta | Reduction | Classification |
| --- | --- | --- | ---: | ---: | ---: | --- |
| seed-5-historical | internetarchive/openlibrary | true/true | 21932 -> 10048 | 11,884 | 54.2% | clean_official_savings |
| new-20-expansion | internetarchive/openlibrary | true/true | 43689 -> 40804 | 2,885 | 6.6% | clean_official_savings |
| new-20-expansion | ansible/ansible | true/true | 52126 -> 40852 | 11,274 | 21.6% | clean_official_savings |
| new-20-expansion | ansible/ansible | true/true | 56658 -> 34347 | 22,311 | 39.4% | clean_official_savings |
| new-20-expansion | internetarchive/openlibrary | true/true | 39663 -> 36342 | 3,321 | 8.4% | clean_official_savings |
| new-20-expansion | flipt-io/flipt | true/true | 51891 -> 40173 | 11,718 | 22.6% | clean_official_savings |

## Quality/Source-Focus Rows

These rows are not counted as clean savings. They are useful because Kairn passed official evaluation and/or local source scope where baseline did not.

| Group | Repo | Baseline/Kairn official pass | Tokens | Delta | Reduction | Classification |
| --- | --- | --- | ---: | ---: | ---: | --- |
| seed-5-historical | qutebrowser/qutebrowser | false/true | 40467 -> 21802 | 18,665 | 46.1% | quality_source_focus_rescue |
| seed-5-historical | qutebrowser/qutebrowser | false/true | 47104 -> 43313 | 3,791 | 8% | quality_source_focus_rescue |
| seed-5-historical | NodeBB/NodeBB | false/true | 61212 -> 78456 | -17,244 | -28.2% | quality_source_focus_rescue |
| seed-5-historical | ansible/ansible | true/true | 48716 -> 53747 | -5,031 | -10.3% | quality_source_focus_rescue |
| new-20-expansion | flipt-io/flipt | true/true | 40364 -> 19666 | 20,698 | 51.3% | quality_source_focus_rescue |
| new-20-expansion | internetarchive/openlibrary | false/true | 85664 -> n/a | n/a | n/a | quality_source_focus_rescue |
| new-20-expansion | future-architect/vuls | true/true | 58935 -> 52233 | 6,702 | 11.4% | quality_source_focus_rescue |
| new-20-expansion | tutao/tutanota | false/true | 46394 -> 48160 | -1,766 | -3.8% | quality_source_focus_rescue |

## Token Regressions

These rows passed official evaluation and local scope on both sides, but Kairn used more observed tokens. They are tracked as regressions, not savings.

| Group | Repo | Baseline/Kairn official pass | Tokens | Delta | Reduction | Classification |
| --- | --- | --- | ---: | ---: | ---: | --- |
| new-20-expansion | ansible/ansible | true/true | 38649 -> 43173 | -4,524 | -11.7% | official_token_regression |
| new-20-expansion | ansible/ansible | true/true | 23797 -> 34257 | -10,460 | -44% | official_token_regression |
| new-20-expansion | future-architect/vuls | true/true | 47599 -> 56323 | -8,724 | -18.3% | official_token_regression |
| new-20-expansion | internetarchive/openlibrary | true/true | 19083 -> 30900 | -11,817 | -61.9% | official_token_regression |

## Non-Passing / Invalid Savings Rows

Rows below either failed official evaluation on Kairn, failed on both sides, or had savings that cannot be counted because the quality gate did not pass.

| Group | Repo | Baseline/Kairn official pass | Tokens | Delta | Reduction | Classification |
| --- | --- | --- | ---: | ---: | ---: | --- |
| new-20-expansion | element-hq/element-web | false/false | 47280 -> 81798 | -34,518 | -73% | both_official_fail |
| new-20-expansion | element-hq/element-web | false/false | 113227 -> 74095 | 39,132 | 34.6% | invalid_savings |
| new-20-expansion | element-hq/element-web | false/false | 79465 -> 70876 | 8,589 | 10.8% | invalid_savings |
| new-20-expansion | gravitational/teleport | false/false | 30600 -> 20479 | 10,121 | 33.1% | invalid_savings |
| new-20-expansion | protonmail/webclients | false/false | 46973 -> 38556 | 8,417 | 17.9% | invalid_savings |

## Pause/Fix Provenance

The campaign paused several times for behavior-class issues and resumed only after general fixes plus affected/control reruns. See `docs/publication-evidence-20260524/swe-pro-official-25/fix-log.md` for details. The final Batch D pause was caused by a generic selected-test counterpart routing issue, then cleared after the routing fix made NodeBB pass official evaluation with the intended source surface.

## Artifacts

- Summary JSON: `docs/publication-evidence-20260524/swe-pro-official-25/campaign-summary.json`
- Results CSV: `docs/publication-evidence-20260524/swe-pro-official-25/results.csv`
- Failures CSV: `docs/publication-evidence-20260524/swe-pro-official-25/failures.csv`
- Seed inventory: `docs/publication-evidence-20260524/swe-pro-official-25/seed-5-inventory.json`
- New 20 manifest: `docs/publication-evidence-20260524/swe-pro-official-25/new-20-manifest.json`
- Fix log: `docs/publication-evidence-20260524/swe-pro-official-25/fix-log.md`

## Website Gate

The campaign meets the pre-declared website-update gate:

- At least 20 valid official rows completed: yes.
- Kairn official pass rate at least baseline: yes.
- At least 3 clean pass/pass savings rows: yes.
- No repeated harmful-assist class: yes.

Public wording should remain conservative: “Across 25 official SWE-Pro rows from our evidence campaigns...” and should keep clean savings separate from quality/source-focus evidence.
