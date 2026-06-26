# Governance Routing PR Follow-up

Date: 2026-06-26

This follow-up addresses the two blockers found during the targeted recheck:

- row 8 had been reported as `official_pass_token_unavailable`, then the transcript accounting fix exposed a real harmful Kairn over-assist timeout.
- SWE-mode MCP row 7 passed and returned useful source attribution, but initially used more tokens than baseline.

## Fixes

### Row 8: execution-state migration over-assist

Kairn was over-assisting a self-contained official execution-state migration prompt. The initial accounting fix made the token data available, but exposed a bad result: Kairn sent a large focused-start body, timed out, and failed quality.

The general fix is to suppress Kairn context for self-contained official execution-state migration prompts when the prompt already includes the required multi-file contract and there is no failure output.

Final rerun:

- artifact: `live-row-8-self-contained-suppress-final`
- baseline tokens: `216651`
- Kairn tokens: `243425`
- official/local quality: pass
- scope: pass
- harmful assist: no
- classification: `passive_token_regression`

This resolves the harmful-assist and token-unavailable blocker. It is not positive savings evidence and should not be counted as clean savings.

### Row 7: MCP session handling and attribution

The first row 7 MCP rerun showed useful source attribution, but token use regressed. Transcript inspection found a real MCP bug: the model first called `kairn_prepare_task` with a client-provided `sessionId`, and Kairn returned `Unknown Kairn session`, causing a retry without `sessionId`.

The general fix is for `primeContext` to create a new session when MCP supplies a fresh session id on the first prepare call. This makes MCP clients robust when they provide their own stable session ids.

Final rerun:

- artifact: `mcp-swe-row-7-session-fix-rerun`
- baseline tokens: `176844`
- MCP tokens: `107137`
- tokens saved: `69707`
- savings: `39.42%`
- official/local quality: pass
- scope: pass
- MCP calls: `1`
- useful attribution: `4`
- classification: `clean_passpass;mcp_useful_attribution`

## Validation

- `pnpm vitest run tests/mcp.test.ts --testNamePattern "lists and calls|client-session|paired-contract"`
- `pnpm vitest run tests/runtime.test.ts --testNamePattern "execution-state|execution state|State Migration|self-contained"`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

## Merge Read

This follow-up resolves the two immediate blockers:

- row 8 is no longer token-unavailable or harmful; it is now an isolated passive token regression.
- row 7 MCP mode now records real MCP use, useful attribution, quality pass, scope pass, and positive savings.

Do not use row 8 as public savings evidence. Row 7 can be treated as supporting MCP evidence, but still only as a single-row targeted recheck until repeated.
