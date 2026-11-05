/**
 * @file lib/bet_flags.ts
 * @description YAML-rule flag engine over incoming Fantasy402 bets: a wide rule-facing bet record,
 * three wire wideners, a closed field/operator vocabulary, fail-closed rule parsing and a
 * deterministic evaluator with optional windowed aggregates.
 *
 * Evidence for the wire shapes (all read-only reuse, no live call here):
 *  - `lib/f402_ingest.ts` `F402TickerRow` normalizes a `getBetTicker` `LIST` row into camelCase;
 *    `data/live-wagers.json` `LIST` rows and the live probe carry the same 13 wire fields. Both
 *    spellings widen identically, so the live fetch and the capture fallback cannot drift.
 *  - `data/live-bets.json` `games` rows (`Report/Pending`) use a different shape: `ticketNumber`
 *    plus a leg `wagerNumber`, `agent.level`, `picks`, `chosenTeam`, `wagered`/`toWin`, and a
 *    `ticketKey` that names the ticket-leg pair.
 *
 * Timestamps: `InsertDateTime` and the Pending `acceptedAt` carry no zone. They are the portal's
 * wall clock, and the portal writes America/New_York (evidence and the same constant live in
 * `lib/watchlist_signal_engine.ts` `PORTAL_TIME_ZONE`; reading them as UTC is ~5 h early and as
 * the desk's own Central clock ~56 min in the future). This module converts them to ISO here, from
 * the same documented finding, so ages never depend on the host zone.
 *
 * Money: `AmountWagered`/`ToWinAmount`/`VolumeAmount` are whole-dollar wire integers. Sentinel
 * channels (`ALERT` mirrors a real ticket, `BLOCKED` and `NON_SPORTS_DROP` are not wagers) are
 * pinned to zero through `lib/f402_bet_ticker_delta.ts`, so an ALERT twin cannot double a stake.
 * A missing amount stays `null`: absent is never zero.
 *
 * Wager kind: only `S` (straight) and `P` (parlay) have evidence in this repository. A description
 * with two or more legs is a parlay; every other type code stays `"other"` rather than being
 * renamed into a guess (the repo has no documented meaning for `M`, `L`, `E`, `T`, `I`, `G`).
 *
 * Evaluation is once per `betKey`: an ALERT row and its real ticket share the key, so counting both
 * would double a velocity aggregate and alert twice for one bet. The non-ALERT row wins.
 *
 * Rule parsing fails closed and collects every error: an unknown key, field, operator, severity, a
 * duplicate id, an empty `all`/`any`, an invalid regex or an aggregate without a condition refuses
 * the whole file instead of applying the valid part of it.
 *
 * v2 depth (additive): the record carries structured market fields from `lib/bet_market_parse.ts`
 * (`eventLabel`, `eventKey`, `marketKey`, `marketType`, `periodLabel`, `side`, `playerName`,
 * `isPlayerProp`, `isAltLine`) and a nullable `context` from `lib/bet_context.ts`. Rules may name
 * every `context.*` field, use the inclusive `between` operator, group an aggregate by
 * market/event/period/sport and require a number of distinct customers (crowding).
 */

import {
  amountToCents,
  demuxChannel,
  isSentinelChannel,
} from "./f402_bet_ticker_delta.ts";
import { BET_CONTEXT_FIELDS } from "./bet_context.ts";
import type { BetContext } from "./bet_context.ts";
import {
  eventKeyFor,
  marketKeyFor,
  parseBetMarket,
} from "./bet_market_parse.ts";
import type { ParsedMarket } from "./bet_market_parse.ts";
import { parseShortDesc } from "./live_wagers.ts";

export type FlagSeverity = "info" | "low" | "medium" | "high" | "critical";

