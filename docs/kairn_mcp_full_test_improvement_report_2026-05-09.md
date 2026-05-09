# Kairn MCP Full Test Improvement Report

Date: 2026-05-09

## Summary

The MCP integration is mechanically working again. With the corrected noninteractive Codex command shape, MCP modes now record actual Kairn MCP tool calls instead of only mentioning Kairn in text.

The results are mixed by language and task:

- Python Click: hybrid MCP-brief was excellent and quality-preserving, saving `55.76%` observed Codex tokens.
- C++ fmt: all Kairn modes preserved quality, but every Kairn mode used more tokens than baseline.
- TypeScript TanStack: Kairn modes reduced tokens and recorded MCP calls, but all modes failed verification, so every token reduction is invalid savings.
- Java Commons Lang: baseline and hook full-prime passed, but MCP modes failed verification despite recording actual MCP calls.

The headline finding is not "MCP is better" or "hooks are better." The finding is sharper: MCP works when it stays focused, but Kairn still needs stronger value gating and response discipline so it does not spend tokens on tasks Codex already handles cheaply.

## Test Setup

Runnable cases:

- `python-click-term-len-ansi`
- `cpp-fmt-starts-with`
- `typescript-tanstack-hidden-hash`
- `java-commons-lang-isblank`

Modes:

- `baseline`
- `hook_full_prime`
- `real_mcp_first`
- `hybrid_mcp_brief`

Important command detail:

```bash
codex -a never exec --model gpt-5.4-mini --sandbox danger-full-access ...
```

This was required for noninteractive Codex MCP proof runs. Under `--sandbox workspace-write`, Codex could see the Kairn MCP server but cancelled tool calls before Kairn received them. `danger-full-access` is only appropriate for disposable benchmark clones, not normal user workflows.

Raw result files:

- `/tmp/kairn-full-proof-python-mcp-20260508235928.json`
- `/tmp/kairn-full-proof-cpp-mcp-20260509000333.json`
- `/tmp/kairn-full-proof-typescript-mcp-20260509000715.json`
- `/tmp/kairn-java-quick-proof-20260509002319.json`

## Results

### Python Click

Case: `term_len` should ignore ANSI escape codes.

| Mode | Outcome | Quality | Tokens | Delta vs Baseline | MCP Calls | Hook Calls | Required Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline | pass | pass | `35,406` | baseline | `0` | `0` | yes |
| Hook full-prime | pass | pass | `55,767` | `-57.51%` | `0` | `1` | yes |
| Real MCP-first | pass | pass | `23,679` | `+33.12%` | `2` | `0` | yes |
| Hybrid MCP-brief | pass | pass | `15,663` | `+55.76%` | `2` | `1` | yes |

MCP returned files:

- `src/click/_termui_impl.py`
- `src/click/_compat.py`

Interpretation:

- MCP is now genuinely being called.
- Hybrid MCP-brief produced the strongest valid result.
- Hook full-prime made Codex use much more context despite a small `575` token prime. This is strong evidence that full-prime hooks should not be unconditional.
- The good pattern here was a small hook plus focused MCP retrieval over two relevant Python files.

### C++ fmt

Case: `basic_string_view::starts_with` should return true for an equal-length identical prefix.

| Mode | Outcome | Quality | Tokens | Delta vs Baseline | MCP Calls | Hook Calls | Required Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline | pass | pass | `15,032` | baseline | `0` | `0` | yes |
| Hook full-prime | pass | pass | `20,605` | `-37.07%` | `0` | `1` | yes |
| Real MCP-first | pass | pass | `16,863` | `-12.18%` | `4` | `0` | yes |
| Hybrid MCP-brief | pass | pass | `36,429` | `-142.34%` | `3` | `1` | yes |

Real MCP-first returned:

- `include/fmt/base.h`
- 20 test files, including broad `test/*` and fuzzing files.

Hybrid returned:

- `include/fmt/base.h`
- `include/fmt/format-inl.h`
- `src/os.cc`
- additional broad headers/tests.

Interpretation:

- Quality passed, but all Kairn modes were net negative on observed tokens.
- Baseline Codex solved this small C++ fix very efficiently.
- MCP returned too much test/file fanout for a task with a precise production header target.
- Hybrid was worst because it combined a prompt hook with broad MCP follow-up.

### TypeScript TanStack

Case: object query keys with the same properties in different orders should hash consistently.

| Mode | Outcome | Quality | Tokens | Token Delta vs Baseline | MCP Calls | Hook Calls | Required Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline | fail | fail | `50,333` | baseline | `0` | `0` | yes |
| Hook full-prime | fail | fail | `19,762` | invalid `+60.74%` | `0` | `1` | yes |
| Real MCP-first | fail | fail | `29,072` | invalid `+42.24%` | `2` | `0` | yes |
| Hybrid MCP-brief | fail | fail | `26,453` | invalid `+47.44%` | `3` | `1` | yes |

MCP evidence:

- `real_mcp_first` returned `packages/query-core/src/utils.ts` and `packages/query-core/src/types.ts`.
- `hybrid_mcp_brief` returned `packages/query-core/src/utils.ts`, but also noisy `packages/angular-query-experimental/...` and `packages/query-devtools/...`.

Interpretation:

- MCP is working mechanically for TypeScript too.
- All token reductions are invalid because verification failed with exit `130`.
- The task is still useful for retrieval inspection, but it is not a valid savings proof until the verification command is made reliable or replaced.

### Java Commons Lang

Case: `StringUtils.isBlank` should use Java whitespace semantics.

| Mode | Outcome | Quality | Tokens | Token Delta vs Baseline | MCP Calls | Hook Calls | Required Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Baseline | pass | pass | `16,428` | baseline | `0` | `0` | yes |
| Hook full-prime | pass | pass | `23,134` | `-40.82%` | `0` | `1` | yes |
| Real MCP-first | fail | fail | `13,734` | invalid `+16.40%` | `4` | `0` | yes |
| Hybrid MCP-brief | fail | fail | `20,677` | invalid `-25.86%` | `5` | `1` | yes |

MCP returned:

- `src/main/java/org/apache/commons/lang3/StringUtils.java`
- `src/test/java/org/apache/commons/lang3/StringUtilsEmptyBlankTest.java`
- Broad neighboring production classes such as `Validate.java`, `CharUtils.java`, `CharRange.java`, `BooleanUtils.java`, `ObjectUtils.java`, and more.

Interpretation:

- Java is now runnable locally with JDK 17 and Maven.
- MCP mechanically worked and recorded actual calls.
- MCP retrieved the expected source file, but expanded into too many neighboring utility classes.
- The MCP modes failed verification, so the apparent token reduction in `real_mcp_first` is invalid savings.
- This matches the C++ failure pattern: when the expected source file is already known, broad expansion can make Codex worse.

## Cross-Case Findings

### 1. MCP Is Back

All MCP-enabled runnable cases recorded actual Kairn MCP calls:

- Python real MCP-first: `2`
- Python hybrid: `2`
- C++ real MCP-first: `4`
- C++ hybrid: `3`
- TypeScript real MCP-first: `2`
- TypeScript hybrid: `3`
- Java real MCP-first: `4`
- Java hybrid: `5`

This resolves the previous `actualMcpToolCalls = 0` blocker.

### 2. Focused MCP Can Beat Baseline

Python hybrid was the best result:

- Quality passed.
- Required source was touched.
- MCP returned only two relevant files.
- Observed tokens dropped from `35,406` to `15,663`.

This is the shape Kairn should optimize for.

### 3. Broad MCP Fanout Is Expensive

C++ and Java show the clearest failure pattern:

- The expected source file was correct.
- MCP then returned too many tests and related files.
- Codex spent more tokens despite having the right file.

Kairn needs to treat "found exact source" as a reason to stop expanding, not as permission to return a broad neighborhood.

### 4. Hook Full-Prime Is Not Safe As A Universal Default

Hook full-prime was net negative on Python, C++, and Java in this pass:

- Python: `55,767` vs baseline `35,406`
- C++: `20,605` vs baseline `15,032`
- Java: `23,134` vs baseline `16,428`

The prime itself was small, but it likely changed Codex's behavior enough to cause extra exploration. The controller should emit full-prime only when the expected value is high, and otherwise shrink or suppress.

### 5. TypeScript Proof Needs Replacement Or Repair

The TanStack case repeatedly reaches the expected source file but fails verification with exit `130`. It should not be used for headline token claims. It can remain a retrieval stress test, but the savings proof suite needs a deterministic TypeScript case with reliable verification.

## Improvement Plan

### Priority 1: Stop Expanding After Exact Source Hits

When Kairn finds a high-confidence exact source file and the task is a small single-bug fix:

- Return one primary source file.
- Return one exact symbol/snippet.
- Return at most one verification command.
- Do not return broad test fanout unless the prompt explicitly asks for tests or the failure output names tests.

This targets the C++ failure directly and should generalize to Java/Python/TypeScript.

### Priority 2: Make Full-Prime Hook Truly Adaptive

Update the context controller:

- `emit`: only for high-confidence, multi-file, failure-heavy, or large-repo tasks.
- `shrink`: for exact source/symbol hits where one-file context is enough.
- `suppress`: for small precise tasks where Codex is likely cheaper unaided.

The C++ case should likely shrink or suppress. The Python case should prefer hybrid MCP-brief over full-prime.

### Priority 3: Tighten MCP Compact Responses

`kairn_prepare_task` and `kairn_get_next_context` should enforce stricter limits:

- One primary file.
- One fallback file only if confidence gap is low.
- One likely test/check.
- No broad `test/*` fanout.
- No docs/examples/devtools unless explicitly requested.

The C++ MCP response returning 20 tests is the clearest current waste.

### Priority 4: Add MCP Returned-File Quality Metrics

Benchmark reports should include:

- `mcpReturnedFileCount`
- `mcpReturnedExpectedFileCount`
- `mcpReturnedNoiseFileCount`
- `mcpReturnedTestFanoutCount`
- `mcpContextEfficiency = expected/relevant files per returned file`

Right now the raw metadata exposes this, but the report should make it impossible to miss.

### Priority 5: Replace The TypeScript Savings Proof

Create a smaller deterministic TypeScript seeded case:

- Use a repo with a fast test command.
- Require one production source file.
- Avoid package-manager/test-runner behavior that exits with `130`.

Keep TanStack as a retrieval stress case, not as the primary TypeScript savings proof.

### Priority 6: Add Java Validation Environment Or Skip Policy

Either install Maven for Java proof runs or mark Java as preflight-skipped with a clear report row. The test matrix should not silently omit a language.

## Product Direction

Current best path:

- Keep hook-only savings available, but do not treat full-prime hook as universally safe.
- Continue investing in hybrid MCP-brief because it produced the best Python result and uses actual MCP calls.
- Make MCP/hybrid conditional: when MCP retrieves a focused one-file/two-file context, it can be excellent; when it fans out broadly, it loses.

The next product-level goal should be:

> Kairn should abstain or shrink unless it can provide a focused, high-confidence context packet smaller than what Codex would discover on its own.

## Post-Focused Context Validation

After implementing exact-source focused delivery, adaptive full-prime behavior, tighter MCP compact responses, MCP returned-file quality metrics, and the TanStack source-invariant proof, verification passed:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

Live proof artifacts:

- Python only: `/tmp/kairn-python-proof-20260509.json`
- TypeScript/Java/C++: `/tmp/kairn-cross-minus-python-proof-20260509.json`

### Python Regression Check

The Python Click case did not regress on quality. Every mode passed verification and touched `src/click/_compat.py`.

| Mode | Tokens | Quality | MCP calls | MCP files | MCP test fanout | Result |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| baseline | `26,860` | pass | `0` | `0` | `0` | control |
| hook_full_prime | `25,270` | pass | `0` | `0` | `0` | `5.9%` valid savings |
| real_mcp_first | `16,057` | pass | `2` | `2` | `0` | `40.2%` valid savings |
| hybrid_mcp_brief | `32,655` | pass | `6` | `21` | `11` | `21.6%` regression |

