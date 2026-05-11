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
- FastAPI expansion endurance proof: `/tmp/kairn-endurance-fastapi-v1.json`
- Fastify expansion endurance proof: `/tmp/kairn-endurance-fastify-v1.json`
- Gin expansion endurance proof: `/tmp/kairn-endurance-gin-v1.json`

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

## Follow-Up: Fresh Repo Expansion

Kairn then added and ran fresh endurance suites against new repositories:

- FastAPI: request-response sync endpoint threadpool regression.
- Fastify: HEAD route onSend handler preservation regression.
- Gin: RouterGroup parent middleware inheritance regression.

All three fresh suites passed quality gates in baseline and Kairn modes.

| Suite | Baseline Tokens | Kairn Tokens | Valid Savings | Quality | Pattern |
| --- | ---: | ---: | ---: | --- | --- |
| FastAPI request_response | `108,087` | `87,652` | `18.91%` | pass/pass | Kairn won diagnose/verify/cleanup, lost fix turn |
| Fastify HEAD route | `107,882` | `88,909` | `17.59%` | pass/pass | Kairn won diagnose/verify/cleanup, lost fix turn |
| Gin RouterGroup | `73,099` | `54,392` | `25.59%` | pass/pass | Kairn won diagnose/verify, lost fix/cleanup |

Fresh-expansion interpretation:

- The hook/ledger path generalized beyond the tuned Axios/Flask/Commons set.
- Savings were smaller than the old-suite post-diagnose wins, but still quality-preserving and positive across Python, JS, and Go.
- The repeated new failure pattern is **fix-turn over-assistance**. Kairn is very good at reducing diagnose/verify/cleanup cost, but on small exact-source edits, baseline Codex can patch faster than Kairn-assisted Codex.

Next improvement target:

> For fix turns after diagnosis, Kairn should often emit only the invariant and active source path, or suppress entirely if the agent already touched the right file. The current focused source brief is still sometimes more context than the model needs for the edit.

Next validation should use the same guardrail and ledger setup on a wider suite, split by repo to avoid long timeout-bound runs:

1. JS/TS framework pair: Axios + Vue or Fastify.
2. Python framework pair: Flask + FastAPI.
3. Java utility/framework pair: Commons IO + a Spring-style repo.
4. One endurance repeat set after each suite passes once in both baseline and Kairn modes.

## Follow-Up: Fix-Turn Minimalism Pass

Kairn then changed post-diagnose fix turns from ordinary focused context to a smaller **Fix Guardrail**:

- one active source path,
- semantic invariant to preserve,
- no snippets, symbols, quality score, companions, or related tests,
- explicit stop condition: edit the start file only unless the invariant or a failure requires another file.

This is meant to solve the fresh-expansion pattern where Kairn helped diagnose/verify/cleanup but sometimes over-assisted during the actual edit turn.

| Suite | Previous Savings | Minimalist Savings | Quality | Fix-Turn Behavior |
| --- | ---: | ---: | --- | --- |
| FastAPI request_response | `63.42%` | `73.61%` | pass/pass | fix turn changed from suppress to `118`-token guardrail on `fastapi/routing.py` |
| Fastify HEAD route | `17.59%` | `52.39%` | pass/pass | fix turn changed from suppress to `53`-token guardrail on `lib/head-route.js` |
| Gin RouterGroup | `25.59%` | `-35.36%` | pass/pass | fix turn changed from suppress to `52`-token guardrail on `routergroup.go`, but the diagnose turn became much more expensive |

Interpretation:

- The behavioral target worked: fix turns now receive tiny active-source guardrails instead of either broad context or silence.
- Fastify improved dramatically, and FastAPI improved on total tokens in this repeat.
- Gin is negative evidence. The guardrail did not break quality, and the fix turn itself was cheaper, but the run spent far more tokens during diagnosis. This means fix-turn minimalism is not sufficient by itself; Kairn still needs per-turn attribution and repeat medians before claiming a general win.

