/**
 * Symbol-granular import allowlist for profile insecure-host tooling (TypeScript AST).
 *
 * **Primary control:** env-gated `createProfileQueryHostRunner()`.
 * **This pass is secondary:** legibility + accidental wiring prevention (not a security boundary).
 *
 * Covers: `ImportDeclaration`, `ExportDeclaration` (incl. `export * from`), static
 * `import("…profile_code_mode_host…")`, and imports of `tests/helpers/attachProfileHostTools.ts`.
 * `import type { … }` skips type-only clauses. Unparseable files fail the run (`kind=parse-error`).
 *
 * Deprecation coupling: gated symbols include deprecated aliases removed on **2026-06-01**
 * (sportsdesk-ops **v0.2.0**). Owner: https://github.com/bw496915-cmyk/Sports-desk-ops/issues/227
 * `assertGatedSymbolsExist` hard-fails stale allowlist entries.
 *
 * Re-export of the factory from an allowed file (e.g. `code_mode_profile.ts`) is permitted: it remains
 * env-gated at runtime. Re-export of registrars is never allowed outside the helper module.
 */
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export const PROFILE_CODE_MODE_ALIAS_REMOVAL = "2026-06-01";

const HOST_MODULE_PATTERN = /(^|\/)profile_code_mode_host(\.ts)?$/;
const ATTACH_HELPER_PATTERN = /(^|\/)attachProfileHostTools(\.ts)?$/;

export const ATTACH_PROFILE_HOST_TOOLS_HELPER =
  "tests/helpers/attachProfileHostTools.ts";

export const REGISTRAR_SYMBOLS = [
  "registerProfileCodeModeHostTools",
  "registerProfileQueryCodeModeTools",
] as const;

export const FACTORY_SYMBOLS = ["createProfileQueryHostRunner"] as const;

const ATTACH_HELPER_SYMBOL = "attachProfileHostTools";

const GATED = new Set<string>([...REGISTRAR_SYMBOLS, ...FACTORY_SYMBOLS]);

const REGISTRAR_IMPORT_ALLOW = new Set([ATTACH_PROFILE_HOST_TOOLS_HELPER]);

const FACTORY_IMPORT_ALLOW = new Set([
  "lib/code_mode_profile.ts",
  "cli/code_mode_cli.ts",
  "lib/profile_code_mode_host.test.ts",
]);

/** Allowed to re-export factory symbols from profile_code_mode_host (still env-gated at call). */
const FACTORY_REEXPORT_ALLOW = new Set(FACTORY_IMPORT_ALLOW);

const DEFINITION_FILE = "lib/profile_code_mode_host.ts";

/**
 * Path segments — any file under these dirs is skipped (not string-substring noise).
 *
 * `Scratch/` and `scratch/` are gitignored local experiments; `.agents/` and `.worktrees/` are local
 * worktree checkouts. Each can carry a full copy of `lib/` at a path the symbol allowlist does not
 * recognize: on 2026-11-17 a stale `Scratch/wt-pm-state-fix` copy produced 8 false violations and
 * made the gate scan >1 GB of tooling. Dot-directories are already skipped by the glob, but the
 * explicit entries keep the rule true if the scan ever enables dot files.
 */
const SKIP_PATH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".cache",
  "coverage",
  ".stryker-tmp",
  ".materialized",
  "Scratch",
  "scratch",
  ".agents",
  ".worktrees",
]);

/** Exact directory prefixes (relative to repo root) excluded from production scans. */
const SKIP_EXACT_DIRS = [
  "tests/fixtures/profile_code_mode_host_allowlist",
] as const;

const SKIP_EXACT_FILES = new Set([
  "scripts/ci/check_profile_code_mode_host_allowlist.ts",
  "scripts/ci/profile_code_mode_host_allowlist.ts",
  "scripts/ci/profile_code_mode_host_allowlist.test.ts",
]);

export type ViolationKind =
  | "registrar-import"
  | "factory-import"
  | "re-export"
  | "helper-import"
  | "dynamic-import"
  | "default-import"
  | "allowlist-stale"
  | "parse-error";

export type AllowlistResult = {
  readonly violations: string[];
  readonly scanned: number;
};

export type AllowlistOptions = {
  readonly root?: string;
  readonly onlyRoots?: readonly string[];
  readonly extraSkipSegments?: readonly string[];
};

function normRel(root: string, abs: string): string {
  return relative(root, abs).replaceAll("\\", "/");
}

