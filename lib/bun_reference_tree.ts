/**
 * @file lib/bun_reference_tree.ts
 * @description Parser and verdict engine for bun.sh/reference: module indexes, section merging,
 * kind/verdict classification, sidebar badges and the kind → badge colour contract.
 *
 * Pure over fetched payloads; the network step lives in `lib/bun_reference_audit.ts`. Consumers:
 * `cli/bun_reference_cli.ts` and the Scratch experiment drivers.
 */

export const MODULES_INDEX_URL = "https://bun.sh/reference/bun.props.json";
/** Canonical module index: the /reference landing page. */
export const REFERENCE_INDEX_URL = "https://bun.sh/reference.props.json";
export const TYPE_ONLY_CLAIM = /only exists in types/i;
// TS enums are runtime values (`Bun.FFIType`, `node:ffi` types), so they belong to the value space.
export const VALUE_KINDS: ReadonlySet<string> = new Set([
  "functions",
  "variables",
  "classes",
  "namespaces",
  "enums",
]);
export const TYPE_KINDS: ReadonlySet<string> = new Set(["interfaces", "types"]);

/** Every section kind the reference pages may emit (plus the `other` links section). */
export const KNOWN_SECTION_KINDS: ReadonlySet<string> = new Set([
  ...VALUE_KINDS,
  ...TYPE_KINDS,
  "other",
]);

export type Verdict =
  | "ok"
  | "ok-erased"
  | "ok-types-only"
  | "doc-contradicted"
  | "documented-value-missing"
  | "type-also-value"
  | "module-unresolvable"
  | "module-unsupported"
  | "module-compile-time-only";

export type ModuleFailure =
  "unsupported" | "compile-time-only" | "unresolvable";

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&nbsp;": " ",
};