/** Ascending; a `minSeverity` filter keeps everything at or above the named band. */
export const FLAG_SEVERITIES: readonly FlagSeverity[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

export type IncomingBetSource =
  "live-ticker" | "capture-wagers" | "capture-bets" | "file-capture";

/** Wide, flat, rule-facing bet record. `raw` keeps the wire row for deeper views. */
export interface IncomingBetRecord {
  schemaVersion: 1;
  betKey: string;
  ticketNumber: string;
  wagerNumber: string;
  /** Trimmed uppercase login. */
  customerId: string;
  agentId: string;
  agentLogin: string;
  agentLevel: number | null;
  channel: "GSLIVE" | "GSBUILDER" | "INTERNET" | "ALERT" | "OTHER";
  wagerType: string;
  wagerKind: "straight" | "parlay" | "teaser" | "ifbet" | "reverse" | "other";
  sport: string;
  /** The wire carries no league; kept for sources that do and for forward compatibility. */
  league: string;
  subSport: string;
  period: string;
  rotationNumber: number | null;
  selection: string;
  description: string;
  shortDescription: string;
  americanOdds: number | null;
  impliedProb: number | null;
  line: number | null;
  stakeUsd: number | null;
  toWinUsd: number | null;
  volumeUsd: number | null;
  riskUsd: number | null;
  // v3 derived numeric fields, computed by every widener.
  /** `stakeUsd / toWinUsd` when `toWinUsd > 0`; null when either amount is absent or to-win is 0. */
  stakeToWinRatio: number | null;
  /** `stakeUsd / ticket legs` when the leg count is known (> 0), else `stakeUsd`. */
  stakePerLeg: number | null;
  /** Absolute distance of `americanOdds` from +100 (0 at +100 even money); null without odds. */
  oddsFromEven: number | null;
  isLive: boolean;
  isVip: boolean;
  /** ISO, best available: the portal timestamp, else the observation instant. */
  acceptedAt: string;
  observedAt: string;
  ageSeconds: number | null;
  source: IncomingBetSource;
  raw: Record<string, unknown>;
  // v2 depth: structured market fields from `lib/bet_market_parse.ts`.
  eventLabel: string;
  eventKey: string;
  marketKey: string;
  marketType:
    | "moneyline"
    | "spread"
    | "total"
    | "team_total"
    | "player_prop"
    | "prop"
    | "other";
  periodLabel: string;
  side: string | null;
  playerName: string | null;
  isPlayerProp: boolean;
  isAltLine: boolean;
  /**
   * Batch context from `enrichIncomingBets` (v2): prior customer stakes and window crowd counts.
   * `null` until enriched; every rule may name the fields as `context.<name>`.
   */
  context: BetContext | null;
}

/**
 * The record fields a rule may name. Closed on purpose: a typo in a predicate field refuses the
 * file instead of silently matching nothing. `raw` is excluded — rules read the wide shape. v2 adds
 * the structured market fields and every `context.*` field (from `BET_CONTEXT_FIELDS`); the
 * `context` object itself is not comparable and is not a field.
 */
export const BET_FLAG_FIELDS: readonly string[] = [
  "betKey",
  "ticketNumber",
  "wagerNumber",
  "customerId",
  "agentId",
  "agentLogin",
  "agentLevel",
  "channel",
  "wagerType",
  "wagerKind",
  "sport",
  "league",
  "subSport",
  "period",
  "rotationNumber",
  "selection",
  "description",
  "shortDescription",
  "americanOdds",
  "impliedProb",
  "line",
  "stakeUsd",
  "toWinUsd",
  "volumeUsd",
  "riskUsd",
  // v3 derived numeric fields.
  "stakeToWinRatio",
  "stakePerLeg",
  "oddsFromEven",
  "isLive",
  "isVip",
  "acceptedAt",
  "observedAt",
  "ageSeconds",
  "source",
  "eventLabel",
  "eventKey",
  "marketKey",
  "marketType",
  "periodLabel",
  "side",
  "playerName",
  "isPlayerProp",
  "isAltLine",
  ...BET_CONTEXT_FIELDS.map((field) => `context.${field}`),
];

export const BET_FLAG_OPS: readonly string[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "matches",
  "exists",
  "between",
];

const FIELD_SET: ReadonlySet<string> = new Set(BET_FLAG_FIELDS);
const OP_SET: ReadonlySet<string> = new Set(BET_FLAG_OPS);
const SEVERITY_SET: ReadonlySet<string> = new Set(FLAG_SEVERITIES);

/**
 * Fields a `fieldRef` may name: numeric record fields only. String fields (`sport`, `channel`, …)
 * and every `context.*` field are refused — a cross-field comparison against them is not
 * meaningful — and the set is closed so a typo refuses the whole pack instead of matching nothing.
 */
const NUMERIC_FIELDS: readonly string[] = [
  "agentLevel",
  "rotationNumber",
  "americanOdds",
  "impliedProb",
  "line",
  "stakeUsd",
  "toWinUsd",
  "volumeUsd",
  "riskUsd",
  "stakeToWinRatio",
  "stakePerLeg",
  "oddsFromEven",
  "ageSeconds",
];
const NUMERIC_FIELD_SET: ReadonlySet<string> = new Set(NUMERIC_FIELDS);
/** Ops that may compare the leaf field against another record field. */
const FIELD_REF_OPS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export type Predicate =
  | { all: readonly Predicate[] }
  | { any: readonly Predicate[] }
  | { not: Predicate }
  | { field: string; op: string; value?: unknown };

const AGGREGATE_GROUP_BY: readonly BetFlagAggregate["groupBy"][] = [
  "customerId",
  "agentId",
  "agentLogin",
  "channel",
  "marketKey",
  "eventKey",
  "periodLabel",
  "sport",
];
const AGGREGATE_SUM_FIELDS: readonly NonNullable<
  BetFlagAggregate["sumField"]
>[] = ["stakeUsd", "riskUsd", "volumeUsd", "toWinUsd"];
const AGGREGATE_DISTINCT_FIELDS: readonly NonNullable<
  BetFlagAggregate["distinctField"]
>[] = ["customerId", "marketKey", "agentId"];
const GROUP_BY_SET: ReadonlySet<string> = new Set(AGGREGATE_GROUP_BY);
const SUM_FIELD_SET: ReadonlySet<string> = new Set(AGGREGATE_SUM_FIELDS);
const DISTINCT_FIELD_SET: ReadonlySet<string> = new Set(
  AGGREGATE_DISTINCT_FIELDS,
);

export interface BetFlagAggregate {
  groupBy:
    | "customerId"
    | "agentId"
    | "agentLogin"
    | "channel"
    | "marketKey"
    | "eventKey"
    | "periodLabel"
    | "sport";
  windowSeconds: number;
  where?: Predicate;
  countAtLeast?: number;
  sumField?: "stakeUsd" | "riskUsd" | "volumeUsd" | "toWinUsd";
  sumAtLeast?: number;
  /** v2: require this many DISTINCT values of `distinctField` in the group. */
  distinctField?: "customerId" | "marketKey" | "agentId";
  distinctAtLeast?: number;
}

export interface BetFlagRule {
  id: string;
  title: string;
  severity: FlagSeverity;
  enabled: boolean;
  description?: string;
  tags?: readonly string[];
  when: Predicate;
  aggregate?: BetFlagAggregate;
}

export interface BetFlagFinding {
  ruleId: string;
  ruleTitle: string;
  severity: FlagSeverity;
  bet: IncomingBetRecord;
  matchedAt: string;
  dedupeKey: string;
  evidence: Record<string, unknown>;
}

export interface BetFlagRuleSet {
  schemaVersion: 1;
  path: string;
  rules: readonly BetFlagRule[];
}

export type RuleLoadResult =
  | { ok: true; ruleSet: BetFlagRuleSet }
  | {
      ok: false;
      code: "rules_missing" | "rules_unreadable" | "rules_invalid";
      message: string;
      errors: readonly string[];
      path: string;
    };

// -------------------------------------------------------------------------------------------------
// Scalar helpers
// -------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asIntegerOrNull(value: unknown): number | null {
  const parsed = asNumberOrNull(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function firstNumber(...values: readonly (number | null)[]): number | null {
  for (const value of values) if (value !== null) return value;
  return null;
}

// -------------------------------------------------------------------------------------------------
// Portal wall clock -> ISO
// -------------------------------------------------------------------------------------------------

/**
 * The portal's wall-clock zone (see the file docblock). One formatter built once: creating an
 * `Intl.DateTimeFormat` per row was measured at ~25 µs on this repo's 550-row capture.
 */
const PORTAL_TIME_ZONE = "America/New_York";
const PORTAL_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: PORTAL_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset of the portal zone from UTC at the instant whose *wall clock* is `wallMs` (two-pass DST). */
function portalOffsetMsAt(wallMs: number): number {
  const parts = PORTAL_PARTS_FORMATTER.formatToParts(new Date(wallMs));
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
  return asUtc - wallMs;
}

function portalWallClockToEpochMs(wallMs: number): number {
  // The offset formatter has second precision, so carrying milliseconds through it drifts by
  // hundreds of ms. Resolve the offset on the whole second and add the fraction back unchanged.
  const fractionMs = ((wallMs % 1000) + 1000) % 1000;
  const wholeSecondMs = wallMs - fractionMs;
  const offset = portalOffsetMsAt(
    wholeSecondMs - portalOffsetMsAt(wholeSecondMs),
  );
  return wholeSecondMs - offset + fractionMs;
}

/**
 * A portal timestamp -> ISO instant. An explicit zone (`Z`, `+05:30`) is already an instant and is
 * taken as written; a bare wall clock is read as the portal zone. `null` when unparseable.
 */
function portalIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const wall =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      text,
    );
  if (wall === null) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
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
  const instant = portalWallClockToEpochMs(wallMs);
  if (Number.isNaN(instant)) return null;
  const iso = new Date(instant).toISOString();
  return iso.startsWith("Invalid") ? null : iso;
}

function isoFromOptions(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return portalIso(value) ?? fallback;
}

function ageSecondsBetween(iso: string, observedAtIso: string): number | null {
  const accepted = Date.parse(iso);
  const observed = Date.parse(observedAtIso);
  if (Number.isNaN(accepted) || Number.isNaN(observed)) return null;
  return Math.max(0, Math.floor((observed - accepted) / 1000));
}

// -------------------------------------------------------------------------------------------------
// Market text parsing
// -------------------------------------------------------------------------------------------------

/** The last standalone American price in the text (`-110`, `+136`); `null` when absent. */
function americanFromText(text: string): number | null {
  let last: number | null = null;
  for (const match of text.matchAll(/([+-]\d{3,4})(?!\d)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value !== 0) last = value;
  }
  return last;
}

/** `-110` -> 0.5238…, `+136` -> 0.4237…; `null` when absent. */
function impliedProbFromAmerican(american: number | null): number | null {
  if (american === null) return null;
  const probability =
    american > 0 ? 100 / (american + 100) : -american / (-american + 100);
  return probability > 0 && probability < 1 ? probability : null;
}

/**
 * The last line/value in the selection after the American price is removed: `Lakers -10 -145` ->
 * `-10`, `Over 244.5 -114` -> `244.5`, `Massachusetts +136` -> `null` (a moneyline has no line).
 */
function lineFromText(text: string): number | null {
  const withoutPrice = text.replace(/[+-]\d{3,4}(?!\d)/g, " ");
  let last: number | null = null;
  for (const match of withoutPrice.matchAll(
    /(?:^|[\s(])([+-]?\d+(?:\.\d+)?)(?=[\s),]|$)/g,
  )) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) last = value;
  }
  return last;
}

