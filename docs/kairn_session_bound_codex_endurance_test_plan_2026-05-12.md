# Kairn Session-Bound Codex Endurance Test Plan

## Summary

`kairn codex` is the beta-facing automatic path: Kairn creates one session ledger, temporarily binds Codex hooks to that session, launches the real Codex CLI, and restores the previous `.codex` files afterward. The missing proof is whether this product path helps across multi-turn conversations, not just one-shot tasks.

This plan adds a dedicated endurance benchmark mode for the test-equivalent path:

```text
kairn_codex_session = one pinned Kairn session + simulated prompt-hook delivery + Codex turns
```

Interactive Codex itself is not scripted in CI, and `codex exec` is not a reliable proxy for interactive prompt hooks. The benchmark therefore simulates the `UserPromptSubmit` hook in-process before each turn, using the same pinned Kairn session, then runs Codex with hooks disabled. That preserves the important property we need to test: every prompt decision writes to and reads from one durable ledger, without double-counting external hook behavior.

## Modes

Use these modes for long-session validation:

| Mode | Meaning |
| --- | --- |
| `baseline` | Normal Codex, no Kairn. |
| `kairn` | Direct Kairn prompt-prepend control. Highest-control reference, but not the easiest UX. |
| `hook_full_prime` | Regular hook setup. Useful, but host session mapping can vary. |
| `kairn_codex_session` | Product-path equivalent for `kairn codex`: one explicit Kairn session bound across all turns. |
| `real_mcp_first` | Agent read-gateway path. |
| `hybrid_mcp_brief` | Tiny hook directive plus MCP. |

## Test Shape

Run repeat-3 endurance suites on repos where Kairn has not been overfit to one exact benchmark behavior:

1. Diagnose source.
2. Fix source.
3. Handle failure, edge case, or verification.
4. Cleanup and review diff.

Each run must report:

- cumulative observed Codex tokens,
- per-turn token totals,
- quality pass/fail,
- required source touched,
- unrelated diff hunks,
- assistance status: active, passive/suppressed, or none,
- repeated files/snippets avoided,
- same ledger used across all turns,
- missed opportunity versus correct abstention.

## Acceptance

Kairn is beta-positive only when the system-level result is general:

- cheap/easy tasks: Kairn abstains or emits a tiny guardrail with near-zero harm,
- medium source-rescue tasks: active Kairn saves tokens or improves quality,
- hard/debug/multi-file tasks: active Kairn preserves quality and saves cumulative tokens,
- long sessions: repeated context is avoided after turn 1,
- failures: Kairn re-emits focused failure context only when useful.

Do not tune from one repo. Improvements must target behavior classes:

- source rescue,
- multi-file debug,
- cheap single-source abstention,
- failure-first recovery,
- session repeat suppression,
- weak-signal silence.

## CLI Example

```bash
kairn bench endurance \
  --suite examples/bench/endurance-requests.json \
  --baseline-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --kairn-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --kairn-codex-session-setup-command "kairn setup codex --root {root} --mode savings --session {session} >/dev/null" \
  --kairn-codex-session-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --real-mcp-first-setup-command "kairn setup codex --root {root} --mode mcp-first >/dev/null" \
  --real-mcp-first-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --disable hooks {prompt}" \
  --hybrid-mcp-brief-setup-command "kairn setup codex --root {root} --mode hybrid --session {session} >/dev/null" \
  --hybrid-mcp-brief-command "codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access --enable hooks {prompt}" \
  --repeat 3 \
  --json
```

## Next Improvements If Results Are Poor

If `kairn_codex_session` underperforms:

- verify all turns used the same ledger,
- inspect whether hooks were active or suppressed,
- classify missed opportunity versus correct abstention,
- tighten fix/verify turn minimalism,
- suppress after final verification passes,
- emit failure context only after concrete failures,
- reduce repeated hook context if the file hash is unchanged.

The target is not bigger context. The target is a selective context governor that helps more than it hurts across repeated, fresh-ish tasks.
