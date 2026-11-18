/**
 * @file lib/f402_report_player_analysis.ts
 * @description Request builder, wire parser, CLV price-index verifier, and per-customer /
 * portfolio rollup for `POST /cloud/api/Manager/getReportPlayerAnalysis` and its companion
 * `POST /cloud/api/Manager/getLineTypes` (`app/manager/manager.js:93668`).
 *
 * Wire provenance (observed 2026-11-14 on `manager.html` v1.0.287):
 * - Clicking **Get Data** on `app/manager/module/analysis.js` fires:
 *   1. `POST /cloud/api/Log/write` (`operation: "write"`, `description: "Get Data / Analysis [ v1.0.287 | fantasy402.com ]"`)
 *   2. `POST /cloud/api/Manager/getReportPlayerAnalysis` (`application/x-www-form-urlencoded; charset=UTF-8`):
 *      `agentID`, `agentOwner`, `customerID` (`""` for all customers or a specific customer ID),
 *      `reportType` (default `1`), `startDate` (`YYYY-MM-DD`, default `now - 14d`),
 *      `endDate` (`YYYY-MM-DD`, default `now`), `lineType` (default `1`, or `-1` for all),
 *      `operation: "getReportPlayerAnalysis"`, `RRO: 1`.
 * - Response envelope: `{ LIST: [...] }` where each row carries:
 *   - `CustomerID`: 10-char right-padded string (e.g. `"CUST04_1  "`)
 *   - `PlayerLogin`: unpadded base login (e.g. `"CUST04"`)
 *   - `AgentID`: 10-char right-padded office agent ID (e.g. `"AGNT_A    "`)
 *   - `AgentLogin`: unpadded player/account login (e.g. `"CUST04"`)
 *   - `BETPOINTS`: string decimal points (`"-6.0"`, `"57.5"`) or `null` on Moneyline; records the
 *     pre-buy base spread/total when half-points are bought (`DESCRIPTION` includes `"- buying ½"`)
 *   - `JUICE`: string decimal American odds (`"-110.0"`, `"102.0"`); records the pre-buy base odds
 *   - `CLOSELINE`: closing line + closing juice (`"-6 -110"`, `"135"`, `"-3 -125"`)
 *   - `PRICE`: numeric CLV juice delta in American-odds cents (`oddsToCentIndex(closeJuice) - oddsToCentIndex(betJuice)`),
 *     where negative values mean the player beat the closing price
 *   - `POINTS`: numeric CLV points delta vs. closing line, or `null`
 *   - `DESCRIPTION`: full leg description (`"Football #475 Buccaneers  6½ -108 - buying ½ For Game"`)
 *   - `DAILYFIGUREDATE`: `"YYYY-MM-DD 00:00:00.000"`
 *   - `RISK`, `TOWIN`, `WINLOSE`: stringified integer cents (`"11000"` = $110.00); `WINLOSE` is an
 *     unsigned magnitude (`WINLOSE === RISK` on `"L"`, `WINLOSE === TOWIN` on `"W"`)
 *   - `WAGERSTATUS`: `"W"` | `"L"` | `"P"` | string
 *   - `SPORTSUBTYPE`: 20-char right-padded sub-sport (`"College             "`, `"NFL                 "`)
 *   - `PERIODNUMBER`: string integer (`"0"` = Game, `"1"` = 1st Half)
 *   - `POSTEDDATETIME`: `"YYYY-MM-DD HH:mm:ss.SSS"`
 *   - `SuspectedBot`: `"Y"` | `"N"`
 *   - `SuspectedBotType`: string integer (`"0"` = None, `"1"` = Steam, `"2"` = RAS, `"3"` = Sharp, `"4"`+ = BOT/Syndicate)
 *   - `InetTarget`: entry skin domain (`"betolive.com"`)
 *   - `TOTALBETS`, `BETTERPRICELINES`, `BETTERPOINTSLINES`: summary-mode counters (`null` in detail mode)
 */

import {
  buildAuthenticateCustomerBody,
  decodeJwtExp,
} from "./f402_browser_token_manager.ts";
import { SPORT_FIELD_WIDTH } from "./f402_field_widths.ts";
import { MANAGER_RRO, PROBE_HOST } from "./f402_hierarchy_config.ts";
import { resolveF402BearerTokenDetailed } from "./f402_pending_fetch.ts";
import type { F402ReplayTransport } from "./f402_replay_transport.ts";
import { primeF402Session, readF402Session } from "./f402_session.ts";
import {
  classifySuspectedBot,
  type SuspectedBotLabel,
} from "./f402_transaction_list.ts";
import {
  F402_KEYCHAIN_NAMES,
  readSecretCanonicalThenLegacy,
} from "./secrets.ts";

export const REPORT_PLAYER_ANALYSIS_PATH =
  "/cloud/api/Manager/getReportPlayerAnalysis" as const;

export const LINE_TYPES_PATH = "/cloud/api/Manager/getLineTypes" as const;

export const ANALYSIS_CUSTOMER_ID_PADDED_WIDTH = 10;
export const ANALYSIS_AGENT_ID_PADDED_WIDTH = 10;
export const ANALYSIS_SPORT_SUBTYPE_PADDED_WIDTH = SPORT_FIELD_WIDTH;

/**
 * `reportType` values sent by `app/manager/module/analysis.js` (`1` = book-wide per-customer summary)
 * and `app/manager/module/customer-admin/analysis.js` (`2` = single-customer wager detail).
 */
export const ANALYSIS_REPORT_TYPES = {
  BOOK_SUMMARY: 1,
  PLAYER_DETAIL: 2,
} as const;

/**
 * `lineType` values sent by `analysis.js` (`1` = summary default) and
 * `customer-admin/analysis.html` `<select data-list="line-type">` (`2` = Points wagers, `3` = Price wagers).
 * For any customer in `[startDate, endDate]`, `pointsWagers.length + priceWagers.length === summary.TOTALBETS`.
 */
export const ANALYSIS_LINE_TYPES = {
  SUMMARY_DEFAULT: 1,
  POINTS: 2,
  PRICE: 3,
} as const;

/**
 * Major `SPORTSUBTYPE` whitelist from `app/manager/module/customer-admin/analysis.js`;
 * any wager outside this set increments the portal's `Odd-Ball` counter.
 */
export const ANALYSIS_MAJOR_SPORT_SUBTYPES: ReadonlySet<string> = new Set([
  "NFL",
  "COLLEGE",
  "COLLEGE EXTRA",
  "CANADIAN",
  "NFL PRESEASON",
  "NHL",
  "NBA",
  "MLB",
  "WNBA",
  "NCAA",
  "MLB PRESEASON",
]);

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CHICAGO_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export class ReportPlayerAnalysisError extends Error {
  override readonly name = "ReportPlayerAnalysisError";
}

export interface ReportPlayerAnalysisRequest {
  readonly agentID: string;
  readonly agentOwner?: string;
  /** Empty string `""` (default in `manager.js:93668`) queries all customers under `agentID`. */
  readonly customerID?: string;
  /**
   * Report type (`1` = customer summary rows across all customers, `2` = wager-level detail rows for `customerID`).
   * Default `1`.
   */
  readonly reportType?: number | string;
  /** `YYYY-MM-DD` start date (default: 14 days before `endDate`). */
  readonly startDate: string;
  /** `YYYY-MM-DD` end date (default: today). */
  readonly endDate: string;
  /**
   * Line type code (`1` = default all wagers in detail mode `reportType=2`, `2` = closing-points comparison subset, `-1` = all line types).
   * Default `1`.
   */
  readonly lineType?: number | string;
  readonly rro?: number;
}

export interface LineTypesRequest {
  readonly agentID: string;
  readonly agentOwner?: string;
  readonly sportType?: string;
  readonly rro?: number;
}

export interface LineTypeOption {
  readonly lineType: string;
  readonly displayLineType: string;
}

export interface ReportPlayerAnalysisRowRaw {
  readonly CustomerID?: string | null;
  readonly PlayerLogin?: string | null;
  readonly AgentID?: string | null;
  readonly AgentLogin?: string | null;
  readonly BETPOINTS?: string | number | null;
  readonly JUICE?: string | number | null;
  readonly CLOSELINE?: string | null;
  readonly PRICE?: number | string | null;
  readonly POINTS?: number | string | null;
  readonly DESCRIPTION?: string | null;
  readonly DAILYFIGUREDATE?: string | null;
  readonly RISK?: string | number | null;
  readonly TOWIN?: string | number | null;
  readonly WINLOSE?: string | number | null;
  readonly WAGERSTATUS?: string | null;
  readonly SPORTSUBTYPE?: string | null;
  readonly PERIODNUMBER?: string | number | null;
  readonly POSTEDDATETIME?: string | null;
  readonly SuspectedBot?: string | null;
  readonly SuspectedBotType?: string | number | null;
  readonly InetTarget?: string | null;
  readonly TOTALBETS?: number | string | null;
  readonly BETTERPRICELINES?: number | string | null;
  readonly BETTERPOINTSLINES?: number | string | null;
  readonly [key: string]: unknown;
}

export interface ReportPlayerAnalysisEnvelope {
  readonly LIST: readonly ReportPlayerAnalysisRowRaw[];
}

export interface ParsedCloseLine {
  readonly raw: string;
  readonly closePoints: number | null;
  readonly closeJuice: number | null;
  readonly isMoneyline: boolean;
}

export interface BoughtPointsDetail {
  readonly hasBoughtPoints: boolean;
  readonly boughtPoints: number;
  readonly displayedJuice: number | null;
}

export interface NormalizedPlayerAnalysisRow {
  readonly mode: "detail" | "summary";
  readonly customerId: string;
  readonly customerIdRawWidth: number;
  readonly playerLogin: string;
  readonly agentId: string;
  readonly agentIdRawWidth: number;
  readonly agentLogin: string;
  readonly betPoints: number | null;
  readonly juice: number | null;
  readonly closeLineRaw: string;
  readonly closePoints: number | null;
  readonly closeJuice: number | null;
  readonly isMoneyline: boolean;
  readonly priceDelta: number | null;
  readonly expectedPriceDelta: number | null;
  readonly priceFormulaMatchesWire: boolean;
  readonly pointsDelta: number | null;
  readonly expectedPointsDelta: number | null;
  readonly pointsFormulaMatchesWire: boolean;
  readonly beatClosingPrice: boolean;
  readonly worseThanClosingPrice: boolean;
  readonly matchedClosingPrice: boolean;
  readonly beatClosingPoints: boolean;
  readonly worseThanClosingPoints: boolean;
  readonly matchedClosingPoints: boolean;
  readonly description: string;
  readonly boughtPointsDetail: BoughtPointsDetail;
  readonly dailyFigureDate: string;
  readonly postedDateTime: string;
  readonly leadTimeHours: number | null;
  readonly riskCents: number;
  readonly toWinCents: number;
  readonly winLoseMagnitudeCents: number;
  readonly winLoseMatchesOutcome: boolean;
  readonly wagerStatus: string;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  readonly sportSubType: string;
  readonly sportSubTypeRawWidth: number;
  readonly periodNumber: number | null;
  readonly suspectedBot: "Y" | "N" | string;
  readonly suspectedBotType: number;
  readonly botLabel: SuspectedBotLabel;
  readonly inetTarget: string;
  readonly totalBets: number | null;
  readonly betterPriceLines: number | null;
  readonly betterPointsLines: number | null;
}