/** `ShortDesc` newlines/`&#x0D;` artefacts -> one readable ` | `-joined line for `description`. */
function collapseDescription(value: unknown): string {
  return asText(value)
    .replace(/&#x0D;?/gi, "\n")
    .replace(/\\r\\n|\\n|\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");
}

function vipFromWire(value: unknown): boolean {
  const text = asText(value);
  return text !== "" && text !== "0" && text.toLowerCase() !== "false";
}

const CHANNEL_BY_WRITER: Readonly<
  Record<string, IncomingBetRecord["channel"]>
> = {
  Internet: "INTERNET",
  ALERT: "ALERT",
  GSLIVE: "GSLIVE",
  GSBUILDER: "GSBUILDER",
};

/**
 * `TicketWriter` -> the wide channel union. The f402 demux knows eleven bounded codes; the wide
 * record keeps five, so every code outside the four named writers stays `OTHER`.
 */
function channelOf(ticketWriter: unknown): IncomingBetRecord["channel"] {
  const demuxed = demuxChannel(ticketWriter);
  return CHANNEL_BY_WRITER[demuxed] ?? "OTHER";
}

/**
 * Wager type code -> kind. Only `S`/`P` have evidence (a description with several legs is a
 * parlay regardless of code); the undocumented codes stay `other` instead of being guessed.
 */
function wagerKindOf(
  wagerType: string,
  legCount: number,
): IncomingBetRecord["wagerKind"] {
  if (legCount >= 2) return "parlay";
  const code = wagerType.trim().toUpperCase();
  if (code === "S") return "straight";
  if (code === "P") return "parlay";
  return "other";
}

/** `${ticket}-${leg}` for a ticket-leg source, the wager number for a one-part ticker row. */
function deriveBetKey(
  ticketNumber: string,
  wagerNumber: string,
  ticketKey: string,
): string {
  if (ticketKey !== "") return ticketKey;
  if (ticketNumber === "" && wagerNumber === "") return "";
  if (ticketNumber === "" || ticketNumber === wagerNumber) {
    return wagerNumber === "" ? ticketNumber : wagerNumber;
  }
  return wagerNumber === "" ? ticketNumber : `${ticketNumber}-${wagerNumber}`;
}

// -------------------------------------------------------------------------------------------------
// Widening
// -------------------------------------------------------------------------------------------------

/** The raw `getBetTicker` wire row spelling, normalized from either the wire or `F402TickerRow`. */
const TICKER_WIRE_KEYS = [
  "WagerNumber",
  "TicketNumber",
  "AgentID",
  "AgentLogin",
  "CustomerID",
  "Login",
  "WagerType",
  "ShortDesc",
  "InsertDateTime",
  "TicketWriter",
  "VIP",
  "AmountWagered",
  "ToWinAmount",
  "VolumeAmount",
] as const;

/**
 * `lib/f402_ingest.ts` normalizes the raw row into camelCase; the capture files keep the wire
 * spelling. Map the normalized shape back so one builder widens both without a second code path.
 */
function asWireRow(row: Record<string, unknown>): Record<string, unknown> {
  if (TICKER_WIRE_KEYS.some((key) => key in row)) return row;
  if (!("wagerNumber" in row || "shortDesc" in row)) return row;
  const customerId = row["customerId"];
  return {
    WagerNumber: row["wagerNumber"],
    TicketNumber: row["ticketNumber"],
    AgentID: row["agentId"],
    AgentLogin: row["agentLogin"],
    CustomerID: customerId === undefined ? row["login"] : customerId,
    Login: row["login"],
    WagerType: row["wagerType"],
    ShortDesc: row["shortDesc"],
    InsertDateTime: row["insertedAt"],
    TicketWriter: row["ticketWriter"],
    VIP: row["vip"],
    AmountWagered: row["amountWagered"],
    ToWinAmount: row["toWinAmount"],
    VolumeAmount: row["volumeAmount"],
  };
}

/**
 * Map the structured market parse onto the v2 record fields. Deliberately additive: the legacy v1
 * fields (`sport`/`period`/`selection`/`line`/`americanOdds`) keep the v1 derivation, so every v1
 * rule and test is unchanged; these fields add depth the rules can now target.
 */
function marketFieldsOf(
  market: ParsedMarket,
): Pick<
  IncomingBetRecord,
  | "eventLabel"
  | "eventKey"
  | "marketKey"
  | "marketType"
  | "periodLabel"
  | "side"
  | "playerName"
  | "isPlayerProp"
  | "isAltLine"
> {
  return {
    eventLabel: market.eventLabel,
    eventKey: eventKeyFor(market),
    marketKey: marketKeyFor(market),
    marketType: market.marketType,
    periodLabel: market.periodLabel,
    side: market.side,
    playerName: market.playerName,
    // A player prop is a prop market carrying a player, or an explicit player-prop market.
    isPlayerProp:
      market.marketType === "player_prop" || market.playerName !== null,
    isAltLine: market.isAltLine,
  };
}

/**
 * The v3 derived numeric fields, computed by every widener so rules never repeat the arithmetic:
 *  - `stakeToWinRatio`: stake / potential win, only meaningful when to-win > 0;
 *  - `stakePerLeg`: stake split across the ticket's legs (the whole stake when legs are unknown);
 *  - `oddsFromEven`: absolute distance of the American price from +100 (+100 -> 0, +400 -> 300,
 *    -110 -> 210), so a rule can say "this far from even money" without sign juggling.
 */
function derivedNumericFields(input: {
  stakeUsd: number | null;
  toWinUsd: number | null;
  legs: number;
  americanOdds: number | null;
}): Pick<
  IncomingBetRecord,
  "stakeToWinRatio" | "stakePerLeg" | "oddsFromEven"
> {
  const { stakeUsd, toWinUsd, legs, americanOdds } = input;
  const stakeToWinRatio =
    stakeUsd !== null && toWinUsd !== null && toWinUsd > 0
      ? stakeUsd / toWinUsd
      : null;
  const stakePerLeg =
    stakeUsd === null ? null : legs > 0 ? stakeUsd / legs : stakeUsd;
  const oddsFromEven =
    americanOdds === null ? null : Math.abs(americanOdds - 100);
  return { stakeToWinRatio, stakePerLeg, oddsFromEven };
}

function buildTickerRecord(
  wire: Record<string, unknown>,
  source: IncomingBetSource,
  observedAt: string,
  raw: Record<string, unknown>,
): IncomingBetRecord | null {
  const login = asText(wire["Login"]) || asText(wire["CustomerID"]);
  const customerId = login.trim().toUpperCase();
  if (customerId === "") return null;

  const ticketNumber = asText(wire["TicketNumber"]);
  const wagerNumber = asText(wire["WagerNumber"]);
  const betKey = deriveBetKey(ticketNumber, wagerNumber, "");
  if (betKey === "") return null;

  const ticketWriter = asText(wire["TicketWriter"]);
  const shortDesc = asText(wire["ShortDesc"]);
  const description = collapseDescription(shortDesc);
  const parsed = parseShortDesc(shortDesc);
  const leg = parsed.legs[0];
  const selection = leg === undefined ? "" : leg.pick.trim();
  const sport = leg === undefined ? "" : leg.sport.trim();
  const period = leg === undefined ? "" : leg.period.trim();
  const subSport = leg === undefined ? "" : leg.market.trim();
  const shortDescription =
    selection !== "" ? selection : description.slice(0, 120);

  const sentinel = isSentinelChannel(demuxChannel(ticketWriter));
  const money = (value: number | null): number | null => {
    if (value === null) return null;
    return sentinel ? 0 : amountToCents(value) / 100;
  };
  const stakeUsd = money(asNumberOrNull(wire["AmountWagered"]));
  const americanOdds =
    americanFromText(selection) ?? americanFromText(description);
  const acceptedAtIso = portalIso(wire["InsertDateTime"]) ?? observedAt;
  // v2 depth: the parser normalizes `ShortDesc` (CRLF/`&#x0D;`/unicode halves) and reads the line
  // and rotation the v1 text heuristics miss, so it wins for those two fields and supplies the
  // market fields; every other v1 field keeps its v1 derivation.
  const market = parseBetMarket(shortDesc, { sport, period });
  const toWinUsd = money(asNumberOrNull(wire["ToWinAmount"]));
  const volumeUsd = money(asNumberOrNull(wire["VolumeAmount"]));
  const derived = derivedNumericFields({
    stakeUsd,
    toWinUsd,
    legs: parsed.legs.length,
    americanOdds,
  });

  return {
    schemaVersion: 1,
    betKey,
    ticketNumber,
    wagerNumber,
    customerId,
    agentId: asText(wire["AgentID"]).toUpperCase(),
    agentLogin: asText(wire["AgentLogin"]).toUpperCase(),
    agentLevel: null,
    channel: channelOf(ticketWriter),
    wagerType: asText(wire["WagerType"]),
    wagerKind: wagerKindOf(asText(wire["WagerType"]), parsed.legs.length),
    sport,
    league: "",
    subSport,
    period,
    rotationNumber: market.rotationNumber,
    selection,
    description,
    shortDescription,
    americanOdds,
    impliedProb: impliedProbFromAmerican(americanOdds),
    // The parser reads `O 60.5` / `-4.5` shapes the selection-only heuristic misses.
    line: market.line ?? lineFromText(selection),
    stakeUsd,
    toWinUsd,
    volumeUsd,
    // The book's risk on a straight ticket is the amount wagered; `volumeUsd` stays its own field.
    riskUsd: stakeUsd,
    ...derived,
    isLive: parsed.isLive,
    isVip: vipFromWire(wire["VIP"]),
    acceptedAt: acceptedAtIso,
    observedAt,
    ageSeconds: ageSecondsBetween(acceptedAtIso, observedAt),
    source,
    raw: { ...raw },
    ...marketFieldsOf(market),
    context: null,
  };
}

/**
 * Wide one `getBetTicker` row. Accepts the raw wire row and the camelCase `F402TickerRow` from
 * `lib/f402_ingest.ts`; `null` for a row with no login or no ticket identity.
 */
export function widenTickerRow(
  row: unknown,
  options: { source?: IncomingBetSource; observedAt?: string } = {},
): IncomingBetRecord | null {
  if (!isRecord(row)) return null;
  const observedAt = isoFromOptions(
    options.observedAt,
    new Date().toISOString(),
  );
  return buildTickerRecord(
    asWireRow(row),
    options.source ?? "live-ticker",
    observedAt,
    row,
  );
}

/**
 * Wide one `data/live-wagers.json` `LIST` row (the same wire shape as `getBetTicker`). The file's
 * `observedAt` is a file-level fact, so the caller passes it in.
 */
export function widenWagerRow(
  row: unknown,
  options: { observedAt?: string } = {},
): IncomingBetRecord | null {
  if (!isRecord(row)) return null;
  const observedAt = isoFromOptions(
    options.observedAt,
    new Date().toISOString(),
  );
  return buildTickerRecord(asWireRow(row), "capture-wagers", observedAt, row);
}

function pendingAgent(row: Record<string, unknown>): {
  agentId: string;
  agentLevel: number | null;
} {
  const agent = row["agent"];
  if (typeof agent === "string") {
    return { agentId: agent.trim().toUpperCase(), agentLevel: null };
  }
  if (!isRecord(agent)) return { agentId: "", agentLevel: null };
  const agentId =
    asText(agent["id"]) || asText(agent["key"]) || asText(agent["agentId"]);
  return {
    agentId: agentId.toUpperCase(),
    agentLevel: asIntegerOrNull(agent["level"]),
  };
}

/**
 * Wide one `data/live-bets.json` `games` row (`Report/Pending`). It is a ticket-leg row: the
 * `ticketKey` names the pair, `agent.level` rides along, and `picks` answers parlay vs straight.
 */
export function widenPendingRow(
  row: unknown,
  options: { observedAt?: string } = {},
): IncomingBetRecord | null {
  if (!isRecord(row)) return null;
  const observedAt = isoFromOptions(
    options.observedAt,
    new Date().toISOString(),
  );

  const customerId = (
    asText(row["customerID"]) ||
    asText(row["customerId"]) ||
    asText(row["login"])
  )
    .trim()
    .toUpperCase();
  if (customerId === "") return null;

  const ticketNumber = asText(row["ticketNumber"]);
  const wagerNumber = asText(row["wagerNumber"]);
  const betKey = deriveBetKey(
    ticketNumber,
    wagerNumber,
    asText(row["ticketKey"]),
  );
  if (betKey === "") return null;

  const { agentId, agentLevel } = pendingAgent(row);
  const description = collapseDescription(row["description"]);
  const chosenTeam = asText(row["chosenTeam"]);
  const segments = description.split(" / ");
  const selection =
    chosenTeam !== "" ? chosenTeam : asText(segments[segments.length - 1]);
  const picks = asIntegerOrNull(row["picks"]) ?? 0;
  const americanOdds =
    americanFromText(selection) ?? americanFromText(description);
  const acceptedAtIso =
    portalIso(row["acceptedAt"]) ??
    portalIso(row["gameDateTime"]) ??
    observedAt;
  const stakeUsd = asNumberOrNull(row["wagered"]);
  const toWinUsd = asNumberOrNull(row["toWin"]);
  const team1 = isRecord(row["team1"]) ? row["team1"] : undefined;
  const team2 = isRecord(row["team2"]) ? row["team2"] : undefined;
  const isLive = parseShortDesc(description).isLive;
  // `Report/Pending` keeps the market in prose + structured columns; the hints are what make the
  // team names and chosen side readable without guessing from the description alone.
  const market = parseBetMarket(description, {
    sport: asText(row["sport"]),
    period: asText(row["period"]),
    team1: team1 === undefined ? "" : asText(team1["name"]),
    team2: team2 === undefined ? "" : asText(team2["name"]),
    chosenTeam,
    description,
    live: isLive,
  });

  return {
    schemaVersion: 1,
    betKey,
    ticketNumber,
    wagerNumber,
    customerId,
    agentId,
    agentLogin: agentId,
    agentLevel,
    // `Report/Pending` carries no TicketWriter: the channel is unknown here, never invented.
    channel: "OTHER",
    wagerType: asText(row["wagerType"]),
    // `picks` is direct evidence: one pick is a straight ticket, several are a parlay. The
    // Pending `wagerType` code is not consulted here (its meaning is not documented in this repo).
    wagerKind: picks >= 2 ? "parlay" : picks === 1 ? "straight" : "other",
    sport: asText(row["sport"]),
    league: "",
    subSport: asText(row["subSport"]),
    period: asText(row["period"]),
    // `Report/Pending` carries the game rotation on the teams; the parser can also read one out of
    // the description, and wins when it does.
    rotationNumber:
      market.rotationNumber ??
      firstNumber(
        team1 === undefined ? null : asIntegerOrNull(team1["rotationNumber"]),
        team2 === undefined ? null : asIntegerOrNull(team2["rotationNumber"]),
      ),
    selection,
    description,
    shortDescription: chosenTeam !== "" ? chosenTeam : selection,
    americanOdds,
    impliedProb: impliedProbFromAmerican(americanOdds),
    // The parser normalizes unicode halves (`115½` -> 115.5) and reads the line the v1
    // selection-only heuristic misses.
    line: market.line ?? lineFromText(selection),
    stakeUsd,
    toWinUsd,
    // No volume field on this report: absent stays null rather than mirroring the stake.
    volumeUsd: null,
    riskUsd: stakeUsd,
    ...derivedNumericFields({
      stakeUsd,
      toWinUsd,
      legs: picks,
      americanOdds,
    }),
    isLive,
    isVip: false,
    acceptedAt: acceptedAtIso,
    observedAt,
    ageSeconds: ageSecondsBetween(acceptedAtIso, observedAt),
    source: "capture-bets",
    raw: { ...row },
    ...marketFieldsOf(market),
    context: null,
  };
}

// -------------------------------------------------------------------------------------------------
// Rule validation (fail closed, every error collected)
// -------------------------------------------------------------------------------------------------

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "rules"]);
const RULE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "severity",
  "enabled",
  "description",
  "tags",
  "when",
  "aggregate",
]);
const AGGREGATE_KEYS: ReadonlySet<string> = new Set([
  "groupBy",
  "windowSeconds",
  "where",
  "countAtLeast",
  "sumField",
  "sumAtLeast",
  "distinctField",
  "distinctAtLeast",
]);
const LEAF_KEYS: ReadonlySet<string> = new Set(["field", "op", "value"]);
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_WINDOW_SECONDS = 86_400;

