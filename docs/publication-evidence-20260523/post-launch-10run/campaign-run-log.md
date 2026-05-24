# Kairn Post-Launch 10-Run Campaign Log

Campaign freeze: `2026-05-23T11:24:06Z`

Git SHA: `a289f67c0d5dea9e36d34f14a041ec6bed317120`

Model: `gpt-5.4-mini`

## Preflight

- Passed: `pnpm test` (`15` files, `277` tests)
- Passed: `pnpm typecheck`
- Passed: `pnpm build`
- Passed: `git diff --check`
- Passed: Docker daemon started, server `29.2.1`
- Passed: SWE-Pro official evaluator readiness for selected rows; all 4 selected rows have official assets.

## Harness Pause 1

- Artifact: `endurance-fastify-canary.json`
- Result: setup harness failure, not a product result.
- Cause: the MCP setup command used `node dist/cli.js` while running from the disposable Fastify workspace, where `dist/cli.js` does not exist.
- Fix: reran with the absolute frozen Kairn CLI path: `node /Users/kevindotel/Documents/Projects/kairn/dist/cli.js`.

## Completed Case 1

- Artifact: `endurance-fastify-canary.fixed.json`
- Case: `examples/bench/endurance-fastify.json`
- Modes: `baseline` vs `real_mcp_first`
- Quality: pass/pass
- Scope: passed
- MCP evidence: `1` actual MCP tool call; `1` useful returned production file (`lib/head-route.js`)
- Tokens: baseline `104,425`, Kairn `61,551`
- Clean active savings: `42,874` tokens, `41.1%`

## Completed Case 2

- Artifact: `endurance-commons-io-canary.json`
- Case: `examples/bench/endurance-commons-io.json`
- Modes: `baseline` vs `real_mcp_first`
- Quality: pass/pass
- Scope: passed
- MCP evidence: `1` actual MCP tool call; `1` useful returned production file (`src/main/java/org/apache/commons/io/FilenameUtils.java`)
- Tokens: baseline `140,526`, Kairn `49,484`
- Clean active savings: `91,042` tokens, `64.8%`

## Completed Case 3

- Artifact: `endurance-gin-canary.json`
- Case: `examples/bench/endurance-gin.json`
- Modes: `baseline` vs `real_mcp_first`
- Quality: pass/pass
- Scope: passed
- MCP evidence: `1` actual MCP tool call; `1` useful returned production file (`routergroup.go`)
- Tokens: baseline `69,939`, Kairn `49,732`
- Clean active savings: `20,207` tokens, `28.9%`

## Completed Cases 4-6

- Artifact: `fresh-source-heavy-subset-preflight.json`
- Cases: `webpack/normal-module-factory-resolver`, `gorm/create-callback-statement`, `okhttp/real-interceptor-chain`
- Result: `3/3` deterministic source-quality gates passed
- Latency: webpack `2,447ms`, GORM `244ms`, OkHttp `468ms`
- Decisions: all `shrink`
- Notes:
  - Webpack returned `lib/NormalModuleFactory.js` and `lib/ResolverFactory.js`; `JavascriptParser.js` was not emitted in the compact shrink, but companion/source gate passed.
  - GORM returned `schema/field.go` and `statement.go`; `callbacks/create.go` was not emitted in the compact shrink, but source quality and companion gate passed.
  - OkHttp returned both expected production files.

## Harness Pause 2

- Artifact: `swe-pro/teleport-mfa/proof.json`
- Result: invalid Kairn-mode attempt, not a product result.
- Cause: the first Teleport `kairn_codex_session` run used the direct Codex command instead of the real `kairn codex` wrapper, so no Kairn prime/session context was emitted.
- Fix: reran as `swe-pro/teleport-mfa/proof.wrapper.json` with `node /Users/kevindotel/Documents/Projects/kairn/dist/cli.js codex --codex-command "codex -a never"`.

## Harness Pause 3

- Artifact: SWE-Pro official evaluator runs.
- Result: Docker credential-helper workaround required on macOS.
- Cause: Docker Desktop credential helper could hang under the official evaluator's Python Docker client.
- Fix: ran official evaluator with a temporary `HOME`/`DOCKER_CONFIG` and explicit `PYTHONPATH` for the installed Docker Python package.

## Completed Case 7

- Artifact: `swe-pro/openlibrary-marc-parse/proof.json` plus official evaluator outputs.
- Case: OpenLibrary MARC parse official row.
- Quality: local baseline failed scope/source discipline, local Kairn passed; official evaluator passed both generated patches.
- Scope: baseline failed by editing `openlibrary/catalog/marc/tests/test_parse.py`; Kairn touched only `openlibrary/catalog/marc/parse.py`.
- Tokens: baseline `61,518`, Kairn `32,203`.
- Classification: scope/source-focus rescue. Do not count as clean pass/pass savings.

## Completed Case 8

- Artifact: `swe-pro/openlibrary-standard-ebooks/proof.json` plus official evaluator outputs.
- Case: OpenLibrary Standard Ebooks official row.
- Quality: local pass/pass and official pass/pass.
- Scope: passed for both modes.
- Tokens: baseline `33,270`, Kairn `24,939`.
- Clean official pass/pass savings: `8,331` tokens, `25.0%`.

## Completed Case 9

- Artifact: `swe-pro/element-posthog/proof.json` plus official evaluator outputs.
- Case: Element PostHog official row.
- Quality: local pass/pass and official pass/pass.
- Scope: passed for both modes.
- Tokens: baseline `44,613`, Kairn `52,018`.
- Classification: official pass/pass token regression. Kairn used `7,405` more tokens (`16.6%` higher), so this is not counted as savings.

## Completed Case 10

- Artifact: `swe-pro/teleport-mfa/proof.wrapper.json` plus official evaluator outputs.
- Case: Teleport MFA official row.
- Quality: local pass/pass and official pass/pass.
- Scope: passed for both modes.
- Tokens: baseline `62,755`, Kairn `78,307`.
- Classification: official pass/pass token regression. Kairn used `15,552` more tokens (`24.8%` higher), so this is not counted as savings.

## Campaign Summary

- MCP endurance: `3/3` pass/pass, `154,123` total tokens saved, `49.0%` weighted savings, `41.1%` median savings, `0` scope violations.
- Fresh source-heavy preflight: `3/3` source-quality gates passed with compact `shrink` decisions.
- SWE-Pro official: Kairn passed `4/4` official evaluator rows; baseline also passed `4/4` official evaluator rows in this selected slice.
- Clean official pass/pass savings: `1` row (`25.0%` lower token use).
- Official pass/pass regressions: `2` rows. These are the main follow-up optimization target.
- Supporting rescue evidence: `1` official row where Kairn stayed within local production scope and baseline edited a test.

## Follow-Up Optimization

The repeated official-row token regressions are not a scope or quality failure, but they show a general behavior class to improve: narrow exact-source patch prompts can be over-assisted. Before the next SWE-Pro expansion, test a governor variant that emits only a tiny edit-scope/source guardrail, or suppresses entirely, when the task is already source-specific and retrieval confidence is high.

## Notes

- The repository had existing untracked prior evidence artifacts before this campaign began.
- This campaign writes only under `docs/publication-evidence-20260523/post-launch-10run/` unless a general code fix is required.
