/**
 * @file lib/bet_market_parse.ts
 * @description Pure, deterministic bet-market parser for the two Fantasy402 description shapes.
 *
 * Both feeds describe a bet as a short string, but with different grammars:
 *  - ticker `ShortDesc`: a code line (`M.G320197818`) followed by a leg, or the compact
 *    `S.Basketball #525 Lakers -3½ -120 - For 1st Quarter` form (code, sport, `#rotation`, pick,
 *    `- For <period>`); `P.` rows may concatenate several legs with no separator.
 *  - pending `Report/Pending` rows carry a verbose `description`
 *    (`Football - A vs B / Game / Point spread / A -4.5 +146`) plus structured hints
 *    (`sport`, `period`, `team1`, `team2`, `chosenTeam`).
 *
 * The parser never throws and never calls out: unknown input comes back as
 * `marketType: "other"` with the nullable fields cleared. ½ / ¼ / ¾, `&#189;`, en/em dashes,
 * `&#x0D;` artefacts, CRLF and NBSP are normalised before parsing.
 */

import { SPORT_CATEGORIES } from "./sport_taxonomy.ts";

export interface ParsedMarket {
  /** Canonical sport category ("Basketball", "Football", …) or "" when unrecognised. */
  sport: string;
  /** `"Cavaliers/Thunder"`, `"Massachusetts vs Ball State"`, `"Suns"`; "" when unknown. */
  eventLabel: string;
  /** Both sides of the event when the string names both, else null. */
  teams: readonly [string, string] | null;
  marketType:
    | "moneyline"
    | "spread"
    | "total"
    | "team_total"
    | "player_prop"
    | "prop"
    | "other";
  /** `"Game"`, `"1st Half"`, `"3rd Period"`, `"3rd Set"`, …; "" when absent/unknown. */
  periodLabel: string;
  /** `"over"`/`"under"`, the bet team token, or the player name. */
  side: string | null;
  /** Numeric line (-4.5, 115.5, 3); ½/¼ normalised. Null for moneylines/props without a number. */
  line: number | null;
  /** American price (-110, +145) when the string carries one. */
  americanOdds: number | null;
  /** Compact-feed rotation (`#520`); null when the string has no rotation token. */
  rotationNumber: number | null;
  playerName: string | null;
  isLive: boolean;
  /** `buying`/`selling`/`alt` marker, a comma line (`2½,3`), or an "alt" market label. */
  isAltLine: boolean;
  /** 0..1 heuristic: how much of the market is actually identified. */
  confidence: number;
}

export interface BetMarketHints {
  sport?: string;
  period?: string;
  team1?: string;
  team2?: string;
  chosenTeam?: string;
  description?: string;
  live?: boolean;
}

const EMPTY_MARKET: ParsedMarket = {
  sport: "",
  eventLabel: "",
  teams: null,
  marketType: "other",
  periodLabel: "",
  side: null,
  line: null,
  americanOdds: null,
  rotationNumber: null,
  playerName: null,
  isLive: false,
  isAltLine: false,
  confidence: 0,
};

const FRACTIONS: Readonly<Record<string, string>> = {
  "\u00bd": ".5", // ½
  "\u00bc": ".25", // ¼
  "\u00be": ".75", // ¾
  "\u215b": ".125", // ⅛
};

/** Longest-first so "Horse Racing" is tried before "Horse". */
const SPORTS = [...SPORT_CATEGORIES]
  .filter((name) => name !== "Other")
  .sort((a, b) => b.length - a.length);

