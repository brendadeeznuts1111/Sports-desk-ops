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
  readonly runtime: number;
  readonly absent: string[];
  readonly undeclared: string[];
  readonly namespaces: NamespaceGap[];
  /** Set when the program could not be built; the rest is then empty. */
  readonly error: string | null;
}

const VIRTUAL = "/__bun_surface_probe__.ts";
const VIRTUAL_TEXT = "export const b = Bun;\n";

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
    runtime: 0,
    absent: [],
    undeclared: [],
    namespaces: [],
    error: null,
  };

  const configPath = path.join(cwd, "tsconfig.json");
  let config: ts.ParsedCommandLine | undefined;
  try {
    config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      },
    );
  } catch (error) {
    return { ...empty, error: `tsconfig: ${String(error)}` };
  }
  if (config === undefined)
    return { ...empty, error: `no tsconfig at ${configPath}` };

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
  ts.forEachChild(source, (node) => {
    if (!ts.isVariableStatement(node)) return;
    const declaration = node.declarationList.declarations[0];
    if (declaration?.initializer !== undefined) {
      bunSymbol = checker.getSymbolAtLocation(declaration.initializer);
    }
  });
  if (bunSymbol === undefined)
    return { ...empty, error: "Bun symbol not found" };

  const anchor = bunSymbol.declarations?.[0] ?? source;
  const bunType = checker.getTypeOfSymbolAtLocation(bunSymbol, anchor);
  const declared = checker
    .getPropertiesOfType(bunType)
    .map((symbol) => symbol.name)
    .filter((name) => !name.startsWith("__"));
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
    runtime: runtime.length,
    absent: declared.filter((name) => !runtime.includes(name)),
    undeclared: runtime.filter((name) => !declared.includes(name)),
    namespaces: namespaceGaps,
    error: null,
  };
}
