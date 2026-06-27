# MCP Four-Arm Matrix - 2026-06-26

This matrix compares the same source-bearing MCP scenarios across four arms: raw baseline, Headroom-only compression, Kairn-only governance/context output, and Kairn followed by Headroom compression. Token counts use Headroom MCP reported token fields for both raw and Kairn payloads.

| Scenario | Baseline | Headroom only | Kairn only | Kairn + Headroom | Best | Combo vs Kairn | Heavy lift | Attribution |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| Exact source MCP server | 10,053 | 10,053 | 10,472 | 60 | kairnPlusHeadroom | 99.4% | balanced_or_scenario_dependent | pass |
| Exact source runtime | 80,020 | 80,020 | 25,961 | 63 | kairnPlusHeadroom | 99.8% | kairn | pass |
| Exact source parser fixture | 122 | 122 | 195 | 195 | baseline | 0.0% | headroom | pass |
| Parser related tests | 356 | 356 | 109 | 109 | kairnOnly | 0.0% | kairn | pass |
| Parser noisy failure context | 11,303 | 11,303 | 2,072 | 580 | kairnPlusHeadroom | 72.0% | kairn | pass |
| MCP attribution source surface | 62,034 | 62,034 | 14,813 | 6,751 | kairnPlusHeadroom | 54.4% | kairn | pass |

## Valid Evidence Aggregate

- Valid rows: 6/6
- Baseline: 163,888 tokens
- Headroom only: 163,888 tokens (0% reduction vs baseline)
- Kairn only: 53,622 tokens (67.3% reduction vs baseline)
- Kairn + Headroom: 7,758 tokens (95.3% reduction vs baseline)
- Combo vs Kairn-only: 85.5% lower
- Combo vs Headroom-only: 95.3% lower
- Combo best rows: 4/6
- Combo better than both individual arms: 4/6
- Attribution issue rows: 0
- Heavy lifting: 4 Kairn-led, 1 Headroom-led, 1 balanced/scenario-dependent

## Interpretation

The MCP-to-MCP path is substantially more promising than the Codex proxy wrapper path. On this source-bearing matrix, Kairn + Headroom was the smallest arm on 4/6 valid rows and improved over Kairn-only by 85.5% on aggregate. The two rows where combo did not win were tiny payloads where additional compression had no room to help.

The heavy-lifting split matters: Kairn did most of the reduction on 4/6 valid rows by choosing or summarizing the right source/failure surface before compression. Headroom then provided a second-stage reduction on the already-governed payload. This supports a product direction where Headroom-style compression is an optional downstream stage, not a replacement for Kairn's governance layer.

This is still not public benchmark evidence. It is MCP tool-layer evidence. The next proof step is one end-to-end MCP agent task with both servers available, observed token accounting, and quality/scope validation.
