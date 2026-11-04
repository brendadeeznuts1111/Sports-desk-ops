/**
 * @file gslive_report_columns.ts
 * @description Last Bets (GS Manager Tools → Events → Bet History) column and filter catalog.
 *
 * Observed in the live browser 2026-11-03 (Table settings shows 53 / 53): 52 named columns plus
 * the row-selection checkbox. The checkbox is modeled separately and is not a wire field until a
 * table-schema capture confirms it. Wire mappings are best-effort against
 * `Scratch/betReport-all.json` (69 raw keys); `null` means UI-only or a nested/derived value.
 */
export const UI_LAST_BETS_SLOT_COUNT = 53;
export const UI_LAST_BETS_NAMED_COLUMN_COUNT = 52;
export interface LastBetsColumn {
  readonly index: number;
  readonly label: string;
  readonly column: string;
  readonly wireKey: string | null;
}
export const LAST_BETS_COLUMNS: readonly LastBetsColumn[] = [
  { index: 1, label: "Bet Group", column: "betGroup", wireKey: "betGroupId" },
  { index: 2, label: "Id", column: "id", wireKey: "id" },
  { index: 3, label: "Player", column: "player", wireKey: "userID" },
  { index: 4, label: "Player Id", column: "playerId", wireKey: "playerId" },
  { index: 5, label: "Profile", column: "profile", wireKey: "profile" },
  { index: 6, label: "Agent", column: "agent", wireKey: "agent" },
  { index: 7, label: "Ticket", column: "ticket", wireKey: "ticketNumber" },
  { index: 8, label: "If bet", column: "ifBet", wireKey: "ifBet" },
  { index: 9, label: "Risk", column: "risk", wireKey: "bet" },
  { index: 10, label: "To Win", column: "toWin", wireKey: "betGroupToWin" },
  {
    index: 11,
    label: "Then bet",
    column: "thenBet",
    wireKey: "reversedCredit",
  },
  { index: 12, label: "Premium", column: "premium", wireKey: "premium" },
  { index: 13, label: "Result", column: "result", wireKey: "betGroupResult" },
  { index: 14, label: "Free bet", column: "freeBet", wireKey: "isFreePlay" },
  {
    index: 15,
    label: "Sport / League",
    column: "sportLeague",
    wireKey: null,
  },
  {
    index: 16,
    label: "Sport (SportId)",
    column: "sportSportId",
    wireKey: "displaySportId",
  },
  {
    index: 17,
    label: "League (LeagueId)",
    column: "leagueLeagueId",
    wireKey: "lID",
  },
  { index: 18, label: "Event Id", column: "eventId", wireKey: "eID" },
  { index: 19, label: "Event Details", column: "eventDetails", wireKey: "ev" },
  { index: 20, label: "Bet price", column: "betPrice", wireKey: "fVal" },
  { index: 21, label: "Period", column: "period", wireKey: "period" },
  {
    index: 22,
    label: "Market",
    column: "market",
    wireKey: "marketTypeCategory",
  },
  {
    index: 23,
    label: "Market Id",
    column: "marketId",
    wireKey: "betDetails.m",
  },
  { index: 24, label: "Side", column: "side", wireKey: "team1" },
  { index: 25, label: "Open Spots", column: "openSpots", wireKey: "openSpots" },
  { index: 26, label: "Prop figure", column: "propFigure", wireKey: null },
  { index: 27, label: "Contestant", column: "contestant", wireKey: "team2" },
  { index: 28, label: "Figure", column: "figure", wireKey: null },
  {
    index: 29,
    label: "Wager Type Category",
    column: "wagerTypeCategory",
    wireKey: null,
  },
  { index: 30, label: "Logs", column: "logs", wireKey: null },
  {
    index: 31,
    label: "Time Until Score",
    column: "timeUntilScore",
    wireKey: null,
  },
  { index: 32, label: "Bet Time", column: "betTime", wireKey: "acceptTime" },
  { index: 33, label: "Bet Time (Day)", column: "betTimeDay", wireKey: null },
  {
    index: 34,
    label: "Bet Time (Month)",
    column: "betTimeMonth",
    wireKey: null,
  },
  { index: 35, label: "Bet Time (Hour)", column: "betTimeHour", wireKey: null },
  {
    index: 36,
    label: "Bet Time (Minutes)",
    column: "betTimeMinutes",
    wireKey: null,
  },
  {
    index: 37,
    label: "Bet Time (Seconds)",
    column: "betTimeSeconds",
    wireKey: null,
  },
  { index: 38, label: "Grade Time", column: "gradeTime", wireKey: "gradeTime" },
  { index: 39, label: "State", column: "state", wireKey: "state" },
  { index: 40, label: "Accept Type", column: "acceptType", wireKey: "accept" },
  { index: 41, label: "Actions", column: "actions", wireKey: null },
  { index: 42, label: "Type", column: "type", wireKey: "type" },
  { index: 43, label: "IP Address", column: "ipAddress", wireKey: "ipAddress" },
  {
    index: 44,
    label: "Featured Bet Id",
    column: "featuredBetId",
    wireKey: null,
  },
  {
    index: 45,
    label: "Featured Bet Price",
    column: "featuredBetPrice",
    wireKey: null,
  },
  {
    index: 46,
    label: "Disclaimer",
    column: "disclaimer",
    wireKey: "disclaimer",
  },
  {
    index: 47,
    label: "Teaser Name",
    column: "teaserName",
    wireKey: "teaserName",
  },
  { index: 48, label: "Admin User", column: "adminUser", wireKey: "adminUser" },
  {
    index: 49,
    label: "Uncorrelated Odds",
    column: "uncorrelatedOdds",
    wireKey: "finalUncorrelatedOdds",
  },
  { index: 50, label: "Partner", column: "partner", wireKey: "partnerID" },
  {
    index: 51,
    label: "User Group Id",
    column: "userGroupId",
    wireKey: "userGroupId",
  },
  { index: 52, label: "Delay", column: "delay", wireKey: "delay" },
] as const;
export const ROW_SELECTION_COLUMN = {
  index: 53,
  label: "Row selection",
  column: "rowSelection",
  wireKey: null,
} as const;
export type GsLiveColumn =
  (typeof LAST_BETS_COLUMNS)[number]["column"] | "rowSelection";
