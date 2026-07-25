# Evidence ranker training

Kairn's file-relevance model is an L2-regularized pointwise logistic regression with separate Platt calibration. Training and export use Python's standard library; local inference is dependency-free TypeScript.

## v0.2C corpus and reproduction path

The production corpus is built from a sealed `ranker-corpus.v1` manifest and
`lineage-registry.v1` registry. The constructor refuses to emit training JSONL
unless every case has a bounded union of 7–64 candidates, at least one approved
positive, at least six explicit noise/excluded negatives, and a lineage role
matching its split. Non-sample corpora must contain exactly:

- train: 90 cases / 20 repository lineages / 18 cases per language / 6 per language-scenario cell;
- calibration: 45 cases / 10 lineages / 9 per language / 3 per cell;
- sealed holdout: 30 cases / 10 lineages / 6 per language / 2 per cell.

Synthetic variants are restricted to train, must name a natural parent in the
same repository/language/scenario cell, and are capped at two per parent.
Calibration and holdout cases must be natural public benchmark or patch cases.

The curation boundary starts at
`benchmarks/ranker-corpus-intake.v1.json`. Once independently reviewed and
sealed, the materializer indexes each immutable public checkout and obtains
feature vectors from the same bounded query-local candidate path used in
calibrated serving:

```bash
pnpm ranker:intake:public \
  --out artifacts/ranker-corpus-intake.candidates.json \
  --registry-out artifacts/lineage-registry.candidates.json \
  --summary-out artifacts/ranker-corpus-intake.summary.json

pnpm ranker:materialize \
  --intake benchmarks/ranker-corpus-intake.v1.json \
  --out benchmarks/ranker-corpus.v1.json \
  --report-out artifacts/ranker-corpus.materialization.json

pnpm ranker:review-queue \
  --intake artifacts/ranker-corpus-intake.candidates.json \
  --manifest artifacts/ranker-corpus.draft.json \
  --report artifacts/ranker-corpus.draft.report.json \
  --out artifacts/ranker-corpus.review-queue.json

# Split the large queue into immutable-context reviewer batches.
pnpm ranker:review-batches export \
  --queue artifacts/ranker-corpus.review-queue.json \
  --out-dir artifacts/ranker-corpus-review-batches \
  --batch-size 11 \
  --index-out benchmarks/checkpoints/v02c-review-batches.json

# Merge partial progress without treating it as a completed review.
pnpm ranker:review-batches merge \
  --queue artifacts/ranker-corpus.review-queue.json \
  --batch-dir artifacts/ranker-corpus-review-batches \
  --out artifacts/ranker-corpus.review-queue.merged.json \
  --summary-out artifacts/ranker-corpus-review-batch-merge.json

# Before sealing, require all reviewer/timestamp pairs to be complete.
pnpm ranker:review-batches merge \
  --queue artifacts/ranker-corpus.review-queue.json \
  --batch-dir artifacts/ranker-corpus-review-batches \
  --out artifacts/ranker-corpus.review-queue.complete.json \
  --summary-out artifacts/ranker-corpus-review-batch-complete.json \
  --require-complete

# After every queue decision has an independent reviewer and timestamp:
pnpm ranker:apply-reviews \
  --intake artifacts/ranker-corpus-intake.candidates.json \
  --manifest artifacts/ranker-corpus.draft.json \
  --report artifacts/ranker-corpus.draft.report.json \
  --review-queue artifacts/ranker-corpus.review-queue.json \
  --out artifacts/ranker-corpus-intake.reviewed.json \
  --summary-out artifacts/ranker-corpus-review-application.json

# Preserve an unsealed diagnostic checkpoint without committing raw indexes.
pnpm ranker:checkpoint \
  --intake artifacts/ranker-corpus-intake.candidates-v2.json \
  --registry artifacts/lineage-registry.candidates-v2.json \
  --baseline-report artifacts/ranker-corpus.draft-v6-isolated.report.json \
  --manifest artifacts/ranker-corpus.draft-v17-current.json \
  --report artifacts/ranker-corpus.draft-v17-current.report.json \
  --review-queue artifacts/ranker-corpus.review-queue-v17-current.json \
  --snapshot-dir benchmarks/drafts/kairn-evidence-v02c-20260722 \
  --out benchmarks/checkpoints/v02c-retrieval-5e1cad9.json

# Diagnose selected misses without rematerializing the full corpus.
pnpm ranker:materialize \
  --intake artifacts/ranker-corpus-intake.candidates.json \
  --out artifacts/ranker-corpus.case-diagnostic.json \
  --report-out artifacts/ranker-corpus.case-diagnostic.report.json \
  --draft \
  --case-id case-001,case-002
```

The public-intake command selects the exact 165-case, 40-lineage split from
public SWE-bench Verified, SWE-bench Multilingual, and Multi-SWE-bench patch
records. Its output stays in `artifacts/`: source selection is mechanical, not
an approval. Curators review those rows before copying them into the canonical
intake and lineage registry.

During materialization, add `--draft`. Draft mode accepts the checked-in unsealed
intake and emits `sealed: false` candidate vectors plus candidate paths and
typed reasons in the review report. Curators use that report to mark at least
six true noise/excluded candidates per case; only the subsequent non-draft run
can produce a sealed corpus manifest.

The generated review queue is hash-bound to the intake, manifest, report, and
materializer commit. It never auto-fills decisions. It exposes the prompt,
patch sources present/missing from candidate@64, typed candidate reasons, and
blank reviewer fields so the required-source and explicit-noise decisions are
auditable rather than inferred from Kairn's own ranking.

