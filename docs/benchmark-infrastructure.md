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

The ranker profile checks the campaign manifest, artifact hashes, exact train/calibration case IDs, lineage isolation, Git branch and upstream state, pinned runtimes, dependencies, free disk, retained cache size, and the local semantic model. It never downloads a model or opens holdout. Cache usage warns at 80% of its configured ceiling and fails preflight above the ceiling.

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

### Bounded cache retention

An earlier materialization cache exceeded 30 GiB because every implementation fingerprint retained another full SQLite snapshot and completed per-case resume journals were never retired. That was a retention defect, not expected repository growth.

The permanent cache contract is:

- `artifacts/ranker-checkouts` has an 8 GiB default retained-size ceiling and an 80% low-water target;
- repository caches, semantic snapshot caches, lineage caches, and repository-index snapshots are registered in `cache-ledger.v1.json`;
- eviction is least-recently-used, while active repository checkouts carry expiring leases and cannot be evicted;
- SQLite snapshots are normalized to a checkout-independent root and stored once by SHA-256, so distinct cache keys share byte-identical database blobs;
- successful resumable materialization replaces per-case journals with one checksummed receipt; interrupted runs retain their atomic journals;
- legacy v1 snapshot pairs are adopted into the ledger automatically;
- corrupt or ambiguous entries fail closed and remain visible to cache inspection.

```bash
# Read-only corruption findings plus quota/LRU status.
pnpm benchmark:cache

# Apply LRU cleanup if retained data is over the ceiling.
pnpm benchmark:cache -- --prune

# Inspect behavior under a temporary smaller ceiling.
pnpm benchmark:cache -- --max-bytes 4294967296
```

The ceiling can be changed deliberately with `KAIRN_BENCHMARK_CACHE_MAX_BYTES`. `KAIRN_BENCHMARK_CACHE_TARGET_RATIO`, `KAIRN_BENCHMARK_CACHE_WARNING_RATIO`, and `KAIRN_BENCHMARK_CACHE_MIN_FREE_BYTES` control low-water, warning, and working-space policy. These are benchmark-cache controls; they do not change repository `.kairn` state gates or the separately bounded semantic-model cache.

`benchmark:cache` is non-destructive by default. `--prune` deletes only ledger-owned, reconstructible cache entries and preserves active leases. `--quarantine <finding-id>` moves exactly one known incomplete/corrupt artifact into `artifacts/cache-quarantine`; neither operation recursively targets an unknown directory.

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

## Frozen v0.2C-R result

The source-bound audit at commit `eb3e23ed5b53f48f49df38ad513c4327eaf701d6` is `completed_negative` with valid infrastructure and data. The canonical reports are `artifacts/rankability-audit.v2.json` and `artifacts/rankability-audit.v2.md`.

Semantic candidate generation improved strict full recall@64 from 26/38 (68.42%) to 28/38 (73.68%) and required-file recall@64 from 51/72 (70.83%) to 57/72 (79.17%). Neither paired 95% confidence interval excludes zero, and strict full recall@128 remains 31/38 (81.58%). Seven cases still miss required source at bounded pool@128, so the zero-miss hard gate fails and the ranker remains frozen.

On the separate 45-case/72-file weak-patch cohort, v170 regresses against v166 on the identical bounded pool: Recall@5 is 69.44% versus 76.39% (-6.94 percentage points; paired 95% CI -15.93 to +4.63) and MRR is 0.4384 versus 0.4636 (-0.0252; paired 95% CI -0.0871 to +0.0137). The next authorized experiment is general candidate coverage through semantic documents, query representation, or candidate fusion. It must rerun the frozen 38-case candidate audit before any reranker work.

## Portable bundles

Routine Tier A/Tier B reports are uploaded as checksummed GitHub Actions artifacts. The manual workflow can attach a checksummed, sanitized milestone bundle to a draft prerelease. Bundles exclude repository checkouts, semantic indexes, credentials, source, prompts, patches, and trajectories.
