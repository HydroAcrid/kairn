# Kairn Publication Evidence Report 2026-05-18

Status: v3 campaign harness prepared; live campaign results pending.

This report is the public-facing landing point for the frozen 2026-05-18 evidence bundle. The dry-run artifacts are in `docs/publication-evidence-20260518/` and validate that the campaign plan, command templates, official row IDs, no-governor ablation mode, MCP endurance slice, and reproducibility manifest are wired correctly.

## Campaign Scope

The v3 campaign excludes private beta telemetry from scientific claims. It is designed to validate:

- fresh repo preflight on pinned holdout repos,
- pass/pass token savings on repeat-3 live canaries,
- governor impact through a benchmark-only no-governor ablation,
- MCP usefulness through repeat-3 endurance with actual MCP calls,
- SWE-Pro official evaluator readiness with 10 selected row IDs,
- overhead: setup time, index time, hook/MCP latency, MCP calls, emitted context tokens, and net savings.

## Planned Evidence Slices

| Slice | Entry | Modes | Repeat | Claim Role |
| --- | --- | --- | --- | --- |
| Fresh repo preflight | `fresh-publication-v3-preflight` | matrix | n/a | Unseen source-routing gate |
| Live seeded canary | `fresh-live-repeat3-canary` | baseline, Kairn session | 3 | Pass/pass savings evidence |
| One-shot ablation | `ablation-proof-repeat3` | baseline, Kairn session, no-governor | 3 | Decision-layer proof |
| Endurance ablation | `requests-endurance-ablation-repeat3` | baseline, Kairn session, no-governor | 3 | Session/governor proof |
| Fresh MCP endurance | `httpcore-mcp-endurance-repeat3` | baseline, real MCP-first | 3 | Fresh MCP evidence |
| MCP regression proof | `requests-mcp-endurance-repeat3` | baseline, real MCP-first, hybrid | 3 | Existing strong MCP slice |
| MCP protocol smoke | `local-mcp-smoke-v3` | MCP smoke | n/a | Tool-call delivery gate |
| SWE-Pro official | `swe-pro-official-eval-v3` | official evaluator | 10 rows | External credibility gate |

## Claim Rules

- Headline savings use only pass/pass rows.
- Active savings count only when quality passes, Kairn assistance is active, scope discipline passes, and emitted context is useful.
- MCP claims require recorded MCP tool calls and returned useful production files.
- SWE-Pro savings do not count unless the official evaluator passes.
- Suppressed or passive savings are abstention evidence, not active Kairn wins.
- Quality-rescue rows support usefulness but are not clean token-savings claims.

## Current Dry-Run Verification

The dry run generated:

- `docs/publication-evidence-20260518/publication-summary.json`
- `docs/publication-evidence-20260518/publication-results.csv`
- `docs/publication-evidence-20260518/publication-failures.csv`
- `docs/publication-evidence-20260518/publication-manifest.json`
- `docs/publication-evidence-20260518/kairn_publication_evidence_report_2026-05-18.md`
- raw planned artifacts under `docs/publication-evidence-20260518/raw/`

Because this is a dry run, metric tables are intentionally empty. Populate this report after the live v3 campaign completes.

## Live Run Order

1. Run pre-live verification: `pnpm test`, `pnpm typecheck`, `pnpm build`, `git diff --check`.
2. Run the fresh repo matrix preflight.
3. Run the repeat-3 live seeded canary.
4. Run the no-governor ablation subset.
5. Run the fresh httpcore MCP endurance repeat-3.
6. Run the SWE-Pro official evaluator slice only after evaluator setup is clean.
7. Copy final aggregate results into the LinkedIn/website brief.

## Findings Placeholder

| Metric | Result |
| --- | --- |
| Quality pass rate delta vs baseline | TBD |
| Active pass/pass median savings | TBD |
| Debug/endurance median savings | TBD |
| Correct abstention count | TBD |
| Evidence request count | TBD |
| Harmful assist count | TBD |
| Repeated harmful pattern | TBD |
| MCP calls recorded | TBD |
| SWE-Pro official passes | TBD |
| Median hook/MCP latency | TBD |

## Publication Readiness

Current status: not final. The v3 evidence machinery is ready, but the scientific/public-preview claims should wait for the live artifacts to replace this dry-run placeholder.
