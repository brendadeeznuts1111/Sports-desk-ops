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

/** `team1`/`team2` carry the sport ("Soccer") and the market type ("Market") on some rows. */
function isPlaceholderTeamName(name: string, sport: string): boolean {
  const upper = name.trim().toUpperCase();
  return (
    upper === "" || upper === "MARKET" || upper === sport.trim().toUpperCase()
  );
}

const FRACTION_VALUES: Readonly<Record<string, number>> = {
  "½": 0.5,
  "¼": 0.25,
  "¾": 0.75,
};

/** A line token: `1`, `1.5`, `1½`, `½` — the capture writes halves as U+00BD. */
const LINE_TOKEN = String.raw`\d{1,2}(?:\.\d+)?[½¼¾]?|[½¼¾]`;

const SIGNED_LINE_PATTERN = new RegExp(`^([+-]?)\\s*(${LINE_TOKEN})$`);
/** A signed spread selection: `Arsenal -1½`, `Betis +½,+1`. */
const SPREAD_SELECTION_PATTERN = new RegExp(
  `^(.*?)\\s+([+-](?:${LINE_TOKEN})(?:,(?:[+-])?(?:${LINE_TOKEN}))?)$`,
);

/** `2½` → 2.5, `½` → 0.5, `2.5` → 2.5; `null` when the token is not a line number. */
function parseLineNumber(token: string): number | null {
  const trimmed = token.trim();
  if (trimmed === "") return null;
  const match = /^(\d+)?\s*([½¼¾])?$/.exec(trimmed);
  if (match !== null && (match[1] !== undefined || match[2] !== undefined)) {
    const whole = match[1] === undefined ? 0 : Number(match[1]);
    const fraction =
      match[2] === undefined ? 0 : (FRACTION_VALUES[match[2]] ?? 0);
    return whole + fraction;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** A signed line token (`-1½`, `+1`, `½`) → its number; `null` when it is not a line. */
function parseSignedLine(token: string): number | null {
  const match = SIGNED_LINE_PATTERN.exec(token.trim());
  if (match === null) return null;
  const magnitude = parseLineNumber(match[2] ?? "");
  if (magnitude === null) return null;
  return (match[1] === "-" ? -1 : 1) * magnitude;
}

/** A split line (`2½,3`, `+½,+1`) is one market; its effective line is the midpoint. */
function parseLineExpression(token: string): number | null {
  const parts = token.split(",");
  if (parts.length === 0 || parts.length > 2) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseSignedLine(part);
    if (value === null) return null;
    values.push(value);
  }
  if (values.length === 1) return values[0] ?? null;
  return ((values[0] ?? 0) + (values[1] ?? 0)) / 2;
}

/**
 * The selection text of one live-bets row.
 *
 * `chosenTeam` is the leg's selection (`Arsenal -1½ -120`); `description` may hold every leg of
 * a parlay, so it is only a fallback and is cut down to its first leg.
 */
function liveBetsSelectionText(row: Record<string, unknown>): string {
  const chosen = String(row["chosenTeam"] ?? "").trim();
  if (chosen !== "") return chosen;
  const description = String(row["description"] ?? "");
  const firstLeg =
    (description.split("|")[0] ?? "").split(
      /\s+-\s+For\s+(?:Game|1st Half|2nd Half)/i,
    )[0] ?? "";
  return firstLeg.replace(/^[A-Za-z.]*\s*#\d+\s+/, "").trim();
}

interface LiveBetsSelection {
  readonly teams: readonly string[];
  readonly marketKind: "moneyline" | "spread" | "total" | "team_total";
  readonly sideTeam: string | null;
  readonly line: number | null;
  readonly overUnder: OverUnder | null;
}

/**
 * Parse a soccer selection label.
 *
 * The capture names the pick, not the sides: `Arsenal -380` (moneyline), `Arsenal -1½ -120`
 * (spread), `Arsenal/Slavia Praha O 2½ -130` (match total), `Como O 1½ -140` (team total),
 * `Draw ( Betis vs Borussia Dortmund ) +160`, with `½`/`¼`/`¾` fractions and split lines
 * (`-½,-1`). Returns `null` when the label holds no readable market.
 */
function parseSoccerSelection(text: string): LiveBetsSelection | null {
  let cleaned = text.replace(/\s+/g, " ").trim();
  // A futures label prefixes the pick with `#`-separated path segments.
  if (cleaned.startsWith("#")) {
    const lastSegment = cleaned.lastIndexOf(" - ");
    if (lastSegment >= 0) cleaned = cleaned.slice(lastSegment + 3);
    cleaned = cleaned.replace(/#/g, " ").replace(/\s+/g, " ").trim();
  }
  cleaned = cleaned.replace(/\s+(?:-\s*)?for\s+game\s*$/i, "").trim();
  // American odds are the trailing signed 3-5 digit token; a price is never a line.
  const priceMatch = /\s([+-]\d{3,5})\s*$/.exec(cleaned);
  const body = (
    priceMatch === null ? cleaned : cleaned.slice(0, priceMatch.index)
  ).trim();
  if (body === "") return null;

  const total = /^(.*?)\s+(Over|Under|O|U)\s+([0-9½¼¾.,+-]+)$/i.exec(body);
  if (total !== null) {
    const subject = (total[1] ?? "").trim();
    const marker = (total[2] ?? "").toUpperCase();
    const line = parseLineExpression(total[3] ?? "");
    if (subject === "" || line === null) return null;
    const overUnder: OverUnder = marker.startsWith("O") ? "over" : "under";
    const halves = subject
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (halves.length === 2) {
      return {
        teams: halves.map((part) => part.toUpperCase()),
        marketKind: "total",
        sideTeam: null,
        line,
        overUnder,
      };
    }
    return {
      teams: [subject.toUpperCase()],
      marketKind: "team_total",
      sideTeam: subject.toUpperCase(),
      line,
      overUnder,
    };
  }

  // A spread line is signed and small (`-1½`); a price is three or more digits.
  const spread = SPREAD_SELECTION_PATTERN.exec(body);
  if (spread !== null) {
    const subject = (spread[1] ?? "").trim();
    const line = parseLineExpression(spread[2] ?? "");
    if (subject === "" || line === null) return null;
    const names = subject
      .split("/")
      .map((part) => part.trim().toUpperCase())
      .filter((part) => part !== "");
    return {
      teams: names,
      marketKind: "spread",
      sideTeam: names[0] ?? null,
      line,
      overUnder: null,
    };
  }

  const spreadPk = /^(.*?)\s+PK$/i.exec(body);
  if (spreadPk !== null) {
    const subject = (spreadPk[1] ?? "").trim();
    if (subject === "") return null;
    const names = subject
      .split("/")
      .map((part) => part.trim().toUpperCase())
      .filter((part) => part !== "");
    return {
      teams: names,
      marketKind: "spread",
      sideTeam: names[0] ?? null,
      line: 0,
      overUnder: null,
    };
  }

  const draw = /^Draw\s*\(\s*(.+?)\s+vs\.?\s+(.+?)\s*\)$/i.exec(body);
  if (draw !== null) {
    const teams = [draw[1] ?? "", draw[2] ?? ""]
      .map((part) => part.trim().toUpperCase())
      .filter((part) => part !== "");
    if (teams.length === 2) {
      return {
        teams,
        marketKind: "moneyline",
        sideTeam: "DRAW",
        line: null,
        overUnder: null,
      };
    }
  }

  const names = body
    .split("/")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== "");
  if (names.length === 0) return null;
  return {
    teams: names,
    marketKind: "moneyline",
    sideTeam: names[0] ?? null,
    line: null,
    overUnder: null,
  };
}

/**
 * A `data/live-bets.json` game row, best effort; `null` when its market is not readable.
 *
 * Soccer rows put the sport and the market type in `team1`/`team2` (`Soccer`/`Market`), so the
 * sides and the market come from the selection text; every other sport keeps the description
 * parse, where the captured team names are real.
 */
export function parseLiveBetsGame(value: unknown): ParsedMarket | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const sport = String(row["sport"] ?? "").toUpperCase();
  const league = LIVE_BETS_SPORT_TO_LEAGUE[sport] ?? "UNKNOWN";
  const teamName = (side: unknown): string => {
    if (typeof side !== "object" || side === null) return "";
    return String((side as Record<string, unknown>)["shortName"] ?? "").trim();
  };
  const description = String(row["description"] ?? "");
  const periodText = String(row["period"] ?? "");
  const periodToken = /^1st Quarter/i.test(periodText)
    ? "1q"
    : /^1st Half/i.test(periodText)
      ? "1h"
      : null;
  const marketKind = (kind: string): string =>
    periodToken === null ? kind : `${periodToken}_${kind}`;

  if (sport === "SOCCER") {
    const selectionText = liveBetsSelectionText(row);
    const selection = parseSoccerSelection(selectionText);
    if (selection !== null) {
      const captured = [teamName(row["team1"]), teamName(row["team2"])]
        .filter((name) => !isPlaceholderTeamName(name, sport))
        .map((name) => name.toUpperCase());
      return {
        league,
        marketKind: marketKind(selection.marketKind),
        teams: captured.length === 2 ? captured : [...selection.teams],
        sideTeam: selection.sideTeam,
        line: selection.line,
        overUnder: selection.overUnder,
        raw: selectionText === "" ? description : selectionText,
      };
    }
  }

  const teams = [teamName(row["team1"]), teamName(row["team2"])]
    .filter((name) => name !== "")
    .map((name) => name.toUpperCase());
  const chosen = String(row["chosenTeam"] ?? "")
    .trim()
    .toUpperCase();
  // A spread line carries a decimal (`-1.5`); a moneyline price is a whole number (`-110`).
  const kind = /total/i.test(description)
    ? "total"
    : /\bspread\b|\bpk\b/i.test(description) || /[+-]\d+\.\d+/.test(description)
      ? "spread"
      : "moneyline";
  const overMatch = /\b(Over|Under)\s+(\d+(?:\.\d+)?)/i.exec(description);
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
    marketKind: marketKind(kind),
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
// Both are defaults only: a caller that supplies a window (the CLI passes
// config.maxSignalAgeSeconds) overrides them, so status, the board chip, the engine's
// `provenance.stale` and the freshness gate all measure the same thing.

interface RowProvenance {
  readonly source: string;
  readonly fixture: boolean;
  /**
   * The observation instant as epoch milliseconds, never a string.
   *
   * Timestamps arrive as strings and are converted exactly once at the artifact boundary; the
   * row layout carries the number so age, staleness, aggregation and candidate ranking never
   * re-parse (or re-format) the same instant. ISO strings are materialized at the public
   * boundary, once per signal rather than once per row.
   */
  readonly asOfMs: number | null;
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

function ageSecondsFromMs(asOfMs: number | null, nowMs: number): number | null {
  return asOfMs === null
    ? null
    : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
}

function isoToEpochMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowProvenance(
  source: string,
  recordedAsOfMs: number | null,
  fallbackAsOfMs: number | null,
  staleAfterSeconds: number,
  nowMs: number,
  options: { fixture: boolean; dataMode: string | null },
): RowProvenance {
  const asOfMs = recordedAsOfMs ?? fallbackAsOfMs;
  const age = ageSecondsFromMs(asOfMs, nowMs);
  // A bet cannot be accepted after it was read. A clock that lands in the future is a
  // broken/unknown clock, never evidence of freshness, so it is refused as stale.
  const future =
    asOfMs !== null && asOfMs - nowMs > FUTURE_TOLERANCE_SECONDS * 1_000;
  return {
    source,
    fixture: options.fixture,
    asOfMs,
    dataMode: options.dataMode,
    stale: future || (age !== null && age > staleAfterSeconds),
  };
}

/** How far ahead of "now" a portal timestamp may sit before the clock is treated as wrong. */
const FUTURE_TOLERANCE_SECONDS = 120;

/** The portal's wall-clock zone. Evidence (2026-11-04): live-captured rows land 3.7 min
 * before the measurement instant only when read as America/New_York — UTC is ~5 h early
 * and the desk's own Central clock is ~56 min in the future — so the portal writes Eastern. */
const PORTAL_TIME_ZONE = "America/New_York";

/**
 * One `Intl.DateTimeFormat` per zone, built once and reused.
 *
 * Constructing a formatter costs ~25 µs (measured 2026-11-04), while `formatToParts` on a
 * shared instance costs ~1 µs. A per-row `new Intl.DateTimeFormat(...)` therefore turned a
 * 550-row capture into ~28 ms of pure formatter allocation; the zone offset is a property of
 * the instant, not of the row, so the formatter belongs to the layout, not the row loop.
 */
const ZONE_PARTS_FORMATTERS: Record<string, Intl.DateTimeFormat> = {
  [PORTAL_TIME_ZONE]: new Intl.DateTimeFormat("en-US", {
    timeZone: PORTAL_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }),
};

function zonePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const known = ZONE_PARTS_FORMATTERS[timeZone];
  if (known !== undefined) return known;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  ZONE_PARTS_FORMATTERS[timeZone] = created;
  return created;
}

/** Offset of `timeZone` from UTC at the instant whose *wall clock* is `wallMs` (two-pass for DST). */
function zoneOffsetMs(timeZone: string, wallMs: number): number {
  return offsetAt(timeZone, wallMs - offsetAt(timeZone, wallMs));
}

function offsetAt(timeZone: string, instantMs: number): number {
  const parts = zonePartsFormatter(timeZone).formatToParts(new Date(instantMs));
  const part = (type: string): number => {
    const value = parts.find((entry) => entry.type === type)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - instantMs;
}

/**
 * Portal wall-clock → epoch milliseconds. `getBetTicker` `InsertDateTime` and
 * `Report/Pending` `acceptedAt` carry no zone. Reading them as host-local (what `Date.parse`
 * does) put the desk's own Central offset on an Eastern clock, i.e. ~56 min *in the future*
 * for a just-captured row; that made old activity look indefinitely fresh. The point is the
 * clock the portal wrote — when the bet was placed — not the moment this capture re-read a
 * frozen page, so a capture that keeps returning the same tickets cannot read as fresh.
 *
 * Returns the instant as a number: the row layout carries epoch milliseconds, so downstream
 * age/staleness/aggregation arithmetic never re-parses a string.
 */
function portalClockEpochMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  // An explicit zone is already an instant; let Date.parse own it.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }
  const wall =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      text,
    );
  if (wall === null) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }
  const [, year, month, day, hour, minute, second = "00", fraction = "0"] =
    wall;
  const wallMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0")),
  );
  return wallMs - zoneOffsetMs(PORTAL_TIME_ZONE, wallMs);
}

