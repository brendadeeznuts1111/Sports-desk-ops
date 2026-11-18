/**
 * @file lib/bun_globals_map_summaries.ts
 * @description Pin-truth validation for `docs/bun-globals-map.json` summaries.
 *
 * `scripts/scrape_bun_globals_map.ts` copies each detail page's `data-algolia-summary` verbatim, so
 * the artifact inherits documentation defects from upstream. Two classes are derived here, never
 * hardcoded:
 *
 * 1. **A falsified claim.** Upstream copies an abstract base's JSDoc onto subclasses that declare
 *    none of their own, so `Bun.MD5` and friends were published as "This class only exists in
 *    types" while the pinned runtime exposes a constructor. Falsifiable against the running `Bun`.
 * 2. **A borrowed description.** The same inheritance makes `Bun.Worker` display `EventTarget`'s
 *    summary, `Bun.NetworkSink` display `FileSink`'s, and `Bun.FetchEvent` display `Event`'s. Not
 *    falsifiable from the runtime (a worker *is* constructed), but provable from `bun-types`: a
 *    declaration with no JSDoc of its own can only be quoting its base.
 *
 * The declaration source is the `bun-types` **package graph** (the reference closure of its
 * `index.d.ts`), filtered to declarations inside `declare module "bun"` and outside nested
 * `namespace` blocks — `globals.d.ts` re-declares DOM names (`Worker`, `EventSource`) that must not
 * shadow the Bun ones. Suppressed text is preserved in the artifact's metadata so every removal
 * stays auditable; a failed resolution is an error, never a silent pass.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The inherited JSDoc sentence that documents the abstract base, not the subclass. */
export const TYPE_ONLY_CLAIM = /only exists in types/i;

/** Links the base's own MDN page, e.g. `[MDN Reference](…/Web/API/Event)`. */
const MDN_REFERENCE =
  /developer\.mozilla\.org\/docs\/Web\/API\/([A-Za-z0-9_.~-]+)/g;

export interface SuppressedSummary {
  readonly symbol: string;
  readonly reason: "types-only-falsified" | "inherited-from-base";
  /** Runtime type for (1); the base declaration for (2). */
  readonly detail: string;
  readonly upstreamSummary: string;
}

interface SummaryRow {
  readonly symbol: string;
  readonly kind?: string;
  readonly summary?: string;
}

/** One `interface`/`class` declaration recovered from a `.d.ts`. */
export interface DeclarationBases {
  readonly hasOwnJsDoc: boolean;
  readonly bases: readonly string[];
}

/** The resolved declaration graph used for provenance checks. */
export interface BunTypesDeclarations {
  readonly package: string;
  readonly files: readonly string[];
  readonly relativeFiles: readonly string[];
  readonly declarations: ReadonlyMap<string, DeclarationBases>;
}

/** `globals.bun.MD5` → `MD5`; other symbol shapes are returned unchanged. */
export function runtimeNameOf(symbol: string): string {
  return symbol.startsWith("globals.bun.")
    ? symbol.slice("globals.bun.".length)
    : symbol;
}

function readRuntime(runtime: Record<string, unknown>, name: string): unknown {
  try {
    return runtime[name];
  } catch {
    return undefined;
  }
}

/** True when the summary links the base's own MDN page, i.e. it is the base's description. */
export function quotesBaseReference(summary: string, base: string): boolean {
  for (const match of summary.matchAll(MDN_REFERENCE)) {
    if (match[1] === base) return true;
  }
  return false;
}

/**
 * Rows whose types-only claim the pinned runtime contradicts. Read-only: for `--check`.
 *
 * Existence (`in`), not the read value, is what falsifies the claim: a property that exists but is
 * a throwing getter or is deliberately `undefined` is still an exposed symbol.
 */
export function findFalsifiedTypeOnlyClaims(
  rows: readonly SummaryRow[],
  runtime: Record<string, unknown> = Bun as unknown as Record<string, unknown>,
): SuppressedSummary[] {
  const claims: SuppressedSummary[] = [];
  for (const row of rows) {
    const summary = row.summary ?? "";
    if (!TYPE_ONLY_CLAIM.test(summary)) continue;
    const runtimeName = runtimeNameOf(row.symbol);
    if (runtimeName === "" || !(runtimeName in runtime)) continue;
    claims.push({
      symbol: row.symbol,
      reason: "types-only-falsified",
      detail: typeof readRuntime(runtime, runtimeName),
      upstreamSummary: summary,
    });
  }
  return claims;
}

/**
 * Clear every falsified types-only summary, leaving all other rows untouched. Idempotent: a second
 * run finds nothing once the summaries are empty.
 */
