# Kairn Architecture Overview

Kairn is a local repository evidence layer for coding agents. It maps the current checkout, ranks the files most likely to be required, and delivers the smallest useful evidence through hooks or MCP. The complete useful path runs locally by default: indexing, ranking, session evidence, and delivery do not require a Kairn account, API key, hosted backend, or trajectory upload.

Token efficiency is a co-primary outcome, but only when the agent still reaches the required production source and passes verification. This document maps the implementation behind that product contract.

## Product Shape

Kairn has one core product:

> A local repository evidence and token-efficiency layer that helps supported coding agents reach the right production source sooner.

It exposes that runtime through multiple surfaces:

- CLI commands for direct use and scripting.
- MCP tools for agent-native context requests.
- Codex/Claude hooks for automatic prompt and failure context.
- Session and optional watcher/daemon paths for current local evidence and lower latency.
- Eval/benchmark tools for proving whether Kairn actually helps.

These are surfaces over the same runtime. They should not become separate products.

## Layer Map

```text
Agent / Human
  |
  |-- CLI: enable, model, init, start, prime, context, hook, watch, eval, bench
  |-- MCP: prepare_task, find_context, read_file, read_symbol, next_context, failure_context
  |-- Hooks: Codex/Claude UserPromptSubmit, PostToolUse, failures, file changes
  |
KairnRuntime facade
  |
  |-- IndexService      -> scan, parse, graph, semantic documents/embeddings, lexical index, tier/state stats
  |-- MetricsService    -> token estimates, hook/MCP telemetry, index tier stats
  |-- EvalService       -> observed Codex usage, transcript metadata, feedback
  |-- Runtime methods   -> context, prime, hooks, failures, benchmarks, sessions
  |
Repository Evidence Layer
  |
  |-- TaskSignalExtractor: paths, symbols, failures, intent, git, session state
  |-- CandidateGenerators: exact path/symbol, BM25, failure, diff, session, local semantic
  |-- bounded union and query-local graph/chunk enrichment
  |-- EvidenceFeatureBuilder and local calibrated file-relevance ranker
  |-- deterministic governor: content, path hint, shrink, request evidence, or silence
  |
SQLite Store under .kairn/
  |
  |-- sessions, shown context, files, symbols, graph edges
  |-- semantic documents/int8 embeddings, lexical documents/terms
  |-- legacy semantic chunks/vectors retained only for rollback migration
  |-- watch events, metrics events, eval runs, benchmark runs
  |-- session ledger events and local telemetry queue/config
```

## Public Surfaces

### CLI

Main entrypoint: `src/cli.ts`

Command modules:

- `src/cli/commands/core.ts`: `init`, `start`, `prime`, `serve`, `daemon`, `metrics`, `index`, `codex`.
- `src/cli/commands/context.ts`: `context`, `diff`, `compress`, `failure`.
- `src/cli/commands/watch.ts`: `watch`, `hook`.
- `src/cli/commands/setup.ts`: canonical `enable`/`disable` plus advanced `setup wizard`, `setup codex`, `setup mcp`, and repair/removal commands.
- `src/cli/commands/model.ts`: explicit status, checksummed installation, verification, and removal for the shared local ONNX model cache.
- `src/cli/commands/eval.ts`: eval runs, Codex usage ingestion, feedback.
- `src/cli/commands/bench.ts`: replay, live-agent proofs, repo-matrix preflight, endurance runs.
- `src/cli/commands/beta.ts`: doctor checks, privacy-first telemetry, diagnostics export, beta reports.

The CLI should stay thin. Command modules should parse options, call `KairnRuntime` or focused benchmark/setup helpers, then format output.

Canonical onboarding starts with one machine install and `kairn enable` in each repository. Enable detects supported local agents, previews Kairn-owned changes, installs source-first Codex hooks or client-specific MCP configuration after one confirmation, builds local inventory, and runs doctor checks. The setup wizard remains an advanced composition layer over the same primitives. `kairn disable` removes only configuration that Kairn can identify as its own; `--delete-state` also removes local `.kairn` state.

### MCP

Main entrypoint: `src/server/mcp.ts`

Current tools:

- `kairn_prepare_task`
- `kairn_start_task`
- `kairn_find_context`
- `kairn_read_file`
- `kairn_read_symbol`
- `kairn_get_related_files`
- `kairn_find_tests`
- `kairn_review_diff`
- `kairn_compress_output`
- `kairn_get_next_context`
- `kairn_get_failure_context`
- `kairn_get_metrics`
- `kairn_get_session_state`

