import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { GraphEdgeRecord, GraphEdgeType, RepoGraph, SymbolRecord } from "../types.js";
import { readTextFile } from "../retrieval/readSource.js";
import { normalizeRelativePath } from "../utils/paths.js";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MAX_LANGUAGE_SERVICE_FILES = 500;
const MAX_LANGUAGE_SERVICE_SYMBOLS = 300;

export async function enrichGraphWithTypeScript(input: {
  rootPath: string;
  graph: RepoGraph;
}): Promise<RepoGraph> {
  try {
    return enrichGraph(input);
  } catch {
    return input.graph;
  }
}

function enrichGraph(input: { rootPath: string; graph: RepoGraph }): RepoGraph {
  const sourceFiles = input.graph.files.filter((file) => TS_EXTENSIONS.has(path.extname(file.path)));
  if (sourceFiles.length === 0) return input.graph;
  if (sourceFiles.length > MAX_LANGUAGE_SERVICE_FILES) {
    return {
      ...input.graph,
      edges: [
        ...input.graph.edges,
        {
          rootPath: input.rootPath,
          fromFile: "__kairn__",
          toFile: "__kairn__",
          type: "implementation",
          metadata: {
            skipped: true,
            reason: "typescript language-service enrichment skipped for oversized repo",
            sourceFileCount: sourceFiles.length,
            maxFiles: MAX_LANGUAGE_SERVICE_FILES
          }
        }
      ]
    };
  }

  const absoluteByRelative = new Map(sourceFiles.map((file) => [file.path, path.join(input.rootPath, file.path)]));
  const relativeByAbsolute = new Map([...absoluteByRelative].map(([relative, absolute]) => [normalizeAbsolute(absolute), relative]));
  const contentByAbsolute = new Map<string, string>();
  for (const [relative, absolute] of absoluteByRelative) {
    try {
      contentByAbsolute.set(normalizeAbsolute(absolute), readTextFile(input.rootPath, relative));
    } catch {
      // Missing or unreadable files are ignored by the enrichment layer.
    }
  }

  const languageService = ts.createLanguageService(createLanguageServiceHost({
    rootPath: input.rootPath,
    fileNames: [...contentByAbsolute.keys()],
    contentByAbsolute
  }));
  const edgeMap = new Map(input.graph.edges.map((edge) => [edgeKey(edge), edge]));

  for (const symbol of input.graph.symbols.slice(0, MAX_LANGUAGE_SERVICE_SYMBOLS)) {
    const absoluteFile = absoluteByRelative.get(symbol.filePath);
    if (!absoluteFile) continue;
    const normalizedAbsoluteFile = normalizeAbsolute(absoluteFile);
    const content = contentByAbsolute.get(normalizedAbsoluteFile);
    if (!content) continue;
    const position = positionForSymbol(content, symbol);
    if (position === undefined) continue;

    addDefinitionEdges({
      rootPath: input.rootPath,
      edgeMap,
      languageService,
      relativeByAbsolute,
      symbol,
      absoluteFile: normalizedAbsoluteFile,
      position
    });
    addReferenceEdges({
      rootPath: input.rootPath,
      edgeMap,
      languageService,
      relativeByAbsolute,
      symbol,
      absoluteFile: normalizedAbsoluteFile,
      position
    });
    addImplementationEdges({
      rootPath: input.rootPath,
      edgeMap,
      languageService,
      relativeByAbsolute,
      symbol,
      absoluteFile: normalizedAbsoluteFile,
      position
    });
    addCallEdges({
      rootPath: input.rootPath,
      edgeMap,
      languageService,
      relativeByAbsolute,
      symbol,
      absoluteFile: normalizedAbsoluteFile,
      position
    });
  }

  return {
    ...input.graph,
    edges: [...edgeMap.values()].sort(
      (a, b) =>
        a.fromFile.localeCompare(b.fromFile) ||
        a.toFile.localeCompare(b.toFile) ||
        a.type.localeCompare(b.type)
    )
  };
}

function createLanguageServiceHost(input: {
  rootPath: string;
  fileNames: string[];
  contentByAbsolute: Map<string, string>;
}): ts.LanguageServiceHost {
  const compilerOptions = compilerOptionsForRoot(input.rootPath);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => input.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      const normalized = normalizeAbsolute(fileName);
      const content = input.contentByAbsolute.get(normalized) ?? ts.sys.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => input.rootPath,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => input.contentByAbsolute.has(normalizeAbsolute(fileName)) || fs.existsSync(fileName),
    readFile: (fileName) => input.contentByAbsolute.get(normalizeAbsolute(fileName)) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  };
  if (ts.sys.realpath) host.realpath = ts.sys.realpath;
  return host;
}

function compilerOptionsForRoot(rootPath: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(rootPath, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    try {
      const raw = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!raw.error) {
        const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
        return {
          ...parsed.options,
          allowJs: true,
          checkJs: false,
          noEmit: true
        };
      }
    } catch {
      // Fall through to inferred project options.
    }
  }

  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true
  };
}

