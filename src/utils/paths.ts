import path from "node:path";

export function resolveRoot(root?: string): string {
  return path.resolve(root ?? process.cwd());
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
