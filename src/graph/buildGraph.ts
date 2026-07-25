// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type { FileRecord, GraphEdgeRecord, ParsedFile, RepoGraph } from "../types.js";
import { resolveImportCandidates } from "../retrieval/readSource.js";
import { budgetGraphEdges } from "./budget.js";

export function buildRepoGraph(input: {
  rootPath: string;
  files: FileRecord[];
  parsedFiles: ParsedFile[];
  goModules?: Array<{ directory: string; modulePath: string }>;
}): RepoGraph {
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));
  const edgeMap = new Map<string, GraphEdgeRecord>();

  for (const parsedFile of input.parsedFiles) {
    for (const specifier of parsedFile.imports) {
      if (isPackageMetadata(specifier)) continue;
      for (const candidate of resolveImportCandidates(parsedFile.filePath, specifier)) {
        if (!fileByPath.has(candidate)) continue;

        addEdge(edgeMap, {
          rootPath: input.rootPath,
          fromFile: parsedFile.filePath,
          toFile: candidate,
          type: "imports",
          metadata: { specifier }
        });
      }
    }
  }

  addDynamicImplementationEdges(
    edgeMap,
    input.rootPath,
    input.files,
    input.parsedFiles
  );
  addGoPackageImportEdges(
    edgeMap,
    input.rootPath,
    input.files,
    input.parsedFiles,
    input.goModules ?? []
  );
  addLocalTypeReferenceEdges(
    edgeMap,
    input.rootPath,
    input.files,
    input.parsedFiles,
    input.goModules ?? []
  );
  addLocalCallEdges(edgeMap, input.rootPath, input.files, input.parsedFiles);
  addSiblingImplementationEdges(edgeMap, input.rootPath, input.files, input.parsedFiles);
  addTestEdges(edgeMap, input.rootPath, input.files);
  addGoTestSymbolEdges(edgeMap, input.rootPath, input.files, input.parsedFiles);
  addParentRouteEdges(edgeMap, input.rootPath, input.files);

  return {
    rootPath: input.rootPath,
    files: input.files,
    parsedFiles: input.parsedFiles,
    symbols: input.parsedFiles.flatMap((file) => file.symbols),
    edges: budgetGraphEdges({ edges: [...edgeMap.values()], files: input.files })
  };
}

function addDynamicImplementationEdges(
  edgeMap: Map<string, GraphEdgeRecord>,
  rootPath: string,
  files: FileRecord[],
  parsedFiles: ParsedFile[]
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const parsedByPath = new Map(parsedFiles.map((parsedFile) => [parsedFile.filePath, parsedFile]));
  const maxTargetsPerDispatcher = 64;

  for (const dispatcher of parsedFiles) {
    if (!dispatcher.dynamicImports?.length && !dispatcher.moduleInstallers?.length) continue;
    const targets = new Set<string>();
    for (const installer of dispatcher.moduleInstallers ?? []) {
      for (const installedPath of resolveImportCandidates(dispatcher.filePath, installer)) {
        const installed = fileByPath.get(installedPath);
        if (
          installed &&
          installed.kind !== "test" &&
          installed.indexTier !== "tier0"
        ) {
          targets.add(installed.path);
        }
      }
    }
    for (const prefix of dispatcher.dynamicImports ?? []) {
      for (const candidate of dynamicLocalModuleCandidates(
        dispatcher.filePath,
        prefix,
        files
      )) {
        targets.add(candidate.path);
        for (const installer of parsedByPath.get(candidate.path)?.moduleInstallers ?? []) {
          for (const installedPath of resolveImportCandidates(candidate.path, installer)) {
            const installed = fileByPath.get(installedPath);
            if (
              installed &&
              installed.kind !== "test" &&
              installed.indexTier !== "tier0"
            ) {
              targets.add(installed.path);
            }
          }
        }
      }
    }

    const boundedTargets = [...targets].sort().slice(0, maxTargetsPerDispatcher);
    for (const target of boundedTargets) {
      if (target === dispatcher.filePath) continue;
      addEdge(edgeMap, {
        rootPath,
        fromFile: dispatcher.filePath,
        toFile: target,
        type: "module_installation",
        metadata: {
          reason: "dynamic local module family implementation"
        }
      });
    }

    const importers = [...edgeMap.values()]
      .filter((edge) =>
        edge.type === "imports" &&
        edge.toFile === dispatcher.filePath &&
        edge.fromFile !== dispatcher.filePath
      )
      .map((edge) => edge.fromFile)
      .sort()
      .slice(0, 256);
    for (const importer of importers) {
      for (const target of boundedTargets) {
        if (target === importer) continue;
        addEdge(edgeMap, {
          rootPath,
          fromFile: importer,
          toFile: target,
          type: "module_installation",
          metadata: {
            reason: "imported module installs or dispatches to concrete implementation",
            through: dispatcher.filePath
          }
        });
      }
    }
  }
}

