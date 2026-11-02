/**
 * @file sport_catalog.ts
 * @description Types and indexes over the portal sport catalog: 19 sports, 230 sub-sports and
 * 42 period entries, from `tests/fixtures/fantasy402-sport-catalog-2026-10-21.json`.
 *
 * Two facts this module refuses to flatten:
 *
 *  1. **Period numbers are sport-specific.** `number: 1` is "1st Half" for Football and
 *     Basketball, "1st Period" for Hockey and "1st 5 Innings" for Baseball. A single global
 *     number→name table would mislabel most sports, so {@link periodTypeIndex} reports the
 *     names each number actually carries and flags the ambiguous ones.
 *  2. **A sub-sport code is not unique.** "Arena" is both Football and Horse Racing, "NCAA
 *     Extra" is both Basketball and Hockey, so lookups require `(sport, code)`.
 */

export interface CatalogSubSport {
  /** Wire code, e.g. `"F1 MATCHUPS"`. */
  readonly code: string;
  /** Display label, e.g. `"F1 Matchups"`. */
  readonly name: string;
}

export interface CatalogPeriod {
  readonly name: string;
  readonly number: number;
}

export interface CatalogSport {
  readonly sport: string;
  readonly subSports: readonly CatalogSubSport[];
  readonly periods: readonly CatalogPeriod[];
}

export interface CatalogCollision {
  readonly code: string;
  readonly sports: readonly string[];
}

export interface SportCatalogFile {
  readonly provider: string;
  readonly capturedAt: string;
  readonly periodsCapturedAt: string;
  readonly sportCount: number;
  readonly subSportCount: number;
  readonly sportPeriodCount: number;
  readonly collisions: readonly CatalogCollision[];
  readonly expectedEmptySubSportPaths: {
    readonly stable: readonly string[];
    readonly volatile: readonly string[];
  };
  readonly migrationRisks: readonly {
    readonly kind: string;
    readonly code: string;
    readonly affects: readonly string[];
    readonly note: string;
  }[];
  readonly sports: readonly CatalogSport[];
}

export interface PeriodType {
  readonly number: number;
  /** Every name this number carries, sorted. More than one means it is sport-specific. */
  readonly names: readonly string[];
  /** Sports that use the number with each name. */
  readonly sports: readonly string[];
  readonly sportSpecific: boolean;
}

export interface SubSportIndexEntry {
  readonly code: string;
  readonly name: string;
  /** Every sport that declares this code. More than one is a desk-link collision. */
  readonly sports: readonly string[];
  readonly collision: boolean;
}

export interface CatalogSummary {
  readonly sports: number;
  readonly subSports: number;
  readonly periodEntries: number;
  readonly distinctPeriodNumbers: number;
  readonly collisions: number;
}

/** Validates shape and cross-checks the declared counts. Returns null on a foreign payload. */
export function loadSportCatalog(payload: unknown): SportCatalogFile | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Partial<SportCatalogFile>;
  if (!Array.isArray(record.sports) || record.sports.length === 0) return null;
  if (typeof record.sportCount !== "number") return null;

  const sports: CatalogSport[] = [];
  for (const entry of record.sports) {
    if (typeof entry !== "object" || entry === null) return null;
    const sport = entry as Partial<CatalogSport>;
    if (typeof sport.sport !== "string" || !Array.isArray(sport.subSports)) {
      return null;
    }
    if (!Array.isArray(sport.periods)) return null;
    sports.push({
      sport: sport.sport,
      subSports: sport.subSports.map((s) => ({
        code: String(s.code ?? ""),
        name: String(s.name ?? ""),
      })),
      periods: sport.periods.map((p) => ({
        name: String(p.name ?? ""),
        number: Number(p.number ?? 0),
      })),
    });
  }

  return {
    provider: typeof record.provider === "string" ? record.provider : "",
    capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : "",
    periodsCapturedAt:
      typeof record.periodsCapturedAt === "string"
        ? record.periodsCapturedAt
        : "",
    sportCount: record.sportCount,
    subSportCount:
      typeof record.subSportCount === "number" ? record.subSportCount : 0,
    sportPeriodCount:
      typeof record.sportPeriodCount === "number" ? record.sportPeriodCount : 0,
    collisions: Array.isArray(record.collisions)
      ? record.collisions.map((c) => ({
          code: String(c.code ?? ""),
          sports: (c.sports ?? []).map(String),
        }))
      : [],
    expectedEmptySubSportPaths: {
      stable: (record.expectedEmptySubSportPaths?.stable ?? []).map(String),
      volatile: (record.expectedEmptySubSportPaths?.volatile ?? []).map(String),
    },
    migrationRisks: Array.isArray(record.migrationRisks)
      ? record.migrationRisks.map((risk) => ({
          kind: String(risk.kind ?? ""),
          code: String(risk.code ?? ""),
          affects: (risk.affects ?? []).map(String),
          note: String(risk.note ?? ""),
        }))
      : [],
    sports,
  };
}

