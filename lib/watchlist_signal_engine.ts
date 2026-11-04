/**
 * Watchlist signals: what the accounts we watch are actually betting, aggregated.
 *
 * Three sources feed it, each row keeping its own provenance so the verdict can be capped:
 * the graph feed's `pendingBets`, the clipboard ticker (`data/live-wagers.json`) and the Pending
 * capture (`data/live-bets.json`). The feed is currently fixture-backed, so anything derived from
 * it is marked `fixture` and the join caps that signal at `fixture_only` — a fixture row must
 * never read as observed betting flow.
 *
 * Only watchlist accounts (`getUnifiedWatchlistRegistry`) become signals; a login that is not on
 * the list is ignored rather than attributed to someone else. Parsing is deliberately strict: an
 * unparseable market string is dropped (and counted), never guessed into a side or a line.
 */
import { join } from "node:path";
import { getUnifiedWatchlistRegistry } from "./gslive_manager_watchlist.ts";
import type { WatchlistUnifiedEntry } from "./gslive_manager_watchlist.ts";

export type League = "NBA" | "NFL" | "CFB" | "EPL" | "NHL" | "MLB" | "UNKNOWN";
export type OverUnder = "over" | "under";

export interface ParsedMarket {
  readonly league: League;
  /** `moneyline`, `spread`, `total`, `team_total`, or a period-scoped kind like `1q_total`. */
  readonly marketKind: string;
  /** Team tokens as written by the source (codes when the source uses codes, else names). */
  readonly teams: readonly string[];
  readonly sideTeam: string | null;
  readonly line: number | null;
  readonly overUnder: OverUnder | null;
  readonly raw: string;
}

export interface SignalProvenance {
  readonly dataMode: string | null;
  readonly asOf: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly fixture: boolean;
  readonly sources: readonly string[];
}

export interface SignalAccount {
  readonly login: string;
  readonly agentId: string | null;
  readonly archetype: string | null;
  readonly sourceCategory: string | null;
  readonly riskUsd: number;
  readonly source: string;
}

export interface WatchlistSignal {
  readonly id: string;
  readonly league: League;
  readonly marketKind: string;
  readonly teams: readonly string[];
  readonly sideTeam: string | null;
  readonly line: number | null;
  readonly overUnder: OverUnder | null;
  readonly accounts: readonly SignalAccount[];
  readonly distinctAccounts: number;
  readonly riskUsd: number;
  /** Share of the (event, kind, line) risk that sits on this side; 1 means one-sided. */
  readonly oneSidedShare: number;
  readonly fairProb: number | null;
  readonly confidence: number;
  readonly provenance: SignalProvenance;
}

/** How much a source category counts toward confidence; the whale/syndicate flow is the point. */
const ACCOUNT_WEIGHTS: Readonly<Record<string, number>> = {
  POLY_ONCHAIN_CTF_WHALE: 40,
  POLY_PARLAY_SYNDICATE: 35,
  SUBNET_BRIDGED_SHARP: 30,
  INTERNAL_F402_SHARP: 30,
  SIX_GATE_BET1_DISCOVERY: 20,
  FUNDING_DISTRIBUTOR_ROOT: 15,
};

const LEAGUES: ReadonlySet<string> = new Set([
  "NBA",
  "NFL",
  "CFB",
  "EPL",
  "NHL",
  "MLB",
]);

const PERIOD_TOKENS: Readonly<Record<string, string>> = {
  "1Q": "1q",
  "2Q": "2q",
  "3Q": "3q",
  "4Q": "4q",
  "1H": "1h",
  "2H": "2h",
  FG: "fg",
};

const KIND_TOKENS: ReadonlySet<string> = new Set([
  "SPREAD",
  "TOTAL",
  "TEAM",
  "MONEYLINE",
  "ML",
  "WINNER",
]);

function toOverUnder(value: string | null | undefined): OverUnder | null {
  const upper = (value ?? "").toUpperCase();
  if (upper === "OVER") return "over";
  if (upper === "UNDER") return "under";
  return null;
}

