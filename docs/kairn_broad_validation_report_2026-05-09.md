# Kairn Broad Validation Report - 2026-05-09

## Summary

This pass tested Kairn across deterministic repo-matrix preflight, one-shot live Codex proofs, and one short endurance proof.

The result is honest but useful:

- Kairn's **state discipline is now working**. Large and medium repos stayed under the configured state gates.
- Kairn's **exact-source retrieval is strong** across TypeScript, Python, Java, and C++.
- Kairn's **automatic one-shot assistance currently over-assists on aggregate** against modern Codex. Baseline Codex is already very efficient on small seeded source bugs.
- Kairn's most repeated weakness is **companion-file recall** for multi-surface framework tasks.
- Endurance remains the right long-session thesis, but the latest Flask endurance run failed quality in both baseline and Kairn modes, so it is not a savings claim.

Token savings below only count when quality passes, required production files are touched, unrelated files are avoided, and Kairn was actually active.

## Artifacts

- Core preflight: `/tmp/kairn-broad-validation-core-20260509.json`
- Generalization preflight: `/tmp/kairn-broad-validation-generalization-20260509.json`
- Expanded preflight: `/tmp/kairn-broad-validation-expanded-20260509.json`
- Cross-language live proof: `/tmp/kairn-broad-live-cross-language-20260509.json`
- Fresh-repo live proof: `/tmp/kairn-broad-live-new-repos-20260509.json`
- Flask endurance proof: `/tmp/kairn-broad-endurance-flask-20260509.json`

## Preflight Results

| Matrix | Repos | Passing repos | Cases | Passing cases | State gate | Main finding |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Core | 5 | 5 | 5 | 5 | 5/5 | Exact-source and weak-signal suppression passed. |
| Generalization | 9 | 5 | 9 | 5 | 9/9 | Companion routing failed on pytest, Axios, Gin, and chi. |
| Expanded | 8 | 3 | 9 | 4 | 8/8 | Large state stayed bounded; companion misses repeated. |

State stayed bounded. The largest observed preflight state was under `100MB` in this run, far below the earlier multi-GB failure mode.

### Passing Preflight Signals

| Repo | Language | Size | Task type | Decision | Top source result |
| --- | --- | --- | --- | --- | --- |
| TanStack Query | TypeScript | large | exact source bug | shrink | `packages/query-core/src/utils.ts` |
| Click | Python | medium | exact source bug | shrink | `src/click/_compat.py` |
| Commons Lang | Java | large | exact source bug | shrink | `StringUtils.java` |
| fmt | C++ | medium | exact source bug | shrink | `include/fmt/base.h` |
| Weak signal control | mixed | medium | vague prompt | suppress | none |
| FastAPI | Python | large | routing/dependency companion | emit | `routing.py`, `dependencies/utils.py` |
| Vue Core | TypeScript | large | scheduler/renderer companion | emit | `scheduler.ts`, `renderer.ts` |
| Flask | Python | medium | app/context companion | emit | `app.py`, `ctx.py` |
| NestJS | TypeScript | large | router execution companion | emit | router execution/proxy/response files |
| Commons IO | Java | medium | utility/IOCase companion | emit | `FilenameUtils.java`, `IOCase.java` |
| Next.js | TypeScript | huge | exact source bug | shrink | `is-local-url.ts` |
| Django | Python | large | exact source bug | shrink | `django/utils/text.py` |

### Failed Preflight Patterns

| Repo | Language | Failed task | Pattern |
| --- | --- | --- | --- |
| pytest | Python | fixture resolution | Suppressed when fixture/python companion files were expected. |
| Axios | JavaScript | interceptor/dispatch | Suppressed on a multi-file source task. |
| Gin | Go | router group/context | Universal retrieval does not yet understand Go package companions well enough. |
| chi | Go | middleware/router context | Same Go companion weakness. |
| Kairn local | TypeScript | MCP follow-up quality | Found `KairnRuntime.ts` but missed `server/mcp.ts`. |
| Portfolio | TypeScript app | mobile layout | Found table UI but missed dashboard tabs companion. |
| Starlette | Python | route matching/convertors | Found routing but missed convertors companion. |
| Express | JavaScript | router param dispatch | Suppressed instead of returning router files. |
| Spring PetClinic | Java app | controller/repository | Found controller family but missed repository companion. |

The repeated failure is not repo-specific. It is a general companion-routing problem: Kairn can find the primary file, but often misses the second surface the task needs.

## One-Shot Live Proofs

### Cross-Language Exact-Source Suite

| Mode | Quality | Tokens | Delta vs baseline | Assist classification |
| --- | --- | ---: | ---: | --- |
| baseline | pass | `131,260` | control | baseline |
| hook full-prime | pass | `157,839` | `-20.25%` | over_assist |
| real MCP-first | fail | `169,445` | `-29.09%` | harmful_invalid_assist |
| hybrid MCP-brief | fail | `135,122` | `-2.94%` | harmful_invalid_assist |

Per-case valid wins:

| Case | Best Kairn mode | Baseline | Best Kairn | Valid savings | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| TanStack hidden hash | none | `32,408` | n/a | none | All Kairn modes used more tokens. |
| Click `term_len` | hook full-prime | `32,410` | `24,390` | `24.74%` | Good focused Python win. |
| Commons Lang `isBlank` | hook full-prime | `40,523` | `37,453` | `7.58%` | Small valid Java win. |
| fmt `starts_with` | hybrid MCP-brief | `25,919` | `22,432` | `13.45%` | Hybrid won C++, but aggregate quality failed because Java failed in hybrid. |

Conclusion: exact-source bugs are not where Kairn reliably beats Codex on aggregate. Codex already finds these quickly.

### Fresh Framework/App-Style Suite

