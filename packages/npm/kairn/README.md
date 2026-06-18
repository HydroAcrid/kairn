# Kairn

This is the public beta npm launcher for Kairn.

Install:

```bash
npm install -g usekairn@beta
```

The launcher does not download arbitrary code during install. It resolves the platform-specific optional npm package installed by npm, then runs that package's Kairn binary.

The first npm beta supports macOS arm64 and Linux arm64/x64. Intel Mac and native Windows npm support are deferred until their binary smokes are stable; use WSL or the private beta fallback for now.

Telemetry is opt-in during Kairn setup. Installing the package does not enable telemetry, mutate shell profiles, or configure agent clients.

Uninstall:

```bash
kairn setup remove --root /path/to/repo
npm uninstall -g usekairn
```