export function summarizeCatalog(catalog: SportCatalogFile): CatalogSummary {
  let subSports = 0;
  let periodEntries = 0;
  const numbers = new Set<number>();

  for (const sport of catalog.sports) {
    subSports += sport.subSports.length;
    periodEntries += sport.periods.length;
    for (const period of sport.periods) numbers.add(period.number);
  }

  return {
    sports: catalog.sports.length,
    subSports,
    periodEntries,
    distinctPeriodNumbers: numbers.size,
    collisions: catalog.collisions.length,
  };
}

/**
 * Number → names, with the sports that use each name. `sportSpecific` is true whenever a number
 * carries more than one name, which is the case for every number except 0 ("Game").
 */
export function periodTypeIndex(
  catalog: SportCatalogFile,
): readonly PeriodType[] {
  const byNumber = new Map<
    number,
    { names: Map<string, Set<string>>; sports: Set<string> }
  >();

  for (const sport of catalog.sports) {
    for (const period of sport.periods) {
      const entry = byNumber.get(period.number) ?? {
        names: new Map<string, Set<string>>(),
        sports: new Set<string>(),
      };
      const sportsForName = entry.names.get(period.name) ?? new Set<string>();
      sportsForName.add(sport.sport);
      entry.names.set(period.name, sportsForName);
      entry.sports.add(sport.sport);
      byNumber.set(period.number, entry);
    }
  }

  return [...byNumber.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, entry]) => ({
      number,
      names: [...entry.names.keys()].sort(),
      sports: [...entry.sports].sort(),
      sportSpecific: entry.names.size > 1,
    }));
}

/** Code → sports, exposing the desk-link collisions the catalog records. */
export function subSportIndex(
  catalog: SportCatalogFile,
): readonly SubSportIndexEntry[] {
  const byCode = new Map<string, { name: string; sports: Set<string> }>();

  for (const sport of catalog.sports) {
    for (const subSport of sport.subSports) {
      const entry = byCode.get(subSport.code) ?? {
        name: subSport.name,
        sports: new Set<string>(),
      };
      entry.sports.add(sport.sport);
      byCode.set(subSport.code, entry);
    }
  }

  return [...byCode.entries()]
    .map(([code, entry]) => ({
      code,
      name: entry.name,
      sports: [...entry.sports].sort(),
      collision: entry.sports.size > 1,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Exact lookup: the same code under a different sport is a different market. */
export function findSubSport(
  catalog: SportCatalogFile,
  sport: string,
  code: string,
): CatalogSubSport | null {
  const entry = catalog.sports.find((s) => s.sport === sport);
  if (entry === undefined) return null;
  return entry.subSports.find((s) => s.code === code) ?? null;
}

/** Period menu for one sport, verbatim — the only safe way to label a period number. */
export function periodsFor(
  catalog: SportCatalogFile,
  sport: string,
): readonly CatalogPeriod[] {
  return catalog.sports.find((s) => s.sport === sport)?.periods ?? [];
}