MCP is the read-gateway surface. Its job is not to dump large prime briefs. It should help agents take the next smallest useful read. Kairn writes client-specific config rather than assuming one MCP layout: VS Code uses `.vscode/mcp.json` with `servers`, Claude Code uses project `.mcp.json` with `mcpServers`, Gemini CLI uses `.gemini/settings.json`, Copilot CLI uses `~/.copilot/mcp-config.json` only with explicit user-level consent, and generic clients receive JSON to paste into their own settings.

MCP is a product entrypoint, not only a benchmark mode. It supports editor/app integrations where prompt hooks are unavailable, blocked by review, or not part of the host UX. `kairn setup mcp --client vscode` writes a workspace `.vscode/mcp.json` server block while preserving unrelated MCP servers. `kairn setup codex --mode mcp-first` writes the Codex TOML equivalent. Both point at the same local `kairn serve --mcp --root <repo>` server.

Integration guidance:

- `kairn codex`: default CLI/terminal path with session-bound hooks.
- `kairn setup mcp --client vscode`: default MCP/editor path with no hooks.
- `kairn setup codex --mode hybrid`: advanced Codex-only path for users who explicitly want both a tiny hook and MCP.

Pure MCP should remain the default MCP recommendation until hybrid wins repeatedly across fresh suites. Hybrid is not just "MCP with better defaults"; it depends on hooks, so it is a separate trust/UX choice.

MCP stop conditions are part of the product contract:

- after `kairn_prepare_task` returns a high-confidence production source file, repeated compact prepare calls should usually return a stop-only payload with no files;
- `kairn_get_next_context` should not expand after source evidence is sufficient unless a check fails, a file changes, or the task target changes;
- `kairn_get_failure_context` may re-emit focused failure context, but should prefer the already-returned production source over broad tests or neighboring files.

MCP follow-up calls have a stop condition: after Kairn has already returned sufficient source evidence and no new failure or diff exists, `kairn_get_next_context` should return a small "continue from the shown source" response instead of expanding into more files. Metrics record returned source/noise/test counts and token estimates per MCP call.

### Hooks And Watcher

Hook command path:

- `src/cli/commands/watch.ts`
- `src/watch/normalizeHook.ts`
- `src/watch/hookPredicates.ts`
- `src/watch/recommendation.ts`
- `KairnRuntime.handleHookEvent`

Watcher path:

- `src/watch/watchRepo.ts`
- `KairnRuntime.createWatchSnapshot`
- `KairnRuntime.recordFileChanges`

Hook modes:

- `savings`: prompt-submit full-prime only when confidence is high.
- `observe`: prompt context plus quiet/failure-oriented post-tool observation.
- `debug`: broad diagnostics.
- `mcp-first`: MCP config and instructions, no prompt prime by default.
- `hybrid`: tiny hook directive plus MCP availability, with AGENTS.md telling the agent to work normally unless a hook supplies context or a concrete failure appears.

Hooks must stay quiet when Kairn lacks high-confidence leverage. When Kairn does have a strong but potentially over-assisting signal, hooks should prefer a tiny guardrail over a full brief.

Conversation binding:

- If a host hook payload includes a stable conversation/session id, Kairn maps that host id to one durable Kairn session through `host_session_links`.
- If the host cannot provide a stable id, such as repeated `codex exec` launches, Kairn needs an explicit session binding.
- `kairn setup codex --session <id>` writes hook commands that always use that Kairn session.
- `kairn codex "<task>" --bind-hooks` creates or reuses a Kairn session, temporarily installs session-bound hooks, launches Codex with `hooks` enabled, and restores the previous project `.codex/` files afterward.
- `kairn codex` without a task launches interactive Codex with session-bound hooks by default. This is the preferred "one command per conversation" shape.
- This keeps hook mode attached to the same ledger across diagnose, fix, verify, and cleanup turns instead of creating isolated per-process sessions.

### Daemon

Daemon path:

- `src/daemon/server.ts`

Purpose:

- Keep a warm runtime/index available.
- Let hooks avoid expensive prompt-turn indexing.
- Reduce hook latency and timeout risk.

The daemon is an optimization layer, not a separate source of truth.

## Runtime Facade

Main file: `src/runtime/KairnRuntime.ts`

