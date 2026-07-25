# Kairn

Kairn is the local repository evidence layer for the coding agents you already use.

It maps the current checkout, points supported agents toward the smallest useful production-source scope, and reduces unnecessary searching, repeated reads, context, and tokens. Repository indexing, evidence ranking, session state, hooks, and MCP delivery run locally without a Kairn account, API key, hosted backend, or trajectory upload.

Token reduction is a core benefit, but it only counts when the compared run still reaches the required source and passes external verification. Kairn reports observed agent tokens separately from estimated context size and preserves negative token deltas as regressions.

## Status

The CLI, MCP server, local index, hooks, task ledger, bounded evidence ranker, and evaluation harness are under active v0.2 development. Codex is the most-tested automatic path. Claude Code, Gemini CLI, Copilot CLI, VS Code, and generic MCP clients are supported integration targets; support does not imply equal published efficacy evidence.

For a full map of the current layers and data flow, see `docs/kairn_architecture_overview.md`. The frozen v0.2C-S model-selection, holdout, runtime, and candidate-promotion state is summarized in `docs/v02c-semantic-candidates.md`.

The source checkout is licensed under Apache-2.0. The local product is intended to remain complete without a Kairn-hosted service. Kairn does not capture reasoning traces, route models, provide a trajectory dashboard, or build hosted collective memory. See `docs/privacy-boundary.md`, `SECURITY.md`, and `CONTRIBUTING.md`.

## Install Once, Enable Per Repository

Kairn's beta distribution path is npm first because it works across macOS, Linux, and Windows with one Node-based CLI. Enabling remains repository-scoped so Kairn can preview and safely own only the relevant agent configuration.

Requirements:

- Node.js 20.19 or newer, below Node 26. Node 22 or 24 LTS is the recommended private beta path. Kairn's parser uses WASM Tree-sitter to avoid the old native Tree-sitter build failure on newer Node releases.
- Git
- Codex CLI for the terminal hook/session path, or an MCP-capable client such as Claude Code, GitHub Copilot CLI, Gemini CLI, VS Code/Copilot, Antigravity, Avante/MCPHub, or another MCP client

The v0.2 public-beta command will be:

```bash
npm install -g usekairn@beta
cd /path/to/repo
kairn enable
```

The `usekairn@beta` registry tag is a release gate, not proof that the current
checkout has been published. Until the release workflow verifies and publishes
the v0.2 artifact, install the locally packed tarball below. Do not use an older
registry beta as evidence for this checkout's behavior.

`kairn enable` detects supported local agents, previews Kairn-owned changes, configures their tested hook or MCP path after one confirmation, builds the local inventory, and runs setup checks. If no supported client can be detected, it still builds the inventory and prints a copy-ready generic MCP configuration. Use `kairn enable --dry-run` to inspect the plan or `kairn enable --agents codex,claude-code --yes` for an explicit non-interactive selection.

The inventory retains every non-ignored repository path. Content parsing, symbols, graph enrichment, and chunks stay bounded: oversized or lower-priority files remain available for exact path and basename evidence without being read eagerly.

### Local semantic model

Kairn's semantic candidate lane uses a real CPU-only ONNX embedding model. It does not assign semantic relevance from regular expressions, filename tokens, or hashed bag-of-words vectors. Structural parsers may still extract objective paths, symbols, imports, compiler locations, stack traces, and file roles; the model supplies semantic similarity, and deterministic policy controls exclusions, budgets, delivery, and abstention.

The preferred pinned model is `jina-code-v2-q8`, derived from `jinaai/jina-embeddings-v2-base-code` at an immutable revision. Its checksummed local directory is about 158 MiB and is shared across repositories under the user Kairn cache. Retrieval never downloads a model automatically.

```bash
kairn model status
kairn model install
kairn model verify
kairn model remove

# Configure agents and build the cheap inventory without offering a download.
kairn enable --offline
```

Normal `kairn enable` shows the model id, source revision, license, download size, and cache location before one explicit confirmation. Installation stages every artifact atomically and verifies its pinned SHA-256 checksum. A missing, corrupt, incompatible, or stale model produces a visible fallback to exact path, failure, symbol, BM25, git, session, and graph evidence. It never restores pseudo-semantic hashing.

File-level documents are built for eligible source files, with additional bounded symbol documents allocated across large files. Generated and vendor files are excluded from the semantic lane; an explicit path or precise failure can still hard-pin one without requiring semantic relevance. Once installed, indexing and retrieval work with outbound networking blocked; repository content, evidence, prompts, and agent trajectories are not sent to a Kairn service.

