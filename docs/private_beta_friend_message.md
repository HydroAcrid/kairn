# Kairn Private Beta Message

## Short Version

I am privately testing **Kairn**, a local-first tool that helps Codex and other AI coding agents use fewer tokens by giving them only the repo context that actually matters, or staying silent when extra context would just be noise.

In private tests, I have seen quality-passing token reductions around **20% to 70%+** on the kinds of work Kairn is designed for: debugging, larger repos, multi-file tasks, and longer coding sessions. I am not claiming that on every task. The goal of this beta is to prove where it helps, where it should stay quiet, and how it behaves on real projects.

Your code stays local. Kairn creates a `.kairn/` index in your repo and can connect through Codex hooks or MCP for editors like VS Code.

If you are open to testing it:

```bash
nvm install 22
nvm use 22
npm install -g --legacy-peer-deps ./kairn-0.1.0.tgz
cd /path/to/your/repo
kairn setup wizard
kairn doctor
kairn codex
```

Please use **Node 20 or 22 LTS** for now. Node 24/25 can fail while building Kairn's native Tree-sitter dependencies.

Telemetry is optional but very helpful. It is sanitized and does **not** upload source code, prompts, diffs, filenames, repo names, raw command output, usernames, branch names, or machine paths. It only sends aggregate signals like whether Kairn helped, stayed silent, over-assisted, hit hook/MCP errors, or saved estimated tokens.

If you enable telemetry:

```bash
kairn telemetry enable --destination supabase
```

After telemetry is enabled, Kairn automatically uploads sanitized snapshots when `kairn codex` exits or when you run `kairn beta report`. You can still force a send with `kairn telemetry flush`.

You can see whether it helped with:

```bash
kairn beta report
```

This is private beta software, so feedback on setup, confusion, bad context, silence, latency, or real token savings is exactly what I need.

Please keep this private for now. I am still validating the idea before making broader claims or a public launch.

## Full Version

I am private testing a tool called **Kairn**.

Kairn runs locally beside Codex and other AI coding agents. Its job is to reduce wasted tokens by giving the agent the smallest useful repo context for a task, or by staying silent when the task is already obvious.

In private tests, I have seen quality-passing token reductions from roughly **20% to 70%+** on the kinds of work Kairn is built for: debugging, large repos, multi-file tasks, and longer coding sessions. I am not claiming it saves that much on every request. On cheap/easy tasks, the correct behavior is often for Kairn to do nothing.

What Kairn tries to decide:

- which source file matters,
- whether a companion file matters,
- what invariant needs to be preserved,
- what check or test is most relevant,
- and when extra context would just add noise.

Kairn is **local-first**. Your code stays on your machine. It creates a local `.kairn/` index inside the repo and uses that to guide Codex, hooks, or MCP. It is designed to be quiet and low-latency: after the first setup/index step, it should only add context when it has high-confidence value.

## Install

For beta, please use **Node 20 or 22 LTS**.

If I send you a beta package:

```bash
nvm install 22
nvm use 22
npm install -g --legacy-peer-deps ./kairn-0.1.0.tgz
```

If it is available through npm:

```bash
npm install -g kairn
```

Then, inside your repo:

```bash
cd /path/to/your/repo
kairn setup wizard
kairn doctor
```

The wizard lets you choose terminal Codex hooks, VS Code/editor MCP, or both.

## Normal Use

If you use Codex in the terminal, start a session with:

```bash
kairn codex
```

You can type normally inside Codex. Kairn stays attached to that conversation and should stay quiet unless useful context is available.

If you use VS Code or another MCP-capable editor, choose the MCP option in the setup wizard. That lets the editor/agent ask Kairn for focused context without needing the terminal Codex wrapper.

Codex may ask you to approve Kairn hooks the first time. Open `/hooks` inside Codex and approve the Kairn hook if prompted.

## Optional Telemetry

Telemetry is optional, but I would really appreciate it if you enable it during the beta. It helps me improve Kairn without seeing your work.

Telemetry does **not** upload:

- source code,
- prompts,
- diffs,
- filenames or paths,
- repo names or URLs,
- raw command output,
- usernames,
- branch names,
- machine paths.

It only sends sanitized aggregate signals like:

- whether Kairn emitted, shrank, or suppressed context,
- estimated token savings,
- language mix and repo size bucket,
- hook/MCP errors,
- latency,
- whether Kairn seemed helpful, passive, or overactive.

Enable telemetry from inside your repo:

```bash
kairn telemetry enable --destination supabase
```

Check telemetry:

```bash
kairn telemetry status
```

Send queued sanitized metrics:

```bash
kairn telemetry flush
```

Telemetry also flushes automatically at safe points after it is enabled, such as when a `kairn codex` session exits or when you run `kairn beta report`. It does not upload during prompt hooks.

## See Whether Kairn Helped

From inside your repo:

```bash
kairn beta report
```

For deeper session metrics:

```bash
kairn metrics --session <session-id>
```

The numbers are estimates, not exact billing totals, but they help show whether Kairn was active, stayed silent, avoided repeated context, or may have over-assisted.

## Remove Kairn

From inside your repo:

```bash
kairn setup remove --delete-state
npm uninstall -g kairn
```

That removes Kairn-owned hook/MCP config and deletes the local `.kairn/` state.

## Beta Framing

This is still a private beta. The goal is not to prove Kairn magically helps every task. The goal is to prove it consistently helps more than it hurts, especially on large-repo, debug-heavy, and longer coding sessions.

If it feels useful, confusing, too quiet, too noisy, or breaks setup, I want to know. That feedback is exactly what this beta is for.