/** `-750`/`+150`/`5450` (hundredths) → `-7.5`/`+1.5`/`54.5`; decimal strings pass through. */
function parseLineToken(token: string | undefined): number | null {
  if (token === undefined) return null;
  const cleaned = token.replace(/^\+/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return token.includes(".") ? value : value / 100;
}

function splitTeams(tokens: readonly string[]): readonly string[] {
  return tokens
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token !== "" && !KIND_TOKENS.has(token));
}

/**
 * Parse the feed's canonical market strings.
 *
 * Two dialects are in the feed. Underscore form is `LEAGUE_TEAMH_TEAMA[_PERIOD]_KIND[_SIDE]_LINE`
 * (`NBA_LAL_BOS_1Q_TOTAL_OVER_55.5`, `CFB_TXST_ULL_SPREAD_TXST_+14.5`,
 * `NBA_BOS_MIL_TEAM_TOTAL_BOS_OVER_118.5`). Colon form is `LEAGUE_A_B:PERIOD:KIND:HUNDREDTHS`
 * (`NBA_LAL_BOS:FG:ALT_SPREAD:-750`, `NBA_GSW_SAC:3Q:SPREAD:-150`, `NBA_DEN_PHX:2Q:TOTAL:5450`).
 * Anything else returns `null` — no guessed league, kind or line.
 */
export function parseCanonicalMarket(raw: string): ParsedMarket | null {
  const text = raw.trim();
  if (text === "") return null;
  if (text.includes(":")) return parseColonCanonical(text);
  return parseUnderscoreCanonical(text);
}

function parseColonCanonical(text: string): ParsedMarket | null {
  const parts = text.split(":");
  if (parts.length < 4) return null;
  const [head = "", periodToken = "", kindToken = "", lineToken = ""] = parts;
  const headTokens = head.split("_").filter(Boolean);
  const leagueRaw = headTokens[0] ?? "";
  const league = (LEAGUES.has(leagueRaw) ? leagueRaw : "UNKNOWN") as League;
  const teams = splitTeams(headTokens.slice(1));
  const period = PERIOD_TOKENS[periodToken.toUpperCase()] ?? null;
  const kindRaw = kindToken.toUpperCase();
  const baseKind = kindRaw.includes("SPREAD")
    ? "spread"
    : kindRaw === "TOTAL"
      ? "total"
      : kindRaw === "ML" || kindRaw === "MONEYLINE"
        ? "moneyline"
        : kindRaw === "WINNER"
          ? "moneyline"
          : null;
  if (baseKind === null) return null;
  const line = parseLineToken(lineToken);
  if (line === null) return null;
  const marketKind =
    period === null || period === "fg" ? baseKind : `${period}_${baseKind}`;
  return {
    league,
    marketKind,
    teams,
    // The colon dialect puts the line on the first team of the pair: `BOS_MIL:4Q:SPREAD:+150`
    // is BOS +1.5, `LAL_BOS:FG:ALT_SPREAD:-750` is LAL −7.5. For totals there is no side.
    sideTeam: baseKind === "spread" ? (teams[0] ?? null) : null,
    line,
    // The colon dialect encodes no over/under side; guessing "over" would invent a bet.
    overUnder: null,
    raw: text,
  };
}

