# Kairn Design Doc

## 1. Summary

Kairn is a local-first dynamic context runtime for software engineering agents.

The core idea is simple: coding agents waste too much time, context, and usage figuring out what matters in a repository before they can acptually make a change. Kairn sits beside tools like Codex, Claude Code, Cursor, Gemini CLI, and other coding agents. It analyzes the repo, understands relationships between files, tracks the current task session, and routes the exact context an agent needs as the work unfolds.

Kairn does not replace coding agents. It makes them more effective.

Conduit is the verification layer after the agent acts. Kairn is the context layer before and during the agent's work.

```txt
Ticket / prompt / PR / issue
        ↓
   Kairn Runtime
        ↓
Repo graph + AST + embeddings + memory + cache + session state
        ↓
Dynamic context responses
        ↓
Codex / Claude Code / Cursor / Gemini CLI / API agent
        ↓
Patch / diff
        ↓
Conduit verification
        ↓
Evidence-backed review result
```

## 2. Problem

Modern coding agents are powerful, but they are inefficient when working inside real codebases.

They often need to:

* Search the repo repeatedly
* Read unrelated files
* Infer architecture from scratch
* Discover dependency relationships manually
* Re-read files they already inspected
* Burn context on terminal output, logs, and long diffs
* Miss project conventions or previous architectural decisions
* Make edits without understanding affected tests, routes, or downstream dependencies

This creates several problems:

1. **Tiny effective context windows**
   Even if a model technically supports large context, the usable working context for a specific engineering task is much smaller. Agents still drown in irrelevant code.

2. **Wasted usage**
   CLI and subscription-based tools have practical limits. API-based tools are directly metered. In both cases, having the model discover context itself is expensive.

3. **Unstable results**
   Agents make mistakes when they receive incomplete or noisy context. They may modify the wrong files, miss related tests, or misunderstand the flow of data through the app.

4. **Poor observability**
   Users often cannot see why an agent chose certain files or ignored others. When the agent fails, it is hard to know whether the issue was the model, the context, or the retrieval process.

5. **No reusable repo understanding**
   Every agent session tends to rediscover the same things. Project knowledge is not compiled into a durable, queryable system.

## 3. Product Thesis

The winning agent workflow will not be “give the agent the whole repo.”

It will be:

> Route the right repo context at the right time, at the right level of detail, then verify the result.

Kairn owns the first half of that loop.

Conduit owns the second half.

Kairn should become the runtime that turns vague engineering intent into precise, live agent context.

## 4. One-Line Pitch

Kairn routes the right repo context to coding agents before they waste tokens finding it themselves.

## 5. Longer Pitch

Kairn is a dynamic context runtime for coding agents. It analyzes a codebase using AST parsing, repo graphing, semantic search, memory, cached project summaries, and live task state. Given a ticket, issue, prompt, or PR, it exposes context tools that return the relevant files, symbols, dependencies, conventions, risks, tests, diffs, and compressed outputs an agent needs while it works.

Instead of letting Codex, Claude Code, or Cursor burn usage exploring and re-reading the repository, Kairn gives them a shared runtime for asking better context questions.

## 6. Positioning

Kairn is not just memory.

Memory systems remember facts. Kairn decides what context matters right now.

Kairn is also not just semantic search.

Search finds matching chunks. Kairn routes task-aware context using code structure, dependency relationships, project knowledge, session history, and risk signals.

Kairn is not an agent replacement.

It is agent infrastructure.

## 7. Relationship to Conduit

Kairn and Conduit should be separate but complementary.

### Kairn

Purpose: Give the agent the right context before and during the task.

Responsibilities:

* Understand repo structure
* Retrieve relevant context
* Build dependency maps
* Include project memory
* Identify likely affected files and tests
* Serve exact or compressed context responses
* Expose one runtime through MCP tools, CLI wrappers, and future watcher/hooks
* Track why context was selected

### Conduit

Purpose: Verify the agent after it acts.

Responsibilities:

* Run browser/runtime verification
* Capture evidence
* Analyze UI behavior
* Assess PR readiness
* Identify blockers
* Publish review comments
* Store verification artifacts

### Combined Flow

```txt
Kairn: What does the agent need to know?
Agent: Make the change.
Conduit: Did the change actually work?
```

This creates a full agent development loop:

```txt
Intent → Context → Action → Verification → Evidence → Review
```

## 8. Target Users