function dynamicLocalModuleCandidates(
  fromFile: string,
  prefix: string,
  files: FileRecord[]
): FileRecord[] {
  const resolvedPrefix = withoutTrailingSlash(path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), prefix)
  ));
  const directory = prefix.endsWith("/")
    ? resolvedPrefix
    : path.posix.dirname(resolvedPrefix);
  const basenamePrefix = prefix.endsWith("/") ? "" : path.posix.basename(resolvedPrefix);
  return files
    .filter((file) =>
      file.path !== fromFile &&
      file.kind !== "test" &&
      file.indexTier !== "tier0" &&
      path.posix.dirname(file.path) === directory &&
      path.posix.basename(file.path).startsWith(basenamePrefix)
    )
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, 24);
}

function withoutTrailingSlash(value: string): string {
  let result = value;
  while (result.length > 1 && result.endsWith("/")) result = result.slice(0, -1);
  return result;
}

function addLocalTypeReferenceEdges(
  edgeMap: Map<string, GraphEdgeRecord>,
  rootPath: string,
  files: FileRecord[],
  parsedFiles: ParsedFile[],
  goModules: Array<{ directory: string; modulePath: string }>
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const declarations = new Map<string, Set<string>>();
  const javaDeclarations = new Map<string, Set<string>>();
  const goDeclarations = new Map<string, Set<string>>();
  const goPackagesByDirectory = new Map<string, string>();

  for (const parsedFile of parsedFiles) {
    const scope = localTypeScope(parsedFile);
    if (!scope || fileByPath.get(parsedFile.filePath)?.indexTier === "tier0") continue;
    for (const symbol of parsedFile.symbols) {
      if (!["class", "interface", "type"].includes(symbol.kind)) continue;
      addDeclaration(declarations, `${scope}\0${symbol.name}`, parsedFile.filePath);
      if (parsedFile.language === "java") {
        const packageName = packageMetadata(parsedFile);
        if (packageName) {
          addDeclaration(javaDeclarations, `${packageName}.${symbol.name}`, parsedFile.filePath);
        }
      }
      if (parsedFile.language === "go") {
        const directory = path.posix.dirname(parsedFile.filePath);
        addDeclaration(goDeclarations, `${directory}\0${symbol.name}`, parsedFile.filePath);
        const packageName = packageMetadata(parsedFile);
        if (packageName) goPackagesByDirectory.set(directory, packageName);
      }
    }
  }

  for (const parsedFile of parsedFiles) {
    const scope = localTypeScope(parsedFile);
    if (!scope) continue;
    for (const reference of parsedFile.references ?? []) {
      addUniqueTypeReferenceEdge({
        edgeMap,
        rootPath,
        fromFile: parsedFile.filePath,
        targetFiles: declarations.get(`${scope}\0${reference}`),
        fileByPath,
        reference,
        reason: "parser-observed local type reference"
      });
    }

    if (parsedFile.language === "go") {
      const packageDirectories = [...goPackagesByDirectory.keys()];
      for (const specifier of parsedFile.imports) {
        if (isPackageMetadata(specifier)) continue;
        const targetDirectory = resolveLocalGoPackageDirectory(
          parsedFile.filePath,
          specifier,
          packageDirectories,
          goModules
        );
        if (!targetDirectory) continue;
        const qualifier = goPackagesByDirectory.get(targetDirectory);
        if (!qualifier) continue;
        for (const reference of parsedFile.references ?? []) {
          if (!reference.startsWith(`${qualifier}.`)) continue;
          const declaration = reference.slice(qualifier.length + 1);
          if (!declaration || declaration.includes(".")) continue;
          addUniqueTypeReferenceEdge({
            edgeMap,
            rootPath,
            fromFile: parsedFile.filePath,
            targetFiles: goDeclarations.get(`${targetDirectory}\0${declaration}`),
            fileByPath,
            reference,
            reason: "parser-observed Go imported type reference"
          });
        }
      }
    }

    if (parsedFile.language !== "java") continue;
    for (const specifier of parsedFile.imports) {
      if (isPackageMetadata(specifier) || specifier.endsWith(".*")) continue;
      addUniqueTypeReferenceEdge({
        edgeMap,
        rootPath,
        fromFile: parsedFile.filePath,
        targetFiles: javaDeclarations.get(specifier),
        fileByPath,
        reference: specifier.slice(specifier.lastIndexOf(".") + 1),
        reason: "parser-observed Java type import"
      });
    }
  }
}

