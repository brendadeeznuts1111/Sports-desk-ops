/**
 * @file bun_shapes.ts
 * @description The Bun shapes this repository actually calls, and the evidence that
 * keeps each one's contract honest.
 *
 * Single source of truth, by layer: names and signatures come from `bun-types@1.4.4`
 * (the declarations the bun.com/reference site renders), behaviour comes from probes
 * against the local 1.4.4 binary (`tests/bun_baseline.json`), and property attributes
 * come from the pinned Bun commit. This module quotes no upstream text — it points at
 * the sources so there is only ever one copy to drift.
 *
 * The table itself is generated: `scripts/bun_shapes_catalog.ts` derives membership
 * from the tracked-source usage scan, `kind`/`heading` from the declarations, and
 * takes subsystem + evidence from `lib/bun_shapes_overlay.ts`. `analyzeBunShapes`
 * is pure and the coverage test feeds it the real repository, so adding a `Bun.*`
 * call makes the generated file stale until it is regenerated and the overlay gains
 * a row.
 */

import * as ts from "typescript";
import { listSourceFiles } from "./source_files.ts";

/** The exact upstream artifacts this table is written against. */
export const BUN_SHAPE_PINS = {
  bunVersion: "1.4.4",
  bunCommit: "38afee6c84fcf48c0edb2466aa4b27d287a59c30",
  typesVersion: "1.4.4",
} as const;

export const SHAPE_SUBSYSTEMS = [
  "process",
  "text",
  "data",
  "storage",
  "crypto",
  "network",
  "image",
  "meta",
] as const;

export type ShapeSubsystem = (typeof SHAPE_SUBSYSTEMS)[number];

/** Catalog `##` section title each subsystem's shapes must appear under. */
export const SHAPE_SECTIONS: Readonly<Record<ShapeSubsystem, string>> = {
  process: "Process, filesystem and shell",
  text: "Text and terminal rendering",
  data: "Data formats and parsing",
  storage: "Storage and scheduling",
  crypto: "Crypto, hashing and compression",
  network: "Network and serving",
  image: "Image and WebView",
  meta: "Runtime metadata and environment",
};

/**
 * `value` — a runtime property of `Bun`; `type` — declared in bun-types but not a
 * runtime value (`typeof Bun.X === "undefined"`), so it may only be used in type
 * positions.
 */
export type ShapeKind = "value" | "type";

export interface BunShape {
  /** Dotless member name, e.g. `mmap` or `$` — the name used in `Bun.<name>`. */
  readonly name: string;
  readonly kind: ShapeKind;
  readonly subsystem: ShapeSubsystem;
  /** Exact `####` heading text in docs/runbooks/bun_shape_contracts_runbook.md. */
  readonly heading: string;
  /**
   * `declared-only`: part of the declared surface we have not called yet, kept in
   * the catalog on purpose. It must NOT appear in source usage, and the gate flips
   * the entry to a normal one the moment it does.
   */
  readonly status?: "declared-only";
  /** `probe:<id>` | `test:<path>` | `surface:<check-name>`. */
  readonly evidence: readonly string[];
}

/**
 * Shapes the binary exposes that `bun-types` does not declare. Empty today: `bun-types@1.4.4`
 * declares every shape in `BUN_SHAPES` (including `CSRF`, `isStandaloneExecutable`, and
 * `sliceAnsi`). An entry here must name the source anchor that justifies it, or
 * `analyzeBunShapes` reports `runtime-only-without-source`; once `bun-types` adds a
 * declaration, `analyzeBunShapes` reports `stale-runtime-only` so stale claims cannot linger.
 */
export const RUNTIME_ONLY_SHAPES: ReadonlyMap<string, string> = new Map();

export interface BunSubmoduleSymbol {
  readonly module: `bun:${string}`;
  readonly name: string;
  /**
   * `value` — runtime property of `await import(module)`;
   * `macro` — bundler-transformed intrinsic (e.g. `feature` from `bun:bundle`) that
   * throws or cannot be evaluated outside a transpiled condition.
   */
  readonly kind: "value" | "macro";
  readonly evidence: readonly string[];
}