function addDefinitionEdges(input: EdgeInput): void {
  const definitions = input.languageService.getDefinitionAtPosition(input.absoluteFile, input.position) ?? [];
  for (const definition of definitions.slice(0, 8)) {
    addEdgeForSpan({
      ...input,
      spanFileName: definition.fileName,
      edgeType: "definition",
      metadata: { symbol: input.symbol.name, sourceLine: input.symbol.startLine }
    });
  }
}

function addReferenceEdges(input: EdgeInput): void {
  const references = input.languageService.findReferences(input.absoluteFile, input.position) ?? [];
  const edgeCounts = new Map<string, number>();
  const edgeType: GraphEdgeType = input.symbol.kind === "type" || input.symbol.kind === "interface" ? "type_reference" : "reference";

  for (const group of references) {
    for (const reference of group.references) {
      const target = input.relativeByAbsolute.get(normalizeAbsolute(reference.fileName));
      if (!target || target === input.symbol.filePath) continue;
      edgeCounts.set(target, (edgeCounts.get(target) ?? 0) + 1);
    }
  }

  for (const [toFile, referenceCount] of edgeCounts) {
    addEdge(input.edgeMap, {
      rootPath: input.rootPath,
      fromFile: input.symbol.filePath,
      toFile,
      type: edgeType,
      metadata: { symbol: input.symbol.name, referenceCount }
    });
  }
}

function addImplementationEdges(input: EdgeInput): void {
  const implementations = input.languageService.getImplementationAtPosition?.(input.absoluteFile, input.position) ?? [];
  for (const implementation of implementations.slice(0, 8)) {
    addEdgeForSpan({
      ...input,
      spanFileName: implementation.fileName,
      edgeType: "implementation",
      metadata: { symbol: input.symbol.name, sourceLine: input.symbol.startLine }
    });
  }
}

function addCallEdges(input: EdgeInput): void {
  const service = input.languageService as ts.LanguageService & {
    prepareCallHierarchy?: (fileName: string, position: number) => ts.CallHierarchyItem | ts.CallHierarchyItem[] | undefined;
    provideCallHierarchyOutgoingCalls?: (fileName: string, position: number) => ts.CallHierarchyOutgoingCall[] | undefined;
  };
  const items = service.prepareCallHierarchy?.(input.absoluteFile, input.position);
  if (!items) return;
  const item = Array.isArray(items) ? items[0] : items;
  if (!item) return;
  const calls = service.provideCallHierarchyOutgoingCalls?.(input.absoluteFile, input.position) ?? [];
  for (const call of calls.slice(0, 12)) {
    addEdgeForSpan({
      ...input,
      spanFileName: call.to.file,
      edgeType: "call",
      metadata: { symbol: input.symbol.name, targetName: call.to.name, sourceLine: input.symbol.startLine }
    });
  }
}

type EdgeInput = {
  rootPath: string;
  edgeMap: Map<string, GraphEdgeRecord>;
  languageService: ts.LanguageService;
  relativeByAbsolute: Map<string, string>;
  symbol: SymbolRecord;
  absoluteFile: string;
  position: number;
};

function addEdgeForSpan(input: EdgeInput & {
  spanFileName: string;
  edgeType: GraphEdgeType;
  metadata: Record<string, unknown>;
}): void {
  const target = input.relativeByAbsolute.get(normalizeAbsolute(input.spanFileName));
  if (!target || target === input.symbol.filePath) return;
  addEdge(input.edgeMap, {
    rootPath: input.rootPath,
    fromFile: input.symbol.filePath,
    toFile: target,
    type: input.edgeType,
    metadata: input.metadata
  });
}

function addEdge(edgeMap: Map<string, GraphEdgeRecord>, edge: GraphEdgeRecord): void {
  const key = edgeKey(edge);
  const existing = edgeMap.get(key);
  if (!existing) {
    edgeMap.set(key, edge);
    return;
  }
  edgeMap.set(key, {
    ...existing,
    metadata: {
      ...existing.metadata,
      ...edge.metadata
    }
  });
}

function positionForSymbol(content: string, symbol: SymbolRecord): number | undefined {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, symbol.startLine - 1);
  const endIndex = Math.min(lines.length - 1, Math.max(startIndex, symbol.endLine - 1));
  let offset = lines.slice(0, startIndex).join("\n").length;
  if (startIndex > 0) offset += 1;
  const region = lines.slice(startIndex, endIndex + 1).join("\n");
  const local = region.indexOf(symbol.name);
  if (local >= 0) return offset + local;
  const fallback = content.indexOf(symbol.name);
  return fallback >= 0 ? fallback : undefined;
}

function edgeKey(edge: GraphEdgeRecord): string {
  return `${edge.rootPath}:${edge.fromFile}->${edge.toFile}:${edge.type}`;
}

function normalizeAbsolute(filePath: string): string {
  return normalizeRelativePath(path.resolve(filePath));
}