| Mode | Quality | Tokens | Delta vs baseline | Assist classification |
| --- | --- | ---: | ---: | --- |
| baseline | pass | `79,020` | control | baseline |
| hook full-prime | pass | `91,791` | `-16.16%` | over_assist |
| real MCP-first | pass | `83,638` | `-5.84%` | over_assist |
| hybrid MCP-brief | pass | `107,066` | `-35.49%` | over_assist |

Per-case valid wins:

| Case | Best Kairn mode | Baseline | Best Kairn | Valid savings | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| Axios interceptor order | none | `19,035` | n/a | none | Kairn increased tokens in every mode. |
| Flask dispatch request | real MCP-first | `23,627` | `19,531` | `17.34%` | MCP helped when actual MCP calls were recorded. |
| Commons IO filename case | hook full-prime | `36,358` | `24,563` | `32.44%` | Strong Java utility win. |

Conclusion: Kairn has real per-case wins, but current automatic modes are not yet consistently better than baseline across mixed suites.

## Endurance Proof

Suite: Flask dispatch endurance, four turns: diagnose, fix, verify, cleanup.

| Mode | Quality | Tokens | Assistance | Classification |
| --- | --- | ---: | --- | --- |
| baseline | fail | `92,989` | none | baseline failed quality |
| kairn | fail | `88,885` | active, `3` shrink, `1` suppress | harmful_invalid_assist |

Kairn used fewer tokens by `4,104`, but this is **invalid savings** because final verification failed. Baseline also failed quality, so this endurance suite is currently a task/harness stress signal, not a product win.

Important endurance findings:

- Kairn's ledger correctly identified `src/flask/app.py` as the active file and next smallest read.
- Kairn avoided broad full-prime repetition, using shrink/suppress decisions.
- Both baseline and Kairn failed to remove the seeded `return None` invariant, so the task prompt or turn structure needs repair before repeated endurance claims.

## Answers To The Four Questions

### 1. When Does Kairn Help?

So far, Kairn helps most when:

- the task has a moderately expensive source search,
- Kairn has a high-confidence source target,
- the prompt does not already make the fix obvious,
- the mode stays sharp instead of expanding into broad context.

Observed valid wins in this pass:

- Click Python exact-source: `24.74%`
- Commons Lang Java exact-source: `7.58%`
- fmt C++ exact-source under hybrid: `13.45%`
- Flask MCP framework task: `17.34%`
- Commons IO Java utility task: `32.44%`

### 2. When Does Kairn Correctly Stay Silent?

The weak-signal control passed preflight: `make it better` produced `suppress`.

That is a correct abstention pattern. The new reporting layer can now distinguish this from missed opportunities.

### 3. When Does Kairn Hurt?

Kairn hurts when it adds context to tasks Codex already solves cheaply:

- TanStack exact-source: Kairn added tokens in all modes.
- Axios one-shot: Kairn added tokens in all modes.
- Cross-language aggregate hook full-prime: `20.25%` more tokens.
- Fresh-repo aggregate hook full-prime: `16.16%` more tokens.

MCP can also hurt quality:

- Cross-language real MCP-first failed Java despite actual MCP calls.
- Cross-language hybrid failed Java despite lower Java tokens, so lower tokens were negative evidence.

### 4. Which Failure Patterns Repeat?

Repeated patterns:

1. **Companion misses**: router/dependency, controller/repository, routing/convertor, UI table/tabs, Go route/context.
2. **Over-assist on exact-source bugs**: Kairn should shrink harder or suppress when baseline is likely cheap.
3. **MCP tool use is real now, but not always efficient**: actual MCP calls are recorded, but agents sometimes call several tools and still use more tokens.
4. **Endurance task quality is not stable yet**: ledger behavior is useful, but turn prompts need better invariant/check guidance.

## Current Best Product Interpretation

Kairn is not a universal one-shot token saver yet.

The evidence points to a narrower, stronger claim:

> Kairn is useful when it can provide high-confidence, minimal source guidance or when a session gets long enough that avoiding repeated context matters. It should abstain more aggressively on obvious one-file bugs.

The broad report makes the next product direction clear: fewer automatic primes, better companion routing, and stronger long-session/failure-first behavior.

## Next Improvement Priorities

1. **Companion Routing V2**
   - Improve generic role-pair detection for controller/repository, router/route, route/convertor, UI sibling surfaces, Go package companions, and MCP/runtime pairs.
   - This is the most repeated deterministic failure.

2. **Exact-Source Abstention**
   - If Kairn finds one exact production file and no real multi-file signal, default to shrink or suppress.
   - Full-prime should not be the default for cheap exact-source bug fixes.

3. **MCP Efficiency**
   - MCP is mechanically working and actual calls are recorded.
   - It needs a "done, stop asking Kairn" response after enough evidence is returned.
   - Track tokens per MCP call and returned-file usefulness more aggressively.

4. **Endurance Prompt Repair**
   - The Flask endurance suite should be revised so the fix turn gives the invariant directly: remove `return None`, call `self.view_functions[rule.endpoint]`, preserve `ensure_sync`, and keep edits inside `dispatch_request`.
   - Do not run repeat endurance claims until baseline or Kairn can pass at least once.

5. **Abstention Accuracy Metric**
   - Add a report-level score:
     - correct abstention,
     - missed savings opportunity,
     - missed quality opportunity,
     - over-assist,
     - harmful assist.
   - The classification exists now; the next report should aggregate it.

## Recommendation Before More Live Spend

Do not tune from a single live win.

The next implementation should target the repeated deterministic failures first:

- companion routing,
- exact-source abstention,
- MCP stop conditions.

Then rerun:

1. repo-matrix preflight,
2. fresh framework one-shot suite,
3. revised Flask or Commons IO endurance.