function listAllowed(values: Iterable<string>): string {
  return [...values].sort().join(", ");
}

interface PredicateContext {
  path: string;
  errors: string[];
}

function parsePredicate(
  value: unknown,
  context: PredicateContext,
): Predicate | null {
  if (!isRecord(value)) {
    context.errors.push(`${context.path}: predicate must be a mapping`);
    return null;
  }
  const keys = Object.keys(value);
  const branch = keys.filter(
    (key) => key === "all" || key === "any" || key === "not",
  );
  const leaf = keys.filter((key) => LEAF_KEYS.has(key));
  const unknown = keys.filter(
    (key) => !LEAF_KEYS.has(key) && !["all", "any", "not"].includes(key),
  );
  for (const key of unknown) {
    context.errors.push(
      `${context.path}: unknown predicate key "${key}" (use all/any/not or field/op/value)`,
    );
  }
  if (branch.length > 0 && leaf.length > 0) {
    context.errors.push(
      `${context.path}: a predicate is either all/any/not or a field leaf, not both`,
    );
    return null;
  }
  if (branch.length > 1) {
    context.errors.push(
      `${context.path}: a predicate takes one of all/any/not, not ${branch.join(" + ")}`,
    );
    return null;
  }
  if (unknown.length > 0 && branch.length === 0 && leaf.length === 0) {
    return null;
  }
  if (branch.length === 1) {
    const key = branch[0] as "all" | "any" | "not";
    if (key === "not") {
      const inner = parsePredicate(value[key], {
        path: `${context.path}.not`,
        errors: context.errors,
      });
      return inner === null ? null : { not: inner };
    }
    const list = value[key];
    if (!Array.isArray(list)) {
      context.errors.push(
        `${context.path}.${key}: must be a list of predicates`,
      );
      return null;
    }
    if (list.length === 0) {
      context.errors.push(
        `${context.path}.${key}: must not be empty (an empty ${key} can never express a rule)`,
      );
      return null;
    }
    const children: Predicate[] = [];
    let failed = false;
    list.forEach((entry, index) => {
      const child = parsePredicate(entry, {
        path: `${context.path}.${key}[${index}]`,
        errors: context.errors,
      });
      if (child === null) failed = true;
      else children.push(child);
    });
    if (failed) return null;
    return key === "all" ? { all: children } : { any: children };
  }
  return parseLeaf(value, context);
}