`KairnRuntime` is still the compatibility boundary for CLI, MCP, hooks, eval, and tests. It currently does too much, but that is intentional during product exploration. The intended direction is to keep it as a facade and gradually delegate into services.

Current extracted services:

- `src/runtime/services/IndexService.ts`
- `src/runtime/services/MetricsService.ts`
- `src/runtime/services/EvalService.ts`

Still mostly inside `KairnRuntime`:

- context search orchestration,
- file/symbol reads,
- related/test/diff context,
- failure-first routing,
- hook session resolution,
- watch recommendations,
- benchmark orchestration.

Refactor rule: preserve `KairnRuntime` public methods while moving implementation behind services.

## Indexing Pipeline

Indexing starts with `runtime.init()` and flows through:

1. `src/scanner/scanRepo.ts`
   - full file inventory,
   - ignore handling,
   - language/kind classification,
   - adaptive scan budgets.

2. `src/parser/parseFile.ts`
   - WASM Tree-sitter parsing for supported languages,
   - symbol extraction,
   - import/include extraction.

3. `src/languages/adapters.ts`
   - language adapter registry,
   - active JS/TS, Python, Go, Java, and C/C++ support,
   - stub adapters for Rust and Ruby where universal retrieval works but deep graph support is future work.

4. `src/graph/buildGraph.ts`
   - import edges,
   - test/source associations,
   - nearby/route relationships,
   - bounded graph edge generation.

5. `src/ts/tsGraph.ts`
   - TypeScript language-service enrichment for JS/TS definitions/references where feasible.

6. `src/semantic/documents.ts`
   - one structural file document for every eligible indexed source,
   - bounded symbol documents allocated across files and across large-file symbol ranges,
   - objective path, language, role, module, import, signature, documentation, and source-body fields.

7. `src/semantic/modelManager.ts` and `src/semantic/modelRuntime.ts`
   - immutable checksummed model installation,
   - CPU-only ONNX batching, pooling, normalization, and deterministic verification,
   - explicit unavailable, corrupt, incompatible, stale-index, and ready states,
   - no runtime download and no executable remote model code.

8. `src/lexical/bm25.ts`
   - exact lexical document/term index.

9. `src/indexer/indexRepo.ts`
   - combines scan, parse, graph, structural documents, compact int8 embeddings, BM25, and tier state into persisted index records,
   - reuses embeddings only when document, model/tokenizer artifact, and document-schema identities remain current,
   - keeps cheap inventory available while deeper embedding work is resumable.

10. `src/indexer/symbolCompaction.ts`
   - large-repo symbol compaction.

`src/semantic/chunk.ts` and `src/semantic/vector.ts` remain only for the legacy/shadow rollback path through v0.3. Hashed vectors are never used as semantic evidence in `semantic` mode.

Indexing goal:

- Keep cheap recall across the whole repo.
- Load expensive graph/chunk/vector detail only for hot or query-relevant files.
- Avoid whole-repo deep context loading in user-facing paths.

## Retrieval Stack

Retrieval is hybrid and local-only.

Core modules:

- `src/retrieval/evidenceSignals.ts`
- `src/retrieval/semanticCandidates.ts`
- `src/retrieval/candidateFusion.ts`
- `src/retrieval/evidenceRanker.ts`
- `src/retrieval/evidenceModel.ts`
- `src/retrieval/relatedFiles.ts`
- `src/retrieval/readSource.ts`
- `src/retrieval/responseRouter.ts`
- `src/context/formatContext.ts`

Candidate generation is independent by evidence class:

- exact paths and precise failure locations are hard-pinned;
- exact symbols, BM25, git diff, and active-session evidence produce independent rankings;
- the local ONNX model searches the complete available embedding index, then collapses symbol/file documents to files by maximum normalized cosine similarity;
- reciprocal-rank fusion combines non-hard rankings without path-name or task-word bonuses;
- at most 64 initial files are selected;
- only direct graph and source/test neighbors may expand the union, capped at 128.

The calibrated logistic model receives this bounded union and estimates file requirement probability from `evidence-features-v3`. In addition to real semantic similarity, v3 exposes objective parser-graph precision, independent-seed consensus, and bounded support so the model can distinguish relationship evidence without a hand-written relevance bonus. The deterministic governor—not the embedding model—decides whether to emit content, emit a path hint, request more evidence, suppress repeated unchanged context, or remain silent. Explicit paths, precise failures, generated/vendor policy, intent compatibility, index freshness, verification state, and context budgets stay deterministic.

