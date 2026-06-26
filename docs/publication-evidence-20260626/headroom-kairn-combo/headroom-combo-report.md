# Kairn + Headroom Combo Report - 2026-06-26

## Summary

This pass implemented the first safe research layer for evaluating Headroom against and alongside Kairn.

No public Kairn claims should change from this pass. No live SWE-Pro or endurance benchmark rows were run yet. The result is a clean inventory plus smoke baseline that shows Headroom can be installed locally, its proxy can start in passthrough mode, and Kairn still builds on the isolated research branch.

## What Was Verified

| Check | Result | Notes |
| --- | --- | --- |
| Headroom repo refresh | pass | Reviewed commit `9f772378d3e1f1f5145af6c1868c6c6bd4b6f557`. |
| Headroom license | pass | Apache-2.0. |
| Headroom MCP install | pass | `headroom-ai[mcp]` installed in `/tmp/headroom-kairn-smoke-venv`. |
| Headroom proxy install | pass | `headroom-ai[proxy]` installed in the same temporary venv. |
| Headroom version | pass | `0.27.0`. |
| Headroom MCP status | pass | SDK installed; no Claude config and proxy not running, expected for non-mutating smoke. |
| Headroom MCP initialize | partial | Server initialized and advertised tool capability; raw `tools/list` probe needs SDK retry. |
| Headroom proxy passthrough | pass | `/livez` returned HTTP 200 with `--no-optimize --no-cache`. |
| Kairn source build | pass | `pnpm build` passed; `kairn --version` reported `0.1.4`. |

## Current Interpretation

Headroom appears complementary rather than a direct replacement for Kairn.

- Headroom is strongest as a compression/proxy/MCP layer for content already in the request path.
- Kairn is strongest as a governance layer deciding which repo context belongs in the working session.
- The most plausible combo is Kairn first, Headroom second.

The clean positioning remains:

> Headroom compresses context. Kairn decides what context belongs in the coding session.

## Live Test Gate

Do not run the full four-arm SWE-Pro sample until these two checks pass:

1. MCP SDK-backed tool call:
   - initialize Headroom MCP,
   - list tools,
   - call `headroom_compress`,
   - confirm `headroom_stats` records the compression.

2. Passthrough accounting sanity:
   - direct baseline vs Headroom passthrough,
   - same tiny command/task,
   - confirm token accounting and patch capture still work.

## Planned Live Sequence

After the gate:

1. Run four-arm sample on one narrow exact-source row.
2. Run four-arm sample on one multi-file source-governance row.
3. Run four-arm sample on one noisy failure/log row.
4. Run four-arm sample on one frontend ownership row.
5. Run one known-good MCP/endurance suite.
6. Run one JS/TS or server MCP/endurance suite.

Arms:

- `baseline_direct`
- `headroom_passthrough`
- `headroom_only`
- `kairn_only`
- `kairn_plus_headroom`

## Acceptance Criteria

Treat Kairn + Headroom as promising only if:

- combo quality is at least Kairn-only quality,
- combo token use is lower than Kairn-only on at least two applicable rows,
- source attribution survives compression,
- token accounting remains valid,
- MCP useful attribution still records,
- no scope violations appear.

## Follow-Up Learning Backlog

If the live sample supports it, convert the useful ideas into Kairn-native plans:

- three-arm direct/passthrough/governed eval structure,
- local context receipts,
- evidence/log compression after Kairn source selection,
- MCP stats and why-this-context visibility,
- prefix-cache stability metrics,
- preview-first failure learning,
- better campaign journal/resume output.
