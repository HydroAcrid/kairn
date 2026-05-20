# Kairn Roadmap 2026-05-19

This roadmap replaces the earlier LinkedIn/website brief. It keeps the public-preview copy, but puts it behind the work that matters first: private beta stability, a credible evidence bundle, then a waitlist launch.

## Current Position

Kairn is a local context governor for coding agents. It indexes the repo locally, keeps a structured session ledger, and decides whether to emit focused source context, shrink to an edit-scope directive, request missing evidence, or stay silent.

The most-tested path is `kairn codex`. MCP is the portable path for editor and non-Codex clients. Hybrid mode remains advanced until more holdout runs show it is consistently neutral or positive.

## Immediate Sprint

### 1. Stabilize Private Beta Package

Goal: friends should be able to install, update, use, diagnose, and remove Kairn without hand-holding.

Required checks:

- `npm install -g ./kairn-*.tgz` works on macOS, Windows, and WSL.
- Reinstalling the same tarball behaves like a smooth update.
- `kairn setup wizard` supports Codex CLI, VS Code/Copilot MCP, Claude Code MCP, Gemini MCP, generic MCP, and multi-target setup.
- `kairn doctor --target <agent>` gives targeted, actionable output.
- `kairn telemetry status`, `enable`, auto-flush, and `beta report` work without exposing prompts, paths, filenames, diffs, source, branch names, or repo names.
- `kairn setup remove --delete-state` removes Kairn-owned config and `.kairn/` while preserving unrelated user config.
- Windows paths with OneDrive and shell metacharacters are handled or clearly warned.

Current result:

- Local tarball smoke on Node 24 passed install, reinstall/update, wizard, target-specific doctor, telemetry enable/auto-flush through beta report, setup removal, and uninstall.
- Windows/WSL tester handoff: `docs/kairn_windows_wsl_beta_smoke_handoff_2026-05-20.md`.
- Remaining before wider beta: one native Windows smoke and one WSL smoke from a real user machine.

### 2. Small SWE-Pro Expansion

Goal: strengthen the credibility line without overfitting to qutebrowser.

Target claim:

> On official SWE-Pro generated-patch rows, Kairn can improve pass rate and may produce pass/pass savings when quality and scope gates pass.

Rules:

- Use official evaluator results only.
- Do not count savings unless baseline and Kairn both pass official eval.
- Do not count savings when local scope discipline fails.
- Separate quality rescue from clean savings.

Current 2026-05-19 expansion:

- Initial broad four-row expansion was stopped because selected rows were too large and timed out before producing useful artifacts.
- A tractable non-qutebrowser three-row slice was generated from the local official SWE-Pro export.
- A general loader fix was added so Kairn accepts official helper rows with inferred `repo_language` and uppercase `FAIL_TO_PASS` / `PASS_TO_PASS` arrays.
- Official result: baseline passed 2/3, Kairn passed 3/3.
- Clean pass/pass savings rows: 0, because the two pass/pass rows had local scope violations.
- Quality rescue rows: 1.

2026-05-20 scope recheck:

- Added a general production-source-only scope fix for prompts that say `fix the issue in production source` and `do not edit unrelated files`.
- Kairn reran the tractable three-row slice and produced one-file production patches for all rows.
- Official evaluator result: Kairn passed 3/3.
- Local scope result: Kairn passed 3/3.
- Clean active pass/pass savings rows remain 0; this is official pass-rate, quality-rescue, and scope-rescue evidence rather than a savings headline.

Next SWE-Pro step:

- Prefer new rows with one production edit file, valid Docker images, and non-procedural problem statements.
- Keep SWE-Pro as credibility evidence, not the only product proof.

### 3. Fresh Endurance/MCP Check

Goal: verify the product wedge: Kairn stays useful over multiple turns and MCP calls stay disciplined after source is known.

Current 2026-05-19 result:

- Added `examples/bench/endurance-commons-text.json`, a six-turn Java endurance suite.
- First run exposed a harness accounting bug: setup-owned files from MCP config were counted as agent edits.
- Fixed endurance accounting so setup baseline files are ignored unless the agent later changes them.
- Post-fix run: real MCP-first passed quality and official-like source scope; baseline failed final verification.
- Interpretation: quality rescue, not pass/pass token savings.

Next endurance step:

- Completed one fresh repeat-3 pass/pass slice on Click compatibility encoding.
- Result: baseline, Kairn Codex session, and real MCP-first all passed 3/3 final quality.
- Kairn Codex session median valid savings: 42.7%, with one over-assist repeat caused by a high-token repeat-context turn after Kairn had already suppressed context.
- Real MCP-first median valid savings: 52.6%, with 3/3 valid savings runs, 4 actual MCP calls, 3 useful returned files, and 0 scope violations.
- The run produced a general active-source continuation fix: known session source now beats fresh one-file candidates during later turns.
- Completed a second fresh repeat-3 pass/pass slice outside Python on `npm/node-semver`.
- SemVer result: all modes passed 3/3; Kairn Codex session median savings was 16.4% with 2/3 valid savings runs; real MCP-first showed 48.6% observed savings but is treated as supporting evidence in that artifact because useful returned files were not captured.
- Completed a general MCP attribution fix after the SemVer run: compact guardrail/known-source MCP responses now expose explicit `attributedFiles`, so future runs can credit useful source-file guidance without scraping text or counting noisy suppressed failure metadata.

Next endurance step:

- Keep MCP proof fields visible: actual MCP calls, useful returned files, suppressed repeated context, scope violations, and after-turn-1 behavior.
- Rerun one compact-guardrail MCP slice if we want to convert the SemVer-style observed savings into active-valid MCP savings under the new attribution accounting.

## Evidence Roadmap

### Controlled Evidence

- Fresh unseen repo repeat-3 or repeat-5.
- Endurance repeat-3 on at least three repos.
- MCP repeat evidence with actual tool calls recorded.
- Governor ablation on a small representative subset.
- Latency and overhead reporting: setup time, index time, hook/MCP median and p95 latency, context tokens emitted, and net savings.

### Official Evidence

- SWE-Pro official evaluator: 5-10 rows, counted only with official pass plus local scope pass.
- SWE-Atlas/QnA: source-grounding and evidence-request behavior only, not the headline token-savings proof.
- SWE-ContextBench: pilot if setup remains tractable, focused on context reuse and irrelevant prior-context suppression.

### Failure Taxonomy

Every report should separate:

- valid active savings,
- correct abstention,
- correct evidence request,
- over-assist,
- harmful assist,
- missed opportunity,
- quality rescue,
- invalid savings.

Headline savings must use only pass/pass rows.

## Private Beta Rollout

Target users:

- trusted technical users first,
- primarily Codex users,
- MCP users with VS Code/Copilot, Claude Code, Gemini, Antigravity, or generic MCP clients.

Beta positioning:

> Kairn helps coding agents avoid repeated repo context and can reduce token use on debug and long-session work. It is local-first, may stay silent when confidence is low, and optional telemetry is sanitized.

Beta requirements:

- simple tarball or private npm install path,
- clear update command,
- `kairn doctor` as the first support step,
- one-page uninstall instructions,
- opt-in telemetry,
- user-facing `kairn beta report` for local savings/status.

## Website SPA Plan

### Hero

Headline: Local context governance for AI coding agents.

Subcopy: Kairn helps Codex and MCP-compatible agents spend less time rereading your repo by deciding when to provide source context, when to shrink it, when to ask for evidence, and when to stay silent.

CTA: Join the technical preview.

Secondary CTA: Read the evidence report.

### Sections

- What Kairn does.
- How context governance differs from plain RAG.
- Architecture diagram: prompt -> task frame -> retrieval candidates -> context governor -> delivery mode -> session ledger.
- Results table populated from the latest evidence report.
- Privacy/local-first section.
- Supported modes: Codex session, MCP, hybrid, diagnostics-only.
- Caveats and unsupported claims.
- Waitlist CTA.

### Results Table Template

| Slice | Modes | Quality | Median Valid Savings | Notes |
| --- | --- | --- | --- | --- |
| Fresh holdout | baseline vs Kairn session | TBD | TBD | Pass/pass rows only |
| MCP endurance | baseline vs real MCP-first | 3/3 vs 3/3 on Click | 52.6% | Actual MCP calls and useful files recorded; 0 scope violations |
| JS endurance | baseline vs Kairn session | 3/3 vs 3/3 on node-semver | 16.4% | Second pass/pass endurance row outside Python |
| Governor ablation | governed vs no-governor | TBD | TBD | Shows decision-layer impact |
| SWE-Pro official | official evaluator | TBD | TBD | Count only evaluator + scope pass |

## LinkedIn Draft

I have been building Kairn, a local context-governance layer for AI coding agents.

Instead of dumping more repo context into the model, Kairn asks a harder question: should the agent get context at all?

It indexes your repo locally, tracks the active working set across a session, and chooses between:

- focused source context,
- a tiny edit-scope directive,
- a request for failure output or a stronger signal,
- or silence when the agent probably does not need help.

In controlled tests, Kairn has reduced token use on source-rescue, debug, MCP, and long-session workflows while keeping quality gates intact. Codex is the most-tested path, and MCP support is available for editor and non-CLI agents.

I am opening a small technical preview soon. The tool is local-first, telemetry is opt-in, and uploaded telemetry is sanitized: no source, prompts, diffs, filenames, repo names, paths, branch names, or raw outputs.

Waitlist: [link]

## Claims Matrix

### Safe Claims

- Kairn is a local context governor for coding agents.
- Kairn can reduce token use on source-rescue, debug, and endurance tasks in controlled tests.
- Kairn uses suppression and evidence requests to avoid low-confidence context.
- Kairn telemetry is opt-in and sanitized by default.
- Codex is the most-tested path; MCP is the portable path.

### Claims Requiring More Evidence

- Works equally well across Claude, Gemini, Copilot, and Codex.
- Month-long sessions are reliably optimized.
- Official benchmark leaderboard-level performance.
- Universal savings across arbitrary coding tasks.

### Claims To Avoid

- Guaranteed token savings.
- 20-70% savings for every user or repo.
- No quality risk.
- Fully autonomous self-learning optimization.
- Source code never leaves the machine if the user manually chooses to export diagnostics with source snippets enabled.

## Go/No-Go Gates

Before broader waitlist launch:

- macOS tarball smoke passes.
- Windows native smoke passes or has a clear documented workaround.
- WSL smoke passes.
- At least one fresh repeat-3 endurance/MCP slice has pass/pass savings or quality rescue with no scope violations.
- SWE-Pro official summary is updated with evaluator-pass rows and invalid savings separated.
- README install/update/remove path is current.
- Telemetry backend receives sanitized payloads and `kairn telemetry status` reports clearly.