function parseUnderscoreCanonical(text: string): ParsedMarket | null {
  const tokens = text.split("_").filter((token) => token !== "");
  const first = tokens[0] ?? "";
  const league = (LEAGUES.has(first) ? first : "UNKNOWN") as League;
  if (league === "UNKNOWN") return null;
  const rest = tokens.slice(1);

  let kindIndex = -1;
  let kind: "spread" | "total" | "team_total" | "moneyline" | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "TEAM" && rest[index + 1] === "TOTAL") {
      kindIndex = index;
      kind = "team_total";
      break;
    }
    if (token === "SPREAD") {
      kindIndex = index;
      kind = "spread";
      break;
    }
    if (token === "TOTAL") {
      kindIndex = index;
      kind = "total";
      break;
    }
    if (token === "MONEYLINE" || token === "ML" || token === "WINNER") {
      kindIndex = index;
      kind = "moneyline";
      break;
    }
  }
  if (kindIndex < 0 || kind === null) return null;

  let period: string | null = null;
  let teamsEnd = kindIndex;
  const beforeKind = rest[kindIndex - 1] ?? "";
  if (PERIOD_TOKENS[beforeKind] !== undefined) {
    period = PERIOD_TOKENS[beforeKind] ?? null;
    teamsEnd = kindIndex - 1;
  }
  const teams = splitTeams(rest.slice(0, teamsEnd));
  const consumed = kind === "team_total" ? kindIndex + 2 : kindIndex + 1;
  const tail = rest.slice(consumed);

  let line: number | null = null;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const candidate = parseLineToken(tail[index]);
    if (candidate !== null) {
      line = candidate;
      break;
    }
  }
  const overUnder = toOverUnder(tail.find((token) => toOverUnder(token)));
  const teamTokens = tail.filter((token) => !/^[+-]?\d/.test(token));
  const sideCandidate = teamTokens.find(
    (token) =>
      token !== "OVER" &&
      token !== "UNDER" &&
      /^[A-Z]{2,4}$/.test(token) &&
      token !== "VS" &&
      token !== "WK",
  );
  const sideTeam =
    kind === "spread" || kind === "team_total"
      ? (sideCandidate ?? null)
      : kind === "moneyline"
        ? (sideCandidate ?? teams[0] ?? null)
        : null;
  const marketKind =
    period === null || period === "fg" ? kind : `${period}_${kind}`;
  return {
    league,
    marketKind,
    teams,
    sideTeam,
    line,
    overUnder,
    raw: text,
  };
}

const SPORT_TO_LEAGUE: Readonly<Record<string, League>> = {
  BASKETBALL: "NBA",
  FOOTBALL: "NFL",
  BASEBALL: "MLB",
  HOCKEY: "NHL",
  SOCCER: "EPL",
};

const DESC_PERIOD_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/\b1st Quarter\b/i, "1q"],
  [/\b2nd Quarter\b/i, "2q"],
  [/\b3rd Quarter\b/i, "3q"],
  [/\b4th Quarter\b/i, "4q"],
  [/\b1st Half\b/i, "1h"],
  [/\b2nd Half\b/i, "2h"],
];

/**
 * Parse the clipboard ticker's `ShortDesc`, e.g.
 * `Football - Denver Broncos vs Kansas City Chiefs / Game / Total / Over 46.5 -108`.
 *
 * Team tokens here are full names: the join cannot match them to Kalshi's 2-4 letter codes, so
 * such a signal becomes `no_market` rather than a guessed game. They are kept for the dashboard.
 */
