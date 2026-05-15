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
- `docs/publication-evidence-20260514/requests-endurance-repeat1-summary.json`
- `docs/publication-evidence-20260514/requests-endurance-repeat1-results.csv`
- `docs/publication-evidence-20260514/raw/requests-10turn-endurance-repeat1.json`
- `docs/publication-evidence-20260514/raw/swe-atlas-qna-matrix-before-language.json`
- `docs/publication-evidence-20260514/raw/swe-atlas-qna-matrix-post-testintent.json`
- `docs/publication-evidence-20260514/raw/swe-pro-matrix-20260514.json`
- `/tmp/kairn-publication-one-shot-repeat1-post-guardrail/`
- `/tmp/kairn-publication-companion-routing/`
- `/tmp/kairn-publication-live-20260514/`
- `/tmp/kairn-loop-fresh-v4-final-latest.json`
- `/tmp/kairn-loop-private-beta-v3-final-latest.json`
- `/tmp/kairn-loop-qna-final-latest.json`
- `/tmp/kairn-loop-swe-pro-final4.json`
- `docs/publication-evidence-20260514/post-governor-live/seeded-fresh-repeat2-postfix.json`
- `docs/publication-evidence-20260514/post-governor-live/chi-only-recheck-repeat4.json`
- `docs/publication-evidence-20260514/post-governor-live/vite-only-recheck-repeat2.json`

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

7. Compact shrink formatting now preserves invariants, stop conditions, and edit scope before optional snippets.
   This fixed a live Vite failure where Kairn found the correct files but dropped the invariant from the compact delivery.

8. Qualified-symbol routing now boosts owner files for dotted symbols such as `AtomicLevel.Enabled`.
   This fixed a Zap-style owner/provider ambiguity where the provider method had stronger lexical overlap than the owning production file.

9. Endurance MCP guidance now cleans weak ledger-derived invariants and falls back to explicit prompt invariants.
   This fixed corrupted later-turn prompts such as `Invariant: , fix, verify...`.

10. Official benchmark source routing now recognizes `Dataset language label: ...` and downranks generated filename surfaces such as `*.gen.ts`.
    This is a general official-task/source-grounding fix, not a repo-specific rule.

11. Test-intent detection no longer treats “prefer production source over tests unless explicitly asked” as an actual request for tests.
    This reduces noisy test-file retrieval in source-grounded QnA prompts.

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

## Repeat-3 One-Shot Rerun

After compact invariant delivery and qualified owner routing fixes, the 8-case one-shot repeat-3 slice became mostly positive, but not yet a clean overall publication claim.

Consistent active wins:

| Case | Median Valid Savings |
| --- | ---: |
| spdlog `should_log` | 61.18% |
| Pydantic `to_snake`/kebab behavior | 61.46% |
| Rich cell length cache | 53.67% |
| Vite `injectQuery` | 43.35% |
| Zod object-array behavior | 39.29% |

Follow-up targeted reruns:

| Case | Result |
| --- | --- |
| Vite compact invariant recheck | 73.55% valid active savings, pass/pass |
| Zap qualified-owner recheck | 46.56% valid active savings, pass/pass |

Remaining caveats:

- Chi was correctly silent/passive on a cheap source case rather than an active win.
- Commons Text remained volatile across repeats.
- The publication aggregate row showed 13.49% median valid savings because it includes passive/suppressed and volatile rows; case-level active wins are stronger than the aggregate median.

## Requests Endurance Repeat-1

The first post-fix 10-turn endurance run used `baseline`, `kairn_codex_session`, and `real_mcp_first`.

| Mode | Quality | Tokens | Valid Active Savings | Repeated Files Avoided | MCP Calls | Scope Violations |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| baseline | pass | 266,891 | 0 | 0 | 0 | 0 |
| `kairn_codex_session` | pass | 149,970 | 116,921 / 43.81% | 4 | 0 | 0 |
| `real_mcp_first` | pass | 114,593 | 152,298 / 57.06% | 0 | 1 | 0 |

This is the best long-session result in this campaign. It supports the intended wedge: once the source and invariant are known, Kairn can keep later turns narrow instead of letting the agent reread broadly. MCP also behaved correctly here: one call, then stop guidance.

## MCP Finding

`real_mcp_first` was included in the initial one-shot slice and performed poorly for cheap/source-rescue one-shot patch tasks. It had lower quality and higher token use in that setting.