Current recommendation:

- Keep the Fix Guardrail behavior because it is safer than full-prime context and it preserves quality.
- Do not claim a universal savings increase from this pass.
- Next iteration should add a per-turn “where did the tokens move?” report so diagnose spikes cannot hide behind aggregate savings.

## Follow-Up: Gin Canary + SWE-Bench Pro Pilot

The Gin regression was treated as a canary rather than a tuning target. A repeat-3 run after the negative `v2` outlier showed the regression was mostly live-run variance:

| Run | Baseline Tokens | Kairn Tokens | Valid Savings | Quality |
| --- | ---: | ---: | ---: | --- |
| Gin repeat 3 | `71,863` | `50,117` | `30.26%` | pass/pass |
| Gin repeat 4 | `74,426` | `28,152` | `62.17%` | pass/pass |
| Gin repeat 5 | `78,659` | `23,024` | `70.73%` | pass/pass |

Median repeat result:

| Baseline Median | Kairn Median | Median Savings |
| ---: | ---: | ---: |
| `74,426` | `28,152` | `62.17%` |

Interpretation:

- The earlier `-35.36%` Gin run should stay in the record as negative variance evidence.
- It should not drive Go-specific tuning by itself.
- Gin remains a useful canary, but the median repeat supports the Fix Guardrail direction.

Kairn also added a small SWE-Bench Pro pilot adapter:

- `kairn bench swe-pro-pilot` fetches a public sample from `ScaleAI/SWE-bench_Pro` or consumes a local JSON/JSONL export.
- It writes both a repo-matrix preflight file and a live-agent suite scaffold.
- The generator removes golden patch file paths from prompts so retrieval is not leaked.
- Matrix preflight uses a distilled issue query: title, code identifiers, and test names instead of the full long issue body.
- The pilot scores only the primary production source file, because official patches often include docs, schemas, tests, config, or secondary files.

SWE-Bench Pro pilot sample:

| Sample | Languages | Repos | State Gate | Primary-Source Preflight |
| --- | --- | --- | --- | --- |
| `12` tasks | JS `2`, Python `8`, Go `2` | NodeBB, qutebrowser, ansible, openlibrary, teleport, navidrome | `12/12` passed | `3/12` passed |

Preflight passes:

| Repo | Language | Expected Primary Source | Returned |
| --- | --- | --- | --- |
| ansible | Python | `lib/ansible/utils/collection_loader/_collection_finder.py` | matched |
| teleport | Go | `lib/kube/proxy/forwarder.go` | matched |
| openlibrary | Python | `openlibrary/plugins/openlibrary/lists.py` | matched |

Preflight failures showed two repeated patterns:

- Kairn still over-suppresses several long SWE-style issue statements even after query distillation.
- Some emitted results find a nearby surface but miss the exact primary patch file, especially NodeBB routing/user-email and qutebrowser host/log movement tasks.

A no-agent verification smoke on the three preflight-pass cases failed before live Codex could run because the Hugging Face rows API truncates large `test_patch` fields, producing corrupt patches. That means live SWE-Bench Pro proof should not run from the rows API export. The next harness step is either:

1. consume a full Parquet/JSONL export with untruncated `test_patch`, or
2. integrate the official Docker evaluator flow using `dockerhub_tag`.

Current SWE-Bench Pro conclusion:

- Kairn can index these larger professional repos within state limits.
- Kairn is not yet good enough on long issue-statement retrieval: `3/12` primary-source preflight is a useful hard baseline, not a product win.
- Do not spend live Codex tokens on SWE-Bench Pro until the pilot uses full untruncated task data and preflight improves.

Artifacts:

- SWE pilot files: `/tmp/kairn-swe-pro-pilot-20260510-v4/`
- SWE preflight report: `/tmp/kairn-swe-pro-pilot-matrix-20260510-v4.json`
- SWE verification smoke: `/tmp/kairn-swe-pro-pilot-pass3-verification-smoke-20260510.json`
- Gin repeat artifacts: `/tmp/kairn-endurance-gin-repeat-3.json`, `/tmp/kairn-endurance-gin-repeat-4.json`, `/tmp/kairn-endurance-gin-repeat-5.json`

