# Kairn Month-Long Session Memory Plan

## Summary

Kairn is pointed at a stronger long-session architecture than normal chat compaction, but month-long reliability is not proven yet. The goal is to make Kairn behave like a repo-grounded working memory for long Codex/Claude conversations: remember what source was already shown, what changed, what passed, what failed, and when old facts should stop influencing new turns.

This plan is intentionally future-facing. It should guide implementation and validation before Kairn claims reliable weeks/months-long token savings.

## Current Foundation

Kairn already has the right base:

- A structured session ledger in `.kairn`, not raw conversation text.
- Metadata-only events for files shown, files touched, failures seen, commands run, verification outcomes, ignored recommendations, and active working-set files.
- Anti-repeat policy that can suppress unchanged repeated files/snippets.
- Re-emission rules when a file changed, a new failure references it, or the task phase shifts.

This is better suited to long coding sessions than prose chat compaction. Chat compaction summarizes the conversation. Kairn can remember repo facts such as:

> `src/foo.ts` was shown at hash `abc`, touched by the agent, verification passed, and the previous failure is now stale.

## Main Limitation

The weak point is long-lived host-session continuity.

Kairn works best when Codex/Claude keeps a stable conversation/session identifier that maps back to one Kairn session. If the host changes IDs, starts a new chat, or hooks do not expose durable identity, Kairn may create a new session and lose the memory advantage.

The product needs either:

- stable host-session mapping across Codex/Claude/MCP/hook paths, or
- an explicit Kairn-owned launcher/wrapper that binds the agent process to a Kairn session.

## Product Direction

The likely winning UX:

```bash
kairn start
kairn codex
```

or:

```bash
kairn start --session <name>
codex
```

where hooks and MCP resolve to the same durable Kairn session for that conversation.

In this model, Kairn becomes less like prompt RAG and more like local repo working memory.

## Required Improvements

### 1. Stable Session Identity

- Add explicit named sessions: `kairn session start <name> --root <repo>`.
- Store host-session aliases for Codex/Claude/MCP in one session record.
- Add a `kairn codex --session <name>` launcher that injects the session into hook setup and MCP instructions.
- Add recovery: if a host session changes but cwd, branch, and recent prompt hash match, offer/session-map continuity instead of creating a new memory island.

### 2. Branch And Commit Awareness

- Record git branch, HEAD commit, and dirty file hashes in ledger events.
- Mark facts stale when:
  - branch changes,
  - HEAD moves significantly,
  - a file hash changes,
  - a file was deleted/renamed,
  - verification passed after a failure.
- Prefer fresh current-branch context over old cross-branch ledger facts.

### 3. Ledger Aging

- Split memory into active and archive tiers.
- Active tier keeps current files, current invariant, latest failure, latest passing verification, open risks, and last few useful recommendations.
- Archive tier keeps older facts for retrieval but does not automatically prime the agent.
- Add TTL-like decay by file hash, turn count, and phase transitions, not wall-clock alone.

### 4. Working-Set Compaction

Periodically derive a compact working-set snapshot:

- active files,
- touched files,
- ignored recommendations,
- stale files,
- current invariant,
- latest failure,
- latest passing verification,
- next smallest useful read,
- open risks.

Do not compact into generic prose. Keep file refs, hashes, symbols, and source invariants structured.

### 5. Long-Session Context Policy

Automatic delivery should follow these rules:

- If the same file/snippet was already shown and unchanged, suppress or emit a one-line reminder.
- If verification passed, stop suggesting stale ignored files.
- If a new failure references a known file, re-emit only failure-linked evidence.
- If the task target changes, allow a new focused retrieval.
- If the user asks broad planning questions, summarize the working set rather than source snippets.

### 6. Host Tooling Coverage

Support multiple surfaces:

- Codex hooks: automatic prompt and failure context.
- MCP: explicit next-read gateway.
- Kairn wrapper: strongest session continuity.
- CLI: manual inspection and ledger debugging.

The same Kairn session must be shared across these surfaces.

## Validation Plan

Month-long behavior cannot be proven with one-shot benchmarks. Add staged endurance tests:

### Stage 1: 8-12 Turn Simulations

Repos where one-shot Kairn already works:

- Vite or Axios,
- Rich or Pydantic,
- Chi or Gin,
- Commons Text or Guava.

Turns:

1. Diagnose source.
2. Fix source.
3. Handle verification failure or edge case.
4. Cleanup/review diff.
5. Ask a related follow-up.
6. Switch to a nearby file.
7. Return to original source.
8. Verify and summarize.

Measure:

- total observed tokens,
- repeated file reads,
- repeated Kairn context suppressed,
- stale recommendations,
- quality pass/fail,
- active vs passive Kairn assistance.

### Stage 2: 20-50 Turn Synthetic Endurance

Simulate a long coding conversation:

- repeated prompts,
- multiple failures,
- branch/commit changes,
- source file edits,
- stale failures,
- cleanup and review cycles.

Acceptance:

- Kairn reduces repeated reads,
- Kairn does not repeat unchanged context,
- stale facts are demoted,
- quality gates pass,
- active Kairn savings are separated from passive/suppressed savings.

### Stage 3: Real Multi-Day Pilot

Use Kairn in a real repo over multiple days with:

- stable named session,
- hook + MCP enabled,
- periodic ledger reports,
- manual quality review.

Do not claim month-long reliability until this passes.

## Metrics

Add/track:

- stable session continuity rate,
- repeated files avoided,
- stale recommendations suppressed,
- changed-file re-emissions,
- failure re-emissions,
- archive-to-active promotions,
- active Kairn turns,
- passive/suppressed turns,
- missed opportunities,
- harmful assists,
- quality-gated cumulative savings.

## Acceptance Criteria

Kairn can claim long-session readiness when:

- A named session survives 20-50 turns without memory drift.
- Context repeated unchanged is suppressed.
- Changed files and new failures re-enable focused context.
- Branch changes stale old facts safely.
- Quality passes across the full endurance task.
- Active Kairn assistance saves tokens versus baseline without relying on passive/suppressed evidence.

## Non-Goals

- Do not store raw chat transcripts.
- Do not store raw command output by default.
- Do not summarize the whole conversation into generic prose.
- Do not force Kairn context into every turn.

## Product Principle

Kairn’s long-session value is not remembering everything. It is remembering the right repo-grounded facts, knowing when they are stale, and staying quiet when they are no longer useful.
