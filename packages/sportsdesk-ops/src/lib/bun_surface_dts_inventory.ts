/**
 * @file packages/sportsdesk-ops/src/lib/bun_surface_dts_inventory.ts
 * @description DOD-DEHARDCODE-02: derive Bun ambient declaration category counts and
 * DTS closure SHA (GATE-BUN-DOC-BLOB-SHA-01) from installed @types/bun / bun-types.
 */

import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export type BunSymbolKind =
  "Function" | "Class" | "Interface" | "Type" | "Variable" | "Namespace";

export interface BunSymbolLocation {
  readonly symbol: string;
  readonly kind: BunSymbolKind;
  /** e.g. `packages/bun-types/bun.d.ts` */
  readonly leafPath: string;
  readonly line: number;
  readonly blobUrl: string;
}

export interface BunNamespaceSurfaceCounts {
  readonly functions: number;
  readonly classes: number;
  readonly interfaces: number;
  readonly types: number;
  readonly variables: number;
  readonly namespaces: number;
}

export interface DerivedBunDtsInventory {
  readonly counts: BunNamespaceSurfaceCounts;
  readonly mergedFnNamespaces: readonly string[];
  readonly astDtsSha256: string;
  readonly symbolLocations: readonly BunSymbolLocation[];
}

const REF_PATH_RE = /\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g;
const REF_TYPES_RE = /\/\/\/\s*<reference\s+types=["']([^"']+)["']\s*\/>/g;

const BUN_TYPES_ROOT_RE = /[/\\]bun-types[/\\]/;

export function searchRootsFromModuleDir(moduleDir: string): string[] {
  return [
    resolve(moduleDir, "../.."),
    resolve(moduleDir, "../../.."),
    resolve(moduleDir, "../../../.."),
  ];
}

export function resolveInstalledBunTypesEntry(
  searchRoots: readonly string[],
): string {
  for (const root of searchRoots) {
    try {
      return Bun.resolveSync("@types/bun/index.d.ts", root);
    } catch {
      continue;
    }
  }
  throw new Error("ERR_CAT_TYPES_ENTRY: cannot resolve @types/bun/index.d.ts");
}

export function resolveBunTypesRootDir(dtsFiles: readonly string[]): string {
  const index = dtsFiles.find((path) =>
    /[/\\]bun-types[/\\]index\.d\.ts$/.test(path),
  );
  if (index !== undefined) return dirname(index);
  const any = dtsFiles.find((path) => BUN_TYPES_ROOT_RE.test(path));
  if (any !== undefined) return dirname(any);
  throw new Error("ERR_CAT_BUN_TYPES_ROOT: bun-types not in DTS closure");
}