export type NormalizedReportPlayerAnalysisRow = NormalizedPlayerAnalysisRow;

export interface CustomerAnalysisRollup {
  readonly customerId: string;
  readonly playerLogin: string;
  readonly agentId: string;
  readonly agentLogin: string;
  readonly suspectedBot: string;
  readonly suspectedBotType: number;
  readonly botLabel: SuspectedBotLabel;
  readonly inetTargets: readonly string[];
  readonly subSports: Readonly<Record<string, number>>;
  readonly wagerCount: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly pushOrOtherCount: number;
  readonly winRate: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  readonly roiPct: number;
  readonly beatClosingPriceCount: number;
  readonly worseClosingPriceCount: number;
  readonly matchedClosingPriceCount: number;
  readonly beatClosingPriceRate: number;
  readonly beatClosingPointsCount: number;
  readonly beatClosingPointsRate: number;
  readonly meanPriceDelta: number | null;
  readonly meanPointsDelta: number | null;
  readonly riskWeightedPriceDelta: number | null;
  readonly minPriceDelta: number | null;
  readonly maxPriceDelta: number | null;
  readonly boughtPointsWagerCount: number;
  readonly maxLeadTimeHours: number | null;
  readonly summaryTotalBets: number | null;
  readonly summaryBetterPriceLines: number | null;
  readonly summaryBetterPointsLines: number | null;
  /** `BETTERPOINTSLINES + BETTERPRICELINES` (matching `app/manager/module/analysis.js` `Beat Line` column). */
  readonly combinedBeatCount: number;
  /** `(BETTERPOINTSLINES + BETTERPRICELINES) / TOTALBETS` in `[0, 1]` (matching `analysis.js` `Percentage` column). */
  readonly combinedBeatRate: number;
  /**
   * True when an account shows high `BETTERPRICELINES` with mild negative `PRICE` (`[-10, -1]`)
   * while `POINTS > 0` (losing to closing spreads) and `beatClosingPriceCount > beatClosingPointsCount * 2` —
   * the signature of a reduced-juice VIP (`-105` / `-107` / `-108` vs standard `-110` closing line, e.g. `CUST002`, `GX195`),
   * warned about in `app/ui/component/manager/module/analysis/modal-info.html`.
   */
  readonly likelyReducedJuiceArtifact: boolean;
  /** True when `SuspectedBot !== "Y"`, `wagerCount >= minSample`, `beatClosingPointsCount >= 5`, and `meanPointsDelta <= -0.25` (true spread/total line mover, immune to reduced-juice `PRICE` inflation). */
  readonly trueSpreadSharpSignal: boolean;
  /** True when F402 has not flagged the account (`SuspectedBot === "N"`) but CLV price/points beat rate or mean PRICE/POINTS exceeds sharp thresholds (excluding reduced-juice artifacts that lose to closing spreads). */
  readonly unflaggedSharpSignal: boolean;
}

export interface OfficeAnalysisRollup {
  readonly agentId: string;
  readonly customerCount: number;
  readonly wagerCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  readonly beatClosingPriceCount: number;
  readonly worseClosingPriceCount: number;
  readonly matchedClosingPriceCount: number;
  readonly beatClosingPriceRate: number;
  readonly beatClosingPointsCount: number;
  readonly beatClosingPointsRate: number;
  readonly meanPriceDelta: number | null;
  readonly meanPointsDelta: number | null;
  readonly unflaggedSharpCustomerCount: number;
}

export interface SubSportAnalysisRollup {
  readonly sportSubType: string;
  readonly wagerCount: number;
  readonly totalRiskCents: number;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  readonly beatClosingPriceCount: number;
  readonly beatClosingPriceRate: number;
  readonly meanPriceDelta: number | null;
}

export interface InetTargetAnalysisRollup {
  readonly inetTarget: string;
  readonly customerCount: number;
  readonly wagerCount: number;
  readonly totalRiskCents: number;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  readonly beatClosingPriceCount: number;
  readonly beatClosingPriceRate: number;
  readonly beatClosingPointsCount: number;
  readonly beatClosingPointsRate: number;
}

export interface PortfolioAnalysisSummary {
  readonly rowCount: number;
  readonly detailRowCount: number;
  readonly summaryRowCount: number;
  readonly customerCount: number;
  readonly officeCount: number;
  readonly totalWagerCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly totalPlayerNetCents: number;
  readonly totalHouseNetCents: number;
  readonly beatClosingPriceCount: number;
  readonly worseClosingPriceCount: number;
  readonly matchedClosingPriceCount: number;
  readonly beatClosingPriceRate: number;
  readonly beatClosingPointsCount: number;
  readonly beatClosingPointsRate: number;
  readonly meanPriceDelta: number | null;
  readonly meanPointsDelta: number | null;
  readonly riskWeightedPriceDelta: number | null;
  readonly priceFormulaMatchCount: number;
  readonly pointsFormulaMatchCount: number;
  readonly winLoseInvariantMatchCount: number;
  readonly customers: readonly CustomerAnalysisRollup[];
  readonly byOffice: readonly OfficeAnalysisRollup[];
  readonly bySubSport: readonly SubSportAnalysisRollup[];
  readonly byInetTarget: readonly InetTargetAnalysisRollup[];
  readonly unflaggedSharpCustomers: readonly CustomerAnalysisRollup[];
}

function formatChicagoYmd(date: Date): string {
  const parts = CHICAGO_YMD_FORMAT.formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Default 14-day `[startDate, endDate]` window matching `manager.js:93668`:
 * `start: moment(new Date).subtract(14, "day").format("YYYY-MM-DD")`,
 * `end: moment(new Date).format("YYYY-MM-DD")`.
 */
export function defaultAnalysisDateWindow(
  now: Date = new Date(),
  daysBack = 14,
): { readonly startDate: string; readonly endDate: string } {
  const safeDays = Math.max(0, Math.trunc(daysBack));
  const start = new Date(now.getTime() - safeDays * 86_400_000);
  return {
    startDate: formatChicagoYmd(start),
    endDate: formatChicagoYmd(now),
  };
}

/**
 * Build form fields in the exact key order `manager.js:93668` passes to `$.ajax`:
 * `{ agentID, agentOwner, customerID, reportType, startDate, endDate, lineType, operation: "getReportPlayerAnalysis", RRO }`.
 */
export function buildReportPlayerAnalysisFormFields(
  request: ReportPlayerAnalysisRequest,
): Record<string, string> {
  const agentID = request.agentID.trim();
  if (agentID === "") {
    throw new ReportPlayerAnalysisError("agentID must not be empty");
  }
  const startDate = request.startDate.trim();
  const endDate = request.endDate.trim();
  if (!YMD_PATTERN.test(startDate)) {
    throw new ReportPlayerAnalysisError(
      `startDate must be YYYY-MM-DD, got "${request.startDate}"`,
    );
  }
  if (!YMD_PATTERN.test(endDate)) {
    throw new ReportPlayerAnalysisError(
      `endDate must be YYYY-MM-DD, got "${request.endDate}"`,
    );
  }
  if (endDate < startDate) {
    throw new ReportPlayerAnalysisError(
      `endDate (${endDate}) must not precede startDate (${startDate})`,
    );
  }
  const agentOwner = (request.agentOwner ?? agentID).trim() || agentID;
  const customerID = (request.customerID ?? "").trim();
  const reportType = String(request.reportType ?? 1).trim();
  const lineType = String(request.lineType ?? 1).trim();
  const rro = String(request.rro ?? MANAGER_RRO);

  return {
    agentID,
    agentOwner,
    customerID,
    reportType,
    startDate,
    endDate,
    lineType,
    operation: "getReportPlayerAnalysis",
    RRO: rro,
  };
}

export function buildReportPlayerAnalysisFormBody(
  request: ReportPlayerAnalysisRequest,
): string {
  const fields = buildReportPlayerAnalysisFormFields(request);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, v);
  }
  return params.toString();
}

export function buildLineTypesFormFields(
  request: LineTypesRequest,
): Record<string, string> {
  const agentID = request.agentID.trim();
  if (agentID === "") {
    throw new ReportPlayerAnalysisError("agentID must not be empty");
  }
  const agentOwner = (request.agentOwner ?? agentID).trim() || agentID;
  return {
    agentID,
    agentOwner,
    sportType: (request.sportType ?? "").trim(),
    operation: "getLineTypes",
    RRO: String(request.rro ?? MANAGER_RRO),
  };
}

export function buildLineTypesFormBody(request: LineTypesRequest): string {
  const fields = buildLineTypesFormFields(request);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, v);
  }
  return params.toString();
}

export function parseLineTypesEnvelope(
  raw: unknown,
): readonly LineTypeOption[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReportPlayerAnalysisError(
      "getLineTypes envelope must be an object",
    );
  }
  const list = (raw as { LIST?: unknown }).LIST;
  if (!Array.isArray(list)) {
    throw new ReportPlayerAnalysisError("getLineTypes LIST must be an array");
  }
  const out: LineTypeOption[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const lineType = String(rec.lineType ?? "").trim();
    const displayLineType = String(rec.DisplayLineType ?? "").trim();
    if (lineType !== "") {
      out.push({ lineType, displayLineType });
    }
  }
  return out;
}

/**
 * Convert American odds to a continuous cent index centered at pick'em (`±100 -> 0`):
 * - `j < 0`: `j + 100` (e.g. `-110 -> -10`, `-125 -> -25`, `-103 -> -3`)
 * - `j >= 0`: `j - 100` (e.g. `+100 -> 0`, `+102 -> +2`, `+140 -> +40`)
 */
export function americanOddsToCentIndex(juice: number): number {
  if (!Number.isFinite(juice)) return 0;
  return juice < 0 ? juice + 100 : juice - 100;
}

/**
 * Compute Fantasy402's `PRICE` CLV cent delta:
 * `PRICE = americanOddsToCentIndex(closeJuice) - americanOddsToCentIndex(betJuice)`.
 * Negative means the bettor got better odds than the closing line.
 */
export function computeExpectedPriceDelta(
  betJuice: number | null,
  closeJuice: number | null,
): number | null {
  if (betJuice === null || closeJuice === null) return null;
  if (!Number.isFinite(betJuice) || !Number.isFinite(closeJuice)) return null;
  const delta =
    americanOddsToCentIndex(closeJuice) - americanOddsToCentIndex(betJuice);
  return Object.is(delta, -0) ? 0 : Math.round(delta * 1000) / 1000;
}

/**
 * Compute Fantasy402's `POINTS` CLV delta across Spreads, Unders, and Overs:
 * - For Overs (`/\sO\s+\d/.test(description)`): `POINTS = betPoints - closePoints`
 * - For Spreads (favorites & underdogs) and Unders (`/\sU\s+\d/.test(description)`): `POINTS = closePoints - betPoints`
 * Negative values (`POINTS < 0`) always mean the bettor beat the closing line.
 */
