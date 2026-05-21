# Kairn SWE-Pro Pass/Pass Evidence Update - 2026-05-21

## Scope

This update continues the roadmap item for fresh non-qutebrowser SWE-Pro evidence before the website/waitlist push. The goal was to find official rows where baseline and Kairn both pass, then measure whether `kairn_codex_session` saves tokens without losing quality or scope discipline.

## Verification Before Live Spend

- `pnpm test`: passed before the live slice.
- `pnpm typecheck`: passed before and after the tiny-directive fix.
- `pnpm build`: passed after the tiny-directive fix.
- `git diff --check`: still pending in the final sweep.

## General Fix Made During The Slice

The Element row exposed a real general bug in tiny directive output, not a repo-specific tuning issue:

- Long official prompts could consume the tiny directive budget before Kairn's start file, edit scope, and selected-test guidance appeared.
- Selected test paths mentioned in the task were not always surfaced as read-only verification context.

Fixes:

- Tiny directives now compact the task line before adding Kairn guidance.
- The edit-scope controller extracts task-mentioned test files and surfaces them as read-only verification context.
- Added tests covering long official prompts where start files and edit scope must remain visible.

## SWE-Pro Rows Run

| Row | Repo | Result | Tokens | Interpretation |
| --- | --- | --- | --- | --- |
| `future-architect/vuls` SNMP2CPE | Go | Baseline local fail, Kairn local pass | baseline 34,232; Kairn 34,912 | Scope/quality rescue only; not pass/pass savings. |
| `navidrome/navidrome` reverse proxy auth | Go | Baseline local fail, Kairn local pass | baseline 80,529; Kairn 75,389 | Scope/quality rescue with 6.38% lower tokens; not pass/pass savings. |
| `element-hq/element-web` PosthogAnalytics, initial | TS | Baseline local+official pass, Kairn local pass but official fail | baseline 55,145; Kairn 43,904 | Local pass/pass savings was invalidated by official eval; led to tiny-directive fix. |
| `element-hq/element-web` PosthogAnalytics, after fix | TS | Kairn official pass; local pass/pass but Kairn higher tokens | baseline 36,062; Kairn 40,382 | Quality fixed, but not a savings win on this repeat. |
| `internetarchive/openlibrary` Standard Ebooks mapper | Python | Baseline official pass, Kairn official pass | baseline 43,827; Kairn 24,034 | Clean official pass/pass savings: 19,793 tokens saved, 45.16%. |
| `gravitational/teleport` X11 display | Go | Baseline local fail, Kairn local pass | baseline 41,215; Kairn 27,874 | Scope/quality rescue with 32.37% lower tokens; not pass/pass savings. |
| `internetarchive/openlibrary` FnToCLI args | Python | Both local pass, Kairn over-assisted | baseline 19,283; Kairn 65,928 | Negative evidence: Kairn active on a cheap row and used far more tokens. |

## Current Evidence Status

This slice produced the first clean official SWE-Pro pass/pass savings row:

- OpenLibrary Standard Ebooks mapper: both baseline and Kairn passed the official evaluator.
- Kairn saved 19,793 observed tokens, or 45.16%.
- Kairn touched only the required production file.

It also produced important negative and corrective evidence:

- The Element row proved local quality gates are not enough; official eval must remain required for SWE-Pro claims.
- The tiny-directive bug was fixed generally and re-tested; the fixed Kairn patch then passed official eval.
- FnToCLI shows Kairn can still over-assist on rows where baseline solves cheaply. This should be counted as negative evidence, not swept away.

## Fresh MCP Endurance Slice

After the SWE-Pro slice, I ran a fresh HTTPCore six-turn endurance suite with baseline vs `real_mcp_first`.

Artifact:

- `docs/publication-evidence-20260521/endurance-httpcore/real-mcp-repeat3.json`

Repeat-3 result:

| Mode | Quality | Median observed tokens | Median savings | MCP calls | Useful MCP files | Scope violations |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 3/3 | 70,182 | n/a | 0 | 0 | 0 |
| real_mcp_first | 3/3 | 38,449 | 53.65% | 3 | 3 | 0 |

Interpretation:

- This is strong fresh MCP endurance evidence: all repeats passed quality, MCP calls were real, and every returned MCP file was useful.
- The suite still records mixed evidence because one repeat over-assisted relative to that repeat's baseline, but the median result is strongly positive.
- This supports the product claim better than another one-shot row: MCP can be called sparingly, return the right source file, and preserve quality over multiple turns.

## Claim Impact

Safe claim after this slice:

> In a fresh non-qutebrowser SWE-Pro expansion, Kairn produced one clean official pass/pass savings row at 45.16% fewer observed tokens, plus several quality/scope rescue rows. The slice also found and fixed a general tiny-directive budget bug, and it found one over-assist row that needs further suppression work.

Do not claim yet:

- Kairn consistently saves on SWE-Pro overall.
- SWE-Pro median savings is positive across this slice.
- The official benchmark story is complete.

## Next Step

The next product step is website/waitlist preparation, while internal testing continues in parallel. Evidence that should be carried forward:

- one official SWE-Pro pass/pass savings row,
- several SWE-Pro quality/scope rescue rows,
- one fixed tiny-directive quality miss,
- one SWE-Pro over-assist row to keep the claims honest,
- one fresh MCP endurance repeat-3 row with 53.65% median savings and real useful MCP calls.