/**
 * Built-in `bun:*` submodule symbols imported by non-test source files (`bun:sqlite`,
 * `bun:jsc`, `bun:bundle`). Tracked alongside `BUN_SHAPES` so no `bun:*` surface goes dark.
 */
/**
 * Derived: every `bun:*` symbol the tracked sources import, with the surface
 * probe or test that covers it. The only hand-written part is which symbols are
 * bundler macros rather than runtime values (`MACRO_SUBMODULE_SYMBOLS` in the
 * generator).
 */
export { BUN_SUBMODULE_SHAPES } from "./bun_shapes.generated.ts";

/**
 * Shapes whose members depend on the caller, so they are not snapshotted: the
 * environment, the argv vector and the stdio streams.
 */
export const VOLATILE_SHAPES: ReadonlySet<string> = new Set([
  "env",
  "argv",
  "stdin",
  "stdout",
]);

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
  // The legacy accessors are Object.prototype members too. A chain that ends in another realm's
  // Object.prototype is not stopped by the identity check below, and reported them as "added"
  // on Bun.s3 (CI, 2026-11-04).
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Own names plus the prototype chain, minus function internals. The same walk
 * `bin/bun_types.ts` uses for declaration drift, so a member list means the same
 * thing in both places.
 */
export function surfaceMembers(value: unknown): string[] {
  const names = new Set<string>();
  let current: unknown = value;
  while (
    current !== null &&
    current !== Object.prototype &&
    current !== Function.prototype &&
    current !== Array.prototype
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (!FUNCTION_INTERNALS.has(name)) names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names].sort();
}

/**
 * Derived, not hand-written: membership from the tracked-source usage scan,
 * `kind`/`heading` from bun-types declarations, subsystem and evidence from
 * `lib/bun_shapes_overlay.ts`. Regenerate with
 * `bun scripts/bun_shapes_catalog.ts --write`.
 */
export { BUN_SHAPES } from "./bun_shapes.generated.ts";

/** `#### Title` lines, in file order. */
export function catalogHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => /^####\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((heading): heading is string => heading !== undefined);
}

export interface ShapeUsage {
  /** Shape name → files that reference it in a value or type position. */
  readonly used: Map<string, Set<string>>;
  /** `Bun[` accesses, which this scanner cannot resolve and which must fail the gate. */
  readonly elementAccess: string[];
  /** Built-in `bun:*` submodule symbol (`"bun:sqlite/Database"`) → files that import it. */
  readonly submodules?: ReadonlyMap<string, Set<string>>;
}

const SCANNED_EXTENSIONS = ["ts", "tsx", "mts", "mjs", "js"] as const;

export function isBunShapeScannedPath(file: string): boolean {
  return (
    !file.includes(".test.") &&
    !file.startsWith("tests/") &&
    !file.startsWith("verification/") &&
    !file.startsWith("examples/") &&
    !file.startsWith("scratch/") &&
    !file.startsWith("Scratch/") &&
    !file.startsWith("packages/sportsdesk-ops/bin/") &&
    !file.startsWith("scripts/build") &&
    !file.startsWith("scripts/dev_dashboard")
  );
}

/**
 * Single shared production file list for `scripts/bun_shape_contracts.ts` and
 * `tests/bun_shapes_coverage.test.ts` so the catalog generator and the CI gate
 * always inspect the exact same tracked source files (including `.tsx` and `.mts`).
 */
export async function listBunShapeScannedFiles(
  root: string,
): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", root, "ls-files", "-z", "--cached"], {
    stdout: "pipe",
    stderr: "ignore",
    env: {
      ...Bun.env,
      GIT_CONFIG_GLOBAL: Bun.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [trackedText, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.exited,
  ]);
  const trackedSet =
    exitCode === 0
      ? new Set(trackedText.split("\0").filter((f) => f !== ""))
      : null;

  const all = await listSourceFiles(root, SCANNED_EXTENSIONS);
  return all.filter(
    (file) =>
      (trackedSet === null || trackedSet.has(file)) &&
      isBunShapeScannedPath(file),
  );
}

function scriptKindForFile(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function isBunNamespaceExpression(
  expr: ts.Expression,
  bunNamespaces: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expr) && bunNamespaces.has(expr.text)) return true;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "globalThis" &&
    expr.name.text === "Bun"
  ) {
    return true;
  }
  return false;
}

