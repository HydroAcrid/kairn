// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { KairnRuntime } from "../runtime/KairnRuntime.js";

export async function withRuntime<T>(root: string, cb: (runtime: KairnRuntime) => Promise<T>): Promise<T> {
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
}): string[] {
  return [
    "exec",
    ...(input.model ? ["--model", input.model] : []),
    "--sandbox",
    input.sandbox,
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
}): string[] {
  return [
    ...(input.model ? ["--model", input.model] : []),
    "--sandbox",
    input.sandbox,
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
