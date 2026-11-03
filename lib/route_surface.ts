/**
 * The daemon's route surface exists in three places, hand-maintained: the `pathname === "…"`
 * arms in services/sportsdesk_webview_server.ts, `surfaces[].members` in the ledger, and the
 * paths in docs/openapi.json. Nothing compared them, so they drifted: measured 2026-11-01,
 * five routes were served and undocumented.
 *
 * This derives the served surface from the source and compares it with what is declared. It is
 * a static reading of the chain, not a model of it — once the handler grows a real route table
 * (`ROUTES`), the table becomes the source and this extractor is deleted. Until then the
 * invariant is enforced rather than assumed.
 */

import { z } from "zod";

export type SurfaceFinding = {
  readonly kind: "served-undocumented" | "declared-not-served" | "spec-missing";
  readonly path: string;
  readonly detail: string;
};

/** Normalise a ledger member (`GET /api/x`) to a bare path. */
export function memberPath(member: unknown): string | undefined {
  if (typeof member !== "string") return undefined;
  const text = member
    .trim()
    .replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "");
  const path = text.split(/\s+/)[0] ?? "";
  return path.startsWith("/") ? path : undefined;
}

/**
 * Paths the server answers, read from the if-chain.
 *
 * Both the literal comparison and the two variants in use are covered: `pathname === "…"`,
 * a `||` continuation onto the next line, and `pathname.endsWith(…)` suffix matching. Query
 * strings are not part of a path, so they are dropped.
 *
 * A `SomeSet.has(pathname)` arm is read from the set's literal declaration: `/combo-uniqueness.json`
 * and `/cross-domain-bridge.json` are served that way, and a chain scan that only understood
 * `===` reported "every served path has a row" while two paths had none. The set is only counted
 * when this source actually branches on it, so a set used for something else is not a route.
 */
export function servedPathsFromSource(source: string): Set<string> {
  const paths = new Set<string>();
  const literal = /pathname === "([^"]+)"/g;
  for (const match of source.matchAll(literal)) {
    const value = match[1] ?? "";
    if (value.startsWith("/")) paths.add(value.split("?")[0] ?? value);
  }

  const setLiteral =
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*new Set\(\s*\[([^\]]*)\]\s*\)/g;
  for (const match of source.matchAll(setLiteral)) {
    const name = match[1] ?? "";
    const members = match[2] ?? "";
    if (
      name === "" ||
      !new RegExp(`\\b${name}\\.has\\(\\s*pathname\\s*\\)`).test(source)
    ) {
      continue;
    }
    for (const member of members.matchAll(/"([^"]+)"/g)) {
      const value = member[1] ?? "";
      if (value.startsWith("/")) paths.add(value.split("?")[0] ?? value);
    }
  }
  return paths;
}

/**
 * The ledger's surface categories, as a union rather than `string`.
 *
 * `category: string` compiled happily with a typo, and the comparison that decides whether a path
 * must be served here (`category !== "local-route"`) would then silently classify a local route as
 * something else. The ledger is the authoritative list; `"unknown"` exists only so an unrecognised
 * value is reported rather than coerced into a real category.
 */
export type SurfaceCategory =
  | "catalog"
  | "upstream-route"
  | "local-route"
  | "blocked-contract"
  | "documented-not-implemented"
  | "unknown";

const SURFACE_CATEGORIES: readonly SurfaceCategory[] = [
  "catalog",
  "upstream-route",
  "local-route",
  "blocked-contract",
  "documented-not-implemented",
];

export function parseSurfaceCategory(value: unknown): SurfaceCategory {
  return typeof value === "string" &&
    (SURFACE_CATEGORIES as readonly string[]).includes(value)
    ? (value as SurfaceCategory)
    : "unknown";
}

export type DeclaredPath = {
  readonly surface: string;
  /** `local-route` paths are served by this daemon; `upstream-route` ones are proxied elsewhere. */
  readonly category: SurfaceCategory;
};

/** One ledger surface, parsed rather than cast: the JSON is external data at this boundary. */
export type ParsedSurface = {
  readonly id: string;
  readonly category: SurfaceCategory;
  readonly members: readonly unknown[];
};

