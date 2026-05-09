# Kairn

Kairn is a local-first dynamic context runtime for software engineering agents.

It runs beside coding agents and answers live context questions against a target repository: which files matter, what source should be read exactly, what can be summarized, which tests are related, and what changed in the current diff.

## Status

MCP, CLI, semantic retrieval, TypeScript graph enrichment, BM25 lexical retrieval, watcher/hooks, proactive priming, and eval/benchmark MVPs are in progress.

For a full map of the current layers and data flow, see `docs/kairn_architecture_overview.md`.

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
pnpm dev -- prime "job tracker mobile layout" --root /path/to/repo
```

## Runtime Surfaces

- MCP tools for agent-native context requests.
- CLI wrappers for humans and agents without MCP.
- Watcher/hooks for observe-and-react session updates.
- TypeScript language-service graph enrichment for JS/TS definitions, references, calls, implementations, and type references.
- BM25 exact lexical retrieval for identifiers and status terms that should not be blurred by vector scoring.

## Watcher And Hooks

Watcher mode observes local work and updates the same task session used by MCP and CLI context commands:

```bash
kairn watch --session task_123 --root /path/to/repo
kairn watch --session task_123 --root /path/to/repo --once --json
```

Hook mode ingests JSON from agent host hooks. V1 is observe/react only: it records events, routes failures through failure-first context, compresses non-trivial output, links failures to source files, and recommends next context. It does not block or approve tool calls.

Kairn normalizes the official snake_case Codex and Claude payload fields, including `hook_event_name`, `session_id`, `tool_name`, `tool_input`, `tool_response`, `tool_calls`, `file_path`, `error`, and host session metadata. Raw output-bearing fields are hashed in stored metadata; summaries and file references are kept.

```bash
kairn hook --session task_123 --root /path/to/repo --source generic --json
kairn hook --session task_123 --root /path/to/repo --source claude
kairn hook --session task_123 --root /path/to/repo --source codex
```

For failed tests, lint, typecheck, or stack traces, use failure-first context directly:

```bash
kairn failure --session task_123 --root /path/to/repo --type test --output-file /tmp/test-output.txt
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

Examples live in `examples/.codex/config.toml`, `examples/.codex/hooks.json`, and `examples/claude/settings.json`. For Codex, the recommended setup is sessionless:

```bash
kairn setup codex --root /path/to/repo
```

After that, open normal `codex` in the repo and submit a task. The default `savings` setup installs only `UserPromptSubmit` with a quality-gated full-prime brief, so Kairn can create or reuse a task session and point Codex at high-confidence start files before broad repo scanning. Use `--hook-output tiny-directive` only for delivery experiments, `--mode observe --post-tool-hook-output failure-only` to add failure-only post-tool context, `--mode debug` for broad diagnostics, `--mode mcp-first` to install Kairn as a Codex MCP server plus MCP-first guidance with no prompt prime, or `--mode hybrid` to install MCP plus a tiny prompt hook that tells Codex which Kairn session/files to start with before calling MCP. If the hook host cannot find the global `kairn` binary, set `KAIRN_CMD` to an absolute command such as `node /Users/kevindotel/Documents/Projects/kairn/dist/cli.js`.

Codex project hooks require a trusted repo `.codex/` config and the hooks feature flag:

```toml
[features]
codex_hooks = true
```

The Codex example uses the savings-first setup: proactive `UserPromptSubmit` only. Stop and post-tool hooks are supported in observe/debug modes, but Kairn only emits host JSON when it has useful additional context. For lower latency, run `kairn daemon --root /path/to/repo` in another terminal; hooks will use the warm runtime when available and fall back to direct CLI execution otherwise. The Claude example observes `PostToolUse`, `PostToolUseFailure`, and `FileChanged` for common project config files; use `kairn watch` for repo-wide file observation.

## Metrics

Metrics are local-only and approximate. Kairn records one additive metrics row for each context, diff, test-discovery, file/symbol read, and compression response. The baseline is an estimate of what the agent likely would have needed without Kairn, such as full source for suggested files or raw command output. The output count is Kairn's returned token estimate.

```bash
kairn metrics --session task_123 --root /path/to/repo
kairn metrics --session task_123 --root /path/to/repo --json
```

