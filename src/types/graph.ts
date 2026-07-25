// SPDX-License-Identifier: Apache-2.0

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

export type IndexTier = "tier0" | "tier1" | "tier2" | "tier3" | "tier4";

export type IndexedFileTierState = {
  path: string;
  tier: IndexTier;
  score: number;
  reasons: string[];
};

export type IndexingConfig = {
  maxStateMb: number;
  hardMaxStateMb: number;
  maxGraphEdges: number;
  maxSemanticChunks: number;
  maxHotFiles: number;
};

export type GraphEdgeBudget = {
  maxTotalEdges: number;
  maxImportsPerFile: number;
  maxTestsPerFile: number;
  maxRouteSiblingsPerFile: number;
  maxTypeScriptEnrichmentEdges: number;
};

export type IndexStateStats = {
  rootPath: string;
  databasePath: string;
  dbSizeBytes: number;
  walSizeBytes: number;
  totalSizeBytes: number;
  maxStateBytes: number;
  hardMaxStateBytes: number;
  fileCount: number;
  symbolCount: number;
  graphEdgeCount: number;
  semanticChunkCount: number;
  semanticVectorCount: number;
  semanticDocumentCount?: number;
  semanticEmbeddingCount?: number;
  lexicalDocumentCount: number;
  lexicalTermCount: number;
  tiers: Record<IndexTier, number>;
  freshness?: IndexFreshnessStatus;
};

export type IndexFreshnessMetadata = {
  rootPath: string;
  gitHead?: string;
  gitBranch?: string;
  dirtyFingerprint: string;
  fileCount: number;
  schemaVersion: number;
  indexedAt: string;
  metadata: Record<string, unknown>;
};

export type IndexFreshnessStatus = {
  stale: boolean;
  reason: "fresh" | "missing_metadata" | "git_head_changed" | "git_branch_changed" | "dirty_state_changed" | "file_count_changed" | "unknown";
  indexedAt?: string | undefined;
  gitHead?: string | undefined;
  gitBranch?: string | undefined;
  currentGitHead?: string | undefined;
  currentGitBranch?: string | undefined;
  dirtyFileCount: number;
  indexedFileCount?: number | undefined;
  currentFileCount?: number | undefined;
};

export type IndexCompactionResult = {
  before: IndexStateStats;
  after: IndexStateStats;
  graphEdgesDeleted: number;
  semanticChunksDeleted: number;
  semanticVectorsDeleted: number;
  walCheckpointed: boolean;
};

export type QueryLocalIndex = {
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  vectors: SemanticVectorRecord[];
  lexicalDocuments: LexicalDocumentRecord[];
  lexicalTerms: LexicalTermRecord[];
  lexicalStats?: LexicalStatsRecord;
  edges: GraphEdgeRecord[];
  candidateFiles: string[];
};

export type FileRecord = {
  rootPath: string;
  path: string;
  language: string;
  kind: FileKind;
  size: number;
  hash: string;
  importance: number;
  indexTier?: IndexTier;
  tierScore?: number;
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
  /** Parser-observed type names used by this file, never task-derived relevance terms. */
  references?: string[];
  /** Relative module-family prefixes from dynamic local require calls. */
  dynamicImports?: string[];
  /** Literal modules that are required and immediately invoked as installers. */
  moduleInstallers?: string[];
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

export type SemanticDocumentKind = "file" | "symbol";
export type SemanticDocumentSchemaVersion =
  | "semantic-documents-v1"
  | "semantic-documents-v2"
  | "semantic-documents-v3"
  | "semantic-documents-v4";

export type SemanticDocumentRecord = {
  rootPath: string;
  id: string;
  filePath: string;
  kind: SemanticDocumentKind;
  symbol?: string;
  text: string;
  hash: string;
  tokenEstimate: number;
  schemaVersion: SemanticDocumentSchemaVersion;
};

export type SemanticEmbeddingRecord = {
  rootPath: string;
  documentId: string;
  documentHash: string;
  modelId: string;
  schemaVersion: SemanticDocumentSchemaVersion;
  dimensions: number;
  /** Symmetric int8 quantization keeps a repository-wide local index bounded. */
  vector: Int8Array;
  scale: number;
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
  candidateCount?: number;
  indexedFileLimit?: number;
  skippedByLimit?: number;
  inventoryOnlyCount?: number;
  contentIndexedCount?: number;
  indexTiers?: Record<IndexTier, number>;
  tierStates?: IndexedFileTierState[];
  scannedAt: string;
};
