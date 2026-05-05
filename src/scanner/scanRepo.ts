import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { FileRecord, ScanResult } from "../types.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath, resolveRoot } from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { classifyFile, detectLanguage, scoreFileImportance } from "./classifyFile.js";

const DEFAULT_IGNORE = [
  ".git/**",
  ".kairn/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".turbo/**",
  ".cache/**",
  "coverage/**",
  "target/**",
  "vendor/**",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.sqlite",
  "*.db"
];

export async function scanRepo(root?: string): Promise<ScanResult> {
  const rootPath = resolveRoot(root);
  const gitignore = loadGitignore(rootPath);
  const scannedAt = nowIso();

  const candidates = await fg("**/*", {
    cwd: rootPath,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORE,
    unique: true
  });

  let ignoredCount = 0;
  const files: FileRecord[] = [];

  for (const candidate of candidates) {
    const relativePath = normalizeRelativePath(candidate);

    if (gitignore.ignores(relativePath)) {
      ignoredCount += 1;
      continue;
    }

    const absolutePath = path.join(rootPath, relativePath);
    const stat = fs.statSync(absolutePath);

    if (stat.size > 400_000) {
      ignoredCount += 1;
      continue;
    }

    const content = fs.readFileSync(absolutePath);
    const kind = classifyFile(relativePath);

    files.push({
      rootPath,
      path: relativePath,
      language: detectLanguage(relativePath),
      kind,
      size: stat.size,
      hash: sha256(content),
      importance: scoreFileImportance(relativePath, kind),
      updatedAt: scannedAt
    });
  }

  return {
    rootPath,
    files,
    ignoredCount,
    scannedAt
  };
}

function loadGitignore(rootPath: string): ReturnType<typeof ignore> {
  const ig = ignore();
  const gitignorePath = path.join(rootPath, ".gitignore");

  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }

  return ig;
}
