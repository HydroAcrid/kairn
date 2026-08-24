# Kairn Privacy Boundary

Kairn's useful core path is local by default. Repository scanning, indexes, evidence ranking, context selection, task/session state, hooks, and the MCP server operate on the user's machine and do not require a Kairn account, API key, or hosted Kairn backend.

## Local state

Repository-derived state is stored under the repository's `.kairn` directory. Agent client configuration may also be written to documented project-level files. `kairn enable` requires confirmation before applying changes; user-level Copilot CLI configuration is included in that confirmation. `kairn disable` removes Kairn-owned configuration, and `kairn disable --delete-state` also removes local `.kairn` state.

## Network behavior

Core Kairn operation does not require outbound network access. Package installation, an independently hosted model provider used by an agent, and explicitly enabled third-party comparison tools are outside the local Kairn runtime.

Telemetry upload is disabled by default. When explicitly enabled, its configuration, sanitization, queue, destination, and status are visible through Kairn's telemetry commands. Opt-in telemetry is operational evidence; it is not silently reused as ranker training data.

Controlled ReasonBlocks comparisons are benchmark-only, use public repositories, and require both a ReasonBlocks API key and an explicit external-trajectory flag. They are not part of normal Kairn operation.

## Training boundary

Bundled ranker artifacts must be trained from documented public or synthetic inputs. Normal customer repository content and `.kairn` state are excluded from training unless a future, separate contribution flow obtains explicit informed consent.
