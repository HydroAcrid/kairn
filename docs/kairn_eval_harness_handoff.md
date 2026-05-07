# Kairn Eval Harness Handoff (Improvements + Continuation Pack)

This document is meant to let another engineer or AI model continue the “Proof Metrics + Eval Harness” work without re-deriving project context.

## What Kairn is (in repo terms)

Kairn is a **local-first dynamic context runtime** that sits beside coding agents (Codex, Claude Code, Cursor, etc.) and answers repo-context questions during a task session.

Primary surfaces:

- **CLI**: `src/cli.ts`
- **Runtime**: `src/runtime/KairnRuntime.ts`
- **MCP server**: `src/server/mcp.ts`
- **Local state**: `.kairn/` in the target repo (SQLite + artifacts)
- **Watcher/hooks ingestion**: `src/watch/*`

Core constraint in repo docs/code: **do not store raw source files or raw command output** in Kairn state; store hashes + summaries + file references.

## Current system gaps this feature should address

### 1) Metrics are directional only (need observed evidence)

Current `kairn metrics` reports estimated token savings derived from heuristics:
- baseline tokens ≈ “top N files as full-source baseline”
- output tokens ≈ “Kairn response token estimate”

Gap:
- No **observed** token usage from real agent sessions (Codex, etc.), so it’s hard to prove impact.

Improvement:
- Add an evidence layer that records observed Codex token usage and ties it to eval runs (baseline vs Kairn-assisted).

### 2) No first-class A/B eval workflow (need eval runs + compare)

Gap:
- Sessions exist (`sessions` table) but there is no explicit “eval run” entity to compare baseline vs Kairn.

Improvement:
- Add `eval_runs` + `eval_observations`, plus CLI to start/ingest/note/report/compare.

### 3) Hook output is noisy (needs suppression logic + observability)

Current:
- `normalizeHookPayload` (`src/watch/normalizeHook.ts`) produces `NormalizedHookEvent` with `command`, `output`, `exitCode`, etc.
- `KairnRuntime.handleHookEvent` always compresses output when `event.output` exists (even if success/trivial).
- CLI `hook` prints hook-specific output via `hostHookOutput`, gated by `supportsAdditionalContext`.

Gap:
- Successful trivial tool outputs can flood agent context and distort “Kairn helped” perception.

Improvement:
- Suppress emitting “additionalContext” for trivial successes.
- Treat `UserPromptSubmit` as “prompt/context event” not “command output compression.”
- Emit only when meaningful (failures, linked files, high-confidence context).
- Track suppression vs emission rates.

### 4) “Pass to another model” needs explicit invariants

Non-negotiables (consistent with README/design doc + current storage approach):
- Do **not** store raw Codex transcripts in `.kairn/` DB or filesystem.
- Do **not** store raw command output beyond what is already stored as summaries/hashes.
- Prefer additive schema changes (SQLite `create table if not exists`, additive columns) to avoid migrations that break existing state.
- Keep CLI output stable; support `--json` for machine consumption.

## Where to implement the eval harness

### CLI surface

File: `src/cli.ts`

Pattern:
- Flat command definitions (`init`, `start`, `serve`, `context`, `diff`, `compress`, `watch`, `hook`, `metrics`)
- Uses `commander`
- Uses `withRuntime(root, cb)` to construct/close `KairnRuntime`
- Most commands support `--json` and print via `printJson(...)` or `printContextResponse(...)`

Implementation plan:
- Add an `eval` command group under `program.command("eval")` with subcommands:
  - `start`
  - `ingest-codex`
  - `note`
  - `report`
  - `compare`
- Keep signatures aligned with the plan in `docs/kairn_eval_harness_plan.md`.

### Runtime surface

File: `src/runtime/KairnRuntime.ts`

Relevant existing entrypoints:
- `getMetrics(sessionId)` returns `MetricsSummary` built from `metrics_events` + `watch_events`.
- `handleHookEvent({ sessionId, event })` compresses output + records watch event.

Implementation plan:
- Add runtime methods to:
  - create eval run records
  - ingest parsed Codex usage into eval observations
  - attach outcome notes
  - build a report JSON (join eval run + observations + metrics summary + hook stats)
  - compute comparison (`EvalComparison`)
- Keep these methods local-only and rooted in `.kairn` SQLite.

### SQLite store surface

File: `src/store/sqliteStore.ts`

Pattern:
- The store defines “Row” types near the top, plus `map*Row` helpers.
- `migrate()` uses `db.exec(...)` with `create table if not exists ...` and indices.
- Most “record*” methods are additive inserts; read methods list rows ordered by time.