### Primary V1 User

Individual engineers using coding agents heavily.

Examples:

* Developers using Codex CLI, Claude Code, Cursor, Gemini CLI, or Windsurf
* Engineers working on large personal projects
* Startup founders trying to move fast with AI coding tools
* Engineers frustrated by coding agents wasting usage exploring the repo

### Secondary User

Small engineering teams using agents in a shared repo.

Examples:

* Teams that want consistent context behavior across agents
* Teams with complex monorepos
* Teams that want better agent observability
* Teams that want to reduce API cost in automated workflows

### Future User

Enterprise engineering organizations.

Examples:

* Teams with strict governance requirements
* Teams that need audit logs for agent decisions
* Teams with internal platforms, design systems, and many service dependencies
* Teams that need context boundaries and policy controls

## 9. Dynamic-First Goal

Kairn should skip the static-only packet phase and go straight toward becoming a live context runtime for coding agents.

The first real version should answer:

> Given what the agent is trying to do right now, what exact repo context should it receive, in what form, and at what level of detail?

Instead of producing only a one-time markdown packet, Kairn should sit between the agent and the repository as a context router. It should assist or intercept file reads, searches, terminal outputs, diffs, and follow-up context requests. It should decide when to return raw code, when to return compressed summaries, when to include graph neighbors, and when to warn that the agent is missing critical context.

The dynamic version is the real product. Task packets are only one output mode.

```txt
Agent prompt / task / tool call
        ↓
      Kairn Runtime
        ↓
Repo graph + AST + embeddings + memory + cache + live working state
        ↓
Dynamic context response
        ↓
Agent continues with smaller, more relevant context
        ↓
Patch / diff
        ↓
Conduit verification
```

## 10. Dynamic-First Non-Goals

Kairn should not:

* Become just a markdown packet generator
* Replace Codex, Claude Code, Cursor, or other agents
* Require API usage to be useful
* Require hosted SaaS to work
* Build a full autonomous coding agent immediately
* Hide retrieval decisions from the user
* Return raw full files by default when compressed context would be enough
* Compress everything blindly when exact source code is necessary

The goal is not to make a prettier repo summary. The goal is to build a context runtime that helps agents spend less context discovering, rereading, and reprocessing repo information.

## 11. Core Dynamic Workflow

### Runtime Command

Kairn should start with a live runtime command:

```bash
kairn serve
```

or:

```bash
kairn run --agent claude
kairn run --agent codex
```

The system exposes a local context service that an agent can query during work.

```txt
User gives agent a task
        ↓
Agent needs context
        ↓
Agent asks Kairn or Kairn intercepts the request
        ↓
Kairn retrieves, ranks, compresses, and responds
        ↓
Agent edits with the right working set
        ↓
Kairn tracks live context state
        ↓
Conduit verifies the final result
```

### One Runtime, Three Access Modes

Kairn should be one product, not three products.

The product is the Kairn Runtime:

* It owns repo indexing, graphing, retrieval, compression, memory, session state, and context traces.
* It remembers what context has already been shown during the task.
* It decides whether the next response should be exact source, compressed context, graph neighbors, test guidance, diff analysis, or failure context.
* It keeps enough structured state for Conduit to later verify whether the agent stayed aligned with the task.

The access modes are only different surfaces over the same runtime:

1. **MCP tools**
   The first real integration surface. Agents call Kairn directly during work.

2. **CLI wrappers**
   Terminal commands that query the same runtime when MCP is unavailable, awkward, or insufficient.

3. **Watcher/hooks**
   Later automation that observes file changes, diffs, test runs, and tool events.

Do not build separate MCP, CLI, and watcher products. Build one runtime with multiple surfaces. Start with MCP plus session state, then add CLI wrappers, then add watcher/hooks.

### Runtime Context Loop

Kairn should maintain a live task session.

A session includes:

* Original task
* Files already shown to the agent
* Files the agent opened
* Symbols already included
* Summaries already provided
* Commands already run
* Diffs created so far
* Tests discovered
* Tests run
* Current risk areas
* Context budget spent
* Context still likely missing

This means Kairn can answer context requests differently over time.

Example:

```txt
First request:
"What files are relevant to job dashboard filtering?"
→ Return route, table, types, query files, and short summaries.

Second request:
"Show me JobTable."
→ Return exact JobTable component code, not a summary.

Third request:
"What tests should I run?"
→ Return tests connected by graph proximity and package scripts.

Fourth request:
"Why is this failing?"
→ Use current diff, error output, graph neighbors, and prior session context.
```