/** The three files this module reads, each parsed once here and trusted afterwards. */
const LedgerSchema = z.object({
  surfaces: z
    .array(
      z.object({
        id: z.string().optional(),
        category: z.unknown(),
        members: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});

const SpecSchema = z.object({
  paths: z.record(z.string(), z.unknown()).optional(),
});

const SurfaceSchema = z.object({
  id: z.string().optional(),
  category: z.unknown(),
  members: z.array(z.unknown()).optional(),
});

export function parseLedgerSurface(value: unknown): ParsedSurface | null {
  const parsed = SurfaceSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    id: parsed.data.id ?? "surface",
    category: parseSurfaceCategory(parsed.data.category),
    members: parsed.data.members ?? [],
  };
}

/** Paths declared by the ledger's surfaces[], with the surface and category that declare them. */
export function declaredPathsFromLedger(
  ledger: unknown,
): Map<string, DeclaredPath> {
  const declared = new Map<string, DeclaredPath>();
  const parsed = LedgerSchema.safeParse(ledger);
  if (!parsed.success) return declared;
  for (const value of parsed.data.surfaces ?? []) {
    const surface = parseLedgerSurface(value);
    if (surface === null) continue;
    for (const member of surface.members) {
      const path = memberPath(member);
      if (path !== undefined) {
        declared.set(path, { surface: surface.id, category: surface.category });
      }
    }
  }
  return declared;
}

/** Paths published in the spec. */
export function specPathsFromDocument(spec: unknown): Set<string> {
  const parsed = SpecSchema.safeParse(spec);
  if (!parsed.success) return new Set();
  return new Set(Object.keys(parsed.data.paths ?? {}));
}

/**
 * `{name}` (the spec's notation) and `*` (the handler's) are the same route.
 *
 * `/api/logo/{name}` in the ledger and spec, `/api/logo/*` in `DAEMON_PREFIX_ROUTES`: without a
 * shared form the comparison reports the route as both undocumented and unpublished.
 */
export function canonicalRoutePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "*");
}

/**
 * Compare the three views.
 *
 * `declared-not-served` is only reported for surfaces that are not documented as unimplemented:
 * `surface.desk-api-unimplemented` exists precisely to record routes that are documented and
 * deliberately absent, so counting those as drift would train the reader to ignore the report.
 */
export function compareRouteSurfaces(input: {
  readonly served: ReadonlySet<string>;
  readonly declared: ReadonlyMap<string, DeclaredPath>;
  readonly spec: ReadonlySet<string>;
  readonly allowUndeclaredUnserved?: readonly string[];
}): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const allow = new Set(
    input.allowUndeclaredUnserved ?? ["surface.desk-api-unimplemented"],
  );

  // Scope: `/api/*` is the contract and must be declared. Pages (`/graph`, `/live-bets`, …) are
  // UI, described by surfaces at a coarser grain, so a missing page row is not drift — but a
  // *declared* page that is no longer served still is.
  const isApi = (path: string): boolean => path.startsWith("/api/");

  const servedByCanonical = new Map<string, string>();
  for (const path of input.served) {
    servedByCanonical.set(canonicalRoutePath(path), path);
  }
  const specCanonical = new Set([...input.spec].map(canonicalRoutePath));
  const declaredByCanonical = new Map<string, DeclaredPath>();
  for (const [path, declared] of input.declared) {
    // First declaration wins; a second surface listing the same route is not a finding.
    if (!declaredByCanonical.has(canonicalRoutePath(path))) {
      declaredByCanonical.set(canonicalRoutePath(path), declared);
    }
  }

  for (const path of [...input.served].sort()) {
    if (!isApi(path)) continue;
    if (!declaredByCanonical.has(canonicalRoutePath(path))) {
      findings.push({
        kind: "served-undocumented",
        path,
        detail: "served by the daemon, but no ledger surface lists it",
      });
    }
  }

  // `declared-not-served` is only asserted where the reading is trustworthy: a local-route
  // surface's `/api/*` member. Upstream routes are proxied elsewhere, and asset/data paths are
  // served by prefix or suffix matching, which this extractor deliberately does not model.
  for (const [path, declared] of [...input.declared.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (servedByCanonical.has(canonicalRoutePath(path))) continue;
    if (allow.has(declared.surface)) continue;
    if (declared.category !== "local-route" || !path.startsWith("/api/"))
      continue;
    findings.push({
      kind: "declared-not-served",
      path,
      detail: `${declared.surface} lists it, but the daemon has no such arm`,
    });
  }

  for (const path of [...input.declared.keys()].sort()) {
    if (!isApi(path)) continue;
    const served = servedByCanonical.has(canonicalRoutePath(path));
    if (served && !specCanonical.has(canonicalRoutePath(path))) {
      findings.push({
        kind: "spec-missing",
        path,
        detail:
          "served and declared, but docs/openapi.json publishes no path for it",
      });
    }
  }
  return findings;
}

export async function readRouteSurfaceInputs(
  root: string,
  prefixPaths: readonly string[] = [],
): Promise<{
  readonly served: Set<string>;
  readonly declared: Map<string, DeclaredPath>;
  readonly spec: Set<string>;
}> {
  const source = await Bun.file(
    `${root}/services/sportsdesk_webview_server.ts`,
  ).text();
  const ledger: unknown = await Bun.file(
    `${root}/docs/evidence/ledger.json`,
  ).json();
  const spec: unknown = await Bun.file(`${root}/docs/openapi.json`).json();
  return {
    // Prefix arms (`pathname.startsWith`) are invisible to the literal scan, so the caller passes
    // the table's own prefix rows rather than having this guess at an arm's intent.
    served: new Set([...servedPathsFromSource(source), ...prefixPaths]),
    declared: declaredPathsFromLedger(ledger),
    spec: specPathsFromDocument(spec),
  };
}
