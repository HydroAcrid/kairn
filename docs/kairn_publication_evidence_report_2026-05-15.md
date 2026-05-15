# Kairn Publication Evidence Campaign v2

Status: implementation and dry-run bundle prepared.

This campaign freezes Kairn for a publication-grade validation pass. It separates controlled benchmark evidence, official benchmark evidence, SWE-ContextBench context-reuse evidence, SWE-Atlas/QnA source-grounding evidence, and private beta telemetry.

## Frozen Bundle

- Plan: `examples/bench/publication-plan-v2.json`
- Evidence directory: `docs/publication-evidence-20260515/`
- Manifest: `docs/publication-evidence-20260515/publication-manifest.json`
- Dry-run report: `docs/publication-evidence-20260515/kairn_publication_evidence_report_2026-05-15.md`
- Results CSV: `docs/publication-evidence-20260515/publication-results.csv`
- Failures CSV: `docs/publication-evidence-20260515/publication-failures.csv`
- Private beta telemetry summary: `docs/private-beta-telemetry-summary-20260515.md`

## Implemented Campaign Scope

- Fresh unseen preflight: `repo-matrix-fresh-holdout-v4`.
- Fresh repeat-5 one-shot live proof: `seeded-fresh-holdout-v2`.
- Endurance repeat-3: Requests 10-turn and FastAPI.
- MCP smoke: local protocol delivery check.
- SWE-Pro official evaluator gate: selected row ids are recorded, but savings are blocked unless official evaluator JSON is attached and passes.
- SWE-ContextBench pilot: related-task metadata adapter with base/related grouping and source-reuse preflight artifacts.
- SWE-Atlas/QnA: retained as source-grounding and evidence-request support, not the main token-savings proof.

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope discipline passes, and official evaluator requirements are satisfied.
- Suppressed/passive savings are reported separately as abstention evidence.
- SWE-Pro savings are invalid until official Docker evaluator results pass.
- Private beta telemetry is supporting evidence only; it is sanitized and excludes prompts, source, paths, filenames, diffs, repo names, branch names, and raw command output.

## Next Live Commands

Dry run:

```sh
kairn bench publication --plan examples/bench/publication-plan-v2.json --out-dir docs/publication-evidence-20260515 --dry-run
```

Run one frozen slice first:

```sh
kairn bench publication --plan examples/bench/publication-plan-v2.json --out-dir docs/publication-evidence-20260515 --only fresh-unseen-v4-preflight
```

Then continue with repeat-5 and endurance only if preflight passes.

## Verification

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- `npm pack --pack-destination /tmp/kairn-evidence-v2-pack`
- temp-prefix install smoke: `kairn --version` and `kairn doctor --json`
