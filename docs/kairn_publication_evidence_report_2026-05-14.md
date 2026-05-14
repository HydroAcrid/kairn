# Kairn Publication Evidence Report 2026-05-14

This report records the first publication-oriented live campaign run after adding the publication orchestrator. The main result is not yet a final scientific claim. It is a campaign log: what passed, what failed, which general fixes were made, and what needs repeat validation next.

## Campaign Scope

Model: `gpt-5.4-mini`

Primary modes tested:

- `baseline`
- `kairn_codex_session`
- `real_mcp_first` on the initial one-shot slice only

Controlled artifacts:

- `docs/publication-evidence-20260514/raw/fresh-holdout-v3-preflight.json`
- `docs/publication-evidence-20260514/one-shot-post-guardrail/publication-summary.json`
- `docs/publication-evidence-20260514/companion-routing/publication-summary.json`
- `docs/publication-evidence-20260514/companion-routing/companion-routing-live.json`
- `/tmp/kairn-publication-one-shot-repeat1-post-guardrail/`
- `/tmp/kairn-publication-companion-routing/`
- `/tmp/kairn-publication-live-20260514/`

## Harness Fixes

The first live run exposed a benchmark harness bug before it exposed a Kairn behavior issue.

- Publication proof runs now write partial artifacts while live runs are in progress.
- Publication progress now prints the active repeat, mode, and case.
- Agent command placeholder expansion now supports `{session}` and `{turn}`.
- `kairn_codex_session` publication commands no longer pass a non-existent pre-created session to `kairn codex`; the wrapper owns its own session.

A mini Rich proof after the harness fix passed with active Kairn:

| Case | Baseline Tokens | Kairn Tokens | Quality | Savings |
| --- | ---: | ---: | --- | ---: |
| `python-rich-cell-len-cache` | 16,687 | 5,156 | pass/pass | 69.1% |

## Preflight

Fresh holdout v3 repo-matrix preflight:

| Result | Count |
| --- | ---: |
| Repos checked | 9 |
| State gates passed | 9 |
| Primary-source preflight passed | 6 |
| Primary-source preflight failed | 3 |

Repeated failure classes:

- Adjacent pipeline companion routing: Vite-like tasks needed better source-vs-example routing.
- Go same-package role routing: Zap/Gin-style package companions need repeat validation.
- JVM/Kotlin exact class/path routing: OkHttp-like class routing still needs broader proof.

## Initial One-Shot Live Slice

After the harness fix and the first conservative `kairn codex` source-policy change, the 8-case one-shot slice produced mixed evidence.

| Mode | Tokens | Case Quality |
| --- | ---: | --- |
| baseline | 271,506 | 6 pass, 2 fail |
| `kairn_codex_session` | 208,250 | 5 pass, 3 partial |

Raw token reduction was 23.3%, but it was invalid as a savings claim because Kairn had quality misses in Vite, Commons Text, and spdlog.

Case-level pattern:

- Kairn improved Zod from baseline fail to pass and reduced tokens.
- Kairn correctly suppressed Chi and avoided the earlier over-assist pattern.
- Kairn kept Rich/Pydantic positive.
- Kairn missed companion files for Vite, Commons Text, and spdlog.

The important diagnosis: Kairn was finding the primary source, but its companion routing was still too generic.

## General Improvements Made

These were behavior-class fixes, not repo-specific special cases.

1. `kairn codex` now uses the same automatic source policy as Codex hooks.
   This lets cheap high-confidence one-file tasks shrink to a minimal guardrail or suppress instead of injecting normal focused context.

2. Companion routing now ignores URL/path examples as source anchors.
   Example literals like `/src/main.ts` should not cause Kairn to recommend template `main.ts` files.

3. Companion routing now downranks cross-runtime Node/server files for browser/client source tasks.
   Client/browser URL tasks should prefer client/shared utilities over `src/node` surfaces unless the prompt explicitly asks for Node/server behavior.

4. Companion routing now recognizes text-transform utility siblings.
   Same-package utility companions with delimiter/whitespace/capitalization behavior are preferred over generic string helpers.

5. Companion routing now recognizes C/C++ inline-header companions.
   Public API `*-inl.h` companions are preferred for header fixes when they contain the relevant behavior surface.

6. Multi-file directives no longer replace a high-confidence exact primary source with a companion as the primary.
   Companions may be included, but the exact source remains primary.

## Focused Post-Fix Live Rerun

The three previously failing companion-routing cases were rerun after the general routing fixes.

| Case | Baseline Tokens | Kairn Tokens | Quality | Files Used |
| --- | ---: | ---: | --- | --- |
| Vite `injectQuery` | 42,823 | 23,728 | pass/pass | `client.ts`, `shared/utils.ts` |
| Commons Text `CaseUtils` | 20,955 | 9,774 | pass/pass | `CaseUtils.java`, `WordUtils.java` |
| spdlog `should_log` | 31,354 | 10,064 | pass/pass | `logger.h`, `spdlog-inl.h` |

Aggregate:

| Metric | Result |
| --- | ---: |
| Baseline tokens | 95,132 |
| Kairn tokens | 43,566 |
| Valid active savings | 51,566 |
| Savings rate | 54.2% |
| Quality | pass/pass |
| Scope violations | 0 |
| Assistance classification | `valid_assist` |

This is the strongest evidence from this campaign: the same failure class that caused invalid savings was fixed by a general companion-routing improvement and then passed live with large savings.

## MCP Finding

`real_mcp_first` was included in the initial one-shot slice and performed poorly for cheap/source-rescue one-shot patch tasks. It had lower quality and higher token use in that setting.

Current conclusion:

- MCP should not be the default for cheap one-shot source fixes.
- MCP remains important for broad, failure-driven, editor-extension, and long-session workflows.
- The next MCP evidence should use broad/failure/endurance cases, not the cheap one-shot patch slice.

## Claim Status

Current controlled claim supported by this campaign:

> Kairn can convert invalid or noisy source-rescue behavior into valid active savings when companion routing is correct. In the focused post-fix rerun, active Kairn reduced tokens by 54.2% while preserving quality.

Claims not yet publication-ready:

- Overall median savings across all fresh repos.
- MCP-vs-hook performance across endurance sessions.
- SWE-Pro official evaluator acceptance at scale.
- Repeat-3 statistical stability for the new routing fixes.

## Next Required Runs

Before using this as scientific-report evidence:

1. Rerun the 8-case one-shot slice with repeat-3.
2. Rerun endurance repeat-3 on at least Requests, Gin, Axios/Flask-style, and one fresh framework case.
3. Test MCP only on broad/failure/endurance tasks where MCP is expected to help.
4. Run SWE-Atlas/QnA grounding and SWE-Pro official-evaluator pilots separately.
5. Keep behavior-class fixes only; do not tune to individual repo outcomes.
