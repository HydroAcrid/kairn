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

```bash
pnpm ranker:corpus -- --manifest benchmarks/ranker-corpus.v1.json
pnpm ranker:train -- --input artifacts/ranker-corpus.jsonl
pnpm ranker:promote -- --manifest artifacts/ranker-holdout.json
pnpm ranker:reproduce
```

The checked-in production manifest remains `sealed: false` while curation is
incomplete, so these commands fail closed rather than minting counterfeit
calibration evidence. L2 cross-validation groups by `repositoryLineageId`, not
individual task/case IDs. Training fits and reports calibration, but does not
evaluate the sealed holdout; the promotion command is the single-use holdout
opening and records its model/corpus hashes and evaluation ID.

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

Each JSONL row contains the ordered 21-value `evidence-features-v1` vector and:

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