export function parseWagerShortDesc(raw: string): ParsedMarket | null {
  const text = raw
    .replace(/&#x0D;/gi, " ")
    .replace(/\r?\n/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  const headerMatch =
    /^(?:[MP]\.G\d+\s*(?:\/\s*)?)?([A-Za-z]+)\s*-\s*(.+?)\s+vs\.?\s+(.+?)\s*(?:\/|$)/.exec(
      text,
    );
  if (headerMatch === null) return null;
  const sport = (headerMatch[1] ?? "").toUpperCase();
  const league = SPORT_TO_LEAGUE[sport] ?? "UNKNOWN";
  const teamOne = (headerMatch[2] ?? "").trim().toUpperCase();
  const teamTwo = (headerMatch[3] ?? "").trim().toUpperCase();
  const segments = text.split("/").map((segment) => segment.trim());

  let period: string | null = null;
  for (const [pattern, token] of DESC_PERIOD_TOKENS) {
    if (pattern.test(text)) {
      period = token;
      break;
    }
  }

  const joined = segments.join(" | ");
  const totalMatch = /\b(Over|Under)\s+(\d+(?:\.\d+)?)/i.exec(joined);
  const spreadToken = /\b([A-Z][A-Za-z. ]+?)\s+([+-]\d+(?:\.\d+)?)\b/.exec(
    segments[segments.length - 1] ?? "",
  );
  const moneylineTeam = /^([A-Z][A-Za-z. ]+?)\s+[+-]\d{3,4}\b/.exec(
    segments[segments.length - 1] ?? "",
  )?.[1];

  let kind: string | null = null;
  if (/\bTeam Total\b/i.test(joined)) kind = "team_total";
  else if (/\bTotal\b/i.test(joined)) kind = "total";
  else if (/\bSpread\b/i.test(joined) || /\bRun Line\b/i.test(joined))
    kind = "spread";
  else if (/\bWinner|Money ?Line\b/i.test(joined)) kind = "moneyline";
  if (kind === null) return null;
  const marketKind = period === null ? kind : `${period}_${kind}`;

  const line =
    kind === "total"
      ? totalMatch === null
        ? null
        : Number(totalMatch[2])
      : kind === "spread"
        ? spreadToken === null
          ? null
          : Number(spreadToken[2])
        : null;
  const sideTeam =
    kind === "total"
      ? null
      : ((moneylineTeam ?? spreadToken?.[1])?.trim().toUpperCase() ?? null);
  return {
    league,
    marketKind,
    teams: [teamOne, teamTwo].filter((team) => team !== ""),
    sideTeam,
    line: line !== null && Number.isFinite(line) ? line : null,
    overUnder: toOverUnder(totalMatch?.[1] ?? null),
    raw: text,
  };
}

const LIVE_BETS_SPORT_TO_LEAGUE: Readonly<Record<string, League>> = {
  BASKETBALL: "NBA",
  FOOTBALL: "NFL",
  SOCCER: "EPL",
  HOCKEY: "NHL",
  BASEBALL: "MLB",
};

/** A `data/live-bets.json` game row, best effort; `null` when its market is not readable. */
export function parseLiveBetsGame(value: unknown): ParsedMarket | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const sport = String(row["sport"] ?? "").toUpperCase();
  const league = LIVE_BETS_SPORT_TO_LEAGUE[sport] ?? "UNKNOWN";
  const team1 = row["team1"];
  const team2 = row["team2"];
  const teams: string[] = [];
  if (typeof team1 === "object" && team1 !== null) {
    const name = String(
      (team1 as Record<string, unknown>)["shortName"] ?? "",
    ).trim();
    if (name !== "") teams.push(name.toUpperCase());
  }
  if (typeof team2 === "object" && team2 !== null) {
    const name = String(
      (team2 as Record<string, unknown>)["shortName"] ?? "",
    ).trim();
    if (name !== "") teams.push(name.toUpperCase());
  }
  const description = String(row["description"] ?? "");
  const periodText = String(row["period"] ?? "");
  const periodToken = /^1st Quarter/i.test(periodText)
    ? "1q"
    : /^1st Half/i.test(periodText)
      ? "1h"
      : null;
  // A spread line carries a decimal (`-1.5`); a moneyline price is a whole number (`-110`).
  const kind = /total/i.test(description)
    ? "total"
    : /\bspread\b|\bpk\b/i.test(description) || /[+-]\d+\.\d+/.test(description)
      ? "spread"
      : "moneyline";
  const overMatch = /\b(Over|Under)\s+(\d+(?:\.\d+)?)/i.exec(description);
  const chosen = String(row["chosenTeam"] ?? "")
    .trim()
    .toUpperCase();
  const lineToken = /([+-]\d+(?:\.\d+)?)/.exec(description);
  const line =
    kind === "total"
      ? overMatch === null
        ? null
        : Number(overMatch[2])
      : lineToken === null
        ? null
        : Number(lineToken[1]);
  return {
    league,
    marketKind: periodToken === null ? kind : `${periodToken}_${kind}`,
    teams,
    sideTeam: kind === "total" ? null : chosen === "" ? null : chosen,
    line: line !== null && Number.isFinite(line) ? line : null,
    overUnder: toOverUnder(overMatch?.[1] ?? null),
    raw: description,
  };
}

/** American odds → implied probability in (0,1); `null` when unparseable. */
export function americanToImpliedProbability(
  value: number | null,
): number | null {
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  const probability = value > 0 ? 100 / (value + 100) : -value / (-value + 100);
  return probability > 0 && probability < 1 ? probability : null;
}

function parseAmericanOdds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const match = /([+-]?\d{3,4})/.exec(value.replace(/[()]/g, " "));
  if (match === null) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function registryLookup(
  registry: readonly WatchlistUnifiedEntry[],
): Map<string, WatchlistUnifiedEntry> {
  const map = new Map<string, WatchlistUnifiedEntry>();
  for (const entry of registry) {
    map.set(entry.customerLogin.trim().toUpperCase(), entry);
  }
  return map;
}

const FEED_STALE_SECONDS = 180;
const CAPTURE_STALE_SECONDS = 3_600;

interface RowProvenance {
  readonly source: string;
  readonly fixture: boolean;
  readonly asOf: string | null;
  readonly dataMode: string | null;
  readonly stale: boolean;
}

interface SignalRow {
  readonly login: string;
  readonly agentId: string | null;
  readonly archetype: string | null;
  readonly sourceCategory: string | null;
  readonly riskUsd: number;
  readonly oddsAmerican: number | null;
  readonly parsed: ParsedMarket;
  readonly provenance: RowProvenance;
}

function ageSeconds(asOf: string | null, now: Date): number | null {
  if (asOf === null) return null;
  const parsed = Date.parse(asOf);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.floor((now.getTime() - parsed) / 1000))
    : null;
}

