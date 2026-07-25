// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Point } from "web-tree-sitter";
import type { ParsedFile, SymbolKind, SymbolRecord } from "../types.js";

const require = createRequire(import.meta.url);

type ParserGrammar = "typescript" | "tsx" | "python" | "go" | "java" | "c" | "cpp";

type SyntaxNodeLike = {
  type: string;
  text: string;
  startPosition: Point;
  endPosition: Point;
  hasError: boolean;
  firstChild: SyntaxNodeLike | null;
  parent: SyntaxNodeLike | null;
  namedChildren: SyntaxNodeLike[];
  childForFieldName(fieldName: string): SyntaxNodeLike | null;
  childrenForFieldName(fieldName: string): SyntaxNodeLike[];
};

const WASM_BY_GRAMMAR: Record<ParserGrammar, string> = {
  typescript: "@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "@repomix/tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  python: "@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm",
  go: "@repomix/tree-sitter-wasms/out/tree-sitter-go.wasm",
  java: "@repomix/tree-sitter-wasms/out/tree-sitter-java.wasm",
  c: "@repomix/tree-sitter-wasms/out/tree-sitter-c.wasm",
  cpp: "@repomix/tree-sitter-wasms/out/tree-sitter-cpp.wasm"
};

const TREE_SITTER_CORE_WASM = require.resolve("web-tree-sitter/web-tree-sitter.wasm");

const SOURCE_GRAMMAR_BY_EXTENSION = new Map<string, ParserGrammar>([
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".js", "typescript"],
  [".jsx", "tsx"],
  [".mjs", "typescript"],
  [".cjs", "typescript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".java", "java"],
  [".c", "c"],
  [".h", "cpp"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".hxx", "cpp"]
]);

let parserInitPromise: Promise<void> | undefined;
const languagePromises = new Map<ParserGrammar, Promise<Language>>();

export function isParseSupported(filePath: string): boolean {
  return SOURCE_GRAMMAR_BY_EXTENSION.has(path.extname(filePath).toLowerCase());
}

export async function parseSourceFile(input: {
  rootPath: string;
  filePath: string;
  content: string;
  language: string;
}): Promise<ParsedFile> {
  const grammar = SOURCE_GRAMMAR_BY_EXTENSION.get(path.extname(input.filePath).toLowerCase());
  if (!grammar) {
    return emptyParsedFile(input, false);
  }
  if (isWasmParserDisabled()) {
    return emptyParsedFile(input, true);
  }

  try {
    const language = await loadLanguage(grammar);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(input.content);
    if (!tree) return emptyParsedFile(input, true);
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
    // A malformed, oversized, or otherwise parser-hostile file must not
    // disable structured parsing for every later file and repository in this
    // process. Parser/language initialization promises remain cached, so a
    // genuine backend initialization failure still degrades consistently.
    return emptyParsedFile(input, true);
  }
}

async function loadLanguage(grammar: ParserGrammar): Promise<Language> {
  parserInitPromise ??= Parser.init({
    locateFile(scriptName: string) {
      return scriptName.endsWith(".wasm") ? TREE_SITTER_CORE_WASM : scriptName;
    },
    printErr() {
      // web-tree-sitter can print repeated "Aborted()" lines before throwing when
      // a runtime cannot initialize WASM. Kairn degrades to lexical indexing below.
    }
  });
  await parserInitPromise;

  const cached = languagePromises.get(grammar);
  if (cached) return cached;

  const promise = Language.load(require.resolve(WASM_BY_GRAMMAR[grammar]));
  languagePromises.set(grammar, promise);
  return promise;
}

function isWasmParserDisabled(): boolean {
  const explicitDisable = process.env.KAIRN_DISABLE_WASM_PARSER;
  if (explicitDisable && /^(1|true|yes)$/i.test(explicitDisable)) return true;
  const parserBackend = process.env.KAIRN_PARSER_BACKEND;
  return Boolean(parserBackend && /^(lexical|scan|none)$/i.test(parserBackend));
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
  rootNode: SyntaxNodeLike
): { symbols: SymbolRecord[]; imports: string[] } {
  if (input.language === "python") return parsePython(input, rootNode);
  if (input.language === "go") return parseGo(input, rootNode);
  if (input.language === "java") return parseJava(input, rootNode);
  if (input.language === "c" || input.language === "cpp") return parseCFamily(input, rootNode);
  return parseJavaScriptLike(input, rootNode);
}

