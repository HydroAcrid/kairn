# Kairn Broad Validation Report - 2026-05-09

## Summary

This pass tested Kairn across deterministic repo-matrix preflight, one-shot live Codex proofs, and short multi-turn endurance proofs.

The result is honest but useful:

- Kairn's **state discipline is now working**. Large and medium repos stayed under the configured state gates.
- Kairn's **exact-source retrieval is strong** across TypeScript, Python, Java, and C++.
- Kairn's **automatic one-shot assistance currently over-assists on aggregate** against modern Codex. Baseline Codex is already very efficient on small seeded source bugs.
- Kairn's most repeated weakness is **companion-file recall** for multi-surface framework tasks.
- The repaired endurance path is now the strongest evidence for Kairn's product direction: quality-passing long-session runs saved `50-59%` after post-diagnose source focusing.

Token savings below only count when quality passes, required production files are touched, unrelated files are avoided, and Kairn was actually active.

## Artifacts

- Core preflight: `/tmp/kairn-broad-validation-core-20260509.json`
- Generalization preflight: `/tmp/kairn-broad-validation-generalization-20260509.json`
- Expanded preflight: `/tmp/kairn-broad-validation-expanded-20260509.json`
- Cross-language live proof: `/tmp/kairn-broad-live-cross-language-20260509.json`
- Fresh-repo live proof: `/tmp/kairn-broad-live-new-repos-20260509.json`
- Flask endurance proof: `/tmp/kairn-broad-endurance-flask-20260509.json`
- Repaired Flask endurance proof v1: `/tmp/kairn-endurance-flask-v1.json`
- Repaired Flask endurance proof v2: `/tmp/kairn-endurance-flask-v2.json`
- Commons IO endurance proof: `/tmp/kairn-endurance-commons-io-v1.json`
- Axios endurance proof: `/tmp/kairn-endurance-axios-v1.json`
- Axios post-diagnose focus proof: `/tmp/kairn-endurance-axios-v3.json`
- Flask post-diagnose focus proof: `/tmp/kairn-endurance-flask-v3.json`
- Commons IO post-diagnose focus proof: `/tmp/kairn-endurance-commons-io-v2.json`

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

## Endurance Proofs

### Initial Flask Stress Run

| Mode | Quality | Tokens | Assistance | Classification |
| --- | --- | ---: | --- | --- |
| baseline | fail | `92,989` | none | baseline failed quality |
| kairn | fail | `88,885` | active, `3` shrink, `1` suppress | harmful_invalid_assist |

Kairn used fewer tokens by `4,104`, but this is **invalid savings** because final verification failed. Baseline also failed quality, so this endurance suite is currently a task/harness stress signal, not a product win.

Important endurance findings:

- Kairn's ledger correctly identified `src/flask/app.py` as the active file and next smallest read.
- Kairn avoided broad full-prime repetition, using shrink/suppress decisions.
- Both baseline and Kairn failed to remove the seeded `return None` invariant, so the task prompt or turn structure needs repair before repeated endurance claims.

### Repaired Long-Session Runs

After the harness started recording semantic source invariants, diff-scope checks, passing verification events, and verified-source anchors into the session ledger, the same long-session pattern became a quality-passing product signal.

| Suite | Baseline Tokens | Kairn Tokens | Valid Savings | Quality | Kairn Assistance |
| --- | ---: | ---: | ---: | --- | --- |
| Flask dispatch endurance v1 | `107,208` | `63,994` | `40.31%` | pass/pass | active: `3` shrink, `1` suppress |
| Flask dispatch endurance v2 | `99,737` | `47,216` | `52.66%` | pass/pass | active: `3` shrink, `1` suppress |
| Commons IO filename endurance | `158,869` | `96,479` | `39.27%` | pass/pass | active: `4` shrink |
| Axios interceptor endurance | `114,217` | `71,498` | `37.40%` | pass/pass | active: `2` shrink, `2` suppress, `3` failure contexts |

Per-turn pattern:

| Suite | Turn | Baseline Tokens | Kairn Tokens | Result |
| --- | --- | ---: | ---: | --- |
| Flask v2 | diagnose | `39,133` | `20,399` | Kairn reduced search cost |
| Flask v2 | fix | `16,900` | `8,589` | Kairn kept the edit focused |
| Flask v2 | verify | `26,994` | `14,080` | Kairn reduced verification drift |
| Flask v2 | cleanup | `16,710` | `4,148` | Ledger guidance prevented broad rereads |
| Commons IO | diagnose | `40,871` | `45,595` | Kairn over-assisted on the first turn |
| Commons IO | fix | `21,849` | `20,895` | Small improvement |
| Commons IO | verify | `62,719` | `15,202` | Major long-session win |
| Commons IO | cleanup | `33,430` | `14,787` | Major long-session win |
| Axios | diagnose | `31,393` | `22,543` | Kairn reduced companion discovery cost |
| Axios | fix | `26,180` | `14,163` | Kairn kept the edit focused |
| Axios | verify | `40,750` | `29,504` | Kairn reduced verification cost |
| Axios | cleanup | `15,894` | `5,288` | Ledger/failure context prevented broad rereads |

This is the first clear evidence that the long-session thesis is stronger than the one-shot thesis. Kairn did not win every turn, but it won cumulatively by preventing repeated discovery and broad verification/cleanup scans.

Remaining caveat from this pass: Flask v2 still surfaced neighbor files during one verification turn before the ledger fully anchored on `src/flask/app.py`. That became the next polish target for phase-aware routing.

### Post-Diagnose Source Focus

Kairn then tightened post-diagnose behavior:

- after Kairn has prior session evidence and one active production source, implementation/debugging/verification/cleanup turns shrink to that source,
- real failure-linked files still override the source-focus rule,
- duplicate-context suppression still wins over repeating a focused source,
- shrunk prime formatting now uses the emitted focus file instead of the raw retrieval companion list.

This directly addressed the Axios and Flask issue where Kairn occasionally resurfaced companion files after the active source was already known.

| Suite | Previous Valid Savings | Focused Valid Savings | Quality | Notable Change |
| --- | ---: | ---: | --- | --- |
| Axios interceptor endurance | `37.40%` | `58.56%` | pass/pass | fix turn changed from companions/declarations to `lib/core/Axios.js` |
| Flask dispatch endurance | `52.66%` | `49.83%` | pass/pass | verification turn changed from neighbor files to `src/flask/app.py` |
| Commons IO filename endurance | `39.27%` | `52.72%` | pass/pass | cleanup stayed tightly anchored to `FilenameUtils.java` |

The live-proof variance is still real, but the behavioral change is clear: prime files are now source-focused after diagnosis, and all three suites preserved quality.

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
4. **Endurance task quality became the strongest positive signal after source-invariant and ledger repairs**: Kairn's cumulative wins came mostly from verification and cleanup turns, not from first-turn discovery.

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

4. **Endurance Phase Routing**
   - Verification and cleanup turns should anchor harder on the last passing source-invariant file.
   - Kairn should avoid returning neighbor files once the ledger has a passing verification and no unresolved failure.

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

## Follow-Up: Guardrail Hook Pass

After the broad report, Kairn implemented the repeated deterministic fixes:

- Companion Routing V2 for generic role pairs and source-over-noise routing.
- Conditional hybrid MCP setup so hybrid does not force first-turn MCP calls.
- MCP stop/suppression metrics so suppressed failure context does not count as returned files.
- Tiny no-snippet guardrails for automatic hooks when full context is risky.
- Exact-source hook delivery changed from suppress-only to small active guardrails.

The most important one-shot live result came from a repeat-2 fresh-repo suite over Axios, Flask, and Commons IO Java:

| Mode | Repeats | Quality Passing Reports | Median Tokens | Valid Savings |
| --- | ---: | ---: | ---: | ---: |
| baseline | `2` | `2/2` | `65,661` | n/a |
| hook full-prime adaptive guardrail | `2` | `2/2` | `48,487` | `26.16%` |

Per-repeat totals:

| Repeat | Baseline Tokens | Hook Tokens | Result |
| ---: | ---: | ---: | --- |
| 1 | `58,427` | `39,422` | hook won, quality passed |
| 2 | `72,895` | `57,552` | hook won, quality passed |

Per-case hook behavior in the repeat-2 proof:

| Case | Hook Prime | Prime Tokens | Quality |
| --- | --- | ---: | --- |
| Axios interceptor order | emitted tiny guardrail | `159` | pass |
| Flask dispatch request | emitted tiny guardrail | `217` | pass |
| Commons IO filename equals | emitted tiny guardrail | `224` | pass |

This is the strongest current one-shot evidence that the product path should be:

> Default Codex setup = prompt hook with adaptive tiny guardrails, not broad full-prime context and not forced MCP-first.

Current interpretation:

- The earlier large wins were real but unstable because full-prime and MCP could over-assist.
- The new guardrail path is less flashy but more repeatable: it preserved quality and beat baseline in both repeats.
- Hybrid MCP should remain experimental. It is now safer because it suppresses when MCP would return no useful files, but it did not beat hook-only in this pass.

## Follow-Up: Session Ledger Endurance Pass

After the guardrail hook pass, Kairn added long-session ledger discipline:

- source-invariant and diff-scope verification events are recorded in the session ledger,
- passing verification anchors the working set to the verified source file,
- verification and cleanup turns can use `verified_context_shrunk` instead of repeating the full prime,
- suppress-only runs still cannot count as active Kairn wins.

The repaired endurance results are now stronger than the one-shot results:

| Suite | Baseline Tokens | Kairn Tokens | Valid Savings | Quality | Main Win |
| --- | ---: | ---: | ---: | --- | --- |
| Flask dispatch endurance v3 | `69,025` | `34,631` | `49.83%` | pass/pass | verification anchored to `src/flask/app.py` |
| Commons IO filename endurance v2 | `154,666` | `73,124` | `52.72%` | pass/pass | verification and cleanup avoided broad rereads |
| Axios interceptor endurance v3 | `127,942` | `53,023` | `58.56%` | pass/pass | fix turn stayed on `lib/core/Axios.js` |

Current interpretation:

- The default one-shot path should remain adaptive hook guardrails.
- The high-value product claim should emphasize hard/debug/long-session work, where the ledger can prevent repeated discovery, companion drift, and broad verification/cleanup scans.
- MCP remains experimental until it proves similar cumulative savings with actual tool calls and quality passing.

Remaining pain points:

- Axios-style multi-surface tasks still have live-run variance, even though post-diagnose source focusing fixed the companion drift in the latest run.
- The report aggregation still needs clearer per-case active/passive attribution so aggregate savings cannot be over-attributed to one active case.
- MCP has not yet shown the same repeatable long-session win as hook/ledger assistance.

Next validation should use the same guardrail and ledger setup on a wider suite, split by repo to avoid long timeout-bound runs:

1. JS/TS framework pair: Axios + Vue or Fastify.
2. Python framework pair: Flask + FastAPI.
3. Java utility/framework pair: Commons IO + a Spring-style repo.
4. One endurance repeat set after each suite passes once in both baseline and Kairn modes.
