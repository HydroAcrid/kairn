# Governance Routing PR Targeted Recheck - 2026-06-26

## Summary

Targeted recheck for PR #3 focused on rows 1, 6, 7, row 8 accounting, and MCP real-mode safety.

Result: row 7 now has a compact HTTP auth policy guardrail and reruns as clean pass/pass savings in the live harness. The latest row 7 Kairn patch also passes the official SWE-Pro evaluator. Row 1 remains a valid suppression case. Row 6 remains a compact quality-support case. Row 8 was rerun and still has unavailable observed token data because both baseline and Kairn hit the agent timeout boundary; it is excluded from token aggregates.

The dedicated MCP checks split cleanly: SWE-mode MCP passed quality/scope and recorded useful attribution, but regressed tokens on row 7; endurance-mode MCP passed quality/scope and produced clean savings on the Click control suite.

No public claims should change from this pass alone.

## Changes Tested

- Added `http_auth_policy_compact` directive sizing for netrc / Authorization / `use_netrc` tasks.
- Kept the edit surface focused on request utility, `uri`, `get_url`, and URL lookup paths.
- Explicitly excludes action plugins, tests, docs, examples, generic helpers, and unrelated module utilities unless directly named.
- Added campaign MCP useful-attribution aggregation for proof runs.

## Proxy Results

| Row | Result | Decision | Tokens | Classification | Note |
| --- | --- | --- | ---: | --- | --- |
| 1 | passed | suppress | 941 | `suppression_expected`, `valid_guardrail` | Narrow RPM parser/source-package prompt is not an active over-assist case. |
| 6 | passed | compact paired directive | 244 | `valid_guardrail` | gRPC context error policy keeps the required three-file surface. |
| 7 | passed | compact paired directive | 186 | `valid_guardrail` | HTTP auth/netrc policy uses the new compact guardrail. |

## Live Row 7 Rerun

| Row | Baseline Tokens | Kairn Tokens | Saved | Reduction | Quality | Classification |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 7 | 176,844 | 141,310 | 35,534 | 20.1% | pass/pass | `clean_passpass` |

Notes:

- Baseline was reused from the strict harness cache.
- Kairn produced a scoped patch touching the expected four production files.
- No scope violations, quality drop, harmful assist, or token regression were recorded.
- The latest Kairn row 7 patch passed the official SWE-Pro evaluator in `official-row-7-http-auth-compact-kairn`.

## Row 8 Accounting

Row 8 is still classified as `official_pass_token_unavailable` after a fresh rerun.

The stored baseline artifact had a passing patch but did not contain observed Codex token data. A fresh row 8 baseline/Kairn rerun completed with both modes passing local quality/scope, but both mode executions reached the 900s timeout boundary and still reported observed Codex usage as unavailable. Row 8 should remain valid for quality/scope evidence only and must stay out of clean savings/token-regression aggregates.

## MCP Check

`bench mcp-smoke` passed with actual MCP tool activity.

- `mcpToolCalls`: 2
- start file returned: `src/runtime/KairnRuntime.ts`
- estimated saved tokens: 261,167

This verifies the MCP server/tool path still works on the branch.

### SWE-Mode MCP

The dedicated row 7 `real_mcp_first` SWE proof passed local quality/scope and recorded useful MCP attribution, but it used more tokens than the cached baseline.

| Row | Mode | Baseline Tokens | MCP Tokens | Saved | Reduction | Quality | MCP Calls | Useful Attribution | Classification |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| 7 | `real_mcp_first` | 176,844 | 221,764 | -44,920 | -25.4% | pass/pass | 1 | 1 | `official_token_regression`, `mcp_useful_attribution` |

This is useful mechanics evidence, not positive token evidence. It shows MCP works in SWE-style proof mode, but row 7 is a poor token-saving MCP case after the compact Codex-session guardrail.

### Endurance MCP

The Click endurance control produced positive MCP evidence.

| Suite | Mode | Baseline Tokens | MCP Tokens | Saved | Reduction | Quality | MCP Calls | Useful Attribution | Classification |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| Click compatibility encoding | `real_mcp_first` | 209,289 | 87,443 | 121,846 | 58.2% | pass/pass | 1 | 1 | `clean_passpass`, `mcp_useful_attribution` |

No quality drop, harmful assist, or scope violation was recorded. This is the stronger MCP result for PR readiness because it exercises a multi-turn session rather than a tiny official patch row.

## Validation

Final validation on the PR branch passed after the targeted evidence runs:

- `pnpm test` - 17 files, 443 tests passed
- `pnpm typecheck` - passed
- `pnpm build` - passed
- `git diff --check` - passed

## PR Readiness

This targeted pass resolves the previous PR blockers for row 7, row 8 accounting disposition, and MCP real-mode verification. The remaining caveats are evidence-scoping caveats rather than merge blockers:

- Row 8 remains excluded from token aggregates because observed token usage is unavailable after rerun.
- SWE-mode MCP on row 7 is pass/pass but token-negative.
- The full 12-row official aggregate should not be republished as a new public claim from this targeted pass alone.