Implementation plan:
- Add new table definitions in `migrate()`:
  - `eval_runs`
  - `eval_observations`
  - (Optional) `codex_usage` as a separate table, OR encode it into `eval_observations.metrics_json`
- Add store methods:
  - `createEvalRun(...)`
  - `getEvalRun(id)`
  - `listEvalRuns(rootPath, sessionId?)`
  - `recordEvalObservation(...)`
  - `listEvalObservations(runId)`

### Types

File: `src/types.ts`

Pattern:
- Central place for shared record types.
- Watch/hook and metrics types already exist (`MetricsSummary`, `WatchEventRecord`, etc.).

Implementation plan:
- Add new exported types:
  - `EvalRunRecord`, `EvalObservationRecord`, `CodexUsageRecord`, `EvalComparison`
- Keep JSON fields typed as structured objects, but store in SQLite as `*_json` strings (like existing `metadata_json` usage).

## Codex usage ingestion: what to parse and store

### Input shapes (expected)

1) Terminal footer string (highest priority; simplest)

Example:
`Token usage: total=33,729 input=33,253 (+ 24,704 cached) output=476.`

2) Transcript metadata (best-effort; optional)

Constraint:
- If `--transcript <path>` is supplied, hash the file (or hash the path + mtime/size) and store only:
  - `transcriptPath`
  - `transcriptHash`
  - extracted token usage + model name if available
  - no raw transcript content

### Proposed `CodexUsageRecord` fields (minimum viable)

- `source`: `"footer"` | `"transcript"`
- `totalTokens`: number
- `inputTokens`: number
- `cachedInputTokens?`: number
- `outputTokens`: number
- `model?`: string
- `hostSessionId?`: string
- `transcriptPath?`: string
- `transcriptHash?`: string
- `ingestedAt`: ISO timestamp

Store location:
- Either as `metrics_json` in an `eval_observations` row of kind `codex_usage`, OR as a dedicated table keyed by `(run_id, session_id)`.

## Hook signal-quality improvements (concrete insertion points)

### Suppress trivial successes

File: `src/runtime/KairnRuntime.ts`, method `handleHookEvent(...)`

Current behavior:
- If `event.output` exists, it compresses and includes it in the recorded watch event summary even for success.

Insertion point:
- Before calling `compressOutput`, compute `shouldEmitContext` based on:
  - `eventName` (prompt events vs tool events)
  - `exitCode` (failures always emit)
  - `linkedFiles.length` (linked files likely emit)
  - output length / known “boring” patterns (e.g. short “OK”, empty, standard success)
  - toolName (e.g. `apply_patch` success might be suppressible unless files linked)

### Treat `UserPromptSubmit` as context (not command output)

File: `src/watch/normalizeHook.ts`

Current:
- `output` may be set from `payload.prompt` and then treated like output in the runtime.

Improvement:
- For eventName `UserPromptSubmit`, set `kind` to something that the runtime handles as “prompt/context update” without compressing as command output.
  - Option A: encode in `NormalizedHookEvent.kind` (e.g. keep as `"hook"` but include metadata flag like `metadata.promptEvent = true`)
  - Option B: set `command` undefined and put prompt text into a separate field (would require type changes)

### Track “emitted vs suppressed”

Add lightweight counters into either:
- `metrics_events` metadata, OR
- `eval_observations` kinds like `hook_signal_stats`

## CLI and test guidance for the next model

### How the repo runs

- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Build: `pnpm build`
- Tests: `pnpm test`

### How CLI tests are structured

File: `tests/cli.test.ts`

Pattern:
- Runs CLI via `execFileSync(["tsx","src/cli.ts", ...])`
- Creates fixture repo via `tests/helpers.ts`
- Uses `--json` outputs for parsing assertions

Add new CLI tests:
- `kairn eval start ... --json`
- `kairn eval ingest-codex ... --json`
- `kairn eval report ... --json`
- `kairn eval compare ... --json`
- Ensure `kairn metrics --json` includes observed usage when present

### JSON output contract (recommendation)

For each eval command:
- Always support `--json` and print a single JSON object.
- Make sure reports/compare include both:
  - estimated metrics (existing `MetricsSummary`)
  - observed usage (parsed Codex usage)
  - derived deltas

## Suggested “Definition of Done” for V1

- A baseline run and a Kairn run can be created and compared locally.
- Codex usage footer text can be ingested and appears in:
  - `kairn eval report`
  - `kairn eval compare`
  - and (optionally) `kairn metrics` as “observed usage” separate from estimates.
- Hook suppression reduces emitted context on trivial successes while preserving failure context.
- All tests pass: `pnpm test`, `pnpm typecheck`, `pnpm build`.

## Reference plan

See: `docs/kairn_eval_harness_plan.md`