function addDeclaration(
  declarations: Map<string, Set<string>>,
  key: string,
  filePath: string
): void {
  const paths = declarations.get(key) ?? new Set<string>();
  paths.add(filePath);
  declarations.set(key, paths);
}

function addUniqueTypeReferenceEdge(input: {
  edgeMap: Map<string, GraphEdgeRecord>;
  rootPath: string;
  fromFile: string;
  targetFiles: Set<string> | undefined;
  fileByPath: Map<string, FileRecord>;
  reference: string;
  reason: string;
}): void {
  const toFile = resolveTypeReferenceTarget(
    input.targetFiles,
    input.fromFile,
    input.fileByPath
  );
  if (!toFile) return;
  addEdge(input.edgeMap, {
    rootPath: input.rootPath,
    fromFile: input.fromFile,
    toFile,
    type: "type_reference",
    metadata: {
      reason: input.reason,
      reference: input.reference
    }
  });
}

function addLocalCallEdges(
  edgeMap: Map<string, GraphEdgeRecord>,
  rootPath: string,
  files: FileRecord[],
  parsedFiles: ParsedFile[]
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const declarations = new Map<string, Set<string>>();
  const callersByTarget = new Map<string, {
    declarationFile: string;
    symbol: string;
    callers: Set<string>;
  }>();

  for (const parsedFile of parsedFiles) {
    const scope = localCallScope(parsedFile);
    if (!scope || fileByPath.get(parsedFile.filePath)?.indexTier === "tier0") continue;
    for (const symbol of parsedFile.symbols) {
      if (symbol.kind !== "function") continue;
      addDeclaration(declarations, `${scope}\0${symbol.name}`, parsedFile.filePath);
    }
  }

  for (const parsedFile of parsedFiles) {
    const scope = localCallScope(parsedFile);
    if (!scope) continue;
    for (const call of parsedFile.calls ?? []) {
      const declarationFile = resolveTypeReferenceTarget(
        declarations.get(`${scope}\0${call}`),
        parsedFile.filePath,
        fileByPath
      );
      if (!declarationFile) continue;
      addEdge(edgeMap, {
        rootPath,
        fromFile: parsedFile.filePath,
        toFile: declarationFile,
        type: "call",
        metadata: {
          reason: "parser-observed unique local call target",
          symbol: call
        }
      });
      const familyKey = `${declarationFile}\0${call}`;
      const family = callersByTarget.get(familyKey) ?? {
        declarationFile,
        symbol: call,
        callers: new Set<string>()
      };
      family.callers.add(parsedFile.filePath);
      callersByTarget.set(familyKey, family);
    }
  }

  const maxSharedCallers = 8;
  for (const family of callersByTarget.values()) {
    const callers = [...family.callers].sort();
    if (callers.length < 2 || callers.length > maxSharedCallers) continue;
    for (let leftIndex = 0; leftIndex < callers.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < callers.length; rightIndex += 1) {
        addEdge(edgeMap, {
          rootPath,
          fromFile: callers[leftIndex]!,
          toFile: callers[rightIndex]!,
          type: "shared_call_target",
          metadata: {
            reason: "parser-observed shared unique local call target",
            symbol: family.symbol,
            declarationFile: family.declarationFile
          }
        });
      }
    }
  }
}

function resolveTypeReferenceTarget(
  targetFiles: Set<string> | undefined,
  fromFile: string,
  fileByPath: Map<string, FileRecord>
): string | undefined {
  const candidates = [...(targetFiles ?? [])].filter((path) => path !== fromFile);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;

  const productionCandidates = candidates.filter((path) => {
    const kind = fileByPath.get(path)?.kind;
    return kind === "source" || kind === "component" || kind === "route" || kind === "schema";
  });
  return productionCandidates.length === 1 ? productionCandidates[0] : undefined;
}

