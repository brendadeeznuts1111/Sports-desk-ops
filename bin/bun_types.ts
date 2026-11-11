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
    error: null,
  };

  const configPath = path.join(cwd, "tsconfig.json");
  let config: ts.ParsedCommandLine;
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error !== undefined)
      return { ...empty, error: `no tsconfig at ${configPath}` };
    // Only the compiler options are used. Emptying files/include skips expanding `**/*.ts`
    // across the repo (~50-110 ms); the resulting "no inputs" diagnostic is ignored.
    config = ts.parseJsonConfigFileContent(
      { ...read.config, files: [], include: [] },
      ts.sys,
      cwd,
      undefined,
      configPath,
    );
  } catch (error) {
    return { ...empty, error: `tsconfig: ${String(error)}` };
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
    return { ...empty, error: `program: ${String(error)}` };
  }

  const checker = program.getTypeChecker();
  const source = program.getSourceFile(VIRTUAL);
  if (source === undefined)
    return { ...empty, error: "virtual source missing" };

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
    return { ...empty, error: "Bun symbol not found" };

  const anchor = bunSymbol.declarations?.[0] ?? source;
  const bunType = checker.getTypeOfSymbolAtLocation(bunSymbol, anchor);
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
    error: null,
  };
}
