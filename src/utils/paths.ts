import fs from "node:fs";
import path from "node:path";

export function resolveRoot(root?: string): string {
  const absolute = path.resolve(root ?? process.cwd());
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function resolveInsideRoot(rootPath: string, target: string): string {
  const absolute = path.resolve(rootPath, target);
  const relative = path.relative(rootPath, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Target escapes root: ${target}`);
  }

  return absolute;
}