The useful first number while testing Codex hooks is `estimated tokens saved`. It is not billing-grade accounting; it is a directional measure for whether Kairn is reducing repeated context and compressing noisy command output.

## Eval Harness

The eval harness records proof from manual A/B Codex runs. For manual sessions, you run the baseline and Kairn-assisted sessions yourself, then ingest the Codex usage footer.

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

When a transcript is ingested, Kairn also extracts metadata-only feedback: files read, files edited, commands run, test commands, outcome hints, and transcript hash. It does not store the raw transcript. Use feedback to compare Kairn recommendations against actual agent behavior:

```bash
kairn eval feedback --root /path/to/repo --session task_123
```

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

Before broad live-agent testing, run a repo-matrix preflight. This clones or opens several repos, runs Kairn indexing and `prime` only, then checks state size, prime latency, expected source files, noisy-file drift, and weak-prompt suppression without spending agent tokens.

```bash
kairn bench matrix --matrix examples/bench/repo-matrix.json --workdir /tmp/kairn-repo-matrix --json
```

The included matrix is intentionally retrieval-only. Treat failures as a signal to improve general source targeting, suppression, or state discipline before running expensive Codex proofs.

Agent benchmarks are opt-in. Kairn copies the target repo into a disposable temp workspace and only runs an agent when you pass an explicit command. If the command output contains a Codex footer like `Token usage: total=33,729 input=33,253 (+ 24,704 cached) output=476`, Kairn parses it automatically and shows observed Codex usage in benchmark reports.

```bash
kairn bench run --root /path/to/repo --mode agent --agent-command "codex exec --model gpt-5.4-mini --sandbox workspace-write {prompt}"
```

For direct A/B runs, use `bench ab`. It runs the same agent cases twice in disposable workspaces, once with the baseline command and once with the Kairn-assisted command, then compares observed Codex token totals when footers are present.

```bash
kairn bench ab \
  --root "$TARGET_REPO" \
  --suite examples/bench/job-tracker-agent-light.json \
  --baseline-command "codex exec --model gpt-5.4-mini --sandbox workspace-write {prompt}" \
  --kairn-command "codex exec --model gpt-5.4-mini --sandbox workspace-write {prompt}" \
  --json
```

Use the Kairn command variant that matches your local hook setup. The `{prompt}` and `{root}` placeholders are shell-quoted and replaced per disposable workspace. The included `examples/bench/job-tracker-agent-light.json` suite contains three read-only Codex prompts for mobile UI, sync review, and parser/backend validation.

Without `--agent-command`, agent cases are recorded as skipped. Benchmark reports can recommend scoring or routing improvements, but they never edit Kairn automatically.

Seeded agent cases let you validate Kairn on large public repos without mutating your real working tree. Add a `seed` object to an agent benchmark case with a pinned `repoUrl`, `ref`, optional `setupPatch` or `setupPatchFile`, setup commands, an `expectedFailureCommand`, and a final `testCommand`. Kairn clones the seed into a disposable temp workspace, applies the patch, runs the agent, then runs the verification command and scores tokens, expected-file mentions, changed files, and pass/fail.

```json
{
  "id": "seeded-debug",
  "mode": "agent",
  "task": "Debug the seeded failing test. Do not edit unrelated files.",
  "expectedFiles": ["packages/core/src/cache.ts", "packages/core/src/cache.test.ts"],
  "excludedFiles": ["docs/", "examples/"],
  "seed": {
    "repoUrl": "https://github.com/example/large-typescript-repo.git",
    "ref": "pinned_commit_sha",
    "cloneDepth": 1,
    "setupCommands": ["pnpm install --ignore-scripts"],
    "setupPatchFile": "./patches/cache-regression.patch",
    "expectedFailureCommand": "pnpm test packages/core/src/cache.test.ts",
    "testCommand": "pnpm test packages/core/src/cache.test.ts"
  }
}
```

Use this for harder debugging proofs:

```bash
kairn bench prove \
  --root /Users/kevindotel/Documents/Projects/kairn \
  --suite ./seeded-debug-suite.json \
  --baseline-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --prompt-only-command "kairn setup codex --root {root} --mode savings >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --prompt-plus-hooks-command "kairn setup codex --root {root} --mode observe >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --repeat 3 \
  --shuffle-order \
  --json
```

