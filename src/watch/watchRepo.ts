import path from "node:path";
import { watch } from "chokidar";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { WatchSnapshot } from "../types.js";
import { createRepoIgnore } from "../scanner/scanRepo.js";
import { normalizeRelativePath } from "../utils/paths.js";

export async function runRepoWatcher(input: {
  runtime: KairnRuntime;
  sessionId: string;
  rootPath: string;
  debounceMs: number;
  pollMs: number;
  once?: boolean | undefined;
  onSnapshot: (snapshot: WatchSnapshot) => void;
}): Promise<void> {
  if (input.once) {
    input.onSnapshot(await input.runtime.createWatchSnapshot({ sessionId: input.sessionId, source: "watch" }));
    return;
  }

  const ignored = createRepoIgnore(input.rootPath);
  const pendingFiles = new Set<string>();
  let debounceTimer: NodeJS.Timeout | undefined;

  const flush = async () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }

    const changedFiles = [...pendingFiles];
    pendingFiles.clear();
    input.onSnapshot(
      await input.runtime.createWatchSnapshot({
        sessionId: input.sessionId,
        changedFiles,
        source: "watch"
      })
    );
  };

  const watcher = watch(input.rootPath, {
    ignored: (candidatePath) => isIgnored(input.rootPath, candidatePath, ignored),
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50
    }
  });

  watcher.on("all", (_eventName, candidatePath) => {
    const relative = relativePath(input.rootPath, candidatePath);
    if (!relative) return;
    pendingFiles.add(relative);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      flush().catch((error: unknown) => {
        process.stderr.write(`kairn watch: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, input.debounceMs);
  });

  const pollTimer = setInterval(() => {
    input.runtime
      .createWatchSnapshot({ sessionId: input.sessionId, source: "watch" })
      .then(input.onSnapshot)
      .catch((error: unknown) => {
        process.stderr.write(`kairn watch: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }, input.pollMs);

  input.onSnapshot(await input.runtime.createWatchSnapshot({ sessionId: input.sessionId, source: "watch" }));

  await new Promise<void>((resolve) => {
    const close = () => {
      clearInterval(pollTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close().finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function isIgnored(rootPath: string, candidatePath: string, ignored: ReturnType<typeof createRepoIgnore>): boolean {
  const relative = relativePath(rootPath, candidatePath);
  if (!relative) return false;
  return ignored.ignores(relative);
}

function relativePath(rootPath: string, candidatePath: string): string | undefined {
  const relative = normalizeRelativePath(path.relative(rootPath, candidatePath));
  if (!relative || relative === "." || relative.startsWith("..")) return undefined;
  return relative;
}
