# Kairn LinkedIn And Website Brief 2026-05-18

This brief is for the public-preview website and LinkedIn announcement after the v3 evidence campaign is run. Do not publish numbers until they are copied from `docs/kairn_publication_evidence_report_2026-05-18.md`.

## Conservative Positioning

Kairn is a local context governor for coding agents. It watches the repo, builds a structured working memory, and decides when to give the agent source context, when to shrink that context to a small directive, when to ask for missing evidence, and when to stay silent.

The public claim should be:

> In controlled coding-agent tests, Kairn reduced token use on source-rescue, debug, and long-session work while preserving quality by selectively shrinking, suppressing, and routing context.

Avoid claiming universal savings or model-independent performance until the beta telemetry and additional non-Codex runs support it.

## LinkedIn Announcement Draft

I have been building Kairn, a local context-governance layer for AI coding agents.

Instead of dumping more repo context into the model, Kairn tries to answer a harder question: should the agent get context at all?

It indexes your repo locally, tracks the active working set across a session, and then chooses between:

- providing focused source context,
- giving a tiny edit-scope directive,
- asking for failure output or a stronger signal,
- or staying silent when the agent probably does not need help.

In controlled private tests, this has produced meaningful token reductions on source-rescue, debug, MCP, and long-session workflows while keeping quality gates intact. The most-tested path is Codex, with MCP support for editor and non-CLI agents.

I am opening a small technical preview soon. The tool is local-first, telemetry is opt-in, and uploaded telemetry is sanitized: no source, prompts, diffs, filenames, repo names, paths, branch names, or raw outputs.

Waitlist: [link]

## Technical Follow-Up Draft

The design goal behind Kairn is not "more RAG." It is context governance.

Most coding-agent context systems optimize retrieval: find relevant files and send them. Kairn adds a decision layer before delivery:

1. Classify the task frame.
2. Score candidate files by source role, language alignment, graph proximity, generated/test/doc risk, session freshness, and retrieval confidence.
3. Decide whether to emit, shrink, suppress, or request evidence.
4. Track the session ledger so later turns do not repeat unchanged context.

The interesting result so far is that suppression is as important as retrieval. Cheap exact-source tasks should usually get nothing or a tiny guardrail. Debug and endurance tasks benefit when Kairn finds the right invariant and then stops repeating itself.

The v3 evidence bundle separates:

- active pass/pass savings,
- correct abstention,
- evidence requests,
- invalid savings,
- quality rescues,
- MCP usefulness,
- governor ablation,
- and overhead.

Report: [link to `docs/kairn_publication_evidence_report_2026-05-18.md`]

## Website SPA Outline

### Hero

Headline: Local context governance for AI coding agents.

Subcopy: Kairn helps Codex and MCP-compatible agents spend less time rereading your repo by deciding when to provide source context, when to shrink it, when to ask for evidence, and when to stay silent.

CTA: Join the technical preview.

Secondary CTA: Read the evidence report.

### What Kairn Does

- Builds a local repo index.
- Maintains a per-session ledger of files shown, files touched, failures seen, and verification status.
- Routes context through a governor that can emit, shrink, suppress, or request evidence.
- Supports Codex session hooks and MCP-compatible clients.
- Records local metrics and optional sanitized telemetry.

### Architecture Diagram Copy

User prompt -> task-frame classifier -> retrieval candidates -> context governor -> delivery mode.

Delivery modes:

- `emit`: focused context block.
- `shrink`: one-file or two-file directive with edit scope.
- `request_evidence`: asks for failure output, command, symbol, or runtime signal.
- `suppress`: stays silent.

Session ledger feeds back into the next turn so unchanged files are not repeated.

### Results Table

Populate from v3 final report:

| Slice | Modes | Quality | Median Valid Savings | Notes |
| --- | --- | --- | --- | --- |
| Fresh holdout repeat-3 | baseline vs Kairn session | TBD | TBD | Pass/pass rows only |
| MCP endurance | baseline vs real MCP-first | TBD | TBD | Requires actual MCP calls |
| Governor ablation | governed vs no-governor | TBD | TBD | Shows decision-layer impact |
| SWE-Pro official | official evaluator | TBD | TBD | Savings only count if evaluator passes |

### Privacy And Local-First

- Repo indexing happens locally.
- Detailed ledger and metrics live under `.kairn/`.
- Telemetry is opt-in.
- Sanitized uploads exclude source, prompts, raw outputs, diffs, filenames, paths, repo names, usernames, branch names, and machine paths.

### Supported Modes

- Codex CLI/session: most-tested path.
- MCP: portable path for editor and app integrations.
- Hybrid: advanced path combining hooks and MCP.
- Diagnostics-only: local reporting without agent integration.

### Caveats

- Codex is the most-tested agent path today.
- Kairn is not meant to save tokens on every task.
- Kairn may stay silent when confidence is low.
- Official benchmark savings are counted only when quality and scope gates pass.
- Private beta telemetry is product evidence, not scientific proof.

### Waitlist Copy

Kairn is currently in technical preview. Join if you use AI coding agents on real repos and are willing to try a local-first context governor. Codex is the most-tested path; MCP is available for compatible editor agents. Optional telemetry is sanitized and helps improve routing without uploading your code.

## Claims Matrix

### Safe Claims After V3 Passes

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
- Source code never leaves the machine if the user manually shares diagnostics with source snippets enabled.

## Launch Checklist

- Fill results table from the v3 final report.
- Add waitlist URL.
- Link privacy docs.
- Link install docs and `kairn doctor`.
- State technical-preview status clearly.
- Keep beta telemetry separate from scientific evidence.