export function computeExpectedPointsDelta(
  betPoints: number | null,
  closePoints: number | null,
  description: string | null | undefined,
): number | null {
  if (betPoints === null || closePoints === null) return null;
  if (!Number.isFinite(betPoints) || !Number.isFinite(closePoints)) return null;
  const desc = typeof description === "string" ? description : "";
  const isOver = /\sO\s+\d/.test(desc);
  const delta = isOver ? betPoints - closePoints : closePoints - betPoints;
  return Object.is(delta, -0) ? 0 : Math.round(delta * 1000) / 1000;
}

/**
 * Parse `CLOSELINE`:
 * - Spread / Total (`"<points> <juice>"`, e.g. `"-6 -110"`, `"57.5 -110"`): `{ closePoints: -6, closeJuice: -110, isMoneyline: false }`
 * - Moneyline (`"<juice>"`, e.g. `"135"`, `"-145"`): `{ closePoints: null, closeJuice: 135, isMoneyline: true }`
 */
export function parseCloseLine(
  raw: string | null | undefined,
): ParsedCloseLine {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    return {
      raw: "",
      closePoints: null,
      closeJuice: null,
      isMoneyline: false,
    };
  }
  const tokens = text.split(/\s+/);
  if (tokens.length === 1) {
    const ml = Number(tokens[0]);
    return {
      raw: text,
      closePoints: null,
      closeJuice: Number.isFinite(ml) ? ml : null,
      isMoneyline: Number.isFinite(ml),
    };
  }
  const pts = Number(tokens[0]);
  const juice = Number(tokens[tokens.length - 1]);
  return {
    raw: text,
    closePoints: Number.isFinite(pts) ? pts : null,
    closeJuice: Number.isFinite(juice) ? juice : null,
    isMoneyline: false,
  };
}

const BUYING_POINTS_RE =
  /([+-]?\d+)\s*-\s*buying\s+(?:(\d+)?(½|¼|¾|\.5|\.25|\.75)|(\d+(?:\.\d+)?))/i;

function fractionTokenToNumber(
  whole: string | undefined,
  frac: string | undefined,
  plain: string | undefined,
): number {
  if (plain !== undefined && plain !== "") {
    const n = Number(plain);
    return Number.isFinite(n) ? n : 0;
  }
  const w = whole !== undefined && whole !== "" ? Number(whole) : 0;
  let f = 0;
  if (frac === "½" || frac === ".5") f = 0.5;
  else if (frac === "¼" || frac === ".25") f = 0.25;
  else if (frac === "¾" || frac === ".75") f = 0.75;
  return w + f;
}

/**
 * Detect bought points in `DESCRIPTION` (e.g. `"Football #475 Buccaneers  6½ -108 - buying ½ For Game"`).
 * When points are bought, `BETPOINTS` and `JUICE` on the wire hold the pre-buy market line (`6.0`, `+102.0`),
 * while `DESCRIPTION`, `RISK`, and `TOWIN` reflect the post-buy ticket (`6½ -108`, risk `5400` to win `5000`).
 */
export function detectBoughtPointsInDescription(
  description: string | null | undefined,
): BoughtPointsDetail {
  const desc = typeof description === "string" ? description : "";
  const match = BUYING_POINTS_RE.exec(desc);
  if (match === null) {
    return {
      hasBoughtPoints: false,
      boughtPoints: 0,
      displayedJuice: null,
    };
  }
  const displayedJuice = Number(match[1]);
  const boughtPoints = fractionTokenToNumber(match[2], match[3], match[4]);
  return {
    hasBoughtPoints: boughtPoints > 0,
    boughtPoints,
    displayedJuice: Number.isFinite(displayedJuice) ? displayedJuice : null,
  };
}

function parseOptionalFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseCentsInt(value: unknown): number {
  const n = parseOptionalFiniteNumber(value);
  return n === null ? 0 : Math.round(n);
}

function computeLeadTimeHours(
  postedDateTime: string,
  dailyFigureDate: string,
): number | null {
  if (postedDateTime === "" || dailyFigureDate === "") return null;
  const postedMs = Date.parse(postedDateTime.replace(" ", "T") + "Z");
  const figureDateYmd = dailyFigureDate.slice(0, 10);
  if (!YMD_PATTERN.test(figureDateYmd) || !Number.isFinite(postedMs)) {
    return null;
  }
  // Compare against the end of the figure date (23:59:59Z) or figure date midnight;
  // using figureDate 23:59:59Z avoids negative lead times for same-day afternoon games.
  const figureDayStartMs = Date.parse(`${figureDateYmd}T00:00:00Z`);
  if (!Number.isFinite(figureDayStartMs)) return null;
  const postedDayStartMs = Date.parse(
    `${postedDateTime.slice(0, 10)}T00:00:00Z`,
  );
  if (!Number.isFinite(postedDayStartMs)) return null;
  const diffHours = (figureDayStartMs - postedDayStartMs) / 3_600_000;
  return Math.max(0, Math.round(diffHours * 100) / 100);
}

/** Validate and return the raw `getReportPlayerAnalysis` response envelope (`{ LIST: [...] }` or top-level array). */
export function parseReportPlayerAnalysisEnvelope(
  raw: unknown,
): ReportPlayerAnalysisEnvelope {
  if (Array.isArray(raw)) {
    return { LIST: raw as ReportPlayerAnalysisRowRaw[] };
  }
  if (typeof raw !== "object" || raw === null) {
    throw new ReportPlayerAnalysisError(
      "getReportPlayerAnalysis response must be an object or array",
    );
  }
  const obj = raw as { LIST?: unknown };
  if (Array.isArray(obj.LIST)) {
    return { LIST: obj.LIST as ReportPlayerAnalysisRowRaw[] };
  }
  if (typeof obj.LIST === "string") {
    const trimmed = obj.LIST.trim();
    if (trimmed === "") return { LIST: [] };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { LIST: parsed as ReportPlayerAnalysisRowRaw[] };
      }
    } catch {
      // fall through
    }
  }
  throw new ReportPlayerAnalysisError(
    "getReportPlayerAnalysis response missing LIST array",
  );
}

/** Normalize one `getReportPlayerAnalysis` wire row and verify its CLV & settlement invariants. */
export function normalizeReportPlayerAnalysisRow(
  raw: ReportPlayerAnalysisRowRaw,
): NormalizedPlayerAnalysisRow {
  const customerIdRaw =
    typeof raw.CustomerID === "string" ? raw.CustomerID : "";
  const agentIdRaw = typeof raw.AgentID === "string" ? raw.AgentID : "";
  const sportSubTypeRaw =
    typeof raw.SPORTSUBTYPE === "string" ? raw.SPORTSUBTYPE : "";

  const customerId = customerIdRaw.trim();
  const playerLogin =
    typeof raw.PlayerLogin === "string" ? raw.PlayerLogin.trim() : customerId;
  const agentId = agentIdRaw.trim();
  const agentLogin =
    typeof raw.AgentLogin === "string" ? raw.AgentLogin.trim() : "";

  const betPoints = parseOptionalFiniteNumber(raw.BETPOINTS);
  const juice = parseOptionalFiniteNumber(raw.JUICE);
  const parsedClose = parseCloseLine(raw.CLOSELINE);
  const priceDelta = parseOptionalFiniteNumber(raw.PRICE);
  const expectedPriceDelta = computeExpectedPriceDelta(
    juice,
    parsedClose.closeJuice,
  );
  const priceFormulaMatchesWire =
    priceDelta === null ||
    expectedPriceDelta === null ||
    Math.abs(priceDelta - expectedPriceDelta) < 1e-6;

  const description =
    typeof raw.DESCRIPTION === "string" ? raw.DESCRIPTION.trim() : "";
  const boughtPointsDetail = detectBoughtPointsInDescription(description);

  const pointsDelta = parseOptionalFiniteNumber(raw.POINTS);
  const expectedPointsDelta = computeExpectedPointsDelta(
    betPoints,
    parsedClose.closePoints,
    description,
  );
  const pointsFormulaMatchesWire =
    pointsDelta === null ||
    expectedPointsDelta === null ||
    Math.abs(pointsDelta - expectedPointsDelta) < 1e-6;

  const dailyFigureDate =
    typeof raw.DAILYFIGUREDATE === "string" ? raw.DAILYFIGUREDATE.trim() : "";
  const postedDateTime =
    typeof raw.POSTEDDATETIME === "string" ? raw.POSTEDDATETIME.trim() : "";
  const leadTimeHours = computeLeadTimeHours(postedDateTime, dailyFigureDate);

  const riskCents = parseCentsInt(raw.RISK);
  const toWinCents = parseCentsInt(raw.TOWIN);
  const rawWinLoseCents = parseCentsInt(raw.WINLOSE);
  const wagerStatus =
    typeof raw.WAGERSTATUS === "string"
      ? raw.WAGERSTATUS.trim().toUpperCase()
      : "";

  const totalBets = parseOptionalFiniteNumber(raw.TOTALBETS);
  const betterPriceLines = parseOptionalFiniteNumber(raw.BETTERPRICELINES);
  const betterPointsLines = parseOptionalFiniteNumber(raw.BETTERPOINTSLINES);
  const isSummaryRow =
    (totalBets !== null ||
      betterPriceLines !== null ||
      betterPointsLines !== null) &&
    description === "";
  const mode: "detail" | "summary" = isSummaryRow ? "summary" : "detail";

  let winLoseMagnitudeCents = Math.abs(rawWinLoseCents);
  let playerNetCents = 0;
  let winLoseMatchesOutcome = true;
  if (mode === "summary") {
    playerNetCents = rawWinLoseCents;
  } else if (wagerStatus === "W") {
    winLoseMagnitudeCents = rawWinLoseCents;
    playerNetCents = winLoseMagnitudeCents;
    winLoseMatchesOutcome = winLoseMagnitudeCents === toWinCents;
  } else if (wagerStatus === "L") {
    winLoseMagnitudeCents = rawWinLoseCents;
    playerNetCents = -winLoseMagnitudeCents;
    winLoseMatchesOutcome = winLoseMagnitudeCents === riskCents;
  }

  const sportSubType = sportSubTypeRaw.trim();
  const periodNumber = parseOptionalFiniteNumber(raw.PERIODNUMBER);

  const suspectedBot =
    typeof raw.SuspectedBot === "string" && raw.SuspectedBot.trim() !== ""
      ? raw.SuspectedBot.trim().toUpperCase()
      : "N";
  const suspectedBotType = parseOptionalFiniteNumber(raw.SuspectedBotType) ?? 0;
  const botClassification = classifySuspectedBot({
    suspectedBot,
    suspectedBotType,
  });

  const inetTarget =
    typeof raw.InetTarget === "string" ? raw.InetTarget.trim() : "";

  return {
    mode,
    customerId,
    customerIdRawWidth: customerIdRaw.length,
    playerLogin,
    agentId,
    agentIdRawWidth: agentIdRaw.length,
    agentLogin,
    betPoints,
    juice,
    closeLineRaw: parsedClose.raw,
    closePoints: parsedClose.closePoints,
    closeJuice: parsedClose.closeJuice,
    isMoneyline: parsedClose.isMoneyline,
    priceDelta,
    expectedPriceDelta,
    priceFormulaMatchesWire,
    pointsDelta,
    expectedPointsDelta,
    pointsFormulaMatchesWire,
    beatClosingPrice: priceDelta !== null && priceDelta < 0,
    worseThanClosingPrice: priceDelta !== null && priceDelta > 0,
    matchedClosingPrice: priceDelta !== null && priceDelta === 0,
    beatClosingPoints: pointsDelta !== null && pointsDelta < 0,
    worseThanClosingPoints: pointsDelta !== null && pointsDelta > 0,
    matchedClosingPoints: pointsDelta !== null && pointsDelta === 0,
    description,
    boughtPointsDetail,
    dailyFigureDate,
    postedDateTime,
    leadTimeHours,
    riskCents,
    toWinCents,
    winLoseMagnitudeCents,
    winLoseMatchesOutcome,
    wagerStatus,
    playerNetCents,
    houseNetCents: -playerNetCents,
    sportSubType,
    sportSubTypeRawWidth: sportSubTypeRaw.length,
    periodNumber,
    suspectedBot,
    suspectedBotType,
    botLabel: botClassification.label,
    inetTarget,
    totalBets,
    betterPriceLines,
    betterPointsLines,
  };
}