/**
 * `value: { fieldRef: "<numeric field>" }` — compare a leaf against another field on the SAME
 * record. Fail closed: exactly one key, a known numeric field (never a string or `context.*`),
 * never the leaf's own field, and no nesting (`{ fieldRef: { … } }` is refused).
 */
function parseFieldRefValue(
  raw: Record<string, unknown>,
  field: string,
  op: string,
  context: PredicateContext,
): { fieldRef: string } | null {
  if (!FIELD_REF_OPS.has(op)) {
    context.errors.push(
      `${context.path}.value: op "${op}" does not take a fieldRef (only eq/neq/gt/gte/lt/lte do)`,
    );
    return null;
  }
  const before = context.errors.length;
  for (const key of Object.keys(raw)) {
    if (key !== "fieldRef") {
      context.errors.push(
        `${context.path}.value: unknown key "${key}" in a field reference (only fieldRef is allowed)`,
      );
    }
  }
  const ref = raw["fieldRef"];
  if (typeof ref !== "string" || ref.trim() === "") {
    context.errors.push(
      `${context.path}.value.fieldRef: must be a non-empty numeric field name (nesting is not allowed)`,
    );
  } else if (ref === field) {
    context.errors.push(
      `${context.path}.value.fieldRef: a rule cannot compare "${field}" with itself`,
    );
  } else if (!NUMERIC_FIELD_SET.has(ref)) {
    context.errors.push(
      `${context.path}.value.fieldRef: unknown numeric field "${ref}" (allowed: ${NUMERIC_FIELDS.join(", ")})`,
    );
  }
  if (context.errors.length > before) return null;
  return { fieldRef: ref as string };
}