export function suppressFalsifiedTypeOnlySummaries<T extends SummaryRow>(
  rows: readonly T[],
  runtime: Record<string, unknown> = Bun as unknown as Record<string, unknown>,
): { rows: T[]; suppressed: SuppressedSummary[] } {
  const falsified = new Set(
    findFalsifiedTypeOnlyClaims(rows, runtime).map((claim) => claim.symbol),
  );
  const suppressed: SuppressedSummary[] = [];
  const patched = rows.map((row) => {
    if (!falsified.has(row.symbol)) return row;
    const summary = row.summary ?? "";
    suppressed.push({
      symbol: row.symbol,
      reason: "types-only-falsified",
      detail: typeof readRuntime(runtime, runtimeNameOf(row.symbol)),
      upstreamSummary: summary,
    });
    return { ...row, summary: "" };
  });
  return { rows: patched, suppressed };
}

const DECLARATION =
  /(?<doc>\/\*\*(?:(?!\*\/)[\s\S])*?\*\/\s*)?\b(?:(?:export|declare|default|abstract)\s+)*(?:interface|class)\s+(?<name>[A-Za-z_$][\w$]*)(?:<[^{};]*?>)?\s*(?:extends\s+(?<bases>[^{]+?))?\s*(?:implements\s+[^{]+?)?\s*\{/g;

const MODULE_BUN = /declare\s+module\s+["']bun["']\s*\{/g;
const NAMESPACE = /\bnamespace\s+[A-Za-z_$][\w$]*\s*\{/g;

/** Skip `//`, `/* *\/`, quoted strings and template literals while scanning braces. */
function skipNonCode(source: string, start: number): number {
  const next = source[start];
  if (next === "/" && source[start + 1] === "/") {
    const end = source.indexOf("\n", start);
    return end < 0 ? source.length : end + 1;
  }
  if (next === "/" && source[start + 1] === "*") {
    const end = source.indexOf("*/", start + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (next === '"' || next === "'" || next === "`") {
    const quote = next;
    let cursor = start + 1;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === quote) return cursor + 1;
      cursor += 1;
    }
    return source.length;
  }
  return start + 1;
}

/** End index (exclusive) of the block whose `{` is at `open`. */
function blockEnd(source: string, open: number): number {
  let depth = 0;
  let cursor = open;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "/" || char === '"' || char === "'" || char === "`") {
      cursor = skipNonCode(source, cursor);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

/** `[start, end)` ranges of `declare module "bun" { … }` blocks. */
function moduleBunRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of source.matchAll(MODULE_BUN)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    ranges.push([match.index ?? 0, blockEnd(source, open)]);
  }
  return ranges;
}

/** `[start, end)` ranges of nested `namespace X { … }` blocks. */
function namespaceRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const match of source.matchAll(NAMESPACE)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    ranges.push([match.index ?? 0, blockEnd(source, open)]);
  }
  return ranges;
}

const inside = (index: number, range: [number, number]): boolean =>
  index >= range[0] && index < range[1];

/**
 * Split an `extends` clause into base names. Angle-bracket aware (type arguments are not bases),
 * comment tolerant, and it rejects a self-edge and `__internal` helpers.
 */
export function baseNames(raw: string, declarationName: string): string[] {
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const clause = withoutComments.split(/\bimplements\b/)[0] ?? withoutComments;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of clause) {
    if (char === "<") depth += 1;
    else if (char === ">") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const bases: string[] = [];
  for (const part of parts) {
    const segments = (part.trim().split("<")[0] ?? "")
      .trim()
      .split(".")
      .map((segment) => segment.trim())
      .filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    if (segments.includes("__internal") || segments[0] === "__internal")
      continue;
    const base = segments[segments.length - 1] ?? "";
    if (!/^[A-Za-z_$][\w$]*$/.test(base)) continue;
    if (base === declarationName) continue;
    if (!bases.includes(base)) bases.push(base);
  }
  return bases;
}

/**
 * `interface`/`class` declarations of a `.d.ts` by name, with the facts the provenance rule needs:
 * whether the declaration carries its own JSDoc and what it extends.
 *
 * With `options.module`, only declarations inside that `declare module "<name>"` block and outside
 * nested `namespace` blocks are kept — the scope filter that keeps DOM re-declarations from
 * shadowing Bun's own symbols.
 */
export function parseTypeScriptBases(
  source: string,
  options: { readonly module?: string } = {},
): Map<string, DeclarationBases> {
  const moduleRanges =
    options.module === undefined ? [] : moduleBunRanges(source);
  const nested = options.module === undefined ? [] : namespaceRanges(source);

  const found = new Map<string, DeclarationBases>();
  for (const match of source.matchAll(DECLARATION)) {
    const index = match.index ?? 0;
    if (options.module !== undefined) {
      if (!moduleRanges.some((range) => inside(index, range))) continue;
      if (nested.some((range) => inside(index, range))) continue;
    }
    const name = match.groups?.name;
    if (name === undefined) continue;
    const declaration: DeclarationBases = {
      hasOwnJsDoc: (match.groups?.doc ?? "").trim() !== "",
      bases: baseNames(match.groups?.bases ?? "", name),
    };
    const previous = found.get(name);
    // A doc-bearing declaration wins over one seen without a comment.
    if (
      previous === undefined ||
      (!previous.hasOwnJsDoc && declaration.hasOwnJsDoc)
    ) {
      found.set(name, declaration);
    }
  }
  return found;
}

/** `/// <reference path="…" />` closure of an entry declaration, in dependency order. */
function referenceClosure(entry: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const visit = (file: string): void => {
    const resolved = realpathSync(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    files.push(resolved);
    let text = "";
    try {
      text = readFileSync(resolved, "utf8");
    } catch {
      return;
    }
    for (const match of text.matchAll(
      /\/\/\/\s*<reference\s+path=["']([^"']+)["']/g,
    )) {
      const next = join(dirname(resolved), match[1]!);
      if (Bun.file(next).size > 0) visit(next);
    }
  };
  visit(entry);
  return files;
}

function packageVersionOf(indexPath: string): string {
  try {
    const pkg = readFileSync(join(dirname(indexPath), "package.json"), "utf8");
    const parsed = JSON.parse(pkg) as { name?: string; version?: string };
    return `${parsed.name ?? "bun-types"}@${parsed.version ?? "unknown"}`;
  } catch {
    return "bun-types@unknown";
  }
}

/**
 * Resolve the installed `bun-types` package and its reference closure. `@types/bun` is the entry
 * point (it depends on `bun-types`); the private `.bun`/pnpm stores are last-resort fallbacks,
 * preferring the version matching the running Bun. Returns null when nothing resolves.
 */
export function resolveBunTypesIndex(root: string): string | null {
  // 1. @types/bun → bun-types (validated against this checkout's isolated install).
  try {
    const typesIndex = realpathSync(
      Bun.resolveSync("@types/bun/index.d.ts", root),
    );
    try {
      const resolved = Bun.resolveSync(
        "bun-types/index.d.ts",
        dirname(typesIndex),
      );
      if (Bun.file(resolved).size > 0) return realpathSync(resolved);
    } catch {
      // Fall through to the declaration that @types/bun re-exports.
    }
    if (Bun.file(typesIndex).size > 0) return typesIndex;
  } catch {
    // Not installed as @types/bun.
  }

  // 2. Store layouts. Sorted, with the running Bun's version preferred.
  const patterns = [
    "node_modules/.bun/bun-types@*/node_modules/bun-types/index.d.ts",
    "node_modules/.pnpm/bun-types@*/node_modules/bun-types/index.d.ts",
    "node_modules/bun-types/index.d.ts",
  ];
  for (const pattern of patterns) {
    let found: string[] = [];
    try {
      found = [...new Bun.Glob(pattern).scanSync({ cwd: root })].sort();
    } catch {
      continue;
    }
    const preferred =
      found.find((path) => path.includes(`bun-types@${Bun.version}/`)) ??
      found[0];
    if (preferred !== undefined) return join(root, preferred);
  }
  return null;
}

/** Load and merge the module-scoped declarations from the `bun-types` reference closure. */
export function loadBunTypesDeclarations(
  root: string,
): BunTypesDeclarations | null {
  let index: string | null;
  try {
    index = resolveBunTypesIndex(root);
  } catch {
    index = null;
  }
  if (index === null) return null;

  const files = referenceClosure(index);
  const declarations = new Map<string, DeclarationBases>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [name, declaration] of parseTypeScriptBases(source, {
      module: "bun",
    })) {
      const previous = declarations.get(name);
      if (
        previous === undefined ||
        (!previous.hasOwnJsDoc && declaration.hasOwnJsDoc)
      ) {
        declarations.set(name, declaration);
      }
    }
  }
  return {
    package: packageVersionOf(index),
    files,
    relativeFiles: files.map((file) => relative(root, file)),
    declarations,
  };
}

/** Rows whose summary can only be their base's, because they declare none of their own. */
export function findInheritedSummaries(
  rows: readonly SummaryRow[],
  declarations: ReadonlyMap<string, DeclarationBases>,
): SuppressedSummary[] {
  const summaryOf = new Map<string, string>();
  // A merged symbol has several rows; the class/interface row carries the declaration's own text,
  // so it wins over a function/namespace row regardless of row order.
  for (const declarationRow of [true, false]) {
    for (const row of rows) {
      const isDeclaration = row.kind === "class" || row.kind === "interface";
      if (isDeclaration !== declarationRow) continue;
      const summary = (row.summary ?? "").trim();
      if (summary === "") continue;
      const name = runtimeNameOf(row.symbol);
      if (name === "" || summaryOf.has(name)) continue;
      summaryOf.set(name, summary);
    }
  }

  const claims: SuppressedSummary[] = [];
  const claimed = new Set<string>();
  for (const row of rows) {
    const summary = (row.summary ?? "").trim();
    if (summary === "" || claimed.has(row.symbol)) continue;
    // Types-only rows are the falsified pass's business: classifying them as inherited here would
    // make report mode and --apply disagree on a fresh scrape.
    if (TYPE_ONLY_CLAIM.test(summary)) continue;
    if (row.kind !== "class" && row.kind !== "interface") continue;
    const name = runtimeNameOf(row.symbol);
    const declaration = declarations.get(name);
    if (declaration === undefined || declaration.hasOwnJsDoc) continue;

    for (const base of declaration.bases) {
      if (base === name) continue;
      const baseSummary = summaryOf.get(base);
      if (baseSummary !== undefined) {
        // The base is documented in the same artifact: identical text means inherited.
        if (baseSummary === summary) {
          claims.push({
            symbol: row.symbol,
            reason: "inherited-from-base",
            detail: base,
            upstreamSummary: summary,
          });
          claimed.add(row.symbol);
          break;
        }
        continue;
      }
      // The base is outside the artifact (EventTarget, Event): either a sibling that extends the
      // same base carries the identical text, or the text links the base's own MDN page.
      const sibling = rows.some((other) => {
        if (other === row) return false;
        // Corroboration must come from a different declaration: another row of the same symbol
        // resolves to the same declaration and proves nothing.
        if (runtimeNameOf(other.symbol) === name) return false;
        if ((other.summary ?? "").trim() !== summary) return false;
        const otherDeclaration = declarations.get(runtimeNameOf(other.symbol));
        return (
          otherDeclaration !== undefined &&
          !otherDeclaration.hasOwnJsDoc &&
          otherDeclaration.bases.includes(base)
        );
      });
      if (sibling || quotesBaseReference(summary, base)) {
        claims.push({
          symbol: row.symbol,
          reason: "inherited-from-base",
          detail: base,
          upstreamSummary: summary,
        });
        claimed.add(row.symbol);
        break;
      }
    }
  }
  return claims;
}

/** Clear only the rows whose text a claim names; a merged symbol's other rows keep theirs. */
export function suppressInheritedSummaries<T extends SummaryRow>(
  rows: readonly T[],
  declarations: ReadonlyMap<string, DeclarationBases>,
): { rows: T[]; suppressed: SuppressedSummary[] } {
  const inherited = findInheritedSummaries(rows, declarations);
  if (inherited.length === 0) return { rows: [...rows], suppressed: [] };
  const claimedText = new Map(
    inherited.map((claim) => [claim.symbol, claim.upstreamSummary] as const),
  );
  return {
    rows: rows.map((row) => {
      const claim = claimedText.get(row.symbol);
      if (claim === undefined) return row;
      if ((row.summary ?? "").trim() !== claim.trim()) return row;
      return { ...row, summary: "" };
    }),
    suppressed: inherited,
  };
}

/**
 * Both passes, in order: the falsified claim first (runtime only), then the borrowed description
 * (declarations), on rows that still carry a summary.
 */
export function suppressSummaryDefects<T extends SummaryRow>(
  rows: readonly T[],
  options: {
    readonly runtime?: Record<string, unknown>;
    // `| undefined` is explicit: callers pass the resolved declaration map, absent when bun-types
    // cannot be located (exactOptionalPropertyTypes forbids a bare optional here).
    readonly declarations?: ReadonlyMap<string, DeclarationBases> | undefined;
  } = {},
): { rows: T[]; suppressed: SuppressedSummary[] } {
  const falsified = suppressFalsifiedTypeOnlySummaries(rows, options.runtime);
  if (options.declarations === undefined) {
    return { rows: falsified.rows, suppressed: falsified.suppressed };
  }
  const inherited = suppressInheritedSummaries(
    falsified.rows,
    options.declarations,
  );
  return {
    rows: inherited.rows,
    suppressed: [...falsified.suppressed, ...inherited.suppressed],
  };
}