The review-batch workflow makes the queue resumable without weakening those
bindings. Exported batches separate immutable case context from the only
editable `decision` objects. Merge rejects changed context, missing or extra
batches, duplicate or unknown cases, stale source-queue hashes, half-completed
reviewer/timestamp pairs, invalid candidate paths, insufficient noise labels,
and positive/noise overlap. Partial merges preserve honest progress; only
`--require-complete` output may proceed to `ranker:apply-reviews`.

The review-application command is the only supported path from that queue to a
sealed intake. It verifies every source artifact and per-case candidate hash,
requires a named reviewer and timestamp for every case, requires at least six
candidate@64 negatives, rejects positive/noise overlap, and requires a curated
required-source oracle for every holdout case. It copies the lineage registry
beside the reviewed intake when the output directory changes and emits a
checksummed application summary. It never edits the original intake or fills a
decision automatically. The reviewed intake must still pass a fresh non-draft
materialization before it can become the sealed training corpus.

The diagnostic-checkpoint command preserves the exact unreviewed intake and
lineage registry while representing large ignored manifests, reports, and
review queues by SHA-256 and byte count. It validates complete case sets,
process isolation, artifact bindings, lineage roles, and blank review
decisions. Its output is always promotion-ineligible and keeps official-patch
recall separate from unavailable required-source and calibration gates.

Targeted draft diagnostics record the typed task signals and index coverage
counts used for selected cases. Partial materialization is never accepted for
a sealed corpus.

The corpus CLI materializes every case in a fresh child process. This prevents
a parser failure, WebAssembly runtime state, or other process-local cache from
changing later repositories in the campaign. Production manifests must prove
`caseProcessIsolation: true`; the corpus builder rejects older or in-process
production artifacts.

Draft reporting keeps two ground-truth levels separate. Curated
`requiredSourceFiles` determine the strict candidate-recall@64 gate. Official
patch files are weaker positives and are reported through patch-source mean
recall and any-hit rate; missing a weak patch file is disclosed but is not
silently converted into a required-source miss. Every production holdout case
must acquire at least one independently curated required-source oracle before
the corpus builder accepts it.

Production materialization requires a clean Kairn checkout. It fails if a
required source or curated negative is absent from candidate@64, a repository
reference is not a full immutable commit, a lineage crosses splits, or weak
observed-read labels lack a quality-passing record. Local fixture roots are
accepted only behind explicit sample flags used by tests; they cannot enter a
production corpus.

```bash
pnpm ranker:corpus --manifest benchmarks/ranker-corpus.v1.json
pnpm ranker:train --input artifacts/ranker-corpus.jsonl
pnpm ranker:promote --manifest artifacts/ranker-holdout.json
pnpm ranker:reproduce
```

The checked-in intake and production manifests remain `sealed: false` while
curation is incomplete, so these commands fail closed rather than minting
counterfeit calibration evidence. L2 cross-validation groups by
`repositoryLineageId`, not individual task/case IDs. Training fits and reports
calibration, but does not evaluate the sealed holdout; the promotion command is
the single-use holdout opening and records its model/corpus hashes and
evaluation ID.

The checked-in sample is synthetic and exists to prove the build path, not to support promotion claims:

```bash
python3 scripts/train-evidence-ranker.py \
  --input benchmarks/evidence-training.sample.jsonl \
  --out artifacts/sample-evidence-model.json \
  --model-id sample-evidence-v1 \
  --node "$(command -v node)" \
  --public-data-only
```

The command writes a checksummed model artifact, a training manifest, and a model card. The v0.2C candidate model ID is `kairn-evidence-v02c-20260722`. The runtime rejects a model when its feature order, schema hash, keys, coefficients, calibration, thresholds, or checksum differ from the compiled schema.

## Training-row contract

Each JSONL row contains the ordered 26-value `evidence-features-v4` vector and:

- a `repositoryLineageId`, `caseGroupId`, and `split` (`train`, `calibration`, or `holdout`);
- `isPublic: true`, an HTTPS `publicSourceUrl`, and a public/synthetic `dataOrigin`;
- a supported label provenance and its fixed label weight.

The exporter rejects case groups or repository lineages that cross data splits. It also rejects private rows, out-of-range normalized features, arbitrary labels, and label-weight changes. Grouped L2 selection uses repository lineages. Accepted label policies are:

| Provenance | Label | Weight |
|---|---:|---:|
| Required-source oracle | 1 | 1.0 |
| Explicit noise or excluded file | 0 | 1.0 |
| Verified official-patch source | 1 | 0.75 |
| Quality-passing observed read/touch | 1 | 0.25 |

Other candidates must remain unlabeled. Normal customer `.kairn` state is not a training input.

Promotion requires a real public, repository-disjoint corpus and the gates in [product-contract.md](product-contract.md); the sample model must never be represented as calibrated production evidence.

## Promotion gate artifact

Run the ranker on a sealed repository-disjoint holdout and export a
`ranker-promotion.v1` campaign using the structure demonstrated by
`benchmarks/evidence-promotion.sample.json`. Then run:

```bash
python3 scripts/evaluate-ranker-promotion.py \
  --input artifacts/ranker-holdout.json \
  --out artifacts/ranker-promotion-report.json
```

The evaluator fails unless candidate recall at 64, per-language recall,
required-source recall@5, recall@1, MRR, excluded/generated-file discipline,
ECE, ranker latency, prime latency, state size, and verification/source-
invariant non-regression all clear the v0.3 thresholds. Repository lineage
overlap is rejected. The checked-in campaign is explicitly `sampleOnly`; it
tests gate arithmetic and can never make `promotionEligible` true.

Calibrated serving also requires an explicit local artifact. The bundled
hand-authored bootstrap is available only for legacy-served shadow analysis and
is never reported as calibrated behavior.
