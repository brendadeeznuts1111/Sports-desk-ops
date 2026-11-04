/**
 * @file lib/gslive_report_columns.ts
 * @description Display-label vocabulary for GS Manager reports.
 *
 * Source: the public i18n bundle the console loads
 * (`/manager-tools/translations/v2/getI18nResources/index.php?lng=en&ns=translation&appId=2`),
 * observed 2026-11-02. These are **UI labels**, not wire field names. The bundle also
 * shows how reports are produced ("Generating report. Please wait…", "Report has been
 * generated successfully.", "Report History", "To CSV", "To Excel"), which is why this
 * mapper targets an exported header row rather than a JSON grid response.
 *
 * Use it to turn a downloaded CSV/XLS header row into canonical keys, and to fail loudly
 * on headers that were never observed. It invents no transport, method or response shape;
 * `docs/gs-manager-contracts.md` still marks every report kind `blocked_contract`.
 */

export type GsLiveColumn =
  | "login"
  | "agent"
  | "bet"
  | "win"
  | "loss"
  | "toWin"
  | "profit"
  | "pending"
  | "gradedTotal"
  | "pendingTotal"
  | "wagerCount"
  | "hold"
  | "vigorish"
  | "ratio"
  | "line"
  | "side"
  | "price"
  | "event"
  | "league"
  | "period"
  | "market"
  | "sport"
  | "legs"
  | "parlay"
  | "teaser"
  | "betTime"
  | "endTime"
  | "gradeTime"
  | "description"
  | "comment";

/**
 * Observed label → canonical key. Several labels collapse onto one key because the
 * console uses them interchangeably across report kinds ("Player" / "Player Name" /
 * "Login"; "Sports" / "Sport").
 */
const LABELS: Readonly<Record<GsLiveColumn, readonly string[]>> = {
  login: ["Player", "Player Name", "Login"],
  agent: ["Agent", "Agent Name"],
  bet: ["Bet", "Bets"],
  win: ["Win"],
  loss: ["Loss"],
  toWin: ["To Win"],
  profit: ["Profit"],
  pending: ["Pending"],
  gradedTotal: ["Graded total"],
  pendingTotal: ["Pending total"],
  wagerCount: ["Wager Count"],
  hold: ["Hold"],
  vigorish: ["Vigorish"],
  ratio: ["Ratio"],
  line: ["Line"],
  side: ["Side"],
  price: ["Price"],
  event: ["Event"],
  league: ["League"],
  period: ["Period"],
  market: ["Market"],
  sport: ["Sports", "Sport"],
  legs: ["Legs"],
  parlay: ["Parlay"],
  teaser: ["Teaser"],
  betTime: ["Bet time"],
  endTime: ["End time"],
  gradeTime: ["Grade time"],
  description: ["Description"],
  comment: ["Comment"],
};

/** Header comparisons ignore case, surrounding space and repeated whitespace. */
function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const BY_LABEL: ReadonlyMap<string, GsLiveColumn> = new Map(
  Object.entries(LABELS).flatMap(([column, labels]) =>
    labels.map(
      (label) => [normalizeLabel(label), column as GsLiveColumn] as const,
    ),
  ),
);

/** Canonical key for one observed header label, or `null` if never observed. */
export function canonicalizeGsLiveHeader(header: string): GsLiveColumn | null {
  return BY_LABEL.get(normalizeLabel(header)) ?? null;
}

export interface MappedHeaders {
  /** One entry per input header, in order. `null` where the label was not observed. */
  readonly columns: (GsLiveColumn | null)[];
  /** Headers that matched no known label — a schema change or a different report. */
  readonly unknown: string[];
  /** Canonical keys that appeared more than once (e.g. two "Win" columns). */
  readonly duplicates: GsLiveColumn[];
}

/** Map an exported report header row positionally, surfacing unknown labels. */
export function mapGsLiveHeaders(headers: readonly string[]): MappedHeaders {
  const columns = headers.map((header) => canonicalizeGsLiveHeader(header));
  const seen = new Set<GsLiveColumn>();
  const duplicates = new Set<GsLiveColumn>();
  for (const column of columns) {
    if (column === null) continue;
    if (seen.has(column)) duplicates.add(column);
    seen.add(column);
  }
  return {
    columns,
    unknown: headers.filter((_, index) => columns[index] === null),
    duplicates: [...duplicates],
  };
}

/** All labels known for a column, for document export ("Login (Player / Player Name)"). */
export function labelsFor(column: GsLiveColumn): readonly string[] {
  return LABELS[column];
}
