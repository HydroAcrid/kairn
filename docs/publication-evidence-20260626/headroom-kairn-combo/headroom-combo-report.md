# Kairn + Headroom Combo Report - 2026-06-26

## Summary

This pass implemented the first safe research layer for evaluating Headroom against and alongside Kairn.

No public Kairn claims should change from this pass. No live SWE-Pro or endurance benchmark rows were run yet.

The result is a clean inventory plus smoke evidence showing Headroom can be installed locally, its proxy can start in passthrough mode, its MCP tools work through an SDK client, and Kairn output can be fed into Headroom while preserving source attribution.

## What Was Verified

| Check | Result | Notes |
| --- | --- | --- |
| Headroom repo refresh | pass | Reviewed commit `9f772378d3e1f1f5145af6c1868c6c6bd4b6f557`. |
| Headroom license | pass | Apache-2.0. |
| Headroom MCP install | pass | `headroom-ai[mcp]` installed in `/tmp/headroom-kairn-smoke-venv`. |
| Headroom proxy install | pass | `headroom-ai[proxy]` installed in the same temporary venv. |
| Headroom version | pass | `0.27.0`. |
| Headroom MCP status | pass | SDK installed; no Claude config and proxy not running, expected for non-mutating smoke. |
| Headroom MCP SDK round trip | pass | Listed `headroom_compress`, `headroom_retrieve`, and `headroom_stats`; compress/retrieve/stats round trip completed. |
| Headroom proxy passthrough | pass | `/livez` returned HTTP 200 with `--no-optimize --no-cache`. |
| Kairn source build | pass | `pnpm build` passed; `kairn --version` reported `0.1.4`. |
| Kairn prepare -> Headroom compress | pass | Kairn returned runtime/governor attribution; Headroom preserved both paths and nooped because the payload was already tiny. |
| Kairn read-file -> Headroom compress | pass | Kairn returned exact source for `src/runtime/KairnRuntime.ts`; Headroom compressed 3,633 estimated tokens to 63 and preserved retrieval. |

## Combo Smoke Results

| Payload | Before | After | Saved | Reduction | Attribution | Classification |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Kairn prepare-task guidance | 192 | 192 | 0 | 0.0% | runtime + governor paths preserved | `combo_prepare_noop_attribution_preserved` |
| Kairn exact source payload | 3,633 | 63 | 3,570 | 98.3% | `src/runtime/KairnRuntime.ts` preserved and retrievable | `combo_source_compression_attribution_preserved` |

## Expanded Local Payload Matrix

This matrix used real Kairn MCP outputs plus one Headroom-only raw noisy-output control. It is still a local payload test, not an end-to-end coding benchmark.

| Payload | Arm | Before | After | Saved | Reduction | Strategy | Attribution | Classification |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Kairn prepare guidance | Kairn + Headroom | 173 | 173 | 0 | 0.0% | `router:noop` | 2/2 paths preserved | `combo_noop_attribution_preserved` |
| Kairn exact runtime source | Kairn + Headroom | 5,997 | 63 | 5,934 | 98.9% | `router:mixed:0.00` | 2/2 paths preserved | `combo_compression_attribution_preserved` |
| Kairn runtime summary | Kairn + Headroom | 952 | 65 | 887 | 93.2% | `router:smart_crusher:0.00` | 1/1 path preserved | `combo_compression_attribution_preserved` |
| Kairn MCP snippet retrieval | Kairn + Headroom | 11,969 | 3,843 | 8,126 | 67.9% | `router:smart_crusher:0.21` | 1/1 path preserved | `combo_compression_attribution_preserved` |
| Kairn failure context | Kairn + Headroom | 1,669 | 1,669 | 0 | 0.0% | `router:protected:error_output` | 2/2 paths preserved | `combo_noop_attribution_preserved` |
| Kairn compressed noisy output | Kairn + Headroom | 1,442 | 1,442 | 0 | 0.0% | `router:protected:error_output` | 1/2 paths preserved | `combo_noop_attribution_preserved` |
| Raw noisy test output | Headroom only | 11,673 | 1,493 | 10,180 | 87.2% | `router:log:0.13` | 3/3 strings preserved | `headroom_only_compression_attribution_preserved` |

## Source Governance Control

