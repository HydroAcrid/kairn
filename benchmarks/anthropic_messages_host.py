#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Instrumented Anthropic Messages host for Kairn's four-arm comparison.

This benchmark-only program deliberately keeps raw prompts, source, model text, and
tool output out of its JSONL trace. ReasonBlocks-enabled arms still transmit the
trajectory slice required by ReasonBlocks and therefore require explicit consent.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
try:
    import resource
except ImportError:  # pragma: no cover - resource is unavailable on Windows.
    resource = None  # type: ignore[assignment]
import shlex
import stat
import struct
import subprocess
import sys
import time
from typing import Any, Callable
import uuid


CONDITIONS = {"vanilla", "reasonblocks", "kairn", "kairn_reasonblocks"}
HOST_PROTOCOL_VERSION = "comparison-host-v2"
WORKSPACE_TREE_SCOPE = "git-tracked-and-unignored-v1"
IGNORED_DIRS = {".git", ".kairn", "node_modules", "vendor", "dist", "build", "target"}
SOURCE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
    ".go", ".java", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi",
    ".ts", ".tsx", ".json", ".toml", ".yaml", ".yml", ".xml", ".md",
}
PINNED_SANDBOX_IMAGE = re.compile(r"^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$", re.I)


class InfrastructureError(RuntimeError):
    pass


class Trace:
    def __init__(self, target: Path, attempt_id: str) -> None:
        self.target = target
        self.attempt_id = attempt_id
        self.started = time.monotonic()
        self.sequence = 0
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("", encoding="utf-8")

    def write(self, kind: str, turn: int, model_step: int | None = None, **fields: Any) -> None:
        payload: dict[str, Any] = {
            "schemaVersion": 1,
            "attemptId": self.attempt_id,
            "sequence": self.sequence,
            "monotonicMs": round((time.monotonic() - self.started) * 1000),
            "turn": turn,
            "kind": kind,
        }
        if model_step is not None:
            payload["modelStep"] = model_step
        payload.update({key: value for key, value in fields.items() if value is not None})
        with self.target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
        self.sequence += 1