interface MutableCustomerAccum {
  customerId: string;
  playerLogin: string;
  agentId: string;
  agentLogin: string;
  suspectedBot: string;
  suspectedBotType: number;
  botLabel: SuspectedBotLabel;
  inetTargets: Set<string>;
  subSports: Record<string, number>;
  wagerCount: number;
  winCount: number;
  lossCount: number;
  pushOrOtherCount: number;
  totalRiskCents: number;
  totalToWinCents: number;
  playerNetCents: number;
  beatClosingPriceCount: number;
  worseClosingPriceCount: number;
  matchedClosingPriceCount: number;
  beatClosingPointsCount: number;
  priceDeltaSum: number;
  priceDeltaCount: number;
  pointsDeltaSum: number;
  pointsDeltaCount: number;
  riskWeightedPriceNumer: number;
  riskWeightedPriceDenom: number;
  minPriceDelta: number | null;
  maxPriceDelta: number | null;
  boughtPointsWagerCount: number;
  maxLeadTimeHours: number | null;
  summaryTotalBets: number | null;
  summaryBetterPriceLines: number | null;
  summaryBetterPointsLines: number | null;
}

/**
 * Summarize normalized or raw `getReportPlayerAnalysis` rows across all customers, offices,
 * sub-sports, and `InetTarget` skins.
 */