Candidate generation currently supports `legacy`, `shadow`, and `semantic` rollout modes. Shadow computes and records model-based candidates while serving the rollback generator; semantic mode serves the global embedding lane. Promotion remains gated on public-repository candidate recall, per-language results, runtime limits, and verification quality.

For private beta tarballs or local source builds:

```bash
# maintainer/source checkout
pnpm install
pnpm build
npm pack

# beta user
nvm install 24
nvm use 24
npm install -g ./usekairn-0.2.0.tgz
cd /path/to/repo
kairn enable
```

The existing guided and scriptable setup commands remain available for advanced or single-client configuration:

| Choice | Best for | What it configures |
| --- | --- | --- |
| Codex CLI session/hooks | Terminal Codex users | Default source-first hooks plus the `kairn codex` session-bound path. |
| Claude Code MCP | Claude users | Project `.mcp.json` plus MCP-first `AGENTS.md` guidance. Advanced Claude hooks are optional. |
| Copilot CLI MCP | Copilot terminal users | A safe user-config template for `~/.copilot/mcp-config.json`; writes only with explicit confirmation or `--install-user`. |
| Gemini CLI MCP | Gemini users | Project `.gemini/settings.json` with `mcpServers.kairn`. |
| VS Code / Copilot MCP | Editor users or users who do not want hooks | `.vscode/mcp.json` and MCP-first `AGENTS.md` guidance. |
| Generic MCP | Antigravity, Avante/MCPHub, or other clients | JSON config output to paste into that client's MCP settings. |

Scriptable setup is available for docs, CI, and support:

```bash
kairn setup wizard --root /path/to/repo --choice codex --yes
kairn setup wizard --root /path/to/repo --choice mcp --yes
kairn setup wizard --root /path/to/repo --targets claude-code,gemini-cli --yes --no-index
kairn setup mcp --root /path/to/repo --client copilot-cli --json
kairn doctor --root /path/to/repo
kairn doctor --root /path/to/repo --target gemini-cli
kairn doctor --root /path/to/repo --fix
```

During rapid tarball beta updates, run `kairn doctor --fix` inside a repo after installing the new tarball. It rewrites only Kairn-owned hook/MCP entries to the current `kairn` command path and leaves unrelated client config alone. Use `--target vscode`, `--target claude-code`, `--target gemini-cli`, or `--target codex` to repair one integration.

If sanitized telemetry is enabled, Kairn uploads at safe command boundaries: when `kairn codex` exits and when `kairn beta report` runs. Prompt hooks do not perform network uploads during an agent turn. Private beta telemetry defaults to the Kairn Supabase ingest endpoint when users opt in with `kairn telemetry enable --destination supabase`.

To remove Kairn from a repo:

```bash
kairn disable
kairn disable --delete-state
npm uninstall -g usekairn
```

`kairn disable` delegates to the same ownership-aware removal path as `setup remove`: it deletes Kairn-owned hooks, MCP entries, and guidance while preserving unrelated user configuration. Without `--delete-state`, it keeps local indexes and session state but disables telemetry upload.

On Windows, the wizard defaults to a safe setup index that avoids WASM AST parsing during first setup. If native indexing still misbehaves, run `kairn setup wizard --no-index`, then use `kairn index refresh --safe --root <repo>` or WSL as a fallback.

Homebrew, Winget, and signed native installers are packaging targets, not the first beta path. They are useful once the npm path, hook review flow, MCP setup, and `kairn doctor` checks are stable on other machines.

## Quick Start

```bash
pnpm install
pnpm build
pnpm kairn enable --root /path/to/repo
pnpm kairn start "Fix redirect handling" --root /path/to/repo
pnpm kairn serve --mcp --root /path/to/repo
```

During local development, use:

```bash
pnpm dev -- init --root /path/to/repo
pnpm dev -- start "Fix redirect handling" --root /path/to/repo
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
- Global CPU-only ONNX semantic retrieval over bounded structural file and symbol documents.
- BM25 exact lexical retrieval for identifiers and status terms that should not be blurred by vector scoring.

## Evidence And Token Claims

Kairn treats token efficiency and source quality as a joint result. The controlled experiment command freezes a four-arm Vanilla/ReasonBlocks/Kairn/Kairn-plus-ReasonBlocks protocol, records an ordered file/tool/provider trace, and generates a provenance-bearing `public-evidence.v1.json` artifact:

```bash
kairn bench experiment \
  --plan comparison-v1.json \
  --out artifacts/comparison-v1 \
  --seed 20260722 \
  --dry-run