export interface LastBetsFilter {
  readonly label: string;
  readonly control: string;
  readonly bodyKeys: readonly string[];
}
export const LAST_BETS_FILTERS: readonly LastBetsFilter[] = [
  {
    label: "Date range (with Grade time / Bet time basis)",
    control: "dateRange",
    bodyKeys: ["from", "to", "dateFilterBy"],
  },
  { label: "Player", control: "player", bodyKeys: ["partnerUserId"] },
  { label: "Agent", control: "agent", bodyKeys: ["agent"] },
  { label: "Event Id", control: "eventId", bodyKeys: ["eventId"] },
  { label: "Bet Id", control: "betId", bodyKeys: ["betId"] },
  { label: "Bet Group Id", control: "betGroupId", bodyKeys: ["betGroupId"] },
  { label: "Group Kind", control: "groupKind", bodyKeys: ["group"] },
  { label: "Group Name", control: "groupName", bodyKeys: ["group"] },
  { label: "Free Bet Id", control: "freeBetId", bodyKeys: ["freeBetId"] },
  { label: "State", control: "state", bodyKeys: ["state"] },
  { label: "Sport", control: "sport", bodyKeys: ["sId"] },
  { label: "Period", control: "period", bodyKeys: ["period"] },
  { label: "Min Wager", control: "minWager", bodyKeys: ["minVolume"] },
  {
    label: "Max Time Until Score",
    control: "maxTimeUntilScore",
    bodyKeys: ["maxTimeUntilScore"],
  },
  { label: "Market", control: "market", bodyKeys: ["mId"] },
] as const;
export const LAST_BETS_FILTER_COUNT = 15;
const ALIASES: Readonly<Record<string, GsLiveColumn>> = {
  "Player Name": "player",
  Login: "player",
  "Player Id": "playerId",
  Agent: "agent",
  Ticket: "ticket",
  "If bet": "ifBet",
  Bet: "risk",
  Bets: "risk",
  "To Win": "toWin",
  "Then bet": "thenBet",
  Result: "result",
  "Free bet": "freeBet",
  "Sport / League": "sportLeague",
  Sports: "sportLeague",
  Sport: "sportLeague",
  "Sport (SportId)": "sportSportId",
  "League (LeagueId)": "leagueLeagueId",
  "Event Id": "eventId",
  "Event Details": "eventDetails",
  "Bet price": "betPrice",
  Period: "period",
  Market: "market",
  "Market Id": "marketId",
  "Open Spots": "openSpots",
  "Prop figure": "propFigure",
  Contestant: "contestant",
  Figure: "figure",
  "Wager Type Category": "wagerTypeCategory",
  Logs: "logs",
  "Time Until Score": "timeUntilScore",
  "Bet Time": "betTime",
  "Bet Time (Day)": "betTimeDay",
  "Bet Time (Month)": "betTimeMonth",
  "Bet Time (Hour)": "betTimeHour",
  "Bet Time (Minutes)": "betTimeMinutes",
  "Bet Time (Seconds)": "betTimeSeconds",
  "Grade Time": "gradeTime",
  State: "state",
  "Accept Type": "acceptType",
  Actions: "actions",
  Type: "type",
  "IP Address": "ipAddress",
  "Featured Bet Id": "featuredBetId",
  "Featured Bet Price": "featuredBetPrice",
  Disclaimer: "disclaimer",
  "Teaser Name": "teaserName",
  "Admin User": "adminUser",
  "Uncorrelated Odds": "uncorrelatedOdds",
  Partner: "partner",
  "User Group Id": "userGroupId",
  Delay: "delay",
  "Row selection": "rowSelection",
};
function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
const BY_LABEL: ReadonlyMap<string, GsLiveColumn> = new Map([
  ...LAST_BETS_COLUMNS.map(
    (c) => [normalizeLabel(c.label), c.column as GsLiveColumn] as const,
  ),
  ...Object.entries(ALIASES).map(
    ([label, column]) => [normalizeLabel(label), column] as const,
  ),
]);
export function labelsFor(column: GsLiveColumn): readonly string[] {
  const labels: string[] = LAST_BETS_COLUMNS.filter(
    (c) => c.column === column,
  ).map((c) => c.label);
  for (const [label, value] of Object.entries(ALIASES))
    if (value === column && !labels.includes(label)) labels.push(label);
  return labels;
}

export function canonicalizeGsLiveHeader(header: string): GsLiveColumn | null {
  return BY_LABEL.get(normalizeLabel(header)) ?? null;
}
export interface MappedHeaders {
  readonly columns: (GsLiveColumn | null)[];
  readonly unknown: string[];
  readonly duplicates: GsLiveColumn[];
}
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
    unknown: headers.filter((_, i) => columns[i] === null),
    duplicates: [...duplicates],
  };
}
/** Structural self-check used by the contracts test. */
export function verifyLastBetsCatalog(): {
  slots: number;
  named: number;
  filters: number;
  mapped: number;
  unmapped: number;
} {
  const mapped = LAST_BETS_COLUMNS.filter((c) => c.wireKey !== null).length;
  return {
    slots: UI_LAST_BETS_SLOT_COUNT,
    named: LAST_BETS_COLUMNS.length,
    filters: LAST_BETS_FILTERS.length,
    mapped,
    unmapped: LAST_BETS_COLUMNS.length - mapped,
  };
}
