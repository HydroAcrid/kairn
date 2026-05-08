# Kairn Tiered Adaptive Indexing Plan

## Summary

The current large-repo cap is a safety brake, not the final architecture. It prevents Kairn from creating unusable multi-GB state on repositories like Next.js, but static caps can throw away useful context. The long-term fix is tiered adaptive indexing: index everything lightly, index important things deeply, compact stale or low-value context, and expand cold files on demand.

Kairn should behave more like intelligent conversation compaction for codebases: preserve high-signal structure, reduce low-signal bulk, and spend tokens/storage only where the current task has leverage.

## Problem

The Next.js proof exposed an indexing failure:

```text
28k-file repo -> .kairn grew to roughly 8GB -> proof became unusable
```

The temporary fix added:

```text
max indexed files: 8,000
max semantic chunks: 7,500
```

That makes Kairn operational, but it is still blunt. A cap answers “how much can we afford?” but not “what is worth keeping?”

## Core Principle

Kairn should not index every file equally.

The desired behavior:

```text
index everything lightly
index important things deeply
expand cold files on demand
compact stale context over time
```

## Proposed Tiers

### Tier 0: Full File Inventory

Store metadata for every non-ignored file:

- path
- extension/language
- kind: source, test, doc, config, generated, fixture, vendor, etc.
- size
- hash
- mtime
- importance score

Do not store full chunks or vectors at this tier.

Purpose:

- know the repo shape
- support path search
- detect changes
- avoid losing files entirely because of caps

### Tier 1: Lightweight Lexical And Symbol Metadata

For most source-like files, store compact metadata:

- symbols
- exported/public names
- imports/includes
- package/module path
- BM25 terms
- short file summary

Purpose:

- keep broad retrieval possible without deep chunking every file
- support exact identifiers like `slugify`, `sourceEmailId`, `starts_with`, `isBlank`

### Tier 2: Package/File Summaries

Build summaries by module or package boundary:

- responsibility
- main files
- public API
- test locations
- ownership relationships
- recently changed files

Purpose:

- compact repo-level understanding
- help agents orient without scanning thousands of files

### Tier 3: Hot Semantic Chunks

Only deep-index high-value files:

- source files with strong importance scores
- files touched in current diff
- files linked to failures
- files recommended in prior successful runs
- files frequently used by Codex/Claude
- files in active package/module scope

Store:

- symbol chunks
- embeddings/hashed vectors
- snippet-ready context

Purpose:

- spend expensive indexing/storage on files likely to matter now

### Tier 4: On-Demand Exact Reads

Cold files stay light until needed.

When a task, failure, MCP request, or hook references a cold file:

1. read exact file
2. parse symbols if supported
3. create temporary hot chunks
4. optionally promote the file if it proves useful

Purpose:

- avoid permanent bloat while keeping recall available

## Promotion And Demotion

Files should move between tiers based on evidence.

Promote when:

- file is in git diff
- failure output references it
- Codex/Claude reads or edits it
- benchmark expected files include it
- Kairn recommendation was later used successfully
- exact symbol match is strong
- package is active in the task

Demote when:

- file has not been used recently
- file is docs/examples/generated and not requested
- chunks are stale after hash change
- file repeatedly appears in wrong-context primes

## Compaction Strategy

Kairn should compact stored context, not just delete it.

For cold files:

- keep inventory
- keep symbol names
- keep imports/includes
- keep short summary
- drop vectors/chunks

For old sessions:

- keep task summary
- keep files shown
- keep files edited
- keep failures and outcomes
- keep token deltas
- drop large content snippets

For failed recommendations:

- keep negative evidence:
  - recommended files
  - actual files used
  - token regression
  - quality failure reason

This gives Kairn memory without unbounded state growth.

## Retrieval Changes

Hybrid retrieval should use tiers in order:

1. exact path/symbol/file inventory
2. BM25 metadata
3. package summaries
4. hot semantic chunks
5. graph relationships
6. on-demand expansion if confidence is low but a cold file looks promising

Important rule:

Do not let hot chunks hide cold exact matches. A cold file with an exact symbol match may be more valuable than a hot file with vague semantic similarity.

## Controller Changes

The context-value controller should consider tier state:

- `emit`: hot source file, strong symbol/behavior match, high top-gap
- `shrink`: cold but promising file, exact symbol match, needs on-demand read
- `suppress`: no strong source target, top files are tests/docs/examples, low top-gap

New decision fields:

- `tier`
- `promotionReason`
- `coldFileCandidate`
- `onDemandExpansionRecommended`
- `compactionRisk`

## Storage Goals

Default goals for large repos:

- `.kairn` stays under a configurable soft limit, e.g. `250MB`
- full inventory can exceed the semantic chunk cap
- semantic chunks are capped by value, not arbitrary file order
- old sessions are compacted automatically

Suggested config:

```json
{
  "indexing": {
    "maxStateMb": 250,
    "maxHotChunks": 7500,
    "maxHotFiles": 3000,
    "inventoryAllFiles": true,
    "deepIndexDocs": false,
    "deepIndexExamples": false
  }
}
```

## CLI Additions

Potential future commands:

```bash
kairn index status --root <repo>
kairn index compact --root <repo>
kairn index promote <file> --root <repo>
kairn index explain <file> --root <repo>
```

Status should show:

- total inventory files
- hot indexed files
- semantic chunks
- database size
- skipped/deep-index-disabled files
- top promotion reasons
- compaction candidates

## Test Plan

Unit tests:

- large repo inventory stores all paths but hot chunks stay capped
- source files promote before docs/examples
- exact cold symbol match can trigger on-demand expansion
- stale sessions compact without losing outcome metadata
- wrong-context recommendations demote noisy files

Integration tests:

- Next.js-scale fixture or real clone stays under state-size budget
- Django `slugify` still routes to `django/utils/text.py`
- docs/examples are searchable but not deeply indexed by default
- on-demand read promotes a cold source file

Live validation:

- rerun Next.js init and proof
- rerun Django proof
- compare `.kairn` size, index time, observed tokens, and quality gates

## Acceptance Criteria

- Large repos no longer require blunt loss of recall.
- `.kairn` state remains bounded by configured soft limits.
- Kairn can still find cold exact matches.
- Wrong-context risk decreases on source-fix prompts.
- Observed token savings are only claimed when quality gates pass.

## Product Implication

This is the architecture that makes Kairn meaningfully different from naive RAG.

Kairn should not be “retrieve chunks from the repo.”

Kairn should be:

```text
a repo-aware context controller that compresses codebase knowledge by usefulness,
then expands only the smallest necessary context for the current task.
```
