# Kairn v0.2 Unified Release Conflict Ledger

This ledger records how the semantic/infrastructure line at `74ddb15` and the public beta/reporting line at `660bce7` were unified. It exists so a green merge cannot silently reintroduce benchmark-specific relevance rules or discard generally useful public-beta behavior.

## Release baseline

- Primary architecture: the content-addressed, fail-closed benchmark infrastructure and model-based semantic candidate work from `74ddb15`.
- Distribution: the root `usekairn` package is the complete local Node.js product. The older launcher plus per-platform Kairn binary packages are retired.
- Monday serving default: deterministic candidate generation (`legacy`). Semantic retrieval is available only through the explicit `--semantic-preview` shadow path and does not alter served evidence.
- Evidence policy: timeout, provider, trace, verifier, or source-invariant failures produce no effectiveness or token claim.

## Public-line dispositions

| Commit | Capability | Disposition |
| --- | --- | --- |
| `231009d` | Governance routing and large task-specific runtime/test additions | General governance types and formatting concepts retained. Repository, fixture, filename, task-term, and regex relevance routes are superseded by the semantic architecture and were not carried into the serving runtime. |
| `8af1e7d` | MCP session accounting and official guardrails | Caller-supplied MCP session creation and token/session attribution retained. Benchmark-shaped execution-state relevance rules were superseded. |
| `ccea7b1` | Kairn-native evidence compression | Retained through the typed evidence-compression route, metadata, metrics, and focused integration coverage. |
| `d02042d` | Shadow evidence-routing policy | Retained as diagnostics only. Counterfactual shadow results do not count as realized savings or change served evidence. |
| `660bce7` | Quality-gated shareable report | Retained. `kairn report --share` is aggregate-only and distinguishes estimated context from provider-observed billing tokens. |
| `b578bf3` through `09d983a` | Launcher and per-platform binary npm distribution | Retired. v0.2 ships the root Apache-2.0 `usekairn` Node package and validates a packed clean-consumer install instead. |

## Superseded tests

Tests that asserted repository-specific or task-word routing outcomes were removed rather than rewritten to preserve their old behavior. They encoded the exact heuristic pattern that v0.2C-S is replacing. New coverage is mechanism-level:

- exact paths and objective failure references remain deterministic;
- native compression preserves file attribution and never leaks raw evidence into metrics;
- MCP callers share the intended session ledger;
- shadow routing leaves served output unchanged;
- timed-out attempts are quality-incomplete and cannot generate token claims;
- normal enable remains deterministic, while semantic shadow evaluation requires explicit opt-in.

Wall-clock latency comparisons were also removed from parallel unit tests. Latency is measured only in the isolated benchmark tiers, where machine load and cache state are part of the run manifest; functional shadow tests still require byte-equivalent delivery and identical realized metrics.

## Required proof before promotion

The unified branch must pass typecheck, the full Vitest suite, build, semantic architecture guard, license/header/notices checks, direct package-content validation, clean packed-package install/enable/disable smoke, benchmark Tier A, and the five-language Tier B operational smoke. None of those operational checks is an effectiveness result. Ranker tuning, holdout opening, and paid Claude/ReasonBlocks work remain blocked until the separate effectiveness gates pass.
