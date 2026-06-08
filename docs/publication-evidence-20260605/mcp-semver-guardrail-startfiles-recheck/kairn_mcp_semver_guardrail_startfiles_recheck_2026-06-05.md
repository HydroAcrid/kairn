# Kairn MCP SemVer Guardrail Recheck - 2026-06-05

## Summary

This focused recheck reran the Node SemVer endurance suite after the post-governor MCP campaign exposed a repeated quality-risk class. The suite was run repeat-3 with baseline, `real_mcp_first`, and `hybrid_mcp_brief`.

The quality-risk class did not reproduce in this recheck. Both MCP modes passed all three repeats, saved tokens against the baseline median, and recorded zero harmful assists.

## Results

| Mode | Quality passes | Median observed tokens | Median saved tokens | Reduction | Valid savings | Harmful runs | MCP calls | Useful attribution | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | 3/3 | 87,461 | n/a | n/a | 0 | 0 | 0 | 0 | baseline |
| real_mcp_first | 3/3 | 43,709 | 41,957 | 47.97% | 3 | 0 | 3 | 3 | consistent_win |
| hybrid_mcp_brief | 3/3 | 44,785 | 38,101 | 43.56% | 3 | 0 | 3 | 3 | consistent_win |

## Interpretation

This is a positive MCP recheck: SemVer moved from quality-risk in the prior repeat-3 campaign to clean repeat-3 pass/pass savings here.

Useful source attribution was captured through guided/attributed source files. Returned-file count remains zero for this suite, so this should be reported as MCP guided/attributed evidence rather than direct returned-file evidence.

## Code Change In This Cycle

Cheap one-shot MCP guardrails now return the primary source as a start file while still suppressing source snippets and additional context. This improves the MCP response contract for clients that need a concrete file handle but should not receive broad context.

The live SemVer repeat-3 completed before `dist/cli.js` was rebuilt with that start-file contract, so the SemVer result should be interpreted as an MCP workflow recheck rather than proof that this specific code change caused the win. The contract change is covered by MCP unit tests and the repo has since been rebuilt locally.

## Public Claim Status

This recheck supports the MCP evidence story, but it should not be turned into a standalone public headline. It is best used as supporting evidence that the post-governor MCP path no longer reproduces the SemVer quality-risk class.