To test the "does Headroom make Kairn irrelevant?" risk, this pass also sent Headroom a broad raw source bundle containing runtime, governor, MCP, and prime-formatting files.

| Payload | Arm | Before | After | Saved | Reduction | Strategy | Attribution | Classification |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Broad raw source bundle | Headroom only | 133,141 | 133,141 | 0 | 0.0% | `router:protected:recent_code` | 3/3 paths preserved | `headroom_only_broad_source_noop_attribution_preserved` |

This is the most important strategic result so far: Headroom preserved source attribution, but it did not reduce a broad recent-code payload. That means Headroom is not enough by itself when the core problem is choosing the right source surface before the agent sees it.

## Wrapper Sanity

`headroom wrap codex --no-context-tool --no-mcp --no-serena -- --version` launched Codex successfully through the Headroom wrapper. However, the wrapper also injected a Headroom provider into the active Codex config file. The generated backup was restored immediately.

That means live combo tests should not use the default wrapper against the user's real Codex config. Use an isolated `CODEX_HOME`, or use a direct proxy/MCP path where config mutation is explicit and reversible.

## Live Accounting Sanity

After isolating `CODEX_HOME`, a tiny Codex prompt was run direct and through `headroom wrap codex`.

| Arm | Result | Input | Cached Input | Output | Classification |
| --- | --- | ---: | ---: | ---: | --- |
| Direct Codex | expected response | 12,917 | 7,552 | 24 | `direct_codex_accounting_baseline` |
| Headroom-wrapped Codex | expected response | 12,880 | 2,432 | 25 | `headroom_passthrough_accounting_stable` |

This is not a savings result. It only proves the wrapped path can complete a live Codex call and preserve JSON token accounting when run in an isolated config home.

## Live Coding Fixture

The first actual coding test used a disposable JS parser fixture with noisy failure output. All four arms fixed the bug and passed `npm test`.

| Arm | Quality | Input | Cached Input | Output | Delta vs Direct | Classification |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Direct Codex | pass | 68,854 | 61,312 | 1,130 | 0.0% | `live_baseline_pass` |
| Headroom wrapped Codex | pass | 82,098 | 69,888 | 987 | -19.2% | `headroom_live_token_regression` |
| Kairn only | pass | 68,591 | 56,704 | 971 | +0.4% | `kairn_live_neutral_savings` |
| Kairn + Headroom wrapped Codex | pass | 131,762 | 116,096 | 1,915 | -91.4% | `combo_live_token_regression` |

This is a negative result for the current Codex proxy-wrapper path. Headroom proxy logs reported internal compression attempts, but Codex-observed usage regressed and the Headroom arms showed repeated stream retry warnings. For product purposes, the observed Codex usage is the number that matters.

Current conclusion from this live row:

- Kairn + Headroom is promising as a local/MCP payload compression idea.
- Kairn + Headroom is not currently promising as "run Codex through Headroom proxy" for normal source-edit work.
- The next viable combo path should be narrower: Kairn governs source context first, then Headroom compresses bulky logs/tool output or explicit Kairn payloads, without proxying every Codex request.

## Live Failure-Prompt Fixture

A second live fixture compared a full noisy failure-output prompt against Kairn's failure-first context. Headroom was applied to the Kairn failure context, but it nooped because Kairn had already compacted the signal to 663 estimated tokens.

| Arm | Quality | Prompt Size | Input | Cached Input | Output | Delta vs Full Log | Classification |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Full noisy failure log | pass | 39,792 chars | 85,176 | 70,656 | 833 | 0.0% | `direct_full_log_prompt_pass` |
| Kairn failure context + Headroom noop | pass | 2,559 chars | 56,105 | 41,472 | 961 | +34.1% | `kairn_failure_context_headroom_noop_savings` |

This is a positive Kairn-first result, but not a positive Headroom-added result. It shows Kairn can already turn noisy failure output into a much smaller task signal while preserving quality. Headroom is still likely useful for payloads Kairn does not already compact, but it did not add value on this specific Kairn failure-context output.

## Dual-MCP Orchestrator Simulation

To separate MCP behavior from the problematic Codex proxy wrapper, this pass ran one local orchestrator connected to both stdio MCP servers:

- Kairn MCP: `node dist/cli.js serve --mcp --root <repo-or-fixture>`
- Headroom MCP: `headroom mcp serve`

The orchestrator called Kairn first for governed source or failure context, then passed the selected Kairn payload to Headroom for compression and retrieval. This simulates how an MCP-capable agent could use both tools side by side without putting Headroom in front of every Codex request.

| Row | Kairn Tool | Before | After | Saved | Reduction | Attribution | Classification |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Exact MCP source | `kairn_read_file` | 10,472 | 60 | 10,412 | 99.4% | `src/server/mcp.ts`, `kairn_prepare_task`, `kairn_read_file` preserved | `mcp_combo_source_compression_attribution_preserved` |
| MCP attribution source surface | `kairn_find_context` | 14,143 | 6,349 | 7,794 | 55.1% | `src/eval/codexUsage.ts`, `src/server/mcp.ts`, `mcp_tool_call` preserved | `mcp_combo_source_surface_attribution_preserved` |
| Parser failure context | `kairn_get_failure_context` | 649 | 243 | 406 | 62.6% | `src/parser.js`, `test/parser.test.js`, `parseUserProfile` preserved | `mcp_combo_failure_context_compression_attribution_preserved` |
| Tiny prepare payload | `kairn_prepare_task` | 1,491 | 133 | 1,358 | 91.1% | `src/server/mcp.ts` preserved | `mcp_combo_tiny_prepare_compressed_attribution_preserved` |
| Raw noisy parser log control | none | 11,303 | 11,303 | 0 | 0.0% | `src/parser.js`, `test/parser.test.js` preserved | `mcp_headroom_raw_noise_protected_noop` |

Kairn + Headroom MCP rows only:

- 4 rows
- 26,755 -> 6,785 tokens
- 19,970 tokens saved
- 74.6% aggregate reduction
- 0 lost-attribution rows

This is the strongest positive combo result so far. It does not contradict the negative Codex-wrapper result, because the integration point is different:

- Bad path: wrap all Codex traffic through Headroom proxy.
- Better path: Kairn governs source/failure context first, then Headroom compresses selected MCP payloads.

The dual-MCP result is still not public evidence. It is an orchestrated tool-chain test, not an end-to-end agent benchmark. But it proves the MCPs can be used together technically, and that attribution can survive the handoff.

## MCP Four-Arm Matrix

The next pass compared source-bearing MCP scenarios across four arms:

- Raw baseline payload.
- Headroom-only compression of the raw payload.
- Kairn-only governed MCP payload.
- Kairn MCP payload followed by Headroom MCP compression.

| Scenario | Baseline | Headroom Only | Kairn Only | Kairn + Headroom | Best | Attribution |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Exact source MCP server | 10,053 | 10,053 | 10,472 | 60 | Kairn + Headroom | pass |
| Exact source runtime | 80,020 | 80,020 | 25,961 | 63 | Kairn + Headroom | pass |
| Exact source parser fixture | 122 | 122 | 195 | 195 | Baseline | pass |
| Parser related tests | 356 | 356 | 109 | 109 | Kairn only | pass |
| Parser noisy failure context | 11,303 | 11,303 | 2,072 | 580 | Kairn + Headroom | pass |
| MCP attribution source surface | 62,034 | 62,034 | 14,813 | 6,751 | Kairn + Headroom | pass |

Valid matrix aggregate:

- 6/6 rows preserved attribution.
- Headroom-only: 163,888 -> 163,888 tokens, 0.0% reduction.
- Kairn-only: 163,888 -> 53,622 tokens, 67.3% reduction.
- Kairn + Headroom: 163,888 -> 7,758 tokens, 95.3% reduction.
- Combo was the smallest arm on 4/6 rows.
- Combo was 85.5% lower than Kairn-only on aggregate.
- Heavy-lifting split: 4 Kairn-led rows, 1 Headroom-led tiny row, 1 balanced/scenario-dependent row.

This is the strongest evidence so far that the tools are complementary in MCP form. The caveat is important: Kairn did most of the first-stage work by selecting or summarizing the right source/failure surface. Headroom then gave a strong second-stage compression on selected payloads. That makes the integration direction useful, but it does not make Kairn obsolete.

## End-To-End Agent MCP Checks