function isBunEntityPrefix(
  entity: ts.EntityName,
  bunNamespaces: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(entity) && bunNamespaces.has(entity.text)) return true;
  if (
    ts.isQualifiedName(entity) &&
    ts.isIdentifier(entity.left) &&
    entity.left.text === "globalThis" &&
    entity.right.text === "Bun"
  ) {
    return true;
  }
  return false;
}

function leftmostIdentifier(entity: ts.EntityName): string {
  let cur: ts.EntityName = entity;
  while (ts.isQualifiedName(cur)) cur = cur.left;
  return cur.text;
}

/**
 * Parse a single TypeScript/JavaScript source file and return per-shape hit counts,
 * `bun:*` built-in submodule symbol hits, and any dynamic element accesses (`Bun[...]`
 * or `bunNs[...]`).
 *
 * Tracks both `globalThis.Bun` (`Bun.<name>`, `globalThis.Bun.<name>`, `const { x } = Bun`)
 * and the `"bun"` module surface (`import { x, type T } from "bun"`, `import * as bunNs from "bun"`,
 * `export { x } from "bun"`, `import("bun").<Member>`), plus built-in `bun:*` submodules
 * (`bun:sqlite`, `bun:jsc`, `bun:bundle`, `bun:ffi`, excluding `bun:test`).
 * Comments and string literals are ignored by construction.
 */