export function summarizeReportPlayerAnalysis(
  rawOrEnvelope:
    | ReportPlayerAnalysisEnvelope
    | readonly ReportPlayerAnalysisRowRaw[]
    | unknown,
): PortfolioAnalysisSummary {
  const envelope =
    typeof rawOrEnvelope === "object" &&
    rawOrEnvelope !== null &&
    !Array.isArray(rawOrEnvelope) &&
    "LIST" in rawOrEnvelope
      ? (rawOrEnvelope as ReportPlayerAnalysisEnvelope)
      : parseReportPlayerAnalysisEnvelope(rawOrEnvelope);

  const normalizedRows = envelope.LIST.map(normalizeReportPlayerAnalysisRow);
  const byCustomer = new Map<string, MutableCustomerAccum>();
  const byOffice = new Map<
    string,
    {
      agentId: string;
      customers: Set<string>;
      wagerCount: number;
      totalRiskCents: number;
      totalToWinCents: number;
      playerNetCents: number;
      beatClosingPriceCount: number;
      worseClosingPriceCount: number;
      matchedClosingPriceCount: number;
      beatClosingPointsCount: number;
      priceDeltaSum: number;
      priceDeltaWeight: number;
      pointsDeltaSum: number;
      pointsDeltaWeight: number;
    }
  >();
  const bySubSport = new Map<
    string,
    {
      sportSubType: string;
      wagerCount: number;
      totalRiskCents: number;
      playerNetCents: number;
      beatClosingPriceCount: number;
      priceDeltaSum: number;
      priceDeltaCount: number;
    }
  >();
  const byInet = new Map<
    string,
    {
      inetTarget: string;
      customers: Set<string>;
      wagerCount: number;
      totalRiskCents: number;
      playerNetCents: number;
      beatClosingPriceCount: number;
      beatClosingPointsCount: number;
    }
  >();

  let detailRowCount = 0;
  let summaryRowCount = 0;
  let totalWagerCount = 0;
  let totalRiskCents = 0;
  let totalToWinCents = 0;
  let totalPlayerNetCents = 0;
  let beatClosingPriceCount = 0;
  let worseClosingPriceCount = 0;
  let matchedClosingPriceCount = 0;
  let beatClosingPointsCount = 0;
  let priceDeltaSum = 0;
  let priceDeltaWeight = 0;
  let pointsDeltaSum = 0;
  let pointsDeltaWeight = 0;
  let riskWeightedPriceNumer = 0;
  let riskWeightedPriceDenom = 0;
  let priceFormulaMatchCount = 0;
  let pointsFormulaMatchCount = 0;
  let winLoseInvariantMatchCount = 0;

  for (const row of normalizedRows) {
    if (row.priceFormulaMatchesWire) priceFormulaMatchCount++;
    if (row.pointsFormulaMatchesWire) pointsFormulaMatchCount++;
    if (row.winLoseMatchesOutcome) winLoseInvariantMatchCount++;

    const custKey = row.customerId || row.playerLogin || "UNKNOWN";
    let cust = byCustomer.get(custKey);
    if (cust === undefined) {
      cust = {
        customerId: custKey,
        playerLogin: row.playerLogin || custKey,
        agentId: row.agentId,
        agentLogin: row.agentLogin,
        suspectedBot: row.suspectedBot,
        suspectedBotType: row.suspectedBotType,
        botLabel: row.botLabel,
        inetTargets: new Set<string>(),
        subSports: {},
        wagerCount: 0,
        winCount: 0,
        lossCount: 0,
        pushOrOtherCount: 0,
        totalRiskCents: 0,
        totalToWinCents: 0,
        playerNetCents: 0,
        beatClosingPriceCount: 0,
        worseClosingPriceCount: 0,
        matchedClosingPriceCount: 0,
        beatClosingPointsCount: 0,
        priceDeltaSum: 0,
        priceDeltaCount: 0,
        pointsDeltaSum: 0,
        pointsDeltaCount: 0,
        riskWeightedPriceNumer: 0,
        riskWeightedPriceDenom: 0,
        minPriceDelta: null,
        maxPriceDelta: null,
        boughtPointsWagerCount: 0,
        maxLeadTimeHours: null,
        summaryTotalBets: null,
        summaryBetterPriceLines: null,
        summaryBetterPointsLines: null,
      };
      byCustomer.set(custKey, cust);
    }

    if (row.suspectedBot === "Y" && cust.suspectedBot !== "Y") {
      cust.suspectedBot = "Y";
      cust.suspectedBotType = row.suspectedBotType;
      cust.botLabel = row.botLabel;
    }
    if (row.inetTarget !== "") {
      cust.inetTargets.add(row.inetTarget);
    }

    const officeKey = row.agentId || "UNKNOWN";
    let office = byOffice.get(officeKey);
    if (office === undefined) {
      office = {
        agentId: officeKey,
        customers: new Set<string>(),
        wagerCount: 0,
        totalRiskCents: 0,
        totalToWinCents: 0,
        playerNetCents: 0,
        beatClosingPriceCount: 0,
        worseClosingPriceCount: 0,
        matchedClosingPriceCount: 0,
        beatClosingPointsCount: 0,
        priceDeltaSum: 0,
        priceDeltaWeight: 0,
        pointsDeltaSum: 0,
        pointsDeltaWeight: 0,
      };
      byOffice.set(officeKey, office);
    }
    office.customers.add(custKey);

    const inetKey = row.inetTarget || "UNKNOWN";
    let inet = byInet.get(inetKey);
    if (inet === undefined) {
      inet = {
        inetTarget: inetKey,
        customers: new Set<string>(),
        wagerCount: 0,
        totalRiskCents: 0,
        playerNetCents: 0,
        beatClosingPriceCount: 0,
        beatClosingPointsCount: 0,
      };
      byInet.set(inetKey, inet);
    }
    inet.customers.add(custKey);

    if (row.mode === "summary") {
      summaryRowCount++;
      const rowBets = row.totalBets ?? 0;
      const rowBetterPrice = row.betterPriceLines ?? 0;
      const rowBetterPoints = row.betterPointsLines ?? 0;
      const weight = Math.max(1, rowBets);

      cust.summaryTotalBets = (cust.summaryTotalBets ?? 0) + rowBets;
      cust.summaryBetterPriceLines =
        (cust.summaryBetterPriceLines ?? 0) + rowBetterPrice;
      cust.summaryBetterPointsLines =
        (cust.summaryBetterPointsLines ?? 0) + rowBetterPoints;
      cust.playerNetCents += row.playerNetCents;

      totalWagerCount += rowBets;
      totalPlayerNetCents += row.playerNetCents;
      beatClosingPriceCount += rowBetterPrice;
      beatClosingPointsCount += rowBetterPoints;

      office.wagerCount += rowBets;
      office.playerNetCents += row.playerNetCents;
      office.beatClosingPriceCount += rowBetterPrice;
      office.beatClosingPointsCount += rowBetterPoints;

      inet.wagerCount += rowBets;
      inet.playerNetCents += row.playerNetCents;
      inet.beatClosingPriceCount += rowBetterPrice;
      inet.beatClosingPointsCount += rowBetterPoints;

      if (row.priceDelta !== null) {
        cust.priceDeltaSum += row.priceDelta;
        cust.priceDeltaCount++;
        if (
          cust.minPriceDelta === null ||
          row.priceDelta < cust.minPriceDelta
        ) {
          cust.minPriceDelta = row.priceDelta;
        }
        if (
          cust.maxPriceDelta === null ||
          row.priceDelta > cust.maxPriceDelta
        ) {
          cust.maxPriceDelta = row.priceDelta;
        }
        priceDeltaSum += row.priceDelta * weight;
        priceDeltaWeight += weight;
        office.priceDeltaSum += row.priceDelta * weight;
        office.priceDeltaWeight += weight;
      }
      if (row.pointsDelta !== null) {
        cust.pointsDeltaSum += row.pointsDelta;
        cust.pointsDeltaCount++;
        pointsDeltaSum += row.pointsDelta * weight;
        pointsDeltaWeight += weight;
        office.pointsDeltaSum += row.pointsDelta * weight;
        office.pointsDeltaWeight += weight;
      }
      continue;
    }

    detailRowCount++;
    totalWagerCount++;
    cust.wagerCount++;
    if (row.wagerStatus === "W") cust.winCount++;
    else if (row.wagerStatus === "L") cust.lossCount++;
    else cust.pushOrOtherCount++;

    cust.totalRiskCents += row.riskCents;
    cust.totalToWinCents += row.toWinCents;
    cust.playerNetCents += row.playerNetCents;

    totalRiskCents += row.riskCents;
    totalToWinCents += row.toWinCents;
    totalPlayerNetCents += row.playerNetCents;

    if (row.beatClosingPrice) {
      cust.beatClosingPriceCount++;
      beatClosingPriceCount++;
    } else if (row.worseThanClosingPrice) {
      cust.worseClosingPriceCount++;
      worseClosingPriceCount++;
    } else if (row.matchedClosingPrice) {
      cust.matchedClosingPriceCount++;
      matchedClosingPriceCount++;
    }

    if (row.beatClosingPoints) {
      cust.beatClosingPointsCount++;
      beatClosingPointsCount++;
    }

    if (row.priceDelta !== null) {
      cust.priceDeltaSum += row.priceDelta;
      cust.priceDeltaCount++;
      priceDeltaSum += row.priceDelta;
      priceDeltaWeight++;
      if (row.riskCents > 0) {
        cust.riskWeightedPriceNumer += row.priceDelta * row.riskCents;
        cust.riskWeightedPriceDenom += row.riskCents;
        riskWeightedPriceNumer += row.priceDelta * row.riskCents;
        riskWeightedPriceDenom += row.riskCents;
      }
      if (cust.minPriceDelta === null || row.priceDelta < cust.minPriceDelta) {
        cust.minPriceDelta = row.priceDelta;
      }
      if (cust.maxPriceDelta === null || row.priceDelta > cust.maxPriceDelta) {
        cust.maxPriceDelta = row.priceDelta;
      }
    }

    if (row.pointsDelta !== null) {
      cust.pointsDeltaSum += row.pointsDelta;
      cust.pointsDeltaCount++;
      pointsDeltaSum += row.pointsDelta;
      pointsDeltaWeight++;
    }

    if (row.boughtPointsDetail.hasBoughtPoints) {
      cust.boughtPointsWagerCount++;
    }
    if (
      row.leadTimeHours !== null &&
      (cust.maxLeadTimeHours === null ||
        row.leadTimeHours > cust.maxLeadTimeHours)
    ) {
      cust.maxLeadTimeHours = row.leadTimeHours;
    }

    const subKey = row.sportSubType || "UNKNOWN";
    cust.subSports[subKey] = (cust.subSports[subKey] ?? 0) + 1;

    office.wagerCount++;
    office.totalRiskCents += row.riskCents;
    office.totalToWinCents += row.toWinCents;
    office.playerNetCents += row.playerNetCents;
    if (row.beatClosingPrice) office.beatClosingPriceCount++;
    else if (row.worseThanClosingPrice) office.worseClosingPriceCount++;
    else if (row.matchedClosingPrice) office.matchedClosingPriceCount++;
    if (row.beatClosingPoints) office.beatClosingPointsCount++;
    if (row.priceDelta !== null) {
      office.priceDeltaSum += row.priceDelta;
      office.priceDeltaWeight++;
    }
    if (row.pointsDelta !== null) {
      office.pointsDeltaSum += row.pointsDelta;
      office.pointsDeltaWeight++;
    }

    let sub = bySubSport.get(subKey);
    if (sub === undefined) {
      sub = {
        sportSubType: subKey,
        wagerCount: 0,
        totalRiskCents: 0,
        playerNetCents: 0,
        beatClosingPriceCount: 0,
        priceDeltaSum: 0,
        priceDeltaCount: 0,
      };
      bySubSport.set(subKey, sub);
    }
    sub.wagerCount++;
    sub.totalRiskCents += row.riskCents;
    sub.playerNetCents += row.playerNetCents;
    if (row.beatClosingPrice) sub.beatClosingPriceCount++;
    if (row.priceDelta !== null) {
      sub.priceDeltaSum += row.priceDelta;
      sub.priceDeltaCount++;
    }

    inet.wagerCount++;
    inet.totalRiskCents += row.riskCents;
    inet.playerNetCents += row.playerNetCents;
    if (row.beatClosingPrice) inet.beatClosingPriceCount++;
    if (row.beatClosingPoints) inet.beatClosingPointsCount++;
  }

  const customers: CustomerAnalysisRollup[] = [];
  for (const c of byCustomer.values()) {
    const effectiveWagerCount =
      c.wagerCount > 0 ? c.wagerCount : (c.summaryTotalBets ?? 0);
    const effectiveBeatPriceCount =
      c.wagerCount > 0
        ? c.beatClosingPriceCount
        : (c.summaryBetterPriceLines ?? 0);
    const effectiveBeatPointsCount =
      c.wagerCount > 0
        ? c.beatClosingPointsCount
        : (c.summaryBetterPointsLines ?? 0);
    const beatClosingPriceRate =
      effectiveWagerCount > 0
        ? Math.round((effectiveBeatPriceCount / effectiveWagerCount) * 10000) /
          10000
        : 0;
    const beatClosingPointsRate =
      effectiveWagerCount > 0
        ? Math.round((effectiveBeatPointsCount / effectiveWagerCount) * 10000) /
          10000
        : 0;
    const meanPriceDelta =
      c.priceDeltaCount > 0
        ? Math.round((c.priceDeltaSum / c.priceDeltaCount) * 100) / 100
        : null;
    const meanPointsDelta =
      c.pointsDeltaCount > 0
        ? Math.round((c.pointsDeltaSum / c.pointsDeltaCount) * 100) / 100
        : null;
    const riskWeightedPriceDelta =
      c.riskWeightedPriceDenom > 0
        ? Math.round(
            (c.riskWeightedPriceNumer / c.riskWeightedPriceDenom) * 100,
          ) / 100
        : null;
    const decidedCount = c.winCount + c.lossCount;
    const winRate =
      decidedCount > 0
        ? Math.round((c.winCount / decidedCount) * 10000) / 10000
        : 0;
    const roiPct =
      c.totalRiskCents > 0
        ? Math.round((c.playerNetCents / c.totalRiskCents) * 10000) / 100
        : 0;
    const minSample = c.wagerCount > 0 ? 3 : 10;
    const combinedBeatCount =
      effectiveBeatPriceCount + effectiveBeatPointsCount;
    const combinedBeatRate =
      effectiveWagerCount > 0
        ? Math.round((combinedBeatCount / effectiveWagerCount) * 10000) / 10000
        : 0;
    const likelyReducedJuiceArtifact =
      c.suspectedBot !== "Y" &&
      effectiveWagerCount >= minSample &&
      effectiveBeatPriceCount >= 5 &&
      effectiveBeatPriceCount > effectiveBeatPointsCount * 2 &&
      meanPriceDelta !== null &&
      meanPriceDelta <= -1 &&
      meanPriceDelta >= -10 &&
      meanPointsDelta !== null &&
      meanPointsDelta > 0;
    const trueSpreadSharpSignal =
      c.suspectedBot !== "Y" &&
      effectiveWagerCount >= minSample &&
      effectiveBeatPointsCount >= 5 &&
      meanPointsDelta !== null &&
      meanPointsDelta <= -0.25;
    const unflaggedSharpSignal =
      c.suspectedBot !== "Y" &&
      effectiveWagerCount >= minSample &&
      !likelyReducedJuiceArtifact &&
      (beatClosingPriceRate >= 0.5 ||
        beatClosingPointsRate >= 0.5 ||
        (meanPriceDelta !== null && meanPriceDelta <= -3) ||
        (meanPointsDelta !== null && meanPointsDelta <= -0.5));

    customers.push({
      customerId: c.customerId,
      playerLogin: c.playerLogin,
      agentId: c.agentId,
      agentLogin: c.agentLogin,
      suspectedBot: c.suspectedBot,
      suspectedBotType: c.suspectedBotType,
      botLabel: c.botLabel,
      inetTargets: [...c.inetTargets].sort(),
      subSports: c.subSports,
      wagerCount: effectiveWagerCount,
      winCount: c.winCount,
      lossCount: c.lossCount,
      pushOrOtherCount: c.pushOrOtherCount,
      winRate,
      totalRiskCents: c.totalRiskCents,
      totalToWinCents: c.totalToWinCents,
      playerNetCents: c.playerNetCents,
      houseNetCents: -c.playerNetCents,
      roiPct,
      beatClosingPriceCount: effectiveBeatPriceCount,
      worseClosingPriceCount: c.worseClosingPriceCount,
      matchedClosingPriceCount: c.matchedClosingPriceCount,
      beatClosingPriceRate,
      beatClosingPointsCount: effectiveBeatPointsCount,
      beatClosingPointsRate,
      meanPriceDelta,
      meanPointsDelta,
      riskWeightedPriceDelta,
      minPriceDelta: c.minPriceDelta,
      maxPriceDelta: c.maxPriceDelta,
      boughtPointsWagerCount: c.boughtPointsWagerCount,
      maxLeadTimeHours: c.maxLeadTimeHours,
      summaryTotalBets: c.summaryTotalBets,
      summaryBetterPriceLines: c.summaryBetterPriceLines,
      summaryBetterPointsLines: c.summaryBetterPointsLines,
      combinedBeatCount,
      combinedBeatRate,
      likelyReducedJuiceArtifact,
      trueSpreadSharpSignal,
      unflaggedSharpSignal,
    });
  }

  customers.sort((a, b) => {
    if (b.beatClosingPriceCount !== a.beatClosingPriceCount) {
      return b.beatClosingPriceCount - a.beatClosingPriceCount;
    }
    if (b.beatClosingPointsCount !== a.beatClosingPointsCount) {
      return b.beatClosingPointsCount - a.beatClosingPointsCount;
    }
    if (b.totalRiskCents !== a.totalRiskCents) {
      return b.totalRiskCents - a.totalRiskCents;
    }
    if (Math.abs(b.playerNetCents) !== Math.abs(a.playerNetCents)) {
      return Math.abs(b.playerNetCents) - Math.abs(a.playerNetCents);
    }
    return a.customerId.localeCompare(b.customerId);
  });

  const unflaggedSharpByOffice = new Map<string, number>();
  for (const c of customers) {
    if (c.unflaggedSharpSignal) {
      unflaggedSharpByOffice.set(
        c.agentId,
        (unflaggedSharpByOffice.get(c.agentId) ?? 0) + 1,
      );
    }
  }

  const offices: OfficeAnalysisRollup[] = [...byOffice.values()]
    .map((o) => ({
      agentId: o.agentId,
      customerCount: o.customers.size,
      wagerCount: o.wagerCount,
      totalRiskCents: o.totalRiskCents,
      totalToWinCents: o.totalToWinCents,
      playerNetCents: o.playerNetCents,
      houseNetCents: -o.playerNetCents,
      beatClosingPriceCount: o.beatClosingPriceCount,
      worseClosingPriceCount: o.worseClosingPriceCount,
      matchedClosingPriceCount: o.matchedClosingPriceCount,
      beatClosingPriceRate:
        o.wagerCount > 0
          ? Math.round((o.beatClosingPriceCount / o.wagerCount) * 10000) / 10000
          : 0,
      beatClosingPointsCount: o.beatClosingPointsCount,
      beatClosingPointsRate:
        o.wagerCount > 0
          ? Math.round((o.beatClosingPointsCount / o.wagerCount) * 10000) /
            10000
          : 0,
      meanPriceDelta:
        o.priceDeltaWeight > 0
          ? Math.round((o.priceDeltaSum / o.priceDeltaWeight) * 100) / 100
          : null,
      meanPointsDelta:
        o.pointsDeltaWeight > 0
          ? Math.round((o.pointsDeltaSum / o.pointsDeltaWeight) * 100) / 100
          : null,
      unflaggedSharpCustomerCount: unflaggedSharpByOffice.get(o.agentId) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.totalRiskCents - a.totalRiskCents ||
        b.wagerCount - a.wagerCount ||
        Math.abs(b.playerNetCents) - Math.abs(a.playerNetCents),
    );

  const subSports: SubSportAnalysisRollup[] = [...bySubSport.values()]
    .map((s) => ({
      sportSubType: s.sportSubType,
      wagerCount: s.wagerCount,
      totalRiskCents: s.totalRiskCents,
      playerNetCents: s.playerNetCents,
      houseNetCents: -s.playerNetCents,
      beatClosingPriceCount: s.beatClosingPriceCount,
      beatClosingPriceRate:
        s.wagerCount > 0
          ? Math.round((s.beatClosingPriceCount / s.wagerCount) * 10000) / 10000
          : 0,
      meanPriceDelta:
        s.priceDeltaCount > 0
          ? Math.round((s.priceDeltaSum / s.priceDeltaCount) * 100) / 100
          : null,
    }))
    .sort((a, b) => b.totalRiskCents - a.totalRiskCents);

  const inetTargets: InetTargetAnalysisRollup[] = [...byInet.values()]
    .map((i) => ({
      inetTarget: i.inetTarget,
      customerCount: i.customers.size,
      wagerCount: i.wagerCount,
      totalRiskCents: i.totalRiskCents,
      playerNetCents: i.playerNetCents,
      houseNetCents: -i.playerNetCents,
      beatClosingPriceCount: i.beatClosingPriceCount,
      beatClosingPriceRate:
        i.wagerCount > 0
          ? Math.round((i.beatClosingPriceCount / i.wagerCount) * 10000) / 10000
          : 0,
      beatClosingPointsCount: i.beatClosingPointsCount,
      beatClosingPointsRate:
        i.wagerCount > 0
          ? Math.round((i.beatClosingPointsCount / i.wagerCount) * 10000) /
            10000
          : 0,
    }))
    .sort(
      (a, b) =>
        b.totalRiskCents - a.totalRiskCents ||
        b.wagerCount - a.wagerCount ||
        Math.abs(b.playerNetCents) - Math.abs(a.playerNetCents),
    );

  return {
    rowCount: normalizedRows.length,
    detailRowCount,
    summaryRowCount,
    customerCount: customers.length,
    officeCount: offices.length,
    totalWagerCount,
    totalRiskCents,
    totalToWinCents,
    totalPlayerNetCents,
    totalHouseNetCents: -totalPlayerNetCents,
    beatClosingPriceCount,
    worseClosingPriceCount,
    matchedClosingPriceCount,
    beatClosingPriceRate:
      totalWagerCount > 0
        ? Math.round((beatClosingPriceCount / totalWagerCount) * 10000) / 10000
        : 0,
    beatClosingPointsCount,
    beatClosingPointsRate:
      totalWagerCount > 0
        ? Math.round((beatClosingPointsCount / totalWagerCount) * 10000) / 10000
        : 0,
    meanPriceDelta:
      priceDeltaWeight > 0
        ? Math.round((priceDeltaSum / priceDeltaWeight) * 100) / 100
        : null,
    meanPointsDelta:
      pointsDeltaWeight > 0
        ? Math.round((pointsDeltaSum / pointsDeltaWeight) * 100) / 100
        : null,
    riskWeightedPriceDelta:
      riskWeightedPriceDenom > 0
        ? Math.round((riskWeightedPriceNumer / riskWeightedPriceDenom) * 100) /
          100
        : null,
    priceFormulaMatchCount,
    pointsFormulaMatchCount,
    winLoseInvariantMatchCount,
    customers,
    byOffice: offices,
    bySubSport: subSports,
    byInetTarget: inetTargets,
    unflaggedSharpCustomers: customers.filter((c) => c.unflaggedSharpSignal),
  };
}

export interface SuspectedBotCellProvenance {
  readonly endpoint: string;
  readonly report_type: string;
  readonly as_of: string | null;
  readonly query_sha: string;
  readonly classifier_version: string;
}

export interface SummarizeSuspectedBotCohortOptions {
  readonly endpoint?: string;
  readonly reportType?: string;
  readonly asOf?: string;
  readonly querySha?: string;
  readonly classifierVersion?: string;
}

export interface SuspectedBotSubSportStats {
  readonly sportSubType: string;
  readonly parentSports: readonly string[];
  readonly wagerCount: number;
  readonly wagerSharePct: number;
  readonly botCustomerCount: number;
  readonly botCustomerReachPct: number;
  readonly primaryChoiceCustomerCount: number;
  readonly primaryChoiceSharePct: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly pushOrOtherCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  readonly beatClosingPriceCount: number;
  readonly beatClosingPointsCount: number;
  readonly provenance: SuspectedBotCellProvenance;
}

export interface SuspectedBotCustomerProfile {
  readonly customerId: string;
  readonly playerLogin: string;
  readonly agentId: string;
  readonly suspectedBot: string;
  readonly suspectedBotType: number;
  readonly botLabel: SuspectedBotLabel;
  readonly inetTarget: string;
  readonly totalBets: number;
  readonly primarySubSport: string | null;
  readonly primarySubSportWagers: number;
  readonly primarySubSportSharePct: number;
  readonly subSports: Readonly<Record<string, number>>;
  readonly playerNetCents: number;
  readonly beatClosingPriceCount: number;
  readonly beatClosingPointsCount: number;
  readonly provenance: SuspectedBotCellProvenance;
}

export interface SuspectedBotCohortSummary {
  readonly provenance: SuspectedBotCellProvenance;
  readonly suspectedBotCustomerCount: number;
  readonly byBotType: Readonly<Record<string, number>>;
  readonly totalBotWagerCount: number;
  readonly detailRowCount: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly totalPlayerNetCents: number;
  readonly totalHouseNetCents: number;
  readonly topSubSportByWagers: string | null;
  readonly topSubSportByCustomerReach: string | null;
  readonly topSubSportByPrimaryChoice: string | null;
  readonly topSubSportByRiskCents: string | null;
  readonly periodDistribution: Readonly<Record<string, number>>;
  readonly marketTypeDistribution: {
    readonly spread: number;
    readonly over: number;
    readonly under: number;
    readonly moneyline: number;
  };
  readonly boughtPointsWagerCount: number;
  readonly subSportRankings: readonly SuspectedBotSubSportStats[];
  readonly customers: readonly SuspectedBotCustomerProfile[];
}

/**
 * Summarize the `SuspectedBot === "Y"` cohort and compute their sub-sport of choice
 * across ticket volume (`wagerCount`), bot adoption breadth (`botCustomerCount`),
 * per-bot primary specialization (`primaryChoiceCustomerCount`), and dollar handle (`totalRiskCents`).
 */
export function summarizeSuspectedBotCohort(
  envelope: ReportPlayerAnalysisEnvelope,
  options?: SummarizeSuspectedBotCohortOptions,
): SuspectedBotCohortSummary {
  const rows = envelope.LIST.map(normalizeReportPlayerAnalysisRow).filter(
    (r) => r.suspectedBot === "Y" && r.customerId !== "",
  );
  let hasSummaryRows = false;
  let hasDetailRows = false;
  let maxDateYmd = "";
  const shaHasher = new Bun.CryptoHasher("sha256");
  for (const r of rows) {
    const isSum =
      r.totalBets !== null &&
      r.sportSubType === "" &&
      r.description === "" &&
      r.wagerStatus === "";
    if (isSum) hasSummaryRows = true;
    else hasDetailRows = true;
    const dYmd = (r.postedDateTime || r.dailyFigureDate).slice(0, 10);
    if (YMD_PATTERN.test(dYmd) && dYmd > maxDateYmd) maxDateYmd = dYmd;
    shaHasher.update(
      `${r.customerId}|${r.postedDateTime}|${r.sportSubType}|${r.riskCents}|${r.playerNetCents}|${r.totalBets ?? ""}\n`,
    );
  }
  const inferredReportType =
    hasSummaryRows && hasDetailRows ? "1+2" : hasDetailRows ? "2" : "1";
  const provenance: SuspectedBotCellProvenance = {
    endpoint: options?.endpoint ?? REPORT_PLAYER_ANALYSIS_PATH,
    report_type: options?.reportType ?? inferredReportType,
    as_of: options?.asOf ?? (maxDateYmd !== "" ? maxDateYmd : null),
    query_sha: options?.querySha ?? shaHasher.digest("hex"),
    classifier_version:
      options?.classifierVersion ?? "f402-suspected-bot-v1.0.0",
  };

  interface BotCustAcc {
    customerId: string;
    playerLogin: string;
    agentId: string;
    suspectedBot: string;
    suspectedBotType: number;
    botLabel: SuspectedBotLabel;
    inetTarget: string;
    summaryTotalBets: number | null;
    summaryNetCents: number | null;
    summaryBeatPrice: number | null;
    summaryBeatPoints: number | null;
    detailWagers: number;
    detailNetCents: number;
    detailBeatPrice: number;
    detailBeatPoints: number;
    subSports: Map<string, { wagers: number; riskCents: number }>;
  }

  interface SubSportAcc {
    sportSubType: string;
    parentSports: Set<string>;
    wagerCount: number;
    customers: Set<string>;
    primaryChoiceCustomerCount: number;
    winCount: number;
    lossCount: number;
    pushOrOtherCount: number;
    totalRiskCents: number;
    totalToWinCents: number;
    playerNetCents: number;
    beatClosingPriceCount: number;
    beatClosingPointsCount: number;
  }

  const custMap = new Map<string, BotCustAcc>();
  const subMap = new Map<string, SubSportAcc>();
  const periodDist: Record<string, number> = {};
  let spread = 0;
  let over = 0;
  let under = 0;
  let moneyline = 0;
  let boughtPointsWagerCount = 0;
  let detailRowCount = 0;
  let totalRiskCents = 0;
  let totalToWinCents = 0;
  let detailPlayerNetSum = 0;

  for (const r of rows) {
    let c = custMap.get(r.customerId);
    if (c === undefined) {
      c = {
        customerId: r.customerId,
        playerLogin: r.playerLogin,
        agentId: r.agentId,
        suspectedBot: r.suspectedBot,
        suspectedBotType: r.suspectedBotType,
        botLabel: r.botLabel,
        inetTarget: r.inetTarget,
        summaryTotalBets: null,
        summaryNetCents: null,
        summaryBeatPrice: null,
        summaryBeatPoints: null,
        detailWagers: 0,
        detailNetCents: 0,
        detailBeatPrice: 0,
        detailBeatPoints: 0,
        subSports: new Map(),
      };
      custMap.set(r.customerId, c);
    }
    if (r.inetTarget !== "" && c.inetTarget === "") {
      c.inetTarget = r.inetTarget;
    }

    const isSummary =
      r.totalBets !== null &&
      r.sportSubType === "" &&
      r.description === "" &&
      r.wagerStatus === "";

    if (isSummary) {
      c.summaryTotalBets = r.totalBets;
      c.summaryNetCents = r.playerNetCents;
      c.summaryBeatPrice = r.betterPriceLines;
      c.summaryBeatPoints = r.betterPointsLines;
      continue;
    }

    detailRowCount++;
    c.detailWagers++;
    c.detailNetCents += r.playerNetCents;
    if (r.beatClosingPrice) c.detailBeatPrice++;
    if (r.beatClosingPoints) c.detailBeatPoints++;

    totalRiskCents += r.riskCents;
    totalToWinCents += r.toWinCents;
    detailPlayerNetSum += r.playerNetCents;

    const pKey = r.periodNumber !== null ? String(r.periodNumber) : "unknown";
    periodDist[pKey] = (periodDist[pKey] ?? 0) + 1;

    if (r.boughtPointsDetail.hasBoughtPoints) {
      boughtPointsWagerCount++;
    }
    if (r.betPoints === null) {
      moneyline++;
    } else if (/\sO\s+\d/.test(r.description)) {
      over++;
    } else if (/\sU\s+\d/.test(r.description)) {
      under++;
    } else {
      spread++;
    }

    const sub = r.sportSubType || "(Unspecified)";
    const parentSport = r.description.split(/\s+#/)[0]?.trim() || "Unknown";

    let cs = c.subSports.get(sub);
    if (cs === undefined) {
      cs = { wagers: 0, riskCents: 0 };
      c.subSports.set(sub, cs);
    }
    cs.wagers++;
    cs.riskCents += r.riskCents;

    let st = subMap.get(sub);
    if (st === undefined) {
      st = {
        sportSubType: sub,
        parentSports: new Set(),
        wagerCount: 0,
        customers: new Set(),
        primaryChoiceCustomerCount: 0,
        winCount: 0,
        lossCount: 0,
        pushOrOtherCount: 0,
        totalRiskCents: 0,
        totalToWinCents: 0,
        playerNetCents: 0,
        beatClosingPriceCount: 0,
        beatClosingPointsCount: 0,
      };
      subMap.set(sub, st);
    }
    if (parentSport !== "" && parentSport !== "Unknown") {
      st.parentSports.add(parentSport);
    }
    st.wagerCount++;
    st.customers.add(r.customerId);
    if (r.wagerStatus === "W") st.winCount++;
    else if (r.wagerStatus === "L") st.lossCount++;
    else st.pushOrOtherCount++;
    st.totalRiskCents += r.riskCents;
    st.totalToWinCents += r.toWinCents;
    st.playerNetCents += r.playerNetCents;
    if (r.beatClosingPrice) st.beatClosingPriceCount++;
    if (r.beatClosingPoints) st.beatClosingPointsCount++;
  }

  const byBotType: Record<string, number> = {};
  const customers: SuspectedBotCustomerProfile[] = [];
  let summaryWagerSum = 0;
  let summaryNetSum = 0;

  for (const c of custMap.values()) {
    const typeKey = `${c.suspectedBot}:${c.suspectedBotType} (${c.botLabel})`;
    byBotType[typeKey] = (byBotType[typeKey] ?? 0) + 1;

    const sortedSubs = [...c.subSports.entries()].sort(
      (a, b) => b[1].wagers - a[1].wagers || b[1].riskCents - a[1].riskCents,
    );
    const primary = sortedSubs[0];
    if (primary !== undefined) {
      const st = subMap.get(primary[0]);
      if (st !== undefined) {
        st.primaryChoiceCustomerCount++;
      }
    }

    const totalBets =
      c.detailWagers > 0 ? c.detailWagers : (c.summaryTotalBets ?? 0);
    const playerNetCents =
      c.detailWagers > 0 ? c.detailNetCents : (c.summaryNetCents ?? 0);
    summaryWagerSum += totalBets;
    summaryNetSum += playerNetCents;

    const subRecord: Record<string, number> = {};
    for (const [k, v] of sortedSubs) {
      subRecord[k] = v.wagers;
    }

    customers.push({
      customerId: c.customerId,
      playerLogin: c.playerLogin,
      agentId: c.agentId,
      suspectedBot: c.suspectedBot,
      suspectedBotType: c.suspectedBotType,
      botLabel: c.botLabel,
      inetTarget: c.inetTarget,
      totalBets,
      primarySubSport: primary !== undefined ? primary[0] : null,
      primarySubSportWagers: primary !== undefined ? primary[1].wagers : 0,
      primarySubSportSharePct:
        primary !== undefined && totalBets > 0
          ? Math.round((primary[1].wagers / totalBets) * 1000) / 10
          : 0,
      subSports: subRecord,
      playerNetCents,
      beatClosingPriceCount: c.summaryBeatPrice ?? c.detailBeatPrice,
      beatClosingPointsCount: c.summaryBeatPoints ?? c.detailBeatPoints,
      provenance,
    });
  }

  customers.sort(
    (a, b) =>
      b.totalBets - a.totalBets ||
      Math.abs(b.playerNetCents) - Math.abs(a.playerNetCents),
  );

  const botCustomerCount = customers.length;
  const totalBotWagerCount =
    detailRowCount > 0 ? detailRowCount : summaryWagerSum;
  const totalPlayerNetCents =
    detailRowCount > 0 ? detailPlayerNetSum : summaryNetSum;

  const subSportRankings: SuspectedBotSubSportStats[] = [...subMap.values()]
    .sort(
      (a, b) =>
        b.wagerCount - a.wagerCount || b.totalRiskCents - a.totalRiskCents,
    )
    .map((st) => ({
      sportSubType: st.sportSubType,
      parentSports: [...st.parentSports],
      wagerCount: st.wagerCount,
      wagerSharePct:
        detailRowCount > 0
          ? Math.round((st.wagerCount / detailRowCount) * 1000) / 10
          : 0,
      botCustomerCount: st.customers.size,
      botCustomerReachPct:
        botCustomerCount > 0
          ? Math.round((st.customers.size / botCustomerCount) * 1000) / 10
          : 0,
      primaryChoiceCustomerCount: st.primaryChoiceCustomerCount,
      primaryChoiceSharePct:
        botCustomerCount > 0
          ? Math.round(
              (st.primaryChoiceCustomerCount / botCustomerCount) * 1000,
            ) / 10
          : 0,
      winCount: st.winCount,
      lossCount: st.lossCount,
      pushOrOtherCount: st.pushOrOtherCount,
      totalRiskCents: st.totalRiskCents,
      totalToWinCents: st.totalToWinCents,
      playerNetCents: st.playerNetCents,
      houseNetCents: -st.playerNetCents,
      beatClosingPriceCount: st.beatClosingPriceCount,
      beatClosingPointsCount: st.beatClosingPointsCount,
      provenance,
    }));

  const topByWagers = subSportRankings[0]?.sportSubType ?? null;
  const topByReach =
    [...subSportRankings].sort(
      (a, b) =>
        b.botCustomerCount - a.botCustomerCount || b.wagerCount - a.wagerCount,
    )[0]?.sportSubType ?? null;
  const topByPrimary =
    [...subSportRankings].sort(
      (a, b) =>
        b.primaryChoiceCustomerCount - a.primaryChoiceCustomerCount ||
        b.wagerCount - a.wagerCount,
    )[0]?.sportSubType ?? null;
  const topByRisk =
    [...subSportRankings].sort(
      (a, b) =>
        b.totalRiskCents - a.totalRiskCents || b.wagerCount - a.wagerCount,
    )[0]?.sportSubType ?? null;

  return {
    provenance,
    suspectedBotCustomerCount: botCustomerCount,
    byBotType,
    totalBotWagerCount,
    detailRowCount,
    totalRiskCents,
    totalToWinCents,
    totalPlayerNetCents,
    totalHouseNetCents: -totalPlayerNetCents,
    topSubSportByWagers: topByWagers,
    topSubSportByCustomerReach: topByReach,
    topSubSportByPrimaryChoice: topByPrimary,
    topSubSportByRiskCents: topByRisk,
    periodDistribution: periodDist,
    marketTypeDistribution: {
      spread,
      over,
      under,
      moneyline,
    },
    boughtPointsWagerCount,
    subSportRankings,
    customers,
  };
}

export interface FetchReportPlayerAnalysisOptions {
  readonly host?: string;
  readonly authorizationHeader?: string;
  readonly readSession?: typeof readF402Session;
}

let cachedMintedBearer: { token: string; expMs: number } | null = null;

async function mintBearerViaAuthenticateCustomer(
  transport: F402ReplayTransport,
  host: string,
): Promise<string | null> {
  const now = Date.now();
  if (cachedMintedBearer !== null && cachedMintedBearer.expMs - now > 60_000) {
    return `Bearer ${cachedMintedBearer.token}`;
  }
  const envAgent = (Bun.env.F402_AGENT_ID ?? "").trim();
  const envPass = (Bun.env.F402_PASSWORD ?? "").trim();
  const agentId =
    envAgent !== ""
      ? envAgent
      : ((
          await readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.agentId)
        )?.trim() ?? "");
  const password =
    envPass !== ""
      ? envPass
      : ((
          await readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.password)
        )?.trim() ?? "");
  if (agentId === "" || password === "") return null;

  const payload = buildAuthenticateCustomerBody(
    agentId.toUpperCase(),
    password.toUpperCase(),
  );
  const res = await transport.fetch(
    `${host}/cloud/api/System/authenticateCustomer`,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify(payload),
      redirect: "manual",
    },
  );
  if (!res.ok) return null;
  try {
    const json = (await res.json()) as { code?: unknown };
    const code = typeof json.code === "string" ? json.code.trim() : "";
    if (code === "") return null;
    const expMs = decodeJwtExp(code) ?? now + 20 * 60_000;
    cachedMintedBearer = { token: code, expMs };
    return `Bearer ${code}`;
  } catch {
    return null;
  }
}