function parseJavaScriptLike(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: SyntaxNodeLike
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

    if (node.type === "assignment_expression") {
      const assignedMethod = javaScriptAssignedMethodSymbol(input, node);
      if (assignedMethod) symbols.push(assignedMethod);
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

function javaScriptAssignedMethodSymbol(
  input: { rootPath: string; filePath: string },
  assignment: SyntaxNodeLike
): SymbolRecord | undefined {
  const left = assignment.childForFieldName("left");
  const right = assignment.childForFieldName("right");
  if (!left || !right) return undefined;
  if (
    right.type !== "function_expression" &&
    right.type !== "generator_function" &&
    right.type !== "arrow_function"
  ) {
    return undefined;
  }
  if (left.type !== "member_expression" && left.type !== "subscript_expression") {
    return undefined;
  }
  const property = left.childForFieldName("property") ??
    left.childForFieldName("index") ??
    left.namedChildren.at(-1);
  const name = property?.text.replace(/^["']|["']$/g, "");
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  const exported =
    left.text === "module.exports" ||
    left.text.startsWith("module.exports.") ||
    left.text.startsWith("module.exports[") ||
    left.text.startsWith("exports.") ||
    left.text.startsWith("exports[");
  return symbolRecord(input, name, "function", exported, assignment);
}

function parsePython(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: SyntaxNodeLike
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

function parseGo(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: SyntaxNodeLike
): { symbols: SymbolRecord[]; imports: string[] } {
  const symbols: SymbolRecord[] = [];
  const imports = new Set<string>();

  visit(rootNode, (node) => {
    if (node.type === "package_clause") {
      const packageName = node.namedChildren.find((child) => child.type === "package_identifier")?.text;
      if (packageName) imports.add(`package:${packageName}`);
      return;
    }

    if (node.type === "import_declaration") {
      for (const literal of findNodes(node, ["interpreted_string_literal", "raw_string_literal"])) {
        const specifier = unquoteGoString(literal.text);
        if (specifier) imports.add(specifier);
      }
      return;
    }

    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(symbolRecord(input, name, "function", isGoExported(name), node));
      return;
    }

    if (node.type === "type_spec" || node.type === "type_alias") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return;
      const declaredType = node.childForFieldName("type")?.type;
      const kind: SymbolKind = declaredType === "interface_type" ? "interface" : "type";
      symbols.push(symbolRecord(input, name, kind, isGoExported(name), node));
      return;
    }

    if (node.type === "const_spec" || node.type === "var_spec") {
      const kind: SymbolKind = node.type === "const_spec" ? "const" : "var";
      for (const nameNode of node.childrenForFieldName("name")) {
        const name = nameNode.text;
        if (name) symbols.push(symbolRecord(input, name, kind, isGoExported(name), node));
      }
    }
  });

  return { symbols, imports: [...imports] };
}

function parseJava(
  input: { rootPath: string; filePath: string; content: string },
  rootNode: SyntaxNodeLike
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
  rootNode: SyntaxNodeLike
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

function visit(node: SyntaxNodeLike, cb: (node: SyntaxNodeLike) => void): void {
  cb(node);
  for (const child of node.namedChildren) {
    visit(child, cb);
  }
}

function jsSymbolsFromDeclaration(
  rootPath: string,
  filePath: string,
  declaration: SyntaxNodeLike,
  exported: boolean,
  rangeNode: SyntaxNodeLike
): SymbolRecord[] {
  switch (declaration.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "function", exported, rangeNode);
    case "class_declaration":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "class", exported, rangeNode);
    case "method_definition":
    case "method_signature":
    case "abstract_method_signature":
      return symbolForNamedDeclaration(rootPath, filePath, declaration, "function", false, rangeNode);
    case "public_field_definition":
    case "field_definition":
      return isFunctionValuedField(declaration)
        ? symbolForNamedDeclaration(rootPath, filePath, declaration, "function", false, rangeNode)
        : [];
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

function isFunctionValuedField(declaration: SyntaxNodeLike): boolean {
  const value = declaration.childForFieldName("value");
  if (value?.type === "arrow_function" || value?.type === "function_expression") return true;
  return declaration.namedChildren.some((child) =>
    child.type === "arrow_function" || child.type === "function_expression"
  );
}

function symbolForNamedDeclaration(
  rootPath: string,
  filePath: string,
  declaration: SyntaxNodeLike,
  kind: SymbolKind,
  exported: boolean,
  rangeNode: SyntaxNodeLike
): SymbolRecord[] {
  const name = declaration.childForFieldName("name")?.text ??
    findIdentifierName(declaration) ??
    (exported && isDefaultExport(rangeNode) ? "default" : undefined);
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
  declaration: SyntaxNodeLike,
  exported: boolean,
  rangeNode: SyntaxNodeLike
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
  node: SyntaxNodeLike,
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
  node: SyntaxNodeLike
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

function findIdentifierName(node: SyntaxNodeLike): string | undefined {
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

function findNodes(node: SyntaxNodeLike, type: string | string[]): SyntaxNodeLike[] {
  const matches: SyntaxNodeLike[] = [];
  const types = Array.isArray(type) ? new Set(type) : new Set([type]);
  visit(node, (candidate) => {
    if (types.has(candidate.type)) matches.push(candidate);
  });
  return matches;
}

function functionNameFromDeclarator(node: SyntaxNodeLike | null): string | undefined {
  if (!node) return undefined;
  if (["identifier", "field_identifier", "qualified_identifier", "operator_name"].includes(node.type)) {
    return node.text;
  }

  const direct = node.childForFieldName("declarator");
  const directName = functionNameFromDeclarator(direct);
  if (directName) return directName;

  return findIdentifierName(node);
}

function isExported(node: SyntaxNodeLike): boolean {
  return node.type === "export_statement";
}

function isDefaultExport(node: SyntaxNodeLike): boolean {
  return node.type === "export_statement" && /\bdefault\b/.test(node.text);
}

function firstDeclarationChild(node: SyntaxNodeLike): SyntaxNodeLike | null {
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

function unquoteGoString(text: string): string | undefined {
  if (text.length < 2) return undefined;
  if (text.startsWith("`") && text.endsWith("`")) return text.slice(1, -1);
  if (!text.startsWith('"') || !text.endsWith('"')) return undefined;

  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : undefined;
  } catch {
    return text.slice(1, -1);
  }
}

function isGoExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

function hasPublicModifier(node: SyntaxNodeLike): boolean {
  return /\bpublic\b/.test(node.text.split(/\r?\n/)[0] ?? "");
}

function signatureFor(node: SyntaxNodeLike): string {
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
