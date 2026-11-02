/**
 * @file sport_taxonomy.ts
 * @description The portal's top-level sport taxonomy, plus a mapping from the wire values the
 * reports actually carry (`SportType`, `SportSubType`) onto it.
 *
 * Two entries in the portal's list are not sports:
 *  - `All Sports` is the absence of a filter, so it is not a category here.
 *  - `LIVE` is a *state*, not a sport. It is modelled as {@link LIVE_FILTER} and applied to
 *    `status`, so a live NFL game is filterable as Football *and* as live without pretending
 *    "Live" is a league.
 * `Virtual` is a genuine product line, so it stays a category even though no captured row
 * maps to it yet.
 */

export const SPORT_CATEGORIES = [
  "Auto Racing",
  "Baseball",
  "Basketball",
  "Boxing",
  "Cricket",
  "Entertainment",
  "Esports",
  "Football",
  "Golf",
  "Hockey",
  "Horse Racing",
  "Martial Arts",
  "Olympics",
  "Other",
  "Rugby",
  "Soccer",
  "Tennis",
  "Virtual",
] as const;

export type SportCategory = (typeof SPORT_CATEGORIES)[number];

/** Not a category: the cross-cutting state filter that mirrors the portal's `LIVE` tab. */
export const LIVE_FILTER = "LIVE" as const;

export interface SportCategoryEntry {
  readonly category: SportCategory;
  /** Wire spellings that map here, for operator debugging. */
  readonly wire: readonly string[];
}

const WIRE_MAP: Readonly<Record<string, SportCategory>> = {
  football: "Football",
  "american football": "Football",
  basketball: "Basketball",
  baseball: "Baseball",
  hockey: "Hockey",
  "ice hockey": "Hockey",
  soccer: "Soccer",
  "association football": "Soccer",
  tennis: "Tennis",
  golf: "Golf",
  boxing: "Boxing",
  "martial arts": "Martial Arts",
  mma: "Martial Arts",
  ufc: "Martial Arts",
  "mixed martial arts": "Martial Arts",
  cricket: "Cricket",
  rugby: "Rugby",
  olympics: "Olympics",
  esports: "Esports",
  entertainment: "Entertainment",
  "auto racing": "Auto Racing",
  autoracing: "Auto Racing",
  motorsport: "Auto Racing",
  nascar: "Auto Racing",
  "formula 1": "Auto Racing",
  f1: "Auto Racing",
  "horse racing": "Horse Racing",
  horseracing: "Horse Racing",
  virtual: "Virtual",
  "virtual sports": "Virtual",
};

/**
 * League hints for rows whose `SportType` is present but unrecognised. These are *fallbacks*
 * only: an exact `SportType` match always wins.
 */
const SUBSPORT_HINTS: Readonly<Record<string, SportCategory>> = {
  nfl: "Football",
  ncaaf: "Football",
  "eng prem": "Soccer",
  "eng champ": "Soccer",
  ucl: "Soccer",
  "uefa champions league": "Soccer",
  nba: "Basketball",
  wnba: "Basketball",
  ncaab: "Basketball",
  nhl: "Hockey",
  mlb: "Baseball",
  atp: "Tennis",
  wta: "Tennis",
  pga: "Golf",
};

function key(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Maps a journal row or scoreboard game onto the taxonomy. Unknown sports become `Other`
 * rather than being dropped, so a new league still appears in the UI under an honest label.
 */
export function sportCategoryFor(input: {
  readonly sportType?: unknown;
  readonly sportSubType?: unknown;
  /** Some surfaces already carry a normalised `sport`. */
  readonly sport?: unknown;
}): SportCategory {
  for (const candidate of [input.sportType, input.sport]) {
    const mapped = WIRE_MAP[key(candidate)];
    if (mapped !== undefined) return mapped;
  }

  const hint = SUBSPORT_HINTS[key(input.sportSubType)];
  if (hint !== undefined) return hint;

  return "Other";
}

export interface SportCategorySummary {
  readonly category: SportCategory;
  readonly games: number;
  readonly live: number;
}

/** Counts per category, in taxonomy order, omitting categories with no rows. */
export function summarizeCategories(
  rows: ReadonlyArray<{
    readonly category: SportCategory;
    readonly live?: boolean;
  }>,
): SportCategorySummary[] {
  const counts = new Map<SportCategory, { games: number; live: number }>();
  for (const row of rows) {
    const entry = counts.get(row.category) ?? { games: 0, live: 0 };
    entry.games += 1;
    if (row.live === true) entry.live += 1;
    counts.set(row.category, entry);
  }

  return SPORT_CATEGORIES.filter((category) => counts.has(category)).map(
    (category) => ({
      category,
      games: counts.get(category)?.games ?? 0,
      live: counts.get(category)?.live ?? 0,
    }),
  );
}
