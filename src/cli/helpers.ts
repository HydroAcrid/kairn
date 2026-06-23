import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { KairnRuntime } from "../runtime/KairnRuntime.js";

export async function withRuntime<T>(root: string, cb: (runtime: KairnRuntime) => Promise<T>): Promise<T> {
  ensureKairnInternalStateExcluded(root);
  const runtime = new KairnRuntime(root);
  try {
    return await cb(runtime);
  } finally {
    runtime.close();
  }
}

export function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

export function codexExecArgs(input: {
  root: string;
  prompt: string;
  model?: string | undefined;
  sandbox: string;
  enableHooks?: boolean | undefined;
  skipGitRepoCheck?: boolean | undefined;
}): string[] {
  return [
    "exec",
    ...(input.model ? ["--model", input.model] : []),
    "--sandbox",
    input.sandbox,
    ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    ...(input.enableHooks ? ["--enable", "hooks"] : ["--disable", "hooks"]),
    "--cd",
    path.resolve(input.root),
    input.prompt
  ];
}

export function codexInteractiveArgs(input: {
  root: string;
  initialPrompt?: string | undefined;
  model?: string | undefined;
  sandbox: string;
  enableHooks?: boolean | undefined;
  skipGitRepoCheck?: boolean | undefined;
}): string[] {
  return [
    ...(input.model ? ["--model", input.model] : []),
    "--sandbox",
    input.sandbox,
    ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    ...(input.enableHooks ? ["--enable", "hooks"] : []),
    "--cd",
    path.resolve(input.root),
    ...(input.initialPrompt ? [input.initialPrompt] : [])
  ];
}

export async function waitForShutdown(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      close().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ensureKairnInternalStateExcluded(root: string): boolean {
  const rootPath = path.resolve(root);
  const gitDir = path.join(rootPath, ".git");
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return false;

  const infoDir = path.join(gitDir, "info");
  const excludePath = path.join(infoDir, "exclude");
  fs.mkdirSync(infoDir, { recursive: true });

  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  if (/^\.kairn\/?$/m.test(existing)) return false;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(excludePath, `${existing}${prefix}.kairn/\n`);
  return true;
}

export function withKairnInternalStateHidden<T>(root: string, enabled: boolean, cb: () => T): T {
  const rootPath = path.resolve(root);
  const stateDir = path.join(rootPath, ".kairn");
  const gitDir = path.join(rootPath, ".git");
  if (!enabled || !fs.existsSync(stateDir) || !fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    return cb();
  }

  const hiddenDir = path.join(gitDir, `kairn-state-hidden-${process.pid}-${randomUUID()}`);
  let hidden = false;
  try {
    fs.renameSync(stateDir, hiddenDir);
    hidden = true;
  } catch {
    return cb();
  }

  try {
    return cb();
  } finally {
    if (hidden && fs.existsSync(hiddenDir) && !fs.existsSync(stateDir)) {
      fs.renameSync(hiddenDir, stateDir);
    }
  }
}
