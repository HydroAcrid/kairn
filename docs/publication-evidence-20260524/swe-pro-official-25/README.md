# SWE-Pro Official 25 Evidence Bundle

This directory keeps the publication-safe evidence for the 25-row official SWE-Pro campaign.

Tracked files are the curated artifacts needed to reproduce the claims:

- `campaign-manifest.json`
- `campaign-summary.json`
- `results.csv`
- `failures.csv`
- `seed-5-inventory.json`
- `new-20-manifest.json`
- `batch-summaries/`
- `preflight-summaries/`
- `fix-log.md`

Raw evaluator output, generated patches, transient preflight workdirs, stdout dumps, and local run folders are intentionally ignored by git. They are too large and can contain noisy benchmark internals that should not be treated as public-facing evidence. Regenerate or recover those from the manifests when deeper debugging is needed.
