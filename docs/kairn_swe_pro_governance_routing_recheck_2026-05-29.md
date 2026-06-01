# Kairn SWE-Pro Governance Routing Recheck - 2026-05-29

## Summary

This recheck targeted the three failing behavior classes from the fresh SWE-Pro current-branch slice:

- qutebrowser QtWebEngine config/argument scope,
- Ansible deprecation/date lifecycle routing,
- Element large frontend ownership/scope.

The branch now clears the affected-row gate and the clean-savings control gate.

## Local Validation

- `pnpm vitest run tests/scope.test.ts tests/semantic.test.ts tests/runtime.test.ts tests/bench.test.ts`: passed, 263 tests
- `pnpm test`: passed, 342 tests
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `git diff --check`: passed

## Affected Rows

| Row | Class | Kairn official result | Notes |
| --- | --- | --- | --- |
| qutebrowser QtWebEngine args | config setting + runtime args | pass | The fix allowed `configdata.yml` into edit scope when the prompt explicitly requires a new config setting/schema surface. |
| Ansible deprecation date | lifecycle/deprecation policy | pass | Existing lifecycle routing held. |
| Element voice broadcast | large frontend ownership | pass | Official evaluator passed despite local scope being stricter than the official target. |

## Clean Controls

| Row | Kairn official result | Tokens | Notes |
| --- | --- | ---: | --- |
| Ansible nxos route-target | pass | 47,978 | One production file, local pass. |
| Teleport Kubernetes RBAC | pass | 73,333 | One production file, local pass. Still below the recorded baseline, but materially higher than older Kairn runs for this row. |

## Consolidated Fresh 10-Row Read

This combines the existing fresh current-branch 10-row baseline with the affected/control Kairn reruns from this recheck.

- Baseline official pass rate: 7/10
- Kairn official pass rate: 7/10
- Quality drops: 0
- Clean pass/pass savings rows: 5
- Official pass/pass token regressions: 2
- Clean savings median reduction: 38.8%
- Pass/pass median reduction including regressions: 9.0%
- Clean savings token delta: 215,245 tokens
- Pass/pass token delta including regressions: 203,924 tokens

Artifacts:

- `docs/publication-evidence-20260529/swe-pro-governance-routing-recheck/fresh-slice-current-with-rechecks.aggregate.json`
- `docs/publication-evidence-20260529/swe-pro-governance-routing-recheck/fresh-slice-current-with-rechecks.results.csv`

## Interpretation

This is a meaningful improvement over the previous fresh-slice state because Kairn no longer turns baseline official passes into Kairn official failures on the affected rows. The result is merge-candidate quality from an accuracy standpoint.

The remaining issue is token consistency. Two pass/pass rows still use more tokens with Kairn, and the Teleport RBAC control remains much more expensive than older Kairn runs. That suggests the next optimization target is not broader routing correctness; it is conditional sizing and suppression for official patch tasks after the correct source surface has been found.

## Public-Claim Status

Do not update public claims from this branch alone yet. It is strong internal evidence that the routing fixes improved quality safety, but a full frozen rerun or another fresh slice should confirm token consistency before using it on the website.