function localTypeScope(parsedFile: ParsedFile): string | undefined {
  if (parsedFile.language === "java") {
    const packageName = packageMetadata(parsedFile);
    return packageName ? `java:${packageName}` : undefined;
  }
  if (parsedFile.language === "go") {
    return `go:${path.posix.dirname(parsedFile.filePath)}:${packageMetadata(parsedFile) ?? ""}`;
  }
  if (parsedFile.language === "c" || parsedFile.language === "cpp") {
    return `${parsedFile.language}:${path.posix.dirname(parsedFile.filePath)}`;
  }
  return undefined;
}

function localCallScope(parsedFile: ParsedFile): string | undefined {
  if (parsedFile.language === "java" || parsedFile.language === "go") {
    return localTypeScope(parsedFile);
  }
  if (
    parsedFile.language === "python" ||
    parsedFile.language === "typescript" ||
    parsedFile.language === "javascript" ||
    parsedFile.language === "c" ||
    parsedFile.language === "cpp"
  ) {
    return `${parsedFile.language}:${path.posix.dirname(parsedFile.filePath)}`;
  }
  return undefined;
}

function packageMetadata(parsedFile: ParsedFile): string | undefined {
  return parsedFile.imports.find(isPackageMetadata)?.slice("package:".length);
}

function addSiblingImplementationEdges(
  edgeMap: Map<string, GraphEdgeRecord>,
  rootPath: string,
  files: FileRecord[],
  parsedFiles: ParsedFile[]
): void {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const families = new Map<string, ParsedFile[]>();
  for (const parsedFile of parsedFiles) {
    const file = filesByPath.get(parsedFile.filePath);
    if (!file || file.kind === "test" || file.indexTier === "tier0") continue;
    const parent = path.posix.dirname(parsedFile.filePath);
    const grandparent = path.posix.dirname(parent);
    if (parent === "." || grandparent === ".") continue;
    const familyKey = [
      parsedFile.language,
      grandparent,
      path.posix.basename(parsedFile.filePath)
    ].join("\0");
    families.set(familyKey, [...(families.get(familyKey) ?? []), parsedFile]);
  }

  for (const family of families.values()) {
    if (family.length < 2 || family.length > 24) continue;
    const ordered = [...family].sort((left, right) => left.filePath.localeCompare(right.filePath));
    const callableNames = new Map(ordered.map((parsedFile) => [
      parsedFile.filePath,
      new Set(
        parsedFile.symbols
          .filter((symbol) => symbol.kind === "function")
          .map((symbol) => symbol.name)
      )
    ]));
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const left = ordered[leftIndex]!;
        const right = ordered[rightIndex]!;
        const leftNames = callableNames.get(left.filePath)!;
        const rightNames = callableNames.get(right.filePath)!;
        const shared = [...leftNames].filter((name) => rightNames.has(name)).sort();
        const smallerSurface = Math.min(leftNames.size, rightNames.size);
        if (shared.length < 3 || smallerSurface === 0 || shared.length / smallerSurface < 0.5) continue;
        addEdge(edgeMap, {
          rootPath,
          fromFile: left.filePath,
          toFile: right.filePath,
          type: "implementation",
          metadata: {
            reason: "sibling modules implement a shared callable surface",
            sharedSymbols: shared.slice(0, 12)
          }
        });
      }
    }
  }
}

export function graphEdgesForFile(edges: GraphEdgeRecord[], target: string): GraphEdgeRecord[] {
  return edges.filter((edge) => edge.fromFile === target || edge.toFile === target);
}

function addTestEdges(edgeMap: Map<string, GraphEdgeRecord>, rootPath: string, files: FileRecord[]): void {
  const sourceFiles = files.filter((file) => file.kind !== "test");
  const testFiles = files.filter((file) => file.kind === "test");
  const sourceByBase = new Map<string, FileRecord[]>();
  const sourceByDirectory = new Map<string, FileRecord[]>();

  for (const source of sourceFiles) {
    const sourceBase = baseNameWithoutExtension(source.path);
    sourceByBase.set(sourceBase, [...(sourceByBase.get(sourceBase) ?? []), source]);
    const directory = path.posix.dirname(source.path);
    sourceByDirectory.set(directory, [...(sourceByDirectory.get(directory) ?? []), source]);
  }

  for (const test of testFiles) {
    const candidates = candidateSourcesForTest(test, sourceByBase, sourceByDirectory);

    for (const source of candidates) {
      addEdge(edgeMap, {
        rootPath,
        fromFile: test.path,
        toFile: source.path,
        type: "test_for",
        metadata: { reason: "filename/path proximity" }
      });
    }
  }
}

