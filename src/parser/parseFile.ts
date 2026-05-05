import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import type { ParsedFile, SymbolKind, SymbolRecord } from "../types.js";

const TS_LANGUAGE = TypeScript.typescript as unknown as Parser.Language;
const TSX_LANGUAGE = TypeScript.tsx as unknown as Parser.Language;

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function isParseSupported(filePath: string): boolean {
  return [...SUPPORTED_EXTENSIONS].some((extension) => filePath.endsWith(extension));
}

export function parseSourceFile(input: {
  rootPath: string;
  filePath: string;
  content: string;
  language: string;
}): ParsedFile {
  if (!isParseSupported(input.filePath)) {
    return {
      rootPath: input.rootPath,
      filePath: input.filePath,
      language: input.language,
      symbols: [],
      imports: [],
      hasErrors: false
    };
  }

  try {
    const parser = new Parser();
    parser.setLanguage(input.filePath.endsWith(".tsx") || input.filePath.endsWith(".jsx") ? TSX_LANGUAGE : TS_LANGUAGE);
    const tree = parser.parse(input.content);
    const symbols: SymbolRecord[] = [];
    const imports = new Set<string>();

    visit(tree.rootNode, (node) => {
      if (node.type === "import_statement") {
        const specifier = extractModuleSpecifier(node.text);
        if (specifier) imports.add(specifier);
        return;
      }

      if (node.type === "call_expression") {
        const specifier = extractRequireSpecifier(node.text);
        if (specifier) imports.add(specifier);
      }

      const exported = isExported(node);
      const declaration = exported ? firstDeclarationChild(node) : node;
      if (!declaration) return;
      if (!exported && declaration.parent?.type === "export_statement") return;

      for (const symbol of symbolsFromDeclaration(input.rootPath, input.filePath, declaration, exported, node)) {
        symbols.push(symbol);
      }
    });

    return {
      rootPath: input.rootPath,
      filePath: input.filePath,
      language: input.language,
      symbols: dedupeSymbols(symbols),
      imports: [...imports],
      hasErrors: tree.rootNode.hasError
    };
  } catch {
    return {
      rootPath: input.rootPath,
      filePath: input.filePath,
      language: input.language,
      symbols: [],
      imports: [],
      hasErrors: true
    };
  }
}

function visit(node: Parser.SyntaxNode, cb: (node: Parser.SyntaxNode) => void): void {
  cb(node);
  for (const child of node.namedChildren) {
    visit(child, cb);
  }
}

function symbolsFromDeclaration(
  rootPath: string,
  filePath: string,
  declaration: Parser.SyntaxNode,
  exported: boolean,
  rangeNode: Parser.SyntaxNode
): SymbolRecord[] {
  switch (declaration.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "function", exported, rangeNode);
    case "class_declaration":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "class", exported, rangeNode);
    case "interface_declaration":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "interface", exported, rangeNode);
    case "type_alias_declaration":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "type", exported, rangeNode);
    case "lexical_declaration":
    case "variable_declaration":
      return symbolsForVariableDeclaration(rootPath, filePath, declaration, exported, rangeNode);
    default:
      return [];
  }
}

function symbolForNamedDeclaration(
  rootPath: string,
  filePath: string,
  declaration: Parser.SyntaxNode,
  kind: SymbolKind,
  exported: boolean,
  rangeNode: Parser.SyntaxNode
): SymbolRecord[] {
  const name = findIdentifierName(declaration) ?? (exported && isDefaultExport(rangeNode) ? "default" : undefined);
  if (!name) return [];

  return [
    {
      rootPath,
      filePath,
      name,
      kind: name === "default" ? "default" : kind,
      exported,
      startLine: rangeNode.startPosition.row + 1,
      endLine: rangeNode.endPosition.row + 1,
      signature: signatureFor(rangeNode)
    }
  ];
}

function symbolsForVariableDeclaration(
  rootPath: string,
  filePath: string,
  declaration: Parser.SyntaxNode,
  exported: boolean,
  rangeNode: Parser.SyntaxNode
): SymbolRecord[] {
  const kindText = declaration.firstChild?.text;
  const kind: SymbolKind = kindText === "let" || kindText === "var" ? kindText : "const";
  const declarators = findNodes(declaration, "variable_declarator");

  return declarators.flatMap((declarator) => {
    const name = findIdentifierName(declarator);
    if (!name) return [];

    return [
      {
        rootPath,
        filePath,
        name,
        kind: isLikelyComponentName(name, filePath) ? "component" : kind,
        exported,
        startLine: rangeNode.startPosition.row + 1,
        endLine: rangeNode.endPosition.row + 1,
        signature: signatureFor(rangeNode)
      }
    ];
  });
}

function findIdentifierName(node: Parser.SyntaxNode): string | undefined {
  const child = node.namedChildren.find((candidate) => candidate.type === "identifier" || candidate.type === "type_identifier");
  if (child) return child.text;

  for (const candidate of node.namedChildren) {
    const nested = findIdentifierName(candidate);
    if (nested) return nested;
  }

  return undefined;
}

function findNodes(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const matches: Parser.SyntaxNode[] = [];
  visit(node, (candidate) => {
    if (candidate.type === type) matches.push(candidate);
  });
  return matches;
}

function isExported(node: Parser.SyntaxNode): boolean {
  return node.type === "export_statement";
}

function isDefaultExport(node: Parser.SyntaxNode): boolean {
  return node.type === "export_statement" && /\bdefault\b/.test(node.text);
}

function firstDeclarationChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type !== "export_statement") return node;
  return (
    node.namedChildren.find((child) =>
      [
        "function_declaration",
        "generator_function_declaration",
        "class_declaration",
        "interface_declaration",
        "type_alias_declaration",
        "lexical_declaration",
        "variable_declaration"
      ].includes(child.type)
    ) ?? null
  );
}

function extractModuleSpecifier(text: string): string | undefined {
  const fromMatch = text.match(/\bfrom\s+["']([^"']+)["']/);
  if (fromMatch?.[1]) return fromMatch[1];

  const sideEffectMatch = text.match(/import\s+["']([^"']+)["']/);
  return sideEffectMatch?.[1];
}

function extractRequireSpecifier(text: string): string | undefined {
  return text.match(/require\(["']([^"']+)["']\)/)?.[1];
}

function signatureFor(node: Parser.SyntaxNode): string {
  return node.text.split(/\r?\n/)[0]?.trim() ?? "";
}

function isLikelyComponentName(name: string, filePath: string): boolean {
  return /^[A-Z]/.test(name) && /\.(tsx|jsx)$/.test(filePath);
}

function dedupeSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const byKey = new Map<string, SymbolRecord>();
  for (const symbol of symbols) {
    byKey.set(`${symbol.filePath}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`, symbol);
  }
  return [...byKey.values()];
}
