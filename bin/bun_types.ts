/**
 * @file bin/bun_types.ts
 * @description Compute declaration/runtime drift for the `Bun` object with the
 * TypeScript compiler API.
 *
 * The two layers are generated separately: `bun-types` says what exists, the
 * binary says what runs. This module asks the compiler for the declared members
 * and compares them with the live object, so `dx bun --types` reports the gaps
 * instead of hardcoding them.
 *
 * Opt-in: loading a program costs ~1s, which is too slow for the default path.
 */

import * as ts from "typescript";
import path from "node:path";

export interface NamespaceGap {
  readonly name: string;
  /** Declared in bun-types, missing at runtime. */
  readonly absent: string[];
  /** Present at runtime, not in bun-types. */
  readonly undeclared: string[];
}

/** Tag for doc-snapshot entity inventory blocks in `bun-surface --json`. */
export const E_DOC_SNAPSHOT_ENTITY_INVENTORY =
  "E_DOC_SNAPSHOT_ENTITY_INVENTORY" as const;

export interface AmbientDtsKindNumbers {
  readonly functions: number;
  readonly classes: number;
  readonly interfaces: number;
  readonly types: number;
  readonly variables: number;
  readonly namespaces: number;
}

export interface EntityInventoryReport extends AmbientDtsKindNumbers {
  readonly doc: typeof E_DOC_SNAPSHOT_ENTITY_INVENTORY;
  readonly total: number;
  readonly error: string | null;
}

export interface TypesReport {
  readonly declared: number;
  /** Type-only symbols exported by `declare module "bun"` (and `Bun.<Type>`). */
  readonly declaredTypes: string[];
  /** Whether `import * as m from "bun"` exposes the exact same value declarations as `globalThis.Bun`. */
  readonly moduleParity: boolean;
  readonly runtime: number;
  readonly absent: string[];
  readonly undeclared: string[];
  readonly namespaces: NamespaceGap[];
  /** Category counts from the active `@types/bun` AST (`declare namespace Bun`). */
  readonly entityInventory: EntityInventoryReport;
  /** Set when the program could not be built; the rest is then empty. */
  readonly error: string | null;
}

const VIRTUAL = "/__bun_surface_probe__.ts";
const VIRTUAL_TEXT = `import * as bunMod from "bun";\nexport const b = Bun;\nexport const m = bunMod;\n`;

/** Properties every function inherits that say nothing about the API surface. */
const FUNCTION_INTERNALS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
  "constructor",
  "apply",
  "bind",
  "call",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
]);

/**
 * Public surface of a value: own properties plus the prototype chain.
 *
 * `Bun.$` keeps `env`, `cwd`, `nothrow` and `throws` on its prototype, so an
 * own-property comparison reports them as declared-but-absent.
 */
function surfaceNames(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const names = new Set<string>();
  let current: unknown = value;
  while (
    current !== null &&
    current !== Object.prototype &&
    current !== Function.prototype
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (!FUNCTION_INTERNALS.has(name)) names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names];
}

type AmbientKind = keyof AmbientDtsKindNumbers;

const EMPTY_INVENTORY: EntityInventoryReport = {
  doc: E_DOC_SNAPSHOT_ENTITY_INVENTORY,
  functions: 0,
  classes: 0,
  interfaces: 0,
  types: 0,
  variables: 0,
  namespaces: 0,
  total: 0,
  error: null,
};

function emptyInventory(error: string): EntityInventoryReport {
  return { ...EMPTY_INVENTORY, error };
}

interface BunProbeContext {
  readonly checker: ts.TypeChecker;
  readonly source: ts.SourceFile;
  readonly anchor: ts.Node;
  readonly bunType: ts.Type;
  readonly bunSymbol: ts.Symbol;
  readonly modType: ts.Type | undefined;
  readonly modNamespaceSymbol: ts.Symbol | undefined;
}