## Selective Governor Update

The latest implementation moved Kairn further away from "RAG firehose" behavior and toward a selective context governor:

| Situation | Desired Behavior | Current Evidence |
| --- | --- | --- |
| Obvious source hit | suppress or tiny guardrail | works mechanically, but Flask shows more abstention tuning is needed |
| Source rescue | exact source over broad scans | NodeBB, Teleport, Navidrome SWE-Pro preflight improved to pass |
| Multi-file debug | max two production files plus invariant | SWE-Pro v9 preflight passed `6/6` cases |
| Failure/debug work | compact directive, not full prime | Axios over-assist flipped into a valid assist after directive change |
| Low confidence | stay silent | behavior-target scoring exists; needs more weak-prompt examples |

SWE-Pro preflight v9 passed all six selected cases:

| Case | Returned Files | Gate |
| --- | --- | --- |
| NodeBB | `src/user/email.js`, `src/controllers/admin/users.js` | pass |
| qutebrowser | `qutebrowser/utils/log.py`, `qutebrowser/utils/qtlog.py` | pass |
| Teleport | `lib/service/kubernetes.go`, `lib/kube/proxy/forwarder.go` | pass |
| Navidrome | `core/agents/lastfm/client.go`, `core/agents/listenbrainz/client.go` | pass |
| Element Web | expected files absent from base checkout; scored as absent-file case | pass |
| Vuls | `models/cvecontents.go`, `contrib/trivy/pkg/converter.go` | pass |

Fresh seeded live proof:

| Suite | Cases | Quality | Hook Savings |
| --- | ---: | --- | ---: |
| Axios, Flask, Commons IO | `3` | pass/pass/pass | `56.70%` aggregate |

Case detail:

| Case | Baseline | Hook | Result |
| --- | ---: | ---: | --- |
| Axios | `40,025` | `7,024` | valid assist |
| Flask | `24,226` | `28,760` | over-assist despite quality pass |
| Commons IO | `34,564` | `6,999` | valid assist |

Current pain point:

Flask proves Kairn still needs better exact-source abstention. The context was tiny and correct, but Codex was already cheap enough that the guardrail increased tokens. The next broad validation should explicitly score exact-source abstention accuracy across repeated Python/JS/Java cases before making a stronger default-policy claim.

## Cheap Exact-Source Guardrail Follow-Up

Kairn tested two responses to the Flask exact-source over-assist pattern:

1. Complete automatic hook suppression for obvious dynamic-language exact-source fixes.
2. An ultra-minimal guardrail: one source file, invariant, smallest check, and a stop condition.

The complete suppression run was not a product win. Flask received no Kairn context, but Codex touched `tests/test_basic.py`, so the quality gate failed even though the source invariant was repaired. This is useful evidence: for cheap exact-source tasks, silence can avoid token cost, but it can also fail to preserve the “do not edit unrelated files/tests” constraint.

The guardrail rerun was the stronger behavior:

| Case | Baseline Tokens | Hook Tokens | Prime Tokens | Quality | Result |
| --- | ---: | ---: | ---: | --- | --- |
| Axios interceptor order | `23,448` | `12,702` | `395` | pass/pass | valid assist |
| Flask dispatch request | `41,033` | `12,175` | `156` | pass/pass | valid cheap exact-source guardrail |
| Commons IO filename equals | `27,071` | `6,258` | `281` | pass/pass | valid assist |
| Aggregate | `91,552` | `31,135` | - | pass/pass | `65.99%` valid savings |

Artifact:

- `/tmp/kairn-seeded-new-repos-final-guardrail-20260510.json`

Implementation takeaway:

- Exact-source abstention should not mean “always silent.”
- For automatic hooks, cheap exact-source tasks should usually emit an ultra-minimal guardrail when the prompt includes a concrete invariant and edit-scope constraint.
- The guardrail is materially smaller than the old one-file directive and prevented the test-file drift seen during suppression.
- Java validation was widened to accept semantically equivalent `IOCase` null-fallback repairs, not only exact `IOCase.value(...)` source text.

Current selective-governor status:

| Behavior Class | Current Evidence |
| --- | --- |
| Cheap/easy exact source | ultra-minimal guardrail can preserve quality and save tokens; complete silence is risky |
| Multi-file debug | compact two-file directives remain positive on Axios/SWE-Pro preflight |
| Java exact source | quality can pass with semantic invariant validation; avoid exact-source-string brittleness |
| Weak/low-confidence prompts | still needs broader abstention-accuracy testing |

## Fresh Holdout Matrix

To avoid self-confirming on the tuned repos, Kairn ran a retrieval-only holdout matrix across seven fresh repos:

- Werkzeug
- Requests
- Express
- gorilla/mux
- Guava
- Redis
- React

Artifact:

- `/tmp/kairn-holdout-matrix-20260510.json`
- Matrix definition: `examples/bench/repo-matrix-holdout.json`

Summary:

| Gate | Result |
| --- | ---: |
| Repos | `7` |
| State limit | `7/7` passed |
| Retrieval quality | `0/7` passed strict gates |
| Live-agent runs | skipped |

Important nuance: this does not mean Kairn returned useless files. Most cases returned one strong primary source quickly. The strict gate failed because holdout tasks intentionally expected multi-surface companion files too.

| Repo | Returned Files | Missing Pattern |
| --- | --- | --- |
| Werkzeug | `rules.py`, `converters.py` | missed routing `map.py` companion |
| Requests | `sessions.py` | missed adapter/model companions |
| Express | `router/index.js` | missed router `layer.js` / `route.js` companions |
| gorilla/mux | `middleware.go`, `mux.go` | missed `route.go` |
| Guava | `Strings.java` | missed `CharMatcher.java` companion |
| Redis | `deps/lua/src/lua_cjson.c` | source-vs-deps failure; missed `src/sds.c` / `src/sds.h` |
| React | `ReactFiberWorkLoop.js`, `ReactFiberCacheComponent.js` | missed `ReactFiberHooks.js` |

Interpretation:

- Kairn is not ready to hand to a friend as “works with arbitrary supported repos and workflows.”
- The recent live wins are real, but the holdout shows the next general weakness clearly: companion routing and source-over-vendor/deps routing.
- The state-discipline work is holding up. Even React and Guava stayed under the configured state cap.
- The next implementation should not tune these repos one by one. It should improve generic companion behavior:
  - same directory source siblings,
  - role triples such as `index/layer/route`, `session/adapter/model`, `map/rules/converter`, `mux/route/middleware`, `hooks/workloop`,
  - exact acronym/identifier rescue such as `SDS -> sds.c`,
  - stronger demotion for `deps/`, `vendor/`, and third-party embedded source unless the prompt asks for dependencies.

Recommendation:

Do not run live Codex holdout proofs yet. First improve general companion routing V3 and source-vs-deps routing, then rerun this holdout matrix. Live-agent spending only makes sense after at least a subset of this fresh matrix passes preflight.

## Companion Routing V3 Rerun

After adding generic role triples and stronger source-over-deps routing, the same fresh holdout matrix passed retrieval preflight.

Artifacts:

- `/tmp/kairn-holdout-matrix-v3b-20260510.json`
- Matrix definition: `examples/bench/repo-matrix-holdout.json`

Summary:

| Gate | Result |
| --- | ---: |
| Repos | `7` |
| State limit | `7/7` passed |
| Retrieval quality | `7/7` passed strict gates |
| Live-agent runs | still skipped |

Returned files:

| Repo | Top Returned Files |
| --- | --- |
| Werkzeug | `src/werkzeug/routing/map.py`, `src/werkzeug/routing/converters.py`, `src/werkzeug/routing/rules.py` |
| Requests | `src/requests/sessions.py`, `src/requests/adapters.py`, `src/requests/models.py` |
| Express | `lib/router/index.js`, `lib/router/route.js`, `lib/router/layer.js` |
| gorilla/mux | `mux.go`, `route.go`, `middleware.go` |
| Guava | `guava/src/com/google/common/base/Strings.java`, `guava/src/com/google/common/base/CharMatcher.java`, `android/guava/src/com/google/common/base/CharMatcher.java` |
| Redis | `src/t_string.c`, `src/sds.c`, `src/sds.h` |
| React | `packages/react-reconciler/src/ReactFiberWorkLoop.js`, `packages/react-reconciler/src/ReactFiberHooks.js`, `packages/react-reconciler/src/ReactFiberCacheComponent.js` |

What changed:

- Generic companion role groups now cover session/adapter/model, router/index/route/layer, map/rules/converter, mux/route/middleware, string/matcher, and fiber/hooks/workloop.
- Multi-file directive delivery can include a capped third source file when a framework task has strong companion evidence.
- Vendored dependency surfaces such as `deps/`, `vendor/`, `third_party/`, and `node_modules/` are demoted for implementation/debug prompts.
- Short generic terms like `api` no longer behave like precise source anchors; short exact identifiers such as `SDS` still get source rescue through lexical/source scoring.

Interpretation:

This is a better generalization signal than the tuned live suite because the repos were fresh and the previous strict preflight failed `0/7`. It is still not a live-agent quality claim. The next live spend should use a small holdout subset from these repos, with quality gates and baseline vs hook comparison, before treating V3 as a product-level win.

## Light Live Holdout Proof

Kairn then ran a small live Codex subset with `gpt-5.4-mini`, using two fresh seeded holdout cases:

- Express `lib/router/layer.js` fast-star regression
- Requests `Session.send` redirect-resolution regression

Artifacts:

- Suite: `examples/bench/seeded-holdout-live-light.json`
- First valid indexed run: `/tmp/kairn-holdout-live-light-gpt54mini-indexed-20260510.json`
- Autosuppression rerun: `/tmp/kairn-holdout-live-light-gpt54mini-autosuppress-20260510.json`

Important setup finding:

- A first attempted run installed hooks without `kairn init`.
- Prompt hooks correctly skipped prompt-turn indexing, found no candidates, and suppressed.
- Valid hook benchmark commands must separate setup/index time but still run `kairn init` before `kairn setup codex`.

Indexed run:

| Mode | Tokens | Quality | Active Kairn | Result |
| --- | ---: | --- | --- | --- |
| Baseline | `42,469` | pass | no | control |
| Hook full-prime | `33,292` | pass | yes | `21.61%` valid savings |

Case split:

| Case | Baseline | Hook | Result |
| --- | ---: | ---: | --- |
| Express | `19,080` | `23,110` | hook over-assisted a cheap one-file fix |
| Requests | `23,389` | `10,182` | hook helped substantially with multi-file directive |

Follow-up change:

- Automatic hooks now suppress cheap single-source context when companion evidence is generic.
- Requests-style multi-file directives still emit.

Autosuppression rerun:

| Mode | Tokens | Quality | Result |
| --- | ---: | --- | --- |
| Baseline | `49,853` | pass | control |
| Hook full-prime | `51,863` | pass | `-4.03%`, over-assist |

Case split after autosuppression:

| Case | Baseline | Hook | Kairn Behavior |
| --- | ---: | ---: | --- |
| Express | `30,868` | `28,731` | suppressed, slight win |
| Requests | `18,985` | `23,132` | emitted multi-file directive, regressed on this repeat |

Interpretation:

- Companion Routing V3 is clearly better in retrieval preflight.
- Live results are mixed and high-variance on `gpt-5.4-mini`.
- The product direction is still correct: suppress cheap one-file cases, use structured multi-file directives for framework bugs.
- This does not yet justify broad live holdout spending. The next improvement should focus on repeat-based reporting and perhaps per-case prompt difficulty classification before claiming new live savings.