function rowProvenance(
  source: string,
  recordedAsOf: string | null,
  fallbackAsOf: string | null,
  staleAfterSeconds: number,
  now: Date,
  options: { fixture: boolean; dataMode: string | null },
): RowProvenance {
  const asOf = recordedAsOf ?? fallbackAsOf;
  const age = ageSeconds(asOf, now);
  return {
    source,
    fixture: options.fixture,
    asOf,
    dataMode: options.dataMode,
    stale: age !== null && age > staleAfterSeconds,
  };
}

export interface WatchlistSignalInputs {
  /** Parsed `docs/graph-live-feed.json` (or `null`). */
  readonly feed: unknown;
  readonly wagers: unknown;
  /** Fallback asOf for the wagers artifact when it records no `observedAt` (file mtime ISO). */
  readonly wagersAsOf?: string | null;
  readonly liveBets: unknown;
}

/** Feed rows: `pendingBets[]`, provenance from the feed's own `provenance.f402`. */
function rowsFromFeed(
  feed: unknown,
  registry: Map<string, WatchlistUnifiedEntry>,
  now: Date,
): SignalRow[] {
  if (typeof feed !== "object" || feed === null) return [];
  const record = feed as Record<string, unknown>;
  const provenance =
    typeof record["provenance"] === "object" && record["provenance"] !== null
      ? (record["provenance"] as Record<string, unknown>)
      : {};
  const f402 =
    typeof provenance["f402"] === "object" && provenance["f402"] !== null
      ? (provenance["f402"] as Record<string, unknown>)
      : {};
  const dataMode =
    typeof record["dataMode"] === "string" ? record["dataMode"] : null;
  const fixture =
    f402["source"] === "fixture" ||
    dataMode === "FIXTURE" ||
    (typeof f402["source"] === "string" && f402["source"].includes("fixture"));
  const asOf =
    typeof record["lastUpdatedIso"] === "string"
      ? record["lastUpdatedIso"]
      : null;
  const rows: SignalRow[] = [];
  const pending = Array.isArray(record["pendingBets"])
    ? record["pendingBets"]
    : [];
  for (const raw of pending) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const login = String(row["f402CustomerId"] ?? "")
      .trim()
      .toUpperCase();
    const entry = registry.get(login);
    if (entry === undefined) continue;
    const canonical = String(row["canonicalMarket"] ?? "");
    const parsed = parseCanonicalMarket(canonical);
    if (parsed === null) continue;
    const risk = Number(row["riskUsd"]);
    rows.push({
      login: entry.customerLogin,
      agentId: String(row["agentOwner"] ?? entry.agentId),
      archetype: entry.archetype,
      sourceCategory: entry.sourceCategory,
      riskUsd: Number.isFinite(risk) ? Math.max(0, risk) : 0,
      oddsAmerican: parseAmericanOdds(row["oddsAmerican"]),
      parsed,
      provenance: rowProvenance(
        "docs/graph-live-feed.json",
        asOf,
        null,
        FEED_STALE_SECONDS,
        now,
        { fixture, dataMode },
      ),
    });
  }
  return rows;
}