/** Contract period vocabulary, longest-first for prefix matching. */
const PERIOD_LABELS = [
  "1st Half",
  "2nd Half",
  "1st Quarter",
  "2nd Quarter",
  "3rd Quarter",
  "4th Quarter",
  "1st Period",
  "2nd Period",
  "3rd Period",
  "1st Inning",
  "2nd Inning",
  "3rd Inning",
  "4th Inning",
  "5th Inning",
  "6th Inning",
  "7th Inning",
  "8th Inning",
  "9th Inning",
  "1st Set",
  "2nd Set",
  "3rd Set",
  "4th Set",
  "5th Set",
  "1st OT",
  "2nd OT",
  "Overtime",
  "Game",
].sort((a, b) => b.length - a.length);

/** `Match (Including OT)`, `Reg Time`, … sit in the period slot but are not period labels. */
const MATCH_QUALIFIER =
  /^(?:match(?:\s*\(.*?\))?|reg(?:ulation)?\s*time|regular\s*time|including\s+ot|incl\.?\s*ot)\b/i;

/** Market labels that are exotic/non-team props rather than totals or moneylines. */
const EXOTIC_LABEL =
  /correct\s+score|point\s+bands|margin(?:\s+of\s+victory)?|winning\s+margin|first\s+(?:basket|team|score|goal|touchdown|pitch)|method\s+of|round\s+winner|group\s+winner|double\s+result|both\s+teams\s+to\s+score|to\s+win\s+the|top\s+\d+|exact\s+score|series|award|season|opening\s+faceoff|win\s+opening/i;

/** Pick-text markers for props that carry no market label (compact feed). */
const PROP_PICK_MARKERS =
  /\bwin\s+opening\s+faceoff\b|\bby\s+\d+\s+or\s+more\b|\bfirst\b|\bcorrect\s+score\b|\bmargin\b|\bdouble\s+result\b|\bboth\s+teams\b/i;

/** Stat names that make a compact `Player/Stat O|U <line>` row a player prop. */
const STAT_WORDS = new Set([
  "assists",
  "blocks",
  "double doubles",
  "faceoffs",
  "fantasy points",
  "goals",
  "hits",
  "interceptions",
  "passing tds",
  "points",
  "points and rebounds",
  "points, rebounds, assists",
  "pts",
  "pts+rebs+asts",
  "rebounds",
  "receptions",
  "rushing yards",
  "sacks",
  "saves",
  "shots",
  "shots on goal",
  "steals",
  "strikeouts",
  "tackles",
  "tds",
  "threes",
  "touchdowns",
]);

const AMERICAN_ODDS = /^[+-]\d{2,4}$/;
const NUMERIC_TOKEN = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const OVER_TOKENS = new Set(["o", "ov", "over"]);
const UNDER_TOKENS = new Set(["u", "un", "under"]);