export function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(?:quot|#x27|#39|lt|gt|amp|nbsp);/g,
      (e) => HTML_ENTITIES[e] ?? e,
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** JSON fetch with two retries; used for every module index. */
export async function fetchJson(url: string, attempt = 0): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    if (attempt < 2) return fetchJson(url, attempt + 1);
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

/** Module hrefs from the `Modules` block of a reference page's sidebar. */
export function modulePathsFromSidebar(sidebarHtml: string): string[] {
  const block =
    /<p[^>]*>\s*Modules\s*<\/p>([\s\S]*?)<\/div>/.exec(sidebarHtml)?.[1] ?? "";
  return [
    ...new Set(
      [...block.matchAll(/href="(\/reference\/[^"]+)"/g)].map((m) => m[1]!),
    ),
  ];
}

export interface IndexRow {
  readonly name: string;
  readonly kind: string;
  readonly summary: string;
}

export interface OtherSectionLink {
  readonly href: string;
}

export interface ParsedIndex {
  readonly rows: IndexRow[];
  /** `other`-section rows are links to another module page, not symbols of this module. */
  readonly otherLinks: OtherSectionLink[];
  readonly sectionCounts: Record<string, number>;
}

/**
 * Parse one module index page. `prefix` is the module path without `/reference/` (`bun`,
 * `node/fs`, …); rows are member links under that prefix.
 */
export function parseIndex(html: string, prefix: string): ParsedIndex {
  const rows: IndexRow[] = [];
  const otherLinks: OtherSectionLink[] = [];
  const sectionCounts: Record<string, number> = {};
  for (const section of html.matchAll(
    /<section id="(\w+)"[\s\S]*?<\/section>/g,
  )) {
    const kind = section[1]!;
    sectionCounts[kind] = 0;
    for (const item of section[0].matchAll(/<li class="grid[\s\S]*?<\/li>/g)) {
      const href = item[0].match(/href="\/reference\/([^"#]+)"/)?.[1];
      if (!href) continue;
      sectionCounts[kind]! += 1;
      if (kind === "other") {
        otherLinks.push({ href });
        continue;
      }
      if (!href.startsWith(`${prefix}/`)) continue;
      const name = decodeURIComponent(href.slice(prefix.length + 1));
      if (name === "" || name.includes("/") || name.includes(":")) continue;
      const summary = text(item[0].match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");
      rows.push({ name, kind, summary });
    }
  }
  return { rows, otherLinks, sectionCounts };
}

export interface MergedIndexRow {
  readonly name: string;
  readonly kinds: string[];
  readonly summary: string;
}

export interface MergedIndex {
  readonly entries: MergedIndexRow[];
  /** Names listed in several sections (a merged symbol). */
  readonly duplicates: { name: string; kinds: string[] }[];
}

/** Merge per-section rows of one module by member name, preferring a summary-bearing section. */
export function mergeIndexRows(rows: readonly IndexRow[]): MergedIndex {
  const byName = new Map<string, { kinds: string[]; summary: string }>();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (existing) {
      if (!existing.kinds.includes(row.kind)) existing.kinds.push(row.kind);
      // A types-only claim wins over a later section's text; otherwise first non-empty wins.
      if (
        existing.summary === "" ||
        (TYPE_ONLY_CLAIM.test(row.summary) &&
          !TYPE_ONLY_CLAIM.test(existing.summary))
      ) {
        existing.summary = row.summary;
      }
    } else {
      byName.set(row.name, { kinds: [row.kind], summary: row.summary });
    }
  }
  return {
    entries: [...byName].map(([name, info]) => ({
      name,
      kinds: info.kinds,
      summary: info.summary,
    })),
    duplicates: [...byName]
      .filter(([, info]) => info.kinds.length > 1)
      .map(([name, info]) => ({ name, kinds: info.kinds })),
  };
}

export interface VerdictInput {
  readonly kinds: readonly string[];
  readonly summary: string;
  readonly present: boolean;
  readonly resolvable: boolean;
  readonly failure?: ModuleFailure | undefined;
}

/**
 * Classify one documented member. A missing namespace is neither evidence of absence nor a single
 * bucket: an unimplemented module and a probe bug must not be reported as the same thing.
 */
export function verdictOf(row: VerdictInput): Verdict {
  if (!row.resolvable) {
    if (row.failure === "unsupported") return "module-unsupported";
    if (row.failure === "compile-time-only") return "module-compile-time-only";
    return "module-unresolvable";
  }
  const valueKind = row.kinds.some((kind) => VALUE_KINDS.has(kind));
  // Mixed-kind rows are values when any value kind applies; `every()` would misreport them.
  const typeKind = !valueKind && row.kinds.some((kind) => TYPE_KINDS.has(kind));
  const claimedTypesOnly = TYPE_ONLY_CLAIM.test(row.summary);
  if (valueKind && claimedTypesOnly) {
    return row.present ? "doc-contradicted" : "ok-types-only";
  }
  if (valueKind) return row.present ? "ok" : "documented-value-missing";
  if (typeKind) return row.present ? "type-also-value" : "ok-erased";
  return row.present ? "ok" : "documented-value-missing";
}

/**
 * Why a documented value is missing: an alias under another spelling, a class that lives on
 * `globalThis`, a types-only namespace grouping, or a symbol newer than the pin.
 */
export function explainMissing(
  row: {
    readonly name: string;
    readonly module: string;
    readonly kinds: readonly string[];
  },
  ns: Record<string, unknown> | null,
): string {
  const lower = row.name.toLowerCase();
  if (ns !== null && ns[lower] !== undefined) return "alias";
  const near =
    ns === null
      ? undefined
      : Object.keys(ns).find(
          (key) =>
            key.toLowerCase().startsWith(lower) &&
            typeof ns[key] === "function",
        );
  if (near !== undefined) return `alias:${near}`;
  if (
    row.module !== "/reference/globals" &&
    (globalThis as unknown as Record<string, unknown>)[row.name] !== undefined
  ) {
    return "global";
  }
  if (
    row.module === "/reference/bun" &&
    row.kinds.every((kind) => kind === "namespaces")
  ) {
    return "grouping";
  }
  return "absent-on-pin";
}

/** Module hrefs from the `/reference` landing page's content (the canonical module list). */
export function modulePathsFromLanding(contentHtml: string): string[] {
  const hrefs = [...contentHtml.matchAll(/href="(\/reference\/[^"#]+)"/g)].map(
    (match) => match[1]!,
  );
  // Depth >= 2 and no trailing segment beyond the module page itself.
  return [...new Set(hrefs)].sort();
}

export interface ModuleSourceCheck {
  readonly landing: string[];
  readonly sidebar: string[];
  readonly match: boolean;
  /** Listed on /reference but not in the bun module page's Modules sidebar. */
  readonly onlyLanding: string[];
  /** In the sidebar but not on /reference. */
  readonly onlySidebar: string[];
}

/**
 * The landing page is generated from the same source as the module pages, so the two lists should
 * be identical. A mismatch means a module exists in only one navigation surface; enumerating from
 * one of them alone would silently miss it.
 */
export function crossCheckModuleSources(
  landing: readonly string[],
  sidebar: readonly string[],
): ModuleSourceCheck {
  const landingSet = new Set(landing);
  const sidebarSet = new Set(sidebar);
  return {
    landing: [...landing],
    sidebar: [...sidebar],
    match:
      landing.length === sidebar.length &&
      landing.every((path) => sidebarSet.has(path)),
    onlyLanding: landing.filter((path) => !sidebarSet.has(path)),
    onlySidebar: sidebar.filter((path) => !landingSet.has(path)),
  };
}

/** The landing page states what the reference is generated from; recorded as provenance. */
export function generatedFromClaim(contentHtml: string): string | null {
  // Take the whole paragraph so the anchor tag is closed before stripping markup.
  const match = /Generated from[\s\S]{0,400}?<\/p>/.exec(contentHtml);
  if (match === null) return null;
  const plain = text(match[0]).replace(/\s+/g, " ");
  const sentence = plain.split(".")[0]?.trim();
  return sentence === undefined || sentence === "" ? plain : `${sentence}.`;
}

export interface LandingGroup {
  readonly heading: string;
  readonly hrefs: string[];
}

/** The landing page groups modules by heading; capture heading → member links. */
export function parseLandingGroups(contentHtml: string): LandingGroup[] {
  const groups: LandingGroup[] = [];
  const headings = [
    ...contentHtml.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g),
  ];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = text(headings[i]![1] ?? "");
    if (!/modules|globals/i.test(heading)) continue;
    const start = (headings[i]!.index ?? 0) + headings[i]![0].length;
    const end =
      i + 1 < headings.length
        ? (headings[i + 1]!.index ?? contentHtml.length)
        : contentHtml.length;
    const hrefs = [
      ...new Set(
        [
          ...contentHtml
            .slice(start, end)
            .matchAll(/href="(\/reference\/[^"#]+)"/g),
        ].map((match) => match[1]!),
      ),
    ].sort();
    groups.push({ heading, hrefs });
  }
  return groups;
}

/** The group a module path must belong to, from its path shape alone. */
export function impliedModuleGroup(
  path: string,
): "Bun modules" | "Node.js modules" | null {
  if (path.startsWith("/reference/node/")) return "Node.js modules";
  if (path === "/reference/bun" || path.startsWith("/reference/bun/")) {
    return "Bun modules";
  }
  if (path === "/reference/globals") return "Bun modules";
  return null;
}

export interface ModuleGroupCheck {
  readonly counts: Record<string, number>;
  readonly mismatches: { path: string; expected: string; actual: string }[];
}

/**
 * Cross-check the landing page's grouping against the path-implied group. `Globals` genuinely sits
 * under "Bun modules" (it is available without an import), so the expectation encodes that.
 */
export function checkModuleGroups(
  groups: readonly LandingGroup[],
): ModuleGroupCheck {
  const counts: Record<string, number> = {};
  const mismatches: ModuleGroupCheck["mismatches"] = [];
  for (const group of groups) {
    counts[group.heading] = (counts[group.heading] ?? 0) + group.hrefs.length;
    for (const path of group.hrefs) {
      const expected = impliedModuleGroup(path);
      if (expected !== null && expected !== group.heading) {
        mismatches.push({ path, expected, actual: group.heading });
      }
    }
  }
  return { counts, mismatches };
}

export interface SidebarBadge {
  /** `data-symbol` as published, e.g. `node:fs.accessSync`. */
  readonly symbol: string;
  /** Last path segment of the symbol, e.g. `accessSync`. */
  readonly name: string;
  readonly letter: string;
  readonly colour: string;
}

const ANCHOR = /<a\b[^>]*data-symbol="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const BADGE = /bg-([a-z]+)-500\/15[^>]*>\s*([A-Za-z]{1,2})\s*</;

/** Kind badges in a module page's sidebar: `<span class="… bg-emerald-500/15 …">F</span>`. */
export function parseSidebarBadges(sidebarHtml: string): SidebarBadge[] {
  const badges: SidebarBadge[] = [];
  for (const anchor of sidebarHtml.matchAll(ANCHOR)) {
    const match = BADGE.exec(anchor[2] ?? "");
    if (match === null) continue;
    const published = anchor[1]!;
    badges.push({
      symbol: published,
      name: published.split(".").pop() ?? published,
      colour: match[1]!,
      letter: match[2]!,
    });
  }
  return badges;
}

export interface JoinedBadge extends SidebarBadge {
  /** Documented kinds of the joined member (one entry per merged section, so length > 1 is merged). */
  readonly kinds: readonly string[];
}

export interface ColourContractRow {
  /** Kind name, e.g. `functions`. */
  readonly name: string;
  /** Badge alias letter, e.g. `F`. */
  readonly alias: string;
  /** Palette name from the class, e.g. `emerald`. */
  readonly colour: string;
  readonly count: number;
}

export interface ObservedBadgeRow {
  readonly alias: string;
  readonly colour: string;
  readonly count: number;
}

export interface ColourContract {
  /** Learned kind → (name, alias, colour) rows, separated rather than packed as "F/emerald". */
  readonly contract: readonly ColourContractRow[];
  /** Every observed badge as (alias, colour) with its count. */
  readonly observed: readonly ObservedBadgeRow[];
  readonly conflicts: { alias: string; colours: string[] }[];
  readonly colourConflicts: { colour: string; aliases: string[] }[];
  /**
   * Badges whose alias is not any kind's learned alias for a merged/unambiguous member. A merged
   * class+namespace is allowed either alias, so only genuinely mismatched badges are listed.
   */
  readonly mismatches: {
    symbol: string;
    kinds: readonly string[];
    alias: string;
    colour: string;
    allowed: string[];
  }[];
}

/**
 * Derive the kind → badge contract from observed badges and flag disagreements. The docs claim
 * symbols are colour-coded by kind: an unambiguous member whose badge alias is not its kind's alias
 * is a documentation defect, while a merged symbol may legitimately show either kind's badge.
 * Each entry keeps `name` (kind), `alias` (letter) and `colour` separate so consumers never parse a
 * combined string.
 */
export function colourContract(
  joined: readonly JoinedBadge[],
  allBadges: readonly SidebarBadge[],
): ColourContract {
  const learned = new Map<string, Map<string, number>>();
  for (const badge of joined) {
    if (badge.kinds.length !== 1) continue;
    const kind = badge.kinds[0]!;
    const counts = learned.get(kind) ?? new Map<string, number>();
    const key = `${badge.letter}\u0000${badge.colour}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    learned.set(kind, counts);
  }
  const aliasFor = new Map<string, string>();
  for (const [kind, counts] of learned) {
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best !== undefined) aliasFor.set(kind, best[0].split("\u0000")[0]!);
  }

  const contract: ColourContractRow[] = [...learned]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, counts]) =>
      [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => {
          const [alias, colour] = key.split("\u0000") as [string, string];
          return { name, alias, colour, count };
        }),
    );

  const observedCounts = new Map<string, number>();
  const colourAliases = new Map<string, Set<string>>();
  for (const badge of allBadges) {
    const key = `${badge.letter}\u0000${badge.colour}`;
    observedCounts.set(key, (observedCounts.get(key) ?? 0) + 1);
    const aliases = colourAliases.get(badge.colour) ?? new Set<string>();
    aliases.add(badge.letter);
    colourAliases.set(badge.colour, aliases);
  }
  const observed: ObservedBadgeRow[] = [...observedCounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => {
      const [alias, colour] = key.split("\u0000") as [string, string];
      return { alias, colour, count };
    });

  const aliasColours = new Map<string, Set<string>>();
  for (const badge of allBadges) {
    const colours = aliasColours.get(badge.letter) ?? new Set<string>();
    colours.add(badge.colour);
    aliasColours.set(badge.letter, colours);
  }

  const mismatches: ColourContract["mismatches"] = [];
  for (const badge of joined) {
    const allowed = [
      ...new Set(
        badge.kinds
          .map((kind) => aliasFor.get(kind))
          .filter((alias): alias is string => alias !== undefined),
      ),
    ];
    if (allowed.length === 0) continue;
    if (!allowed.includes(badge.letter)) {
      mismatches.push({
        symbol: badge.symbol,
        kinds: badge.kinds,
        alias: badge.letter,
        colour: badge.colour,
        allowed,
      });
    }
  }

  return {
    contract,
    observed,
    conflicts: [...aliasColours]
      .filter(([, colours]) => colours.size > 1)
      .map(([alias, colours]) => ({ alias, colours: [...colours].sort() })),
    colourConflicts: [...colourAliases]
      .filter(([, aliases]) => aliases.size > 1)
      .map(([colour, aliases]) => ({ colour, aliases: [...aliases].sort() })),
    mismatches,
  };
}
