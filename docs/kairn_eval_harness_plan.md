# Kairn Proof Metrics + Eval Harness Plan

## Summary

Add a local evidence layer that proves Kairn’s usefulness with real Codex sessions, instead of relying only on estimated token savings. The feature will ingest Codex token-usage footers/transcript metadata, record baseline-vs-Kairn eval runs, reduce noisy hook output, and generate reports that separate **estimated savings** from **observed Codex usage**.

## Key Changes

### 1) Add additive SQLite storage for eval evidence

Add new tables (append-only, local-only):

- `eval_runs`
  - `id`, `session_id`, `root_path`, `task`, `label`, `mode`, `status`, timestamps, `metadata_json`
- `eval_observations`
  - `id`, `run_id`, `session_id`, `kind`, `summary`, `metrics_json`, `files_json`, `content_hash`, `created_at`

### 2) Add types

- `EvalRunRecord`
- `EvalObservationRecord`
- `CodexUsageRecord`
- `EvalComparison`

### 3) Add Codex usage ingestion

- Parse Codex terminal footer text like:
  - `Token usage: total=33,729 input=33,253 (+ 24,704 cached) output=476.`
- Best-effort parse transcript metadata when `transcript_path` is available, but **do not store raw transcripts**.
- Store:
  - parsed usage totals, cached-input tokens, output tokens
  - model/session metadata
  - transcript path/hash (no raw transcript content)
  - source run/session identifiers

### 4) Add eval CLI commands

- `kairn eval start --root <path> --task "<task>" --mode baseline|kairn --label <label> [--session <id>] [--json]`
- `kairn eval ingest-codex --root <path> --session <id> [--run <id>] [--transcript <path>] [--usage <text>] [--json]`
- `kairn eval note --run <id> --outcome pass|fail|partial --summary <text> [--files <csv>] [--json]`
- `kairn eval report --root <path> [--session <id>] [--run <id>] [--json]`
- `kairn eval compare --baseline <runId> --kairn <runId> [--json]`

### 5) Extend metrics reporting

- Keep current **estimated savings**.
- Add **observed Codex usage** when ingested.
- Add A/B comparison fields:
  - baseline tokens, Kairn tokens, delta tokens, delta percent
  - outcome notes
  - hook counts, failures
  - files touched
  - commands observed
- Update `kairn metrics` to show **actual Codex usage separately from estimates**.

### 6) Improve hook signal quality

- Record trivial successful outputs silently instead of emitting hook context.
- Treat `UserPromptSubmit` as a prompt/context event, not command output compression.
- Emit hook context only for:
  - failures
  - linked source files
  - meaningful diff/file-change events
  - high-confidence prompt context
- Track recommendation metrics:
  - emitted, suppressed
  - linked files
  - suggested files later touched or involved in failures

### 7) Add docs

- README workflow for manual A/B testing with Codex CLI.
- Example:
  - baseline run without hook output
  - Kairn run with hooks enabled
  - usage ingestion
  - comparison report
- State clearly: **V1 is directional proof, not billing-grade token accounting.**

## Test Plan

### Unit tests

- Codex usage footer parser handles:
  - cached-input
  - no-cached-input
  - commas
  - whitespace variants
  - malformed text
- Eval store inserts/lists runs and observations.
- Eval comparison computes token deltas and handles missing usage cleanly.
- Hook logic suppresses trivial successful output and emits on failures/linked files.

### CLI tests

- `eval start`, `eval ingest-codex`, `eval note`, `eval report`, `eval compare`
- `metrics --json` includes observed usage when present
- Existing `init`, `start`, `context`, `diff`, `compress`, `watch`, `hook`, and MCP tests still pass

### Verification

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

## Assumptions

- V1 does **not** automate Codex runs; manual A/B runs avoid spending quota unpredictably.
- Raw Codex transcripts and raw command output are **never** stored.
- Baseline proof requires at least one ingested baseline run and one ingested Kairn-assisted run.
- Conduit integration is **not** required for this feature.

