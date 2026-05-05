export type SessionStatus = "active" | "completed" | "abandoned";

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

export type ContextRequestType =
  | "initial_brief"
  | "find_context"
  | "file"
  | "symbol"
  | "related"
  | "tests"
  | "error"
  | "diff"
  | "verify_plan";

export type ContextResponseMode =
  | "brief"
  | "exact_code"
  | "compressed_summary"
  | "snippets"
  | "graph_neighbors"
  | "failure_context"
  | "verification_plan";

export type OutputKind = "test" | "lint" | "typecheck" | "generic";

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

export type GraphEdgeType = "imports" | "imported_by" | "test_for" | "tested_by" | "parent_route";

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

export type ContextShownRecord = {
  id?: number;
  sessionId: string;
  kind: "file" | "symbol" | "summary" | "diff" | "tests" | "context";
  filePath?: string;
  symbol?: string;
  mode: ContextResponseMode;
  contentHash: string;
  createdAt: string;
};

export type CommandRecord = {
  id?: number;
  sessionId: string;
  type: OutputKind | "diff";
  summary: string;
  createdAt: string;
};

export type DiffRecord = {
  id?: number;
  sessionId: string;
  files: string[];
  summary: string;
  createdAt: string;
};

export type TaskSession = {
  id: string;
  rootPath: string;
  task: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  filesShown: ContextShownRecord[];
  symbolsShown: ContextShownRecord[];
  commandsRun: CommandRecord[];
  diffsObserved: DiffRecord[];
  risks: string[];
  verificationHints: string[];
};

export type ContextRequest = {
  sessionId: string;
  requestType: ContextRequestType;
  target?: string;
  query?: string;
  agentIntent?: string;
  budget?: number;
};

export type ContextResponse = {
  mode: ContextResponseMode;
  content: string;
  files: string[];
  symbols: string[];
  related: string[];
  warnings: string[];
  suggestedNextContext: string[];
  tokenEstimate: number;
};

export type ScanResult = {
  rootPath: string;
  files: FileRecord[];
  ignoredCount: number;
  scannedAt: string;
};

export type InitResult = {
  rootPath: string;
  kairnDir: string;
  configPath: string;
  databasePath: string;
  scan: ScanResult;
  graph: RepoGraph;
};

export type ScoredFile = FileRecord & {
  score: number;
  reasons: string[];
};
