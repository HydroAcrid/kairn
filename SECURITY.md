# Security Policy

## Supported versions

Security fixes are applied to the latest published Kairn release. A fix may also be backported when an older release remains in active use.

## Reporting a vulnerability

Use GitHub's private security-advisory flow for `HydroAcrid/kairn`. Include the affected version, reproduction steps, impact, and any proposed mitigation. Do not include private repository content or credentials beyond what is strictly necessary to reproduce the issue.

Please do not open a public issue until a fix or coordinated disclosure is ready. The maintainer will acknowledge a complete report, assess severity, and coordinate a release and disclosure timeline with the reporter.

## Security boundary

Kairn's core indexing, ranking, hook, MCP, and session paths run locally. Telemetry is disabled by default and is a separate, explicit opt-in. See [docs/privacy-boundary.md](docs/privacy-boundary.md) for the data-flow contract.
