# Kairn Private Beta Instructions

I am privately testing **Kairn**, a local-first context governor for AI coding agents.

Kairn indexes your repo locally and helps agents like Codex, VS Code/Copilot MCP, Claude Code, Gemini, and other MCP clients avoid rereading unnecessary repo context. It may provide focused source context, shrink to a small edit-scope directive, ask for better evidence, or stay silent when extra context would be noise.

This is private beta software. The goal is to learn where Kairn helps, where it should stay quiet, and where setup still needs work.

## Before You Start

Use **Node 22 or Node 24 LTS** if possible.

Supported range: **Node 20.19 or newer, below Node 26**.

Check:

```bash
node -v
npm -v
git --version
```

If I sent you a tarball, it will look like:

```text
kairn-0.1.2.tgz
```

Use the full path to that file during install if you are not in the same directory.

## macOS Or Linux

Install Node with your normal Node manager. With `nvm`:

```bash
nvm install 24
nvm use 24
```

Install Kairn:

```bash
npm uninstall -g kairn || true
npm install -g ~/Downloads/kairn-0.1.2.tgz
kairn --version
```

Set up a repo:

```bash
cd /path/to/your/repo
kairn setup wizard
kairn doctor
```

For terminal Codex users:

```bash
kairn codex
```

For editor or non-Codex users, choose the MCP option for your client in the setup wizard. Supported setup targets include Codex, VS Code/Copilot MCP, Claude Code MCP, Gemini MCP, Copilot CLI MCP, and generic MCP.

## Windows PowerShell

Use normal **PowerShell**, not WSL, for native Windows testing.

Install Node 22 or 24 LTS from nodejs.org, or use Winget:

```powershell
winget install --id OpenJS.NodeJS.LTS --source winget
```

Close and reopen PowerShell after installing Node.

Check:

```powershell
node -v
npm -v
git --version
```

Install Kairn from Downloads:

```powershell
$Tarball = "$env:USERPROFILE\Downloads\kairn-0.1.2.tgz"
Test-Path $Tarball
npm uninstall -g kairn
npm install -g $Tarball
kairn --version
```

Set up a repo:

```powershell
cd C:\path\to\your\repo
kairn setup wizard --targets vscode,generic --yes --index-mode safe
kairn doctor --target vscode
kairn beta report
```

Notes:

- Avoid OneDrive paths for the first test if possible.
- Avoid paths containing `&`, `(`, `)`, `|`, or `;` for the first test.
- If `kairn` works in PowerShell but not inside VS Code, fully restart VS Code.
- If needed, check npm global PATH:

```powershell
npm config get prefix
$env:Path -split ';' | Select-String npm
```

## WSL Ubuntu

Use WSL for Linux-style workflows on Windows. Put the tarball in the Linux filesystem if possible.

Install Node 22 or 24 with your WSL Node manager. With `nvm`:

```bash
nvm install 24
nvm use 24
```

Important: make sure `node` and `npm` come from the same install.

```bash
which node
node -v
which npm
npm -v
```

Copy the tarball into WSL if it is in Windows Downloads:

```bash
mkdir -p ~/kairn-beta
cp /mnt/c/Users/<you>/Downloads/kairn-0.1.2.tgz ~/kairn-beta/
```

Install:

```bash
npm uninstall -g kairn || true
npm install -g ~/kairn-beta/kairn-0.1.2.tgz
command -v kairn
kairn --version
```

Set up a repo:

```bash
cd /path/to/your/repo
kairn setup wizard --targets generic --yes --index-mode full
kairn doctor --target generic
kairn beta report
```

If `npm install -g` succeeds but `command -v kairn` prints nothing, your WSL `node` and `npm` are probably coming from different installations. Fix your shell PATH so they both come from the same nvm/asdf/Volta/system Node install, then reinstall.

## Optional Telemetry

Telemetry is optional, but useful during beta.

It does **not** upload:

- source code,
- prompts,
- diffs,
- filenames or paths,
- repo names or URLs,
- raw command output,
- usernames,
- branch names,
- machine paths.

It sends sanitized aggregate signals such as whether Kairn emitted, shrank, suppressed, or requested evidence; estimated token savings; hook/MCP errors; and local quality/scope counters.

Enable telemetry from inside your repo:

```bash
kairn telemetry enable --destination supabase
kairn telemetry status
kairn telemetry flush --dry-run --json
```

Telemetry uploads only at safe command boundaries, such as when `kairn codex` exits or when you run `kairn beta report`. It does not upload during prompt hooks or MCP tool calls.

## Check Whether Kairn Helped

From inside your repo:

```bash
kairn beta report
```

This report is local. It summarizes whether Kairn helped, stayed silent, over-assisted, missed opportunities, or has no useful session data yet.

## Update Kairn

When I send a newer tarball:

```bash
npm install -g /full/path/to/kairn-0.1.2.tgz
```

Then run inside each repo where Kairn is configured:

```bash
kairn doctor --fix
kairn doctor
```

`doctor --fix` refreshes Kairn-owned hook/MCP entries to the current installed command while preserving unrelated user config.

## Remove Kairn

From inside a repo:

```bash
kairn setup remove --delete-state
```

Then uninstall globally:

```bash
npm uninstall -g kairn
```

`setup remove --delete-state` removes Kairn-owned hook/MCP config and deletes `.kairn/`. It is designed to preserve unrelated editor, agent, and repo config.

## What To Send Back

Please send:

- your OS and terminal: macOS/Linux/Windows PowerShell/WSL,
- `node -v`,
- `npm -v`,
- whether install worked,
- whether `kairn setup wizard` worked,
- `kairn doctor` output or JSON,
- `kairn beta report` output or JSON,
- what felt confusing, noisy, too quiet, slow, or useful.

Please do **not** send source code, prompts, diffs, `.kairn/`, repo files, raw agent outputs, branch names, repo names, or private paths unless we explicitly agree to debug something together.

## Quick Troubleshooting

- `npm install -g` cannot find the tarball: use the absolute path to `kairn-0.1.2.tgz`.
- `kairn` is not found after install: restart the terminal, then check `npm config get prefix` and PATH.
- Windows VS Code terminal cannot find `kairn`: fully restart VS Code after install.
- WSL install succeeds but `kairn` is missing: make sure `which node` and `which npm` point to the same Node installation.
- Windows path issues: try a repo under `C:\Users\<you>\kairn-test` before testing OneDrive or paths with shell metacharacters.
- Doctor warns about daemon: that is usually okay; the daemon is an optional latency improvement.
- Doctor warns telemetry is disabled: that is okay unless you want to opt in.

Please keep this private for now.