```

Live ReasonBlocks arms additionally require `REASONBLOCKS_API_KEY`, `ANTHROPIC_API_KEY`, public pinned repositories, and `--allow-external-trajectory`. Normal Kairn operation requires none of them. The report keeps cached/uncached input, output, time and tokens before required source, explicit-noise reads, unnecessary emissions, cross-turn rereads, signed regressions, and external verification separate.

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

After that, open normal `codex` in the repo and submit a task. The default `source-first` setup installs only `UserPromptSubmit` with a quality-gated evidence brief, so Kairn can create or reuse a task session and point Codex at high-confidence start files before broad repo scanning. The deprecated `savings` name remains a parser alias during migration. Use `--hook-output tiny-directive` only for delivery experiments, `--mode observe --post-tool-hook-output failure-only` to add failure-only post-tool context, `--mode debug` for broad diagnostics, `--mode mcp-first` to install Kairn as a Codex MCP server plus MCP-first guidance with no prompt prime, or `--mode hybrid` to install MCP plus a tiny prompt hook that tells Codex which Kairn session/files to start with before calling MCP. Generated hook and MCP configs use a resolved Kairn command when possible; set `KAIRN_CMD` only when you want to override that command for local development builds.

For long conversations, Kairn needs a stable conversation key. Interactive Codex/Claude hooks can provide this through the host session id in hook payloads. For repeated `codex exec` or wrapper-driven work where the host id may change per process, bind hooks to an explicit Kairn session:

```bash
kairn start "debug redirect handling across follow-up turns" --root /path/to/repo --json
kairn setup codex --root /path/to/repo --session task_123
```

The Codex wrapper can do this in one step for a session-bound launch:

```bash
kairn codex "debug redirect handling across follow-up turns" \
  --root /path/to/repo \
  --model gpt-5.4-mini \
  --bind-hooks