Two isolated Codex runs tested whether an actual MCP-capable agent would use the two servers together without wrapper/proxying:

| Attempt | Result | Kairn MCP | Headroom MCP | Interpretation |
| --- | --- | --- | --- | --- |
| Parser fix with both servers available | Quality passed, scope passed | used `kairn_prepare_task`, `kairn_find_tests`, `kairn_read_file` | not used | Valid Kairn MCP proof, but not combo proof. The agent skipped Headroom because Kairn returned small source/test context. |
| Forced repo-root dual-MCP toolchain | No edit task | used `kairn_start_task` | used `headroom_compress`, `headroom_retrieve` | Both servers were callable, but the agent compressed Kairn start-task output instead of first reading the exact file payload. No savings. |

This matters for product design. The MCPs are technically compatible, but relying on the agent to decide the optimal Kairn -> Headroom sequence is currently unreliable. The best next product direction is probably not "tell users to use both MCPs manually." It is a Kairn-side optional compression handoff for large MCP payloads, or very explicit client instructions that only call Headroom after Kairn returns a bulky payload.

Aggregate local payload result:

- All seven rows: 33,875 -> 8,748 tokens, 25,127 saved, 74.2% reduction.
- Kairn + Headroom rows only: 22,202 -> 7,255 tokens, 14,947 saved, 67.3% aggregate reduction.
- Kairn + Headroom median reduction: 34.0%, because tiny guidance and protected error-output rows intentionally nooped.
- Lost-attribution rows: 0.

## Current Interpretation

Headroom appears complementary rather than a direct replacement for Kairn.

- Headroom is strongest as a compression/proxy/MCP layer for content already in the request path.
- Kairn is strongest as a governance layer deciding which repo context belongs in the working session.
- The most plausible combo is Kairn first, Headroom second.
- Headroom is a real competitive pressure against any Kairn positioning that says only "we reduce tokens." Kairn's durable claim should stay centered on context governance: source-surface choice, scope discipline, session memory, evidence requests, and when to stay quiet.
- The strongest Headroom result in this local pass was raw noisy output compression. That does not make Kairn irrelevant; it shows Kairn should either interoperate with a compression layer or develop a post-governance compression stage for bulky evidence/tool output.
- The broad-source control makes the complementarity clearer: Headroom can be excellent after context is selected, but it did not solve source selection by compressing a broad source bundle in this local test.
- The first live coding row is a warning: Headroom's Codex proxy path can increase observed token usage even when its own logs report compression. This should block larger live proxy campaigns until the proxy/retry behavior is understood.
- The failure-prompt row supports Kairn's core product direction: source/failure governance first. Headroom is useful only after Kairn still has a bulky payload worth compressing.

The clean positioning remains:

> Headroom compresses context. Kairn decides what context belongs in the coding session.

## Live Test Gate

Do not run the full four-arm SWE-Pro sample through the Headroom Codex proxy path until the stream retry/token-regression issue is resolved.

Completed:

- MCP SDK-backed tool call:
  - initialized Headroom MCP,
  - listed tools,
  - called `headroom_compress`,
  - confirmed `headroom_stats` recorded compression.
- Kairn + Headroom attribution smoke:
  - Kairn source attribution survived Headroom compression,
  - Headroom retrieval returned source-bearing content.
- Isolated Codex accounting smoke:
  - direct and Headroom-wrapped Codex both returned the expected tiny response,
  - JSON usage accounting was preserved,
  - the live user Codex config remained clean.
- Live parser fixture:
  - all four arms passed quality,
  - Kairn-only was neutral/slightly lower than direct baseline,
  - Headroom-wrapped and Kairn+Headroom-wrapped paths regressed in Codex-observed input tokens.
- Live failure-prompt fixture:
  - full noisy log and Kairn failure-context prompts both passed,
  - Kairn failure context reduced observed input tokens by 34.1% versus the full-log prompt,
  - Headroom nooped on Kairn's already-compact failure context.

Remaining:

1. Decide whether to debug the Headroom proxy path or abandon it for Kairn integration.
2. If continuing, reproduce the retry issue with a minimal Headroom/Codex proxy run and inspect certificate/WebSocket fallback behavior.
3. Prefer the narrower MCP/local compression path for the next combo experiment.

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