function isProfileHostSpecifier(specifier: string): boolean {
  const cleaned = specifier.split("?")[0] ?? specifier;
  return HOST_MODULE_PATTERN.test(cleaned.replace(/^\.\//, ""));
}

function isAttachHelperSpecifier(specifier: string): boolean {
  const cleaned = specifier.split("?")[0] ?? specifier;
  return ATTACH_HELPER_PATTERN.test(cleaned.replace(/^\.\//, ""));
}

function pathHasSkippedSegment(
  rel: string,
  extraSegments: readonly string[],
): boolean {
  const segments = rel.split("/");
  const all = new Set([...SKIP_PATH_SEGMENTS, ...extraSegments]);
  return segments.some((seg) => all.has(seg));
}

function isUnderExactDir(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(`${dir}/`);
}

function isSkippedPath(
  rel: string,
  extraSegments: readonly string[],
  fixtureScan: boolean,
): boolean {
  if (rel === DEFINITION_FILE) return true;
  if (pathHasSkippedSegment(rel, extraSegments)) return true;
  if (SKIP_EXACT_FILES.has(rel)) return true;
  if (!fixtureScan) {
    for (const dir of SKIP_EXACT_DIRS) {
      if (isUnderExactDir(rel, dir)) return true;
    }
  }
  return false;
}

function canImportAttachHelper(rel: string): boolean {
  if (rel === ATTACH_PROFILE_HOST_TOOLS_HELPER) return true;
  return rel.endsWith(".test.ts");
}

function formatViolation(
  rel: string,
  kind: ViolationKind,
  detail: string,
): string {
  return `${rel}: [kind=${kind}] ${detail}`;
}

function parseSourceFileOrFail(
  rel: string,
  abs: string,
  text: string,
  violations: string[],
): ts.SourceFile | null {
  const source = ts.createSourceFile(
    abs,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0];
    if (first) {
      const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
      violations.push(
        formatViolation(
          rel,
          "parse-error",
          `TypeScript parse failed: ${message}`,
        ),
      );
    }
    return null;
  }
  return source;
}

function importClauseGatedSymbols(
  clause: ts.ImportClause | undefined,
): string[] {
  if (!clause || clause.isTypeOnly) return [];
  const out: string[] = [];
  const bindings = clause.namedBindings;
  if (!bindings) return out;
  if (ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue;
      const name = (el.propertyName ?? el.name).text;
      if (GATED.has(name) || name === ATTACH_HELPER_SYMBOL) out.push(name);
    }
  }
  return out;
}

function exportDeclarationGatedSymbols(decl: ts.ExportDeclaration): string[] {
  if (!decl.moduleSpecifier || !ts.isStringLiteral(decl.moduleSpecifier))
    return [];
  if (!isProfileHostSpecifier(decl.moduleSpecifier.text)) return [];
  if (decl.exportClause === undefined) {
    return ["*"];
  }
  if (ts.isNamedExports(decl.exportClause)) {
    const out: string[] = [];
    for (const el of decl.exportClause.elements) {
      const exported = (el.propertyName ?? el.name).text;
      if (GATED.has(exported)) out.push(exported);
    }
    return out;
  }
  return [];
}

function checkRegistrar(
  rel: string,
  symbols: string[],
  fromExport: boolean,
): string[] {
  const violations: string[] = [];
  for (const sym of symbols) {
    if (sym === ATTACH_HELPER_SYMBOL) continue;
    if (sym === "*") {
      violations.push(
        formatViolation(
          rel,
          "re-export",
          "must not re-export profile_code_mode_host",
        ),
      );
      continue;
    }
    if (!REGISTRAR_SYMBOLS.includes(sym as (typeof REGISTRAR_SYMBOLS)[number]))
      continue;
    if (!REGISTRAR_IMPORT_ALLOW.has(rel)) {
      violations.push(
        formatViolation(
          rel,
          fromExport ? "re-export" : "registrar-import",
          `must not import ${sym} (use tests/helpers/attachProfileHostTools.ts from *.test.ts only)`,
        ),
      );
    }
  }
  return violations;
}

function checkFactory(
  rel: string,
  symbols: string[],
  fromExport: boolean,
): string[] {
  const violations: string[] = [];
  for (const sym of symbols) {
    if (sym === ATTACH_HELPER_SYMBOL) continue;
    if (sym === "*") {
      violations.push(
        formatViolation(
          rel,
          "re-export",
          "must not re-export profile_code_mode_host",
        ),
      );
      continue;
    }
    if (!FACTORY_SYMBOLS.includes(sym as (typeof FACTORY_SYMBOLS)[number]))
      continue;
    const allow = fromExport ? FACTORY_REEXPORT_ALLOW : FACTORY_IMPORT_ALLOW;
    if (!allow.has(rel)) {
      violations.push(
        formatViolation(
          rel,
          fromExport ? "re-export" : "factory-import",
          `must not import ${sym}`,
        ),
      );
    }
  }
  return violations;
}

function checkAttachHelper(
  rel: string,
  specifier: string,
  symbols: string[],
  defaultImport: boolean,
): string[] {
  if (!isAttachHelperSpecifier(specifier)) return [];
  const importsHelper = defaultImport || symbols.includes(ATTACH_HELPER_SYMBOL);
  if (!importsHelper) return [];
  if (!canImportAttachHelper(rel)) {
    return [
      formatViolation(
        rel,
        "helper-import",
        "attachProfileHostTools may only be imported from *.test.ts files",
      ),
    ];
  }
  return [];
}

function visitFile(
  rel: string,
  source: ts.SourceFile,
  violations: string[],
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      const gated = importClauseGatedSymbols(node.importClause);
      if (isProfileHostSpecifier(spec)) {
        violations.push(
          ...checkRegistrar(rel, gated, false),
          ...checkFactory(rel, gated, false),
        );
        const hasValueNamespace = node.importClause?.name !== undefined;
        if (hasValueNamespace) {
          violations.push(
            formatViolation(
              rel,
              "default-import",
              "must not default-import profile_code_mode_host",
            ),
          );
        }
      }
      violations.push(
        ...checkAttachHelper(
          rel,
          spec,
          gated,
          node.importClause?.name !== undefined,
        ),
      );
    }
    if (ts.isExportDeclaration(node)) {
      const gated = exportDeclarationGatedSymbols(node);
      if (gated.length > 0) {
        violations.push(
          ...checkRegistrar(rel, gated, true),
          ...checkFactory(rel, gated, true),
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      if (isProfileHostSpecifier(node.arguments[0].text)) {
        violations.push(
          formatViolation(
            rel,
            "dynamic-import",
            "static import() of profile_code_mode_host is not allowlisted (computed specifiers are undetectable; factory env gate is primary)",
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export function findMissingExports(
  sourceText: string,
  symbols: readonly string[],
): string[] {
  const missing: string[] = [];
  for (const sym of symbols) {
    const reFn = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${sym}\\b`);
    const reConst = new RegExp(`\\bexport\\s+const\\s+${sym}\\b`);
    if (!reFn.test(sourceText) && !reConst.test(sourceText)) missing.push(sym);
  }
  return missing;
}

export function assertGatedSymbolsExist(root: string): string[] {
  const text = readFileSync(join(root, DEFINITION_FILE), "utf8");
  return findMissingExports(text, [...GATED]);
}

export async function checkProfileCodeModeHostAllowlist(
  options: AllowlistOptions = {},
): Promise<AllowlistResult> {
  const root = options.root ?? join(import.meta.dir, "../..");
  const violations: string[] = [];

  const missing = assertGatedSymbolsExist(root);
  if (missing.length > 0) {
    violations.push(
      formatViolation(
        DEFINITION_FILE,
        "allowlist-stale",
        `missing exports [${missing.join(", ")}] — update allowlist on alias removal (${PROFILE_CODE_MODE_ALIAS_REMOVAL})`,
      ),
    );
  }

  const fixtureScan = options.onlyRoots !== undefined;
  const scanRoots = options.onlyRoots?.map((r) => resolve(root, r)) ?? [root];
  let scanned = 0;

  const tsGlob = new Bun.Glob("**/*.ts");
  for (const scanRoot of scanRoots) {
    for await (const rel of tsGlob.scan({
      cwd: fixtureScan ? scanRoot : root,
      onlyFiles: true,
      dot: false,
    })) {
      const abs = join(fixtureScan ? scanRoot : root, rel);
      const fileRel = normRel(root, abs).replaceAll("\\", "/");
      if (
        isSkippedPath(fileRel, options.extraSkipSegments ?? [], fixtureScan)
      ) {
        continue;
      }

      scanned += 1;
      const text = readFileSync(abs, "utf8");
      const source = parseSourceFileOrFail(fileRel, abs, text, violations);
      if (source) visitFile(fileRel, source, violations);
    }
  }

  return { violations: [...new Set(violations)], scanned };
}

export function violationsForFile(
  violations: string[],
  fixtureBasename: string,
  kind: ViolationKind,
): string[] {
  return violations.filter(
    (v) => v.includes(fixtureBasename) && v.includes(`[kind=${kind}]`),
  );
}