Regular expressions are permitted for objective parsing such as compiler locations, stack traces, transport cleanup, and file-role classification. They may not create semantic relevance, path/task-word bonuses, or benchmark-specific scores. `scripts/check-semantic-architecture.mjs` enforces this serving boundary in CI.

`src/retrieval/hybridRetrieval.ts`, `src/retrieval/companions.ts`, and `src/retrieval/scoreResults.ts` are retained behind `legacy` and `shadow` rollout modes through v0.3. Invalid or unavailable model artifacts fail visibly to exact path, failure, symbol, BM25, git, session, and graph evidence; they never reactivate hashed pseudo-semantic scoring.

Important design point:

> Query-local retrieval is mandatory for large repos. Kairn should not load every graph edge, chunk, vector, or lexical term for a normal `prime` or `findContext` call.

Ruby/Rails is documented as a future adapter target in `docs/kairn_ruby_adapter_future.md`. Rails conventions need framework-aware routing before Kairn should make strong quality/savings claims there.

## Prime And Context Control

Prime modules:

- `src/prime/formatPrime.ts`
- `src/prime/quality.ts`
- `src/prime/contextValue.ts`

Budget policy:

- `src/budget/adaptiveBudget.ts`

`primeContext` generates proactive context for the agent. It is controlled by:

- profile: `ui`, `workflow`, `backend`, `test`, `failure_debug`, `generic`,
- adaptive budget,
- ranked files and snippets,
- `PrimeQuality`,
- `ContextValueDecision`.

Context actions:

- `emit`: send useful context.
- `shrink`: send a tiny one-file/directive brief.
- `shrink` with `multi_file_directive`: send a compact structured-debug brief with one active production source, one companion production source, one invariant, and no broad fanout.
- `suppress`: send nothing to the agent, but record internal metrics.

Current delivery classes:

- `source_rescue`: Kairn has a strong source target that the agent may otherwise miss.
- `multi_file_directive`: SWE/debug work needs a primary source, one companion source, an invariant, and a small check.
- `cheap_single_source`: one production source dominates and companion evidence is generic; automatic hooks emit only a minimal fix guardrail or suppress.
- `cheap_exact_source`: a dynamic-language exact source hit with a concrete invariant gets an ultra-minimal guardrail instead of full context or silence.
- `weak_signal_abstain`: retrieval is broad/noisy, so automatic surfaces stay silent.

Automatic prompt hooks apply a stricter delivery rule than manual `kairn prime`. If Kairn finds one very strong production file or a risky multi-surface target, the hook emits a tiny no-snippet guardrail: start file, invariant/check guidance when available, and a stop condition. Full prime output is reserved for prompts where extra context is likely to change agent behavior without causing broad scans.

The selective-governor rule is: cheap/easy tasks should see near-zero harm, medium source-rescue tasks should get the exact file fast, hard debug tasks should receive only the source evidence needed to preserve the invariant, and long sessions should avoid repeating unchanged context.

Post-diagnose fix turns have an even smaller Fix Guardrail. When the ledger already knows the active production source and the task is a fix/debug turn, Kairn emits only the source path, source invariant, and stop condition. It intentionally omits snippets, companions, related tests, and quality scoring text so the agent edits the known source instead of reopening broad discovery.

Structured-debug delivery handles issue-style prompts with requirements, selected tests, failure/debug language, or strong companion evidence. It is smaller than full prime but less brittle than one-file shrink. Route and named-source signals can reorder the two files so the likely active source appears before helper files.

This controller is one of the most important quality safeguards. Bad primes increase token use and can reduce agent quality.

## Session Memory

Session memory is structured, not transcript-like.

Core modules:

- `src/types/ledger.ts`
- `src/ledger/summary.ts`
- `src/ledger/workingSet.ts`
- `src/ledger/policy.ts`

The append-only ledger records metadata-only facts:

- context recommended or shown,
- files mentioned or touched by the agent,
- commands and tests,
- failures and verification outcomes,
- diffs and phase changes.

The derived working set is the compact long-session memory that hooks, MCP, `primeContext`, and endurance benchmarks consult:

- active files,
- recently touched files,
- ignored recommendations,
- stale shown files,
- current invariant,
- latest failure,
- latest passing verification,
- next smallest useful read,
- open risks.

