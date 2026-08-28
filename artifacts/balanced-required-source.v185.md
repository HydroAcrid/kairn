# Kairn v0.2C balanced required-source baseline

- Status: **completed_baseline**
- Cohort: `kairn-v02c-balanced-required-source-20260828`
- Model: `v185-pairwise-reviewed-negatives`
- Required-file Recall@64: **100.00% (22/22)**
- Strict full case Recall@64: **100.00% (15/15)**
- Required-file Recall@5: 68.18% (15/22)
- MRR: 0.4795
- Calibration ECE: 0.0317
- Generated/vendor top-one violations: 0

## Decision

**freeze_ranking.** v185 already recalls every reviewed required file within 64 on this cohort, leaving no room for the preregistered +5 percentage-point Recall@64 gain. Further ranking iteration would violate the stopping discipline.

## Remaining top-five misses

- `v02c-calibration-python-long_session-097`: `seaborn/utils.py`
- `v02c-calibration-typescript-long_session-106`: `src/components/structures/RoomSearch.tsx`, `src/components/structures/RoomView.tsx`, `src/components/views/rooms/EditMessageComposer.js`, `src/components/views/rooms/RoomSublist.tsx`, `src/components/views/rooms/SendMessageComposer.js`
- `v02c-calibration-cpp-long_session-133`: `include/fmt/std.h`

## Evidence boundary

- The v185 artifact existed and case ranks were inspectable during cohort construction. The deterministic selection rule does not use ranks, but this remains retrospective development evidence.
- These calibration lineages contributed to model development and are not an independent holdout.
- A fresh sealed lineage-disjoint holdout followed by quality-passing live-agent runs.
- The contaminated detached holdout was not accessed.
