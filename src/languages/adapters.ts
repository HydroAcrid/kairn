import type { LanguageAdapter } from "../types.js";

export const languageAdapters: LanguageAdapter[] = [
  {
    id: "typescript",
    languages: ["typescript", "tsx", "javascript", "jsx"],
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    capabilities: ["symbols", "definitions", "references", "call_graph", "tests", "failures"],
    status: "active",
    notes: "Tree-sitter plus TypeScript language-service graph enrichment."
  },
  {
    id: "python",
    languages: ["python"],
    fileExtensions: [".py", ".pyi"],
    capabilities: ["symbols", "tests", "failures"],
    status: "active",
    notes: "Tree-sitter symbols/imports plus universal retrieval and failure parsing."
  },
  {
    id: "java",
    languages: ["java"],
    fileExtensions: [".java"],
    capabilities: ["symbols", "tests", "failures"],
    status: "active",
    notes: "Tree-sitter package/import/class/method extraction plus universal retrieval."
  },
  {
    id: "c-cpp",
    languages: ["c", "cpp"],
    fileExtensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    capabilities: ["symbols", "tests", "failures"],
    status: "active",
    notes: "Tree-sitter include/class/struct/function extraction plus universal retrieval."
  },
  {
    id: "go",
    languages: ["go"],
    fileExtensions: [".go"],
    capabilities: ["symbols", "definitions", "references", "tests", "failures"],
    status: "stub",
    notes: "Universal retrieval works now; deep Go graph support is a future adapter."
  },
  {
    id: "rust",
    languages: ["rust"],
    fileExtensions: [".rs"],
    capabilities: ["symbols", "definitions", "references", "tests", "failures"],
    status: "stub",
    notes: "Universal retrieval works now; deep Rust graph support is a future adapter."
  },
  {
    id: "ruby",
    languages: ["ruby"],
    fileExtensions: [".rb"],
    capabilities: ["symbols", "tests", "failures"],
    status: "stub",
    notes: "Universal retrieval works now; Rails-aware convention routing is a documented future adapter target."
  }
];

export function getLanguageAdapterForPath(filePath: string): LanguageAdapter | undefined {
  const lowerPath = filePath.toLowerCase();
  return languageAdapters.find((adapter) =>
    adapter.fileExtensions.some((extension) => lowerPath.endsWith(extension))
  );
}
