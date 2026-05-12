# Kairn Private Beta Message

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
npm install -g ./kairn-0.1.0.tgz
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
kairn telemetry enable \
  --destination supabase \
  --endpoint https://umefcjkwnphqzxkjwpgx.functions.supabase.co/kairn-telemetry-ingest
```

Check telemetry:

```bash
kairn telemetry status
```

Send queued sanitized metrics:

```bash
kairn telemetry flush
```

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