```

Use `--session task_123 --bind-hooks` to continue an existing Kairn conversation. Session-bound hooks keep follow-up prompt hooks attached to the same ledger, so Kairn can avoid repeated context and preserve source/invariant state across diagnose, fix, verify, and cleanup turns.
The wrapper installs the session-bound hook config for the Codex launch and restores the previous `.codex/` files afterward. Use `kairn setup codex --session task_123` directly only when you intentionally want the repo hooks to remain pinned to that Kairn session.

Codex project hooks require a trusted repo `.codex/` config and the hooks feature flag:

```toml
[features]
hooks = true
```

The Codex example uses the source-first setup: proactive `UserPromptSubmit` only. Stop and post-tool hooks are supported in observe/debug modes, but Kairn only emits host JSON when it has useful additional evidence. For lower latency, run `kairn daemon --root /path/to/repo` in another terminal; hooks use the warm runtime when available and fall back to direct local CLI execution otherwise. The Claude example observes `PostToolUse`, `PostToolUseFailure`, and `FileChanged` for common project config files; use `kairn watch` for repo-wide file observation.

For MCP proof runs, first verify Codex can see the server:

```bash
codex mcp list --json
```

In non-interactive `codex exec`, project MCP calls can be cancelled before Kairn receives them under `--sandbox workspace-write`, even when the server is visible. For disposable benchmark workspaces, use approval-never plus full sandbox access for MCP modes and require `actualMcpToolCalls > 0` before treating a run as MCP evidence:

```bash
codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks "Call kairn_prepare_task for this task before reading files."
```

Use the same Codex sandbox/approval mode across all modes in an MCP comparison matrix so token comparisons are fair. Do not use `danger-full-access` as a normal user default outside disposable benchmark clones.

## Metrics

Metrics are local-only and approximate. Kairn records one additive metrics row for each context, diff, test-discovery, file/symbol read, and compression response. The baseline is an estimate of what the agent likely would have needed without Kairn, such as full source for suggested files or raw command output. The output count is Kairn's returned token estimate.

```bash
kairn metrics --session task_123 --root /path/to/repo
kairn metrics --session task_123 --root /path/to/repo --json
```

`estimated tokens saved` is a local diagnostic for Kairn's own suppression and
compression behavior. It is not observed provider usage and must not be used as
the headline proof of token reduction. Comparative claims come from the
instrumented experiment or ecological Codex track, keep cached input, uncached
input, output, tool-result, and emitted-evidence tokens separate, and count only
when both attempts pass the required-source and verification gates.

Kairn also keeps a metadata-only session ledger for long conversations. The ledger tracks which files Kairn recommended or showed, which files the agent later mentioned or touched, commands/tests/failures, phase changes, and repeated context that Kairn avoided. It stores file refs, hashes, summaries, and token estimates only.

On top of the append-only ledger, Kairn derives a session working set: active files, ignored recommendations, stale shown files, the current invariant, latest failure, latest passing verification, open risks, and the next smallest useful read. Hooks and MCP tools use this working set to avoid repeating context and to re-emit only when the file changed, a failure references it, or the task phase shifted.

```bash
kairn ledger --session task_123 --root /path/to/repo
kairn ledger --session task_123 --root /path/to/repo --json
```

## Private Beta Diagnostics

Kairn is local-first by default. Detailed metrics, ledger facts, hook events, and benchmark evidence stay under `.kairn/`. Telemetry upload is opt-in and sends only sanitized aggregate counts: no source code, prompts, command output, diffs, filenames, repo URLs, usernames, branch names, or machine paths.

Beta users have two supported integration paths:

- `kairn codex`: session-bound Codex hooks for the CLI/interactive conversation path.
- `kairn setup mcp`: a local MCP server config for clients where hooks may be unavailable or not trusted.

For most users, start with the guided setup:

```bash
kairn setup wizard --root /path/to/repo
```

Recommended choice:

| User setup | Command | Notes |
| --- | --- | --- |
| Codex CLI / terminal user | `kairn codex` | Best-tested automatic beta path; one durable session ledger plus adaptive hooks. |
| Claude Code user | `kairn setup mcp --client claude-code` | Project `.mcp.json`; verify with `claude mcp list` and `/mcp`. |
| Copilot CLI user | `kairn setup mcp --client copilot-cli --json` | Copy config to `~/.copilot/mcp-config.json`, or use `--install-user` intentionally. |
| Gemini CLI user | `kairn setup mcp --client gemini-cli` | Project `.gemini/settings.json`; verify with `/mcp`. |
| VS Code / editor / app user | `kairn setup mcp --client vscode` | Pure MCP path. No hooks required; the agent calls Kairn tools when useful. |
| Generic MCP client | `kairn setup mcp --client generic --json` | Use for Antigravity, Avante/MCPHub, or clients with custom config UIs. |
| Codex user who explicitly wants both | `kairn setup codex --mode hybrid` | Advanced/experimental: tiny hook guidance plus MCP. Use only if hooks are acceptable. |

For MCP users, start with pure MCP. Hybrid is not the default MCP setup because hybrid requires hooks; a VS Code-only MCP install cannot provide hook behavior.

```bash
kairn doctor --root /path/to/repo
kairn doctor --root /path/to/repo --target claude-code
kairn doctor --root /path/to/repo --fix
kairn setup mcp --root /path/to/repo --client vscode
kairn setup mcp --root /path/to/repo --client claude-code
kairn setup mcp --root /path/to/repo --client gemini-cli
kairn beta report --root /path/to/repo
kairn telemetry status --root /path/to/repo
kairn telemetry enable --root /path/to/repo --destination supabase
kairn telemetry flush --root /path/to/repo --dry-run --json
kairn diagnostics export --root /path/to/repo --out kairn-diagnostics.json
```

Use `kairn doctor` before sharing beta results. It checks Node/Kairn setup, target-specific client config, daemon hints, index state, Windows friction, and telemetry status. `kairn beta report` summarizes whether Kairn helped, stayed silent, over-assisted, or missed opportunities in local sessions.

Kairn's local footprint in a user repo is intentionally reversible:

- `.kairn/`: local SQLite index, sessions, metrics, ledger, telemetry queue/config, and generated cache state.
- `.codex/config.toml` and `.codex/hooks.json`: Codex hook/MCP setup when the user chooses Codex integration.
- `.mcp.json`: Claude Code project MCP setup.
- `.claude/settings.local.json`: optional advanced Claude Code hooks.
- `.gemini/settings.json`: Gemini CLI project MCP setup.
- `.vscode/mcp.json`: workspace MCP server config when the user chooses editor MCP.
- `AGENTS.md`: a marked Kairn MCP guidance block between `<!-- kairn:mcp-first:start -->` and `<!-- kairn:mcp-first:end -->`.

No repo source files are modified by setup, and telemetry upload is opt-in. Use `kairn setup remove --delete-state` to remove all Kairn-owned repo-local state.

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

Endurance benchmarks simulate the longer-session use case with ordered turns in one disposable workspace and one Kairn session. They are meant to answer whether Kairn avoids repeated context, preserves quality gates, and saves cumulative observed Codex tokens over follow-up work.

```bash
kairn bench endurance \
  --root /Users/kevindotel/Documents/Projects/kairn \
  --suite examples/bench/endurance-axios.json \
  --baseline-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --kairn-codex-session-setup-command "kairn setup codex --root {root} --mode source-first --session {session} >/dev/null" \
  --kairn-codex-session-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --json
