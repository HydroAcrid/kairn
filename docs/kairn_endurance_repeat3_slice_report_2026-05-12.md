# Kairn Endurance Repeat Slice Report - 2026-05-12

## Summary

This pass reran the long-session endurance slice after the fresh holdout/MCP improvements. The goal was not another one-shot retrieval proof. The question was:

> Does Kairn stay useful after turn 1, avoid repeated context, and preserve quality over a multi-turn coding session?

We ran Requests repeat-3 first, then started Gin. Gin exposed an over-assist issue, so the run was stopped before wasting repeat budget. Kairn was updated, then Gin was rerun twice to validate the fix.

## Artifacts

Requests repeat-3:

- `/tmp/kairn-endurance-repeat3-20260512/requests-r1.json`
- `/tmp/kairn-endurance-repeat3-20260512/requests-r2.json`
- `/tmp/kairn-endurance-repeat3-20260512/requests-r3.json`

Gin:

- Pre-fix issue: `/tmp/kairn-endurance-repeat3-20260512/gin-r1.json`
- After invariant alignment + shorter known-source prompt: `/tmp/kairn-endurance-gin-post-fix-20260512.json`
- After MCP prepare wording change: `/tmp/kairn-endurance-gin-mcp-abstain-20260512.json`
- After obvious single-source abstention: `/tmp/kairn-endurance-gin-obvious-abstain-20260512.json`

## Requests Repeat-3

All modes passed quality `3/3`.

| Mode | Median Tokens | Median Savings | Quality | Assistance |
| --- | ---: | ---: | --- | --- |
| Baseline | 70,387 | control | 3/3 | none |
| Direct Kairn | 48,880 | 31.28% | 3/3 | active |
| Hook full-prime | 54,680 | 23.13% | 3/3 | active |
| Real MCP-first | 48,730 | 20.41% | 3/3 | active |
| Hybrid MCP-brief | 55,632 | 18.09% | 3/3 | active |

Ledger behavior:

- Hybrid avoided `9` repeated file context events and `3` repeated snippet events across the three repeats.
- MCP-first used the known-source continuation path after diagnosis.
- Quality gates stayed green across all runs.

Interpretation:

- The long-session mechanism is working on Requests.
- The installed surfaces stayed useful after turn 1.
- Direct Kairn and hook were strongest, but MCP/hybrid were also positive and active.

## Gin Issue

The first Gin run preserved quality but over-assisted:

| Mode | Tokens | Savings | Quality | Classification |
| --- | ---: | ---: | --- | --- |
| Baseline | 52,208 | control | pass | none |
| Direct Kairn | 52,147 | 0.12% | pass | valid, negligible |
| Hook full-prime | 73,149 | -40.11% | pass | over-assist |
| Real MCP-first | 63,495 | -21.62% | pass | over-assist |
| Hybrid MCP-brief | 65,340 | -25.15% | pass | over-assist |

Root causes:

1. Session policy correctly shrank delivery to `routergroup.go`, but invariant metadata could still be derived from the pre-policy primary file (`gin.go`). That created confusing guidance.
2. MCP/endurance first-turn guidance still pushed Kairn too eagerly for a short, obvious source-symbol task.

## Fixes Made

1. `KairnRuntime.primeContext` now realigns invariants to the final delivered files after session-policy file overrides.
2. Endurance MCP known-source continuation prompts are shorter after diagnosis.
3. Endurance MCP first-turn guidance now says to call Kairn only before broad, unclear, multi-file, or failure-driven reads.
4. Endurance added an `obvious_single_source_abstain` guidance path for short single-source symbol tasks.

These are behavior-class fixes, not Gin-specific rules.

## Gin After Fixes

Final post-fix run:

| Mode | Tokens | Savings | Quality | Classification |
| --- | ---: | ---: | --- | --- |
| Baseline | 87,032 | control | pass | none |
| Direct Kairn | 35,465 | 59.25% | pass | active valid assist |
| Hook full-prime | 79,519 | 8.63% | pass | active valid assist |
| Real MCP-first | 62,087 | 28.66% | pass | passive/suppressed |
| Hybrid MCP-brief | 38,776 | 55.45% | pass | passive/suppressed |

Important: MCP/hybrid savings in the final Gin run are **passive evidence**, not active MCP wins, because the correct behavior for this cheap obvious source task was to abstain from MCP calls.

The useful result is not “MCP won Gin.” The useful result is:

> Kairn avoided harming a cheap obvious source task by staying quiet, while direct/hook paths still preserved quality and saved tokens.

## Verification/Cleanup Suppression Follow-Up

After the final Gin run, Kairn added product-level verification/cleanup suppression:

- `verified_context_suppressed` for automatic hook/MCP/benchmark delivery after a passing check and no unresolved failure.
- `verify the fix` now counts as verification rather than implementation just because the prompt contains the noun `fix`.
- `review the final diff` now counts as cleanup.

Artifacts:

- Full five-mode canary: `/tmp/kairn-endurance-gin-verified-suppress-20260512.json`
- Hook-focused canary before the classifier fix: `/tmp/kairn-endurance-gin-hook-verified-suppress-20260512.json`
- Hook-focused canary after the classifier fix: `/tmp/kairn-endurance-gin-hook-verified-suppress-v2-20260512.json`

Latest hook-focused canary:

| Mode | Tokens | Quality | Assistance | Classification |
| --- | ---: | --- | --- | --- |
| Baseline | 65,864 | pass | none | control |
| Direct Kairn | 98,888 | pass | active | over-assist |
| Hook full-prime | 127,477 | pass | passive/suppressed | missed opportunity / no active Kairn win |

Interpretation:

- The hook path did stop emitting after verification/cleanup; that part is fixed.
- The run still does not count as a hook win because passive/suppressed runs cannot claim active savings.
- Gin remains a high-variance cheap-source canary. The next useful improvement is repeat-aware endurance aggregation and a broader repeat slice, not hand-tuning Gin further.

## Current Conclusion

The endurance mechanism is working on Requests and improved on Gin:

- Requests repeat-3 gives a quality-passing positive endurance result across direct, hook, MCP, and hybrid.
- Gin exposed real over-assist, and the fix changed the behavior class from harmful active assistance to safe abstention for MCP/hybrid.
- Hook/direct showed both wins and over-assist on Gin, so Gin should stay a regression canary rather than the product compass.
- MCP/hybrid correctly stop claiming active wins when they abstain.

## Next Steps

1. Add built-in repeat/partial aggregation to `bench endurance`.
   Shell loops are too slow and awkward for this workflow.

2. Rerun Gin repeat-3 after the abstention change.
   The single post-fix run is good, but repeat evidence is still needed.

3. Expand to Axios or Flask only after Gin repeat-3 stays safe.

4. Keep product framing precise:
   - cheap obvious tasks: abstain or tiny guardrail;
   - source-rescue tasks: active one-file guidance;
   - multi-turn tasks: source lock + no repeated context;
   - MCP/hybrid: only count active savings when actual useful MCP/failure guidance happened.