## 12. Dynamic Context Response Types

Kairn should not always return the same kind of artifact. The response depends on what the agent needs right now.

### 12.1 Context Brief

Used at the start of a task.

```md
# Kairn Context Brief

## Task
Add filtering to the job applications dashboard.

## High-Confidence Files
- app/private/jobs/page.tsx
- app/private/jobs/components/JobTable.tsx
- lib/jobs/types.ts
- lib/jobs/queries.ts

## Current Flow
The private jobs page loads application data through `getJobApplications`, then renders the list through `JobTable`. Status display is handled by `JobStatusBadge`.

## Suggested First Reads
1. `app/private/jobs/page.tsx`
2. `app/private/jobs/components/JobTable.tsx`
3. `lib/jobs/types.ts`

## Likely Tests / Checks
- Filter by status
- Filter by company search
- Clear filters
- Preserve sorting
- Empty state

## Risks
- Date values may be nullable.
- Filtering may conflict with existing sort behavior.
```

### 12.2 Exact Code Response

Used when the agent needs source code for implementation.

````md
# Exact Source

## app/private/jobs/components/JobTable.tsx

```tsx
export function JobTable({ applications }: JobTableProps) {
  return (
    <table>
      ...
    </table>
  );
}
````

## Why this matters

This component renders the application list that filtering will affect.

````

### 12.3 Compressed File Response

Used when a file is relevant but exact source is not yet needed.

```md
# Compressed File Context

## lib/jobs/queries.ts

Purpose: Fetches job application records from Supabase and normalizes them for the private jobs dashboard.

Key exports:
- `getJobApplications`
- `createJobApplication`
- `updateJobApplicationStatus`

Relevant behavior:
- Returns applications ordered by most recent activity.
- Some date fields may be nullable.
- Status values come from `JobStatus` in `lib/jobs/types.ts`.
````

### 12.4 Graph Neighbor Response

Used when the agent asks what else might be affected.

```md
# Graph Neighbors

Starting file: `app/private/jobs/page.tsx`

## Direct imports
- `JobTable`
- `JobStatusBadge`
- `getJobApplications`
- `JobApplication`

## Likely affected files
- `app/private/jobs/components/JobTable.tsx`
- `app/private/jobs/components/JobFilters.tsx`
- `lib/jobs/types.ts`

## Why
These files are in the render/data/type path for the jobs dashboard.
```

### 12.5 Failure Context Response

Used after an error, failed test, or unexpected diff.

```md
# Failure Context

## Error Summary
The failing test indicates that `application.status` can be undefined in one branch.

## Relevant Source
- `lib/jobs/types.ts`
- `app/private/jobs/components/JobTable.tsx`
- Current diff in `app/private/jobs/page.tsx`

## Likely Cause
The new filter assumes all applications have a non-null status, but imported records may include incomplete status data.

## Suggested Fix Direction
Normalize status before filtering or guard the filter predicate.
```

### 12.6 Static Packet Mode

The old static task packet still exists, but only as one output mode:

```bash
kairn packet "Add filtering to the job applications dashboard"
```

Useful for manual workflows, but not the main product.

## 13. Core Components

Kairn needs eight major components for the dynamic version.

### 13.1 Repo Scanner

The scanner walks the repo and identifies files Kairn should care about.

Responsibilities:

* Respect `.gitignore`
* Ignore build artifacts and dependency folders
* Detect language/framework signals
* Identify source files, tests, configs, routes, components, API handlers, schemas, and docs
* Build a stable file inventory

### 13.2 AST Parser

The parser extracts structure from source files.

Recommended tool: Tree-sitter.

Responsibilities:

* Extract imports and exports
* Extract functions, classes, components, types, interfaces, hooks, constants
* Identify symbol locations
* Identify route handlers and API endpoints
* Identify React components
* Identify test blocks
* Identify database/schema definitions where possible

### 13.3 Repo Graph

The repo graph maps relationships between files and symbols.

Responsibilities:

* File import graph
* Symbol reference graph
* Route to component relationships
* API route to service/query relationships
* Test to source relationships
* Package/module relationships
* Optional call graph for supported languages

### 13.4 Semantic Index

The semantic index supports meaning-based retrieval.

Responsibilities:

* Chunk code intelligently
* Embed chunks
* Store vectors locally
* Retrieve chunks based on task description
* Combine semantic similarity with graph proximity

### 13.5 Memory Layer

The memory layer stores durable project knowledge.

Memory examples:

* Project conventions
* Naming patterns
* Architecture decisions
* Known fragile areas
* Previous bug fixes
* Preferred libraries
* User preferences
* Testing commands
* Deployment assumptions
* Framework-specific notes

### 13.6 Dynamic Context Router

The dynamic context router is the core product.

It receives a context request and decides:

* What does the agent actually need right now?
* Should Kairn return exact code, a summary, snippets, graph neighbors, tests, or risk notes?
* Has the agent already seen this context?
* Would returning the full file waste context?
* Is exact source necessary for safe editing?
* Should related files be included because of graph proximity?
* Should Kairn warn about missing context?

Example input:

```json
{
  "sessionId": "task_123",
  "requestType": "file_read",
  "target": "app/private/jobs/page.tsx",
  "agentIntent": "implement filtering",
  "budget": 4000
}
```

Example output:

```json
{
  "mode": "exact_code_with_notes",
  "files": ["app/private/jobs/page.tsx"],
  "related": ["JobTable.tsx", "lib/jobs/types.ts"],
  "content": "...",
  "warnings": ["Date fields may be nullable"],
  "suggestedNextContext": ["JobTable", "JobStatus type"]
}
```

### 13.7 Session State Manager

The session state manager tracks what has happened during the task.

Responsibilities:

* Track files already returned
* Track summaries already shown
* Track exact snippets already shown
* Track tool outputs
* Track current diff
* Track selected tests
* Track agent progress
* Track context budget
* Track unresolved risks

This prevents Kairn from repeatedly sending the same context and lets it adapt as the agent works.

### 13.8 Tool Output Compressor

Kairn should eventually compress noisy outputs from commands like:

* `git diff`
* `git status`
* `npm test`
* `pytest`
* `tsc`
* `eslint`
* `docker logs`

RTK could be used as a component here, or Kairn could implement its own compression layer.

The difference:

* RTK compresses terminal output.
* Kairn uses terminal output as part of the live context session and connects it to repo graph, task intent, and verification planning.

## 14. Runtime Context Selection Algorithm

Kairn should not rely on semantic search alone.

A good initial scoring formula:

```txt
final_score =
  semantic_similarity * 0.35
+ keyword_match * 0.15
+ graph_proximity * 0.20
+ session_relevance * 0.15
+ file_importance * 0.05
+ git_signal * 0.05
+ memory_match * 0.05
```

### Runtime-Specific Signals

#### Session Relevance

Does this context relate to files, symbols, errors, diffs, or commands already seen in this task session?

#### Context Freshness

Has this exact context already been shown to the agent? If yes, summarize changes instead of resending it.

#### Response Mode Need

Does the agent need exact source code, or is a summary enough?

Exact source is needed for:

* Editing a function/component
* Fixing a type error
* Modifying tests
* Understanding exact prop names
* Working with complex logic

Summaries are enough for:

* Understanding surrounding architecture
* Knowing what a utility file does
* Finding likely tests
* Getting dependency neighbors

## 15. Runtime Retrieval Flow

```txt
Agent asks for context or attempts tool call
  ↓
Kairn identifies request type
  ↓
Kairn checks session state
  ↓
Kairn retrieves matching files/symbols/chunks
  ↓
Kairn expands through repo graph if needed
  ↓
Kairn decides response mode
  ↓
Kairn returns exact, compressed, snippet, graph, or failure context
  ↓
Kairn records what was shown
  ↓
Agent continues
```

Request types:

* Initial task framing
* File read
* Symbol lookup
* Related files request
* Test discovery
* Error explanation
* Diff review
* Command output compression
* Verification planning

## 16. Context Budgeting

Kairn should support configurable context budgets per response, not just per task.

Example:

```bash
kairn context --session task_123 --file app/private/jobs/page.tsx --budget 3000
kairn context --session task_123 --related app/private/jobs/page.tsx --budget 1500
```

Budget modes:

### Tiny

Good for strict agent limits.

Includes:

* Short summaries
* Top symbols
* No full source unless necessary

### Standard

Good default.

Includes:

* Summaries
* Key snippets
* Important graph neighbors
* Risks

### Exact

Used when the agent needs implementation-level code.

Includes:

