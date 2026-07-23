# Ranker diagnostic checkpoints

These compact files disclose unsealed retrieval diagnostics without committing
multi-megabyte indexes and review queues. They are not model cards, calibrated
results, token-efficiency evidence, or promotion artifacts.

Recreate a checkpoint with `pnpm ranker:checkpoint` and the exact raw artifact
paths recorded in the checkpoint. The command fails when inputs are partial,
not process-isolated, hash-mismatched, case-incomplete, or already contain
reviewer decisions.