export function scanBunShapeSource(
  file: string,
  text: string,
): {
  readonly hits: Map<string, number>;
  readonly submodules: Map<string, number>;
  readonly elementAccess: string[];
} {
  const hits = new Map<string, number>();
  const submodules = new Map<string, number>();
  const elementAccess: string[] = [];
  const bump = (name: string): void => {
    if (name === "default" || name === "__esModule") return;
    hits.set(name, (hits.get(name) ?? 0) + 1);
  };
  const bumpSubmodule = (mod: string, name: string): void => {
    if (mod === "bun:test" || name === "default" || name === "__esModule") {
      return;
    }
    const key = `${mod}/${name}`;
    submodules.set(key, (submodules.get(key) ?? 0) + 1);
  };

  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForFile(file),
  );

  const bunNamespaces = new Set<string>(["Bun"]);
  const submoduleNamespaces = new Map<string, string>();

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (spec === "bun" && clause) {
        if (clause.name) bunNamespaces.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings) {
          if (ts.isNamespaceImport(bindings)) {
            bunNamespaces.add(bindings.name.text);
          } else if (ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              bump((el.propertyName ?? el.name).text);
            }
          }
        }
      } else if (spec.startsWith("bun:") && spec !== "bun:test" && clause) {
        if (clause.name) submoduleNamespaces.set(clause.name.text, spec);
        const bindings = clause.namedBindings;
        if (bindings) {
          if (ts.isNamespaceImport(bindings)) {
            submoduleNamespaces.set(bindings.name.text, spec);
          } else if (ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              bumpSubmodule(spec, (el.propertyName ?? el.name).text);
            }
          }
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (spec === "bun") {
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            bump((el.propertyName ?? el.name).text);
          }
        } else if (!stmt.exportClause) {
          elementAccess.push(`${file}: ${stmt.getText(sf).slice(0, 60)}`);
        }
      } else if (spec.startsWith("bun:") && spec !== "bun:test") {
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            bumpSubmodule(spec, (el.propertyName ?? el.name).text);
          }
        } else if (!stmt.exportClause) {
          elementAccess.push(`${file}: ${stmt.getText(sf).slice(0, 60)}`);
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (isBunNamespaceExpression(node.expression, bunNamespaces)) {
        bump(node.name.text);
      } else if (ts.isIdentifier(node.expression)) {
        const submod = submoduleNamespaces.get(node.expression.text);
        if (submod !== undefined) bumpSubmodule(submod, node.name.text);
      }
    } else if (ts.isQualifiedName(node)) {
      if (isBunEntityPrefix(node.left, bunNamespaces)) {
        bump(node.right.text);
      } else if (ts.isIdentifier(node.left)) {
        const submod = submoduleNamespaces.get(node.left.text);
        if (submod !== undefined) bumpSubmodule(submod, node.right.text);
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (
        isBunNamespaceExpression(node.expression, bunNamespaces) ||
        (ts.isIdentifier(node.expression) &&
          submoduleNamespaces.has(node.expression.text))
      ) {
        elementAccess.push(`${file}: ${node.getText(sf).slice(0, 60)}`);
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      if (isBunNamespaceExpression(node.initializer, bunNamespaces)) {
        for (const el of node.name.elements) {
          if (el.dotDotDotToken) {
            elementAccess.push(`${file}: ${node.getText(sf).slice(0, 60)}`);
          } else if (el.propertyName && ts.isIdentifier(el.propertyName)) {
            bump(el.propertyName.text);
          } else if (!el.propertyName && ts.isIdentifier(el.name)) {
            bump(el.name.text);
          } else {
            elementAccess.push(`${file}: ${node.getText(sf).slice(0, 60)}`);
          }
        }
      } else if (ts.isIdentifier(node.initializer)) {
        const submod = submoduleNamespaces.get(node.initializer.text);
        if (submod !== undefined) {
          for (const el of node.name.elements) {
            if (el.dotDotDotToken) {
              elementAccess.push(`${file}: ${node.getText(sf).slice(0, 60)}`);
            } else if (el.propertyName && ts.isIdentifier(el.propertyName)) {
              bumpSubmodule(submod, el.propertyName.text);
            } else if (!el.propertyName && ts.isIdentifier(el.name)) {
              bumpSubmodule(submod, el.name.text);
            } else {
              elementAccess.push(`${file}: ${node.getText(sf).slice(0, 60)}`);
            }
          }
        }
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      node.qualifier !== undefined
    ) {
      const spec = node.argument.literal.text;
      const member = leftmostIdentifier(node.qualifier);
      if (spec === "bun") {
        bump(member);
      } else if (spec.startsWith("bun:") && spec !== "bun:test") {
        bumpSubmodule(spec, member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { hits, submodules, elementAccess };
}

/**
 * Parse each source and collect `Bun.<name>` / `import { <name> } from "bun"` value and
 * type positions plus `bun:*` built-in submodule imports. Comments and string literals
 * are ignored by construction.
 */
export function collectBunShapeUsage(
  sources: ReadonlyMap<string, string>,
): ShapeUsage {
  const used = new Map<string, Set<string>>();
  const submodules = new Map<string, Set<string>>();
  const elementAccess: string[] = [];
  for (const [file, text] of sources) {
    const scanned = scanBunShapeSource(file, text);
    for (const name of scanned.hits.keys()) {
      const set = used.get(name) ?? new Set<string>();
      set.add(file);
      used.set(name, set);
    }
    for (const subKey of scanned.submodules.keys()) {
      const set = submodules.get(subKey) ?? new Set<string>();
      set.add(file);
      submodules.set(subKey, set);
    }
    elementAccess.push(...scanned.elementAccess);
  }
  return { used, submodules, elementAccess };
}

export type ShapeRule =
  | "unknown-shape"
  | "unused-shape"
  | "duplicate-shape"
  | "heading-missing"
  | "heading-duplicate"
  | "kind-mismatch"
  | "evidence-unresolved"
  | "no-evidence"
  | "undeclared-shape"
  | "runtime-only-without-source"
  | "stale-runtime-only"
  | "section-mismatch"
  | "member-drift"
  | "member-unbaselined"
  | "declared-only-in-use"
  | "element-access"
  | "unknown-submodule-symbol"
  | "unused-submodule-symbol"
  | "submodule-evidence-unresolved";

export interface ShapeProblem {
  readonly rule: ShapeRule;
  readonly detail: string;
}

export interface ShapeWorld {
  readonly usage: ShapeUsage;
  readonly shapes: readonly BunShape[];
  /** Catalog `####` headings. */
  readonly headings: readonly string[];
  /** Probe ids present in tests/bun_baseline.json. */
  readonly probes: ReadonlySet<string>;
  /** Test paths, as written in evidence refs. */
  readonly tests: ReadonlySet<string>;
  /** Check names declared in bin/bun_surface.ts. */
  readonly surfaces: ReadonlySet<string>;
  /** `typeof Bun.<name>` per manifest entry. */
  readonly runtimeTypeof: ReadonlyMap<string, string>;
  /** Member surface per shape, measured now. */
  readonly members: ReadonlyMap<string, readonly string[]>;
  /** Member surface per shape, from tests/bun_shape_members.json. */
  readonly memberBaseline: ReadonlyMap<string, readonly string[]>;
  /** Catalog section title → headings listed under it. */
  readonly sections: ReadonlyMap<string, ReadonlySet<string>>;
  /** Value members declared by bun-types@1.4.4. */
  readonly declaredValues: ReadonlySet<string>;
  /** Raw bun-types source text, used to confirm type-only declarations. */
  readonly typesSource: string;
  /** Optional compiler-derived type-only exports of module `"bun"`, superseding regex scan when supplied. */
  readonly declaredTypes?: ReadonlySet<string>;
  readonly runtimeOnly?: ReadonlyMap<string, string>;
  /** Optional `BUN_SUBMODULE_SHAPES` check when `usage.submodules` is populated. */
  readonly submoduleShapes?: readonly BunSubmoduleSymbol[];
}

const TYPE_DECLARATION =
  /(?:^|\s)(?:interface|class|type|namespace)\s+([A-Za-z_$][\w$]*)/gm;
/** `export import SpawnOptions = Spawn;` is a type-only alias, not a runtime value. */
const TYPE_ALIAS = /(?:^|\s)export\s+import\s+([A-Za-z_$][\w$]*)\s*=/gm;

function typeDeclarations(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(TYPE_DECLARATION))
    names.add(match[1] as string);
  for (const match of source.matchAll(TYPE_ALIAS))
    names.add(match[1] as string);
  return names;
}

export function analyzeBunShapes(world: ShapeWorld): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  const byName = new Map<string, BunShape>();
  const headingCount = new Map<string, number>();
  for (const heading of world.headings) {
    headingCount.set(heading, (headingCount.get(heading) ?? 0) + 1);
  }

  for (const shape of world.shapes) {
    if (byName.has(shape.name)) {
      problems.push({ rule: "duplicate-shape", detail: shape.name });
    }
    byName.set(shape.name, shape);
  }

  for (const [name, files] of world.usage.used) {
    if (!byName.has(name)) {
      problems.push({
        rule: "unknown-shape",
        detail: `${name} (${[...files].sort().join(", ")})`,
      });
    }
  }
  for (const line of world.usage.elementAccess) {
    problems.push({ rule: "element-access", detail: line });
  }

  const runtimeOnly = world.runtimeOnly ?? RUNTIME_ONLY_SHAPES;
  const declaredTypes =
    world.declaredTypes ?? typeDeclarations(world.typesSource);

  for (const shape of world.shapes) {
    const declaredOnly = shape.status === "declared-only";
    const isUsed = world.usage.used.has(shape.name);
    if (!isUsed && !declaredOnly) {
      problems.push({ rule: "unused-shape", detail: shape.name });
    }
    if (isUsed && declaredOnly) {
      problems.push({ rule: "declared-only-in-use", detail: shape.name });
    }

    const count = headingCount.get(shape.heading) ?? 0;
    if (count === 0) {
      problems.push({ rule: "heading-missing", detail: shape.heading });
    } else if (count > 1) {
      problems.push({
        rule: "heading-duplicate",
        detail: `${shape.heading} ×${count}`,
      });
    }

    const actual = world.runtimeTypeof.get(shape.name) ?? "undefined";
    const defined = actual !== "undefined";
    if (shape.kind === "value" && !defined) {
      problems.push({
        rule: "kind-mismatch",
        detail: `${shape.name}: kind=value typeof=${actual}`,
      });
    }
    if (shape.kind === "type" && defined) {
      problems.push({
        rule: "kind-mismatch",
        detail: `${shape.name}: kind=type typeof=${actual}`,
      });
    }

    const baselineMembers = world.memberBaseline.get(shape.name);
    if (baselineMembers !== undefined) {
      const now = world.members.get(shape.name);
      if (now === undefined) {
        problems.push({
          rule: "member-drift",
          detail: `${shape.name}: no member surface in the binary now`,
        });
      } else {
        const added = now.filter((m) => !baselineMembers.includes(m));
        const removed = baselineMembers.filter((m) => !now.includes(m));
        if (added.length > 0 || removed.length > 0) {
          problems.push({
            rule: "member-drift",
            detail: `${shape.name}: added [${added.join(", ")}] removed [${removed.join(", ")}]`,
          });
        }
      }
    } else if (world.members.has(shape.name)) {
      problems.push({
        rule: "member-unbaselined",
        detail: shape.name,
      });
    }

    const section = SHAPE_SECTIONS[shape.subsystem];
    const inSection = world.sections.get(section);
    if (inSection === undefined || !inSection.has(shape.heading)) {
      problems.push({
        rule: "section-mismatch",
        detail: `${shape.heading} is not under "## ${section}"`,
      });
    }

    if (shape.evidence.length === 0) {
      problems.push({ rule: "no-evidence", detail: shape.name });
    }
    const hasTest = shape.evidence.some((ref) => ref.startsWith("test:"));
    if (shape.kind === "type" && !hasTest) {
      problems.push({
        rule: "no-evidence",
        detail: `${shape.name}: a type needs a test reference`,
      });
    }
    for (const ref of shape.evidence) {
      const colon = ref.indexOf(":");
      const kind = colon >= 0 ? ref.slice(0, colon) : ref;
      const id = colon >= 0 ? ref.slice(colon + 1) : "";
      const ok =
        kind === "probe"
          ? world.probes.has(id)
          : kind === "test"
            ? world.tests.has(id)
            : kind === "surface"
              ? world.surfaces.has(id)
              : false;
      if (!ok) problems.push({ rule: "evidence-unresolved", detail: ref });
    }

    const runtimeOnlyAnchor = runtimeOnly.get(shape.name);
    if (shape.kind === "value" && !world.declaredValues.has(shape.name)) {
      if (runtimeOnlyAnchor === undefined) {
        problems.push({ rule: "undeclared-shape", detail: shape.name });
      } else if (runtimeOnlyAnchor.trim() === "") {
        problems.push({
          rule: "runtime-only-without-source",
          detail: shape.name,
        });
      }
    } else if (
      shape.kind === "value" &&
      world.declaredValues.has(shape.name) &&
      runtimeOnlyAnchor !== undefined
    ) {
      problems.push({
        rule: "stale-runtime-only",
        detail: `${shape.name} is now declared in bun-types`,
      });
    }
    if (shape.kind === "type" && !declaredTypes.has(shape.name)) {
      problems.push({
        rule: "undeclared-shape",
        detail: `${shape.name} (type)`,
      });
    }
  }

  for (const [name, anchor] of runtimeOnly) {
    if (!byName.has(name))
      problems.push({
        rule: "runtime-only-without-source",
        detail: `${name}: no manifest entry`,
      });
    if (anchor.trim() === "")
      problems.push({ rule: "runtime-only-without-source", detail: name });
  }

  if (
    world.submoduleShapes !== undefined &&
    world.usage.submodules !== undefined
  ) {
    const subByKey = new Map<string, BunSubmoduleSymbol>();
    for (const sub of world.submoduleShapes) {
      subByKey.set(`${sub.module}/${sub.name}`, sub);
    }
    for (const [key, files] of world.usage.submodules) {
      if (!subByKey.has(key)) {
        problems.push({
          rule: "unknown-submodule-symbol",
          detail: `${key} (${[...files].sort().join(", ")})`,
        });
      }
    }
    for (const [key, sub] of subByKey) {
      if (!world.usage.submodules.has(key)) {
        problems.push({
          rule: "unused-submodule-symbol",
          detail: key,
        });
      }
      for (const ref of sub.evidence) {
        const colon = ref.indexOf(":");
        const kind = colon >= 0 ? ref.slice(0, colon) : ref;
        const id = colon >= 0 ? ref.slice(colon + 1) : "";
        const ok =
          kind === "probe"
            ? world.probes.has(id)
            : kind === "test"
              ? world.tests.has(id)
              : kind === "surface"
                ? world.surfaces.has(id)
                : false;
        if (!ok) {
          problems.push({
            rule: "submodule-evidence-unresolved",
            detail: `${key} -> ${ref}`,
          });
        }
      }
    }
  }

  return problems;
}
