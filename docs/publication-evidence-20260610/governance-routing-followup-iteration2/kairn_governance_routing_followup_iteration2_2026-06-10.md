# Kairn Governance Routing Follow-Up Iteration 2

Date: 2026-06-10

## Summary

This iteration tested general governance/routing fixes for the current failure classes:

- request/form/body paired-source over-assist,
- converter/output-adapter source ownership,
- frontend device/session listener ownership,
- discovery/config exact-source suppression,
- MCP activation when tasks look small but no exact production source is named.

No public claims should change from this run. The run is internal evidence for whether the fixes are worth carrying into a larger official slice.

## Local Validation

Passed:

- `pnpm vitest run tests/bench.test.ts tests/runtime.test.ts tests/semantic.test.ts tests/scope.test.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

After the MCP activation wording change, the focused MCP instruction tests also passed.

## Proxy Results

All proxy rows passed before live spend:

| Row | Target class | Result |
| --- | --- | --- |
| OpenLibrary row 2 | request/body/form paired source | pass |
| Vuls row 3 | converter/output adapter | pass |
| Element row 9 | device/session listener ownership | pass |
| Element row 10 | discovery/config source surface | pass |

## Codex CLI Results

| Row | Classification | Result |
| --- | --- | --- |
| OpenLibrary row 2 | clean pass/pass savings | Kairn passed with lower token use: 115,576 baseline to 41,820 with Kairn, 73,756 saved, 63.8% reduction. |
| Vuls row 3 | quality/source-focus rescue | Baseline failed local scope/quality; Kairn passed with focused converter ownership. |
| Element row 9 | clean pass/pass savings | Kairn passed with lower token use: 148,847 baseline to 80,107 with Kairn, 68,740 saved, 46.2% reduction. |
| Element row 10 | isolated token regression | Kairn passed and suppressed, but used more tokens: 40,526 baseline to 66,701 with Kairn. Treat as isolated accounting/runtime variance, not public evidence. |

No harmful assists and no scope violations were observed in the Codex CLI focused rows.

## MCP Results

MCP smoke passed with actual MCP calls and useful attribution.

### Pre-activation repeat3 rows

Older repeat3 rows exposed an MCP activation issue: Codex could skip MCP when a task looked small. These rows stay in the artifact history but are not the current proof of the post-activation behavior.

| Suite | Result |
| --- | --- |
| Fastify repeat3 | useful attribution, but quality incomplete in one repeat. |
| Node SemVer repeat3 | quality incomplete and no useful MCP calls. |
| Click repeat3 | quality incomplete, with one quality-rescue signal. |

### Post-activation repeat rows

After tightening MCP-first instructions, both rechecked repeat3 suites passed cleanly.

| Suite | Result |
| --- | --- |
| Click repeat3 | clean pass/pass; real MCP-first median 163,319 to 101,007 tokens, 62,312 saved, 38.2% reduction; 8 MCP calls and 6 useful attributions. |
| Fastify repeat3 | clean pass/pass; real MCP-first median 102,999 to 42,841 tokens, 61,754 saved, 58.4% reduction; 6 MCP calls and 6 useful attributions. |

Fastify provides the required JS/server MCP signal. No repeated MCP broad-fanout, quality-drop, missing-attribution, or scope-violation class appeared in the post-activation rechecks.

## Current Read

The branch now has positive focused evidence in both modes:

- Codex CLI: two clean pass/pass savings rows plus one quality/source-focus rescue; one isolated token regression remains.
- MCP: smoke passed; Click repeat3 and Fastify repeat3 passed after activation wording was fixed, with useful attribution and positive savings.

This is strong enough for the next proof step: a fresh official SWE-Pro slice, while keeping website/public claims unchanged until the larger gate completes.

## Remaining Work

- Run a fresh 10-15 row official SWE-Pro slice on this branch.
- If the slice passes, run the additional 10-row confirmation required by the gate.
- Keep Element discovery/config token behavior on the optimization list, but do not treat the isolated row as a repeated class yet.
- Keep semantic slicing out of this cycle; the current evidence points to governance/routing and activation as the right near-term layer.
