# Kairn SWE-Pro Pass/Pass + Fresh MCP Evidence Plan 2026-05-21

## Summary

Now that private beta install/update/remove smoke is working and early users have the package, the next internal credibility goal is official benchmark evidence.

Priority order:

1. Produce clean SWE-Pro pass/pass savings rows.
2. Add one fresh MCP endurance repo outside the already-tested Click/SemVer pattern.
3. Roll those findings into the public website/waitlist narrative.

The purpose is not endless tuning. The purpose is to move from:

> Kairn can rescue quality and enforce scope on official SWE-Pro rows.

to:

> On some official SWE-Pro rows where baseline and Kairn both pass, Kairn also reduces tokens while preserving official correctness and local scope discipline.

## Part 1: SWE-Pro Pass/Pass Expansion

### Goal

Find 3-5 fresh official SWE-Pro rows where:

- baseline passes official evaluator,
- `kairn_codex_session` passes official evaluator,
- local scope discipline passes,
- Kairn emits or guides active useful assistance,
- Kairn uses fewer observed Codex tokens than baseline.

Rows that do not meet all five conditions are still useful, but they must be classified honestly as quality rescue, scope rescue, neutral, invalid savings, or failure.

### Selection Criteria

Prefer rows with:

- one or two production edit files,
- valid Docker images / official evaluator setup,
- deterministic test commands,
- non-procedural problem statements,
- clear source-grounding from preflight,
- no giant monorepo setup cost,
- no obvious benchmark leakage or golden patch use.

Avoid for this slice:

- qutebrowser rows already used heavily,
- broad architecture tasks,
- huge dependency/bootstrap rows,
- rows where baseline times out before a valid patch attempt,
- rows requiring generated snapshots/tests unless the issue explicitly requires them.

### Candidate Discovery

Use the existing SWE-Pro helper/export pipeline and preflight filters:

1. Load official rows.
2. Filter by valid evaluator image/tag.
3. Filter to source-quality preflight pass.
4. Filter to low/medium latency risk.
5. Filter to expected production patch files count <= 2 when known.
6. Deduplicate repos already overused in Kairn tuning.

Initial target size:

- 8-12 candidate rows selected by preflight.
- Run 3-5 rows first.
- Keep backup rows ready if Docker/evaluator setup fails.

### Modes

For each selected row:

- `baseline`
- `kairn_codex_session`

Do not include MCP/hybrid in the first pass/pass SWE-Pro slice. MCP can be tested later only on rows where source discovery/debug complexity is high.

### Execution Flow

For each row:

1. Create disposable workspace from official setup.
2. Generate baseline patch with Codex.
3. Generate Kairn patch with `kairn_codex_session`.
4. Capture observed tokens, elapsed time, changed files, and Kairn decisions.
5. Run official evaluator on both patches.
6. Run local scope/source checks:
   - required production source touched,
   - no unrelated files touched,
   - tests/docs/generated only edited when explicitly justified.
7. Classify row.

### Classification Rules

Clean pass/pass savings:

- baseline official pass,
- Kairn official pass,
- baseline local scope pass,
- Kairn local scope pass,
- Kairn active assistance used,
- Kairn observed tokens lower than baseline.

Quality rescue:

- baseline official fail,
- Kairn official pass.

Scope rescue:

- baseline or earlier Kairn attempt failed local scope,
- current Kairn passes official eval and scope after a general behavior-class fix.

Invalid savings:

- lower tokens but official eval fails,
- lower tokens but local scope fails,
- lower tokens but Kairn was passive/suppressed only,
- lower tokens but active MCP/Kairn did not identify expected or later-used source.

Neutral:

- both pass,
- Kairn tokens roughly equal or higher,
- no harmful assist.

Harmful assist:

- Kairn changes a passing baseline into a failing official result,
- or repeatedly drives edits outside source scope.

### Acceptance Gate

For this pass, satisfactory evidence means:

- at least 3 non-qutebrowser official rows completed,
- at least 2 baseline official passes,
- at least 2 Kairn official passes,
- at least 1 clean pass/pass savings row,
- no repeated harmful-assist pattern,
- all invalid savings are clearly excluded from headline claims.

Stretch target:

- 5 completed rows,
- 2+ clean pass/pass savings rows,
- Kairn official pass rate >= baseline pass rate.

### General Fix Policy

If failures appear, only implement fixes that generalize across behavior classes:

- source-scope routing,
- test-to-source counterpart routing,
- generated/vendor/test downranking,
- stale index handling,
- failure-output evidence requests,
- compact directive clarity,
- official evaluator harness robustness.

Do not add repo-specific or row-specific boosts.

After any fix:

- rerun the affected row,
- rerun at least one unaffected SWE-Pro row,
- rerun one small deterministic source/scope unit test group if the behavior changed.

### Artifacts

Write results under:

- `docs/publication-evidence-20260521/swe-pro-passpass/`

Required files:

- `swe-pro-passpass-summary.json`
- `swe-pro-passpass-results.csv`
- `swe-pro-passpass-failures.csv`
- `proof.json`
- compact patch metadata, not huge raw evaluator folders unless needed
- updated section in `docs/kairn_beta_stabilization_and_evidence_update_2026-05-19.md`

Do not commit large raw Docker/evaluator output unless it is compact and necessary.

## Part 2: Fresh MCP Endurance Repo

### Goal

Add one fresh endurance/MCP proof outside the Click/SemVer pattern.

Success means:

- baseline passes quality,
- real MCP-first passes quality,
- actual MCP tool calls are recorded,
- useful returned or guided source files are recorded,
- Kairn stays disciplined after source is known,
- later turns avoid repeated broad context,
- pass/pass savings are positive or neutral with no harm.

### Candidate Repos

Preferred order:

1. Go: `spf13/cobra`, `rs/zerolog`, or `go-gorm/gorm`
2. Java/Kotlin: `square/okhttp` or `junit-team/junit5`
3. C/C++: `catchorg/Catch2`

Reasoning:

- Click and SemVer already cover Python/JS-style source-rescue endurance.
- A Go or Java row broadens language evidence.
- C/C++ is useful but may carry more setup friction.

### Suite Shape

Use 6-10 turns:

1. diagnose source behavior,
2. fix smallest production source,
3. run focused verification,
4. handle a failure or edge case,
5. review diff/scope,
6. repeat context pressure,
7. cleanup final answer.

The suite should include:

- one expected production source file,
- optional companion file only if genuinely needed,
- final verification command,
- source invariant,
- diff scope,
- no golden patch leakage in prompts.

### Modes

Run:

- `baseline`
- `real_mcp_first`

Optional after clean result:

- `kairn_codex_session`
- `hybrid_mcp_brief`

Repeat:

- repeat-1 canary first,
- repeat-3 if canary is quality-clean.

### MCP Proof Fields

Report must include:

- actual MCP tool calls,
- returned useful files,
- guided/attributed useful files,
- returned noisy/test files,
- `continue_known_source` turns,
- suppressed repeated context,
- scope violations,
- observed token deltas,
- active/passive/invalid classification.

### Acceptance Gate

Good enough for roadmap evidence:

- repeat-3 pass/pass if canary is clean,
- median MCP savings >= 15% or clear neutral/no-harm with quality rescue,
- zero scope violations,
- no repeated unnecessary MCP calls after source/invariant is known.

## Part 3: Website/Waitlist Readiness After Evidence

After SWE-Pro pass/pass and one fresh MCP endurance result:

1. Update evidence report.
2. Update roadmap results table.
3. Prepare website copy with conservative claims.
4. Build SPA with waitlist.
5. Keep beta telemetry separate from scientific evidence.

Safe public framing:

> Kairn is a local context governor for AI coding agents. In controlled tests, it reduced token use on debug and long-session tasks while preserving quality gates. Codex is the most-tested path; MCP is the portable editor path.

Avoid:

- guaranteed savings,
- universal 20-70% claims,
- claiming equal Claude/Gemini/Copilot performance before enough external testing,
- claiming official benchmark dominance from a small SWE-Pro slice.

## Immediate Next Commands

Preflight:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

SWE-Pro candidate discovery:

```bash
node dist/cli.js bench publication \
  --plan examples/bench/publication-plan-v3.json \
  --out-dir docs/publication-evidence-20260521/swe-pro-passpass \
  --dry-run
```

Then run the smallest official SWE-Pro candidate canary before scaling to 3-5 rows.

## Decision Point

Proceed to website/waitlist once all are true:

- private beta install smoke is stable enough,
- at least one clean SWE-Pro pass/pass savings row exists or the report clearly explains why SWE-Pro is mostly quality-rescue evidence,
- at least three endurance pass/pass rows exist across different repo/language families,
- MCP proof fields are clean in at least two endurance slices,
- claims matrix is updated with safe/unsafe claims.