function parseLeaf(
  value: Record<string, unknown>,
  context: PredicateContext,
): Predicate | null {
  const before = context.errors.length;
  const field = value["field"];
  const op = value["op"];
  if (typeof field !== "string" || field.trim() === "") {
    context.errors.push(`${context.path}: field must be a non-empty string`);
  } else if (!FIELD_SET.has(field)) {
    context.errors.push(
      `${context.path}: unknown field "${field}" (allowed: ${BET_FLAG_FIELDS.join(", ")})`,
    );
  }
  if (typeof op !== "string" || op.trim() === "") {
    context.errors.push(`${context.path}: op must be a non-empty string`);
  } else if (!OP_SET.has(op)) {
    context.errors.push(
      `${context.path}: unknown op "${op}" (allowed: ${BET_FLAG_OPS.join(", ")})`,
    );
  }
  if (context.errors.length > before) return null;

  const resolvedFile = field as string;
  const resolvedOp = op as string;
  const hasValue = "value" in value;
  const raw = value["value"];

  if (resolvedOp === "exists") {
    if (hasValue && typeof raw !== "boolean") {
      context.errors.push(
        `${context.path}.value: exists takes a boolean (true means present)`,
      );
      return null;
    }
    return hasValue
      ? { field: resolvedFile, op: resolvedOp, value: raw }
      : { field: resolvedFile, op: resolvedOp };
  }

  if (!hasValue) {
    context.errors.push(`${context.path}: op "${resolvedOp}" needs a value`);
    return null;
  }

  // v3: a mapping value is a cross-field reference (only on the comparison ops).
  if (isRecord(raw)) {
    const reference = parseFieldRefValue(
      raw,
      resolvedFile,
      resolvedOp,
      context,
    );
    return reference === null
      ? null
      : { field: resolvedFile, op: resolvedOp, value: reference };
  }

  if (
    resolvedOp === "gt" ||
    resolvedOp === "gte" ||
    resolvedOp === "lt" ||
    resolvedOp === "lte"
  ) {
    if (!isFiniteNumber(raw)) {
      context.errors.push(
        `${context.path}.value: op "${resolvedOp}" needs a finite number`,
      );
      return null;
    }
    return { field: resolvedFile, op: resolvedOp, value: raw };
  }
  if (resolvedOp === "between") {
    if (!Array.isArray(raw) || raw.length !== 2) {
      context.errors.push(
        `${context.path}.value: op "between" needs exactly two numbers [lo, hi]`,
      );
      return null;
    }
    const [low, high] = raw as [unknown, unknown];
    if (!isFiniteNumber(low) || !isFiniteNumber(high)) {
      context.errors.push(
        `${context.path}.value: op "between" needs two finite numbers`,
      );
      return null;
    }
    if (low > high) {
      context.errors.push(
        `${context.path}.value: op "between" needs lo <= hi (got [${low}, ${high}])`,
      );
      return null;
    }
    return { field: resolvedFile, op: resolvedOp, value: [low, high] };
  }
  if (resolvedOp === "in" || resolvedOp === "not_in") {
    if (!Array.isArray(raw) || raw.length === 0) {
      context.errors.push(
        `${context.path}.value: op "${resolvedOp}" needs a non-empty list`,
      );
      return null;
    }
    if (!raw.every(isScalar)) {
      context.errors.push(
        `${context.path}.value: op "${resolvedOp}" takes a list of scalars`,
      );
      return null;
    }
    return { field: resolvedFile, op: resolvedOp, value: [...raw] };
  }
  if (resolvedOp === "contains") {
    if (typeof raw !== "string" || raw === "") {
      context.errors.push(
        `${context.path}.value: op "contains" needs a non-empty string (case-insensitive substring)`,
      );
      return null;
    }
    return { field: resolvedFile, op: resolvedOp, value: raw };
  }
  if (resolvedOp === "matches") {
    if (typeof raw !== "string" || raw === "") {
      context.errors.push(
        `${context.path}.value: op "matches" needs a non-empty regular expression source`,
      );
      return null;
    }
    try {
      new RegExp(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      context.errors.push(
        `${context.path}.value: invalid regular expression "${raw}": ${detail}`,
      );
      return null;
    }
    return { field: resolvedFile, op: resolvedOp, value: raw };
  }
  if (!isScalar(raw)) {
    context.errors.push(
      `${context.path}.value: op "${resolvedOp}" takes a scalar (string, number, boolean or null)`,
    );
    return null;
  }
  return { field: resolvedFile, op: resolvedOp, value: raw };
}

function parseAggregate(
  value: unknown,
  context: PredicateContext,
): BetFlagAggregate | null {
  if (!isRecord(value)) {
    context.errors.push(`${context.path}: aggregate must be a mapping`);
    return null;
  }
  const before = context.errors.length;
  for (const key of Object.keys(value)) {
    if (!AGGREGATE_KEYS.has(key)) {
      context.errors.push(
        `${context.path}: unknown aggregate key "${key}" (allowed: ${listAllowed(AGGREGATE_KEYS)})`,
      );
    }
  }

  const groupBy = value["groupBy"];
  if (typeof groupBy !== "string" || !GROUP_BY_SET.has(groupBy)) {
    context.errors.push(
      `${context.path}.groupBy: must be one of ${AGGREGATE_GROUP_BY.join(", ")}`,
    );
  }
  const windowSeconds = value["windowSeconds"];
  if (
    !isFiniteNumber(windowSeconds) ||
    !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 ||
    windowSeconds > MAX_WINDOW_SECONDS
  ) {
    context.errors.push(
      `${context.path}.windowSeconds: must be an integer between 1 and ${MAX_WINDOW_SECONDS}`,
    );
  }

  const countAtLeast = value["countAtLeast"];
  if (
    countAtLeast !== undefined &&
    (!isFiniteNumber(countAtLeast) ||
      !Number.isSafeInteger(countAtLeast) ||
      countAtLeast < 1)
  ) {
    context.errors.push(
      `${context.path}.countAtLeast: must be an integer >= 1`,
    );
  }
  const sumField = value["sumField"];
  if (sumField !== undefined) {
    if (typeof sumField !== "string" || !SUM_FIELD_SET.has(sumField)) {
      context.errors.push(
        `${context.path}.sumField: must be one of ${AGGREGATE_SUM_FIELDS.join(", ")}`,
      );
    }
  }
  const sumAtLeast = value["sumAtLeast"];
  if (
    sumAtLeast !== undefined &&
    (!isFiniteNumber(sumAtLeast) || sumAtLeast <= 0)
  ) {
    context.errors.push(
      `${context.path}.sumAtLeast: must be a finite number > 0`,
    );
  }
  const distinctField = value["distinctField"];
  if (distinctField !== undefined) {
    if (
      typeof distinctField !== "string" ||
      !DISTINCT_FIELD_SET.has(distinctField)
    ) {
      context.errors.push(
        `${context.path}.distinctField: must be one of ${AGGREGATE_DISTINCT_FIELDS.join(", ")}`,
      );
    }
  }
  const distinctAtLeast = value["distinctAtLeast"];
  if (
    distinctAtLeast !== undefined &&
    (!isFiniteNumber(distinctAtLeast) ||
      !Number.isSafeInteger(distinctAtLeast) ||
      distinctAtLeast < 1)
  ) {
    context.errors.push(
      `${context.path}.distinctAtLeast: must be an integer >= 1`,
    );
  }
  if (
    value["countAtLeast"] === undefined &&
    value["sumAtLeast"] === undefined &&
    value["distinctAtLeast"] === undefined
  ) {
    context.errors.push(
      `${context.path}: aggregate needs countAtLeast or sumAtLeast (or distinctField + distinctAtLeast)`,
    );
  }
  if (sumAtLeast !== undefined && sumField === undefined) {
    context.errors.push(`${context.path}: sumAtLeast needs sumField`);
  }
  if (sumField !== undefined && sumAtLeast === undefined) {
    context.errors.push(`${context.path}: sumField needs sumAtLeast`);
  }
  if (distinctAtLeast !== undefined && distinctField === undefined) {
    context.errors.push(`${context.path}: distinctAtLeast needs distinctField`);
  }
  if (distinctField !== undefined && distinctAtLeast === undefined) {
    context.errors.push(`${context.path}: distinctField needs distinctAtLeast`);
  }

  let where: Predicate | undefined;
  if (value["where"] !== undefined) {
    const parsed = parsePredicate(value["where"], {
      path: `${context.path}.where`,
      errors: context.errors,
    });
    if (parsed !== null) where = parsed;
  }

  if (context.errors.length > before) return null;
  return {
    groupBy: groupBy as BetFlagAggregate["groupBy"],
    windowSeconds: windowSeconds as number,
    ...(where === undefined ? {} : { where }),
    ...(countAtLeast === undefined
      ? {}
      : { countAtLeast: countAtLeast as number }),
    ...(sumField === undefined
      ? {}
      : { sumField: sumField as NonNullable<BetFlagAggregate["sumField"]> }),
    ...(sumAtLeast === undefined ? {} : { sumAtLeast: sumAtLeast as number }),
    ...(distinctField === undefined
      ? {}
      : {
          distinctField: distinctField as NonNullable<
            BetFlagAggregate["distinctField"]
          >,
        }),
    ...(distinctAtLeast === undefined
      ? {}
      : { distinctAtLeast: distinctAtLeast as number }),
  };
}

function parseRule(
  value: unknown,
  path: string,
  errors: string[],
): BetFlagRule | null {
  if (!isRecord(value)) {
    errors.push(`${path}: rule must be a mapping`);
    return null;
  }
  const before = errors.length;
  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) {
      errors.push(
        `${path}: unknown rule key "${key}" (allowed: ${listAllowed(RULE_KEYS)})`,
      );
    }
  }

  const id = value["id"];
  if (typeof id !== "string" || !RULE_ID_PATTERN.test(id)) {
    errors.push(
      `${path}.id: must be a stable slug (letters, digits, _ . -; up to 64 chars)`,
    );
  }
  const title = value["title"];
  if (typeof title !== "string" || title.trim() === "") {
    errors.push(`${path}.title: must be a non-empty string`);
  }
  const severity = value["severity"];
  if (typeof severity !== "string" || !SEVERITY_SET.has(severity)) {
    errors.push(
      `${path}.severity: unknown severity "${String(severity)}" (allowed: ${FLAG_SEVERITIES.join(", ")})`,
    );
  }
  if (typeof value["enabled"] !== "boolean") {
    errors.push(`${path}.enabled: must be true or false (state it explicitly)`);
  }

  let description: string | undefined;
  if (value["description"] !== undefined) {
    if (typeof value["description"] !== "string") {
      errors.push(`${path}.description: must be a string`);
    } else {
      description = value["description"];
    }
  }

  let tags: readonly string[] | undefined;
  if (value["tags"] !== undefined) {
    const raw = value["tags"];
    if (!Array.isArray(raw)) {
      errors.push(`${path}.tags: must be a list of strings`);
    } else if (
      !raw.every((tag) => typeof tag === "string" && tag.trim() !== "")
    ) {
      errors.push(`${path}.tags: must be a list of non-empty strings`);
    } else {
      tags = raw.map((tag) => String(tag).trim());
    }
  }

  let when: Predicate | undefined;
  if (value["when"] === undefined) {
    errors.push(`${path}.when: missing required key`);
  } else {
    const parsed = parsePredicate(value["when"], {
      path: `${path}.when`,
      errors,
    });
    if (parsed !== null) when = parsed;
  }

  let aggregate: BetFlagAggregate | undefined;
  if (value["aggregate"] !== undefined) {
    const parsed = parseAggregate(value["aggregate"], {
      path: `${path}.aggregate`,
      errors,
    });
    if (parsed !== null) aggregate = parsed;
  }

  if (errors.length > before) return null;
  return {
    id: id as string,
    title: (title as string).trim(),
    severity: severity as FlagSeverity,
    enabled: value["enabled"] as boolean,
    ...(description === undefined ? {} : { description }),
    ...(tags === undefined ? {} : { tags }),
    when: when as Predicate,
    ...(aggregate === undefined ? {} : { aggregate }),
  };
}