Passing verification is now a first-class ledger signal. When a source invariant or diff-scope check passes, Kairn records a metadata-only `verification_passed` event anchored to the source file. Verification and cleanup turns can then use `verified_context_suppressed` for automatic surfaces, or `verified_context_shrunk` for explicit/manual requests, instead of repeating the earlier prime or expanding into neighboring files.

Post-diagnose source focus is the companion to that rule. Once a session has prior context and one active production source, later implementation/debugging/verification/cleanup turns can use `active_source_context_shrunk`: one source file, no companion fanout, and no snippet unless the file changed or a real failure references another file.

This is Kairn's answer to long-conversation compaction. Instead of summarizing the whole chat into prose, Kairn keeps repo-grounded state and uses hashes/file refs to decide whether to repeat, shrink, suppress, or re-emit context.

The ledger is per Kairn session. It behaves like conversation memory only when the integration keeps the same session id. Interactive hosts should do this through stable hook session ids; wrappers and repeated `codex exec` flows should use session-bound hooks.

The ledger is now also a stop-condition source for MCP. When Kairn has already returned the active production file and no unresolved failure exists, MCP compact responses should prefer "continue from the known source" over returning more files. This keeps MCP useful as a read gateway without becoming a repeated-context generator.

## Failure-First Path

Failure modules:

- `src/watch/failureParser.ts`
- `src/watch/classifyCommand.ts`
- `src/watch/recommendation.ts`
- `KairnRuntime.getFailureContext`

Used by:

- CLI `kairn failure`,
- MCP `kairn_get_failure_context`,
- hook failure events,
- watcher snapshots,
- benchmarks.

Failure-first context prioritizes:

- stack traces,
- `path:line:col` references,
- TypeScript diagnostics,
- Vitest/Jest/Python/Java/C++ style failure output,
- changed files,
- linked tests,
- likely production sources.

This is the path most likely to produce large savings on hard debugging tasks.

## Storage Layer

Main file: `src/store/sqliteStore.ts`

State location: `<target-repo>/.kairn/`

Major record groups:

- sessions and context shown,
- file inventory,
- symbols,
- graph edges,
- semantic documents and compact int8 model embeddings,
- legacy semantic chunks/vectors during the rollback migration window,
- lexical documents/terms/stats,
- watch events,
- metrics events,
- eval runs/observations,
- benchmark runs/results,
- host-session links.
- local telemetry queue/config.

The store is currently large but acts as a persistence facade. It should be split after runtime service boundaries are stable.

Storage rules:

- Do not store raw Codex transcripts.
- Do not store raw command output unless explicitly necessary.
- Prefer hashes, summaries, metadata, and file references.
- Keep SQLite state bounded; watch DB/WAL size and tier counts.

## Beta Diagnostics And Telemetry

Beta support modules:

- `src/doctor/doctor.ts`
- `src/telemetry/config.ts`
- `src/telemetry/sanitize.ts`
- `src/telemetry/payload.ts`
- `src/telemetry/queue.ts`
- `src/telemetry/report.ts`
- `src/telemetry/diagnostics.ts`

CLI surfaces:

- `kairn doctor --root <repo> [--json] [--fix-hooks]`
- `kairn telemetry status|enable|disable|flush`
- `kairn diagnostics export --root <repo> --out <path>`
- `kairn beta report --root <repo> [--session <id>] [--json]`

Telemetry is opt-in. Detailed evidence remains local under `.kairn/`; upload payloads are sanitized aggregates only. They may include version, mode, language mix, repo-size buckets, decision counts, assistance classification, token totals, hook/MCP counters, coarse file roles, and salted file ids. They must not include source code, prompts, command output, diffs, filenames, repo URLs, usernames, branch names, or machine paths.

When telemetry is enabled, uploads happen only at safe command boundaries. `kairn codex` queues and flushes one sanitized snapshot after the Codex process exits, and `kairn beta report` queues and flushes one snapshot after producing the local report. Prompt hooks and MCP tool calls do not perform network uploads during an agent turn; they record local metrics that are flushed later.

Hosted ingest lives under `supabase/`:

- `supabase/migrations/20260512000000_kairn_private_beta_telemetry.sql`
- `supabase/functions/kairn-telemetry-ingest/index.ts`

Clients never receive Supabase service-role credentials. The Edge Function validates payload shape, rejects unsafe fields, rate-limits by installation id, and stores only sanitized aggregate JSON.

