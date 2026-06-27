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

## Competitive Read

Headroom is not a direct Kairn clone. It is strongest as a compression/proxy layer after context is already in the request path. Kairn is strongest as a source-governance layer before context reaches the agent.

The clean public distinction to preserve:

> Headroom compresses context. Kairn decides what context belongs in the coding session.

## Integration Cautions

- Do not put Headroom before Kairn if that hides filenames, source paths, symbols, MCP attribution, or task-shape evidence from Kairn.
- Treat Headroom as a black-box dependency for tests. Do not copy implementation code into Kairn.
- Use passthrough mode as a control before attributing any result to compression.
- Keep Headroom logs and any raw traffic out of tracked evidence.