function rowsFromWagers(
  wagers: unknown,
  registry: Map<string, WatchlistUnifiedEntry>,
  fallbackAsOf: string | null,
  now: Date,
): SignalRow[] {
  if (typeof wagers !== "object" || wagers === null) return [];
  const record = wagers as Record<string, unknown>;
  const list = Array.isArray(record["LIST"])
    ? record["LIST"]
    : Array.isArray(record["list"])
      ? record["list"]
      : [];
  const observedAt =
    typeof record["observedAt"] === "string" ? record["observedAt"] : null;
  const rows: SignalRow[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const login = String(row["Login"] ?? row["CustomerID"] ?? "")
      .trim()
      .toUpperCase();
    const entry = registry.get(login);
    if (entry === undefined) continue;
    const parsed = parseWagerShortDesc(String(row["ShortDesc"] ?? ""));
    if (parsed === null) continue;
    const wageredCents = Number(row["AmountWagered"]);
    rows.push({
      login: entry.customerLogin,
      agentId: String(row["AgentID"] ?? entry.agentId),
      archetype: entry.archetype,
      sourceCategory: entry.sourceCategory,
      riskUsd: Number.isFinite(wageredCents)
        ? Math.max(0, wageredCents / 100)
        : 0,
      oddsAmerican: parseAmericanOdds(
        /([+-]\d{3,4})\b/.exec(String(row["ShortDesc"] ?? ""))?.[1] ?? null,
      ),
      parsed,
      provenance: rowProvenance(
        "data/live-wagers.json",
        observedAt,
        fallbackAsOf,
        CAPTURE_STALE_SECONDS,
        now,
        {
          fixture:
            typeof record["source"] === "string" &&
            record["source"].includes("fixture"),
          dataMode: null,
        },
      ),
    });
  }
  return rows;
}

function rowsFromLiveBets(
  liveBets: unknown,
  registry: Map<string, WatchlistUnifiedEntry>,
  now: Date,
): SignalRow[] {
  if (typeof liveBets !== "object" || liveBets === null) return [];
  const record = liveBets as Record<string, unknown>;
  const games = Array.isArray(record["games"]) ? record["games"] : [];
  const capturedAt =
    typeof record["capturedAt"] === "string" ? record["capturedAt"] : null;
  const dataSource =
    typeof record["dataSource"] === "string" ? record["dataSource"] : "";
  const rows: SignalRow[] = [];
  for (const raw of games) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const login = String(row["customerID"] ?? "")
      .trim()
      .toUpperCase();
    const entry = registry.get(login);
    if (entry === undefined) continue;
    const parsed = parseLiveBetsGame(raw);
    if (parsed === null) continue;
    const wageredCents = Number(row["wagered"]);
    rows.push({
      login: entry.customerLogin,
      agentId: entry.agentId,
      archetype: entry.archetype,
      sourceCategory: entry.sourceCategory,
      riskUsd: Number.isFinite(wageredCents)
        ? Math.max(0, wageredCents / 100)
        : 0,
      oddsAmerican: parseAmericanOdds(
        /([+-]\d{3,4})\b/.exec(String(row["description"] ?? ""))?.[1] ?? null,
      ),
      parsed,
      provenance: rowProvenance(
        "data/live-bets.json",
        capturedAt,
        null,
        CAPTURE_STALE_SECONDS,
        now,
        { fixture: dataSource.includes("fixture"), dataMode: null },
      ),
    });
  }
  return rows;
}