Conclusion: Python quality is intact. The best Python path is now `real_mcp_first`, not hybrid. Hybrid regressed because MCP still allowed repeated follow-up expansion into tests after the correct source file was found.

### TypeScript, Java, And C++

The remaining seeded cases were run separately to avoid repeating Python. `hook_full_prime` passed all quality gates and produced the strongest aggregate savings.

| Mode | Aggregate Tokens | Quality | Valid Savings |
| --- | ---: | --- | ---: |
| baseline | `83,937` | pass | control |
| hook_full_prime | `38,334` | pass | `54.3%` |
| real_mcp_first | `60,132` | fail | invalid, Java failed verification |
| hybrid_mcp_brief | `50,976` | fail | invalid, Java failed verification |

Case-level results:

| Case | Baseline | hook_full_prime | real_mcp_first | hybrid_mcp_brief |
| --- | ---: | ---: | ---: | ---: |
| TypeScript TanStack | `44,266` pass | `24,450` pass | `25,198` pass, noisy MCP | `23,564` pass, noisy MCP |
| Java Commons Lang | `16,135` pass | `9,188` pass | `18,274` fail | `16,493` fail |
| C++ fmt | `23,536` pass | `4,696` pass | `16,660` pass | `10,919` pass |

Key findings:

- The focused-context change materially improved `hook_full_prime` on TypeScript, Java, and C++.
- C++ improved dramatically: `23,536` baseline to `4,696` with hook full-prime while preserving quality.
- Java also improved under hook full-prime: `16,135` baseline to `9,188`, with verification passing.
- MCP is mechanically working, but still not safe as a default. Java MCP modes touched the required source but failed verification, so those token reductions are invalid evidence.
- MCP returned-file quality metrics are useful: TypeScript hybrid still returned one noisy `query-devtools` file, and Python hybrid returned `21` files with `11` test fanout files.

### Updated Direction

The current default recommendation should be:

- Keep `hook_full_prime` as the default savings path for now, because the focused controller made it quality-preserving and strongly positive on TS/Java/C++.
- Keep `real_mcp_first` experimental but promising, especially for Python where it produced `40.2%` valid savings with only two returned files.
- Do not promote hybrid yet. Hybrid only wins when MCP remains focused; when it triggers repeated MCP follow-ups, it loses or fails quality gates.
- Next improvement should make MCP stop after exact source hits across all follow-up tools, not just initial `kairn_prepare_task`.

## MCP Exact-Source Follow-Up Gate

Implemented after the validation above:

- Exact-source hits are now tracked in coordination state.
- `kairn_find_context` stays focused after an exact source hit instead of reopening broad retrieval.
- `kairn_get_related_files` returns focused guidance instead of graph/test neighborhood expansion after an exact source hit.
- `kairn_get_next_context` avoids files already returned by hooks or MCP and returns no new file when the exact source has already been supplied.
- `kairn_get_failure_context` skips broad related/test expansion when MCP already has an exact source focus.
- MCP metrics now preserve `contextDecision` metadata so later calls can see exact-source state.

Verification:

- `pnpm test`: `125` tests passed
- `pnpm typecheck`: passed
- `pnpm build`: passed

## Expanded Repo Matrix And Large-Repo Source-Invariant Proof

New artifacts:

- Expanded preflight matrix: `examples/bench/repo-matrix-expanded.json`
- New live proof suite: `examples/bench/seeded-large-repos-source-invariant.json`
- Next seed patch: `examples/bench/patches/next-is-local-url-relative.patch`
- Django seed patch: `examples/bench/patches/django-slugify-allow-unicode.patch`
- Live proof JSON: `/tmp/kairn-large-repos-source-proof-20260509.json`

### Expanded Matrix Results

The expanded matrix tested local Kairn, the portfolio job tracker, Next.js, Django, Starlette, Express, Spring PetClinic, and fmt.

Aggregate:

- Repos: `8`
- Passing repos: `3`
- Failing repos: `5`
- Cases: `9`
- Quality-passing cases: `4`
- State-passing repos: `8`

State stayed bounded across the matrix:

| Repo | State | Result | Main finding |
| --- | ---: | --- | --- |
| Kairn local | `39.82MB` | fail | Returned `KairnRuntime.ts` but missed `src/server/mcp.ts` for MCP follow-up quality. |
| Portfolio job tracker | `38.22MB` | fail | Returned `JobsApplicationsTable.tsx` first but missed `JobsDashboardTabs.tsx` in top 5. |
| Next.js | `84.09MB` | pass | Correctly ranked `is-local-url.ts` first. |
| Django | `70.25MB` | pass | Correctly ranked `django/utils/text.py` first. |
| Starlette | `33.72MB` | fail | Returned `routing.py` but missed `convertors.py`. |
| Express | `19.56MB` | fail | Returned `lib/router/index.js` but missed `lib/router/route.js`. |
| Spring PetClinic | `14.47MB` | fail | Returned `OwnerController.java` but missed `OwnerRepository.java`. |
| fmt | `38.77MB` | pass | Correctly ranked `include/fmt/base.h` first. |

Interpretation:

- The tiered/state work is doing its job: large repos did not produce runaway `.kairn` state.
- The remaining general problem is multi-file recall. Kairn is strong when there is one precise implementation target, but it often under-recovers companion files for controller/repository, router/route, and routing/convertor tasks.
- This is a general retrieval issue, not a Next- or Django-specific issue.

### Large-Repo Live Proof

Modes tested:

- `baseline`
- `hook_full_prime`
- `real_mcp_first`
- `hybrid_mcp_brief`

Cases:

- Next.js `is-local-url.ts` relative URL regression.
- Django `slugify(..., allow_unicode=True)` Unicode-preservation regression.

Case-level results:

| Mode | Next | Django | Total tokens | Notes |
| --- | --- | --- | ---: | --- |
| baseline | `43,623` pass | `29,343` partial | `72,966` | Django touched an excluded test file, so quality was partial. |
| hook_full_prime | `38,056` fail | `11,667` pass | `49,723` | Token reduction is not valid overall because Next verification failed. |
| real_mcp_first | `43,552` pass, `2` MCP calls | `13,768` pass, `3` MCP calls | `57,320` | Quality passed both cases, but Django MCP still returned broad/noisy context. |
| hybrid_mcp_brief | `52,326` pass, `1` MCP call | `25,576` pass, `4` MCP calls | `77,902` | Quality passed, but tokens increased versus baseline. |

Latency attribution worked:

- Next baseline agent time: `79.1s`
- Next hook agent time: `56.1s`, setup/index time: `17.5s`
- Next MCP agent time: `91.7s`, setup/index time: `17.5s`
- Django baseline agent time: `78.3s`
- Django hook agent time: `24.9s`, setup/index time: `11.2s`
- Django MCP agent time: `58.2s`, setup/index time: `11.0s`

Quality findings:

- `real_mcp_first` was the strongest valid mode in this two-case run: both cases passed, expected source files were touched, and actual MCP calls were recorded.
- `hook_full_prime` showed why strict quality gates matter. It reduced tokens overall, but failed the Next source-invariant check. The agent edited the correct file, but replaced the exact helper behavior with a different implementation that did not restore the required invariant.
- `hybrid_mcp_brief` is still not justified as a default: it passed quality but increased tokens by `7%`.
- MCP returned-file quality metrics caught the Django MCP weakness: `11` returned files, `10` test files, `6` noisy files, and context efficiency `0.0909`.

### Updated Direction From The New Repos

The next improvement should focus on general patterns rather than repo-specific tuning:

- Improve multi-file recall when the task naturally has paired implementation surfaces: controller/repository, router/route, route/convertor, UI table/tabs.
- Keep exact-source discipline for single-file utility/debug tasks, because it is working across Next, Django, and fmt.
- Add a "companion file" retrieval stage with strict caps, not broad graph fanout.
- Make hook full-prime use the exact-source evidence packet more directly. The Next failure shows that correct file targeting is not enough; the brief must preserve the key behavioral invariant.
- Keep MCP as a serious candidate for large repos, but only when returned-file quality is high and actual MCP calls are recorded.

