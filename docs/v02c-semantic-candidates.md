# v0.2C-S Model-Based Semantic Candidates

Status: implementation complete enough for frozen candidate-gate evaluation; promotion is not yet approved.

## Contract

Kairn's permanent evidence path is:

`structural parsers → independent candidate generators → local semantic retrieval → calibrated file ranker → deterministic governor`

Parsers extract objective facts. The local embedding model supplies semantic similarity. The logistic file ranker estimates required-source probability. Deterministic policy owns hard pins, generated/vendor exclusions, delivery, budgets, repeated-context suppression, and abstention.

No regular expression, filename token, task token, benchmark identity, repository identity, or fixture identity may create semantic relevance. `pnpm check:semantic-architecture` enforces the semantic-serving boundary.

## Runtime

The preferred model is `jina-code-v2-q8`, pinned to upstream revision `516f4baf13dec4ddddda8631e019b5737c8bc250`. BGE small remains the evaluated fallback candidate. Both use immutable manifests, CPU-only ONNX inference, local tokenizers, checksummed atomic installation, normalized embeddings, and compact int8 repository storage.

```bash
kairn model status
kairn model install
kairn model verify
kairn model remove
kairn enable --offline
```

Retrieval performs no network call. A missing, corrupt, incompatible, or stale model/index falls back visibly to exact path, precise failure, exact symbol, BM25, git, session, and graph evidence.

## Candidate Flow

1. Hard-pin exact paths and precise failure references.
2. Independently rank semantic, BM25, exact-symbol, git, and session candidates.
3. Search the full available semantic embedding index.
4. Collapse semantic documents to files by maximum normalized cosine similarity.
5. Fuse non-hard rankings with reciprocal-rank fusion.
6. Keep at most 64 initial candidates.
7. Add only direct graph and source/test neighbors, capped at 128.
8. Build `evidence-features-v5` for the bounded union. The v5 schema retains
   real semantic similarity and adds objective parser-graph precision,
   independent-seed consensus, bounded support, supporting-seed strength, and
   independent retrieval evidence as model inputs. It also exposes a typed
   model-corroborated reverse-importer fact rather than assigning that relation
   a deterministic bonus. Probe-seed facts are passed
   through from candidate generation instead of being recomputed from only the
   first 64 files; none of these facts directly assigns relevance.
9. Rank files with the calibrated logistic artifact when enabled.
10. Let deterministic policy select content, path hint, request-evidence, suppression, or abstention.

`legacy` and `shadow` remain rollback modes through v0.3. Semantic mode never uses the old hashed vectors as relevance evidence.

## Frozen Evidence

Tracked checkpoints:

- `benchmarks/checkpoints/v02c-semantic-baseline-cf43ef8.json`
- `benchmarks/checkpoints/v02c-semantic-model-selection-v4-d5aa740.json`
- `benchmarks/checkpoints/v02c-semantic-holdout-v4-566f912.json`
- `benchmarks/semantic/oracle38-cases-v1.json`
- `artifacts/ranker-corpus-intake.reviewed-v35.json`
- `artifacts/lineage-registry.reviewed-v35.json`

The reviewed intake is pinned by SHA-256
`bcfe94973f9e93964a2bd0473addb3c1f43a0b4fed1168de690214db36629fa6`.
The 38-case manifest freezes the cases whose required production source
existed in the checkout used by the legacy baseline. The raw 165-case
candidate intake is not a valid recall oracle because it predates the
reviewed required-source labels.

Legacy public-oracle baseline:

- strict full required-source Recall@64: 26/38 = 68.42%;
- strict full required-source Recall@128: 31/38 = 81.58%;
- zero-positive cases at 128: 3.

Frozen v4 model selection:

| Model | Recall@1 | Recall@5 | MRR | Median query latency |
| --- | ---: | ---: | ---: | ---: |
| Jina code | 100% | 100% | 1.000 | 29.543 ms |
| BGE small | 70% | 100% | 0.833 | 14.434 ms |

Fresh Jina v4 holdout:

- ranks: Python 1, TypeScript 3, Go 1, Java 12, C++ 1;
- Recall@1: 60%;
- Recall@5: 80%;
- strict full Recall@64 and Recall@128: 100%;
- MRR: 0.683333;
- zero positive misses at 128: 0.

The Java rank-12 result is a disclosed negative ranking result. It is acceptable for the candidate-generation gate, not proof that the downstream ranker is ready.

Runtime at 7,500 documents:

- cold initialization: 1,051.56 ms;
- query p95: 26.763 ms;
- vector scan p95: 12.594 ms;
- combined warm upper bound: 39.357 ms;
- projected initial embedding: 20.57 minutes.

## Public Calibration Repair

The first Babel calibration attempt missed the required parser source at 64 because the large file had only a file summary and class document. The general repair added JS/TS method extraction and replaced first-symbol allocation with bounded weighted allocation across files plus even sampling within each file.

No target term, filename, symbol, repository, or issue phrase was added to retrieval policy.

On the same 24,759-file checkout, the required source moved into the real serving union at rank 12/64 with semantic similarity `0.661666`. State grew from 149,463,144 to 159,146,088 bytes.

## Promotion Gate

The resumable public-oracle materialization writes:

- `artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.json`
- `artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.report.json`
- `artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.json.progress.json`

Each successful isolated case is written atomically to the progress file.
`--resume` refuses to reuse progress unless the Kairn commit, reviewed-intake
hash, and ordered case set are identical.

```bash
CASE_IDS="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("benchmarks/semantic/oracle38-cases-v1.json","utf8"));process.stdout.write(x.caseIds.join(","))')"
KAIRN_CANDIDATE_MODE=semantic \
KAIRN_SEMANTIC_MODEL=jina-code-v2-q8 \
KAIRN_SEMANTIC_THREADS=4 \
pnpm exec tsx scripts/materialize-evidence-corpus.ts \
  --intake artifacts/ranker-corpus-intake.reviewed-v35.json \
  --out artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.json \
  --report-out artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.report.json \
  --cache artifacts/ranker-checkouts \
  --draft \
  --case-id "$CASE_IDS" \
  --migrate-feature-schema \
  --resume
```

Promotion remains blocked until:

- strict full required-source Recall@64 is 38/38;
- per-language Recall@64 is at least 95%;
- zero positive cases miss at 128;
- generated/vendor top-one is zero unless objective evidence references it;
- state and runtime limits pass;
- ranker data is rebuilt against the frozen semantic union;
- downstream Recall@5, MRR, calibration, verification, and source-invariant gates pass.

The 35 reviews against the legacy union are `superseded-pending`. Claude/ReasonBlocks spend, the 180-attempt pilot, and npm beta preparation remain paused.
