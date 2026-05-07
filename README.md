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
pnpm dev -- metrics --session <session-id> --root /path/to/repo
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

Examples live in `examples/.codex/config.toml`, `examples/.codex/hooks.json`, and `examples/claude/settings.json`. Set `KAIRN_SESSION` to the active Kairn task session before enabling those hooks. If the hook host cannot find the global `kairn` binary, set `KAIRN_CMD` to an absolute command such as `node /Users/kevindotel/Documents/Projects/kairn/dist/cli.js`.

Codex project hooks require a trusted repo `.codex/` config and the hooks feature flag:

```toml
[features]
codex_hooks = true
```

The Codex example observes `PostToolUse` for `Bash|apply_patch|mcp__.*` and `UserPromptSubmit`. Stop hooks are supported too, but Kairn only emits host JSON when it has useful additional context. The Claude example observes `PostToolUse`, `PostToolUseFailure`, and `FileChanged` for common project config files; use `kairn watch` for repo-wide file observation.

## Metrics

Metrics are local-only and approximate. Kairn records one additive metrics row for each context, diff, test-discovery, file/symbol read, and compression response. The baseline is an estimate of what the agent likely would have needed without Kairn, such as full source for suggested files or raw command output. The output count is Kairn's returned token estimate.

```bash
kairn metrics --session task_123 --root /path/to/repo
kairn metrics --session task_123 --root /path/to/repo --json
```

The useful first number while testing Codex hooks is `estimated tokens saved`. It is not billing-grade accounting; it is a directional measure for whether Kairn is reducing repeated context and compressing noisy command output.

## Eval Harness

The eval harness records proof from manual A/B Codex runs. Kairn does not launch Codex or spend quota automatically; you run the baseline and Kairn-assisted sessions yourself, then ingest the Codex usage footer.

```bash
# Baseline: Codex without Kairn hook output, or with hooks disabled.
kairn eval start --root /path/to/repo --session task_123 --task "Fix mobile layout" --mode baseline --label baseline

# Kairn-assisted: Codex with Kairn hooks/MCP enabled.
kairn eval start --root /path/to/repo --session task_123 --task "Fix mobile layout" --mode kairn --label kairn

# Paste the footer from Codex at the end of each run.
kairn eval ingest-codex --root /path/to/repo --session task_123 --run eval_abc --usage "Token usage: total=33,729 input=33,253 (+ 24,704 cached) output=476"

# Add the human outcome and compare.
kairn eval note --root /path/to/repo --run eval_def --outcome pass --summary "Completed and tests passed" --files src/app.ts
kairn eval compare --root /path/to/repo --baseline eval_abc --kairn eval_def
kairn eval report --root /path/to/repo --session task_123
```

`ingest-codex` can also read a transcript path for best-effort metadata:

```bash
kairn eval ingest-codex --root /path/to/repo --session task_123 --run eval_def --transcript ~/.codex/sessions/...
```

Kairn stores parsed token totals, hashes, file references, and summaries. It does not store raw Codex transcripts or raw command output. Eval reports separate observed Codex usage from Kairn's estimated context savings; V1 is directional proof, not billing-grade token accounting.

## Benchmarks

Benchmarks automate the cheap part of proving Kairn: replaying known context queries, scoring expected files, and comparing before/after runs. Replay mode is deterministic and safe to run often.

```bash
kairn bench run --root /path/to/repo --mode replay
kairn bench report --root /path/to/repo --run bench_123
kairn bench compare --root /path/to/repo --before bench_old --after bench_new
kairn bench export --root /path/to/repo --run bench_123 --format md
```

The default suite adapts to the target repo and covers UI context, parser/backend context, auth/access context, test discovery, diff review, and hook failure linking. You can also pass a JSON suite:

```bash
kairn bench run --root /path/to/repo --suite ./kairn-bench.json --mode replay --json
```

For a stronger validation pass, run the default suite first, then a focused suite for the workflow you care about, then compare the two reports. The job tracker validation suite is included as a concrete example:

```bash
TARGET_REPO="/Users/kevindotel/Documents/Projects/new-site/my-portfolio"
kairn bench run --root "$TARGET_REPO" --mode replay --json
kairn bench run --root "$TARGET_REPO" --suite examples/bench/job-tracker-focused.json --mode replay --json
```

Agent benchmarks are opt-in. Kairn copies the target repo into a disposable temp workspace and only runs an agent when you pass an explicit command:

```bash
kairn bench run --root /path/to/repo --mode agent --agent-command "codex exec --model gpt-5.4-mini {prompt}"
```

Without `--agent-command`, agent cases are recorded as skipped. Benchmark reports can recommend scoring or routing improvements, but they never edit Kairn automatically.

## State

Kairn stores generated state in the target repo under `.kairn/`. This includes local SQLite metadata, sessions, scans, traces, watch events, metrics, compressed command summaries, and hashes. Raw source files and raw command output are not copied into Kairn state.

## Native Dependency Notes

Kairn uses native Tree-sitter bindings for AST parsing. On Node 24, a fresh source build may need C++20 enabled:

```bash
CXXFLAGS="-std=c++20" pnpm install
```