## Repeat-Based Holdout Classification

Kairn added case-level repeat classifications to `bench prove` so a repeated proof can distinguish:

- consistent active wins,
- correct abstention,
- missed opportunities,
- over-assist,
- volatile mixed evidence,
- quality risk.

This matters because latest-run deltas are noisy. The repeat-2 light holdout proof showed:

Artifact:

- `/tmp/kairn-holdout-live-light-gpt54mini-repeat2-20260510.json`

Aggregate median:

| Mode | Median Tokens | Quality | Median Result |
| --- | ---: | --- | --- |
| Baseline | `50,117` | pass | control |
| Hook full-prime | `43,003` | pass | `14.19%` median savings |

Case repeat classifications:

| Case | Classification | Median Saved Tokens | Interpretation |
| --- | --- | ---: | --- |
| Express `layer.js` | `missed_opportunity` | `-5,891` | Kairn suppressed both repeats, but baseline remained expensive; suppression alone is not enough for this prompt class. |
| Requests `sessions.py` | `consistent_win` | `13,006` | Multi-file directive was active both repeats and saved `51.48%` median tokens while preserving quality. |

Interpretation:

- Requests-style multi-file directives should not be disabled globally; they are now repeat-confirmed useful on this holdout.
- Express-style cheap source fixes need a better choice than either one-file guardrail or silent suppression. The next controller shape should probably be an ultra-short invariant-only guardrail, or a stronger prediction that Codex already has enough signal and Kairn should fully abstain.
- For repeat proofs, use aggregate medians and `caseRepeatClassifications` over the latest-run `observedTokenDeltas` field, which remains present for backwards compatibility but can mislead when live runs are high variance.

## Long-Session Ledger Proof

Kairn then shifted from one-shot retrieval proofs to four-turn endurance tasks:

1. diagnose source,
2. fix source,
3. verify or handle the edge case,
4. cleanup/review diff.

The goal was to test the real wedge: cumulative token savings, repeated-context control, and quality preservation over follow-up work.

Artifacts:

- Requests baseline/Kairn run: `/tmp/kairn-endurance-requests-ledger-20260510.json`
- Requests MCP-inclusive run before MCP stop-condition fix: `/tmp/kairn-endurance-requests-ledger-mcp-20260510.json`
- Requests MCP-inclusive rerun after MCP stop-condition fix: `/tmp/kairn-endurance-requests-ledger-mcp-v2-20260510.json`
- Gin baseline/Kairn run: `/tmp/kairn-endurance-gin-ledger-20260510.json`

Results:

| Suite | Mode | Tokens | Quality | Active Kairn | Valid Savings |
| --- | --- | ---: | --- | --- | ---: |
| Requests | baseline | `74,534` | pass | no | control |
| Requests | Kairn prime | `49,894` | pass | yes, `4` shrink turns | `33.06%` |
| Gin | baseline | `68,790` | pass | no | control |
| Gin | Kairn prime | `27,072` | pass | yes, `4` shrink turns | `60.65%` |

Requests MCP comparison before and after the stop-condition fix:

| Run | Baseline | Kairn Prime | MCP/Hybrid | MCP Result |
| --- | ---: | ---: | ---: | --- |
| before fix | `54,957` | `47,333` (`13.87%`) | `73,396` | `-33.55%`, over-assist |
| after fix | `53,293` | `43,348` (`18.66%`) | `42,398` | `20.44%`, valid savings |

What changed:

- MCP compact prepare now returns a stop-only suppressed payload after it has already returned a production source file for the same session.
- MCP failure context now focuses on the previously returned MCP source file when exact-source metadata is unavailable.
- In the successful MCP rerun, recorded tool calls returned:
  - `kairn_prepare_task`: `src/requests/sessions.py`
  - later `kairn_prepare_task`: no files, stop-only payload
  - `kairn_get_failure_context`: `src/requests/sessions.py`
  - later prepare calls: no files, stop-only payload