function sideKey(parsed: ParsedMarket): string {
  if (parsed.overUnder !== null) return parsed.overUnder;
  if (parsed.sideTeam !== null) return parsed.sideTeam;
  if (parsed.line !== null) return parsed.line > 0 ? "positive" : "negative";
  return "none";
}

function signalId(parsed: ParsedMarket, side: string): string {
  return [
    parsed.league,
    [...parsed.teams].sort().join("_"),
    parsed.marketKind,
    parsed.line === null ? "noline" : String(parsed.line).replace("-", "m"),
    side,
  ].join("-");
}

/**
 * Aggregate watchlist rows into signals.
 *
 * Grouping is (league, team set, market kind, line) and then side, so two accounts on opposite
 * sides of the same total are two signals whose `oneSidedShare` is each side's share. A group
 * derived from any fixture row is flagged `fixture` — one fixture row is enough to cap it.
 */
export function aggregateWatchlistSignals(
  rows: readonly SignalRow[],
  now: Date = new Date(),
): WatchlistSignal[] {
  const baseGroups = new Map<string, SignalRow[]>();
  for (const row of rows) {
    const baseKey = [
      row.parsed.league,
      [...row.parsed.teams].sort().join("_"),
      row.parsed.marketKind,
      row.parsed.line === null ? "noline" : String(row.parsed.line),
    ].join("|");
    const bucket = baseGroups.get(baseKey);
    if (bucket === undefined) baseGroups.set(baseKey, [row]);
    else bucket.push(row);
  }

  const signals: WatchlistSignal[] = [];
  for (const bucket of baseGroups.values()) {
    const sideGroups = new Map<string, SignalRow[]>();
    for (const row of bucket) {
      const key = sideKey(row.parsed);
      const sideRows = sideGroups.get(key);
      if (sideRows === undefined) sideGroups.set(key, [row]);
      else sideRows.push(row);
    }
    const totalRisk = bucket.reduce((sum, row) => sum + row.riskUsd, 0);
    for (const [side, sideRows] of sideGroups) {
      const riskUsd = sideRows.reduce((sum, row) => sum + row.riskUsd, 0);
      const accounts = new Map<string, SignalAccount>();
      for (const row of sideRows) {
        const existing = accounts.get(row.login);
        accounts.set(row.login, {
          login: row.login,
          agentId: row.agentId,
          archetype: row.archetype,
          sourceCategory: row.sourceCategory,
          riskUsd: (existing?.riskUsd ?? 0) + row.riskUsd,
          source: row.provenance.source,
        });
      }
      let weightedProb = 0;
      let probabilityWeight = 0;
      for (const row of sideRows) {
        const probability = americanToImpliedProbability(row.oddsAmerican);
        if (probability === null) continue;
        const weight = Math.max(1, row.riskUsd);
        weightedProb += probability * weight;
        probabilityWeight += weight;
      }
      let confidence = 0;
      for (const row of sideRows) {
        const weight = ACCOUNT_WEIGHTS[row.sourceCategory ?? ""] ?? 10;
        const riskFactor = 0.5 + 0.5 * Math.min(1, row.riskUsd / 5_000);
        confidence += weight * riskFactor;
      }
      const first = sideRows[0];
      if (first === undefined) continue;
      const asOfTimes = sideRows
        .map((row) => row.provenance.asOf)
        .filter((value): value is string => value !== null)
        .sort();
      const asOf = asOfTimes[asOfTimes.length - 1] ?? null;
      const age = ageSeconds(asOf, now);
      const parsed = first.parsed;
      signals.push({
        id: signalId(parsed, side),
        league: parsed.league,
        marketKind: parsed.marketKind,
        teams: [...parsed.teams],
        sideTeam: parsed.sideTeam,
        line: parsed.line,
        overUnder: parsed.overUnder,
        accounts: [...accounts.values()].sort((a, b) => b.riskUsd - a.riskUsd),
        distinctAccounts: accounts.size,
        riskUsd: Math.round(riskUsd),
        oneSidedShare:
          totalRisk > 0 ? Math.round((riskUsd / totalRisk) * 1000) / 1000 : 1,
        fairProb:
          probabilityWeight > 0
            ? Math.round((weightedProb / probabilityWeight) * 10_000) / 10_000
            : null,
        confidence: Math.min(100, Math.round(confidence)),
        provenance: {
          dataMode: first.provenance.dataMode,
          asOf,
          ageSeconds: age,
          stale: sideRows.some((row) => row.provenance.stale),
          fixture: sideRows.some((row) => row.provenance.fixture),
          sources: [
            ...new Set(sideRows.map((row) => row.provenance.source)),
          ].sort(),
        },
      });
    }
  }
  return signals.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.riskUsd - a.riskUsd ||
      a.id.localeCompare(b.id),
  );
}

