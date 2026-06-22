# Kairn

This is the public beta npm launcher for Kairn.

Install:

```bash
npm install -g usekairn@beta
```

First repo setup:

```bash
cd /path/to/repo
kairn init
kairn doctor
```

The launcher does not download arbitrary code during install. It resolves the platform-specific optional npm package installed by npm, then runs that package's Kairn binary.

The npm beta supports macOS arm64/x64 and Linux arm64/x64. Windows users should use WSL during beta while the native Windows binary path is hardened.

Telemetry is opt-in during Kairn setup. Installing the package does not enable telemetry, mutate shell profiles, or configure agent clients.

If `kairn` is not found after install, check your npm global bin directory and shell `PATH`.

Uninstall:

```bash
kairn setup remove --root /path/to/repo
npm uninstall -g usekairn
```
