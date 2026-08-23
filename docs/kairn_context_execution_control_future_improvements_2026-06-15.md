# Kairn Context Execution Control Future Improvements

Date: 2026-06-15

## Summary

Kairn's long-term technical advantage should be framed as smarter context execution control, not just better retrieval.

The core future question is:

> Given these candidates, this task shape, this session history, and this failure state, what is the smallest context action that preserves quality?

That question is broader than semantic search. Retrieval can find files, chunks, symbols, tests, and prior evidence. Kairn should decide what should actually reach the agent now, what should be compressed, what should wait, and when evidence is needed before spending tokens.

## Product Direction

Kairn should keep moving toward an attention governor / context runtime:

- Retrieval finds candidate context.
- Ranking estimates which candidates are likely useful.
- The governor decides the delivery action.
- Session memory carries verified state forward.
- Failure feedback expands or narrows the aperture.
- Telemetry and local metrics improve future thresholds without exposing source.

The proprietary layer is the decision policy around execution context, especially during long coding sessions, unknown codebases, and repeated agent turns.

## Target Decision Model

The ideal policy should score each turn using:

- candidate quality;
- task shape;
- required source surface;
- session history;
- user/project preferences;
- previous agent actions;
- failure state;
- verification state;
- scope risk;
- token budget pressure;
- confidence that silence is safer than more context.

The output should remain one of Kairn's existing high-level actions:

- `emit`: send focused source context;
- `shrink`: send a compact directive, owner map, or guardrail;
- `suppress`: stay quiet because context is already established or low-value;
- `request_evidence`: ask for a runtime/test/failure/source-owner signal;
- `expand_after_failure`: widen context only after concrete failure evidence.

## Improvement Tracks

### 1. Learned Context Action Ranking

Train or tune a lightweight ranking/confidence layer over Kairn's existing features.

Inputs:

- task-shape signal;
- required surface;
- candidate roles;
- file graph relationships;
- previous turn outcomes;
- ledger state;
- MCP/hook source attribution;
- token estimates;
- scope violations;
- over-assist / missed-opportunity / harmful-assist labels.

Output:

- confidence for `emit`, `shrink`, `suppress`, or `request_evidence`;
- expected quality risk;
- expected token waste;
- expected missed-context risk.

This should start as offline scoring over existing benchmark and beta telemetry artifacts, not as a live model dependency.

### 2. Temporal Awareness

Deepen the session-ledger layer so Kairn understands what is current, stale, verified, rejected, or already overused.

Future signals:

- active files from the latest successful turn;
- stale files changed after context was shown;
- files touched during failed turns;
- files verified by tests or source invariants;
- files repeatedly suggested but ignored;
- user-selected files and manually opened files;
- recent failure surfaces.

Goal:

Kairn should become more confident about staying quiet or shrinking context as a session matures, while still reopening context when the task target changes.

### 3. Semantic Slicing

Move from heuristic snippets toward AST/function/class-level slices.

Useful when:

- the correct file is known but full-file context is too expensive;
- the task targets one function/class/export;
- the agent needs surrounding invariants but not the whole module;
- official patch prompts are narrow and exact-source.

Risks:

- bad slicing can remove the invariant needed for quality;
- language adapters vary in maturity;
- slicing before correct routing may make quality worse.

Rollout:

1. Start with read-only/offline diagnostics.
2. Compare full-file, heuristic snippet, and AST-slice prompts on known pass/pass rows.
3. Enable only for high-confidence exact-source tasks.
4. Keep failure-triggered aperture expansion available.

### 4. Failure Correction And Aperture Expansion

When an agent fails, Kairn should use the concrete failure output to decide whether to:

- keep the same source and retry;
- add the nearest test;
- add a companion file;
- add a runtime/stack trace owner;
- request one more signal;
- expand from single-file to paired or feature-cluster context.

The key is controlled expansion. Failure should not trigger broad fanout by default.

### 5. User And Project Adaptation

Kairn can become more useful when it learns local preferences without uploading private code.

Potential local-only signals:

- preferred agent mode;
- repos where MCP works better than hook mode;
- user tolerance for quiet decisions;
- common verification commands;
- common source/test layout;
- high-risk directories;
- generated/vendor paths;
- project-specific source ownership patterns.

This should remain local-first. Any aggregate telemetry should be opt-in and sanitized.

### 6. Unknown Codebase Bootstrap

Fresh repos are harder because Kairn has less session history.

Future bootstrap improvements:

- faster source ownership maps;
- import/test/route graph summaries;
- lightweight project archetype detection;
- high-confidence source/test counterpart detection;
- first-session caution mode that asks for evidence sooner;
- stronger transition from cold-start retrieval to warm session governance.

## What This Is Not

This is not a plan to replace Kairn with generic RAG, embeddings, or a vector database.

Those tools can improve candidate discovery, but Kairn's value is deciding the execution context policy:

- whether context should be sent at all;
- how much context is enough;
- whether prior state is already sufficient;
- whether failure evidence should be requested first;
- whether adding context would create token waste or noise.

## Validation Strategy

Every improvement should be measured against the same gates:

- Kairn pass rate at least baseline;
- no repeated harmful-assist class;
- positive pass/pass savings;
- token regressions isolated and explained;
- MCP attribution remains useful;
- long-session quality remains stable;
- no private source, prompts, paths, diffs, branch names, or raw output in public artifacts.

Recommended sequence:

1. Offline scoring on existing benchmark artifacts.
2. Proxy campaign through the fast campaign harness.
3. Targeted live recheck on affected rows plus controls.
4. Fresh SWE-Pro official slice.
5. MCP/endurance repeat-3 suite.
6. Private beta telemetry review.

## Near-Term Recommendation

Do not start with a heavy ML system.

The next practical version should be:

- modularize the current governor/routing/sizing code;
- expose clear feature vectors for context-action decisions;
- log sanitized decision metadata;
- build offline analysis over existing campaign artifacts;
- tune deterministic thresholds first;
- only then consider learned ranking or lightweight classifiers.

This keeps Kairn defensible, testable, and local-first while still moving toward a smarter, more adaptive context runtime.