async function buildBunProbeContext(
  cwd: string,
): Promise<{ ctx: BunProbeContext | null; error: string | null }> {
  const configPath = path.join(cwd, "tsconfig.json");
  let config: ts.ParsedCommandLine;
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error !== undefined)
      return { ctx: null, error: `no tsconfig at ${configPath}` };
    config = ts.parseJsonConfigFileContent(
      { ...read.config, files: [], include: [] },
      ts.sys,
      cwd,
      undefined,
      configPath,
    );
  } catch (error) {
    return { ctx: null, error: `tsconfig: ${String(error)}` };
  }

  const host = ts.createCompilerHost(config.options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === VIRTUAL
      ? ts.createSourceFile(name, VIRTUAL_TEXT, languageVersion, true)
      : baseGetSourceFile(name, languageVersion, onError, shouldCreate);
  host.fileExists = (name) => name === VIRTUAL || baseFileExists(name);
  host.readFile = (name) =>
    name === VIRTUAL ? VIRTUAL_TEXT : baseReadFile(name);

  let program: ts.Program;
  try {
    program = ts.createProgram([VIRTUAL], config.options, host);
  } catch (error) {
    return { ctx: null, error: `program: ${String(error)}` };
  }

  const checker = program.getTypeChecker();
  const source = program.getSourceFile(VIRTUAL);
  if (source === undefined)
    return { ctx: null, error: "virtual source missing" };

  let bunSymbol: ts.Symbol | undefined;
  let modType: ts.Type | undefined;
  let modNamespaceSymbol: ts.Symbol | undefined;
  ts.forEachChild(source, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      const sym = checker.getSymbolAtLocation(
        node.importClause.namedBindings.name,
      );
      if (sym !== undefined) {
        modNamespaceSymbol = checker.getAliasedSymbol(sym);
      }
      return;
    }
    if (!ts.isVariableStatement(node)) return;
    const declaration = node.declarationList.declarations[0];
    if (declaration?.initializer === undefined) return;
    const varName = ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : "";
    if (varName === "b") {
      bunSymbol = checker.getSymbolAtLocation(declaration.initializer);
    } else if (varName === "m") {
      modType = checker.getTypeAtLocation(declaration);
    }
  });
  if (bunSymbol === undefined)
    return { ctx: null, error: "Bun symbol not found" };

  const anchor = bunSymbol.declarations?.[0] ?? source;
  const bunType = checker.getTypeOfSymbolAtLocation(bunSymbol, anchor);
  return {
    ctx: {
      checker,
      source,
      anchor,
      bunType,
      bunSymbol,
      modType,
      modNamespaceSymbol,
    },
    error: null,
  };
}

function classifyAmbientMember(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  anchor: ts.Node,
): AmbientKind | null {
  const name = symbol.name;
  if (name.startsWith("__")) return null;

  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return "classes";
  if (flags & ts.SymbolFlags.Interface) return "interfaces";
  if (flags & ts.SymbolFlags.TypeAlias) return "types";
  if (flags & ts.SymbolFlags.Enum) return "types";
  if (flags & ts.SymbolFlags.Namespace) return "namespaces";
  if (flags & ts.SymbolFlags.Function) return "functions";
  if (flags & ts.SymbolFlags.Method) return "functions";

  const decls = symbol.getDeclarations() ?? [];
  for (const decl of decls) {
    if (ts.isModuleDeclaration(decl)) return "namespaces";
    if (
      ts.isFunctionDeclaration(decl) ||
      ts.isMethodSignature(decl) ||
      ts.isCallSignatureDeclaration(decl) ||
      ts.isConstructSignatureDeclaration(decl)
    ) {
      return "functions";
    }
    if (ts.isClassDeclaration(decl)) return "classes";
    if (ts.isInterfaceDeclaration(decl)) return "interfaces";
    if (ts.isTypeAliasDeclaration(decl)) return "types";
    if (ts.isEnumDeclaration(decl)) return "types";
    if (ts.isVariableDeclaration(decl)) return "variables";
  }

  if (
    flags &
    (ts.SymbolFlags.Property |
      ts.SymbolFlags.Variable |
      ts.SymbolFlags.BlockScopedVariable)
  ) {
    const first = decls[0] ?? anchor;
    const type = checker.getTypeOfSymbolAtLocation(symbol, first);
    if (type.getCallSignatures().length > 0) return "functions";
    if (type.getConstructSignatures().length > 0) return "classes";
    return "variables";
  }

  if (flags & ts.SymbolFlags.Type) return "types";
  return null;
}

function collectBunNamespaceMembers(
  ctx: BunProbeContext,
): Map<string, ts.Symbol> {
  const { checker, bunType, bunSymbol } = ctx;
  const members = new Map<string, ts.Symbol>();
  const ingest = (symbol: ts.Symbol) => {
    if (symbol.name.startsWith("__")) return;
    members.set(symbol.name, symbol);
  };

  for (const property of checker.getPropertiesOfType(bunType)) ingest(property);
  const root = bunSymbol;
  if (root.members !== undefined) {
    for (const member of root.members.values()) ingest(member);
  }
  const exportSymbol = checker.getExportSymbolOfSymbol(root);
  if (exportSymbol?.members !== undefined) {
    for (const member of exportSymbol.members.values()) ingest(member);
  }

  const valueNames = new Set(members.keys());
  if (ctx.modNamespaceSymbol !== undefined) {
    for (const exp of checker.getExportsOfModule(ctx.modNamespaceSymbol)) {
      if (exp.name.startsWith("__")) continue;
      if (exp.name === "default") continue;
      if (!valueNames.has(exp.name)) ingest(exp);
    }
  }
  return members;
}