function invalidRules(path: string, errors: readonly string[]): RuleLoadResult {
  // Every collected error already leads with the file path and the offending JSON path.
  const first = errors[0] ?? `${path}: rules are invalid`;
  const message =
    errors.length > 1 ? `${first} (+${errors.length - 1} more)` : first;
  return {
    ok: false,
    code: "rules_invalid",
    message,
    errors: [...errors],
    path,
  };
}

/**
 * Parse and validate a rule pack. Syntax errors and every schema violation are collected; no
 * partial pack is ever returned. `Bun.YAML.parse` errors carry no line number, so messages lead
 * with the file path and the JSON-path of the offending node.
 */
export function parseBetFlagRules(
  text: string,
  options: { path?: string } = {},
): RuleLoadResult {
  const path = options.path ?? "<inline>";
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return invalidRules(path, [`${path}: invalid YAML: ${detail}`]);
  }
  if (raw === null || raw === undefined) {
    return invalidRules(path, [`${path}: rule pack is empty`]);
  }
  if (!isRecord(raw)) {
    return invalidRules(path, [
      `${path}: top level must be a mapping with schemaVersion and rules`,
    ]);
  }

  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(
        `${path}: unknown key "${key}" (allowed: ${listAllowed(TOP_LEVEL_KEYS)})`,
      );
    }
  }
  if (raw["schemaVersion"] !== 1) {
    errors.push(`${path}.schemaVersion: must be 1`);
  }
  const rulesRaw = raw["rules"];
  if (!Array.isArray(rulesRaw)) {
    errors.push(`${path}.rules: must be a list of rules`);
    return invalidRules(path, errors);
  }
  if (rulesRaw.length === 0) {
    errors.push(`${path}.rules: must contain at least one rule`);
    return invalidRules(path, errors);
  }

  const rules: BetFlagRule[] = [];
  const seen = new Set<string>();
  rulesRaw.forEach((entry, index) => {
    const rule = parseRule(entry, `${path}: rules[${index}]`, errors);
    if (rule === null) return;
    if (seen.has(rule.id)) {
      errors.push(
        `${path}: rules[${index}].id: duplicate rule id "${rule.id}"`,
      );
      return;
    }
    seen.add(rule.id);
    rules.push(rule);
  });

  if (errors.length > 0) return invalidRules(path, errors);
  return { ok: true, ruleSet: { schemaVersion: 1, path, rules } };
}

/** Read, parse and validate one YAML rule pack. A missing or unreadable file is a refusal, not a throw. */
export async function loadBetFlagRules(path: string): Promise<RuleLoadResult> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        code: "rules_missing",
        message: `${path}: rule file not found`,
        errors: [],
        path,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "rules_unreadable",
      message: `${path}: ${detail}`,
      errors: [],
      path,
    };
  }
  return parseBetFlagRules(text, { path });
}

// -------------------------------------------------------------------------------------------------
// Evaluation
// -------------------------------------------------------------------------------------------------

/**
 * Read one rule-facing field. Flat record fields resolve directly; `context.<name>` resolves into
 * the enrichment object (`undefined` when the batch was not enriched, so every op fails closed).
 * Arbitrary dotted paths are not walked — only the contracted `context` namespace.
 */
function fieldValue(bet: IncomingBetRecord, field: string): unknown {
  const dot = field.indexOf(".");
  if (dot === -1) {
    return (bet as unknown as Record<string, unknown>)[field];
  }
  const namespace = field.slice(0, dot);
  const name = field.slice(dot + 1);
  if (namespace !== "context" || bet.context === null || name === "") {
    return undefined;
  }
  return (bet.context as unknown as Record<string, unknown>)[name];
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

function existsMatch(actual: unknown, expected: unknown): boolean {
  const present =
    actual !== null &&
    actual !== undefined &&
    !(typeof actual === "string" && actual.trim() === "");
  return expected === false ? !present : present;
}

function compareNumbers(
  actual: unknown,
  expected: unknown,
  accept: (difference: number) => boolean,
): boolean {
  if (!isFiniteNumber(actual) || !isFiniteNumber(expected)) return false;
  return accept(actual - expected);
}

/** Run one comparison with an already-resolved expected value. */
function compareLeaf(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return valuesEqual(actual, expected);
    case "neq":
      return !valuesEqual(actual, expected);
    case "gt":
      return compareNumbers(actual, expected, (delta) => delta > 0);
    case "gte":
      return compareNumbers(actual, expected, (delta) => delta >= 0);
    case "lt":
      return compareNumbers(actual, expected, (delta) => delta < 0);
    case "lte":
      return compareNumbers(actual, expected, (delta) => delta <= 0);
    case "between":
      return (
        Array.isArray(expected) &&
        expected.length === 2 &&
        isFiniteNumber(expected[0]) &&
        isFiniteNumber(expected[1]) &&
        isFiniteNumber(actual) &&
        actual >= expected[0] &&
        actual <= expected[1]
      );
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((candidate) => valuesEqual(actual, candidate))
      );
    case "not_in":
      return !(
        Array.isArray(expected) &&
        expected.some((candidate) => valuesEqual(actual, candidate))
      );
    case "contains":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    case "matches":
      if (typeof actual !== "string" || typeof expected !== "string") {
        return false;
      }
      try {
        return new RegExp(expected).test(actual);
      } catch {
        // Unreachable for a parsed pack (the regex is compiled at validation); fail closed.
        return false;
      }
    case "exists":
      return existsMatch(actual, expected);
    default:
      throw new TypeError(
        `bet flag predicate has unknown op "${op}"; parse rule packs with parseBetFlagRules()`,
      );
  }
}

/** The field a validated `{ fieldRef }` leaf points at, or null for a literal value. */
function leafFieldRef(leaf: { value?: unknown }): string | null {
  if (!isRecord(leaf.value)) return null;
  const ref = leaf.value["fieldRef"];
  return typeof ref === "string" ? ref : null;
}

function leafMatches(
  leaf: { field: string; op: string; value?: unknown },
  bet: IncomingBetRecord,
): boolean {
  const actual = fieldValue(bet, leaf.field);
  const fieldRef = leafFieldRef(leaf);
  if (fieldRef !== null) {
    // v3: compare against another field on the same record. Unknown data on either side is not a
    // match (fail closed): null/absent values never satisfy eq/neq/ranges through a reference.
    const reference = fieldValue(bet, fieldRef);
    if (
      actual === null ||
      actual === undefined ||
      reference === null ||
      reference === undefined
    ) {
      return false;
    }
    return compareLeaf(leaf.op, actual, reference);
  }
  return compareLeaf(leaf.op, actual, leaf.value);
}

function predicateMatches(
  predicate: Predicate,
  bet: IncomingBetRecord,
): boolean {
  if ("all" in predicate) {
    return predicate.all.every((child) => predicateMatches(child, bet));
  }
  if ("any" in predicate) {
    return predicate.any.some((child) => predicateMatches(child, bet));
  }
  if ("not" in predicate) return !predicateMatches(predicate.not, bet);
  return leafMatches(predicate, bet);
}