* Full symbol source or full file section
* Important imports/types
* Nearby helper functions

## 17. Runtime Access Modes

Kairn should work with multiple agents without requiring API usage.

These are access modes over one Kairn Runtime. They should share the same repo index, session state, retrieval logic, response mode selection, compression logic, and traces.

### 17.1 MCP Tool Mode

Primary V1 access surface.

```bash
kairn serve --mcp
```

The agent calls Kairn directly while it works.

Initial tools:

* `kairn_start_task`
* `kairn_find_context`
* `kairn_read_file`
* `kairn_read_symbol`
* `kairn_get_related_files`
* `kairn_find_tests`
* `kairn_review_diff`
* `kairn_compress_output`
* `kairn_get_session_state`

Why this comes first:

* It proves the dynamic runtime with real coding agents.
* It avoids building a one-time packet workflow that is not the core product.
* It lets Claude Code, Codex, or other MCP-aware agents ask for context mid-task.
* It gives Kairn a natural place to track what context has already been shown.

### 17.2 CLI Wrapper Mode

Second access surface.

```bash
kairn context --session task_123 --file app/private/jobs/page.tsx
kairn context --session task_123 --related app/private/jobs/page.tsx
npm test | kairn compress --session task_123 --type test
kairn diff --session task_123
```

CLI wrappers call the same runtime as MCP. They are useful when MCP is unavailable, when an agent does not call tools correctly, or when a human wants to inspect Kairn's answer directly.

### 17.3 Watcher/Hook Mode

Third access surface.

```bash
kairn watch --session task_123
```

Watcher/hooks observe live work and update the same task session.

Future inputs:

* File changes
* Git diff changes
* Test runs
* Typecheck/lint output
* Claude hooks
* Shell command output

Why this comes third:

* It is powerful, but it depends on the runtime already understanding repo context and task state.
* Watching changes is not useful unless Kairn can already answer context questions well.

### 17.4 Agent Runner Mode

Kairn launches the agent with context support.

```bash
kairn run --agent claude "Add filtering to the job dashboard"
kairn run --agent codex "Add filtering to the job dashboard"
```

This mode creates a Kairn session, starts the runtime, and passes instructions to the agent for how to ask Kairn for more context.

### 17.5 Manual Packet Mode

Secondary export/debug mode.

```bash
kairn packet "Add filtering to the job dashboard"
```

Packets are not the product center. They are useful when a user wants a static artifact, a pasteable summary, or a retrieval trace for debugging.

### 17.6 IDE/API Mode

Future hosted, IDE, or automated workflows.

Used for:

* VS Code/Cursor integration
* CI/CD
* PR review
* Conduit integration
* Team dashboards
* Autonomous task execution

## 18. CLI Commands

### `kairn serve`

Starts the local dynamic context runtime.

```bash
kairn serve
```

Options:

```bash
kairn serve --mcp
kairn serve --http
kairn serve --port 7331
kairn serve --watch
```

### `kairn start`

Starts a task session.

```bash
kairn start "Add filtering to the job applications dashboard"
```

Returns a session ID and initial context brief.

### `kairn context`

Queries live context.

```bash
kairn context --session task_123 --file app/private/jobs/page.tsx
kairn context --session task_123 --symbol JobTable
kairn context --session task_123 --related app/private/jobs/page.tsx
kairn context --session task_123 --tests
```

### `kairn compress`

Compresses command output with task-aware context.

```bash
npm test | kairn compress --session task_123 --type test
```

### `kairn diff`

Analyzes current diff against the task session.

```bash
kairn diff --session task_123
```

Answers:

* Did the agent touch expected files?
* Did it modify unrelated areas?
* What context is now needed?
* What should Conduit verify?

### `kairn watch`

Watches local work and updates the task session.

```bash
kairn watch --session task_123
```

Future inputs:

* File changes
* Git diff changes
* Test/lint/typecheck output
* Agent hook events

### `kairn packet`

Secondary static output mode.

```bash
kairn packet "Add filtering to the job applications dashboard"
```

## 19. Data Model

### Task Session

```ts
type TaskSession = {
  id: string;
  task: string;
  createdAt: string;
  status: "active" | "completed" | "abandoned";
  filesShown: ContextShownRecord[];
  symbolsShown: ContextShownRecord[];
  commandsRun: CommandRecord[];
  diffsObserved: DiffRecord[];
  risks: RiskRecord[];
  verificationHints: string[];
};
```