export interface DeriveWatchlistSignalsOptions {
  readonly now?: Date;
  readonly registry?: readonly WatchlistUnifiedEntry[];
}

/** Pure derivation: parsed inputs in, signals out. */
export function deriveWatchlistSignals(
  inputs: WatchlistSignalInputs,
  options: DeriveWatchlistSignalsOptions = {},
): WatchlistSignal[] {
  const now = options.now ?? new Date();
  const registry = registryLookup(
    options.registry ?? getUnifiedWatchlistRegistry(),
  );
  const rows = [
    ...rowsFromFeed(inputs.feed, registry, now),
    ...rowsFromWagers(inputs.wagers, registry, inputs.wagersAsOf ?? null, now),
    ...rowsFromLiveBets(inputs.liveBets, registry, now),
  ];
  return aggregateWatchlistSignals(rows, now);
}

/* -------------------------------------------------------------------------- */
/* Artifact loading                                                           */
/* -------------------------------------------------------------------------- */

const FEED_PATH = "docs/graph-live-feed.json";
const WAGERS_PATH = "data/live-wagers.json";
const LIVE_BETS_PATH = "data/live-bets.json";

/**
 * Read raw JSON directly, not through `cachedJsonFile`.
 *
 * The shared artifact cache is keyed by path alone, so a second parser for the same file
 * returns the first parser's value: registering a raw identity parser for
 * `data/live-wagers.json` here poisoned the server's typed reader in one process (the
 * `/api/kpis` arm then read `provenance` off a raw object and 500'd). These are small,
 * per-request reads; correctness over an 0.1 ms saving.
 */
async function readArtifact(path: string): Promise<unknown | null> {
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

/** Read the three local sources (no network), with the wagers file's mtime as its asOf. */
export async function loadWatchlistSignalInputs(
  root: string,
): Promise<WatchlistSignalInputs> {
  const [feed, wagers, liveBets] = await Promise.all([
    readArtifact(join(root, FEED_PATH)),
    readArtifact(join(root, WAGERS_PATH)),
    readArtifact(join(root, LIVE_BETS_PATH)),
  ]);
  let wagersAsOf: string | null = null;
  try {
    const stat = await Bun.file(join(root, WAGERS_PATH)).stat();
    wagersAsOf = stat.mtime.toISOString();
  } catch {
    wagersAsOf = null;
  }
  return {
    feed: feed ?? null,
    wagers: wagers ?? null,
    wagersAsOf,
    liveBets: liveBets ?? null,
  };
}
