# Kairn

Kairn is a local-first dynamic context runtime for software engineering agents.

It runs beside coding agents and answers live context questions against a target repository: which files matter, what source should be read exactly, what can be summarized, which tests are related, and what changed in the current diff.

## Status

MCP, CLI, semantic retrieval, and watcher/hook MVPs are in progress.

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
pnpm dev -- watch --session <session-id> --root /path/to/repo --once
```

## Runtime Surfaces

- MCP tools for agent-native context requests.
- CLI wrappers for humans and agents without MCP.
- Watcher/hooks for observe-and-react session updates.

## Watcher And Hooks

Watcher mode observes local work and updates the same task session used by MCP and CLI context commands:

```bash
kairn watch --session task_123 --root /path/to/repo
kairn watch --session task_123 --root /path/to/repo --once --json
```

Hook mode ingests JSON from agent host hooks. V1 is observe/react only: it records events, compresses command output, links failures to source files, and recommends next context. It does not block or approve tool calls.

Kairn normalizes the official snake_case Codex and Claude payload fields, including `hook_event_name`, `session_id`, `tool_name`, `tool_input`, `tool_response`, `tool_calls`, `file_path`, `error`, and host session metadata. Raw output-bearing fields are hashed in stored metadata; summaries and file references are kept.

```bash
kairn hook --session task_123 --root /path/to/repo --source generic --json
kairn hook --session task_123 --root /path/to/repo --source claude
kairn hook --session task_123 --root /path/to/repo --source codex
```

Generic hook payloads may include:

```json
{
  "eventName": "PostToolUse",
  "toolName": "shell",
  "command": "pnpm test",
  "output": "FAIL src/app.test.ts:3:1",
  "exitCode": 1,
  "files": ["src/app.test.ts"],
  "hostSessionId": "agent-session-id"
}
```

Examples live in `examples/.codex/config.toml`, `examples/.codex/hooks.json`, and `examples/claude/settings.json`. Set `KAIRN_SESSION` to the active Kairn task session before enabling those hooks.

Codex project hooks require a trusted repo `.codex/` config and the hooks feature flag:

```toml
[features]
codex_hooks = true
```

The Codex example observes `PostToolUse` for `Bash|apply_patch|mcp__.*` and `UserPromptSubmit`. Stop hooks are supported too, but Kairn only emits host JSON when it has useful additional context. The Claude example observes `PostToolUse`, `PostToolUseFailure`, and `FileChanged` for common project config files; use `kairn watch` for repo-wide file observation.

## State

Kairn stores generated state in the target repo under `.kairn/`. This includes local SQLite metadata, sessions, scans, traces, watch events, compressed command summaries, and hashes. Raw source files and raw command output are not copied into Kairn state.

## Native Dependency Notes

Kairn uses native Tree-sitter bindings for AST parsing. On Node 24, a fresh source build may need C++20 enabled:

```bash
CXXFLAGS="-std=c++20" pnpm install
```
