# Headroom Inventory For Kairn Combo Evaluation - 2026-06-26

## Source Snapshot

- Repository reviewed: `https://github.com/headroomlabs-ai/headroom`
- Local review path: `/tmp/headroom-kairn-review`
- Reviewed commit: `9f772378d3e1f1f5145af6c1868c6c6bd4b6f557`
- Commit title: `test(proxy): assert CCR hash route guard blocks valid hashes (#1480)`
- Python package name: `headroom-ai`
- Current package version in repo and PyPI smoke: `0.27.0`
- License: Apache-2.0
- Agent eval project: nested `agent-evals`, version `0.0.1`, Apache-2.0

## Install And Entry Points

- Python install:
  - `pip install "headroom-ai[mcp]"`
  - `pip install "headroom-ai[proxy]"`
- CLI entrypoint:
  - `headroom`
- Main modes exposed by docs/CLI:
  - Library compression.
  - HTTP proxy: `headroom proxy`.
  - Agent wrapper: `headroom wrap claude|codex|aider|copilot|opencode`.
  - MCP server: `headroom mcp serve`.
  - Learning/memory surfaces: `headroom learn`, `headroom memory`.
  - Observability: `headroom perf`, `headroom dashboard`, `headroom output-savings`.

## Relevant Capabilities For Kairn

- Proxy passthrough mode exists through `headroom proxy --no-optimize`.
- Codex wrapper exists through `headroom wrap codex`.
- MCP server exposes on-demand compression, retrieval, and stats tools:
  - `headroom_compress`
  - `headroom_retrieve`
  - `headroom_stats`
- Proxy exposes health and metrics surfaces:
  - `/livez`
  - `/readyz`
  - `/health`
  - `/stats`
  - `/stats-history`
  - `/metrics`
- Headroom positions itself as a context compression layer that operates on tool outputs, logs, RAG chunks, files, and conversation history before provider calls.

## Local Smoke Results

- `pip install "headroom-ai[mcp]"`: passed in `/tmp/headroom-kairn-smoke-venv`.
- `pip install "headroom-ai[proxy]"`: passed in `/tmp/headroom-kairn-smoke-venv`.
- `headroom --version`: `headroom, version 0.27.0`.
- `headroom mcp status`: exited successfully; MCP SDK installed, no Claude config, proxy not running.
- `headroom mcp serve` SDK probe: initialized, listed `headroom_compress`, `headroom_retrieve`, and `headroom_stats`, then completed a compress/retrieve/stats round trip.
- `headroom proxy --port 18787 --no-optimize --no-cache`: passed `/livez` health check with HTTP 200.
- Kairn source build on this branch: passed, `kairn --version` reports `0.1.4`, `darwin-arm64`, `source`.
- Kairn + Headroom prepare-task combo: Kairn MCP returned runtime/governor attribution; Headroom preserved both paths and used `router:noop` because the payload was only 192 estimated tokens.
- Kairn + Headroom source-payload combo: Kairn MCP returned exact source for `src/runtime/KairnRuntime.ts`; Headroom compressed 3,633 estimated tokens to 63 while preserving the file path and retrieval.
- Expanded local payload matrix: seven Headroom MCP compress/retrieve calls completed. Kairn+Headroom saved 14,947 of 22,202 tokens across six local Kairn payloads, with zero lost-attribution rows. Headroom-only raw noisy output saved 10,180 of 11,673 tokens and preserved all required source/test strings through retrieval.
- Broad source negative control: Headroom-only protected a 133,141-token raw source bundle as recent code and did not compress it. That preserves source text, but it does not solve source-surface selection or prompt pressure by itself.
- Codex wrapper sanity: `headroom wrap codex --no-context-tool --no-mcp --no-serena -- --version` launched successfully, but injected a Headroom provider into the live Codex config. The generated backup was restored. Future live combo tests should use isolated `CODEX_HOME` or a no-mutation proxy path.
- Isolated Codex accounting sanity: direct Codex and Headroom-wrapped Codex both returned the expected tiny response. Direct JSON usage was 12,917 input / 24 output tokens. Headroom-wrapped JSON usage was 12,880 input / 25 output tokens. This proves wrapper accounting viability, not a savings claim.
- Live parser fixture: all four arms passed quality, but Headroom-wrapped Codex used more observed input tokens than direct Codex, and Kairn+Headroom used much more. This appears tied to proxy/WebSocket retry behavior. Treat the current Codex proxy wrapper path as not production-promising for Kairn until debugged.
- Live failure-prompt fixture: full noisy-log prompting and Kairn failure-context prompting both passed. Kairn failure context reduced observed input tokens by 34.1% versus full-log prompting. Headroom nooped on the Kairn output, so this is Kairn-first savings rather than combined savings.
- Dual-MCP orchestrator simulation: one local client connected to both Kairn MCP and Headroom MCP. Kairn+Headroom MCP rows compressed 26,755 -> 6,785 tokens, saving 19,970 tokens (74.6%) with zero lost-attribution rows. This is a promising MCP-side integration path and is distinct from the negative Codex proxy-wrapper result.
- MCP four-arm matrix: 6 source-bearing scenarios compared raw baseline, Headroom-only, Kairn-only, and Kairn+Headroom. Attribution passed on 6/6 rows. Kairn+Headroom was best on 4/6 rows and reduced aggregate tokens 95.3% vs baseline, 85.5% vs Kairn-only, and 95.3% vs Headroom-only. Heavy lifting was Kairn-led on 4/6 rows.
- End-to-end agent MCP checks: Codex can call both MCP servers from isolated config, and the parser fix passed while using Kairn MCP. However, Codex did not naturally call Headroom on the coding task, and a forced dual-MCP no-edit task did not follow the optimal Kairn-read -> Headroom-compress sequence. This suggests product integration should automate the compression handoff instead of relying on user/agent choreography.

## Competitive Read

Headroom is not a direct Kairn clone. It is strongest as a compression/proxy layer after context is already in the request path. Kairn is strongest as a source-governance layer before context reaches the agent.

The broad-source control reinforces that distinction: Headroom protected broad recent-code payloads in this local test, so broad source selection still needs a governance layer before compression.

The clean public distinction to preserve:

> Headroom compresses context. Kairn decides what context belongs in the coding session.

## Integration Cautions

- Do not put Headroom before Kairn if that hides filenames, source paths, symbols, MCP attribution, or task-shape evidence from Kairn.
- Do not run `headroom wrap codex` against the user's live Codex config during automated tests unless the config mutation is explicitly accepted and restored.
- Prefer MCP-to-MCP composition over global Codex proxy wrapping for future Kairn integration experiments.
- Treat Headroom as a black-box dependency for tests. Do not copy implementation code into Kairn.
- Use passthrough mode as a control before attributing any result to compression.
- Keep Headroom logs and any raw traffic out of tracked evidence.
