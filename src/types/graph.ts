export type FileKind =
  | "source"
  | "test"
  | "config"
  | "route"
  | "component"
  | "schema"
  | "doc"
  | "style"
  | "unknown";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "let"
  | "var"
  | "component"
  | "default"
  | "unknown";

export type GraphEdgeType =
  | "imports"
  | "imported_by"
  | "test_for"
  | "tested_by"
  | "parent_route"
  | "definition"
  | "reference"
  | "call"
  | "type_reference"
  | "implementation";

export type SemanticChunkKind = "symbol" | "file_summary";

export type FileRecord = {
  rootPath: string;
  path: string;
  language: string;
  kind: FileKind;
  size: number;
  hash: string;
  importance: number;
  updatedAt: string;
};

export type SymbolRecord = {
  rootPath: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  signature: string;
};

export type GraphEdgeRecord = {
  rootPath: string;
  fromFile: string;
  toFile: string;
  type: GraphEdgeType;
  metadata: Record<string, unknown>;
};

export type ParsedFile = {
  rootPath: string;
  filePath: string;
  language: string;
  symbols: SymbolRecord[];
  imports: string[];
  hasErrors: boolean;
};

export type RepoGraph = {
  rootPath: string;
  files: FileRecord[];
  parsedFiles: ParsedFile[];
  symbols: SymbolRecord[];
  edges: GraphEdgeRecord[];
};

export type SemanticChunkRecord = {
  rootPath: string;
  id: string;
  filePath: string;
  kind: SemanticChunkKind;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  text: string;
  hash: string;
  tokenEstimate: number;
};

export type SemanticVectorRecord = {
  rootPath: string;
  chunkId: string;
  dimensions: number;
  vector: number[];
};

export type LexicalDocumentRecord = {
  rootPath: string;
  id: string;
  filePath: string;
  kind: "file" | "symbol" | "chunk";
  symbol?: string;
  length: number;
  tokenEstimate: number;
  hash: string;
};

export type LexicalTermRecord = {
  rootPath: string;
  term: string;
  documentId: string;
  filePath: string;
  frequency: number;
};

export type LexicalStatsRecord = {
  rootPath: string;
  documentCount: number;
  averageDocumentLength: number;
};

export type ScanResult = {
  rootPath: string;
  files: FileRecord[];
  ignoredCount: number;
  scannedAt: string;
};
