import type { FileRecord, GraphEdgeBudget, GraphEdgeRecord } from "../types.js";

export const DEFAULT_GRAPH_EDGE_BUDGET: GraphEdgeBudget = {
  maxTotalEdges: 250_000,
  maxImportsPerFile: 100,
  maxTestsPerFile: 12,
  maxRouteSiblingsPerFile: 20,
  maxTypeScriptEnrichmentEdges: 10_000
};

const EDGE_PRIORITY: Record<GraphEdgeRecord["type"], number> = {
  imports: 100,
  test_for: 92,
  parent_route: 78,
  definition: 72,
  reference: 62,
  type_reference: 58,
  implementation: 54,
  call: 46,
  imported_by: 18,
  tested_by: 18
};

export function budgetGraphEdges(input: {
  edges: GraphEdgeRecord[];
  files?: FileRecord[] | undefined;
  budget?: Partial<GraphEdgeBudget> | undefined;
}): GraphEdgeRecord[] {
  const budget = {
    ...DEFAULT_GRAPH_EDGE_BUDGET,
    ...(input.budget ?? {})
  };
  const filesByPath = new Map((input.files ?? []).map((file) => [file.path, file]));
  const perFileTypeCounts = new Map<string, number>();
  const retained: GraphEdgeRecord[] = [];

  for (const edge of input.edges.slice().sort(compareEdgesByValue(filesByPath))) {
    if (retained.length >= budget.maxTotalEdges) break;
    if (isNoisyEdge(edge, filesByPath)) continue;

    const perFileLimit = limitForEdge(edge, budget);
    const fromKey = `${edge.fromFile}:${edge.type}:from`;
    const toKey = `${edge.toFile}:${edge.type}:to`;
    const fromCount = perFileTypeCounts.get(fromKey) ?? 0;
    const toCount = perFileTypeCounts.get(toKey) ?? 0;
    if (fromCount >= perFileLimit || toCount >= perFileLimit) continue;

    retained.push(edge);
    perFileTypeCounts.set(fromKey, fromCount + 1);
    perFileTypeCounts.set(toKey, toCount + 1);
  }

  return retained.sort(
    (a, b) =>
      a.fromFile.localeCompare(b.fromFile) ||
      a.toFile.localeCompare(b.toFile) ||
      a.type.localeCompare(b.type)
  );
}

function limitForEdge(edge: GraphEdgeRecord, budget: GraphEdgeBudget): number {
  if (edge.type === "imports" || edge.type === "imported_by") return budget.maxImportsPerFile;
  if (edge.type === "test_for" || edge.type === "tested_by") return budget.maxTestsPerFile;
  if (edge.type === "parent_route") return budget.maxRouteSiblingsPerFile;
  return Math.max(8, Math.floor(budget.maxTypeScriptEnrichmentEdges / 100));
}

function compareEdgesByValue(filesByPath: Map<string, FileRecord>) {
  return (a: GraphEdgeRecord, b: GraphEdgeRecord): number => {
    return edgeValue(b, filesByPath) - edgeValue(a, filesByPath) || a.fromFile.localeCompare(b.fromFile) || a.toFile.localeCompare(b.toFile);
  };
}

function edgeValue(edge: GraphEdgeRecord, filesByPath: Map<string, FileRecord>): number {
  const from = filesByPath.get(edge.fromFile);
  const to = filesByPath.get(edge.toFile);
  const importance = Math.max(from?.importance ?? 0, to?.importance ?? 0);
  return EDGE_PRIORITY[edge.type] + importance;
}

function isNoisyEdge(edge: GraphEdgeRecord, filesByPath: Map<string, FileRecord>): boolean {
  const from = filesByPath.get(edge.fromFile);
  const to = filesByPath.get(edge.toFile);
  return isNoisyFile(from) || isNoisyFile(to);
}

function isNoisyFile(file: FileRecord | undefined): boolean {
  if (!file) return false;
  const normalized = file.path.toLowerCase();
  return (
    file.kind === "doc" ||
    /(^|\/)(docs?|documentation|examples|demo|demos|fixtures|fixture|generated|dist|build|coverage|website|site|playground|storybook|codemods?|devtools)\//.test(
      normalized
    )
  );
}
