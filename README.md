# Kairn

Kairn is a local-first dynamic context runtime for software engineering agents.

It runs beside coding agents and answers live context questions against a target repository: which files matter, what source should be read exactly, what can be summarized, which tests are related, and what changed in the current diff.

## Status

MCP MVP in progress.

## Quick Start

```bash
pnpm install
pnpm build
pnpm kairn init --root /path/to/repo
pnpm kairn start "Add filtering to the dashboard" --root /path/to/repo
pnpm kairn serve --mcp --root /path/to/repo
```

During local development, use:

```bash
pnpm dev -- init --root /path/to/repo
pnpm dev -- start "Add filtering to the dashboard" --root /path/to/repo
pnpm dev -- context --session <session-id> --file src/app.ts --root /path/to/repo
```

## Runtime Surfaces

- MCP tools for agent-native context requests.
- CLI wrappers for humans and agents without MCP.
- Watcher/hooks later, after the runtime is stable.

## State

Kairn stores generated state in the target repo under `.kairn/`. This includes local SQLite metadata, sessions, scans, and traces. Raw source files are not copied into Kairn state.