The included `examples/bench/seeded-large-js-ts-template.json` shows the intended shape for pinned public JS/TS repos. `examples/bench/seeded-cross-language.json` adds concrete TypeScript, Python, Java, and C++ seeded debugging cases against pinned public repos. Java validation requires Maven, and C++ validation requires a local `c++` compiler.

```bash
kairn bench prove \
  --root /Users/kevindotel/Documents/Projects/kairn \
  --suite examples/bench/seeded-cross-language.json \
  --baseline-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --hook-full-prime-command "kairn setup codex --root {root} --mode savings --hook-output full-prime >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --real-mcp-first-command "kairn setup codex --root {root} --mode mcp-first >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --hybrid-mcp-brief-command "kairn setup codex --root {root} --mode hybrid >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --manual-prime-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --repeat 3 \
  --shuffle-order \
  --json
```

## Proactive Context

For discovery-heavy tasks, `prime` creates or reuses a task session, runs Kairn retrieval, scores prime quality, and emits a compact prompt prefix with ranked files, snippets, related files, likely tests, and guidance to avoid broad scans unless the brief is insufficient.

```bash
kairn prime "job tracker mobile layout" --root "$TARGET_REPO" --profile auto
kairn prime "job tracker mobile layout" --root "$TARGET_REPO" --json
```

For the proven high-savings path without manual copy/paste, use the Codex wrapper:

```bash
kairn codex "debug the query key hashing regression" --root "$TARGET_REPO" --model gpt-5.4-mini
```

Normal Codex can receive automatic context through the prompt-submit hook after `kairn setup codex`. Hook delivery is useful for everyday low-friction usage, but benchmark it separately from manual/wrapper prime because Codex may weight hook `additionalContext` differently from prompt-prepended context.

To prove whether proactive context helps, compare live-agent modes. Repeat runs are preferred because live Codex usage has high variance:

```bash
kairn bench prove \
  --root "$TARGET_REPO" \
  --suite examples/bench/job-tracker-agent-light.json \
  --baseline-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --hook-full-prime-command "kairn setup codex --root {root} --mode savings --hook-output full-prime >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --hook-tiny-directive-command "kairn setup codex --root {root} --mode savings --hook-output tiny-directive >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --hook-tiny-with-failures-command "kairn setup codex --root {root} --mode observe --hook-output tiny-directive --post-tool-hook-output failure-only >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --manual-prime-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --mcp-first-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --real-mcp-first-command "kairn setup codex --root {root} --mode mcp-first >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --disable codex_hooks {prompt}" \
  --hybrid-mcp-brief-command "kairn setup codex --root {root} --mode hybrid >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable codex_hooks {prompt}" \
  --repeat 3 \
  --shuffle-order \
  --json
```

V1 treats post-tool hooks as observation/failure support, not the main savings path. The key validation number is median observed Codex tokens for each automatic mode versus baseline and manual prime. Hybrid mode is intentionally not full-prime plus MCP; the hook stays tiny and MCP is responsible for deeper reads, which avoids paying twice for the same context.

MCP remains an explicit tool surface: `kairn serve --mcp` gives an agent Kairn context tools, but the agent must call those tools or be instructed to ask Kairn before reading files directly. The MCP server includes `kairn_prepare_task`, `kairn_get_next_context`, and `kairn_get_failure_context` for MCP-first workflows where the agent asks Kairn before broad file reads. MCP calls are recorded separately from output mentions, so benchmark reports can distinguish "the agent mentioned Kairn" from "the agent actually called Kairn MCP tools."

```bash
kairn setup codex --mode mcp-first --root "$TARGET_REPO"
kairn setup codex --mode hybrid --root "$TARGET_REPO"
kairn serve --mcp --root "$TARGET_REPO"
```

## State

Kairn stores generated state in the target repo under `.kairn/`. This includes local SQLite metadata, sessions, scans, traces, watch events, metrics, compressed command summaries, and hashes. Raw source files and raw command output are not copied into Kairn state.

## Native Dependency Notes

Kairn uses native Tree-sitter bindings for AST parsing. On Node 24, a fresh source build may need C++20 enabled:

```bash
CXXFLAGS="-std=c++20" pnpm install
```