/** The distinct record fields a predicate touches, for the finding's evidence block. */
function predicateFields(predicate: Predicate): string[] {
  if ("all" in predicate) {
    return predicate.all.flatMap(predicateFields);
  }
  if ("any" in predicate) {
    return predicate.any.flatMap(predicateFields);
  }
  if ("not" in predicate) return predicateFields(predicate.not);
  const referenced = leafFieldRef(predicate);
  return referenced === null
    ? [predicate.field]
    : [predicate.field, referenced];
}

function recordEvidence(
  predicate: Predicate,
  bet: IncomingBetRecord,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of new Set(predicateFields(predicate))) {
    fields[field] = fieldValue(bet, field);
  }
  return { kind: "record", fields };
}

/**
 * Once per `betKey`: an ALERT row mirrors a real ticket and shares its key, so counting both
 * would double a velocity aggregate. The non-ALERT row wins; the first row wins otherwise.
 */
function dedupeRecords(
  records: readonly IncomingBetRecord[],
): IncomingBetRecord[] {
  const byKey = new Map<string, IncomingBetRecord>();
  const unique: IncomingBetRecord[] = [];
  records.forEach((bet, index) => {
    const key = bet.betKey === "" ? `\u0000${index}` : bet.betKey;
    const current = byKey.get(key);
    if (current === undefined) {
      byKey.set(key, bet);
      unique.push(bet);
      return;
    }
    if (current.channel === "ALERT" && bet.channel !== "ALERT") {
      const at = unique.indexOf(current);
      if (at >= 0) unique[at] = bet;
    }
  });
  return unique;
}

function acceptedAtMs(bet: IncomingBetRecord): number | null {
  const parsed = Date.parse(bet.acceptedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

function moreRecentFirst(
  left: IncomingBetRecord,
  right: IncomingBetRecord,
): number {
  const leftMs = acceptedAtMs(left) ?? 0;
  const rightMs = acceptedAtMs(right) ?? 0;
  if (rightMs !== leftMs) return rightMs - leftMs;
  return left.betKey < right.betKey ? -1 : left.betKey > right.betKey ? 1 : 0;
}

/** The dedupe key: once per rule+ticket, or once per rule+group+window bucket for an aggregate. */
export function dedupeKeyFor(
  rule: BetFlagRule,
  bet: IncomingBetRecord,
  evidence?: Record<string, unknown>,
): string {
  if (rule.aggregate !== undefined && evidence !== undefined) {
    const groupValue = evidence["groupValue"];
    const bucketStart = evidence["bucketStart"];
    if (
      typeof groupValue === "string" &&
      groupValue !== "" &&
      typeof bucketStart === "string" &&
      bucketStart !== ""
    ) {
      return `${rule.id}:aggregate:${groupValue}:${bucketStart}`;
    }
  }
  return `${rule.id}:${bet.betKey}`;
}

function aggregateFindings(
  rule: BetFlagRule,
  aggregate: BetFlagAggregate,
  records: readonly IncomingBetRecord[],
  nowMs: number,
  matchedAt: string,
): BetFlagFinding[] {
  const windowMs = aggregate.windowSeconds * 1000;
  const fromMs = nowMs - windowMs;
  // Calendar-aligned bucket: the same group alerts at most once per window, however many scans
  // see it, while a later window can alert again.
  const bucketStartMs = Math.floor(nowMs / windowMs) * windowMs;

  const groups = new Map<string, IncomingBetRecord[]>();
  for (const bet of records) {
    if (!predicateMatches(rule.when, bet)) continue;
    const accepted = acceptedAtMs(bet);
    if (accepted === null || accepted < fromMs || accepted > nowMs) continue;
    if (
      aggregate.where !== undefined &&
      !predicateMatches(aggregate.where, bet)
    ) {
      continue;
    }
    const groupValue = String(fieldValue(bet, aggregate.groupBy));
    const members = groups.get(groupValue);
    if (members === undefined) groups.set(groupValue, [bet]);
    else members.push(bet);
  }

  const findings: BetFlagFinding[] = [];
  for (const groupValue of [...groups.keys()].sort()) {
    const members = groups.get(groupValue);
    if (members === undefined) continue;
    const count = members.length;
    let sum: number | null = null;
    if (aggregate.sumField !== undefined) {
      let total = 0;
      for (const bet of members) {
        const value = fieldValue(bet, aggregate.sumField);
        if (isFiniteNumber(value)) total += value;
      }
      sum = total;
    }
    let distinct: number | null = null;
    if (aggregate.distinctField !== undefined) {
      // An empty identity is "unknown", not a customer/market/agent: it never adds a distinct value.
      const values = new Set<string>();
      for (const bet of members) {
        const value = fieldValue(bet, aggregate.distinctField);
        if (typeof value === "string" && value !== "") values.add(value);
        else if (isFiniteNumber(value)) values.add(String(value));
      }
      distinct = values.size;
    }
    if (
      aggregate.countAtLeast !== undefined &&
      count < aggregate.countAtLeast
    ) {
      continue;
    }
    if (
      aggregate.sumAtLeast !== undefined &&
      (sum === null || sum < aggregate.sumAtLeast)
    ) {
      continue;
    }
    if (
      aggregate.distinctAtLeast !== undefined &&
      (distinct === null || distinct < aggregate.distinctAtLeast)
    ) {
      continue;
    }
    const sorted = [...members].sort(moreRecentFirst);
    const bet = sorted[0];
    if (bet === undefined) continue;
    const evidence: Record<string, unknown> = {
      kind: "aggregate",
      groupBy: aggregate.groupBy,
      groupValue,
      windowSeconds: aggregate.windowSeconds,
      windowStart: new Date(fromMs).toISOString(),
      windowEnd: new Date(nowMs).toISOString(),
      bucketStart: new Date(bucketStartMs).toISOString(),
      count,
      ...(aggregate.sumField === undefined
        ? {}
        : { sumField: aggregate.sumField }),
      ...(sum === null ? {} : { sum }),
      ...(aggregate.distinctField === undefined
        ? {}
        : { distinctField: aggregate.distinctField }),
      ...(distinct === null ? {} : { distinct }),
      memberBetKeys: sorted.slice(0, 10).map((member) => member.betKey),
    };
    findings.push({
      ruleId: rule.id,
      ruleTitle: rule.title,
      severity: rule.severity,
      bet,
      matchedAt,
      dedupeKey: dedupeKeyFor(rule, bet, evidence),
      evidence,
    });
  }
  return findings;
}

/**
 * Evaluate enabled rules over one set of bets. Deterministic for a given input and `now`: rules
 * evaluate in file order, records in input order, aggregate groups in group-value order.
 *
 * `evaluated` counts enabled rules; `skippedDisabled` counts the disabled templates. `matchedAt`
 * is `now` (injected in tests, the scan instant in the CLI).
 */
export function evaluateBetFlagRules(
  records: readonly IncomingBetRecord[],
  rules: readonly BetFlagRule[],
  options: { now?: Date } = {},
): {
  findings: BetFlagFinding[];
  evaluated: number;
  skippedDisabled: number;
} {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const matchedAt = now.toISOString();
  const unique = dedupeRecords(records);
  const findings: BetFlagFinding[] = [];
  let evaluated = 0;
  let skippedDisabled = 0;

  for (const rule of rules) {
    if (!rule.enabled) {
      skippedDisabled += 1;
      continue;
    }
    evaluated += 1;
    if (rule.aggregate !== undefined) {
      findings.push(
        ...aggregateFindings(rule, rule.aggregate, unique, nowMs, matchedAt),
      );
      continue;
    }
    for (const bet of unique) {
      if (!predicateMatches(rule.when, bet)) continue;
      findings.push({
        ruleId: rule.id,
        ruleTitle: rule.title,
        severity: rule.severity,
        bet,
        matchedAt,
        dedupeKey: dedupeKeyFor(rule, bet),
        evidence: recordEvidence(rule.when, bet),
      });
    }
  }

  return { findings, evaluated, skippedDisabled };
}