async function buildManagerFormHeaders(
  transport: F402ReplayTransport,
  host: string,
  options?: FetchReportPlayerAnalysisOptions,
  forceMint = false,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
  };
  const explicitAuth = options?.authorizationHeader?.trim() ?? "";
  if (explicitAuth !== "") {
    headers.authorization = explicitAuth.startsWith("Bearer ")
      ? explicitAuth
      : `Bearer ${explicitAuth}`;
    return headers;
  }
  if (!forceMint) {
    // Keychain store: load the session first so the sync reads below (and the bearer resolver's
    // session fallback) see it; a store failure throws by name.
    if (options?.readSession === undefined) await primeF402Session();
    const session = (options?.readSession ?? readF402Session)();
    const sessionAuth = session?.authorizationHeader?.trim() ?? "";
    if (sessionAuth !== "") {
      headers.authorization = sessionAuth;
      return headers;
    }
    if (options?.readSession === undefined) {
      try {
        const resolved = resolveF402BearerTokenDetailed();
        const expMs = decodeJwtExp(resolved.token);
        if (expMs === null || expMs - Date.now() > 30_000) {
          headers.authorization = `Bearer ${resolved.token}`;
          return headers;
        }
      } catch {
        // fall through to authenticateCustomer mint
      }
    }
  }
  if (options?.readSession === undefined) {
    if (forceMint) cachedMintedBearer = null;
    const minted = await mintBearerViaAuthenticateCustomer(transport, host);
    if (minted !== null) {
      headers.authorization = minted;
    }
  }
  return headers;
}

