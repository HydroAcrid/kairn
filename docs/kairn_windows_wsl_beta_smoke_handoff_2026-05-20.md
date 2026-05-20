# Kairn Windows + WSL Beta Smoke Handoff 2026-05-20

## Goal

Verify that a beta tester can install, update, diagnose, configure, use, and remove Kairn on:

- native Windows PowerShell,
- VS Code integrated terminal on Windows,
- WSL Ubuntu.

This is not an effectiveness benchmark. It is a beta package readiness smoke.

## What To Bring Back

Send back only these local smoke artifacts:

- `kairn-smoke-native/transcript.txt`
- `kairn-smoke-native/doctor-before.json`
- `kairn-smoke-native/doctor-after.json`
- `kairn-smoke-native/index-status.json`
- `kairn-smoke-native/telemetry-status.json`
- `kairn-smoke-native/beta-report.json`
- `kairn-smoke-wsl/transcript.txt`
- `kairn-smoke-wsl/doctor-after.json`
- screenshots only if the wizard UI looks broken

Do not send source code, prompts, diffs, `.kairn/`, repo files, or raw Codex/agent outputs.

## Tarball Prep

On the Mac/dev machine:

```sh
pnpm build
mkdir -p /tmp/kairn-beta
npm pack --pack-destination /tmp/kairn-beta
ls -lh /tmp/kairn-beta/kairn-*.tgz
```

Copy the tarball to the Windows machine, ideally:

```text
C:\Users\<you>\Downloads\kairn-0.1.2.tgz
```

Use the absolute tarball path during install. Most Windows install failures so far were from running `npm install -g .\kairn-0.1.0.tgz` in a directory that did not contain the tarball.

## Native Windows PowerShell Smoke

Open a normal PowerShell terminal, not WSL.

### 1. Environment

Recommended Node for beta smoke: Node 22 or Node 24. Node 20.19+, 23, and 25 are inside the supported range, but LTS is preferred for support.

```powershell
$Smoke = "$env:USERPROFILE\kairn-smoke-native"
$Repo = "$Smoke\sample-repo"
$Tarball = "$env:USERPROFILE\Downloads\kairn-0.1.2.tgz"

New-Item -ItemType Directory -Force $Smoke | Out-Null
Start-Transcript -Path "$Smoke\transcript.txt" -Force

node -v
npm -v
git --version
Test-Path $Tarball
```

Expected:

- `Test-Path $Tarball` prints `True`.
- Node is `v22.x`, `v24.x`, or another version inside Kairn's supported range.

### 2. Install Or Update

```powershell
npm uninstall -g kairn
npm install -g $Tarball

Get-Command kairn
where.exe kairn
kairn --version
kairn --help
```

Expected:

- `kairn --version` prints the package version.
- `Get-Command kairn` points to the npm global location.

If PowerShell works but VS Code terminal says `kairn` is not found, fully restart VS Code after install. Then run:

```powershell
npm config get prefix
$env:Path -split ';' | Select-String npm
```

### 3. Create A Disposable Test Repo

Prefer a normal local path first. Avoid OneDrive and paths with `&` for the first smoke.

```powershell
Remove-Item -Recurse -Force $Repo -ErrorAction SilentlyContinue
git clone --depth 1 https://github.com/npm/node-semver.git $Repo
Set-Location $Repo
```

If cloning is not available, use any small local repo, but do not send its files back.

### 4. Doctor Before Setup

```powershell
kairn doctor --root . --target vscode --json > "$Smoke\doctor-before.json"
kairn doctor --root . --target vscode
```

Expected:

- `.kairn` writable is OK.
- Index may warn before setup.
- VS Code MCP may warn before setup.
- Telemetry may be disabled unless you enable it.

### 5. Noninteractive Setup

Use the scriptable path first. This avoids terminal UI compatibility issues.

```powershell
kairn setup wizard --root . --targets vscode,generic --yes --index-mode safe --json
```

Expected:

- exits successfully,
- creates `.vscode/mcp.json`,
- may create/update `AGENTS.md` with Kairn MCP guidance,
- safe index is used on Windows to avoid initial WASM/parser friction.

Then run:

```powershell
kairn doctor --root . --target vscode --json > "$Smoke\doctor-after.json"
kairn doctor --root . --target vscode
kairn index status --root . --json > "$Smoke\index-status.json"
kairn telemetry status --root . --json > "$Smoke\telemetry-status.json"
kairn beta report --root . --json > "$Smoke\beta-report.json"
```

Expected:

- `doctor --target vscode` should not complain about Codex if you only configured VS Code.
- `index status` should show a nonzero file count or clear stale reason.
- `beta report` should run even if no real Kairn session happened yet.

