# Canonical Source Routing + One-File Guardrails Plan

## Goal

Turn passive missed-opportunity evidence into active Kairn-assisted savings without making hooks noisy again.

The target behavior is:

- If Kairn rescues a precise production source file that Codex may otherwise search for, emit a tiny one-file guardrail.
- If the task is already an obvious cheap exact-source fix, stay silent.
- If the top match is a test, platform mirror, dependency, or generated surface, route back to canonical production source before emitting anything.
- If companion evidence is generic, avoid expanding beyond the primary source.

## Behavior Classes

### Canonical Source Routing

Kairn should prefer main production source over variants when the prompt does not ask for a platform-specific implementation.

Examples of general routing rules:

- `src/`, `lib/`, `include/`, `src/main/java`, module `src/`, and root package sources outrank tests/docs/examples.
- Java `android/`, `jre/`, `gwt/`, and emulation mirrors are downranked unless the prompt names that platform.
- Go build-tag files such as `_windows.go`, `_notwin.go`, `_appengine.go`, `_nocgo.go`, and similar variants are downranked unless named.
- Changed production files receive a stronger rescue signal during source/debug prompts.

### Monolithic Public API Routing

Some libraries expose behavior from a single root module, such as `lodash.js`. For public API prompts, Kairn should let a root production module beat tests and build helpers only when there is an exact exported-symbol/API signal.

This is intentionally narrow: a root file does not win just because it is at the top level.

### One-File Source-Rescue Guardrails

The hook should emit a compact guardrail when:

- the primary file is production source,
- the exact hit came from source-rescue evidence,
- the confidence score and gap are strong,
- the task is a debug/fix/regression task,
- and the hit is not an ultra-obvious cheap exact-source case.

The guardrail shape is:

- one start file,
- one invariant,
- one smallest-check instruction,
- no related/test fanout.

### Cheap Exact-Source Abstention

If Codex already has enough signal, Kairn should suppress rather than add tokens.

Examples:

- very obvious dynamic-language one-file fixes,
- exact path named in the prompt,
- weak or noisy retrieval confidence,
- no real source-rescue evidence.

## Implementation Notes

Implemented changes:

- Added `sourceRescue` and `canonicalSourceHit` decision metadata.
- Added canonical route scoring for production source surfaces.
- Added platform variant/mirror downranking for Go, Java, and C/C++.
- Added monolithic public API source scoring for exact exported API prompts.
- Boosted changed production source files for source/debug prompts.
- Changed automatic hook suppression so source-rescue hits can emit one-file guardrails, while cheap exact-source prompts still suppress.

## Validation Plan

1. Targeted unit/integration tests:
   - canonical Java source beats Android mirror,
   - canonical Go source beats build-tag variants,
   - public JS API root source beats tests,
   - obvious Flask exact-source hook still suppresses,
   - source-rescue exact hits stay eligible for one-file guardrails.
2. Full verification:
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm build`
   - `git diff --check`
3. Fresh holdout live proof:
   - Lodash,
   - HTTPX,
   - Guava,
   - Cobra.

## Success Criteria

- Quality gates pass.
- Retrieval routes expected production source first.
- Hook mode emits active one-file guardrails on source-rescue cases.
- Cheap exact-source cases remain silent.
- Report separates valid active savings from passive suppressed savings.