def estimate_tokens(value: str) -> int:
    return max(0, (len(value) + 3) // 4)


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def _hash_field(target: "hashlib._Hash", value: bytes) -> None:
    target.update(struct.pack(">Q", len(value)))
    target.update(value)


def workspace_tree_fingerprint(root: Path) -> dict[str, Any]:
    """Hash repository-relevant workspace bytes without timestamps or host paths.

    Git's tracked plus unignored-untracked inventory intentionally excludes .git
    internals and ignored dependency/build caches. File paths, kinds, executable
    bits, symlink targets, and regular-file bytes are committed to the digest.
    """
    completed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        env=scrubbed_repository_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise InfrastructureError("cannot enumerate the post-failure workspace tree")

    relative_paths = sorted({item for item in completed.stdout.split(b"\0") if item})
    tree = hashlib.sha256()
    tree.update(b"kairn-workspace-tree-v1\0")
    total_bytes = 0
    file_count = 0
    resolved_root = root.resolve()
    for raw_relative in relative_paths:
        relative = os.fsdecode(raw_relative)
        candidate = root / relative
        try:
            lexical = candidate.absolute()
            lexical.relative_to(resolved_root)
        except ValueError as error:
            raise InfrastructureError("workspace inventory escaped the repository root") from error

        normalized_path = relative.replace(os.sep, "/").encode("utf-8", errors="surrogateescape")
        _hash_field(tree, normalized_path)
        try:
            metadata = candidate.lstat()
        except FileNotFoundError:
            _hash_field(tree, b"missing")
            file_count += 1
            continue

        executable = b"1" if metadata.st_mode & 0o111 else b"0"
        if stat.S_ISLNK(metadata.st_mode):
            target = os.fsencode(os.readlink(candidate))
            _hash_field(tree, b"symlink")
            _hash_field(tree, executable)
            _hash_field(tree, target)
            total_bytes += len(target)
        elif stat.S_ISREG(metadata.st_mode):
            content = hashlib.sha256()
            size = 0
            with candidate.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    content.update(chunk)
                    size += len(chunk)
            _hash_field(tree, b"file")
            _hash_field(tree, executable)
            _hash_field(tree, struct.pack(">Q", size))
            _hash_field(tree, content.digest())
            total_bytes += size
        elif stat.S_ISDIR(metadata.st_mode):
            _hash_field(tree, b"directory")
        else:
            raise InfrastructureError("workspace inventory contains an unsupported file type")
        file_count += 1

    return {
        "digest": tree.hexdigest(),
        "fileCount": file_count,
        "bytes": total_bytes,
        "scope": WORKSPACE_TREE_SCOPE,
    }


def safe_file(root: Path, relative: str) -> tuple[Path, str]:
    normalized = relative.replace("\\", "/").removeprefix("./")
    if not normalized or normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
        raise ValueError("path must stay inside the benchmark workspace")
    candidate = (root / normalized).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise ValueError("path resolved outside the benchmark workspace")
    return candidate, candidate.relative_to(resolved_root).as_posix()


def file_event(
    path_value: str,
    delivery: str,
    text: str | None = None,
    start: int | None = None,
    end: int | None = None,
    token_estimate: int | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {"path": path_value, "delivery": delivery}
    if text is not None:
        event["contentHash"] = content_hash(text)
        event["tokenEstimate"] = estimate_tokens(text) if token_estimate is None else max(0, token_estimate)
    if start is not None:
        event["startLine"] = start
    if end is not None:
        event["endLine"] = end
    return event


def extract_paths(text: str, root: Path) -> list[str]:
    suffixes = "|".join(re.escape(item.removeprefix(".")) for item in sorted(SOURCE_SUFFIXES))
    pattern = re.compile(rf"(?<![\w./-])((?:[\w@.-]+/)*[\w@.-]+\.(?:{suffixes}))(?:[:(]\d+)?")
    output: list[str] = []
    for match in pattern.finditer(text):
        try:
            candidate, relative = safe_file(root, match.group(1))
        except ValueError:
            continue
        if not candidate.is_file() or candidate.is_symlink():
            continue
        if relative not in output:
            output.append(relative)
    return output[:80]


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def scrubbed_repository_environment() -> dict[str, str]:
    """Remove credentials before executing any repository-controlled code."""
    explicit = {
        "ANTHROPIC_API_KEY", "REASONBLOCKS_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN",
        "GH_TOKEN", "NPM_TOKEN", "PYPI_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET",
    }
    sensitive = re.compile(r"(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY)(?:$|_)", re.I)
    unsafe_git_environment = {
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
        "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS",
        "GIT_PROXY_COMMAND", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_SYSTEM",
    }
    output = {
        key: value
        for key, value in os.environ.items()
        if key not in explicit and key.upper() not in unsafe_git_environment and not sensitive.search(key)
    }
    for key in list(output):
        if re.match(r"^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$", key, re.I) or re.match(
            r"^(?:GIT|SSH)_ASKPASS$", key, re.I
        ):
            output.pop(key, None)
    output.update({
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GCM_INTERACTIVE": "Never",
    })
    return output


def sandbox_docker_args(root: Path, image: str, name: str, command: str) -> list[str]:
    uid = os.getuid() if hasattr(os, "getuid") else 65532
    gid = os.getgid() if hasattr(os, "getgid") else 65532
    args = [
        "docker", "run", "--rm", "--pull=never", "--name", name,
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "512",
        "--user", f"{uid}:{gid}",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777",
        "--mount", f"type=bind,source={root},target=/workspace",
        "--workdir", "/workspace",
        "--env", "HOME=/tmp/kairn-home",
        "--env", "CI=true",
        "--env", "GIT_CONFIG_NOSYSTEM=1",
        "--env", "GIT_CONFIG_GLOBAL=/dev/null",
        "--env", "GIT_TERMINAL_PROMPT=0",
        "--env", "GIT_OPTIONAL_LOCKS=0",
        "--entrypoint", "/bin/sh",
    ]
    git_directory = root / ".git"
    if git_directory.is_dir():
        args.extend(["--mount", f"type=bind,source={git_directory},target=/workspace/.git,readonly"])
    args.extend([
        image,
        "-c", 'umask 077; mkdir -p "$HOME"; exec /bin/sh -c "$1"', "kairn-bench", command,
    ])
    return args


def cleanup_sandbox_container(name: str) -> None:
    try:
        subprocess.run(
            ["docker", "rm", "--force", name],
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            env=scrubbed_repository_environment(),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        pass


def run_sandboxed_repository_command(root: Path, image: str, command: str, timeout: int) -> subprocess.CompletedProcess[str]:
    if not PINNED_SANDBOX_IMAGE.fullmatch(image):
        raise InfrastructureError("sandbox image must be pinned by an immutable sha256 digest")
    name = f"kairn-bench-{uuid.uuid4().hex}"
    try:
        completed = subprocess.run(
            sandbox_docker_args(root.resolve(), image, name, command),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            env=scrubbed_repository_environment(),
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        cleanup_sandbox_container(name)
        raise InfrastructureError(f"sandboxed repository command timed out after {timeout}s") from error
    except OSError as error:
        raise InfrastructureError(f"sandbox execution failed to start: {type(error).__name__}") from error
    if completed.returncode in {125, 126, 127}:
        cleanup_sandbox_container(name)
        raise InfrastructureError(
            f"sandbox execution failed with exit code {completed.returncode}: {completed.stdout[-1000:]}"
        )
    return completed


def ensure_sandbox_available(root: Path, image: str) -> None:
    if not PINNED_SANDBOX_IMAGE.fullmatch(image):
        raise InfrastructureError("sandbox image must be pinned by an immutable sha256 digest")
    try:
        inspected = subprocess.run(
            ["docker", "image", "inspect", image],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            env=scrubbed_repository_environment(),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise InfrastructureError(f"Docker sandbox is unavailable: {type(error).__name__}") from error
    if inspected.returncode != 0:
        raise InfrastructureError(
            "digest-pinned sandbox image is unavailable locally; the harness will not pull it: " + inspected.stdout[-1000:]
        )
    try:
        inspection = json.loads(inspected.stdout)
        volumes = inspection[0].get("Config", {}).get("Volumes") if isinstance(inspection, list) and inspection else None
    except (AttributeError, IndexError, json.JSONDecodeError, TypeError) as error:
        raise InfrastructureError("Docker returned an unreadable sandbox image inspection result") from error
    if isinstance(volumes, dict) and volumes:
        raise InfrastructureError("sandbox images must not declare writable VOLUME paths")
    preflight = run_sandboxed_repository_command(root, image, ":", 60)
    if preflight.returncode != 0:
        raise InfrastructureError(f"sandbox preflight failed with exit code {preflight.returncode}: {preflight.stdout[-1000:]}")


def directory_size(target: Path) -> int:
    total = 0
    if not target.exists():
        return 0
    for candidate in target.rglob("*"):
        try:
            if candidate.is_file() and not candidate.is_symlink():
                total += candidate.stat().st_size
        except OSError:
            continue
    return total


def peak_rss_bytes(who: int | None = None) -> int | None:
    if resource is None:
        return None
    value = int(resource.getrusage(resource.RUSAGE_SELF if who is None else who).ru_maxrss)
    return value if sys.platform == "darwin" else value * 1024


def child_cpu_seconds() -> float | None:
    if resource is None:
        return None
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return float(usage.ru_utime + usage.ru_stime)


def resource_metadata(cpu_started: float, child_cpu_started: float | None) -> dict[str, Any]:
    values: dict[str, Any] = {
        "hostCpuMs": round((time.process_time() - cpu_started) * 1000),
        "hostPeakRssBytes": peak_rss_bytes(),
        "resourceScope": "host process and direct children; Docker daemon/container workload excluded",
    }
    child_cpu = child_cpu_seconds()
    if child_cpu is not None and child_cpu_started is not None:
        values["directChildCpuMs"] = round(max(0.0, child_cpu - child_cpu_started) * 1000)
    if resource is not None:
        values["directChildPeakRssBytes"] = peak_rss_bytes(resource.RUSAGE_CHILDREN)
    return values


class RepositoryTools:
    def __init__(self, root: Path, task: dict[str, Any], trace: Trace) -> None:
        self.root = root.resolve()
        self.task = task
        self.trace = trace
        self.current_turn = 0
        self.current_step = 0
        self.pending_failure: str | None = None
        self.sandbox_image = task.get("sandbox_image") if isinstance(task.get("sandbox_image"), str) else ""
        self.allowed_commands = {
            item for item in [task.get("initial_failure_command"), task.get("verification_command")] if isinstance(item, str) and item
        }

    def specifications(self) -> list[dict[str, Any]]:
        return [
            {
                "name": "list_files",
                "description": "List repository files. Use a glob to keep the result focused.",
                "input_schema": {"type": "object", "properties": {"glob": {"type": "string"}}, "additionalProperties": False},
            },
            {
                "name": "search_repo",
                "description": "Search text in repository files and return matching source lines.",
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}, "glob": {"type": "string"}},
                    "required": ["query"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "read_file",
                "description": "Read a bounded line range from one repository file.",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "start_line": {"type": "integer", "minimum": 1},
                        "end_line": {"type": "integer", "minimum": 1},
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "apply_patch",
                "description": "Apply a unified diff inside the repository. The patch must use relative paths.",
                "input_schema": {
                    "type": "object",
                    "properties": {"patch": {"type": "string"}},
                    "required": ["patch"],
                    "additionalProperties": False,
                },
            },
            {
                "name": "run_verification",
                "description": "Run the preregistered failure or verification command.",
                "input_schema": {
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"],
                    "additionalProperties": False,
                },
            },
        ]

    def execute(self, name: str, arguments: dict[str, Any]) -> str:
        self.trace.write("tool_call", self.current_turn, self.current_step, tool=name)
        dispatch: dict[str, Callable[[dict[str, Any]], tuple[str, list[dict[str, Any]], bool | None]]] = {
            "list_files": self._list_files,
            "search_repo": self._search_repo,
            "read_file": self._read_file,
            "apply_patch": self._apply_patch,
            "run_verification": self._run_verification,
        }
        if name not in dispatch:
            raise ValueError(f"unsupported tool: {name}")
        try:
            result, files, passed = dispatch[name](arguments)
        except Exception as error:
            bounded = f"Tool error: {type(error).__name__}: {str(error)[:1000]}"
            self.trace.write(
                "tool_result", self.current_turn, self.current_step, tool=name, files=[], passed=False,
                tokenEstimate=estimate_tokens(bounded), metadata={"errorType": type(error).__name__},
            )
            raise
        self.trace.write(
            "tool_result", self.current_turn, self.current_step, tool=name, files=files, passed=passed,
            tokenEstimate=estimate_tokens(result),
        )
        return result

    def _iter_files(self, glob_value: str | None = None) -> list[tuple[Path, str]]:
        output: list[tuple[Path, str]] = []
        for candidate in self.root.rglob("*"):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            try:
                resolved = candidate.resolve(strict=True)
            except OSError:
                continue
            if resolved != self.root and self.root not in resolved.parents:
                continue
            relative = resolved.relative_to(self.root).as_posix()
            if any(part in IGNORED_DIRS for part in Path(relative).parts):
                continue
            if glob_value and not fnmatch.fnmatch(relative, glob_value):
                continue
            output.append((candidate, relative))
            if len(output) >= 6000:
                break
        return sorted(output, key=lambda item: item[1])

    def _list_files(self, arguments: dict[str, Any]) -> tuple[str, list[dict[str, Any]], None]:
        glob_value = arguments.get("glob") if isinstance(arguments.get("glob"), str) else None
        files = self._iter_files(glob_value)[:500]
        paths = [relative for _, relative in files]
        return "\n".join(paths), [file_event(item, "path_hint") for item in paths], None

    def _search_repo(self, arguments: dict[str, Any]) -> tuple[str, list[dict[str, Any]], None]:
        query = arguments.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("search query is required")
        glob_value = arguments.get("glob") if isinstance(arguments.get("glob"), str) else None
        lowered = query.casefold()
        output: list[str] = []
        event_files: list[dict[str, Any]] = []
        for candidate, relative in self._iter_files(glob_value):
            if candidate.suffix.lower() not in SOURCE_SUFFIXES:
                continue
            try:
                text = candidate.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            matched_lines: list[tuple[int, str]] = []
            for number, line in enumerate(text.splitlines(), start=1):
                if lowered in line.casefold():
                    matched_lines.append((number, line[:600]))
                    output.append(f"{relative}:{number}: {line[:600]}")
                    if len(output) >= 100:
                        break
            if matched_lines:
                excerpt = "\n".join(line for _, line in matched_lines)
                event_files.append(file_event(relative, "content", excerpt, matched_lines[0][0], matched_lines[-1][0]))
            if len(output) >= 100:
                break
        return "\n".join(output) if output else "No matches.", event_files, None

    def _read_file(self, arguments: dict[str, Any]) -> tuple[str, list[dict[str, Any]], None]:
        requested = arguments.get("path")
        if not isinstance(requested, str):
            raise ValueError("path is required")
        candidate, relative = safe_file(self.root, requested)
        if not candidate.is_file():
            raise ValueError("file does not exist")
        lines = candidate.read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(1, int(arguments.get("start_line", 1)))
        end = min(len(lines), int(arguments.get("end_line", start + 399)))
        if end < start:
            raise ValueError("end_line must be at or after start_line")
        selected = lines[start - 1 : end]
        text = "\n".join(f"{number:>6}  {line}" for number, line in enumerate(selected, start=start))
        raw = "\n".join(selected)
        return text, [file_event(relative, "content", raw, start, end)], None

    def _apply_patch(self, arguments: dict[str, Any]) -> tuple[str, list[dict[str, Any]], bool]:
        patch = arguments.get("patch")
        if not isinstance(patch, str) or not patch.strip():
            raise ValueError("patch is required")
        touched = self._patch_paths(patch)
        checked = subprocess.run(
            ["git", "apply", "--check", "--whitespace=nowarn", "-"],
            cwd=self.root,
            input=patch,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            env=scrubbed_repository_environment(),
        )
        if checked.returncode != 0:
            return f"Patch check failed:\n{checked.stdout[-4000:]}", [], False
        applied = subprocess.run(
            ["git", "apply", "--whitespace=nowarn", "-"],
            cwd=self.root,
            input=patch,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            env=scrubbed_repository_environment(),
        )
        files: list[dict[str, Any]] = []
        for relative in touched:
            candidate, normalized = safe_file(self.root, relative)
            text = candidate.read_text(encoding="utf-8", errors="replace") if candidate.is_file() else ""
            files.append(file_event(normalized, "path_hint", text if candidate.is_file() else None))
        self.trace.write("file_edit", self.current_turn, self.current_step, tool="apply_patch", files=files, passed=applied.returncode == 0)
        return applied.stdout[-4000:] or "Patch applied.", files, applied.returncode == 0

    def _patch_paths(self, patch: str) -> list[str]:
        paths: list[str] = []
        for line in patch.splitlines():
            if not line.startswith(("+++ ", "--- ")):
                continue
            value = line[4:].split("\t", 1)[0].strip()
            if value == "/dev/null":
                continue
            value = re.sub(r"^[ab]/", "", value)
            _, relative = safe_file(self.root, value)
            if relative not in paths:
                paths.append(relative)
        if not paths:
            raise ValueError("patch does not contain repository-relative file headers")
        return paths

    def _run_verification(self, arguments: dict[str, Any]) -> tuple[str, list[dict[str, Any]], bool]:
        command = arguments.get("command")
        if not isinstance(command, str) or command not in self.allowed_commands:
            raise ValueError("command is not one of the preregistered verification commands")
        completed = run_sandboxed_repository_command(self.root, self.sandbox_image, command, 300)
        output = completed.stdout[-20000:]
        paths = extract_paths(output, self.root)
        files = [file_event(item, "path_hint") for item in paths]
        passed = completed.returncode == 0
        self.trace.write("verification", self.current_turn, self.current_step, tool="run_verification", files=files, passed=passed)
        if not passed:
            self.pending_failure = output
            self.trace.write("failure", self.current_turn, self.current_step, tool="run_verification", files=files, passed=False)
        return output, files, passed


class KairnProvider:
    def __init__(self, command: str, root: Path, attempt_id: str) -> None:
        self.command = shlex.split(command)
        if not self.command:
            raise InfrastructureError("Kairn command is empty")
        self.root = root
        self.attempt_id = attempt_id
        self.session: str | None = None
        self.started = False
        self.ranker_status: dict[str, Any] | None = None

    def guidance(
        self, task: str, failure: str | None = None
    ) -> tuple[str, list[dict[str, Any]], int, str, dict[str, Any]]:
        started = time.monotonic()
        first_call = not self.started
        if first_call:
            # Let Kairn create a real session, then reuse the returned id. The
            # runtime intentionally rejects arbitrary unknown session ids.
            args = self.command + ["prime", task, "--root", str(self.root), "--budget", "700", "--json"]
            stdin = None
            self.started = True
        elif failure is not None:
            if self.session is None:
                raise InfrastructureError("Kairn provider has no session after its initial prime")
            args = self.command + ["failure", "--root", str(self.root), "--session", self.session, "--type", "generic", "--budget", "600", "--json"]
            stdin = failure
        else:
            if self.session is None:
                raise InfrastructureError("Kairn provider has no session after its initial prime")
            args = self.command + ["context", "--root", str(self.root), "--session", self.session, "--query", task, "--mode", "brief", "--budget", "500", "--json"]
            stdin = None
        try:
            completed = subprocess.run(
                args,
                cwd=self.root,
                input=stdin,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=180,
                env=scrubbed_repository_environment(),
            )
        except subprocess.TimeoutExpired as error:
            raise InfrastructureError("Kairn provider timed out after 180 seconds") from error
        except OSError as error:
            raise InfrastructureError(f"Kairn provider could not start: {type(error).__name__}") from error
        if completed.returncode != 0:
            raise InfrastructureError(f"Kairn provider failed with exit code {completed.returncode}")
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise InfrastructureError("Kairn provider returned invalid JSON") from error
        if first_call:
            session_payload = payload.get("session")
            returned_session = session_payload.get("id") if isinstance(session_payload, dict) else None
            if not isinstance(returned_session, str) or not returned_session:
                raise InfrastructureError("Kairn initial prime did not return a reusable session id")
            self.session = returned_session
        content = payload.get("content") if isinstance(payload.get("content"), str) else ""
        raw_files = payload.get("files") if isinstance(payload.get("files"), list) else []
        ranked_files = payload.get("rankedFiles") if isinstance(payload.get("rankedFiles"), list) else []
        payload_metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        ranker_status = payload_metadata.get("ranker")
        if not isinstance(ranker_status, dict):
            ranker_status = payload.get("rankerStatus")
        if isinstance(ranker_status, dict):
            allowed_status = {
                key: ranker_status[key]
                for key in ("requestedMode", "servedMode", "modelId", "featureSchemaVersion", "fallbackReason")
                if isinstance(ranker_status.get(key), str) and ranker_status[key]
            }
            if allowed_status:
                self.ranker_status = allowed_status
        delivery_by_path: dict[str, str] = {}
        ranker_models: set[str] = set()
        schema_versions: set[str] = set()
        for ranked in ranked_files:
            if not isinstance(ranked, dict) or not isinstance(ranked.get("path"), str):
                continue
            try:
                _, ranked_path = safe_file(self.root, ranked["path"])
            except ValueError:
                continue
            if ranked.get("delivery") in {"path_hint", "content"}:
                delivery_by_path[ranked_path] = ranked["delivery"]
            if isinstance(ranked.get("rankerModelId"), str):
                ranker_models.add(ranked["rankerModelId"])
            if isinstance(ranked.get("featureSchemaVersion"), str):
                schema_versions.add(ranked["featureSchemaVersion"])
        files: list[dict[str, Any]] = []
        normalized_files: list[str] = []
        for item in raw_files:
            if not isinstance(item, str):
                continue
            try:
                _, relative = safe_file(self.root, item)
            except ValueError:
                continue
            normalized_files.append(relative)
        # `files` is a ranking/governor field, not proof that the final bounded
        # payload actually delivered a path or source. Attribute only evidence
        # visible in the rendered text, and hash exact source lines found there.
        rendered_paths = list(dict.fromkeys([*normalized_files, *extract_paths(content, self.root)]))
        for relative in rendered_paths:
            event = rendered_provider_file_event(self.root, relative, content)
            if event is not None:
                files.append(event)
        action = payload.get("action") if payload.get("action") in {"emit", "shrink", "suppress", "request_evidence"} else ("emit" if content or files else "suppress")
        metadata: dict[str, Any] = {
            "injectionHash": content_hash(content),
            "kairnStateBytes": directory_size(self.root / ".kairn"),
            "structuredContentFiles": sum(1 for item in files if item["delivery"] == "content"),
            "declaredContentFiles": sum(1 for item in normalized_files if delivery_by_path.get(item) == "content"),
        }
        timings = payload.get("timings") if isinstance(payload.get("timings"), dict) else {}
        if first_call and isinstance(timings.get("initMs"), (int, float)):
            metadata["coldIndexingMs"] = max(0, round(float(timings["initMs"])))
        if ranker_models:
            metadata["rankerModelIds"] = sorted(ranker_models)
        if schema_versions:
            metadata["featureSchemaVersions"] = sorted(schema_versions)
        if self.ranker_status is not None:
            metadata["rankerStatus"] = dict(self.ranker_status)
        return content, files, round((time.monotonic() - started) * 1000), action, metadata


def rendered_provider_file_event(root: Path, relative: str, rendered: str) -> dict[str, Any] | None:
    normalized_rendered = rendered.replace("\\", "/")
    if relative.casefold() not in normalized_rendered.casefold():
        return None
    try:
        candidate, normalized = safe_file(root, relative)
    except ValueError:
        return None
    if not candidate.is_file() or candidate.is_symlink():
        return None
    try:
        source_lines = candidate.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return file_event(normalized, "path_hint")
    delivered: list[str] = []
    for line in source_lines:
        stripped = line.strip()
        if len(stripped) < 16 or stripped not in rendered:
            continue
        if stripped not in delivered:
            delivered.append(stripped)
        if len(delivered) >= 200:
            break
    if not delivered:
        return file_event(normalized, "path_hint")
    excerpt = "\n".join(delivered)
    return file_event(normalized, "content", excerpt)


def run_initial_failure(task: dict[str, Any], tools: RepositoryTools) -> str | None:
    command = task.get("initial_failure_command")
    if not isinstance(command, str) or not command:
        return None
    result, _, passed = tools._run_verification({"command": command})
    if passed:
        raise InfrastructureError("preregistered initial failure command unexpectedly passed")
    return result


def reasonblocks_version() -> str | None:
    return package_version("reasonblocks")


def reasonblocks_service_version(condition: str) -> str | None:
    if condition not in {"reasonblocks", "kairn_reasonblocks"}:
        return None
    value = os.environ.get("REASONBLOCKS_SERVICE_VERSION", "").strip()
    return value or "unavailable"


def make_reasonblocks_session(args: argparse.Namespace, task: dict[str, Any], initial_task: str):
    try:
        from reasonblocks import ReasonBlocks
    except ImportError as error:
        raise InfrastructureError("reasonblocks is not installed; install the pinned benchmark requirements") from error
    api_key = os.environ.get("REASONBLOCKS_API_KEY")
    if not api_key:
        raise InfrastructureError("REASONBLOCKS_API_KEY is required")
    try:
        rb = ReasonBlocks(api_key=api_key, model_routing={})
        return rb.claude_messages_session(
            agent_name="kairn-comparison",
            task=initial_task,
            model=args.model,
            codebase_id=f"kairn-public/{task['attempt_id']}/{task['run_id']}/{task['execution_id']}",
        )
    except Exception as error:
        raise InfrastructureError(f"ReasonBlocks session setup failed: {type(error).__name__}") from error


def block_to_dict(block: Any) -> dict[str, Any]:
    if hasattr(block, "model_dump"):
        return block.model_dump()
    if isinstance(block, dict):
        return block
    raise TypeError("Anthropic response block is not serializable")


def text_from_blocks(blocks: list[Any]) -> str:
    return "\n".join(getattr(block, "text", "") for block in blocks if getattr(block, "type", "") == "text")


def reasonblocks_decision_metadata(decision: Any, rendered_text: str) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "state": str(getattr(decision, "state", "unknown")),
        "modelRouted": False,
        "injectionHash": content_hash(rendered_text),
    }
    pattern_hashes: set[str] = set()
    monitor_events = 0
    pending_count = 0
    for name in ("pending", "pending_patterns", "matched_patterns", "patterns", "monitor_events", "triggered_monitors"):
        value = getattr(decision, name, None)
        if not isinstance(value, (list, tuple, set)):
            continue
        if name == "pending":
            pending_count = len(value)
        if "monitor" in name:
            monitor_events += len(value)
        for item in value:
            identity: dict[str, str] = {"type": type(item).__name__}
            for field in ("id", "name", "key", "tier", "source", "kind", "pattern_id", "monitor_id"):
                candidate = getattr(item, field, None)
                if isinstance(candidate, (str, int, float, bool)):
                    identity[field] = str(candidate)
            for field in ("text", "content", "body"):
                candidate = getattr(item, field, None)
                if isinstance(candidate, str) and candidate:
                    identity[f"{field}Hash"] = content_hash(candidate)
            pattern_hashes.add(content_hash(json.dumps(identity, sort_keys=True, separators=(",", ":"))))
    entry = getattr(decision, "entry", None)
    for name in ("monitor_events", "triggered_monitors", "monitor_results"):
        value = getattr(entry, name, None)
        if isinstance(value, (list, tuple, set)):
            monitor_events += len(value)
    metadata["patternHashes"] = sorted(pattern_hashes)
    metadata["pendingInjectionCount"] = pending_count
    metadata["monitorEventCount"] = monitor_events
    return metadata


def reasonblocks_effective_protocol(session: Any) -> dict[str, Any]:
    """Inspect the SteeringSession assembled by the installed SDK.

    Benchmark requests are not evidence of effective behavior. These fields
    are derived from the live session object and combined with lifecycle and
    decision evidence in the TypeScript trace validator.
    """
    injections = getattr(session, "injections", None)
    if injections is None:
        injections = getattr(session, "_injections", None)
    injection_values = list(injections) if isinstance(injections, (list, tuple, set)) else []
    injection_types = sorted({type(item).__name__ for item in injection_values})
    normalized_types = " ".join(injection_types).casefold()
    model_routing = getattr(session, "model_routing", None)
    if model_routing is None:
        model_routing = getattr(session, "_model_routing", None)
    state_manager = getattr(session, "state_manager", None)
    if state_manager is None:
        state_manager = getattr(session, "_state_manager", None)
    return {
        "inspection": "installed_session_object",
        "modelRoutingConfigured": bool(model_routing),
        "stateManagerPresent": state_manager is not None,
        "injectionCount": len(injection_values),
        "injectionTypes": injection_types,
        "monitorSteeringPresent": "monitor" in normalized_types,
        "eTraceInjectionPresent": any(
            marker in normalized_types
            for marker in ("etrace", "e_trace", "pattern", "universal", "commons", "instance", "e1", "e2", "e3")
        ),
    }


class InfrastructureContext:
    """Translate hosted-session lifecycle failures into invalid infrastructure attempts."""

    def __init__(self, context: Any) -> None:
        self.context = context
        self.open_latency_ms = 0
        self.close_latency_ms = 0

    def __enter__(self):
        started = time.monotonic()
        try:
            value = self.context.__enter__()
            self.open_latency_ms = round((time.monotonic() - started) * 1000)
            return value
        except Exception as error:
            raise InfrastructureError(f"ReasonBlocks session open failed: {type(error).__name__}") from error

    def __exit__(self, exc_type, exc_value, traceback):
        started = time.monotonic()
        try:
            value = self.context.__exit__(exc_type, exc_value, traceback)
            self.close_latency_ms = round((time.monotonic() - started) * 1000)
            return value
        except Exception as error:
            raise InfrastructureError(f"ReasonBlocks session close failed: {type(error).__name__}") from error


def build_user_turns(task: dict[str, Any], initial_failure: str | None) -> list[str]:
    turns = task.get("turns") if isinstance(task.get("turns"), list) else []
    prompts = [item.get("prompt") for item in turns if isinstance(item, dict) and isinstance(item.get("prompt"), str)]
    if not prompts:
        prompts = [task["prompt"]]
    if initial_failure:
        prompts[0] = f"{prompts[0]}\n\nThe preregistered command failed before assistance:\n{initial_failure[-12000:]}"
    return prompts


def run_agent(args: argparse.Namespace, task: dict[str, Any], trace: Trace) -> dict[str, Any]:
    try:
        from anthropic import Anthropic
    except ImportError as error:
        raise InfrastructureError("anthropic is not installed; install the pinned benchmark requirements") from error
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise InfrastructureError("ANTHROPIC_API_KEY is required")

    condition = args.condition
    use_kairn = condition in {"kairn", "kairn_reasonblocks"}
    use_reasonblocks = condition in {"reasonblocks", "kairn_reasonblocks"}
    if use_reasonblocks and not args.allow_external_trajectory:
        raise InfrastructureError("ReasonBlocks requires --allow-external-trajectory")

    root = Path(args.workspace).resolve()
    validate_preregistered_paths(root, task)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise InfrastructureError("ANTHROPIC_API_KEY is required")
    client = Anthropic(api_key=api_key)
    tools = RepositoryTools(root, task, trace)
    initial_failure = run_initial_failure(task, tools)
    tools.pending_failure = None
    messages: list[dict[str, Any]] = []
    user_turns = build_user_turns(task, initial_failure)
    workspace_tree = workspace_tree_fingerprint(root)
    trace.write(
        "assistance_start", 0,
        metadata={
            "initialFailureReady": initial_failure is not None,
            "workspaceTreeDigest": workspace_tree["digest"],
            "workspaceTreeFileCount": workspace_tree["fileCount"],
            "workspaceTreeBytes": workspace_tree["bytes"],
            "workspaceTreeScope": workspace_tree["scope"],
        },
    )
    kairn_constructed_at = time.monotonic()
    kairn = KairnProvider(args.kairn_command, root, task["attempt_id"]) if use_kairn else None
    kairn_construction_ms = round((time.monotonic() - kairn_constructed_at) * 1000) if use_kairn else 0
    reasonblocks_constructed_at = time.monotonic()
    session_context = make_reasonblocks_session(args, task, user_turns[0]) if use_reasonblocks else None
    reasonblocks_construction_ms = round((time.monotonic() - reasonblocks_constructed_at) * 1000) if use_reasonblocks else 0
    base_system = (
        "You are completing a controlled public-repository coding task. "
        "Use only the supplied repository tools for discovery, reading, editing, and verification. "
        "Do not use shell commands or infer success without running the preregistered verifier. "
        "Make the smallest production-source change that satisfies the task."
    )
    context_manager = InfrastructureContext(session_context) if session_context is not None else NullContext()
    global_step = 0
    last_thought: str | None = None
    last_observation: str | None = None
    last_action: str | None = None
    last_action_input: dict[str, Any] | None = None
    current_kairn_guidance = ""
    current_kairn_files: list[dict[str, Any]] = []
    last_kairn_event_step = -1
    first_kairn_guidance_ms: int | None = None

    with context_manager as session:
        effective_reasonblocks_protocol = reasonblocks_effective_protocol(session) if session is not None else None
        for turn_index, user_prompt in enumerate(user_turns):
            prompt_paths = [file_event(item, "path_hint") for item in extract_paths(user_prompt, root)]
            trace.write(
                "turn_start", turn_index, files=prompt_paths,
                tokenEstimate=estimate_tokens(user_prompt),
                metadata={"promptPathCount": len(prompt_paths)},
            )
            tools.current_turn = turn_index
            messages.append({"role": "user", "content": user_prompt})
            if turn_index > 0:
                last_observation = f"New user turn: {user_prompt[-12000:]}"
            if kairn is not None:
                current_kairn_guidance, current_kairn_files, latency, action, provider_metadata = kairn.guidance(user_prompt)
                if first_kairn_guidance_ms is None:
                    first_kairn_guidance_ms = latency
                trace.write(
                    "provider_injection", turn_index, global_step, provider="kairn", action=action,
                    tokenEstimate=estimate_tokens(current_kairn_guidance), latencyMs=latency, files=current_kairn_files,
                    metadata={"refreshed": True, **provider_metadata},
                )
                last_kairn_event_step = global_step
            turn_finished = False
            while not turn_finished:
                if global_step >= args.max_steps:
                    raise RuntimeError("maximum model steps reached")
                tools.current_step = global_step
                if kairn is not None and tools.pending_failure is not None:
                    current_kairn_guidance, current_kairn_files, latency, action, provider_metadata = kairn.guidance(user_prompt, tools.pending_failure)
                    tools.pending_failure = None
                    trace.write(
                        "provider_injection", turn_index, global_step, provider="kairn", action=action,
                        tokenEstimate=estimate_tokens(current_kairn_guidance), latencyMs=latency, files=current_kairn_files,
                        metadata={"refreshed": True, "failureFirst": True, **provider_metadata},
                    )
                    last_kairn_event_step = global_step
                elif kairn is not None and last_kairn_event_step != global_step:
                    trace.write(
                        "provider_injection", turn_index, global_step, provider="kairn",
                        action="emit" if current_kairn_guidance else "suppress",
                        tokenEstimate=estimate_tokens(current_kairn_guidance), latencyMs=0, files=current_kairn_files,
                        metadata={
                            "refreshed": False,
                            **({"rankerStatus": dict(kairn.ranker_status)} if kairn.ranker_status is not None else {}),
                        },
                    )
                    last_kairn_event_step = global_step

                system = base_system
                if current_kairn_guidance:
                    system += f"\n\n[KAIRN REPOSITORY EVIDENCE]\n{current_kairn_guidance}"
                decision = None
                if session is not None:
                    rb_started = time.monotonic()
                    try:
                        decision = session.begin_step(
                            thought=last_thought,
                            action=last_action,
                            action_input=last_action_input,
                            observation=last_observation,
                        )
                    except Exception as error:
                        raise InfrastructureError(f"ReasonBlocks begin_step failed: {type(error).__name__}") from error
                    rb_text = decision.rendered_injection_text or ""
                    if getattr(decision, "model_override", None) is not None:
                        raise InfrastructureError("ReasonBlocks returned a model override despite routing being disabled")
                    rb_files = [
                        event
                        for item in extract_paths(rb_text, root)
                        if (event := rendered_provider_file_event(root, item, rb_text)) is not None
                    ]
                    trace.write(
                        "provider_injection", turn_index, global_step, provider="reasonblocks",
                        action="emit" if rb_text else "suppress", tokenEstimate=estimate_tokens(rb_text),
                        latencyMs=round((time.monotonic() - rb_started) * 1000),
                        files=rb_files,
                        metadata={
                            **reasonblocks_decision_metadata(decision, rb_text),
                            "reasonblocksEffectiveProtocol": effective_reasonblocks_protocol,
                        },
                    )
                    try:
                        system = decision.compose_system_prompt(system)
                    except Exception as error:
                        raise InfrastructureError(f"ReasonBlocks prompt composition failed: {type(error).__name__}") from error

                trace.write("model_request", turn_index, global_step)
                model_started = time.monotonic()
                try:
                    response = client.messages.create(
                        model=args.model,
                        max_tokens=args.max_tokens,
                        temperature=args.temperature,
                        system=system,
                        messages=messages,
                        tools=tools.specifications(),
                    )
                except Exception as error:
                    raise InfrastructureError(f"Anthropic Messages request failed: {type(error).__name__}") from error
                latency_ms = round((time.monotonic() - model_started) * 1000)
                fresh_input_tokens = int(getattr(response.usage, "input_tokens", 0) or 0)
                cached_tokens = int(getattr(response.usage, "cache_read_input_tokens", 0) or 0)
                cache_creation_tokens = int(getattr(response.usage, "cache_creation_input_tokens", 0) or 0)
                input_tokens = fresh_input_tokens + cached_tokens + cache_creation_tokens
                output_tokens = int(getattr(response.usage, "output_tokens", 0) or 0)
                trace.write(
                    "model_response", turn_index, global_step, inputTokens=input_tokens,
                    cachedInputTokens=min(input_tokens, cached_tokens),
                    cacheCreationInputTokens=min(max(0, input_tokens - cached_tokens), cache_creation_tokens),
                    outputTokens=output_tokens,
                    latencyMs=latency_ms,
                    metadata={"stopReason": response.stop_reason, "resolvedModel": getattr(response, "model", args.model)},
                )
                assistant_blocks = [block_to_dict(block) for block in response.content]
                messages.append({"role": "assistant", "content": assistant_blocks})
                last_thought = text_from_blocks(response.content)
                tool_uses = [block for block in response.content if getattr(block, "type", "") == "tool_use"]
                tool_names: list[str] = []
                tool_results: list[dict[str, Any]] = []
                observations: list[str] = []
                for tool_use in tool_uses:
                    tool_names.append(str(tool_use.name))
                    try:
                        result = tools.execute(str(tool_use.name), dict(tool_use.input))
                        is_error = False
                    except InfrastructureError:
                        raise
                    except Exception as error:  # The model receives a bounded tool error, not a traceback.
                        result = f"Tool error: {type(error).__name__}: {str(error)[:1000]}"
                        is_error = True
                    observations.append(result)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": str(tool_use.id),
                        "content": result,
                        "is_error": is_error,
                    })
                if tool_uses:
                    last_tool = tool_uses[-1]
                    last_action = str(last_tool.name)
                    last_action_input = dict(last_tool.input)
                else:
                    last_action = None
                    last_action_input = None
                last_observation = "\n\n".join(observations)[-12000:] if observations else None
                if decision is not None:
                    try:
                        session.end_step(
                            decision,
                            model_id=args.model,
                            tokens=input_tokens + output_tokens,
                            tool_calls=tool_names,
                            latency_ms=float(latency_ms),
                            observation=last_observation,
                        )
                    except Exception as error:
                        raise InfrastructureError(f"ReasonBlocks end_step failed: {type(error).__name__}") from error
                global_step += 1
                if tool_results:
                    messages.append({"role": "user", "content": tool_results})
                else:
                    turn_finished = True
            trace.write("turn_end", turn_index, global_step)

    final_text = last_thought or ""
    sys.stdout.write(final_text)
    step_log = getattr(session, "step_log", None) if session is not None else None
    return {
        "reasonblocksStepLogEntries": len(step_log) if isinstance(step_log, (list, tuple)) else 0,
        "reasonblocksLifecycleCompleted": bool(use_reasonblocks),
        "kairnSetupMs": kairn_construction_ms + (first_kairn_guidance_ms or 0),
        "reasonblocksSetupMs": reasonblocks_construction_ms + context_manager.open_latency_ms,
        "reasonblocksCloseMs": context_manager.close_latency_ms,
        "kairnStateBytes": directory_size(root / ".kairn"),
    }


def validate_preregistered_paths(root: Path, task: dict[str, Any]) -> None:
    sandbox_image = task.get("sandbox_image")
    if not isinstance(sandbox_image, str) or not sandbox_image:
        raise InfrastructureError("controlled task is missing its digest-pinned sandbox image")
    ensure_sandbox_available(root, sandbox_image)
    for field in ("required_source_files", "required_touched_files", "allowed_support_files"):
        values = task.get(field, [])
        if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
            raise InfrastructureError(f"task field {field} is invalid")
        for item in values:
            try:
                candidate, _ = safe_file(root, item)
            except ValueError as error:
                raise InfrastructureError(f"preregistered path in {field} is unsafe") from error
            if not candidate.is_file() or candidate.is_symlink():
                raise InfrastructureError(f"preregistered path in {field} is missing or not a regular file")


class NullContext:
    open_latency_ms = 0
    close_latency_ms = 0

    def __enter__(self):
        return None

    def __exit__(self, exc_type, exc_value, traceback):
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--condition", choices=sorted(CONDITIONS), required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--task-file", required=True)
    parser.add_argument("--trace", required=True)
    parser.add_argument("--model", default="claude-sonnet-4-6")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-steps", type=int, default=40)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--kairn-command", default="kairn")
    parser.add_argument("--allow-external-trajectory", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    task = json.loads(Path(args.task_file).read_text(encoding="utf-8"))
    if not isinstance(task.get("run_id"), str) or not task["run_id"]:
        raise SystemExit("experiment task file is missing run_id")
    if not isinstance(task.get("execution_id"), str) or not task["execution_id"]:
        raise SystemExit("experiment task file is missing execution_id")
    environment_fingerprint_hash = task.get("environment_fingerprint_hash")
    if not isinstance(environment_fingerprint_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", environment_fingerprint_hash):
        raise SystemExit("experiment task file is missing a valid environment_fingerprint_hash")
    execution_environment_hash = task.get("execution_environment_hash")
    if not isinstance(execution_environment_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", execution_environment_hash):
        raise SystemExit("experiment task file is missing a valid execution_environment_hash")
    trace = Trace(Path(args.trace), task["attempt_id"])
    cpu_started = time.process_time()
    child_cpu_started = child_cpu_seconds()
    tool_schema = RepositoryTools(Path(args.workspace).resolve(), task, trace).specifications()
    trace.write(
        "attempt_start", 0, metadata={
            "condition": args.condition,
            "model": args.model,
            "runId": task["run_id"],
            "executionId": task["execution_id"],
            "environmentFingerprintHash": environment_fingerprint_hash,
            "executionEnvironmentHash": execution_environment_hash,
            "hostProtocolVersion": HOST_PROTOCOL_VERSION,
            "toolSchemaHash": content_hash(json.dumps(tool_schema, sort_keys=True, separators=(",", ":"))),
            "anthropicVersion": package_version("anthropic"),
            "reasonblocksVersion": reasonblocks_version(),
            "reasonblocksServiceVersion": reasonblocks_service_version(args.condition),
            "reasonblocksServiceVersionSource": "operator_asserted" if os.environ.get("REASONBLOCKS_SERVICE_VERSION", "").strip() else "unavailable",
            "pythonVersion": sys.version.split()[0],
            "externalTrajectoryAllowed": bool(args.allow_external_trajectory),
            "reasonblocksProtocolRequested": {
                "adapter": "SteeringSession.begin_step/end_step",
                "modelRouting": False,
                "serverMonitors": True,
                "eTraces": True,
                "withinSessionState": True,
                "prepopulatedMemory": False,
                "importGraph": False,
                "langchainCompression": False,
            } if args.condition in {"reasonblocks", "kairn_reasonblocks"} else None,
        },
    )
    try:
        runtime_metadata = run_agent(args, task, trace)
        trace.write(
            "attempt_end", 0, passed=True,
            metadata={
                "category": "completed",
                **resource_metadata(cpu_started, child_cpu_started),
                **runtime_metadata,
            },
        )
        return 0
    except InfrastructureError as error:
        trace.write(
            "attempt_end", 0, passed=False,
            metadata={
                "category": "infrastructure", "errorType": type(error).__name__,
                **resource_metadata(cpu_started, child_cpu_started),
                "kairnStateBytes": directory_size(Path(args.workspace).resolve() / ".kairn"),
            },
        )
        sys.stderr.write(f"experiment host infrastructure failure: {error}\n")
        return 2
    except Exception as error:
        trace.write(
            "attempt_end", 0, passed=False,
            metadata={
                "category": "agent", "errorType": type(error).__name__,
                **resource_metadata(cpu_started, child_cpu_started),
                "kairnStateBytes": directory_size(Path(args.workspace).resolve() / ".kairn"),
            },
        )
        sys.stderr.write(f"experiment host failure: {type(error).__name__}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
