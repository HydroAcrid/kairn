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
  const root = resolveRoot(rootPath);
  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Target escapes root: ${target}`);
  }

  if (fs.existsSync(absolute)) {
    const real = fs.realpathSync.native(absolute);
    const realRelative = path.relative(root, real);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Target escapes root: ${target}`);
    }
    return real;
  }

  return absolute;
}
