# Kairn Deep Audit - 2026-05-21

## Scope

This audit covered the current Kairn CLI, setup, doctor, telemetry, diagnostics, MCP smoke path, package install shape, and Windows/WSL beta install path.

Checks run:

- WSL source verification: `pnpm typecheck`, `pnpm build`, `pnpm test`.
- WSL targeted regression: `pnpm vitest run tests/cli.test.ts`.
- WSL installed-package smoke from `npm pack`: global temp install, `kairn --version`, `setup wizard`, `doctor`, `telemetry status`, `beta report`, and `setup remove`.
- WSL broader command smoke: `init`, `index status`, `index compact`, `start`, `prime`, `context`, `failure`, `compress`, `diff`, `watch --once`, `metrics`, `ledger`, `eval start`, `eval note`, `eval report`, `diagnostics export`, and `bench mcp-smoke`.
- Native Windows installed-package smoke through PowerShell: Node/npm check, global temp install from the packed tarball, `setup wizard`, `doctor`, `beta report`, and `setup remove`.
- Static pass over the command surface, platform docs, language adapter status, and beta instructions.

## Problems Found And Fixed

1. Fresh setup could immediately report a stale index.

   `kairn setup wizard --index-mode safe` indexed before writing generated integration files such as `.vscode/mcp.json` and `AGENTS.md`. A following `kairn doctor` saw those new files in git status and warned `Index has ... and is stale (dirty_state_changed)`, even though the user had just indexed during setup.

   Fix: the setup wizard now writes integrations first and runs the optional setup index afterward, so index freshness metadata reflects the final post-setup repo state. Added a CLI regression test that asserts the wizard's embedded doctor `index_state` check is `ok` and fresh after indexed setup.

2. README beta Node guidance was stale.

   The README still said "Node.js 20 through 25" and recommended "Node 20 or 22 LTS", while the actual package, preinstall check, and doctor logic require Node `>=20.19 <26` and recommend Node 22 or 24 LTS.

   Fix: README install and native dependency notes now match the runtime policy and beta instructions.

## Verification Results

- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm test`: passed, 14 test files and 270 tests.
- `pnpm vitest run tests/cli.test.ts`: passed, 6 tests.
- WSL package smoke: passed on Node 20.19.2/npm 10.8.2. Setup indexed successfully, `doctor` overall was `warn` only because daemon and telemetry are optional; `index_state` was `ok` and fresh.
- Native Windows package smoke: passed on Node 24.15.0/npm 11.12.1. Setup indexed successfully, `doctor` overall was `warn` only because daemon and telemetry are optional; `index_state` was `ok` and fresh.
- MCP smoke: passed with real stdio server startup and two MCP tool calls.

## Notes

- Go, Rust, and Ruby adapters are intentionally marked as stubs for deep graph support. Universal retrieval still works, and the architecture docs already describe those as future deep adapters rather than fully graph-backed languages.
- The install smoke still prints a transitive `prebuild-install` deprecation warning during native dependency installation. It did not block WSL or Windows install.
- Native Windows npm did not install cleanly from a WSL UNC tarball path in this audit. Copying the tarball to a normal Windows path such as `%TEMP%` or Downloads worked. The beta instructions already tell testers to install from Downloads on native Windows and to copy the tarball into WSL for WSL testing.
- This audit did not launch real VS Code, Claude Code, Gemini, Copilot CLI, or Codex interactive UIs. It verified generated configs, doctor detection, and MCP stdio behavior from the CLI.
- This audit did not rerun long live-agent benchmark campaigns or external official evaluators.

No unaddressed functional blockers were found in the audited local CLI, setup, doctor, package install, WSL, Windows, telemetry-status, diagnostics-export, or MCP-smoke surfaces.
