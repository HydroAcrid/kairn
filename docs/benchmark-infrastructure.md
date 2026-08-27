# v0.2C benchmark infrastructure

Kairn separates infrastructure validity, data validity, and product effectiveness. A provider, Docker, trace, artifact, or environment failure cannot be reported as a Kairn win or loss. A valid negative result is retained as `completed_negative` evidence.

## Pinned environment

- Node 24 (`.node-version`)
- pnpm 10.31.0 (`packageManager`)
- Python 3.12 (`.python-version`)
- Jina Code v2 Q8 at revision `516f4baf13dec4ddddda8631e019b5737c8bc250`

Run infrastructure checks from `codex/v0.2c-benchmark-infrastructure`. Run the frozen rankability audit from `codex/v0.2c-rankability-audit`. On the current WSL host, activate the pinned runtimes before any evidence command:

```bash
export PATH=/home/kevin_dotel/.nvm/versions/node/v24.18.0/bin:/home/kevin_dotel/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu/bin:/usr/local/bin:/usr/bin:/bin
```

The default WSL Node 18 / Python 3.10 environment is invalid for this campaign.

## Preflight

```bash
pnpm benchmark:doctor -- --profile ranker --manifest benchmarks/campaigns/v02c-rankability-audit.json
pnpm benchmark:doctor -- --profile live
```

The ranker profile checks the campaign manifest, artifact hashes, exact train/calibration case IDs, lineage isolation, Git branch and upstream state, pinned runtimes, dependencies, free disk, and the local semantic model. It never downloads a model or opens holdout.

The live profile additionally requires a working Docker server, locally present digest-pinned images in `KAIRN_BENCHMARK_IMAGES`, both provider credentials, and `KAIRN_ALLOW_EXTERNAL_TRAJECTORY=1`. Credentials are never printed or hashed into public output.

Effectiveness preflight requires a clean pushed commit. Dirty development fixtures are allowed only when the campaign is permanently marked `nonEvidence: true`.

## Validation tiers

```bash
# Offline fixture/contracts; target below two minutes.
pnpm benchmark:tier-a

# Real installed Jina model; five languages; target below fifteen minutes.
pnpm benchmark:tier-b
```

Tier A performs type checking, contract and fault tests, fake four-arm trace validation, the semantic architecture guard, and two deterministic sample-model builds. It does not clone repositories, download models, use Docker, or call providers.

Tier B creates a disposable Python/TypeScript/Go/Java/C++ repository and runs the production semantic index in isolated processes. The first run embeds all documents, the second must reuse every embedding and reproduce rankings within `1e-5`, and a changed source file must re-embed incrementally. It is pipeline evidence, never retrieval-quality evidence.

## Campaign and run artifacts

The canonical campaign is `benchmarks/campaigns/v02c-infrastructure.json`. It pins artifact hashes and exact case membership through the reviewed JSONL rows. The detached holdout artifact is allowed only in the holdout stage.

```bash
pnpm benchmark:reproduce -- --stage tier_a
pnpm benchmark:reproduce -- --stage calibration
pnpm benchmark:cache
```

Runs live under `artifacts/runs/<campaign>/<run>/`. The run manifest binds the campaign fingerprint, source commit, stage, and evidence status. The artifact index records producer commands, inputs, hashes, schemas, byte sizes, and timestamps. Resume refuses a changed source commit, campaign fingerprint, or stage.

Calibration reproduction retrains v166 and v170 from their pinned rows and requires byte-identical model artifacts before producing their same-cohort comparison. It does not open holdout. A corrupt output is quarantined and rebuilt; the run remains invalid unless the rebuilt output matches the originally registered hash.

Corpus materialization caches repository inventory/parser/index snapshots separately from semantic embeddings, candidate fusion, labels, training rows, and models. Immutable cases at the same repository commit restore the index into a fresh detached worktree and relocate only index-owned rows; session, telemetry, and evaluation state are never copied. Parser/document/model changes invalidate the snapshot, while reporting or ranker-training changes reuse it. Snapshot database/manifest pairs are checksummed and fail closed when incomplete or corrupt.

`benchmark:cache` is read-only by default. `--quarantine <finding-id>` moves exactly one known incomplete/corrupt artifact into `artifacts/cache-quarantine`; it never recursively deletes caches or worktrees.

## Reporting and rankability

```bash
pnpm benchmark:rankability-audit -- \
  --manifest benchmarks/campaigns/v02c-rankability-audit.json \
  --run-id <id> \
  --resume
```

Candidate-generation comparisons use the same frozen 38-case oracle. Ranker comparisons require identical split, case IDs, candidate-manifest hash, and materialization-report hash. Reports refuse cross-population percentages.

Raw candidate recall@64 is diagnostic. Promotion requires zero required-source misses in the bounded pool at 128, served recall@64 of at least 99% overall and 95% per language, ECE at most 0.05, and zero unreferenced generated/vendor top-one results. Recall@5, MRR, verification, and source-invariant results remain separate gates.

The audit registers `rankability-audit.v2` JSON and Markdown in the content-addressed run ledger. It is calibration-only and `promotionEligible: false`. For each required file it records candidate-stage and lane ranks, v166/v170 scores and feature contributions, higher-ranked labels, exact/near feature collisions, paired confidence intervals, root-cause classification, and the mechanism-selected next experiment. Pairwise-linear and shallow-nonlinear probes are diagnostic ceilings only.

The 38-case deterministic-versus-semantic candidate comparison, 10-case/17-file required-source audit, and 45-case calibration cohort are distinct populations and are never merged into one percentage. The required-source cohort has no Python cases and uneven language/scenario coverage, so its results remain internal diagnostics. Any public claim requires sealed-holdout confirmation plus quality-passing live-agent runs and provider-observed token measurements.

## Portable bundles

Routine Tier A/Tier B reports are uploaded as checksummed GitHub Actions artifacts. The manual workflow can attach a checksummed, sanitized milestone bundle to a draft prerelease. Bundles exclude repository checkouts, semantic indexes, credentials, source, prompts, patches, and trajectories.