/**
 * Counts functions, classes, interfaces, types, variables, and namespaces on the
 * declared `Bun` namespace from the active `@types/bun` program (not hardcoded).
 */
export function deriveAmbientDtsKindNumbers(
  ctx: BunProbeContext,
): EntityInventoryReport {
  const counts = {
    functions: 0,
    classes: 0,
    interfaces: 0,
    types: 0,
    variables: 0,
    namespaces: 0,
  } satisfies AmbientDtsKindNumbers;

  for (const symbol of collectBunNamespaceMembers(ctx).values()) {
    const kind = classifyAmbientMember(ctx.checker, symbol, ctx.anchor);
    if (kind === null) continue;
    counts[kind] += 1;
  }

  const total =
    counts.functions +
    counts.classes +
    counts.interfaces +
    counts.types +
    counts.variables +
    counts.namespaces;

  return {
    doc: E_DOC_SNAPSHOT_ENTITY_INVENTORY,
    ...counts,
    total,
    error: null,
  };
}

export async function deriveAmbientDtsKindNumbersFromProject(
  cwd: string = process.cwd(),
): Promise<EntityInventoryReport> {
  const built = await buildBunProbeContext(cwd);
  if (built.error !== null || built.ctx === null) {
    return emptyInventory(built.error ?? "probe unavailable");
  }
  return deriveAmbientDtsKindNumbers(built.ctx);
}

export async function declarationDrift(
  namespaces: readonly string[],
  cwd: string = process.cwd(),
): Promise<TypesReport> {
  const empty: TypesReport = {
    declared: 0,
    declaredTypes: [],
    moduleParity: false,
    runtime: 0,
    absent: [],
    undeclared: [],
    namespaces: [],
    entityInventory: { ...EMPTY_INVENTORY },
    error: null,
  };

  const built = await buildBunProbeContext(cwd);
  if (built.error !== null || built.ctx === null) {
    return {
      ...empty,
      entityInventory: emptyInventory(built.error ?? "probe unavailable"),
      error: built.error ?? "probe unavailable",
    };
  }
  const { checker, anchor, bunType, modType, modNamespaceSymbol } = built.ctx;

  const entityInventory = deriveAmbientDtsKindNumbers(built.ctx);
  const declared = checker
    .getPropertiesOfType(bunType)
    .map((symbol) => symbol.name)
    .filter((name) => !name.startsWith("__"))
    .sort();
  const modDeclared =
    modType === undefined
      ? []
      : checker
          .getPropertiesOfType(modType)
          .map((symbol) => symbol.name)
          .filter((name) => !name.startsWith("__"))
          .sort();
  const moduleParity =
    declared.length === modDeclared.length &&
    declared.every((name, idx) => name === modDeclared[idx]);
  const declaredSet = new Set(declared);
  const declaredTypes =
    modNamespaceSymbol === undefined
      ? []
      : checker
          .getExportsOfModule(modNamespaceSymbol)
          .filter(
            (symbol) =>
              !declaredSet.has(symbol.name) &&
              (symbol.flags &
                (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace)) !==
                0 &&
              !symbol.name.startsWith("__"),
          )
          .map((symbol) => symbol.name)
          .sort();
  const runtime = surfaceNames(Bun);

  const namespaceGaps: NamespaceGap[] = [];
  for (const namespace of namespaces) {
    const symbol = checker.getPropertyOfType(bunType, namespace);
    if (symbol === undefined) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, anchor);
    const declaredMembers = checker
      .getPropertiesOfType(type)
      .map((member) => member.name)
      .filter(
        (name) => !name.startsWith("__") && !FUNCTION_INTERNALS.has(name),
      );
    const runtimeMembers = surfaceNames(
      (Bun as unknown as Record<string, unknown>)[namespace],
    );
    namespaceGaps.push({
      name: namespace,
      absent: declaredMembers.filter((name) => !runtimeMembers.includes(name)),
      undeclared: runtimeMembers.filter(
        (name) => !declaredMembers.includes(name),
      ),
    });
  }

  return {
    declared: declared.length,
    declaredTypes,
    moduleParity,
    runtime: runtime.length,
    absent: declared.filter((name) => !runtime.includes(name)),
    undeclared: runtime.filter((name) => !declared.includes(name)),
    namespaces: namespaceGaps,
    entityInventory,
    error: null,
  };
}
