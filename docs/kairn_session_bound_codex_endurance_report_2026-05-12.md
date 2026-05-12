# Kairn Session-Bound Codex Endurance Report - 2026-05-12

## Summary

The first 10-turn product-path endurance proof is positive. `kairn_codex_session` now tests the `kairn codex` behavior by simulating the session-bound prompt hook before each scripted Codex turn, using one durable Kairn ledger across the whole run.

This avoids treating `codex exec` hook behavior as equivalent to interactive Codex while still testing the core product policy: Kairn decides per prompt whether to shrink, suppress, or provide focused context from the same session memory.

## Live Result

Suite: `examples/bench/endurance-requests-10turn.json`

Model: `gpt-5.4-mini`

Artifact: `/tmp/kairn-requests-10turn-session-live-simulated-20260512111502.json`

| Mode | Quality | Assistance | Observed Tokens | Savings |
| --- | --- | --- | ---: | ---: |
| baseline | pass | none | 333,310 | n/a |
| kairn_codex_session | pass | active | 220,595 | 33.82% |

Kairn saved 112,715 observed tokens while preserving the source invariant and final quality gate.

## Behavior Observed

- Kairn actively shrank the first discovery turn.
- Kairn suppressed repeated or low-value turns after the source was known.
- The ledger avoided 5 repeated file context events and 1 repeated snippet.
- No tests/docs/ext files were touched.
- The session stayed bound to one Kairn ledger across all 10 turns.

## Follow-Up Fix

The live report exposed stale working-set risk noise: after final verification passed, the ledger still warned that a shown file changed after being shown. This is now fixed by clearing changed-file stale risk when a later passing verification covers that file or a general final verification passes.

Deterministic post-fix smoke:

Artifact: `/tmp/kairn-requests-10turn-session-smoke-post-ledger-fix.json`

- quality: pass
- assistance: active
- open risks: none
- next read: none

## Interpretation

This is not yet enough to claim month-long reliability, but it is the right beta-shaped evidence: Kairn helped in a 10-turn session, stayed quiet after the first useful context, and preserved quality.

Next proof should repeat this on fresh suites with different languages and task shapes before promoting a broad beta claim.