Expected impact for the next live proof:

- Python `real_mcp_first` should preserve its focused two-file pattern.
- Java MCP modes should stop returning 10+ tests after `StringUtils.java` is identified.
- Hybrid should improve only if Codex follows the MCP guidance without repeatedly asking for broad search.

## Post-Gate Live Proof

Fresh live proof artifact:

- `/tmp/kairn-full-proof-after-mcp-gate-20260509.json`

Modes:

- `baseline`
- `hook_full_prime`
- `real_mcp_first`
- `hybrid_mcp_brief`

### Aggregate

| Mode | Tokens | Quality | Savings |
| --- | ---: | --- | ---: |
| baseline | `110,422` | pass | control |
| hook_full_prime | `83,210` | pass | `24.6%` valid |
| real_mcp_first | `96,674` | fail | invalid, Java failed |
| hybrid_mcp_brief | `83,812` | fail | invalid, Java failed |

### Case Results

| Case | Baseline | hook_full_prime | real_mcp_first | hybrid_mcp_brief |
| --- | ---: | ---: | ---: | ---: |
| TypeScript TanStack | `37,466` pass | `22,204` pass | `22,534` pass, `11` MCP files / `10` tests | `23,090` pass, `1` MCP file |
| Python Click | `31,243` pass | `16,145` pass | `25,121` pass, `1` MCP file | `26,465` pass, `1` MCP file |
| Java Commons Lang | `28,164` pass | `37,378` pass | `22,023` fail, `1` MCP file | `19,811` fail, `1` MCP file |
| C++ fmt | `13,549` pass | `7,483` pass | `26,996` pass, `1` MCP file | `14,446` pass, `1` MCP file |

### Interpretation

- The exact-source MCP follow-up gate worked mechanically for Python, Java, C++, and hybrid TypeScript: MCP returned one file and zero test fanout in those paths.
- TypeScript `real_mcp_first` still produced fanout: `11` MCP files and `10` tests. That suggests the exact-source state was not established early enough in that path, or a later MCP tool returned tests before the gate had source focus.
- `hook_full_prime` remained the only mode with all quality gates passing across all four languages, but its aggregate savings dropped from the previous run to `24.6%`.
- Java is the blocker for MCP/hybrid promotion. The MCP modes used the expected file and avoided fanout, but still failed verification. That means the issue is no longer just broad context; MCP guidance may be too sparse or may be steering Codex toward an incomplete edit.
- C++ hybrid is close to neutral but still not better than hook full-prime. C++ real MCP-first regressed badly despite one-file MCP output, likely because Codex spent more time reasoning/tooling around the sparse MCP path.

### Next Improvement From This Proof

The next MCP improvement should not simply reduce returned files further. It should add a small exact-source evidence packet:

- one source file,
- one exact symbol/function,
- one minimal snippet around the likely edit,
- one verification command,
- no related/test fanout unless explicitly requested.

This keeps the gate's discipline while giving Codex enough concrete evidence to avoid under-solving Java and over-reasoning in C++.

## Exact-Source Evidence Packet

Implemented after the post-gate proof:

- Compact `kairn_prepare_task` now includes `exactSourceEvidence` for high-confidence exact-source hits.
- The evidence packet contains:
  - `file`
  - `symbol`
  - `lines`
  - `snippet`
  - `expectedBehavior`
  - `verificationCommand`
- Exact-source follow-up context now returns the same focused evidence shape in prose instead of only saying "stay focused."
- The symbol selector prefers task identifiers that appear as callable code in the snippet, so C++ cases surface `starts_with` instead of only the enclosing class.
- Related-file/test fanout remains suppressed after exact-source hits.

Verification:

- `pnpm test`: `125` tests passed
- `pnpm typecheck`: passed
- `pnpm build`: passed