### 6. Interactive Wizard UI Smoke

Only run this after the noninteractive path works:

```powershell
kairn setup wizard --root .
```

Check:

- arrow keys move,
- checkbox selection works,
- Back/restart behavior does not loop,
- no repeated `Aborted()` spam,
- the ASCII banner alignment is acceptable.

If it crashes or loops, stop it with `Ctrl+C` and keep the transcript.

### 7. Optional Telemetry Opt-In Smoke

Only run this if you are comfortable testing sanitized upload.

```powershell
kairn telemetry enable --root . --destination supabase
kairn telemetry status --root . --json > "$Smoke\telemetry-status-enabled.json"
kairn telemetry flush --root . --dry-run --json
```

Expected:

- status shows telemetry enabled,
- dry-run shows sanitized payload shape,
- no source, prompts, paths, filenames, diffs, repo names, branches, or raw output.

### 8. Remove And Reinstall Smoke

```powershell
kairn setup remove --root . --delete-state --json
kairn doctor --root . --target vscode

npm install -g $Tarball
kairn --version
```

Expected:

- Kairn-owned config/state is removed.
- Reinstall/update is smooth.
- Unrelated repo files are preserved.

End transcript:

```powershell
Stop-Transcript
```

## VS Code Integrated Terminal Check

Open VS Code after the native install. In a new integrated terminal:

```powershell
kairn --version
kairn doctor --root C:\Users\<you>\kairn-smoke-native\sample-repo --target vscode
```

Expected:

- same command resolution as standalone PowerShell.
- if not, restart VS Code or verify npm global prefix is on PATH.

## WSL Smoke

Open Ubuntu/WSL. Put the tarball in the Linux filesystem, not under `/mnt/c`, if possible.

```sh
mkdir -p ~/kairn-smoke-wsl
cd ~/kairn-smoke-wsl
script -q transcript.txt

node -v
npm -v
git --version
```

If Node is missing, install Node 22 or 24 using your normal Node manager. In WSL, make sure `which node` and `which npm` resolve to the same Node manager installation before installing globally.

Copy the tarball into WSL, for example:

```sh
cp /mnt/c/Users/<you>/Downloads/kairn-0.1.2.tgz ~/kairn-smoke-wsl/
```

Install:

```sh
npm uninstall -g kairn || true
npm install -g ~/kairn-smoke-wsl/kairn-0.1.2.tgz
command -v kairn
kairn --version
```

Create repo and setup:

```sh
rm -rf sample-repo
git clone --depth 1 https://github.com/npm/node-semver.git sample-repo
cd sample-repo

kairn setup wizard --root . --targets generic --yes --index-mode full --json
kairn doctor --root . --target generic --json > ../doctor-after.json
kairn index status --root . --json > ../index-status.json
kairn beta report --root . --json > ../beta-report.json
```

Expected:

- WSL full index should work.
- Generic MCP JSON output/config should be produced without Windows path escaping issues.

Remove:

```sh
kairn setup remove --root . --delete-state --json
npm uninstall -g kairn
exit
```

## Known Failure Patterns To Note

Record the exact command and attach the transcript if any of these happen:

- `kairn` works in PowerShell but not VS Code terminal.
- `npm install -g` cannot find the tarball.
- `npm install -g` fails on native dependency build.
- WSL `npm install -g` succeeds but `kairn` is not on PATH because `node` and `npm` come from different installations.
- wizard repeats `Aborted()`.
- `kairn setup wizard --targets ... --yes` fails noninteractively.
- `doctor --target vscode` warns about unrelated Codex setup.
- `index status` stays at 0 files after setup.
- paths under OneDrive behave differently from `C:\Users\<you>\kairn-smoke-native`.
- paths with `&`, spaces, or parentheses break setup/MCP config.

## Pass Criteria

Native Windows passes if:

- install/update works,
- `kairn --version` works in standalone PowerShell,
- VS Code terminal can resolve `kairn` after restart,
- noninteractive setup works,
- doctor target output is actionable and not noisy,
- safe index produces usable state or a clear warning,
- remove deletes Kairn-owned config/state without damaging unrelated files.

WSL passes if:

- install works,
- full index works,
- generic MCP setup works,
- doctor/index/beta report commands run,
- remove works.

## Handoff Summary To Fill In

```text
Windows version:
PowerShell version:
Node version:
npm version:
Install result:
VS Code terminal result:
Wizard noninteractive result:
Wizard interactive result:
Doctor target result:
Index result:
Telemetry status result:
Remove result:
WSL distro/version:
WSL Node version:
WSL setup result:
Issues found:
Files attached:
```
