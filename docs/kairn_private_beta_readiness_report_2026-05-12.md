# Kairn Private Beta Readiness Report - 2026-05-12

## Summary

Kairn has enough evidence for a small trusted private beta, but not for a public "works anywhere" claim. The primary beta path should be `kairn codex` / `kairn_codex_session`: one session-bound ledger, adaptive prompt-hook delivery, and suppression when Kairn lacks high-confidence leverage. The secondary beta path should be MCP via `kairn setup mcp --client vscode` or `kairn setup codex --mode mcp-first` for editor/app users who do not want CLI hooks.

## Current Evidence

| Evidence | Result |
| --- | --- |
| 10-turn Requests live proof | `kairn_codex_session` passed quality and saved 33.82% observed tokens |
| Fresh Fastify 4-turn endurance | `kairn_codex_session` passed quality and saved 54.51% observed tokens |
| Fresh FastAPI 4-turn endurance | `kairn_codex_session` passed quality and saved 30.30% observed tokens |
| Session memory | Ledger avoided repeated file/snippet context and cleared stale risks after verification |
| Privacy posture | Detailed metrics stay local by default |
| Telemetry readiness | Opt-in sanitized aggregate telemetry scaffolded with Supabase ingest assets |
| MCP setup readiness | Workspace `.vscode/mcp.json` setup and doctor detection added for editor/app integrations |

## Fresh Holdout V3

New preflight matrix:

`examples/bench/repo-matrix-private-beta-v3.json`

Coverage:

- Vite and Zod for JS/TS.
- Rich and httpcore for Python.
- Chi and Zap for Go.
- OkHttp for JVM/Kotlin/Java-style code.
- spdlog for C++.
- Zod weak-signal canary for suppression accuracy.

Preflight result after Companion Routing V3 / source-vs-noise routing fixes:

| Metric | Result |
| --- | ---: |
| Repos | 9 |
| State-bounded repos | 9 / 9 |
| Quality-passing cases | 9 / 9 |
| Failed cases | 0 |

Returned source evidence:

| Case | Top returned files |
| --- | --- |
| Vite plugin container resolve | `pluginContainer.ts`, `importAnalysis.ts`, `importAnalysisBuild.ts` |
| Zod object parse shape | `schemas.ts`, `core.ts`, `mini/schemas.ts` |
| Rich render measure | `console.py`, `measure.py`, `segment.py` |
| httpcore connection pool retry | `_sync/connection_pool.py`, `_sync/connection.py`, `_async/connection.py` |
| Chi route context | `mux.go`, `context.go`, `tree.go` |
| Zap core entry write | `zapcore/entry.go`, `zapcore/core.go`, `zapcore/encoder.go` |
| OkHttp interceptor chain | `RealCall.kt`, `RealInterceptorChain.kt`, `Call.kt` |
| spdlog logger sink dispatch | `logger.h`, `sink.h`, `base_sink.h` |
| Weak-signal canary | correctly passed without required source fanout |

Reproduction command:

```bash
kairn bench matrix \
  --matrix examples/bench/repo-matrix-private-beta-v3.json \
  --json
```

Live validation should use `baseline` vs `kairn_codex_session` first, with MCP added only for broad/failure-driven cases.

## Fresh Live Endurance Smoke

Live model: `gpt-5.4-mini`

| Suite | Quality | Assistance | Baseline tokens | Kairn tokens | Valid savings | Artifact |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Fastify HEAD route | pass/pass | active | 72,311 | 32,897 | 54.51% | `/tmp/kairn-private-beta-fastify-session-post-diagnose-20260512131558.json` |
| FastAPI request response | pass/pass | active | 91,374 | 63,691 | 30.30% | `/tmp/kairn-private-beta-fastapi-session-20260512132116.json` |
| Fastify MCP-first | pass/pass | active | 93,585 | 56,029 | 40.13% | `/tmp/kairn-private-beta-fastify-mcp-hybrid-post-diagnose-20260512135059.json` |
| Fastify hybrid MCP-brief | pass/pass | active | 93,585 | 48,720 | 47.94% | `/tmp/kairn-private-beta-fastify-mcp-hybrid-post-diagnose-20260512135059.json` |

The first Fastify attempt exposed a general missed-opportunity issue: `diagnose` and `audit` prompts were not considered high-confidence hook candidates, so Kairn stayed passive. The fix was behavior-class based, not repo-specific: prompt hooks now treat `diagnose`, `investigate`, `audit`, and `trace` as high-confidence source-routing verbs.

Remaining weakness from the fresh live smoke: FastAPI's first shrink found the correct source, `fastapi/routing.py`, but included extra neighbor files. This did not break quality, but Companion Routing should continue moving toward "one exact source unless multi-file evidence is strong."

MCP note: the first Fastify MCP/hybrid run was passive because no MCP tool calls occurred. Kairn then updated MCP-first/hybrid guidance so diagnose, investigate, audit, and trace prompts without exact production paths call `kairn_prepare_task` once before broad/manual source reads. The rerun recorded one MCP call in both pure MCP and hybrid, one returned useful file, no quality loss, and active valid savings. This supports pure MCP as the default editor/app path, while hybrid remains opt-in for users who also accept hooks.

## Beta Readiness Gate

Private beta can start when fresh validation shows:

- Kairn quality pass rate is within 5 percentage points of baseline.
- Active Kairn runs have median valid savings of at least 15%.
- No repeated harmful-assist pattern appears.
- Cheap/weak prompts mostly suppress or emit only tiny guardrails.
- At least one fresh endurance suite shows active Kairn value after turn 1.

## Product Readiness Additions

Implemented beta support surfaces:

- `kairn setup mcp --root <repo> --client vscode`
- `kairn doctor --root <repo> [--json]`
- `kairn telemetry status|enable|disable|flush`
- `kairn diagnostics export`
- `kairn beta report`
- Supabase migration and Edge Function scaffold for sanitized telemetry ingest.

Telemetry is opt-in only. Uploaded payloads intentionally exclude source code, prompts, command output, diffs, filenames, repo URLs, usernames, branch names, and machine paths.

## Decision

Current decision: **private beta candidate**.

The fresh preflight gate is passing on unseen repo families, and two fresh endurance smokes passed with active quality-preserving savings. The remaining beta blocker is install/setup smoke on another machine.

The trusted-friend beta should be framed as:

> Kairn helps Codex stay focused and can reduce tokens on debug/long-session work. It is privacy-first, local by default, and may stay silent when it does not have high-confidence value.