/**
 * Fetch `POST /cloud/api/Manager/getReportPlayerAnalysis` through `F402ReplayTransport`
 * and return both the raw envelope and the normalized portfolio/customer summary.
 */
export async function fetchReportPlayerAnalysis(
  transport: F402ReplayTransport,
  request: ReportPlayerAnalysisRequest,
  options?: FetchReportPlayerAnalysisOptions,
): Promise<{
  readonly envelope: ReportPlayerAnalysisEnvelope;
  readonly summary: PortfolioAnalysisSummary;
  readonly url: string;
  readonly bodyFields: Readonly<Record<string, string>>;
}> {
  const host = (options?.host ?? PROBE_HOST).replace(/\/$/, "");
  const url = `${host}${REPORT_PLAYER_ANALYSIS_PATH}`;
  const bodyFields = buildReportPlayerAnalysisFormFields(request);
  const bodyString = buildReportPlayerAnalysisFormBody(request);
  let headers = await buildManagerFormHeaders(transport, host, options, false);

  let res = await transport.fetch(url, {
    method: "POST",
    headers,
    body: bodyString,
    redirect: "manual",
  });
  if (res.status === 401 && options?.readSession === undefined) {
    headers = await buildManagerFormHeaders(transport, host, options, true);
    res = await transport.fetch(url, {
      method: "POST",
      headers,
      body: bodyString,
      redirect: "manual",
    });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ReportPlayerAnalysisError(
      `getReportPlayerAnalysis HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReportPlayerAnalysisError(
      `getReportPlayerAnalysis invalid JSON: ${text.slice(0, 200)}`,
    );
  }
  const envelope = parseReportPlayerAnalysisEnvelope(parsed);
  const summary = summarizeReportPlayerAnalysis(envelope);
  return { envelope, summary, url, bodyFields };
}

/** Fetch `POST /cloud/api/Manager/getLineTypes` through `F402ReplayTransport`. */
export async function fetchLineTypes(
  transport: F402ReplayTransport,
  request: LineTypesRequest,
  options?: FetchReportPlayerAnalysisOptions,
): Promise<readonly LineTypeOption[]> {
  const host = (options?.host ?? PROBE_HOST).replace(/\/$/, "");
  const url = `${host}${LINE_TYPES_PATH}`;
  const bodyString = buildLineTypesFormBody(request);
  let headers = await buildManagerFormHeaders(transport, host, options, false);

  let res = await transport.fetch(url, {
    method: "POST",
    headers,
    body: bodyString,
    redirect: "manual",
  });
  if (res.status === 401 && options?.readSession === undefined) {
    headers = await buildManagerFormHeaders(transport, host, options, true);
    res = await transport.fetch(url, {
      method: "POST",
      headers,
      body: bodyString,
      redirect: "manual",
    });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ReportPlayerAnalysisError(
      `getLineTypes HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReportPlayerAnalysisError(
      `getLineTypes invalid JSON: ${text.slice(0, 200)}`,
    );
  }
  return parseLineTypesEnvelope(parsed);
}

export interface CombinedCustomerDetailAnalysis {
  readonly customerId: string;
  readonly pointsWagerCount: number;
  readonly priceWagerCount: number;
  readonly totalWagerCount: number;
  readonly beatPointsCount: number;
  readonly beatPriceCount: number;
  readonly combinedBeatCount: number;
  readonly combinedBeatRate: number;
  readonly totalRiskCents: number;
  readonly totalToWinCents: number;
  readonly playerNetCents: number;
  readonly houseNetCents: number;
  /**
   * Count of wagers where `periodNumber !== 0` (1st Half, 2nd Half, Quarters, etc.).
   * Fixes the `0 !== c.PERIODNUMBER` string-vs-number bug in `customer-admin/analysis.js`
   * that marks 100.00% of wagers as Non-Game in the portal UI.
   */
  readonly nonGameWagerCount: number;
  readonly nonGameWagerPct: number;
  /**
   * Count of wagers whose trimmed `SPORTSUBTYPE` is outside `ANALYSIS_MAJOR_SPORT_SUBTYPES`
   * (matching the `Odd-Ball` header metric in `customer-admin/analysis.js`).
   */
  readonly oddBallWagerCount: number;
  readonly oddBallWagerPct: number;
  /**
   * Count of `lineType=3` (Price) wagers where the spread/total closed on the exact bet number
   * (`betPoints !== null && pointsDelta === null`), closing juice was standard `-110`, and the
   * player's base juice was reduced (`-109 <= juice <= -101`), generating a mechanical `PRICE < 0`
   * beat solely from a reduced-juice deal (`modal-info.html`).
   */
  readonly reducedJuicePerkWagerCount: number;
  readonly summaryReconciliation: {
    readonly provided: boolean;
    readonly totalBetsMatches: boolean;
    readonly beatPointsMatches: boolean;
    readonly beatPriceMatches: boolean;
    readonly playerNetCentsMatches: boolean;
    readonly allMatch: boolean;
  };
  readonly mergedSummary: PortfolioAnalysisSummary;
}

/**
 * Merge a customer's `lineType: 2` (Points wagers) and `lineType: 3` (Price wagers)
 * detail envelopes (`reportType: 2`) and optionally reconcile against their `reportType: 1`
 * book-wide summary row (`TOTALBETS === points.length + price.length`, `WINLOSE === signedNetCents`).
 */
export function summarizeCombinedCustomerDetail(
  pointsInput:
    ReportPlayerAnalysisEnvelope | readonly ReportPlayerAnalysisRowRaw[],
  priceInput:
    ReportPlayerAnalysisEnvelope | readonly ReportPlayerAnalysisRowRaw[],
  summaryRowRaw?: ReportPlayerAnalysisRowRaw | null,
): CombinedCustomerDetailAnalysis {
  const pointsRows = "LIST" in pointsInput ? pointsInput.LIST : pointsInput;
  const priceRows = "LIST" in priceInput ? priceInput.LIST : priceInput;
  const combinedRaw = [...pointsRows, ...priceRows];
  const mergedSummary = summarizeReportPlayerAnalysis(combinedRaw);

  let nonGameWagerCount = 0;
  let oddBallWagerCount = 0;
  let reducedJuicePerkWagerCount = 0;

  for (const raw of combinedRaw) {
    const row = normalizeReportPlayerAnalysisRow(raw);
    if (row.periodNumber !== null && row.periodNumber !== 0) {
      nonGameWagerCount++;
    }
    const subUpper = row.sportSubType.trim().toUpperCase();
    if (subUpper !== "" && !ANALYSIS_MAJOR_SPORT_SUBTYPES.has(subUpper)) {
      oddBallWagerCount++;
    }
  }

  for (const raw of priceRows) {
    const row = normalizeReportPlayerAnalysisRow(raw);
    if (
      row.betPoints !== null &&
      row.pointsDelta === null &&
      row.closeJuice === -110 &&
      row.juice !== null &&
      row.juice > -110 &&
      row.juice <= -101 &&
      row.beatClosingPrice
    ) {
      reducedJuicePerkWagerCount++;
    }
  }

  const totalWagerCount = combinedRaw.length;
  const beatPointsCount = mergedSummary.beatClosingPointsCount;
  const beatPriceCount = mergedSummary.beatClosingPriceCount;
  const combinedBeatCount = beatPointsCount + beatPriceCount;
  const combinedBeatRate =
    totalWagerCount > 0
      ? Math.round((combinedBeatCount / totalWagerCount) * 10000) / 10000
      : 0;
  const nonGameWagerPct =
    totalWagerCount > 0
      ? Math.round((nonGameWagerCount / totalWagerCount) * 10000) / 100
      : 0;
  const oddBallWagerPct =
    totalWagerCount > 0
      ? Math.round((oddBallWagerCount / totalWagerCount) * 10000) / 100
      : 0;

  const firstCustomer =
    mergedSummary.customers[0]?.customerId ??
    (summaryRowRaw !== undefined && summaryRowRaw !== null
      ? normalizeReportPlayerAnalysisRow(summaryRowRaw).customerId
      : "");

  let reconciliation = {
    provided: false,
    totalBetsMatches: true,
    beatPointsMatches: true,
    beatPriceMatches: true,
    playerNetCentsMatches: true,
    allMatch: true,
  };
  if (summaryRowRaw !== undefined && summaryRowRaw !== null) {
    const normSum = normalizeReportPlayerAnalysisRow(summaryRowRaw);
    const totalBetsMatches = normSum.totalBets === totalWagerCount;
    const beatPointsMatches = normSum.betterPointsLines === beatPointsCount;
    const beatPriceMatches = normSum.betterPriceLines === beatPriceCount;
    const playerNetCentsMatches =
      normSum.playerNetCents === mergedSummary.totalPlayerNetCents;
    reconciliation = {
      provided: true,
      totalBetsMatches,
      beatPointsMatches,
      beatPriceMatches,
      playerNetCentsMatches,
      allMatch:
        totalBetsMatches &&
        beatPointsMatches &&
        beatPriceMatches &&
        playerNetCentsMatches,
    };
  }

  return {
    customerId: firstCustomer,
    pointsWagerCount: pointsRows.length,
    priceWagerCount: priceRows.length,
    totalWagerCount,
    beatPointsCount,
    beatPriceCount,
    combinedBeatCount,
    combinedBeatRate,
    totalRiskCents: mergedSummary.totalRiskCents,
    totalToWinCents: mergedSummary.totalToWinCents,
    playerNetCents: mergedSummary.totalPlayerNetCents,
    houseNetCents: mergedSummary.totalHouseNetCents,
    nonGameWagerCount,
    nonGameWagerPct,
    oddBallWagerCount,
    oddBallWagerPct,
    reducedJuicePerkWagerCount,
    summaryReconciliation: reconciliation,
    mergedSummary,
  };
}

/**
 * Fetch both `lineType: 2` (Points wagers) and `lineType: 3` (Price wagers) in `reportType: 2`
 * for a single customer and return the merged detail analysis.
 */
export async function fetchCustomerPlayerAnalysisDetail(
  transport: F402ReplayTransport,
  request: Omit<ReportPlayerAnalysisRequest, "reportType" | "lineType"> & {
    readonly customerID: string;
    readonly summaryRowRaw?: ReportPlayerAnalysisRowRaw | null;
  },
  options?: FetchReportPlayerAnalysisOptions,
): Promise<{
  readonly pointsEnvelope: ReportPlayerAnalysisEnvelope;
  readonly priceEnvelope: ReportPlayerAnalysisEnvelope;
  readonly detail: CombinedCustomerDetailAnalysis;
}> {
  const pointsRes = await fetchReportPlayerAnalysis(
    transport,
    {
      ...request,
      reportType: ANALYSIS_REPORT_TYPES.PLAYER_DETAIL,
      lineType: ANALYSIS_LINE_TYPES.POINTS,
    },
    options,
  );
  const priceRes = await fetchReportPlayerAnalysis(
    transport,
    {
      ...request,
      reportType: ANALYSIS_REPORT_TYPES.PLAYER_DETAIL,
      lineType: ANALYSIS_LINE_TYPES.PRICE,
    },
    options,
  );
  const detail = summarizeCombinedCustomerDetail(
    pointsRes.envelope,
    priceRes.envelope,
    request.summaryRowRaw,
  );
  return {
    pointsEnvelope: pointsRes.envelope,
    priceEnvelope: priceRes.envelope,
    detail,
  };
}