## Metrics, Eval, And Bench

Metrics:

- `src/metrics/baseline.ts`
- `src/metrics/summary.ts`
- `src/runtime/services/MetricsService.ts`

Eval:

- `src/eval/codexUsage.ts`
- `src/eval/usageObservation.ts`
- `src/runtime/services/EvalService.ts`

Bench:

- `src/bench/suite.ts`
- `src/bench/score.ts`
- `src/bench/agent.ts`
- `src/bench/proofReport.ts`
- `src/bench/matrix.ts`
- `src/bench/endurance.ts`
- `src/bench/enduranceSuite.ts`
- `src/bench/sourceValidation.ts`
- `src/bench/sweBenchPro.ts`
- `src/bench/sweAtlasQna.ts`
- `src/bench/officialClassification.ts`
- `src/bench/mcpSmoke.ts`

Bench layers:

1. Replay benchmarks: deterministic retrieval scoring.
2. Repo-matrix preflight: broad repo/state/retrieval gates without live agents.
3. Live-agent proof: expensive Codex/agent runs in disposable workspaces.
4. Endurance benchmarks: multi-turn agent work in one disposable workspace/session.
5. SWE-Bench Pro pilot generation: imports public task rows into Kairn preflight/live-suite scaffolds.
6. SWE-Atlas/QnA pilot generation: imports official QnA rows into retrieval/grounding suites where reference answers are used only for offline expected-file scoring.
7. Official task classification: stratifies official rows by task class, evaluator, Kairn applicability, and live-risk before interpreting results.
8. MCP smoke checks: starts the real MCP stdio server, calls `kairn_prepare_task`, and verifies tool-call metrics before MCP live spend.
9. Eval harness: manual A/B run evidence and transcript metadata.

The session-bound `kairn codex` product path is tested through the `kairn_codex_session` endurance mode. Because `codex exec` is not a reliable proxy for interactive prompt hooks, this mode simulates `UserPromptSubmit` against one explicit Kairn session before each turn, then runs Codex with hooks disabled. That is the scriptable equivalent of the context policy used when a user launches `kairn codex` and types normally inside the interactive Codex UI.

Quality rule:

> Token savings only count when quality gates pass.

Quality gates include:

- verification passes,
- required production files are used when specified,
- excluded files are avoided,
- hook failures are zero,
- MCP modes have actual MCP calls,
- official SWE-Pro Docker evaluation passes for SWE-Pro claims,
- source invariants pass when declared,
- changed hunks stay inside allowed diff scopes when declared,
- active Kairn assistance happened for a Kairn-assisted savings claim,
- token reductions are not counted when task quality fails.

Endurance benchmark rule:

> A lower token count is not automatically a Kairn win.

Endurance reports distinguish:

- `active`: Kairn emitted/shrank context, served MCP context, or supplied failure context.
- `passive_suppressed`: Kairn ran but suppressed every turn.
- `none`: baseline/no Kairn assistance.

Only `active` runs can produce `validSavings`. Suppress-only reductions are tracked as passive evidence so the report does not overclaim.

Assist and abstention classification:

- `valid_assist`: Kairn was active, quality passed, and observed tokens dropped.
- `over_assist`: Kairn was active, quality passed, but observed tokens did not improve.
- `harmful_invalid_assist`: Kairn was active and quality failed.
- `correct_abstention`: Kairn suppressed while baseline passed cheaply.
- `missed_savings_opportunity`: Kairn suppressed while baseline passed but spent many tokens.
- `missed_quality_opportunity`: Kairn suppressed while baseline failed quality.
- `passive_quality_regression`: Kairn suppressed, baseline passed, but the Kairn-mode run failed quality.

This classification is what lets broad tests measure abstention accuracy instead of treating all lower-token runs as wins. Kairn should abstain when it has no leverage, but missed expensive searches are now visible as missed opportunities.

Behavior target scoring:

- `cheap_single_source`: obvious one-file fixes should suppress or emit only a minimal guardrail with near-zero harm.
- `source_rescue`: Kairn should actively help when Codex is likely to search broadly for a hidden source file.
- `multi_file_debug`: Kairn should return the primary source plus one focused companion and an invariant, not broad fanout.
- `failure_first`: failure output should route to linked source/check context before generic retrieval.
- `session_repeat`: automatic surfaces should avoid repeating unchanged context already shown in the session.
- `weak_signal`: low-confidence prompts should stay silent.