Interpretation:

- The long-session Kairn prime path is now stronger evidence than the one-shot holdout: it passed quality on Requests and Gin while saving `33-61%`.
- MCP is mechanically viable but very sensitive to stop conditions. The same Requests suite moved from a large regression to positive savings after Kairn stopped re-surfacing context once source evidence was sufficient.
- The next MCP target is fewer total tool calls, not broader context. Tool calls can still be useful, but repeated prepare/failure calls should return tiny stop guidance once the active source and invariant are known.

### MCP Tool-Call Discipline Follow-Up

Kairn added phase-aware MCP benchmark guidance:

- first turn: call `kairn_prepare_task` before broad reads;
- later turns: if a known source is already in the session ledger, do **not** call `kairn_prepare_task` again;
- after concrete failure output: call `kairn_get_failure_context` at most once;
- source selection now prefers actual MCP-returned files over ignored ledger recommendations.

Artifacts:

- `/tmp/kairn-endurance-requests-mcp-discipline-20260510.json`
- `/tmp/kairn-endurance-requests-mcp-discipline-v2-20260510.json`
- `/tmp/kairn-endurance-requests-mcp-discipline-v3-20260510.json`
- `/tmp/kairn-holdout-hook-mcp-hybrid-20260510.json`

Requests endurance after the final source-priority fix:

| Mode | Tokens | Quality | Actual MCP Calls | Result |
| --- | ---: | --- | ---: | --- |
| Baseline | `85,830` | pass | `0` | control |
| Kairn prime/shrink | `52,669` | pass | `0` | `38.64%` valid savings |
| MCP/hybrid | `72,276` | pass | `1` | `15.79%` valid savings |

This is the right direction: MCP no longer repeatedly calls Kairn through the whole session. It still lags direct prime/shrink on this run, mostly because the natural-language MCP instruction overhead is higher than the direct shrunk prime.

Actual installed one-shot surfaces were then checked on the light holdout suite:

| Mode | Quality | Result |
| --- | --- | --- |
| Hook full-prime | pass | over-assisted vs baseline |
| Real MCP-first | pass | over-assisted vs baseline |
| Hybrid MCP brief | pass | over-assisted vs baseline |

Interpretation:

- Long-session direct prime/shrink is currently the strongest proven path.
- MCP is improving and now shows valid long-session savings when calls are disciplined, but it needs lower prompt/tool overhead before becoming the default.
- Actual installed hook/hybrid one-shot mode is not ready for SWE-Pro live spend based on this exploratory run. The next fix should make prompt hooks and hybrid briefs more aggressively abstain or emit ultra-minimal guardrails on cheap one-shot source bugs.

### Cheap One-Shot Hook/MCP Guardrail Iteration

Plan:

1. Detect cheap one-shot source fixes as a behavior class, not a repo-specific rule.
2. For prompt hooks, suppress host context completely when the task is cheap, exact-source, and has no multi-file signal.
3. For MCP, avoid fanout. If the model calls Kairn anyway, return either no context or one ultra-minimal source guardrail: one production path, invariant, no snippets, no companions, no next tool calls.
4. Tighten MCP-first instructions so agents do not call Kairn solely because a prompt says debug/failure/regression when the task is otherwise a small one-source fix.
5. Treat suppress-only runs as passive evidence; active savings require hook context, MCP guidance, or failure guidance.

Implementation:

- Hook prompt submissions now suppress cheap exact-source one-shot tasks instead of emitting full prime context.
- `kairn_prepare_task(detail: "compact")` now returns `cheap_one_shot_guardrail` with one source file when Kairn has a clean production candidate, or `cheap_one_shot_abstention` with no files when it does not.
- MCP-first `AGENTS.md` instructions now explicitly say to work normally on cheap one-shot source fixes and to reserve Kairn for broad, unclear, multi-file, or real command/test failure output.