function resolveTypesPackageEntry(
  typesName: string,
  searchRoots: readonly string[],
  fromDir: string,
): string | null {
  const candidates =
    typesName === "node"
      ? ["@types/node/index.d.ts"]
      : [`${typesName}/index.d.ts`, `${typesName}/package.json`];
  const roots = [fromDir, ...searchRoots];
  for (const root of roots) {
    for (const candidate of candidates) {
      try {
        const resolved = Bun.resolveSync(candidate, root);
        if (resolved.endsWith("package.json")) {
          const pkgText = ts.sys.readFile(resolved);
          if (pkgText === undefined) continue;
          const pkg = JSON.parse(pkgText) as {
            types?: string;
            typings?: string;
          };
          const typesField = pkg.types ?? pkg.typings ?? "index.d.ts";
          return resolve(dirname(resolved), typesField);
        }
        return resolved;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Enumerate the `bun-types` package root (`*.d.ts` only, no hardcoded filenames).
 * `jsx.d.ts` and `test-globals.d.ts` are optional entry points that `index.d.ts`
 * never references, so the reference walk alone would omit them from the closure
 * hash; the audit's "every leaf file" claim needs the directory too.
 */
function enqueueBunTypesRootLeaves(
  typesIndexPath: string,
  visited: ReadonlySet<string>,
  queue: string[],
): void {
  const rootDir = dirname(typesIndexPath);
  try {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
      const fullPath = resolve(rootDir, entry.name);
      if (!visited.has(fullPath)) queue.push(fullPath);
    }
  } catch {
    return;
  }
}

export function collectDtsClosureFiles(
  entryPath: string,
  searchRoots: readonly string[],
): string[] {
  const visited = new Set<string>();
  const queue: string[] = [entryPath];

  const visitFile = (currentPath: string): void => {
    if (visited.has(currentPath)) return;
    visited.add(currentPath);

    const text = ts.sys.readFile(currentPath);
    if (!text) return;

    const baseDir = dirname(currentPath);
    REF_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REF_PATH_RE.exec(text)) !== null) {
      const targetPath = resolve(baseDir, match[1]!);
      if (!visited.has(targetPath) && ts.sys.fileExists(targetPath)) {
        queue.push(targetPath);
      }
    }

    REF_TYPES_RE.lastIndex = 0;
    while ((match = REF_TYPES_RE.exec(text)) !== null) {
      const resolved = resolveTypesPackageEntry(
        match[1]!,
        searchRoots,
        baseDir,
      );
      if (
        resolved !== null &&
        !visited.has(resolved) &&
        ts.sys.fileExists(resolved)
      ) {
        queue.push(resolved);
      }
    }
  };

  while (queue.length > 0) visitFile(queue.shift()!);

  // The bun-types root is the directory of the `bun-types/index.d.ts` leaf reached
  // through @types/bun's `/// <reference types="bun-types" />`.
  const bunTypesIndex = Array.from(visited).find((path) =>
    /[/\\]bun-types[/\\]index\.d\.ts$/.test(path),
  );
  if (bunTypesIndex !== undefined) {
    enqueueBunTypesRootLeaves(bunTypesIndex, visited, queue);
    while (queue.length > 0) visitFile(queue.shift()!);
  }

  return Array.from(visited).sort();
}

function isBunAmbientModule(name: ts.ModuleName): boolean {
  if (ts.isIdentifier(name)) return name.text === "Bun";
  if (ts.isStringLiteral(name)) return name.text === "bun";
  return false;
}

function leafPathForRepo(
  filePath: string,
  typesRootDir: string,
): string | null {
  const rel = relative(typesRootDir, filePath).replaceAll("\\", "/");
  if (rel.startsWith("..") || rel.length === 0) return null;
  return `packages/bun-types/${rel}`;
}

function blobUrl(
  auditedBunCommit: string,
  leafPath: string,
  line: number,
): string {
  return `https://github.com/oven-sh/bun/blob/${auditedBunCommit}/${leafPath}#L${line}`;
}

function walkBunModuleStatements(
  body: ts.ModuleBlock,
  visit: (stmt: ts.Statement) => void,
): void {
  for (const stmt of body.statements) {
    visit(stmt);
    if (ts.isModuleDeclaration(stmt) && stmt.body !== undefined) {
      if (ts.isModuleBlock(stmt.body)) {
        walkBunModuleStatements(stmt.body, visit);
      }
    }
  }
}

export function deriveAmbientDtsKindNumbers(
  dtsFiles: readonly string[],
  typesRootDir: string,
  auditedBunCommit: string,
): DerivedBunDtsInventory {
  const fnNames = new Set<string>();
  const classNames = new Set<string>();
  const interfaceNames = new Set<string>();
  const typeNames = new Set<string>();
  const varNames = new Set<string>();
  const namespaceNames = new Set<string>();

  const seenLocationKeys = new Set<string>();
  const symbolLocations: BunSymbolLocation[] = [];
  const hasher = new Bun.CryptoHasher("sha256");

  const recordSymbol = (
    name: string,
    kind: BunSymbolKind,
    leafPath: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
  ): void => {
    const line =
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1;
    const dedupeKey = `${name}:${kind}:${leafPath}:${line}`;
    if (seenLocationKeys.has(dedupeKey)) return;
    seenLocationKeys.add(dedupeKey);
    symbolLocations.push({
      symbol: name,
      kind,
      leafPath,
      line,
      blobUrl: blobUrl(auditedBunCommit, leafPath, line),
    });
  };

  const classifyStatement = (
    stmt: ts.Statement,
    leafPath: string,
    sourceFile: ts.SourceFile,
  ): void => {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      fnNames.add(stmt.name.text);
      recordSymbol(stmt.name.text, "Function", leafPath, sourceFile, stmt);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      classNames.add(stmt.name.text);
      recordSymbol(stmt.name.text, "Class", leafPath, sourceFile, stmt);
    } else if (ts.isInterfaceDeclaration(stmt)) {
      interfaceNames.add(stmt.name.text);
      recordSymbol(stmt.name.text, "Interface", leafPath, sourceFile, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      typeNames.add(stmt.name.text);
      recordSymbol(stmt.name.text, "Type", leafPath, sourceFile, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          varNames.add(decl.name.text);
          recordSymbol(decl.name.text, "Variable", leafPath, sourceFile, decl);
        }
      }
    } else if (ts.isModuleDeclaration(stmt)) {
      if (ts.isIdentifier(stmt.name)) {
        namespaceNames.add(stmt.name.text);
        recordSymbol(stmt.name.text, "Namespace", leafPath, sourceFile, stmt);
      }
    } else if (ts.isEnumDeclaration(stmt)) {
      typeNames.add(stmt.name.text);
      recordSymbol(stmt.name.text, "Type", leafPath, sourceFile, stmt);
    }
  };

  for (const filePath of dtsFiles) {
    const sourceText = ts.sys.readFile(filePath);
    if (!sourceText) continue;

    hasher.update(sourceText);
    const leafPath = leafPathForRepo(filePath, typesRootDir);
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.ESNext,
      true,
    );

    for (const topStmt of sourceFile.statements) {
      if (!ts.isModuleDeclaration(topStmt) || topStmt.body === undefined)
        continue;
      if (!isBunAmbientModule(topStmt.name)) continue;
      if (!ts.isModuleBlock(topStmt.body)) continue;
      if (leafPath === null) continue;
      walkBunModuleStatements(topStmt.body, (stmt) =>
        classifyStatement(stmt, leafPath, sourceFile),
      );
    }
  }

  const mergedFnNamespaces = Array.from(namespaceNames)
    .filter((name) => fnNames.has(name) || varNames.has(name))
    .sort();

  symbolLocations.sort((a, b) =>
    a.symbol === b.symbol
      ? a.kind.localeCompare(b.kind)
      : a.symbol.localeCompare(b.symbol),
  );

  return {
    counts: Object.freeze({
      functions: fnNames.size,
      classes: classNames.size,
      interfaces: interfaceNames.size,
      types: typeNames.size,
      variables: varNames.size,
      namespaces: namespaceNames.size,
    }),
    mergedFnNamespaces,
    astDtsSha256: hasher.digest("hex"),
    symbolLocations,
  };
}
