# Post-Launch Routing Recheck Summary

Date: 2026-05-23

## Plan

1. Fix the official pass/pass over-assist class with a tiny exact-source guardrail.
2. Recheck the affected official-style rows plus at least one unaffected control.
3. Run a fresh unseen source-routing matrix before spending more live-agent tokens.
4. Pause the campaign on repeated general failures, implement behavior-class fixes only, then rerun the affected gate.
5. Resume the campaign with a fresh endurance pass/pass slice.

## General Fixes

- Narrow official exact-source patch prompts now use a compact one-file guardrail instead of full focused context.
- Negated interface notes no longer count as explicit multi-file expansion requests.
- `_pytest` source packages are no longer misclassified as tests.
- Rust `.rs` files are classified as source files.
- Multi-surface prompts now recognize routing map/rule/matcher flows, line/comment formatting flows, search/printer output flows, and fixture/runner resolution flows.
- Generic utility/output files are downranked when stronger query-local source companions are available.

## Recheck Results

### Affected Official-Style Rows

- Element PostHog local proof: baseline passed at 55,371 tokens; Kairn passed at 50,500 tokens; 4,871 tokens saved, 8.8%.
- Teleport MFA local proof: baseline failed/timed out; Kairn passed in scope at 47,968 tokens. This remains quality/scope rescue evidence, not clean pass/pass savings.
- OpenLibrary Standard Ebooks control: baseline passed at 36,970 tokens; Kairn passed at 33,538 tokens; 3,432 tokens saved, 9.3%.

### Fresh Source Matrix

Final rerun: `fresh-source-matrix.final-after-routing.json`

- 5 repos, 5 cases.
- 5/5 quality passing.
- 5/5 source-quality passing.
- 5/5 latency passing.
- Rich: `rich/cells.py`.
- Werkzeug: `src/werkzeug/routing/rules.py`, `src/werkzeug/routing/map.py`, `src/werkzeug/routing/matcher.py`.
- Black: `src/black/lines.py`, `src/black/comments.py`, `src/black/linegen.py`.
- ripgrep: `crates/searcher/src/searcher/core.rs`, `crates/core/search.rs`, `crates/printer/src/json.rs`.
- pytest: `src/_pytest/python.py`, `src/_pytest/fixtures.py`, `src/_pytest/runner.py`.

The matrix improved from 1/5 passing before the routing fixes to 5/5 passing after the fixes.

### Fresh Endurance Campaign Slice

Rerun: `endurance-rich-repeat2.after-routing.json`

- Baseline: 100,173 observed tokens.
- Kairn Codex session: 73,436 observed tokens.
- Saved: 26,737 tokens.
- Savings rate: 26.7%.
- Quality gate: passed.
- Assistance classification: valid assist.
- Over-assist: false.
- Harmful assist: false.

## Interpretation

The over-assist fix did not break the endurance story, and the companion-routing update materially improved fresh-repo source selection. The next campaign step should be another fresh live slice only after choosing rows where deterministic preflight is already clean.
