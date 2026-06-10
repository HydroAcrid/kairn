# Kairn Governance Routing Follow-Up Iteration 4

Date: 2026-06-10

## Summary

This iteration rechecked the current governance-routing fixes against the targeted failure classes from the prior loop:

- OpenLibrary request/form/body token regression
- Vuls converter/output-adapter routing
- Element DeviceListener frontend ownership routing
- MCP setup/smoke/endurance behavior after the governance changes

The completed focused Codex CLI rows were all clean pass/pass savings rows. The MCP smoke passed, and the corrected MCP Click endurance repeat-1 produced active MCP evidence with useful attribution and positive savings.

No public website or launch claims should change from this iteration alone. This is focused follow-up evidence, not the final fresh 10-15 row official gate.

## Codex CLI Focused Results

| Row | Class | Baseline Tokens | Kairn Tokens | Saved | Reduction | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| OpenLibrary row 2 | request/form/body | 80,583 | 44,855 | 35,728 | 44.3% | clean pass/pass |
| Vuls row 3 | converter/output-adapter | 131,054 | 64,546 | 66,508 | 50.8% | clean pass/pass |
| Element row 9 | device/listener ownership | 120,383 | 72,071 | 48,312 | 40.1% | clean pass/pass |

Aggregate over completed live focused rows:

- Clean pass/pass rows: 3
- Token regressions: 0
- Quality drops: 0
- Scope violations: 0
- Median reduction: 44.3%

## Proxy Results

The proxy stage passed all intended rows:

- OpenLibrary row 2: proxy pass
- Vuls row 3: valid guardrail
- Element row 9: proxy pass
- Element row 10: proxy pass

The Vuls proxy result is the important fix signal: it now emits a single-file converter guardrail for `contrib/trivy/pkg/converter.go` instead of broad converter/scanner fanout.

## MCP Results

MCP smoke:

- Tools listed successfully.
- `kairn_prepare_task` returned `src/runtime/KairnRuntime.ts` as a start file.
- Recorded 2 MCP tool calls.

MCP Click endurance repeat-1 with absolute CLI setup:

| Mode | Tokens | Quality | Final Verification | MCP Calls | Useful Attribution |
| --- | ---: | --- | --- | ---: | --- |
| Baseline | 124,081 | pass | pass | 0 | none |
| real_mcp_first | 79,126 | pass | pass | 1 | `src/click/_compat.py` |

MCP delta:

- Saved tokens: 44,955
- Reduction: 36.2%
- Assistance classification: valid assist
- Harmful assist: false

Two earlier MCP endurance attempts in this iteration failed before valid MCP evidence because the setup command was wrong for disposable workspaces:

- setup command with shell redirection failed before any assisted turn;
- relative `node dist/cli.js` failed because the worker ran inside the disposable workspace.

The successful rerun used an absolute built CLI path.

## Harness Note

`live-swe-row-10-element-discovery` completed the baseline half, then stalled before the Kairn half produced a report. It is excluded from product metrics and should be treated as a harness/run issue for this iteration.

Baseline partial for row 10 passed quality and touched the expected files, but no Kairn result was produced, so it is not counted as pass/pass, rescue, regression, or failure.

## Validation

Completed after the code changes and live checks:

- `pnpm vitest run tests/bench.test.ts tests/runtime.test.ts tests/semantic.test.ts tests/scope.test.ts`
- `pnpm vitest run tests/mcp.test.ts tests/watch.test.ts tests/bench.test.ts --testNamePattern "MCP|mcp"`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

All passed.

## Next Gate

This focused loop is promising enough to proceed to the planned proof gate:

1. Run a fresh 10-15 row SWE-Pro official slice.
2. Run repeat-3 MCP/endurance on at least two suites, including one non-Python suite.
3. Only update public evidence if Kairn pass rate remains at least baseline, pass/pass median savings stays positive, and no repeated harmful-assist or repeated token-regression class appears.