### Context Request

```ts
type ContextRequest = {
  sessionId: string;
  requestType:
    | "initial_brief"
    | "file"
    | "symbol"
    | "related"
    | "tests"
    | "error"
    | "diff"
    | "verify_plan";
  target?: string;
  agentIntent?: string;
  budget?: number;
};
```

### Context Response

```ts
type ContextResponse = {
  mode:
    | "brief"
    | "exact_code"
    | "compressed_summary"
    | "snippets"
    | "graph_neighbors"
    | "failure_context"
    | "verification_plan";
  content: string;
  files: string[];
  symbols: string[];
  related: string[];
  warnings: string[];
  suggestedNextContext: string[];
  tokenEstimate: number;
};
```

## 20. Tech Stack Recommendation

Recommended V1 dynamic stack:

* TypeScript
* Node.js CLI
* Commander.js or oclif
* Tree-sitter
* SQLite for local metadata and sessions
* LanceDB or SQLite vector extension for embeddings
* simple-git for Git signals
* fast-glob for file scanning
* ignore for `.gitignore` support
* Zod for schema validation
* Local HTTP server or MCP server for dynamic integration

Possible structure:

```txt
src/
  cli.ts
  server/
    serve.ts
    routes.ts
    mcp.ts
  session/
    createSession.ts
    updateSession.ts
    getSession.ts
  scanner/
    scanRepo.ts
  parser/
    parseFile.ts
  graph/
    buildGraph.ts
    expandGraph.ts
  retrieval/
    retrieveContext.ts
    scoreResults.ts
  router/
    decideResponseMode.ts
    buildContextResponse.ts
  compression/
    compressCommandOutput.ts
    compressDiff.ts
  memory/
    readMemory.ts
  conduit/
    buildVerificationPlan.ts
```

## 21. Dynamic-First Build Plan

### Phase 0: Runtime + Session Skeleton

Goal: Build one local Kairn Runtime with durable task session state.

Build:

* CLI skeleton
* `kairn init`
* `kairn serve --mcp`
* `kairn start "task"`
* Session state storage
* Repo scanner
* Basic file classification
* MCP server skeleton
* Tool registry
* Initial context brief response

Success criteria:

* You can start a task session.
* Kairn remembers what context it has already shown.
* An MCP client can connect to the runtime.
* Kairn can return a basic context brief through the runtime.

### Phase 1: MCP Context Tools

Goal: Make Kairn useful to an agent during an active task.

Build:

* `kairn_find_context`
* `kairn_read_file`
* `kairn_read_symbol`
* `kairn_get_related_files`
* `kairn_find_tests`
* `kairn_review_diff`
* `kairn_get_session_state`
* Exact vs compressed response modes
* Budget-aware responses
* Context-shown tracking per session

Success criteria:

* Claude Code, Codex, or another MCP-capable agent can ask Kairn for context mid-task.
* Kairn avoids resending duplicate context.
* Kairn decides when to summarize vs return exact code.
* Kairn can tell the agent what context is likely missing.

### Phase 2: CLI Wrappers

Goal: Make the same runtime useful when MCP is unavailable or insufficient.

Build:

* `kairn context --file`
* `kairn context --symbol`
* `kairn context --related`
* `kairn context --tests`
* `kairn diff`
* `kairn compress`
* `kairn run --agent claude`
* `kairn run --agent codex`

Success criteria:

* A human or CLI agent can query the same task session without MCP.
* Command output can be compressed against the active task.
* Diff review uses the same session state as MCP tools.

### Phase 3: AST + Graph

Goal: Make context routing structurally aware.

Build:

* Tree-sitter parser for TypeScript/JavaScript
* Import/export extraction
* Symbol extraction
* File dependency graph
* Graph expansion from relevant files
* Test and parent-route discovery

Success criteria:

* If the agent asks about a route, Kairn can identify imported components/types.
* If the agent asks about a component, Kairn can find related tests and parent routes.
* Symbol reads are more precise than full-file reads.

### Phase 4: Semantic Retrieval + Response Selection

Goal: Handle vague natural language context requests without returning noisy context.

Build:

* Symbol-aware chunking
* Embeddings
* Local vector storage
* Hybrid scoring
* Runtime response selection
* Confidence and missing-context warnings

Success criteria:

* Kairn finds relevant context even when file names do not exactly match the task.
* Kairn combines semantic search with graph expansion.
* Kairn can choose context brief, exact source, compressed file, graph neighbors, tests, failure context, or diff review.

### Phase 5: Watcher/Hooks

Goal: Let Kairn observe live work without becoming a full autonomous agent.

Build:

* `kairn watch --session task_123`
* File change watcher
* Git diff watcher
* Test/lint/typecheck output ingestion
* Hook adapter interface
* Failure-to-source linking from observed output

Success criteria:

* Kairn updates task session state as files and diffs change.
* Kairn can compress observed command output.
* Kairn can recommend next context based on current diff and failures.

### Phase 6: Conduit Integration

Goal: Close the loop from dynamic context to verification.

Build:

* Pass Kairn session metadata to Conduit
* Include expected files, risks, and verification hints
* Compare selected context against final diff
* Store context trace with verification artifacts

Success criteria:

* Every Conduit run can answer what context the agent used.
* Verification can detect if the agent drifted outside expected scope.

## 22. How Kairn Works With Conduit

When a task is executed by an agent, Kairn should produce a session ID.

Conduit can later consume:

```json
{
  "kairnSessionId": "task_123",
  "task": "Add filters to jobs dashboard",
  "contextShown": [
    "app/private/jobs/page.tsx",
    "app/private/jobs/components/JobTable.tsx",
    "lib/jobs/types.ts"
  ],
  "expectedRiskAreas": [
    "sorting behavior",
    "date filtering",
    "empty states"
  ],
  "verificationHints": [
    "Filter by status",
    "Clear filters",
    "Confirm empty state"
  ]
}
```

Then Conduit can verify:

* Did the agent touch expected files?
* Did it unexpectedly modify unrelated areas?
* Did it run or affect expected tests?
* Did runtime behavior match the task goal?
* Did the final PR align with the original task?

## 23. Differentiation

### Compared to mem0 / Supermemory

They remember persistent facts.

Kairn routes live task context.

Memory is one input to Kairn, not the whole product.

### Compared to RTK

RTK compresses terminal and command output.

Kairn dynamically selects, compresses, and routes repo context throughout the task.

RTK could be used as a component in Kairn’s output compression layer.

### Compared to Cursor / Claude Code / Codex built-in retrieval

Those tools retrieve context inside a specific agent workflow.

Kairn is cross-agent and observable.

It can work with any agent, any CLI, and eventually any API workflow.

## 24. Success Metrics

* Less repeated file reading by agents
* Smaller average context returned per request
* Higher first-pass task success rate
* Higher percentage of modified files predicted by Kairn
* Lower token/usage waste from repo exploration
* Better test discovery
* Better Conduit verification alignment
* Clear retrieval traces for debugging

## 25. First Implementation Checklist

### Day 1

* Create repo
* Build CLI skeleton
* Add `kairn init`
* Add `kairn serve --mcp`
* Add local session store
* Add `kairn start "task"`
* Add repo scanner
* Add MCP server skeleton

### Day 2

* Add `kairn_find_context`
* Add `kairn_read_file`
* Add `kairn_get_related_files`
* Add `kairn_find_tests`
* Add `kairn_review_diff`
* Track files shown in session state
* Add exact vs compressed file responses

### Day 3

* Add CLI wrappers for `kairn context`
* Add `kairn diff`
* Add `kairn compress`
* Add agent runner instructions for Claude/Codex

### Day 4

* Add TypeScript AST parsing
* Extract imports/exports/symbols
* Add file graph
* Add graph expansion
* Add `kairn_read_symbol`

### Day 5

* Add scoring
* Add response mode selection
* Add confidence and missing-context warnings
* Test on real tasks in your own repos

### Day 6+

* Add `kairn watch --session task_123`
* Add hook adapter interface
* Add embeddings
* Add Conduit verification handoff

## 26. Core Principle

Kairn should always be judged by one question:

> Did this help the agent get the right context at the right time with less waste?

If yes, it is useful.

If no, it is just another context tool.

## 27. Final Vision

Kairn becomes the live context runtime for agentic development.

It knows the repo, understands the task, watches the agent’s progress, compresses what can be compressed, returns exact source when necessary, and keeps a trace of what context shaped the final change.

Conduit then verifies whether the agent’s work is correct.

Together, they form a practical loop for AI-assisted software engineering:

```txt
Kairn routes the context.
The agent makes the change.
Conduit proves it worked.
```
