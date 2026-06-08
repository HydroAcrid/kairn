# Kairn MCP Post-Governor Recheck - 2026-06-04

## Summary

This focused MCP recheck validated the post-governor `main` branch across protocol smoke, local MCP tests, and repeat-3 endurance suites. MCP is mechanically healthy and produced strong clean savings on Click. Fastify produced strong JS/server MCP evidence, but it mixes clean pass/pass savings with one quality-rescue row because baseline failed one repeat. Node SemVer exposed a quality-risk class, so this campaign should not be used to update public MCP claims yet.

## Local Checks

- `tests/mcp.test.ts`: passed.
- `tests/watch.test.ts --testNamePattern "mcp|MCP"`: passed.
- `tests/bench.test.ts --testNamePattern "MCP|mcp"`: passed.
- `tests/bench.test.ts --testNamePattern "MCP|mcp|seed|endurance"`: passed after harness retry work.
- MCP smoke recorded tool usage and returned focused setup guidance.

## Results

| Suite | Mode | Quality | Median tokens | Median saved | Reduction | Clean pass/pass rows | Quality rescue rows | MCP calls | Useful attribution | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Click Compatibility Encoding Endurance | kairn_codex_session | 3/3 | 103580 | 13141 | 11.26% | 2 | 0 | 0 | 0 | mixed_or_over_assist |
| Click Compatibility Encoding Endurance | real_mcp_first | 3/3 | 72426 | 44295 | 37.95% | 3 | 0 | 3 | 3 | clean_repeat3_mcp_savings |
| Click Compatibility Encoding Endurance | hybrid_mcp_brief | 3/3 | 55885 | 57754 | 50.82% | 3 | 0 | 4 | 3 | clean_repeat3_mcp_savings |
| Node SemVer Satisfies Endurance | kairn_codex_session | 2/3 | 77517 | -2937 | -3.94% | 1 | 0 | 0 | 0 | quality_risk |
| Node SemVer Satisfies Endurance | real_mcp_first | 2/3 | 38419 | 24554 | 39.92% | 2 | 0 | 3 | 3 | mcp_quality_risk |
| Node SemVer Satisfies Endurance | hybrid_mcp_brief | 2/3 | 45798 | 28236 | 37.18% | 2 | 0 | 3 | 3 | mcp_quality_risk |
| Fastify HEAD Route Endurance | kairn_codex_session | 3/3 | 86337 | -3764 | -4.56% | 1 | 1 | 0 | 0 | mixed_or_over_assist |
| Fastify HEAD Route Endurance | real_mcp_first | 3/3 | 46467 | 58751 | 61.52% | 2 | 1 | 5 | 3 | mixed_clean_plus_quality_rescue |
| Fastify HEAD Route Endurance | hybrid_mcp_brief | 3/3 | 43069 | 51260 | 53.68% | 2 | 1 | 3 | 3 | mixed_clean_plus_quality_rescue |

## Readout

- **Click:** clean repeat-3 MCP evidence. `real_mcp_first` saved a median 44,295 tokens, 37.95%; `hybrid_mcp_brief` saved a median 57,754 tokens, 50.82%. Both modes passed 3/3 with useful MCP attribution and no scope violations.
- **Fastify:** strong JS/server MCP evidence, but mixed. MCP modes passed 3/3 with useful attribution and no scope violations. Two rows are clean pass/pass savings; one row is quality rescue because baseline failed that repeat.
- **Node SemVer:** not clean. MCP modes saved tokens on median and captured useful attribution, but each had one harmful invalid assist / quality-risk repeat. This is the next MCP optimization target.

## Acceptance Gate

The public-evidence gate is **not met** for new public MCP claims. The campaign proves MCP setup and runtime mechanics, and it gives strong positive evidence on Click and Fastify. However, SemVer produced a repeat quality-risk class, so public claims should wait for either a fix/recheck or another fresh clean repeat-3 MCP suite that isolates SemVer as a specific failure class.

## Harness Notes

- The Click seed patch hunk header was corrected so the existing patch applies.
- The first Fastify attempt failed because GitHub reset a fetch. Seeded benchmark git fetch/clone now retries transient RPC/connection failures. This is harness robustness only; it does not alter Kairn runtime behavior.

## Artifacts

- `mcp-smoke.json`
- `endurance-click-repeat3.json`
- `endurance-node-semver-repeat3.json`
- `endurance-fastify-repeat3.json`
- `results.csv`
- `campaign-summary.json`
