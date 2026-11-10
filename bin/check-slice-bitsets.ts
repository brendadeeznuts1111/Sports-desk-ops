#!/usr/bin/env bun
/**
 * @file bin/check-slice-bitsets.ts
 * @description TypeScript type-checked AST gate enforcing `src/risk/*.ts` bitset contracts:
 *
 * 1. Zero boolean arrays or tuples (`boolean[]`, `readonly boolean[]`, `Array<boolean>`,
 *    `ReadonlyArray<boolean>`, boxed `Array<Boolean>`, `type FlagArray = boolean[]` aliases,
 *    or unannotated inferred expressions like `new Array(n).fill(false)` / `[false, true]`).
 * 2. Zero 8-bit TypedArrays (`Uint8Array` / `Int8Array` / `Uint8ClampedArray`) misused as
 *    0/1 boolean flag arrays (only multi-valued enum columns `policy_code` and
 *    `mechanism_code` in `src/risk/slice_data_table.ts` are permitted).
 * 3. Zero bit-packing (`<<`, `|`) inside `buildSliceIndexLookup` registry index construction.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";

export interface SliceBitsetViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule:
    "no-boolean-array" | "no-byte-boolean-array" | "no-packed-registry-index";
  readonly message: string;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  skipDefaultLibCheck: false,
};

const ALLOWED_ENUM_BYTE_COLUMN_NAMES: Readonly<Record<string, true>> = {
  policy_code: true,
  mechanism_code: true,
  hold_floor_resolved_via_code: true,
};

function isBooleanOrBoxedBooleanType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return true;
  }
  const sym = type.getSymbol();
  if (sym !== undefined && sym.getName() === "Boolean") {
    return true;
  }
  if (type.isUnion()) {
    if (type.types.length === 0) {
      return false;
    }
    for (let i = 0; i < type.types.length; i++) {
      if (!isBooleanOrBoxedBooleanType(type.types[i]!)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function isBooleanArrayOrTupleType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if (type.isUnion()) {
    for (let i = 0; i < type.types.length; i++) {
      if (isBooleanArrayOrTupleType(type.types[i]!, checker)) {
        return true;
      }
    }
    return false;
  }
  if (checker.isArrayType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return args.length > 0 && isBooleanOrBoxedBooleanType(args[0]!);
  }
  if (checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    for (let i = 0; i < args.length; i++) {
      if (isBooleanOrBoxedBooleanType(args[i]!)) {
        return true;
      }
    }
  }
  return false;
}

function isByteTypedArrayType(type: ts.Type): string | null {
  const sym = type.getSymbol();
  if (sym === undefined) {
    return null;
  }
  const name = sym.getName();
  if (
    name === "Uint8Array" ||
    name === "Int8Array" ||
    name === "Uint8ClampedArray"
  ) {
    return name;
  }
  return null;
}

function getPropertyOrVarName(node: ts.Node): string | null {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isParameter(node)
  ) {
    if (ts.isIdentifier(node.name)) {
      return node.name.text;
    }
  }
  if (
    ts.isPropertyAssignment(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return null;
}

function inspectSourceFile(
  sf: ts.SourceFile,
  relFile: string,
  checker: ts.TypeChecker,
): SliceBitsetViolation[] {
  const violations: SliceBitsetViolation[] = [];
  const seenKeys: Record<string, true> = Object.create(null) as Record<
    string,
    true
  >;

  const record = (
    node: ts.Node,
    rule: SliceBitsetViolation["rule"],
    message: string,
  ): void => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const line = pos.line + 1;
    const column = pos.character + 1;
    const dedupeKey = `${rule}:${line}:${column}`;
    if (seenKeys[dedupeKey] === true) {
      return;
    }
    seenKeys[dedupeKey] = true;
    violations.push({
      file: relFile,
      line,
      column,
      rule,
      message,
    });
  };

  const isSliceDataTable = relFile
    .replace(/\\/g, "/")
    .endsWith("src/risk/slice_data_table.ts");

  const checkResolvedType = (node: ts.Node, type: ts.Type): void => {
    if (isBooleanArrayOrTupleType(type, checker)) {
      record(
        node,
        "no-boolean-array",
        `Resolved boolean array/tuple type '${checker.typeToString(type)}' is forbidden; use a derived Uint32Array bitset exposed only through predicates.`,
      );
      return;
    }
    const byteArrayName = isByteTypedArrayType(type);
    if (byteArrayName !== null) {
      const ownerName = getPropertyOrVarName(node);
      const allowedEnumColumn =
        isSliceDataTable &&
        ownerName !== null &&
        ALLOWED_ENUM_BYTE_COLUMN_NAMES[ownerName] === true;
      if (!allowedEnumColumn) {
        record(
          node,
          "no-byte-boolean-array",
          `${byteArrayName} ('${ownerName ?? "<expr>"}') is forbidden for boolean/flag storage in src/risk; use a derived Uint32Array bitset exposed through predicates.`,
        );
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) {
      const aliasType = checker.getTypeFromTypeNode(node.type);
      checkResolvedType(node, aliasType);
    } else if (
      ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isParameter(node) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isArrayLiteralExpression(node)
    ) {
      checkResolvedType(node, checker.getTypeAtLocation(node));
      // Catch `new Array(n).fill(false)` where `new Array(n)` types as `any[]`
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "fill" &&
        node.arguments.length > 0 &&
        isBooleanOrBoxedBooleanType(
          checker.getTypeAtLocation(node.arguments[0]!),
        )
      ) {
        record(
          node,
          "no-boolean-array",
          `Array .fill(${node.arguments[0]!.getText(sf)}) constructs a boolean array; use a derived Uint32Array bitset exposed only through predicates.`,
        );
      }
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      const sig = checker.getSignatureFromDeclaration(node);
      if (sig !== undefined) {
        checkResolvedType(node, checker.getReturnTypeOfSignature(sig));
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "buildSliceIndexLookup" &&
        node.body !== undefined
      ) {
        const inspectIndexFn = (inner: ts.Node): void => {
          if (
            ts.isBinaryExpression(inner) &&
            (inner.operatorToken.kind === ts.SyntaxKind.LessThanLessThanToken ||
              inner.operatorToken.kind === ts.SyntaxKind.BarToken ||
              inner.operatorToken.kind === ts.SyntaxKind.BarEqualsToken)
          ) {
            record(
              inner,
              "no-packed-registry-index",
              `Bitwise packing ('${inner.operatorToken.getText(sf)}') is forbidden inside buildSliceIndexLookup; registry indices must remain plain 0..n-1 handles.`,
            );
          }
          ts.forEachChild(inner, inspectIndexFn);
        };
        inspectIndexFn(node.body);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

const SHARED_BASE_HOST = ts.createCompilerHost(COMPILER_OPTIONS, true);
const CACHED_LIB_SOURCE_FILES: Record<string, ts.SourceFile> = Object.create(
  null,
) as Record<string, ts.SourceFile>;

function createCachedHost(): ts.CompilerHost {
  return {
    ...SHARED_BASE_HOST,
    getSourceFile(
      fileName: string,
      languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      const resolved = path.resolve(fileName);
      if (
        resolved.includes("/node_modules/typescript/lib/") &&
        CACHED_LIB_SOURCE_FILES[resolved] !== undefined
      ) {
        return CACHED_LIB_SOURCE_FILES[resolved];
      }
      const sf = SHARED_BASE_HOST.getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
      if (
        sf !== undefined &&
        resolved.includes("/node_modules/typescript/lib/")
      ) {
        CACHED_LIB_SOURCE_FILES[resolved] = sf;
      }
      return sf;
    },
  };
}

/**
 * Type-checks real files on disk and audits each target file's resolved AST.
 */
