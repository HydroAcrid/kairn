# Kairn Publication Evidence Report 2026-05-18

Status: live v3 campaign partially complete. Private beta telemetry is excluded from these claims.

## Summary

The 2026-05-18 campaign strengthened the main claim, with caveats:

> Kairn reduces token use on source-rescue, debug, and long-session coding work while preserving quality through selective context, suppression, MCP/session memory, and edit-scope discipline.

The strongest clean evidence is now MCP/session endurance:

| Slice | Result | Claim Status |
| --- | --- | --- |
| Fresh preflight v3 | 8/8 repos passed after general companion/source routing fixes | Valid routing gate |
| Fresh live repeat-3 canary | Kairn 3/3 quality, baseline 0/3 report-level quality; 58% fewer median tokens | Quality-rescue evidence, not pass/pass savings |
| Governed vs no-governor ablation | Governed Kairn: 17.85% valid pass/pass savings; no-governor: 32.36% but repeated over-assist | Governor improves safety; no-governor is not beta-safe |
| Fresh httpcore MCP endurance repeat-3 | 100% quality, 18.46% median valid active savings, 5 MCP calls, 2 useful returned files, 0 scope violations | Clean MCP evidence |
| Requests MCP endurance repeat-3 | Hybrid: 100% quality, 48.78% median valid savings; real MCP-first had one harmful test edit | Strong but mixed; led to a general MCP scope fix |
| Requests MCP post-fix repeat-1 | MCP-first: 34.84% savings; hybrid: 21.03%; both passed, 0 scope violations | Positive recheck, needs repeat-3 confirmation |
| MCP protocol smoke | Passed; 2 MCP tool calls recorded | Delivery gate passed |
| SWE-Pro official slice | 10 row IDs selected, but no official evaluator result JSON attached | No SWE-Pro savings counted |

## Key Findings

Fresh unseen preflight is clean after behavior-class fixes. Webpack needed better companion routing for module factory/resolver/parser flows. SQLAlchemy needed ORM session/unit-of-work/persistence routing. These were fixed as general source-routing rules, not repo-specific task memorization.

The governor is doing useful work. In the ablation subset, no-governor sometimes spent fewer tokens, but it repeatedly over-assisted. The governed path gave lower headline savings than no-governor, but it preserved safer behavior and still produced 17.85% valid pass/pass savings.

MCP is now a real second wedge. The httpcore endurance run recorded actual MCP tool calls and pass/pass savings. Requests hybrid also showed large savings, but the first full repeat exposed a real failure class: MCP guidance was not explicit enough about read-only tests. Kairn now emits a compact edit-scope directive through MCP and long-session prompts.

SWE-Pro remains a credibility blocker, not a product blocker. The official row slice is selected, but no official evaluator JSON was provided. Per claim rules, SWE-Pro savings remain invalid until official evaluator passes are attached.

## Improvements Made During Campaign

- Hardened the live shell runner so publication/endurance commands do not wedge after Codex child processes exit.
- Added repeat-level MCP evidence fields to publication aggregation: MCP calls, returned file counts, useful returned file counts, repeated context, and scope violations.
- Improved companion/source routing for:
  - Webpack module factory/resolver/parser flows.
  - SQLAlchemy ORM session/unit-of-work/persistence flows.
- Tightened MCP scope delivery:
  - MCP compact responses now include `editScopeDirective`.
  - Known-source MCP endurance prompts now state tests/docs/examples/fixtures/snapshots/generated/vendor are read-only unless a focused verification failure proves otherwise.
  - Prompts instruct agents to revert out-of-scope edits before finalizing.

## Current Evidence Artifacts

Primary artifacts live under `docs/publication-evidence-20260518/`.

| Artifact | Purpose |
| --- | --- |
| `raw/fresh-publication-v3-preflight.json` | Fresh repo deterministic preflight |
| `raw/fresh-live-repeat3-canary.json` | Fresh live canary |
| `raw/ablation-proof-repeat3.json` | Governed vs no-governor proof |
| `raw/httpcore-mcp-endurance-repeat3.json` | Fresh MCP endurance proof |
| `raw/requests-mcp-endurance-repeat3.json` | Requests MCP/hybrid endurance proof before final scope fix |
| `requests-mcp-scope-fix-postbuild-repeat1.json` | Post-fix Requests MCP recheck |
| `raw/local-mcp-smoke-v3.json` | MCP protocol smoke |
| `raw/swe-pro-official-eval-v3.json` | SWE-Pro official-eval placeholder/status |

## Conservative Claim Matrix

Safe to claim:

- Controlled tests show Kairn can reduce token use while preserving quality on source-rescue and endurance tasks.
- MCP and session-bound modes both have positive evidence.
- Kairn often stays focused by suppressing repeated or low-value context.
- Private beta should target Codex/session and MCP workflows first.

Do not claim yet:

- Universal 20-70% savings.
- Public “works anywhere” reliability.
- Official SWE-Pro savings.
- Month-long reliability.
- Claude/Gemini/Copilot performance parity; MCP compatibility is configured, but Codex is the most-tested live path.

## Next Evidence Needed

1. Rerun Requests MCP post-scope-fix as repeat-3.
2. Run one additional fresh MCP endurance repo if time allows.
3. Attach real SWE-Pro official evaluator outputs before making SWE-Pro claims.
4. Run a small strongest-model confirmation slice after the mini-model campaign is stable.
5. Keep private beta telemetry separate from scientific claims, using it only to discover real-world failure classes.

## Verification

Completed during the campaign:

- `pnpm test tests/mcp.test.ts`
- `pnpm test tests/bench.test.ts`
- `pnpm typecheck`
- `pnpm build`

Remaining before packaging a final evidence bundle:

- `pnpm test`
- `git diff --check`
- Repeat-3 Requests MCP post-fix confirmation.
