# Kairn Codebase Audit - 2026-05-21

## Scope

Source-level audit of local runtime behavior after the Windows/WSL beta smoke work. I focused on surfaces that can fail outside the happy path: command spawning, path containment, diagnostics privacy, daemon request handling, packaging, and production dependency health.

## Findings Fixed

### Diagnostics export could leak paths and fail nested writes

- `diagnostics export --root .` used the literal `"."` as a redaction marker. That corrupted unrelated strings and did not reliably redact the real repository path.
- Doctor output embedded in diagnostics was not recursively redacted.
- `--out nested/file.json` failed unless the parent directory already existed.

Fix:

- Resolve the root before redaction.
- Recursively redact doctor payload strings.
- Redact repo root, home directory, broad Unix absolute paths, and Windows absolute paths.
- Create the output parent directory before writing.

Coverage:

- Added diagnostics tests for relative roots, nested doctor paths, and nested output directories.

### Root-contained reads followed symlinks outside the repo

- `resolveInsideRoot` checked the lexical path but not the real filesystem target. A symlink inside the repo could point outside the root and still be read.

Fix:

- Resolve the real path for existing targets and reject it if it escapes the resolved root.

Coverage:

- Added a symlink escape regression test on non-Windows platforms.

### CLI command invocation used shell strings

- `kairn codex` built a shell command string around user-provided prompt args.
- Doctor checks interpolated `<command> --version` through a shell.
- The original Windows-safe attempt exposed two more issues in native Windows smoke:
  - Node 24 emitted `DEP0190` warnings for `shell: true` with args.
  - Unquoted executable paths from CLI options, such as `C:\Program Files\nodejs\node.exe`, were split at the space.

Fix:

- Added shared command parsing/spawn utilities.
- Spawn direct executables without a shell.
- Route Windows `.cmd`/`.bat` shims through `cmd.exe` as one quoted command line.
- Treat an existing command path with spaces as a single executable before shell-style splitting.
- Reused the parser for Codex MCP command setup and added Windows `PATHEXT` discovery for `.exe`, `.cmd`, `.bat`, and `.com`.

Coverage:

- Added parser tests for quoted command lines, Windows path separators, existing paths with spaces, direct `.exe` spawning, and `.cmd` shim resolution.

### Daemon accepted unbounded hook bodies

- `/hook` read the full request body into memory without a size cap.

Fix:

- Added a 1 MB request body cap.
- Reject oversized `Content-Length` requests before body buffering.
- Reject oversized chunked bodies while reading.
- Return HTTP 413 with a clear JSON error.

Coverage:

- Added daemon test for oversized hook payload rejection.

### Production dependency audit had vulnerable transitives

- `pnpm audit --prod` reported advisories through transitive packages under `@modelcontextprotocol/sdk`, including old `hono` and `ip-address` paths.

Fix:

- Updated lockfile resolutions for `hono`, `express-rate-limit`, and `ip-address`.

Verification:

- `pnpm audit --prod` now reports no known vulnerabilities.

## Verification Run

- `pnpm typecheck` passed.
- `pnpm build` passed.
- `pnpm test` passed: 15 files, 275 tests.
- `pnpm audit --prod` passed with no known vulnerabilities.
- WSL installed-package smoke passed:
  - package install from tarball
  - `kairn --version`
  - `setup wizard --targets "vscode generic" --index-mode safe`
  - `doctor --target codex --codex-command true`
  - `diagnostics export --out nested/diagnostics.json`
  - verified indexed state, index doctor status, codex doctor status, nested diagnostics write, and diagnostics path redaction
- Native Windows installed-package smoke passed:
  - package install from tarball
  - `kairn --version`
  - `setup wizard --targets "vscode generic" --index-mode safe`
  - `doctor --target codex --codex-command "C:\Program Files\nodejs\node.exe"`
  - `diagnostics export --out nested\diagnostics.json`
  - verified indexed state, index doctor status, command path with spaces, nested diagnostics write, and diagnostics path redaction

## Boundaries

- Benchmark/live-agent setup commands still allow explicitly user-supplied shell commands by design. That is separate from normal setup, doctor, MCP, daemon, diagnostics, and `kairn codex` command spawning.
- I did not run long live-agent benchmark campaigns or real GUI client launches.
- The npm install still prints a transitive `prebuild-install@7.1.3` deprecation warning. It is not a current production vulnerability and did not block package install.