Artifacts:

- First MCP abstention run: `/tmp/kairn-holdout-real-mcp-ultra-guardrail-20260510.json`
- Instruction-abstention rerun: `/tmp/kairn-holdout-real-mcp-instruction-abstain-20260510.json`

Live result after the final instruction pass:

| Mode | Tokens | Quality | Actual MCP Calls | Result |
| --- | ---: | --- | ---: | --- |
| Baseline | `33,397` | pass | `0` | control |
| Real MCP-first | `28,055` | pass | `2` total, `1` per case | `16.00%` exploratory savings |

Per-case notes:

- Express: `23,248` baseline tokens to `10,828` MCP tokens, quality pass, one returned source file: `lib/router/layer.js`.
- Requests: `10,149` baseline tokens to `17,227` MCP tokens, quality pass, one returned source file: `src/requests/sessions.py`.

Interpretation:

- The active over-assist pattern was reduced: MCP returned one production source file and no companion/test fanout.
- The earlier over-abstention failure was repaired: both holdout cases passed quality gates again.
- MCP still has per-case variance. The Requests case remained token-negative in this run, so this is not enough to promote MCP-first as the default for cheap one-shot tasks.
- Hook-only behavior is now safer for this task class because suppressed hooks do not add host context. MCP-first remains useful where tools are the only available integration surface, but it needs repeat-based classification before product claims.

### Endurance Installed-Surface Smoke

After adding installed-surface endurance modes, Kairn ran two full-surface endurance smokes with:

- baseline
- direct Kairn prime/shrink
- installed hook full-prime
- real MCP-first
- hybrid MCP brief

Artifacts:

- Requests: `/tmp/kairn-endurance-requests-full-surface-smoke-20260510.json`
- Gin: `/tmp/kairn-endurance-gin-full-surface-smoke-20260510.json`

Results:

| Suite | Mode | Tokens | Quality | Active | Valid Savings |
| --- | --- | ---: | --- | --- | ---: |
| Requests | baseline | `96,967` | pass | no | control |
| Requests | direct Kairn prime | `79,488` | pass | yes | `18.03%` |
| Requests | hook full-prime | `50,609` | pass | yes | `47.81%` |
| Requests | real MCP-first | `71,484` | pass | yes, `3` MCP calls | `26.28%` |
| Requests | hybrid MCP brief | `66,599` | pass | yes, `1` MCP call | `31.32%` |
| Gin | baseline | `79,429` | pass | no | control |
| Gin | direct Kairn prime | `39,973` | pass | yes | `49.67%` |
| Gin | hook full-prime | `73,626` | pass | yes | `7.31%` |
| Gin | real MCP-first | `60,366` | pass | yes, `2` MCP calls | `24.00%` |
| Gin | hybrid MCP brief | `58,643` | pass | yes, `1` MCP call | `26.17%` |

Findings:

- The endurance harness can now compare installed hook, real MCP-first, and hybrid modes instead of only direct prompt priming.
- Both suites passed quality gates across every mode; no token reduction here is invalid savings.
- MCP/hybrid are now positive in both smokes and have controlled call counts. Hybrid used one MCP call in both suites.
- Hook full-prime is not universally best. It was strongest on Requests, but weak on Gin. This supports the product thesis that Kairn needs adaptive delivery by behavior class, not one universal mode.
- Direct Kairn prime/shrink remains the strongest long-session upper-bound on Gin, but it is not the normal automatic UX.

Recommendation:

- Do not claim repeat-3 endurance stability yet from these two smokes.
- The next live spend should be repeat-3 on two representative suites first, not the full four-suite/five-mode matrix. A full matrix would be roughly 240 live Codex turns.
- If repeat-3 confirms the same pattern, the product story should be:
  - hook as default automatic savings path,
  - MCP/hybrid as positive but still experimental read-gateway paths,
  - direct prime/shrink as upper-bound and wrapper/control path.