Reports aggregate these targets separately from raw token deltas. This is the main product metric for the selective context governor: Kairn is judged on whether it chose the right behavior class before token savings are interpreted.

Official benchmark classification:

- Official benchmark rows are not averaged blindly.
- SWE-Atlas/QnA and SWE-Pro rows carry `officialEvaluation` metadata: source, task class, evaluator, Kairn applicability, metric eligibility, live-risk, reasons, and recommended modes.
- `source_grounded_explanation`, `patch_verification`, `multi_file_debug`, `failure_first_debug`, `cheap_single_source`, and `source_rescue` can produce Kairn headline evidence when quality passes.
- `runtime_procedural` rows are tracked as stress tests because service startup, live logs, probes, and environment observation can dominate token use and quality.
- Benchmark reports aggregate official results by task class, evaluator, and applicability so scientific claims can be made by class rather than as one misleading overall average.

Source-invariant validation:

- Defined in benchmark suites as semantic file invariants.
- Checks required/forbidden text and regex alternatives.
- Allows equivalent repairs, such as introducing a local variable before calling the intended function.
- Replaces brittle exact-source-string checks for seeded bug-fix tasks.

Diff-scope validation:

- Uses `git diff --unified=0` plus parsed symbols to map changed lines to functions/classes.
- Fails when an agent edits unrelated hunks in the same file, even if the changed file itself is expected.
- Prevents cleanup checks from accepting broad same-file behavior drift.

SWE-Bench Pro pilot rule:

- Public rows are useful for repo-matrix preflight and source-retrieval stress tests.
- Live proof requires full untruncated task data and the official Docker evaluator path before token reductions count as valid SWE-Pro savings. The rows API can truncate large patches, so Kairn should not run leaderboard-style live claims from that source alone.
- SWE-Pro suite generation should prefer `before_repo_set_cmd` over direct `test_patch`, fetch referenced test commits, and commit selected tests so solution diffs contain only agent changes.
- Local required-file and invariant gates are prefilters only. If the official evaluator fails, active Kairn context is negative evidence even when local gates pass.

SWE-Atlas/QnA pilot rule:

- QnA tasks measure source routing and answer grounding, not patch correctness.
- Generated agent prompts include only the public question and repo metadata needed for checkout.
- Reference answers are never sent to the agent. Kairn uses them offline to extract expected source files for retrieval scoring and report diagnostics.
- Docker checkout prefixes in reference paths, such as `/app/<repo>/...`, are canonicalized back to repo-relative paths before scoring.
- Runtime/procedural QnA rows are separated from source-grounded answer rows before live spend.
- A QnA token reduction is useful evidence only when the answer uses the relevant source surface and no repo files are modified.

## Current Complexity Hotspots

These files/modules carry the most complexity:

- `src/runtime/KairnRuntime.ts`
  - still contains many orchestration responsibilities.
- `src/store/sqliteStore.ts`
  - persistence facade with many table groups.
- `src/server/mcp.ts`
  - many tools in one file.
- `src/bench/agent.ts` and `src/bench/score.ts`
  - live-agent proof and quality scoring complexity.
- `src/retrieval/hybridRetrieval.ts`
  - central scoring logic.

Planned pressure relief:

- keep CLI and MCP thin,
- continue extracting runtime services,
- split store only after service boundaries stabilize,
- keep retrieval scoring rules general and test them broadly,
- document benchmark findings before tuning.

## Stable Versus Experimental

Stable-ish foundations:

- file inventory,
- sessions,
- exact file/symbol reads,
- BM25/exact lexical retrieval,
- WASM Tree-sitter symbol extraction,
- query-local retrieval direction,
- metrics/eval storage principles.

Still experimental:

- observed token-savings claims,
- hook delivery effectiveness,
- MCP-first behavior with Codex,
- hybrid hook+MCP coordination,
- cross-language depth beyond parsing/symbols,
- tiered adaptive indexing policies,
- live-agent benchmark methodology.

## Design Guardrails

- One runtime, multiple surfaces.
- Local-first and deterministic by default.
- Prefer broad mechanisms over repo-specific tuning.
- Suppress low-confidence context.
- Count savings only after quality passes.
- Keep expensive state query-local.
- Treat benchmarks as evidence, not as targets to overfit.
- Refactor behind stable public facades.