function addGoPackageImportEdges(
  edgeMap: Map<string, GraphEdgeRecord>,
  rootPath: string,
  files: FileRecord[],
  parsedFiles: ParsedFile[],
  goModules: Array<{ directory: string; modulePath: string }>
): void {
  const parsedByPath = new Map(parsedFiles.map((parsed) => [parsed.filePath, parsed]));
  const productionFilesByDirectory = new Map<string, FileRecord[]>();

  for (const file of files) {
    if (file.language !== "go" || file.kind === "test") continue;
    const directory = path.posix.dirname(file.path);
    productionFilesByDirectory.set(directory, [
      ...(productionFilesByDirectory.get(directory) ?? []),
      file
    ]);
  }

  const packageDirectories = [...productionFilesByDirectory.keys()];
  for (const parsedFile of parsedFiles) {
    if (parsedFile.language !== "go") continue;

    for (const specifier of parsedFile.imports) {
      if (isPackageMetadata(specifier)) continue;
      const targetDirectory = resolveLocalGoPackageDirectory(
        parsedFile.filePath,
        specifier,
        packageDirectories,
        goModules
      );
      if (!targetDirectory) continue;

      const targets = (productionFilesByDirectory.get(targetDirectory) ?? [])
        .slice()
        .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path))
        .slice(0, 12);
      const packageName = targets
        .map((target) => parsedByPath.get(target.path))
        .map((parsed) => parsed ? goPackageName(parsed) : undefined)
        .find((name): name is string => Boolean(name));

      for (const target of targets) {
        if (target.path === parsedFile.filePath) continue;
        addEdge(edgeMap, {
          rootPath,
          fromFile: parsedFile.filePath,
          toFile: target.path,
          type: "imports",
          metadata: {
            reason: "Go local package import",
            specifier,
            ...(packageName ? { package: packageName } : {})
          }
        });
      }
    }
  }
}

function addGoTestSymbolEdges(
  edgeMap: Map<string, GraphEdgeRecord>,
  rootPath: string,
  files: FileRecord[],
  parsedFiles: ParsedFile[]
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const productionSymbols = new Map<string, Array<{ filePath: string; symbol: string }>>();

  for (const parsedFile of parsedFiles) {
    const file = fileByPath.get(parsedFile.filePath);
    if (parsedFile.language !== "go" || !file || file.kind === "test") continue;
    const directory = path.posix.dirname(parsedFile.filePath);
    for (const symbol of parsedFile.symbols) {
      const key = `${directory}:${symbol.name}`;
      productionSymbols.set(key, [
        ...(productionSymbols.get(key) ?? []),
        { filePath: parsedFile.filePath, symbol: symbol.name }
      ]);
    }
  }

  for (const parsedFile of parsedFiles) {
    const file = fileByPath.get(parsedFile.filePath);
    if (parsedFile.language !== "go" || file?.kind !== "test") continue;
    const directory = path.posix.dirname(parsedFile.filePath);

    for (const testSymbol of parsedFile.symbols) {
      for (const sourceName of goSourceSymbolNamesForTest(testSymbol.name)) {
        for (const source of productionSymbols.get(`${directory}:${sourceName}`) ?? []) {
          addEdge(edgeMap, {
            rootPath,
            fromFile: parsedFile.filePath,
            toFile: source.filePath,
            type: "test_for",
            metadata: {
              reason: "Go test symbol matches source symbol",
              testSymbol: testSymbol.name,
              sourceSymbol: source.symbol
            }
          });
        }
      }
    }
  }
}

function addParentRouteEdges(edgeMap: Map<string, GraphEdgeRecord>, rootPath: string, files: FileRecord[]): void {
  const routes = files.filter((file) => isNextRouteFile(file.path));
  const filesByDirectory = new Map<string, FileRecord[]>();

  for (const file of files) {
    const directory = path.posix.dirname(file.path);
    filesByDirectory.set(directory, [...(filesByDirectory.get(directory) ?? []), file]);
  }

  for (const route of routes) {
    const directory = path.posix.dirname(route.path);
    for (const candidate of filesByDirectory.get(directory) ?? []) {
      if (candidate.path === route.path || candidate.kind === "test") continue;
      addEdge(edgeMap, {
        rootPath,
        fromFile: candidate.path,
        toFile: route.path,
        type: "parent_route",
        metadata: { reason: "same Next route segment" }
      });
    }
  }
}

function addEdge(edgeMap: Map<string, GraphEdgeRecord>, edge: GraphEdgeRecord): void {
  edgeMap.set(`${edge.fromFile}->${edge.toFile}:${edge.type}`, edge);
}

