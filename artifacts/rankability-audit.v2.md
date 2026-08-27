# Kairn v0.2C-R rankability audit

Infrastructure: **valid**  
Data: **valid**  
Classification: **completed_negative**  
Commit: `eb3e23ed5b53f48f49df38ad513c4327eaf701d6`  
Campaign: `faae90e71d2aaa6eaae0492d51871a7e4f402fb5fd2611e2284a9ed0e827957d`  
Input: `3587ae05d69bf6bab81d93e69090f4916cdf3efd5f8e4d31d9c02e8b6e94ebde`

> Development diagnostic only. A public improvement claim requires sealed-holdout confirmation and quality-passing live-agent results.

## Immutable recorded baselines

| Cohort | Model | Pool | Cases | Files | Recall@5 | MRR | Strict@64 | ECE |
|---|---|---|---:|---:|---:|---:|---:|---:|
| required_source | kairn-evidence-v02c-semantic-v166-candidate | bounded | 10 | 17 | 17.65% | 0.1404 | 60.00% | n/a |
| required_source | kairn-evidence-v02c-semantic-v170-reviewed-probe512-candidate | bounded | 10 | 17 | 17.65% | 0.1309 | 70.00% | n/a |
| weak_patch_calibration | kairn-evidence-v02c-semantic-v166-candidate | probe | 45 | 72 | 76.39% | 0.4634 | 95.56% | 0.0315 |
| weak_patch_calibration | kairn-evidence-v02c-semantic-v170-reviewed-probe512-candidate | probe | 45 | 72 | 69.44% | 0.4380 | 95.56% | 0.0356 |

## Cohorts

- Candidate oracle: 38/38 semantic cases reconstructed.
- Required-source diagnostic: 10 cases / 17 required files.
- Weak-patch calibration: 45 cases.
- Required-source languages: cpp, go, java, typescript.

## Frozen candidate generation (38 cases / 72 required files)

- Baseline: `deterministic-frozen-v73`.
- Candidate: `semantic-frozen-0360c32974311c35f4e604475182ab8f86232775`.
- Strict full recall@64: 26/38 (68.42%) → 28/38 (73.68%).
- Strict full recall@128: 31/38 (81.58%) → 31/38 (81.58%).
- Required-file recall@64: 51/72 (70.83%) → 57/72 (79.17%).
- Required-file recall@128: 59/72 (81.94%) → 60/72 (83.33%).
- Strict@64 delta: +5.26 pp (95% paired CI -7.89 pp to +21.05 pp).
- File@64 delta: +8.33 pp (95% paired CI -9.65 pp to +13.16 pp).

## Same-pool required-source model metrics (10-case diagnostic)

| Model | Cases | Files | Recall@5 | Strict@64 | File@64 | MRR | ECE | Brier | Log loss |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| kairn-evidence-v02c-semantic-v166-candidate | 10 | 17 | 17.65% | 60.00% | 70.59% | 0.1404 | 0.0345 | 0.0603 | 0.2049 |
| kairn-evidence-v02c-semantic-v170-reviewed-probe512-candidate | 10 | 17 | 17.65% | 70.00% | 82.35% | 0.1309 | 0.0386 | 0.0668 | 0.2224 |

## Same-pool weak-patch calibration metrics (45 cases)

| Model | Cases | Files | Recall@5 | Strict@64 | File@64 | MRR | ECE | Brier | Log loss |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| kairn-evidence-v02c-semantic-v166-candidate | 45 | 72 | 76.39% | 95.56% | 97.22% | 0.4636 | 0.0345 | 0.0603 | 0.2049 |
| kairn-evidence-v02c-semantic-v170-reviewed-probe512-candidate | 45 | 72 | 69.44% | 95.56% | 97.22% | 0.4384 | 0.0386 | 0.0668 | 0.2224 |

## Root-cause accounting

| Cause | Required files | Cases |
|---|---:|---:|
| candidate_coverage | 0 | 0 |
| label_quality | 0 | 0 |
| feature_representation | 0 | 0 |
| model_capacity | 0 | 0 |
| unresolved | 14 | 8 |
| ranked | 3 | 2 |

## Decision

Next experiment: **candidate_generation** — 7 of 38 frozen semantic-oracle cases still miss required source at bounded pool@128; the ranker remains frozen.

## Quantified baseline → candidate deltas

- Required-file Recall@5: +0.00 pp (95% paired CI +0.00 pp to +0.00 pp).
- MRR: -0.0095 (95% paired CI -0.2214 to +0.0738).
- Strict full recall@64: +10.00 pp (95% paired CI +0.00 pp to +30.00 pp).

## Weak-patch calibration baseline → candidate deltas

- Required-file Recall@5: -6.94 pp (95% paired CI -15.93 pp to +4.63 pp).
- MRR: -0.0252 (95% paired CI -0.0871 to +0.0137).
- Strict full recall@64: +0.00 pp (95% paired CI +0.00 pp to +0.00 pp).

## Limitations

- The required-source cohort contains 10 cases and 17 files and is diagnostic, not publication-grade evidence.
- The required-source cohort contains no Python cases.
- Language and scenario coverage is uneven; percentages are reported with explicit denominators.
- Weak official-patch positives are evaluated separately from required-source oracles.
- Diagnostic ceiling models are promotion-ineligible and never access the detached holdout.

