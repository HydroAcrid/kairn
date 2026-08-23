# Kairn MCP Governance Follow-Up - 2026-06-12

## Summary

After the MCP known-source stabilization fix, two repeat-3 endurance suites passed with real MCP-first assistance:

- Click compatibility encoding: 3/3 baseline pass, 3/3 real_mcp_first pass, median 61.2% token reduction.
- Fastify HEAD route onSend: 3/3 baseline pass, 3/3 real_mcp_first pass, median 38.1% token reduction.

Both suites recorded actual MCP calls and useful source attribution. Fastify provides the required non-Python/JS suite signal.

## What Changed

The endurance MCP prompt builder now prefers verified or agent-mentioned source over stale MCP fanout before continuing from a known source. This prevents a failed or out-of-scope turn from poisoning later MCP guidance.

## Gate Read

- MCP smoke: passed.
- Repeat-3 MCP/endurance suites: 2 passed.
- Non-Python suite: Fastify passed.
- Repeated broad fanout / quality drop / scope violation class: none in this follow-up.

This closes the MCP gate for the known-source stabilization checkpoint. The broader branch is still not public-claim ready until the additional official SWE-Pro confirmation rows are complete.