```

`kairn_codex_session` is the scriptable equivalent of the product UX `kairn codex`: one Kairn session ledger is created up front, the benchmark simulates the prompt hook against that ledger before each turn, and Codex is run with hooks disabled to avoid double-counting external hook behavior.

The included endurance examples cover Axios, Flask, and Commons IO. They use source-invariant checks and required touched files, so lower tokens only count when the final quality gate passes.

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
  --baseline-command "codex exec --model gpt-5.4-mini --sandbox workspace-write --disable hooks {prompt}" \
  --prompt-only-command "kairn setup codex --root {root} --mode source-first >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable hooks {prompt}" \
  --prompt-plus-hooks-command "kairn setup codex --root {root} --mode observe >/dev/null && codex exec --model gpt-5.4-mini --sandbox workspace-write --enable hooks {prompt}" \
  --repeat 3 \
  --shuffle-order \
  --json
```

The included `examples/bench/seeded-large-js-ts-template.json` shows the intended shape for pinned public JS/TS repos. `examples/bench/seeded-cross-language.json` adds concrete TypeScript, Python, Java, and C++ seeded debugging cases against pinned public repos. Java validation requires Maven, and C++ validation requires a local `c++` compiler.

```bash
kairn bench prove \
  --root /Users/kevindotel/Documents/Projects/kairn \
  --suite examples/bench/seeded-cross-language.json \
  --baseline-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --hook-full-prime-command "kairn setup codex --root {root} --mode source-first --hook-output full-prime >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
  --real-mcp-first-command "kairn setup codex --root {root} --mode mcp-first >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --hybrid-mcp-brief-command "kairn setup codex --root {root} --mode hybrid >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
  --manual-prime-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
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

For the best-tested automatic token-efficiency path without manual copy/paste, use the Codex wrapper:

```bash
kairn codex "debug the query key hashing regression" --root "$TARGET_REPO" --model gpt-5.4-mini
```

For long-session wrapper runs, add `--bind-hooks` so follow-up hook calls share the same Kairn ledger:

```bash
kairn codex "debug the query key hashing regression" --root "$TARGET_REPO" --model gpt-5.4-mini --bind-hooks
```

Normal Codex can receive automatic context through the prompt-submit hook after `kairn setup codex`. Hook delivery is useful for everyday low-friction usage, but benchmark it separately from manual/wrapper prime because Codex may weight hook `additionalContext` differently from prompt-prepended context.

To prove whether proactive context helps, compare live-agent modes. Repeat runs are preferred because live Codex usage has high variance:

```bash
kairn bench prove \
  --root "$TARGET_REPO" \
  --suite examples/bench/job-tracker-agent-light.json \
  --baseline-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --hook-full-prime-command "kairn setup codex --root {root} --mode source-first --hook-output full-prime >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
  --hook-tiny-directive-command "kairn setup codex --root {root} --mode source-first --hook-output tiny-directive >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
  --hook-tiny-with-failures-command "kairn setup codex --root {root} --mode observe --hook-output tiny-directive --post-tool-hook-output failure-only >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
  --manual-prime-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --mcp-first-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --real-mcp-first-command "kairn setup codex --root {root} --mode mcp-first >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --hybrid-mcp-brief-command "kairn setup codex --root {root} --mode hybrid >/dev/null && codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
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

Kairn uses WASM Tree-sitter grammars for AST parsing, so parser install no longer depends on native Node ABI builds. The remaining expected native dependency is SQLite storage through `better-sqlite3`; use Node 22 or 24 LTS if another Node release exposes a platform-specific SQLite install issue.
