import path from "node:path";
import type { FileKind } from "../types.js";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".rb": "ruby",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml"
};

export function detectLanguage(filePath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "text";
}

export function classifyFile(filePath: string): FileKind {
  const normalized = filePath.toLowerCase();
  const basename = path.basename(normalized);

  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(basename) ||
    /_test\.pyi?$/.test(basename) ||
    /tests?\//.test(normalized) && /\.pyi?$/.test(basename) ||
    /(test|tests)\.java$/.test(basename) ||
    /(^|\/)src\/test\/java\//.test(normalized) ||
    /(_test|_unittest|_tests)\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(basename) ||
    /^test_.*\.(cc|cpp|cxx|c)$/.test(basename) ||
    /(^|\/)(test|tests)\//.test(normalized) && /\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(basename)
  ) {
    return "test";
  }

  if (
    basename === "package.json" ||
    basename === "tsconfig.json" ||
    basename.endsWith(".config.ts") ||
    basename.endsWith(".config.js") ||
    basename.endsWith(".config.mjs") ||
    basename.startsWith(".")
  ) {
    return "config";
  }

  if (basename === "page.tsx" || basename === "route.ts" || basename === "layout.tsx") {
    return "route";
  }

  if (/\.(md|mdx)$/.test(basename)) {
    return "doc";
  }

  if (/\.(css|scss|sass|less)$/.test(basename)) {
    return "style";
  }

  if (normalized.includes("schema") || normalized.includes("migration") || normalized.endsWith(".sql")) {
    return "schema";
  }

  if (/^[A-Z]/.test(path.basename(filePath)) && /\.(tsx|jsx)$/.test(filePath)) {
    return "component";
  }

  if (/\.[cm]?[jt]sx?$/.test(basename) || /\.pyi?$/.test(basename) || /\.java$/.test(basename) || /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(basename)) {
    return "source";
  }

  return "unknown";
}

export function scoreFileImportance(filePath: string, kind: FileKind): number {
  let score = 1;
  if (kind === "route" || kind === "source" || kind === "component") score += 3;
  if (kind === "test") score += 2;
  if (kind === "config" || kind === "schema") score += 2;
  if (filePath.includes("/src/")) score += 1;
  if (filePath.startsWith("src/")) score += 1;
  if (filePath.includes("/src/main/java/") || filePath.startsWith("src/main/java/")) score += 2;
  if (filePath.startsWith("include/") || filePath.includes("/include/")) score += 2;
  if (filePath.includes("/app/") || filePath.includes("/pages/")) score += 1;
  if (filePath.includes("/lib/") || filePath.includes("/server/")) score += 1;
  return score;
}
