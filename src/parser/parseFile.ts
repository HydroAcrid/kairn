import { createRequire } from "node:module";
import path from "node:path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import type { ParsedFile, SymbolKind, SymbolRecord } from "../types.js";

const require = createRequire(import.meta.url);

const TS_LANGUAGE = TypeScript.typescript as unknown as Parser.Language;
const TSX_LANGUAGE = TypeScript.tsx as unknown as Parser.Language;
const PYTHON_LANGUAGE = require("tree-sitter-python") as Parser.Language;
const JAVA_LANGUAGE = require("tree-sitter-java") as Parser.Language;
const CPP_LANGUAGE = require("tree-sitter-cpp") as Parser.Language;
const C_LANGUAGE = require("tree-sitter-c") as Parser.Language;

const SOURCE_LANGUAGE_BY_EXTENSION = new Map<string, Parser.Language>([
  [".ts", TS_LANGUAGE],
  [".tsx", TSX_LANGUAGE],
  [".js", TS_LANGUAGE],
  [".jsx", TSX_LANGUAGE],
  [".mjs", TS_LANGUAGE],
  [".cjs", TS_LANGUAGE],
  [".py", PYTHON_LANGUAGE],
  [".pyi", PYTHON_LANGUAGE],
  [".java", JAVA_LANGUAGE],
  [".c", C_LANGUAGE],
  [".h", CPP_LANGUAGE],
  [".cc", CPP_LANGUAGE],
  [".cpp", CPP_LANGUAGE],
  [".cxx", CPP_LANGUAGE],
  [".hh", CPP_LANGUAGE],
  [".hpp", CPP_LANGUAGE],
  [".hxx", CPP_LANGUAGE]
]);

export function isParseSupported(filePath: string): boolean {
  return SOURCE_LANGUAGE_BY_EXTENSION.has(path.extname(filePath).toLowerCase());
}

export function parseSourceFile(input: {
  rootPath: string;
  filePath: string;
  content: string;
  language: string;
}): ParsedFile {
  const language = SOURCE_LANGUAGE_BY_EXTENSION.get(path.extname(input.filePath).toLowerCase());
  if (!language) {
    return emptyParsedFile(input, false);
  }

  try {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(input.content);
    const parsed = parseByLanguage(input, tree.rootNode);

    return {
      rootPath: input.rootPath,
      filePath: input.filePath,
      language: input.language,
      symbols: dedupeSymbols(parsed.symbols),
      imports: [...new Set(parsed.imports)].sort(),
      hasErrors: tree.rootNode.hasError
    };
  } catch {
    return emptyParsedFile(input, true);
  }
}

function emptyParsedFile(
  input: { rootPath: string; filePath: string; language: string },
  hasErrors: boolean
): ParsedFile {
  return {
    rootPath: input.rootPath,
    filePath: input.filePath,
    language: input.language,
    symbols: [],
    imports: [],
    hasErrors
  };
}

function parseByLanguage(
  input: { rootPath: string; filePath: string; content: string; language: string },
  rootNode: Parser.SyntaxNode
): { symbols: SymbolRecord[]; imports: string[] } {
  if (input.language === "python") return parsePython(input, rootNode);
  if (input.language === "java") return parseJava(input, rootNode);
  if (input.language === "c" || input.language === "cpp") return parseCFamily(input, rootNode);
  return parseJavaScriptLike(input, rootNode);
}

function parseJavaScriptLike(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: Parser.SyntaxNode
): { symbols: SymbolRecord[]; imports: string[] } {
  const symbols: SymbolRecord[] = [];
  const imports = new Set<string>();

  visit(rootNode, (node) => {
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

    for (const symbol of jsSymbolsFromDeclaration(input.rootPath, input.filePath, declaration, exported, node)) {
      symbols.push(symbol);
    }
  });

  return { symbols, imports: [...imports] };
}

function parsePython(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: Parser.SyntaxNode
): { symbols: SymbolRecord[]; imports: string[] } {
  const symbols: SymbolRecord[] = [];
  const imports = new Set<string>();

  visit(rootNode, (node) => {
    if (node.type === "import_statement" || node.type === "import_from_statement" || node.type === "future_import_statement") {
      for (const specifier of extractPythonImports(node.text)) {
        imports.add(specifier);
      }
      return;
    }

    if (node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(symbolRecord(input, name, "class", false, node));
      return;
    }

    if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;
      symbols.push(symbolRecord(input, name, "function", false, node));
    }
  });

  return { symbols, imports: [...imports] };
}