/** Candidate logins come from the same fields as signal logins; trailing dots are noise. */
function candidateLogin(raw: string): string {
  return raw.trim().toUpperCase().replace(/\.+$/, "");
}

/** `AgentID` is a string on the ticker; `Report/Pending` carries an `{ id, key }` object. */
function agentIdFrom(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim().toUpperCase();
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["id", "key", "agentId"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim() !== "") {
        return candidate.trim().toUpperCase();
      }
    }
  }
  return null;
}

/**
 * One parsed-but-unwatched observation. The signal engine deliberately ignores logins
 * that are not on the watchlist rather than attributing them to someone else; this is the
 * advisory trail those rows leave so a genuinely new account is visible instead of silent.
 */
export interface WatchlistCandidateObservation {
  readonly login: string;
  readonly agentId: string | null;
  readonly riskUsd: number;
  readonly source: string;
  readonly betAtMs: number | null;
  readonly parsed: ParsedMarket | null;
}

type CandidateSink = (observation: WatchlistCandidateObservation) => void;

/** A login seen in the captures that the watchlist registry does not cover. */
export interface WatchlistCandidate {
  readonly login: string;
  readonly agentId: string | null;
  readonly riskUsd: number;
  readonly wagers: number;
  readonly sources: readonly string[];
  readonly leagues: readonly League[];
  readonly lastBetAt: string | null;
  readonly ageSeconds: number | null;
  readonly sampleMarkets: readonly string[];
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
  nowMs: number,
  onCandidate?: CandidateSink,
  staleAfterSeconds?: number,
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
  const asOfMs = isoToEpochMs(
    typeof record["lastUpdatedIso"] === "string"
      ? record["lastUpdatedIso"]
      : null,
  );
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
    if (login === "") continue;
    const parsed = parseCanonicalMarket(String(row["canonicalMarket"] ?? ""));
    const risk = Number(row["riskUsd"]);
    const riskUsd = Number.isFinite(risk) ? Math.max(0, risk) : 0;
    const entry = registry.get(login);
    if (entry === undefined) {
      onCandidate?.({
        login: candidateLogin(login),
        agentId: agentIdFrom(row["agentOwner"]),
        riskUsd,
        source: "docs/graph-live-feed.json",
        betAtMs: portalClockEpochMs(row["placedAtUtc"]),
        parsed,
      });
      continue;
    }
    if (parsed === null) continue;
    rows.push({
      login: entry.customerLogin,
      agentId: String(row["agentOwner"] ?? entry.agentId),
      archetype: entry.archetype,
      sourceCategory: entry.sourceCategory,
      riskUsd,
      oddsAmerican: parseAmericanOdds(row["oddsAmerican"]),
      parsed,
      provenance: rowProvenance(
        "docs/graph-live-feed.json",
        asOfMs,
        null,
        staleAfterSeconds ?? FEED_STALE_SECONDS,
        nowMs,
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
  nowMs: number,
  onCandidate?: CandidateSink,
  staleAfterSeconds?: number,
): SignalRow[] {
  if (typeof wagers !== "object" || wagers === null) return [];
  const record = wagers as Record<string, unknown>;
  const list = Array.isArray(record["LIST"])
    ? record["LIST"]
    : Array.isArray(record["list"])
      ? record["list"]
      : [];
  const observedAtMs = isoToEpochMs(
    typeof record["observedAt"] === "string" ? record["observedAt"] : null,
  );
  const fallbackAsOfMs = isoToEpochMs(fallbackAsOf);
  const fixture =
    typeof record["source"] === "string" &&
    record["source"].includes("fixture");
  const rows: SignalRow[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const login = String(row["Login"] ?? row["CustomerID"] ?? "")
      .trim()
      .toUpperCase();
    if (login === "") continue;
    const parsed = parseWagerShortDesc(String(row["ShortDesc"] ?? ""));
    const wageredCents = Number(row["AmountWagered"]);
    const riskUsd = Number.isFinite(wageredCents)
      ? Math.max(0, wageredCents / 100)
      : 0;
    // The bet's own clock, not the capture's: a re-read of the same ticker rows can be
    // seconds old while the wagers themselves are days old.
    const betAtMs = portalClockEpochMs(row["InsertDateTime"]);
    const entry = registry.get(login);
    if (entry === undefined) {
      onCandidate?.({
        login: candidateLogin(login),
        agentId: agentIdFrom(row["AgentID"]),
        riskUsd,
        source: "data/live-wagers.json",
        betAtMs,
        parsed,
      });
      continue;
    }
    if (parsed === null) continue;
    rows.push({
      login: entry.customerLogin,
      agentId: String(row["AgentID"] ?? entry.agentId),
      archetype: entry.archetype,
      sourceCategory: entry.sourceCategory,
      riskUsd,
      oddsAmerican: parseAmericanOdds(
        /([+-]\d{3,4})\b/.exec(String(row["ShortDesc"] ?? ""))?.[1] ?? null,
      ),
      parsed,
      provenance: rowProvenance(
        "data/live-wagers.json",
        betAtMs ?? observedAtMs,
        fallbackAsOfMs,
        staleAfterSeconds ?? CAPTURE_STALE_SECONDS,
        nowMs,
        { fixture, dataMode: null },
      ),
    });
  }
  return rows;
}

function rowsFromLiveBets(
  liveBets: unknown,
  registry: Map<string, WatchlistUnifiedEntry>,
  nowMs: number,
  onCandidate?: CandidateSink,
  staleAfterSeconds?: number,
): SignalRow[] {
  if (typeof liveBets !== "object" || liveBets === null) return [];
  const record = liveBets as Record<string, unknown>;
  const games = Array.isArray(record["games"]) ? record["games"] : [];
  const capturedAtMs = isoToEpochMs(
    typeof record["capturedAt"] === "string" ? record["capturedAt"] : null,
  );
  const dataSource =
    typeof record["dataSource"] === "string" ? record["dataSource"] : "";
  const rows: SignalRow[] = [];
  for (const raw of games) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const login = String(row["customerID"] ?? "")
      .trim()
      .toUpperCase();
    if (login === "") continue;
    const parsed = parseLiveBetsGame(raw);
    const wageredCents = Number(row["wagered"]);
    const riskUsd = Number.isFinite(wageredCents)
      ? Math.max(0, wageredCents / 100)
      : 0;
    const betAtMs = portalClockEpochMs(row["acceptedAt"]);
    const entry = registry.get(login);
    if (entry === undefined) {
      onCandidate?.({
        login: candidateLogin(login),
        agentId: agentIdFrom(row["agent"]),
        riskUsd,
        source: "data/live-bets.json",
        betAtMs,
        parsed,
      });
      continue;
    }
    if (parsed === null) continue;
    rows.push({
      login: entry.customerLogin,
      agentId: entry.agentId,
      archetype: entry.archetype,
      sourceCategory: entry.sourceCategory,
      riskUsd,
      oddsAmerican: parseAmericanOdds(
        /([+-]\d{3,4})\b/.exec(String(row["description"] ?? ""))?.[1] ?? null,
      ),
      parsed,
      provenance: rowProvenance(
        "data/live-bets.json",
        betAtMs ?? capturedAtMs,
        null,
        staleAfterSeconds ?? CAPTURE_STALE_SECONDS,
        nowMs,
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
  const nowMs = now.getTime();
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
      // One number per row; the newest wins without sorting strings, and the ISO form is
      // materialized once for the signal rather than once per contributing row.
      let asOfMs: number | null = null;
      for (const row of sideRows) {
        const value = row.provenance.asOfMs;
        if (value !== null && (asOfMs === null || value > asOfMs)) {
          asOfMs = value;
        }
      }
      const asOf = asOfMs === null ? null : new Date(asOfMs).toISOString();
      const age = ageSecondsFromMs(asOfMs, nowMs);
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
  /**
   * Single freshness window applied to every source (`row.provenance.stale`). Omitted,
   * each source keeps its cadence default; the CLI supplies `config.maxSignalAgeSeconds`
   * so the inspector's stale chip and the freshness gate cannot disagree.
   */
  readonly maxAgeSeconds?: number;
}

/** Pure derivation: parsed inputs in, signals out. */
export function deriveWatchlistSignals(
  inputs: WatchlistSignalInputs,
  options: DeriveWatchlistSignalsOptions = {},
): WatchlistSignal[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const registry = registryLookup(
    options.registry ?? getUnifiedWatchlistRegistry(),
  );
  const staleAfterSeconds = options.maxAgeSeconds;
  const rows = [
    ...rowsFromFeed(inputs.feed, registry, nowMs, undefined, staleAfterSeconds),
    ...rowsFromWagers(
      inputs.wagers,
      registry,
      inputs.wagersAsOf ?? null,
      nowMs,
      undefined,
      staleAfterSeconds,
    ),
    ...rowsFromLiveBets(
      inputs.liveBets,
      registry,
      nowMs,
      undefined,
      staleAfterSeconds,
    ),
  ];
  return aggregateWatchlistSignals(rows, now);
}

export interface CollectWatchlistCandidatesOptions {
  readonly now?: Date;
  readonly registry?: readonly WatchlistUnifiedEntry[];
  /** Max candidates returned after ranking (default: all). */
  readonly limit?: number;
  /** Drop accounts whose summed risk is below this USD amount (default 0). */
  readonly minRiskUsd?: number;
  /** Max sample markets kept per candidate (default 3). */
  readonly sampleLimit?: number;
}

/**
 * Advisory discovery pass: every login in the three captures that the registry does not
 * watch, ranked by the risk the captures show. This never gates and never writes — the
 * signal engine still ignores these rows for derivation; the operator decides whether an
 * account is promoted onto the watchlist.
 */
export function collectWatchlistCandidates(
  inputs: WatchlistSignalInputs,
  options: CollectWatchlistCandidatesOptions = {},
): WatchlistCandidate[] {
  const now = options.now ?? new Date();
  const registry = registryLookup(
    options.registry ?? getUnifiedWatchlistRegistry(),
  );
  const sampleLimit = Math.max(0, options.sampleLimit ?? 3);
  const byLogin = new Map<
    string,
    {
      login: string;
      agentId: string | null;
      riskUsd: number;
      wagers: number;
      sources: Set<string>;
      leagues: Set<League>;
      lastBetAtMs: number | null;
      markets: Set<string>;
    }
  >();

  const sink: CandidateSink = (observation) => {
    if (observation.login === "") return;
    const entry = byLogin.get(observation.login) ?? {
      login: observation.login,
      agentId: null as string | null,
      riskUsd: 0,
      wagers: 0,
      sources: new Set<string>(),
      leagues: new Set<League>(),
      lastBetAtMs: null as number | null,
      markets: new Set<string>(),
    };
    entry.riskUsd += Math.max(0, observation.riskUsd);
    entry.wagers += 1;
    entry.sources.add(observation.source);
    if (entry.agentId === null && observation.agentId !== null) {
      entry.agentId = observation.agentId;
    }
    if (observation.parsed !== null) {
      entry.leagues.add(observation.parsed.league);
      if (entry.markets.size < sampleLimit) {
        entry.markets.add(observation.parsed.raw.slice(0, 96));
      }
    }
    if (
      observation.betAtMs !== null &&
      (entry.lastBetAtMs === null || observation.betAtMs > entry.lastBetAtMs)
    ) {
      entry.lastBetAtMs = observation.betAtMs;
    }
    byLogin.set(observation.login, entry);
  };

  const nowMs = now.getTime();
  rowsFromFeed(inputs.feed, registry, nowMs, sink);
  rowsFromWagers(
    inputs.wagers,
    registry,
    inputs.wagersAsOf ?? null,
    nowMs,
    sink,
  );
  rowsFromLiveBets(inputs.liveBets, registry, nowMs, sink);

  const minRiskUsd = Math.max(0, options.minRiskUsd ?? 0);
  const ranked = [...byLogin.values()]
    .filter((candidate) => candidate.riskUsd >= minRiskUsd)
    .map<WatchlistCandidate>((candidate) => ({
      login: candidate.login,
      agentId: candidate.agentId,
      riskUsd: Math.round(candidate.riskUsd * 100) / 100,
      wagers: candidate.wagers,
      sources: [...candidate.sources].sort(),
      leagues: [...candidate.leagues].sort(),
      lastBetAt:
        candidate.lastBetAtMs === null
          ? null
          : new Date(candidate.lastBetAtMs).toISOString(),
      ageSeconds: ageSecondsFromMs(candidate.lastBetAtMs, nowMs),
      sampleMarkets: [...candidate.markets],
    }))
    .sort(
      (a, b) =>
        b.riskUsd - a.riskUsd ||
        b.wagers - a.wagers ||
        a.login.localeCompare(b.login),
    );
  const limit = options.limit;
  return limit === undefined ? ranked : ranked.slice(0, Math.max(0, limit));
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