function normalizeText(input: string): string {
  return String(input ?? "")
    .replace(/&#x0d;?/gi, "\n")
    .replace(/&#189;/gi, "\u00bd")
    .replace(/&#188;/gi, "\u00bc")
    .replace(/&#190;/gi, "\u00be")
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2013\u2014\u2212]/g, "-") // en dash, em dash, unicode minus
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** `½`/`¼` to decimals, then a finite number; null for anything else. */
function numericValue(token: string): number | null {
  const cleaned = token
    .replace(/[\u00bd\u00bc\u00be\u215b]/g, (char) => FRACTIONS[char] ?? "")
    .replace(/^\+/, "");
  if (!NUMERIC_TOKEN.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function resolveSport(text: string): string {
  const cleaned = text.trim().replace(/^#+/, "").trim();
  if (cleaned === "") return "";
  for (const sport of SPORTS) {
    if (cleaned.toLowerCase() === sport.toLowerCase()) return sport;
  }
  for (const sport of SPORTS) {
    if (cleaned.toLowerCase().startsWith(`${sport.toLowerCase()} `))
      return sport;
  }
  // Competition prefixes ("Top Soccer") still carry the sport as their last word.
  for (const sport of SPORTS) {
    if (cleaned.toLowerCase().endsWith(` ${sport.toLowerCase()}`)) return sport;
  }
  return "";
}

/** Prefix-matches a canonical period label at the start of `text`. */
function matchPeriodLabel(text: string): string {
  const trimmed = text.trim();
  for (const label of PERIOD_LABELS) {
    if (trimmed.length < label.length) continue;
    if (trimmed.slice(0, label.length).toLowerCase() !== label.toLowerCase()) {
      continue;
    }
    const next = trimmed.charAt(label.length);
    if (next === "" || !/[A-Za-z0-9]/.test(next)) return label;
  }
  return "";
}

function cleanToken(text: string): string {
  return text
    .replace(/^#+/, "")
    .replace(/^[\s:/,-]+|[\s:/,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTeamName(text: string): string {
  return cleanToken(text.replace(/\(live\)/gi, ""));
}

/** Wire placeholders the pending feed emits when it has no real team names. */
const PLACEHOLDER_TEAM =
  /^(?:team\s*[a-z0-9]{0,2}|other|market|home|away|tbd|tba|unknown|null|n\/a|-+)$/i;

/** True for empty, "Team A"/"Other"/"Market", and generic sport-name placeholder teams. */
function isPlaceholderTeamName(name: string): boolean {
  const cleaned = cleanTeamName(name).toLowerCase();
  if (cleaned === "") return true;
  if (PLACEHOLDER_TEAM.test(cleaned)) return true;
  return SPORTS.some((sport) => sport.toLowerCase() === cleaned);
}

/** Only keeps a two-team tuple when both sides are real names. */
function validTeams(
  teams: readonly [string, string] | null,
): [string, string] | null {
  if (teams === null) return null;
  if (isPlaceholderTeamName(teams[0]) || isPlaceholderTeamName(teams[1])) {
    return null;
  }
  return [teams[0], teams[1]];
}

/** Drops an event label whose sides are placeholders (`"Basketball vs Market"`). */
function sanitizeEventLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "") return "";
  const sides = trimmed.split(/\s+vs\.?\s+|\//i);
  if (sides.length === 2) {
    if (
      isPlaceholderTeamName(sides[0] ?? "") ||
      isPlaceholderTeamName(sides[1] ?? "")
    ) {
      return "";
    }
  } else if (isPlaceholderTeamName(trimmed)) {
    return "";
  }
  return trimmed;
}

/** `A/B` or `A vs B` → both sides; else null with the cleaned text as the label. */
function splitTeams(eventText: string): {
  teams: [string, string] | null;
  eventLabel: string;
} {
  const text = cleanToken(eventText.replace(/^#+/, ""));
  const vs = /\s+vs\.?\s+/i.exec(text);
  if (vs !== null) {
    const left = cleanTeamName(text.slice(0, vs.index));
    const right = cleanTeamName(text.slice(vs.index + vs[0].length));
    if (left !== "" && right !== "") {
      return { teams: [left, right], eventLabel: `${left} vs ${right}` };
    }
  }
  const slash = text.indexOf("/");
  if (slash > 0) {
    const left = cleanTeamName(text.slice(0, slash));
    const right = cleanTeamName(text.slice(slash + 1));
    if (left !== "" && right !== "") {
      return { teams: [left, right], eventLabel: `${left}/${right}` };
    }
  }
  return { teams: null, eventLabel: text };
}

/** `Andrew Wiggins/Rebounds` → player; `Cavaliers/Thunder` → teams; else unknown. */
function compactSlashKind(prefix: string): "player" | "teams" | "unknown" {
  const slash = prefix.indexOf("/");
  if (slash <= 0) return "unknown";
  const right = prefix
    .slice(slash + 1)
    .trim()
    .toLowerCase();
  if (right === "") return "unknown";
  if (STAT_WORDS.has(right)) return "player";
  if (/\+/.test(right) || /\b(pts|reb|ast|stl|blk)\b/.test(right))
    return "player";
  return "teams";
}

function splitPlayerStat(
  prefix: string,
): { playerName: string; stat: string } | null {
  const slash = prefix.indexOf("/");
  if (slash <= 0) return null;
  const playerName = cleanToken(prefix.slice(0, slash));
  const stat = cleanToken(prefix.slice(slash + 1));
  if (playerName === "" || stat === "") return null;
  return { playerName, stat };
}

interface PickParts {
  /** Text before the O/U marker, line and odds — the team, player or exotic selection. */
  selection: string;
  americanOdds: number | null;
  line: number | null;
  overUnder: "over" | "under" | null;
  isAltLine: boolean;
  isLive: boolean;
  /** Both event sides when the pick itself names them (`A/B O 115`). */
  eventTeams: [string, string] | null;
  eventLabel: string;
}

function parsePickText(raw: string, marketLabel: string): PickParts {
  const isLive = /\(live\)/i.test(raw);
  // Exotic markets ("Correct Score") carry scores in the pick; a trailing number is not a line.
  const exotic = EXOTIC_LABEL.test(marketLabel);
  const text = raw
    .replace(/\(live\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = text.split(" ").filter((token) => token !== "");

  // American odds: the last signed 2-4 digit token with absolute value >= 100.
  let americanOdds: number | null = null;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? "";
    if (!AMERICAN_ODDS.test(token)) continue;
    if (Math.abs(Number(token)) < 100) continue;
    americanOdds = Number(token);
    tokens.splice(index, 1);
    break;
  }

  // Alternate-line markers (`buying ½`, `selling 2`, `alt`) and the amount they move.
  let isAltLine = false;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = (tokens[index] ?? "").toLowerCase();
    if (
      token !== "buying" &&
      token !== "selling" &&
      token !== "alt" &&
      token !== "alt-line"
    ) {
      continue;
    }
    isAltLine = true;
    tokens.splice(index, 1);
    const bought = tokens[index];
    if (bought !== undefined && numericValue(bought) !== null) {
      tokens.splice(index, 1);
    }
  }

  // `- buying ½` leaves a bare "-" separator behind; it is not part of the selection.
  while (tokens[tokens.length - 1] === "-") tokens.pop();

  const overUnderIndex = tokens.findIndex((token) => {
    const lower = token.toLowerCase().replace(/\.$/, "");
    return OVER_TOKENS.has(lower) || UNDER_TOKENS.has(lower);
  });

  if (overUnderIndex >= 0) {
    const marker = (tokens[overUnderIndex] ?? "").toLowerCase();
    const overUnder: "over" | "under" = OVER_TOKENS.has(marker)
      ? "over"
      : "under";
    const prefixText = cleanToken(tokens.slice(0, overUnderIndex).join(" "));
    const lineTokens = tokens.slice(overUnderIndex + 1);
    const lineToken = lineTokens[0] ?? "";
    let line = numericValue(lineToken);
    if (lineToken.includes(",")) {
      isAltLine = true;
      line = numericValue(lineToken.split(",")[0] ?? "");
    }
    const slashKind = compactSlashKind(prefixText);
    const eventSplit =
      slashKind === "teams" || /\s+vs\b/i.test(prefixText)
        ? splitTeams(prefixText)
        : { teams: null, eventLabel: "" };
    return {
      selection: prefixText,
      americanOdds,
      line,
      overUnder,
      isAltLine,
      isLive,
      eventTeams: eventSplit.teams,
      eventLabel: eventSplit.eventLabel,
    };
  }

  // No O/U token: a signed small number is a spread line; a trailing unsigned integer after a
  // team token is also a line (`BYU  7 -155`), except in exotic props where numbers are scores.
  let line: number | null = null;
  let lineIndex = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? "";
    if (!/^[+-]/.test(token)) continue;
    const value = numericValue(token);
    if (value === null || Math.abs(value) >= 100) continue;
    line = value;
    lineIndex = index;
    break;
  }
  if (lineIndex < 0 && !exotic) {
    const last = tokens[tokens.length - 1] ?? "";
    const value = numericValue(last);
    if (value !== null && !/[+-]/.test(last) && tokens.length > 1) {
      line = value;
      lineIndex = tokens.length - 1;
    }
  }
  if (lineIndex >= 0) tokens.splice(lineIndex, 1);

  const selection = cleanToken(tokens.join(" "));
  const vsCount = (selection.match(/\bvs\.?\b/gi) ?? []).length;
  const split =
    vsCount === 1 ? splitTeams(selection) : { teams: null, eventLabel: "" };
  return {
    selection,
    americanOdds,
    line,
    overUnder: null,
    isAltLine,
    isLive,
    eventTeams: split.teams,
    eventLabel: split.eventLabel,
  };
}

function isPlayerLabel(label: string): boolean {
  return /\bplayer\b|to\s+score\s+first/i.test(label);
}

function isTeamTotalLabel(label: string): boolean {
  return /\bteam\s+total\b/i.test(label);
}

function isMoneylineLabel(label: string): boolean {
  return /\bwinner\b|\bmoney\s*line\b|\bmatch\b/i.test(label);
}

function isSpreadLabel(label: string): boolean {
  return /\bspread\b|\bhandicap\b|\brun\s*line\b|\bpuck\s*line\b|\bpoint\s+spread\b/i.test(
    label,
  );
}

function isTotalLabel(label: string): boolean {
  return /\btotal\b/i.test(label);
}

interface StructuredParts {
  sport: string;
  eventLabel: string;
  teams: [string, string] | null;
  periodLabel: string;
  marketLabel: string;
  pickText: string;
  rotationNumber: number | null;
  isLive: boolean;
  isAltLine: boolean;
}

const EMPTY_STRUCTURED: StructuredParts = {
  sport: "",
  eventLabel: "",
  teams: null,
  periodLabel: "",
  marketLabel: "",
  pickText: "",
  rotationNumber: null,
  isLive: false,
  isAltLine: false,
};

function stripCodePrefix(line: string): string {
  const coded = /^([A-Z])[.:]\s*/.exec(line);
  if (coded !== null) return line.slice(coded[0].length).trim();
  // An odd leading single-letter code on an ALL-CAPS team row (`T BLAZERS -1 -150`), but never a
  // person's initial (`M Hontama -1½`).
  const spaced = /^[A-Z]\s+(?=[A-Z][A-Z\s]*-?\d)/.exec(line);
  if (spaced !== null) return line.slice(spaced[0].length).trim();
  return line;
}

function splitCompactPeriod(body: string): {
  head: string;
  periodLabel: string;
} {
  const dashFor = /\s+-\s+For\s+(.+)$/i.exec(body);
  if (dashFor !== null) {
    return {
      head: body.slice(0, dashFor.index).trim(),
      periodLabel: matchPeriodLabel(dashFor[1] ?? ""),
    };
  }
  const forTail = /\s+For\s+(.+)$/i.exec(body);
  if (forTail !== null) {
    const label = matchPeriodLabel(forTail[1] ?? "");
    if (label !== "") {
      return { head: body.slice(0, forTail.index).trim(), periodLabel: label };
    }
  }
  return { head: body.trim(), periodLabel: "" };
}

/** Tries a sport prefix for compact rows whose sport token has trailing punctuation. */
function splitSportPrefix(text: string): { sport: string; rest: string } {
  const cleaned = text.trim();
  for (const sport of SPORTS) {
    if (!cleaned.toLowerCase().startsWith(sport.toLowerCase())) continue;
    const rest = cleaned
      .slice(sport.length)
      .replace(/^[\s:,-]+/, "")
      .trim();
    return { sport, rest };
  }
  return { sport: "", rest: cleaned };
}

function parseVerboseBody(lines: readonly string[]): StructuredParts | null {
  const legLine = lines[0];
  if (legLine === undefined) return null;
  const segments = legLine
    .split(" / ")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length < 2) return null;

  const head = segments[0] ?? "";
  const rest = segments.slice(1);
  const dash = head.indexOf(" - ");
  const sportText = dash >= 0 ? head.slice(0, dash).trim() : "";
  const eventText = dash >= 0 ? head.slice(dash + 3).trim() : head;
  const split = splitTeams(eventText);

  let periodLabel = "";
  let marketLabel = "";
  let pickText = "";
  const first = rest[0] ?? "";
  const firstPeriod = matchPeriodLabel(first);
  if (firstPeriod !== "" || MATCH_QUALIFIER.test(first)) {
    periodLabel = firstPeriod;
    const marketAndPick = rest.slice(1);
    if (marketAndPick.length >= 2) {
      marketLabel = marketAndPick[0] ?? "";
      pickText = marketAndPick.slice(1).join(" / ");
    } else {
      pickText = marketAndPick[0] ?? "";
    }
  } else {
    marketLabel = first;
    pickText = rest.slice(1).join(" / ");
  }

  return {
    sport: resolveSport(sportText),
    eventLabel: split.eventLabel,
    teams: split.teams,
    periodLabel,
    marketLabel,
    pickText: pickText.trim(),
    rotationNumber: null,
    isLive: /\bLIVE\b|\(live\)/i.test(legLine),
    isAltLine: /\balt(?:ernate)?\b|buying|selling/i.test(legLine),
  };
}

function parseCompactBody(
  legLine: string,
  sourceText: string,
): StructuredParts {
  const isLiveText = /\bLIVE\b|\(live\)/i.test(sourceText);
  let body = stripCodePrefix(legLine);
  const period = splitCompactPeriod(body);
  body = period.head;

  let periodLabel = period.periodLabel;
  let isLive = isLiveText;
  let rotationNumber: number | null = null;

  const liveToken = /^LIVE\s+#(\d+)\s*/i.exec(body);
  if (liveToken !== null) {
    isLive = true;
    rotationNumber = Number(liveToken[1]);
    body = body.slice(liveToken[0].length).trim();
  }

  let sport = resolveSport(body);
  if (sport !== "") {
    body = body
      .slice(sport.length)
      .replace(/^[\s:,-]+/, "")
      .trim();
  } else {
    const prefix = splitSportPrefix(body);
    if (prefix.sport !== "") {
      sport = prefix.sport;
      body = prefix.rest;
    }
  }

  if (rotationNumber === null) {
    const hashToken = /^#(\d+)\s*/.exec(body);
    if (hashToken !== null) {
      rotationNumber = Number(hashToken[1]);
      body = body.slice(hashToken[0].length).trim();
    }
  }

  return {
    sport,
    eventLabel: "",
    teams: null,
    periodLabel,
    marketLabel: "",
    pickText: body.trim(),
    rotationNumber,
    isLive,
    isAltLine: /\balt(?:ernate)?\b/i.test(legLine),
  };
}

function parseStructured(text: string): StructuredParts {
  if (text === "") return { ...EMPTY_STRUCTURED };
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return { ...EMPTY_STRUCTURED };

  let start = 0;
  if (/^[A-Z]\.(?:[A-Z]?\d+)?$/.test(lines[0] ?? "")) start = 1;
  const legLine = lines[start];
  if (legLine === undefined) return { ...EMPTY_STRUCTURED };

  if (legLine.includes(" / ")) {
    const verbose = parseVerboseBody(lines.slice(start));
    if (verbose !== null) return verbose;
  }
  return parseCompactBody(legLine, text);
}

function parseHintPeriod(period: string | undefined): string {
  if (typeof period !== "string") return "";
  const text = period.trim();
  if (text === "" || text.includes("/") || text.includes("#")) return "";
  return matchPeriodLabel(text);
}

function buildConfidence(market: ParsedMarket): number {
  let score = 0;
  if (market.sport !== "") score += 0.2;
  if (market.eventLabel !== "") score += 0.2;
  if (market.teams !== null) score += 0.1;
  if (market.marketType !== "other") score += 0.2;
  if (market.side !== null) score += 0.1;
  if (market.line !== null || market.americanOdds !== null) score += 0.1;
  if (market.periodLabel !== "") score += 0.1;
  return Math.round(score * 100) / 100;
}

/**
 * Parses one ticker `ShortDesc` / pending `description` (plus optional structured hints) into a
 * structured market. Never throws: unknown input returns `marketType: "other"` with the nullable
 * fields cleared.
 */
export function parseBetMarket(
  input: string,
  hints: BetMarketHints = {},
): ParsedMarket {
  if (typeof input !== "string") return { ...EMPTY_MARKET };

  const primary = normalizeText(input);
  const hintDescription = normalizeText(
    typeof hints.description === "string" ? hints.description : "",
  );
  const primaryIsStructured =
    primary.includes(" / ") ||
    /^[A-Z][.:]/.test(primary) ||
    /\bvs\b/i.test(primary);
  const chosenSource =
    !primaryIsStructured && hintDescription !== "" ? hintDescription : primary;
  const parts = parseStructured(chosenSource);

  const fallbackPick =
    typeof hints.chosenTeam === "string" ? normalizeText(hints.chosenTeam) : "";
  const pick = parsePickText(
    parts.pickText !== "" ? parts.pickText : fallbackPick,
    parts.marketLabel,
  );

  const hintTeams: [string, string] | null =
    typeof hints.team1 === "string" &&
    typeof hints.team2 === "string" &&
    cleanTeamName(hints.team1) !== "" &&
    cleanTeamName(hints.team2) !== ""
      ? [cleanTeamName(hints.team1), cleanTeamName(hints.team2)]
      : null;

  const sport =
    parts.sport !== ""
      ? parts.sport
      : resolveSport(typeof hints.sport === "string" ? hints.sport : "");
  const periodLabel =
    parts.periodLabel !== ""
      ? parts.periodLabel
      : parseHintPeriod(hints.period);

  // Real names win over placeholders: description first, then the pick's own event sides, then
  // the structured hints (`team1.name`/`team2.name` can carry "Basketball"/"Market" garbage).
  let teams: [string, string] | null = validTeams(parts.teams);
  let eventLabel = sanitizeEventLabel(parts.eventLabel);
  if (teams === null) {
    const pickTeams = validTeams(pick.eventTeams);
    if (pickTeams !== null) {
      teams = pickTeams;
      eventLabel = sanitizeEventLabel(pick.eventLabel);
    }
  }
  if (teams === null) {
    const hintedTeams = validTeams(hintTeams);
    if (hintedTeams !== null) {
      teams = hintedTeams;
      if (eventLabel === "") {
        eventLabel = `${hintedTeams[0]} vs ${hintedTeams[1]}`;
      }
    }
  }
  if (eventLabel === "" && teams !== null) {
    eventLabel = `${teams[0]} vs ${teams[1]}`;
  }

  const label = parts.marketLabel;
  let marketType: ParsedMarket["marketType"] = "other";
  let side: string | null = null;
  let playerName: string | null = null;

  if (isPlayerLabel(label)) {
    marketType = "player_prop";
    playerName = pick.selection !== "" ? pick.selection : null;
    side = pick.overUnder ?? playerName;
  } else if (isTeamTotalLabel(label)) {
    marketType = "team_total";
    side = pick.overUnder ?? (pick.selection !== "" ? pick.selection : null);
  } else if (pick.overUnder !== null) {
    const slashKind = compactSlashKind(pick.selection);
    if (slashKind === "player") {
      marketType = "player_prop";
      playerName = splitPlayerStat(pick.selection)?.playerName ?? null;
      side = pick.overUnder;
    } else if (slashKind === "teams" && pick.eventTeams !== null) {
      marketType = "total";
      side = pick.overUnder;
    } else if (pick.selection !== "") {
      // `HAWKS U 55`, `Mavericks O 107½` — a lone team token before O/U is a team total.
      marketType = "team_total";
      side = pick.overUnder;
    } else {
      marketType = "total";
      side = pick.overUnder;
    }
  } else if (
    EXOTIC_LABEL.test(label) ||
    PROP_PICK_MARKERS.test(pick.selection)
  ) {
    marketType = "prop";
    side = pick.selection !== "" ? pick.selection : null;
  } else if (isSpreadLabel(label) || pick.line !== null) {
    marketType = "spread";
    side = pick.selection !== "" ? pick.selection : null;
  } else if (isMoneylineLabel(label) || pick.americanOdds !== null) {
    marketType = "moneyline";
    side = pick.selection !== "" ? pick.selection : null;
  } else if (isTotalLabel(label)) {
    marketType = "total";
    side = pick.overUnder;
  }

  // Event label fallbacks, per market shape.
  if (teams === null && pick.eventTeams !== null) teams = pick.eventTeams;
  if (eventLabel === "") {
    if (pick.eventTeams !== null && pick.eventLabel !== "") {
      eventLabel = pick.eventLabel;
    } else if (teams !== null) {
      eventLabel = `${teams[0]} vs ${teams[1]}`;
    } else if (marketType === "player_prop") {
      eventLabel = playerName ?? "";
    } else if (
      marketType === "team_total" &&
      pick.selection !== "" &&
      !isPlaceholderTeamName(pick.selection)
    ) {
      eventLabel = pick.selection;
    } else if (
      (marketType === "spread" || marketType === "moneyline") &&
      side !== null &&
      !isPlaceholderTeamName(side)
    ) {
      eventLabel = side;
    } else if (marketType === "prop") {
      const firstWord = pick.selection.split(" ")[0] ?? "";
      eventLabel =
        /^[A-Z]/.test(firstWord) && !isPlaceholderTeamName(firstWord)
          ? firstWord
          : "";
    }
  }

  if (marketType === "other") {
    return { ...EMPTY_MARKET, isLive: parts.isLive || pick.isLive };
  }

  const market: ParsedMarket = {
    sport,
    eventLabel,
    teams,
    marketType,
    periodLabel,
    side,
    line: pick.line,
    americanOdds: pick.americanOdds,
    rotationNumber: parts.rotationNumber,
    playerName,
    isLive: parts.isLive || pick.isLive || hints.live === true,
    isAltLine: parts.isAltLine || pick.isAltLine,
    confidence: 0,
  };
  market.confidence = buildConfidence(market);
  return market;
}

function keyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * An unclassified market has no identity: returning the all-empty sentinel key would let a
 * `marketKey`-grouped crowd rule collapse unrelated unknown rows into one group. `""` is the
 * documented "no market" value for both key helpers.
 */
function hasMarketIdentity(market: ParsedMarket): boolean {
  return market.marketType !== "other";
}

/** Stable event identity: `sport|event` (lowercased, whitespace-collapsed); "" when unclassified. */
export function eventKeyFor(market: ParsedMarket): string {
  if (!hasMarketIdentity(market)) return "";
  return `${keyPart(market.sport)}|${keyPart(market.eventLabel)}`;
}

/**
 * Stable market identity: `sport|event|marketType|period|line`; "" when the market is
 * unclassified (`marketType: "other"`), so crowd/window rules skip it instead of grouping unknowns.
 */
export function marketKeyFor(market: ParsedMarket): string {
  if (!hasMarketIdentity(market)) return "";
  const line = market.line === null ? "" : String(market.line);
  return `${eventKeyFor(market)}|${market.marketType}|${keyPart(market.periodLabel)}|${line}`;
}