function parseJava(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: Parser.SyntaxNode
): { symbols: SymbolRecord[]; imports: string[] } {
  const symbols: SymbolRecord[] = [];
  const imports = new Set<string>();

  visit(rootNode, (node) => {
    if (node.type === "package_declaration") {
      const specifier = node.text.replace(/^package\s+/, "").replace(/;$/, "").trim();
      if (specifier) imports.add(`package:${specifier}`);
      return;
    }

    if (node.type === "import_declaration") {
      const specifier = node.text.replace(/^import\s+(static\s+)?/, "").replace(/;$/, "").trim();
      if (specifier) imports.add(specifier);
      return;
    }

    if (node.type === "class_declaration") {
      addNamedJavaSymbol(input, symbols, node, "class");
      return;
    }

    if (node.type === "interface_declaration" || node.type === "annotation_type_declaration") {
      addNamedJavaSymbol(input, symbols, node, "interface");
      return;
    }

    if (node.type === "enum_declaration") {
      addNamedJavaSymbol(input, symbols, node, "type");
      return;
    }

    if (node.type === "method_declaration" || node.type === "constructor_declaration") {
      addNamedJavaSymbol(input, symbols, node, "function");
    }
  });

  return { symbols, imports: [...imports] };
}

function parseCFamily(
  input: { rootPath: string; filePath: string; content: string; language: string },
  rootNode: Parser.SyntaxNode
): { symbols: SymbolRecord[]; imports: string[] } {
  const symbols: SymbolRecord[] = [];
  const imports = new Set<string>();

  visit(rootNode, (node) => {
    if (node.type === "preproc_include") {
      const specifier = extractCIncludeSpecifier(node.text);
      if (specifier) imports.add(specifier);
      return;
    }

    if (node.type === "namespace_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(symbolRecord(input, name, "type", false, node));
      return;
    }

    if (node.type === "class_specifier" || node.type === "struct_specifier") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(symbolRecord(input, name, "class", false, node));
      return;
    }

    if (node.type === "function_definition") {
      const name = functionNameFromDeclarator(node.childForFieldName("declarator"));
      if (name) symbols.push(symbolRecord(input, name, "function", false, node));
    }
  });

  return { symbols, imports: [...imports] };
}

function visit(node: Parser.SyntaxNode, cb: (node: Parser.SyntaxNode) => void): void {
  cb(node);
  for (const child of node.namedChildren) {
    visit(child, cb);
  }
}

function jsSymbolsFromDeclaration(
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

function addNamedJavaSymbol(
  input: { rootPath: string; filePath: string },
  symbols: SymbolRecord[],
  node: Parser.SyntaxNode,
  kind: SymbolKind
): void {
  const name = node.childForFieldName("name")?.text;
  if (name) symbols.push(symbolRecord(input, name, kind, hasPublicModifier(node), node));
}

function symbolRecord(
  input: { rootPath: string; filePath: string },
  name: string,
  kind: SymbolKind,
  exported: boolean,
  node: Parser.SyntaxNode
): SymbolRecord {
  return {
    rootPath: input.rootPath,
    filePath: input.filePath,
    name,
    kind,
    exported,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signatureFor(node)
  };
}

function findIdentifierName(node: Parser.SyntaxNode): string | undefined {
  const child = node.namedChildren.find((candidate) =>
    ["identifier", "type_identifier", "field_identifier", "namespace_identifier"].includes(candidate.type)
  );
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

function functionNameFromDeclarator(node: Parser.SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (["identifier", "field_identifier", "qualified_identifier", "operator_name"].includes(node.type)) {
    return node.text;
  }

  const direct = node.childForFieldName("declarator");
  const directName = functionNameFromDeclarator(direct);
  if (directName) return directName;

  return findIdentifierName(node);
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

function extractPythonImports(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("import ")) {
    return trimmed
      .replace(/^import\s+/, "")
      .split(",")
      .map((part) => part.trim().replace(/\s+as\s+.+$/, ""))
      .filter(Boolean);
  }

  const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
  if (!fromMatch?.[1]) return [];
  const moduleName = fromMatch[1];
  if (moduleName.startsWith(".")) {
    return [moduleName.replace(/^\.+/, "./")];
  }
  return [moduleName];
}

function extractCIncludeSpecifier(text: string): string | undefined {
  return text.match(/#\s*include\s+[<"]([^>"]+)[>"]/)?.[1];
}

function hasPublicModifier(node: Parser.SyntaxNode): boolean {
  return /\bpublic\b/.test(node.text.split(/\r?\n/)[0] ?? "");
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
