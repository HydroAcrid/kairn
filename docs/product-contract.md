# Kairn product contract

Kairn is the local repository evidence layer for coding agents. It maps the
current checkout, ranks the smallest useful production-source scope, and sends
that evidence through local hooks or MCP. The immediate result should be faster
arrival at required source; the economic result should be fewer unnecessary
reads, repeated reads, context tokens, and elapsed time.

## What must remain true

- Core indexing, ranking, policy, session state, hooks, and MCP work without a
  Kairn account, API key, hosted backend, or outbound network access.
- A token reduction is a win only when required-source and external verification
  gates pass. Negative token deltas remain visible.
- Full-repository recall uses cheap inventory and symbol metadata. Chunk and
  graph loading remain query-local and bounded.
- Public claims identify the campaign, model, repositories, repeats,
  denominators, exclusions, and artifact checksum that support them.
- Supported integrations and efficacy-validated integrations are reported
  separately.

## Non-goals

Kairn does not capture reasoning traces, route models, host collective memory,
provide trajectory dashboards, or orchestrate a general-purpose agent loop.
Those are different product categories. A controlled benchmark may integrate a
third-party trajectory system, but that integration is not part of Kairn's
normal runtime.

## Release gates

- **v0.2:** source-first positioning and compatibility alias; one-command
  per-repository enablement; typed evidence candidates; local calibrated ranker
  in shadow; ordered experiment trace; methodology-only public artifact.
- **v0.3:** calibrated ranker becomes default only after repository-disjoint
  quality gates; stable `usekairn` package; Apache-2.0 release process; repeated
  five-language comparison artifact.
- **v0.4:** remove the legacy scorer, deprecated setup alias, and deprecated
  wire fields after one complete rollback cycle.

The comparison campaign is valid whether Kairn wins, loses, or is neutral. It
must not be stopped or selectively retried because of an unfavorable outcome.
