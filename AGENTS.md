# Kairn Agent Guidelines

## Product Direction

Kairn is a general local context runtime for coding agents. Optimize for quality-preserving token savings across unknown repositories, not for isolated benchmark wins.

## Generalization Over Benchmark Tuning

- Prefer improvements that operate on broad signal classes: exact path matches, exact identifier matches, source/test/doc classification, graph proximity, failure references, git diff, and session history.
- Do not add scoring rules that directly name benchmark fixtures, repos, or symbols such as `is-local-url`, `slugify`, `term_len`, `starts_with`, or similar one-off targets.
- If a benchmark exposes a weakness, fix the underlying mechanism. For example, improve basename matching or source rescue generally instead of adding a special case for one file.
- Treat quality-failing token reductions as negative evidence. Savings only count when verification passes and the expected production source is used when required.
- Kairn should suppress or shrink context when confidence is low. Bad context costs tokens and can lower model quality.

## Large Repo Strategy

- Keep full-repo recall through cheap inventory and symbol metadata.
- Avoid eager whole-repo graph/chunk/vector loading in user-facing paths like `prime`, hooks, MCP prepare, and context search.
- Use query-local expansion: start from lexical/symbol/path candidates, then load chunks and graph neighbors only for those candidates.
- Keep graph edges bounded and useful. Direct imports, direct test links, and precise source relationships beat broad inferred reverse edges.
- Watch `.kairn` state size, WAL size, edge counts, and chunk counts before claiming large-repo readiness.

## Quality Gates

- Token savings are not a standalone success metric.
- A live proof only counts if the task passes, required source files are read or touched as specified, excluded files are avoided, hook failures are zero, and MCP modes show real MCP tool calls when claimed.
- Repeated median results matter more than single-run wins.

## Implementation Preferences

- Keep Kairn local-first and deterministic unless the design explicitly changes.
- Preserve public CLI/MCP behavior unless a migration plan is included.
- Add abstractions only when they reduce real complexity or prevent repeated mistakes.
- Prefer focused tests that prove the general rule, not tests that only encode one benchmark path.
