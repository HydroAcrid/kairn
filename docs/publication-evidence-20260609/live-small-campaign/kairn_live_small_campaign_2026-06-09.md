# Kairn Live Small Campaign - 2026-06-09

## Purpose

This was a proxy-first harness validation run, not a public evidence update. The goal was to prove the new campaign harness can catch bad source-surface decisions before spending live Codex/Docker time, then run a small set of live controls and MCP checks only where the local signal was acceptable.

The tracked manifest uses `KAIRN_CLI_PATH` for Kairn CLI commands so it can be rerun without storing a machine-specific absolute path.

## Summary

- Proxy stage ran on four SWE-Pro-derived rows.
- Two rows passed proxy and were allowed into live local proof runs.
- Two rows were blocked as `wrong_surface_risk`, saving live spend.
- MCP smoke passed with useful attribution.
- Fastify MCP endurance repeat-1 passed with clean savings and useful MCP attribution.
- No quality drops, harmful assists, or scope violations appeared in live rows.
- This run is not sufficient for public claim changes.

## Proxy Gate

| Entry | Result | Signal |
| --- | --- | --- |
| OpenLibrary row 2 | passed | proxy surface matched enough to spend live |
| Vuls row 3 | blocked | `wrong_surface_risk` |
| Element row 9 | blocked | `wrong_surface_risk` |
| Element row 10 | passed | proxy surface matched enough to spend live |

The expected-source proxy check worked as intended: it stopped rows where Kairn's first source surface missed the known target class instead of letting the campaign spend live agent time.

## Live Results

| Entry | Type | Baseline tokens | Kairn tokens | Result | Notes |
| --- | --- | ---: | ---: | --- | --- |
| OpenLibrary row 2 | SWE-Pro local proof/control | 43,173 | 54,229 | token regression | Quality passed and scope passed, but Kairn used 11,056 more tokens. |
| Element row 10 | SWE-Pro local proof/control | 37,640 | 25,991 | clean pass/pass | Quality passed and scope passed with 11,649 tokens avoided. |
| MCP smoke | MCP protocol check | n/a | n/a | passed | Recorded 2 MCP calls and 1 useful attribution. |
| Fastify endurance repeat-1 | MCP/endurance | 122,141 | 36,060 | clean pass/pass | Repeat-1 only; recorded 86,081 tokens avoided, 2 MCP calls, and 2 useful attributions. |

## Interpretation

The harness is now useful for iteration. It caught two source-surface risks before live spend, preserved local quality on the live rows that ran, and produced combined campaign summaries from separately executed `--only` runs.

The OpenLibrary token regression is the next sizing target. Kairn had enough quality signal to pass, but emitted more context than the baseline needed. This should be treated as a conditional sizing issue for narrow paired-source/form/request-body style tasks, not a reason to suppress all first-turn guardrails.

The Vuls and Element proxy failures remain routing targets:

- Vuls: improve converter/source-owner routing when scanner-like files are tempting but not the task owner.
- Element row 9: improve frontend ownership routing for device/listener-style source surfaces.

The MCP path looked healthy in this small run, but Fastify is only repeat-1. Treat it as a smoke/supporting result until repeat-3 or a broader MCP/endurance campaign confirms it.

## Next Actions

1. Fix the remaining source-surface classes from the proxy failures.
2. Tighten narrow paired-source sizing so Kairn avoids pass/pass token regressions like OpenLibrary row 2.
3. Rerun this small campaign after the fixes.
4. Only after that, run a fresh official SWE-Pro slice and a repeat-3 MCP/endurance suite.

## Public Claim Status

No website, launch copy, or public evidence claim should be updated from this run.