function isPackageMetadata(specifier: string): boolean {
  return specifier.startsWith("package:");
}

function goPackageName(parsedFile: ParsedFile): string | undefined {
  return parsedFile.imports
    .find(isPackageMetadata)
    ?.slice("package:".length);
}

function resolveLocalGoPackageDirectory(
  fromFile: string,
  specifier: string,
  packageDirectories: string[],
  goModules: Array<{ directory: string; modulePath: string }>
): string | undefined {
  if (specifier.startsWith(".")) {
    const directory = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    return packageDirectories.includes(directory) ? directory : undefined;
  }

  for (const module of goModules.slice().sort((a, b) => b.modulePath.length - a.modulePath.length)) {
    if (specifier !== module.modulePath && !specifier.startsWith(`${module.modulePath}/`)) continue;
    const relativePackage = specifier === module.modulePath
      ? "."
      : specifier.slice(module.modulePath.length + 1);
    const directory = path.posix.normalize(path.posix.join(module.directory, relativePackage));
    if (packageDirectories.includes(directory)) return directory;
  }

  return undefined;
}

function goSourceSymbolNamesForTest(testName: string): string[] {
  const prefix = ["Test", "Benchmark", "Fuzz", "Example"].find((candidate) => testName.startsWith(candidate));
  if (!prefix) return [];
  const remainder = testName.slice(prefix.length);
  if (!remainder) return [];
  const [primary, ...qualified] = remainder.split("_").filter(Boolean);
  return [primary, ...qualified.filter((name) => /^\p{Lu}/u.test(name))]
    .filter((name): name is string => Boolean(name));
}

function isLikelyTestFor(testPath: string, sourcePath: string): boolean {
  const testDirectory = path.posix.dirname(testPath);
  const sourceDirectory = path.posix.dirname(sourcePath);
  const sourceBase = path.posix.basename(sourcePath).replace(/\.[^.]+$/, "").toLowerCase();
  const testBase = path.posix.basename(testPath).toLowerCase();
  const normalizedTest = testPath.toLowerCase();
  const normalizedSource = sourcePath.toLowerCase();

  return (
    testBase.includes(sourceBase) ||
    testPath.toLowerCase().includes(sourceBase) ||
    testDirectory === sourceDirectory ||
    testDirectory.endsWith("__tests__") && path.posix.dirname(testDirectory) === sourceDirectory ||
    testDirectory.endsWith("/tests") && normalizedTest.includes(sourceBase) ||
    normalizedTest.includes("/src/test/java/") && normalizedSource.includes("/src/main/java/") && testBase.includes(sourceBase)
  );
}

function candidateSourcesForTest(
  test: FileRecord,
  sourceByBase: Map<string, FileRecord[]>,
  sourceByDirectory: Map<string, FileRecord[]>
): FileRecord[] {
  const testDirectory = path.posix.dirname(test.path);
  const mappedDirectory = sourceDirectoryForTestDirectory(testDirectory);
  const testBase = baseNameWithoutExtension(test.path)
    .replace(/(^test[-_.])|([-_.]test$)|([-_.]spec$)|(^test_)/g, "")
    .replace(/test$/i, "")
    .toLowerCase();
  const candidates = new Map<string, FileRecord>();

  for (const source of sourceByBase.get(testBase) ?? []) {
    candidates.set(source.path, source);
  }

  for (const source of sourceByDirectory.get(mappedDirectory) ?? []) {
    if (isLikelyTestFor(test.path, source.path)) {
      candidates.set(source.path, source);
    }
  }

  for (const source of sourceByDirectory.get(testDirectory) ?? []) {
    if (isLikelyTestFor(test.path, source.path)) {
      candidates.set(source.path, source);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path))
    .slice(0, 12);
}

function sourceDirectoryForTestDirectory(testDirectory: string): string {
  if (testDirectory.endsWith("/__tests__")) return path.posix.dirname(testDirectory);
  if (testDirectory.endsWith("/tests")) return path.posix.dirname(testDirectory);
  if (testDirectory.includes("/src/test/java/")) {
    return testDirectory.replace("/src/test/java/", "/src/main/java/");
  }
  return testDirectory;
}

function baseNameWithoutExtension(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.(test|spec)?\.?[^.]+$/i, "").toLowerCase();
}

function isNextRouteFile(filePath: string): boolean {
  const base = path.posix.basename(filePath);
  return filePath.startsWith("app/") && ["page.tsx", "page.ts", "layout.tsx", "layout.ts"].includes(base);
}