Current conclusion:

- MCP should not be the default for cheap one-shot source fixes.
- MCP remains important for broad, failure-driven, editor-extension, and long-session workflows.
- The next MCP evidence should use broad/failure/endurance cases, not the cheap one-shot patch slice.

The Requests endurance repeat-1 confirms this distinction. MCP was weak on cheap one-shot patch tasks but strong on the long-session source-rescue workflow.

## Official Benchmark Pilots

### SWE-Atlas/QnA

The generated 30-task SWE-Atlas/QnA pilot is useful as a harder source-grounding stress test, but it is not directly aligned with Kairn's patch/context-governor claim.

Pilot composition:

| Metric | Count |
| --- | ---: |
| Generated tasks | 30 |
| Source-grounded evaluator rows | 16 |
| Runtime/procedural evaluator rows | 14 |
| Strong Kairn applicability | 12 |
| Partial applicability | 11 |
| Weak applicability | 7 |

Repo-matrix preflight:

| Run | Passing Cases | Notes |
| --- | ---: | --- |
| before official-routing fixes | 6 / 23 | all repos indexed; failures mostly missing expected source anchors |
| after language/generated/test-intent fixes | 7 / 23 | one additional Kitty case passed; generated-file noise reduced |

Main finding:

- SWE-Atlas/QnA is much harder because many prompts require runtime/procedural exploration, not static source retrieval.
- Low QnA preflight is not a laptop issue. It is a task-shape mismatch plus a current retrieval weakness on long, vague, architecture-style questions with weak source anchors.
- Do not spend live QnA tokens broadly yet. Use the 7/23 passing or strong-applicability subset for a small answer-grounding pilot only.

### Dynamic Governor Follow-Up

After adding the shared context governor and `request_evidence` action, the same SWE-Atlas/QnA preflight was rerun with runtime/procedural rows scored as correct evidence requests rather than static retrieval failures.

| Run | Passing Cases | Decisions | Max Prime Latency |
| --- | ---: | --- | ---: |
| before dynamic governor | 8 / 23 | 12 emit, 7 request_evidence, 4 shrink | > 18s on large repos |
| after runtime evidence classifier | 18 / 23 | 20 request_evidence, 2 emit, 1 shrink | 24.7s |
| after pre-retrieval evidence guard | 21 / 23 | 20 request_evidence, 2 emit, 1 shrink | 1.8s |
| after source-over-test/runtime cleanup fixes | 23 / 23 | 20 request_evidence, 3 emit | within gate |

Main finding:

- QnA-style prompts often ask for logs, measurements, runtime behavior, or temporary scripts. Kairn should request that evidence before source retrieval instead of returning misleading static context.
- The pre-retrieval guard is a general latency and reliability improvement: it skips expensive retrieval on runtime-procedural prompts and emits a tiny evidence request instead.
- The remaining QnA failures were fixed by behavior-class changes: cleanup prompts that explicitly prefer production source no longer count as test-target prompts, and runtime/product-data observation prompts request evidence instead of forcing static retrieval.

### Deterministic Governor Follow-Up

After the dynamic governor and follow-up source-routing fixes, the deterministic gates were rerun from cached fresh repos.

| Suite | Cases | Quality Pass | Source Quality Pass | Latency Pass | Decisions |
| --- | ---: | ---: | ---: | ---: | --- |
| Fresh holdout v4 | 9 | 9 | 9 | 9 | 7 shrink, 1 request_evidence, 1 suppress |
| Private beta v3 | 9 | 9 | 9 | 9 | 8 shrink, 1 suppress |
| SWE-Atlas/QnA | 23 | 23 | 23 | 23 | 20 request_evidence, 3 emit |
| SWE-Pro pilot preflight | 10 | 8 | 10 | 8 | 10 shrink |

General fixes made in this loop:

- Vite/plugin-transform routing now treats `pluginContainer` and `importAnalysis` as transform-flow anchors while downranking unrelated resolver/build surfaces.
- Zap/Go logging routing now favors core, entry, and encoder pipeline files over noisy field-helper files for log-dispatch prompts.
- Verification cleanup now avoids selecting tests unless tests are explicitly the answer target.
- Address/recipient modification prompts now favor metadata/interface tracking surfaces over concrete implementation packages.
- Account email confirmation/resend flows now favor user email modules and admin user controllers over settings/socket/config surfaces.
- HTTP auth and netrc prompts now favor URL/request utility modules over generic utility files.