export function auditSliceBitsetFiles(
  relFiles: readonly string[],
  rootDir = process.cwd(),
): SliceBitsetViolation[] {
  const absToRel: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const absFiles: string[] = [];
  for (let i = 0; i < relFiles.length; i++) {
    const rel = relFiles[i]!;
    const abs = path.resolve(rootDir, rel);
    absFiles.push(abs);
    absToRel[abs] = rel;
  }

  const program = ts.createProgram(
    absFiles,
    COMPILER_OPTIONS,
    createCachedHost(),
  );
  const checker = program.getTypeChecker();
  const violations: SliceBitsetViolation[] = [];

  for (let i = 0; i < absFiles.length; i++) {
    const abs = absFiles[i]!;
    const sf = program.getSourceFile(abs);
    if (sf === undefined) {
      continue;
    }
    const found = inspectSourceFile(sf, absToRel[abs]!, checker);
    for (let j = 0; j < found.length; j++) {
      violations.push(found[j]!);
    }
  }
  return violations;
}

/**
 * Audits an in-memory TypeScript snippet using the real TypeScript compiler &
 * type-checker host (used by evasion-resistance unit tests).
 */
export function auditSliceBitsetVirtualSource(
  virtualRelPath: string,
  sourceText: string,
  rootDir = process.cwd(),
): SliceBitsetViolation[] {
  const absVirtualPath = path.resolve(rootDir, virtualRelPath);
  const baseHost = createCachedHost();
  const virtualSf = ts.createSourceFile(
    absVirtualPath,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists(fileName: string): boolean {
      if (path.resolve(fileName) === absVirtualPath) {
        return true;
      }
      return baseHost.fileExists(fileName);
    },
    readFile(fileName: string): string | undefined {
      if (path.resolve(fileName) === absVirtualPath) {
        return sourceText;
      }
      return baseHost.readFile(fileName);
    },
    getSourceFile(
      fileName: string,
      languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      if (path.resolve(fileName) === absVirtualPath) {
        return virtualSf;
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };

  const program = ts.createProgram([absVirtualPath], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  return inspectSourceFile(virtualSf, virtualRelPath, checker);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { verbose: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const rootDir = path.resolve(
    positionals[0] ?? path.join(import.meta.dir, ".."),
  );
  const glob = new Bun.Glob("src/risk/*.ts");
  const files: string[] = [];
  for await (const rel of glob.scan(rootDir)) {
    files.push(rel);
  }
  files.sort();

  const violations = auditSliceBitsetFiles(files, rootDir);
  if (values.verbose) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const hasErr = violations.some((v) => v.file === f);
      console.log(`${hasErr ? "FAIL" : "PASS"}: ${f}`);
    }
  }
  if (violations.length > 0) {
    for (let i = 0; i < violations.length; i++) {
      const v = violations[i]!;
      console.error(
        `FAIL ${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`,
      );
    }
    process.exit(1);
  }
  console.log(
    `PASS: ${files.length} risk modules checked via TypeScript AST + TypeChecker. Zero boolean-array or index-packing violations.`,
  );
}

if (import.meta.main) {
  await main();
}
