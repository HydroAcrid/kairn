# Ranker diagnostic checkpoints

These compact files disclose unsealed retrieval diagnostics without committing
multi-megabyte indexes and review queues. They are not model cards, calibrated
results, token-efficiency evidence, or promotion artifacts.

Recreate a checkpoint with `pnpm ranker:checkpoint` and the exact raw artifact
paths recorded in the checkpoint. The command fails when inputs are partial,
not process-isolated, hash-mismatched, case-incomplete, or already contain
reviewer decisions.

`ranker-corpus-review-batch-index.v1` files preserve the source-queue hash,
exact case coverage, and immutable context hashes for reviewer batches. The
batch payloads remain under ignored `artifacts/` while review is in progress;
only a complete merged queue that also passes `ranker:apply-reviews` may become
a sealed intake.

`ranker-corpus-review-decision-checkpoint.v1` files preserve only completed,
independently attributed decisions plus their immutable case and candidate
hashes. They are compact enough to commit while review is in progress and
remain promotion-ineligible until every case is complete and the reviewed
intake is freshly materialized and sealed.

Required-source decisions may reference a bound official source oracle even
when that path is absent from candidate@64. This preserves genuine retrieval
misses for recall evaluation. Explicit-noise decisions remain restricted to
the frozen candidate set.