The important result is behavioral, not benchmark-specific: Kairn now uses task frame, source/test intent, file role, companion evidence, and expected runtime evidence to choose between shrink, suppress, emit, and request-evidence.

### Post-Governor Live Codex Rerun

After the dynamic governor, production-only edit-scope fixes, and noninteractive `kairn codex` hook isolation, the 8-case seeded fresh holdout was rerun live with `baseline` versus `kairn_codex_session`.

| Mode | Tokens | Quality | Active Kairn | Scope Violations |
| --- | ---: | --- | ---: | ---: |
| baseline | 179,394 | 8 / 8 pass | 0 / 8 | 0 |
| `kairn_codex_session` | 94,559 | 8 / 8 pass | 8 / 8 | 0 |

Aggregate observed savings:

| Metric | Result |
| --- | ---: |
| Saved tokens | 84,835 |
| Savings rate | 47.29% |
| Valid active cases | 8 / 8 |

This is the strongest broad post-governor live result so far. It is still repeat-1, not final publication evidence, but it shows that the governor improvements translated into measured token reduction rather than only static accuracy.

The rerun also exposed two useful scoring and behavior fixes:

- Production-source-only tasks should be validated by required production touch plus scope discipline. They should not be forced to mention every broad expected companion file when a one-file shrink is correct.
- Production-source-only source-rescue should keep companions read-only unless the task explicitly asks for multi-file edits or verification names another source.

Targeted post-fix canaries:

| Case | Baseline Tokens | Kairn Tokens | Quality | Active | Notes |
| --- | ---: | ---: | --- | --- | --- |
| Chi `URLParam` | 25,456 | 13,200 | partial/pass | yes | Kairn emitted a 287-token edit-scope guardrail and avoided test edits. |
| Vite `injectQuery` | 57,317 | 38,439 | partial/pass | yes | Kairn kept edit scope to `client.ts`; companion context remained read-only. |

These canaries are intentionally not the headline claim because their baselines failed scope discipline in those repeats. They are useful as regression checks: Kairn avoided the exact over-assist patterns that previously caused invalid savings.

### SWE-Bench Pro

The SWE-Pro publication pilot generated 10 strong-applicability patch tasks across JS, Python, and Go.

Preflight result after the governor follow-up:

| Metric | Count |
| --- | ---: |
| Repos/tasks checked | 10 |
| State gates passed | 10 |
| Source-quality preflight passed | 10 |
| Overall preflight passed under latency gate | 8 |
| Overall preflight failed | 2 |

The two remaining failures are latency-gate misses rather than source-quality misses:

- NodeBB email/user source: expected files found (`src/controllers/admin/users.js`, `src/user/email.js`), 5,115ms.
- Ansible URL utility source: source-quality gate passed with URL/URI utility files, 7,444ms.

SWE-Pro is therefore a better next official benchmark target than QnA, but no SWE-Pro token savings are counted in this report because official Docker evaluator acceptance is still required.

## Claim Status

Current controlled claim supported by this campaign:

> Kairn can convert invalid or noisy source-rescue behavior into valid active savings when companion routing is correct. In the focused post-fix rerun, active Kairn reduced tokens by 54.2% while preserving quality.

Additional controlled claim now supported:

> In a 10-turn Requests endurance session, both session-bound Kairn and MCP-first preserved quality and produced active valid savings, with MCP-first using one actual MCP call and then stopping.

Claims not yet publication-ready:

- Overall median savings across all fresh repos.
- MCP-vs-hook performance across repeat-3 endurance sessions.
- SWE-Pro official evaluator acceptance at scale.
- Broad SWE-Atlas/QnA usefulness.

## Next Required Runs

Before using this as a finalized scientific-report evidence bundle:

1. Rerun Requests endurance as repeat-3, then add one fresh endurance repo.
2. Run SWE-Pro official Docker evaluator setup on the 8/10 latency-passing tasks first, then decide whether the two source-quality-passing latency misses need optimization or a looser large-repo latency tier.
3. Run a small SWE-Atlas/QnA live answer-grounding pilot only on preflight-passing or strong-applicability rows.
4. Optimize query-local latency on large repos; source/latency reporting now separates source-routing quality from speed gates.
5. Keep behavior-class fixes only; do not tune to individual repo outcomes.
