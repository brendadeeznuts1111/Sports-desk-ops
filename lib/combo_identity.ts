/**
 * @file combo_identity.ts
 * @description Specification-Grade Canonicalization & Identity Engine for Cross-Market Parlay Matching,
 *              upgraded with the de-obfuscated Fantasy402 `customer/report/report.js` Rosetta Stone schema.
 *
 * Implements:
 * 1. Registry extracted from the deobfuscated `customer/report/report.js` (`api/Report/Pending`,
 *    `api/Report/getGrading`, etc.).
 *    - `[CODE]` Parameter names (`["RRO", "agentID", "agentOwner", "customerID", "operation"]` on Manager
 *      and `["customerID", "operation", "token"]` / `date` / `week` on Report) verified PII-safe (no parameter
 *      values recorded) in `docs/evidence/captures/schema/_sniffed_form_templates.json`.
 *    - `[OBSERVED]` Per-prefix routing (`docs/evidence/captures/2026-11-01/`):
 *      - `[Report]`: `/cloud/api/Report/Pending` (`[A]`, 73-field leg schema) and `/cloud/api/Report/getGrading` (`[A-empty]`).
 *      - `[Manager]`: `/cloud/api/Manager/getTransactions` (`[A-empty]`, 200 on Manager vs 500 on Report without `date`).
 *      - `[unknown]`: `getDailyFiguresByCustomer`, `getGradedWagerByCustomer`, `getTicketDetailPrint` (500 on both prefixes;
 *        tracked in `docs/evidence/captures/pending-500s/diagnostics.json`).
 * 2. Definitive 10-Code `WagerType` Map (`getTypeInfo`: S, M, C, T, L, E, I, P, G, A).
 * 3. Deterministic `getRotationNumber(d)` (`d.Team1ID === d.ChosenTeamID ? d.Team1RotNum : d.Team2RotNum`) + DGS `GameNum + 5000` Alt-Spread normalization.
 * 4. Exact `getLineGame(d)` Teaser & Line Math:
 *    - Spread: `effectiveLine = parseFloat(d.AdjSpread) + (parseFloat(d.TeaserPoints) || 0)`
 *    - Total (`L`/`E`): `TotalPointsOU === "o"` subtracts `TeaserPoints`; `"u"` adds `TeaserPoints`.
 * 5. Pre-Hash Composite Ticket Grouping (`d.TicketNumber + "-" + d.WagerNumber`) via `groupF402PendingRowsByTicket()`.
 * 6. LineHundredths integer precision (-3.25 -> -325) & order-independent SHA-256 identity/shape/pick-shape hashes.
 */

import type { Brand, Sha256Hex } from "../design/domain-branded-types.ts";
import { sha256FromDigest } from "./brand.ts";
import {
  deriveGameIdentifier,
  normalizeCanonicalPeriod,
  normalizeCanonicalSubject,
  type CanonicalPeriod,
  type MarketKind,
  type MarketSide,
} from "./leg_taxonomy.ts";

export type {
  CanonicalPeriod,
  MarketKind,
  MarketSide,
} from "./leg_taxonomy.ts";
export {
  deriveGameIdentifier,
  normalizeCanonicalPeriod,
  normalizeCanonicalSubject,
} from "./leg_taxonomy.ts";

// ============================================================================
// 0. ROSETTA STONE: EXACT `customer/report/report.js` ENDPOINTS & WAGER TYPES
// ============================================================================

export const F402_CUSTOMER_REPORT_ENDPOINTS = {
  /** `[Report]` `[A]` Fetches open/pending wagers (`getPendingWagers` -> `e.Pending` 73-field leg array) */
  pending: "api/Report/Pending",
  /** `[UNVERIFIED]` Fetches a specific pending ticket for deletion (`setDeleteWager`; excluded until read-only confirmed) */
  pendingDelete: "api/Report/PendingDelete",
  /** `[unknown]` 500 on both Manager and Report (`docs/evidence/captures/pending-500s/diagnostics.json`) */
  dailyFiguresByCustomer: "api/Report/getDailyFiguresByCustomer",
  /** `[unknown]` 500 on both Manager and Report (`docs/evidence/captures/pending-500s/diagnostics.json`) */
  gradedWagerByCustomer: "api/Report/getGradedWagerByCustomer",
  /** `[Manager]` `[A-empty]` 200 on `/cloud/api/Manager/getTransactions` (500 on Report without `date=MM/DD/YYYY`) */
  transactions: "api/Report/getTransactions",
  /** `[Report]` `[A-empty]` Fetches graded wagers by figure date (`{"LIST":""}` envelope confirmed on `/cloud/api/Report/getGrading`) */
  gradingByFigureDate: "api/Report/getGrading",
  /** `[unknown]` 500 on both Manager and Report (`docs/evidence/captures/pending-500s/diagnostics.json`) */
  ticketDetailPrint: "api/Report/getTicketDetailPrint",
} as const;

export type F402ReportWagerTypeCode =
  "S" | "M" | "C" | "T" | "L" | "E" | "I" | "P" | "G" | "A";

export interface F402WagerTypeMeta {
  readonly code: F402ReportWagerTypeCode;
  readonly labelKey: string;
  readonly name: string;
  readonly appendsTotalPicks: boolean;
  readonly isSportsCanonicalEligible: boolean;
}

/**
 * Definitive `getTypeInfo` map from `customer/report/report.js`.
 */
export const F402_WAGER_TYPE_MAP: Readonly<
  Record<F402ReportWagerTypeCode, F402WagerTypeMeta>
> = {
  S: {
    code: "S",
    labelKey: "L-142",
    name: "Straight",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: true,
  },
  M: {
    code: "M",
    labelKey: "L-432",
    name: "Moneyline",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: true,
  },
  C: {
    code: "C",
    labelKey: "L-203",
    name: "Casino",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: false,
  },
  T: {
    code: "T",
    labelKey: "L-85",
    name: "Teaser",
    appendsTotalPicks: true,
    isSportsCanonicalEligible: true,
  },
  L: {
    code: "L",
    labelKey: "L-144",
    name: "Total",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: true,
  },
  E: {
    code: "E",
    labelKey: "L-145",
    name: "Team Total",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: true,
  },
  I: {
    code: "I",
    labelKey: "L-16",
    name: "If-Bet",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: true,
  },
  P: {
    code: "P",
    labelKey: "L-15",
    name: "Parlay",
    appendsTotalPicks: true,
    isSportsCanonicalEligible: true,
  },
  G: {
    code: "G",
    labelKey: "LIVE",
    name: "Racebook / Live Wagers (LIVEBETTINGCWS / EZL - INTERNET)",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: true,
  },
  A: {
    code: "A",
    labelKey: "L-202",
    name: "Action / Manual Play",
    appendsTotalPicks: false,
    isSportsCanonicalEligible: false,
  },
};

/**
 * Raw leg object shape inside `e.Pending` (`api/Report/Pending`) and `api/Report/getGrading`.
 */
export interface F402CustomerReportPendingRow {
  readonly TicketNumber: string | number;
  readonly WagerNumber: string | number;
  readonly CustomerID?: string | undefined;
  readonly Login?: string | undefined;
  readonly AgentID?: string | undefined;
  readonly AmountWagered: number; // Always stored in integer cents
  readonly ToWinAmount: number; // Always stored in integer cents
  readonly Description?: string | undefined;
  readonly WagerType: F402ReportWagerTypeCode | string;
  readonly totalPicks?: number | undefined;
  readonly GameDateTime?: string | undefined;
  readonly SportType?: string | undefined;
  readonly SportSubType?: string | undefined;
  readonly PeriodNumber?: number | string | undefined;
  readonly Team1ID?: string | undefined;
  readonly Team2ID?: string | undefined;
  readonly ChosenTeamID?: string | undefined;
  readonly Team1RotNum?: number | string | undefined;
  readonly Team2RotNum?: number | string | undefined;
  readonly AdjSpread?: number | string | null | undefined;
  readonly AdjTotalPoints?: number | string | null | undefined;
  readonly TotalPointsOU?: "o" | "u" | "O" | "U" | string | null | undefined;
  readonly TeaserPoints?: number | string | null | undefined;
  readonly FreePlayFlag?: "Y" | "N" | string | undefined;
  readonly WagerStatus?: "W" | "L" | "X" | "P" | string | undefined;
  readonly PlacedOn?: string | undefined;
  readonly TicketWriter?: string | undefined;
  readonly ListedPitcher1?: string | undefined;
  readonly Pitcher1ReqFlag?: string | undefined;
}

/**
 * Exact composite parent ticket key from `getPendingWagers`:
 * `var m = d.TicketNumber + "-" + d.WagerNumber;`
 */
export function getF402TicketGroupKey(
  row: Pick<F402CustomerReportPendingRow, "TicketNumber" | "WagerNumber">,
): string {
  return `${String(row.TicketNumber).trim()}-${String(row.WagerNumber).trim()}`;
}

/**
 * Exact `getRotationNumber` logic from `customer/report/report.js`, plus DGS `GameNum + 5000` Alt-Spread normalization.
 */
export function extractF402RotationNumber(
  row: Pick<
    F402CustomerReportPendingRow,
    "Team1ID" | "Team2ID" | "ChosenTeamID" | "Team1RotNum" | "Team2RotNum"
  >,
): {
  readonly rawRotNum: number | null;
  readonly canonicalRotNum: number | null;
  readonly isAltSpreadRotation: boolean;
} {
  const chosen = (row.ChosenTeamID ?? "").trim();
  const team1 = (row.Team1ID ?? "").trim();
  const rawSelected =
    chosen && team1 && team1 === chosen
      ? row.Team1RotNum
      : (row.Team2RotNum ?? row.Team1RotNum);

  if (rawSelected === undefined || rawSelected === null || rawSelected === "") {
    return {
      rawRotNum: null,
      canonicalRotNum: null,
      isAltSpreadRotation: false,
    };
  }
  const parsed =
    typeof rawSelected === "number"
      ? rawSelected
      : parseInt(String(rawSelected).trim(), 10);
  if (!Number.isFinite(parsed)) {
    return {
      rawRotNum: null,
      canonicalRotNum: null,
      isAltSpreadRotation: false,
    };
  }
  const isAlt = parsed >= 5000 && parsed < 6000;
  const canonical = isAlt ? parsed - 5000 : parsed;
  return {
    rawRotNum: parsed,
    canonicalRotNum: canonical,
    isAltSpreadRotation: isAlt,
  };
}

/**
 * Exact `getLineGame` effective line calculation from `customer/report/report.js`:
 * - Spread (`S` or spread leg in `P`/`T`): `Effective Line = parseFloat(AdjSpread) + parseFloat(TeaserPoints)`
 * - Total (`L` or `E` or total leg in `P`/`T` with `TotalPointsOU`):
 *   If `TeaserPoints > 0`:
 *     - Over (`TotalPointsOU.toLowerCase() === "o"`): `AdjTotalPoints - TeaserPoints`
 *     - Under (`TotalPointsOU.toLowerCase() === "u"`): `AdjTotalPoints + TeaserPoints`
 * - Moneyline (`M`): `null`
 */
export function computeF402EffectiveLine(
  row: Pick<
    F402CustomerReportPendingRow,
    | "WagerType"
    | "AdjSpread"
    | "AdjTotalPoints"
    | "TotalPointsOU"
    | "TeaserPoints"
  >,
): {
  readonly marketKind: MarketKind;
  readonly side: MarketSide;
  readonly rawLine: number | null;
  readonly teaserPoints: number;
  readonly effectiveLine: number | null;
  readonly effectiveLineHundredths: LineHundredths | null;
} {
  const wt = (row.WagerType ?? "").trim().toUpperCase();
  const teaserRaw =
    row.TeaserPoints !== null &&
    row.TeaserPoints !== undefined &&
    row.TeaserPoints !== ""
      ? parseFloat(String(row.TeaserPoints))
      : 0;
  const teaserPoints = Number.isFinite(teaserRaw) ? teaserRaw : 0;

  const ouRaw = (row.TotalPointsOU ?? "").toString().trim().toLowerCase();
  const hasTotalPoints =
    row.AdjTotalPoints !== null &&
    row.AdjTotalPoints !== undefined &&
    row.AdjTotalPoints !== "" &&
    (wt === "L" || wt === "E" || ouRaw === "o" || ouRaw === "u");

  if (wt === "M") {
    return {
      marketKind: "moneyline",
      side: "YES",
      rawLine: null,
      teaserPoints: 0,
      effectiveLine: null,
      effectiveLineHundredths: null,
    };
  }

  if (hasTotalPoints) {
    const baseTotal = parseFloat(String(row.AdjTotalPoints));
    const isOver = ouRaw === "o" || ouRaw === "over";
    const side: MarketSide = isOver ? "OVER" : "UNDER";
    const effective =
      teaserPoints > 0
        ? isOver
          ? baseTotal - teaserPoints
          : baseTotal + teaserPoints
        : baseTotal;
    return {
      marketKind: wt === "E" ? "team_total" : "total",
      side,
      rawLine: baseTotal,
      teaserPoints,
      effectiveLine: effective,
      effectiveLineHundredths: parseLineHundredths(effective),
    };
  }

  if (
    row.AdjSpread !== null &&
    row.AdjSpread !== undefined &&
    row.AdjSpread !== ""
  ) {
    const baseSpread = parseFloat(String(row.AdjSpread));
    const effective =
      teaserPoints !== 0 ? baseSpread + teaserPoints : baseSpread;
    const side: MarketSide = effective < 0 ? "FAVORITE" : "UNDERDOG";
    return {
      marketKind: "spread",
      side,
      rawLine: baseSpread,
      teaserPoints,
      effectiveLine: effective,
      effectiveLineHundredths: parseLineHundredths(effective),
    };
  }

  return {
    marketKind: "unknown",
    side: "UNKNOWN",
    rawLine: null,
    teaserPoints,
    effectiveLine: null,
    effectiveLineHundredths: null,
  };
}

// ============================================================================
// 1. BRANDED LINE HUNDREDTHS & PRECISION NORMALIZATION
// ============================================================================

export type LineHundredths = Brand<number, "LineHundredths">;

/**
 * Normalizes float lines to integer hundredths.
 * Collapses float noise (e.g. 3.5000000000000004 -> 350, -6.5 -> -650).
 * Throws on invalid sub-hundredth precision (e.g. 3.245).
 */
export function parseLineHundredths(
  raw: number | string | null | undefined,
): LineHundredths | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const num =
    typeof raw === "string" ? parseFloat(raw.trim().replace("+", "")) : raw;
  if (!Number.isFinite(num)) {
    throw new TypeError(`Invalid line value: ${String(raw)}`);
  }
  const collapsed = Math.round(num * 10000) / 10000;
  const multiplied = collapsed * 100;
  const rounded = Math.round(multiplied);

  if (Math.abs(multiplied - rounded) > 0.001) {
    throw new RangeError(
      `Line precision exceeds hundredths boundary (sub-hundredth precision rejected): ${raw}`,
    );
  }
  return rounded === 0 ? (0 as LineHundredths) : (rounded as LineHundredths);
}

export function formatLineHundredths(line: LineHundredths | null): string {
  if (line === null) return "PK";
  const points = line / 100;
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(points % 1 === 0 ? 1 : 2)}`;
}

// ============================================================================
// 2. CANONICAL PERIOD, LEG & MARKET TAXONOMY
// ============================================================================

// ============================================================================
// 2. LEG PRODUCT (the combo construct; the four dimensions live in leg_taxonomy.ts)
// ============================================================================

export type ProductClass =
  "straight" | "parlay" | "teaser" | "sgp" | "live" | "if_bet" | "unknown";

export interface CanonicalLeg {
  /** Canonical Game Identifier: e.g. "CFB:BAYLOR_VS_OPP", "2026-10-31:501", "NBA:BOS_VS_LAL" */
  readonly gameId: string;
  /** Period identifier: game (0), 1h (1), 2h (2), 1q..4q (3..6), live (0G) */
  readonly period?: CanonicalPeriod;
  /** Subject entity: team abbreviation, player code, or market scope (e.g. "BAYLOR", "NE", "LAL", "BOS") */
  readonly subject: string;
  /** Primary market kind */
  readonly marketKind: MarketKind;
  /** Side chosen */
  readonly side: MarketSide;
  /** Semantic EFFECTIVE line in hundredths (includes TeaserPoints adjustment; null for moneyline) */
  readonly lineHundredths: LineHundredths | null;
  /** Source product class */
  readonly productClass: ProductClass;
  /** Optional ROT metadata from customer/report/report.js */
  readonly rotationNumber?: number | null;
  /** Optional raw line in hundredths prior to TeaserPoints movement */
  readonly rawLineHundredths?: LineHundredths | null;
  /** Optional TeaserPoints movement in hundredths */
  readonly teaserPointsHundredths?: LineHundredths | null;
}

export interface CanonicalComboPayload {
  readonly legs: readonly CanonicalLeg[];
  readonly sourceTicket: string;
  readonly venue: "polymarket" | "f402";
  readonly accountOrWallet: string;
  readonly agentId?: string;
  readonly placedAtUtc?: string;
}

// ============================================================================
// 3. PURE IDENTITY HASHING ENGINE (Bun.CryptoHasher)
// ============================================================================

/** Formats a single leg into deterministic string for exact identity hashing */
export function formatExactLegString(leg: CanonicalLeg): string {
  const periodStr = leg.period && leg.period !== "game" ? `:${leg.period}` : "";
  const lineStr =
    leg.lineHundredths !== null ? String(leg.lineHundredths) : "NONE";
  return `${leg.gameId}${periodStr}|${leg.subject}|${leg.marketKind}|${leg.side}|${lineStr}|${leg.productClass}`;
}

/** Formats a single leg ignoring line deltas (for shape matching across lines) */
export function formatShapeLegString(leg: CanonicalLeg): string {
  const periodStr = leg.period && leg.period !== "game" ? `:${leg.period}` : "";
  return `${leg.gameId}${periodStr}|${leg.subject}|${leg.marketKind}|${leg.side}|${leg.productClass}`;
}

/** Formats a single leg ignoring line deltas and product class (for pick-service tout bursts) */
export function formatPickShapeLegString(leg: CanonicalLeg): string {
  const periodStr = leg.period && leg.period !== "game" ? `:${leg.period}` : "";
  return `${leg.gameId}${periodStr}|${leg.subject}|${leg.marketKind}|${leg.side}`;
}

function computeSha256(content: string): Sha256Hex {
  return sha256FromDigest(Bun.CryptoHasher.hash("sha256", content, "hex"));
}

export interface ComboIdentityHashes {
  /** Exact match hash (order-independent, includes effective lines and product class) */
  readonly identitySha256: Sha256Hex;
  /** Shape match hash (order-independent, ignores line deltas) */
  readonly shapeSha256: Sha256Hex;
  /** Pick service match hash (order-independent, ignores lines & product classes) */
  readonly pickShapeSha256: Sha256Hex;
  readonly sortedExactKeys: readonly string[];
}

/**
 * Computes pure identity hashes over a list of canonical legs.
 * - Deduplicates identical legs before hashing.
 * - Sorts order-independently so [A, B] === [B, A].
 */
export function computeComboIdentityHashes(
  legs: readonly CanonicalLeg[],
): ComboIdentityHashes {
  if (legs.length === 0) {
    throw new Error("Cannot compute combo identity on empty leg list");
  }

  const exactStrings = Array.from(
    new Set(legs.map(formatExactLegString)),
  ).sort();
  const identitySha256 = computeSha256(exactStrings.join(";"));

  const shapeStrings = Array.from(
    new Set(legs.map(formatShapeLegString)),
  ).sort();
  const shapeSha256 = computeSha256(shapeStrings.join(";"));

  const pickShapeStrings = Array.from(
    new Set(legs.map(formatPickShapeLegString)),
  ).sort();
  const pickShapeSha256 = computeSha256(pickShapeStrings.join(";"));

  return {
    identitySha256,
    shapeSha256,
    pickShapeSha256,
    sortedExactKeys: exactStrings,
  };
}

// ============================================================================
// 4. SOURCE WIRE MAPPERS: mapPolyLeg(), mapF402ReportLeg(), & mapF402Leg()
// ============================================================================

export interface PolymarketRawOrderLeg {
  readonly orderHash?: string;
  readonly conditionId?: string;
  readonly proxyWallet?: string;
  readonly competitionFamily?: string;
  readonly gameId?: string;
  readonly period?: string | number;
  readonly team?: string;
  readonly participantCode?: string;
  readonly marketKind?: string;
  readonly side?: string;
  readonly line?: number | string | null;
  readonly productClass?: string;
  readonly timestamp?: string;
}

export interface F402RawTicketLeg {
  readonly ticketNumber: string | number;
  readonly wagerNumber: string | number;
  readonly customerId: string;
  readonly agentId?: string;
  readonly sportType?: string;
  readonly sportSubType?: string;
  readonly period?: string | number;
  readonly team?: string;
  readonly shortName?: string;
  readonly shortDesc?: string;
  readonly line?: number | string | null;
  readonly riskCents?: number;
  readonly winCents?: number;
  readonly placedAt?: string;
  // Rosetta Stone direct JSON fields (customer/report/report.js)
  readonly WagerType?: F402ReportWagerTypeCode | string;
  readonly GameDateTime?: string;
  readonly Team1ID?: string;
  readonly Team2ID?: string;
  readonly ChosenTeamID?: string;
  readonly Team1RotNum?: number | string;
  readonly Team2RotNum?: number | string;
  readonly AdjSpread?: number | string | null;
  readonly AdjTotalPoints?: number | string | null;
  readonly TotalPointsOU?: "o" | "u" | "O" | "U" | string | null;
  readonly TeaserPoints?: number | string | null;
  readonly PlacedOn?: string;
  readonly TicketWriter?: string;
}

/**
 * Maps Polymarket OrderFilled / CTF Combo leg to CanonicalLeg.
 */
export function mapPolyLeg(raw: PolymarketRawOrderLeg): CanonicalLeg {
  const family = raw.competitionFamily ?? "SPORTS";
  const subject = normalizeCanonicalSubject(raw.participantCode ?? raw.team);
  const gameId = raw.gameId ?? deriveGameIdentifier(family, subject);
  const period = normalizeCanonicalPeriod(raw.period);

  let marketKind: MarketKind = "unknown";
  const rawMk = (raw.marketKind ?? "").toLowerCase();
  if (rawMk === "team_total" || rawMk.includes("team total"))
    marketKind = "team_total";
  else if (rawMk.includes("spread")) marketKind = "spread";
  else if (
    rawMk.includes("total") ||
    rawMk.includes("over") ||
    rawMk.includes("under")
  )
    marketKind = "total";
  else if (rawMk.includes("moneyline") || rawMk.includes("ml"))
    marketKind = "moneyline";
  else if (rawMk.includes("prop")) marketKind = "prop";
  else if (rawMk.includes("teaser")) marketKind = "teaser";

  let side: MarketSide = "UNKNOWN";
  const rawSide = (raw.side ?? "").toUpperCase();
  // Exact tokens first: "UNDERDOG" contains "UNDER", so substring matching alone
  // would mislabel every underdog spread as a total Under.
  if (rawSide === "UNDERDOG") side = "UNDERDOG";
  else if (rawSide === "FAVORITE") side = "FAVORITE";
  else if (rawSide === "OVER") side = "OVER";
  else if (rawSide === "UNDER") side = "UNDER";
  else if (rawSide === "YES") side = "YES";
  else if (rawSide === "NO") side = "NO";
  else if (rawSide.includes("OVER")) side = "OVER";
  else if (rawSide.includes("UNDER")) side = "UNDER";
  else if (rawSide.includes("HOME")) side = "HOME";
  else if (rawSide.includes("AWAY")) side = "AWAY";
  else if (raw.line !== undefined && raw.line !== null) {
    const l = parseFloat(String(raw.line));
    side = l < 0 ? "FAVORITE" : "UNDERDOG";
  }

  const lineHundredths = parseLineHundredths(raw.line);

  return {
    gameId,
    period,
    subject,
    marketKind,
    side,
    lineHundredths,
    productClass: (raw.productClass as ProductClass) ?? "unknown",
  };
}

/**
 * Maps a raw `customer/report/report.js` (`api/Report/Pending` or `api/Report/getGrading`) row
 * directly into a `CanonicalLeg` using `ChosenTeamID`, `Team1RotNum`/`Team2RotNum`,
 * `AdjSpread`, `AdjTotalPoints`, `TotalPointsOU`, and `TeaserPoints` without regex guesswork.
 *
 * Returns `null` for non-sports rows (`WagerType === "C"` Casino, `"A"` Manual Action).
 */
export function mapF402ReportLeg(
  raw: F402CustomerReportPendingRow,
): CanonicalLeg | null {
  const wt = (raw.WagerType ?? "S").trim().toUpperCase();
  if (wt === "C" || wt === "A") {
    return null; // Skip Casino & Manual Action rows per getTypeInfo
  }

  const placedOrWriter =
    `${raw.PlacedOn ?? ""} ${raw.TicketWriter ?? ""}`.toUpperCase();
  const isLiveWager =
    wt === "G" ||
    placedOrWriter.includes("LIVEBETTINGCWS") ||
    placedOrWriter.includes("EZL - INTERNET") ||
    placedOrWriter.includes("GSLIVE");

  const rotInfo = extractF402RotationNumber(raw);
  const chosenSubject = normalizeCanonicalSubject(
    raw.ChosenTeamID ?? raw.Team1ID ?? "GAME",
  );

  const sportPrefix = (raw.SportType ?? "").trim().toUpperCase();
  let gameId: string;
  if (sportPrefix && raw.ChosenTeamID) {
    gameId = deriveGameIdentifier(sportPrefix, chosenSubject);
  } else if (raw.GameDateTime && rotInfo.canonicalRotNum !== null) {
    gameId = `${raw.GameDateTime.slice(0, 10)}:${rotInfo.canonicalRotNum}`;
  } else if (rotInfo.canonicalRotNum !== null) {
    gameId = `ROT:${rotInfo.canonicalRotNum}`;
  } else {
    gameId = deriveGameIdentifier(sportPrefix || "SPORTS", chosenSubject);
  }

  const period: CanonicalPeriod = isLiveWager
    ? "live"
    : normalizeCanonicalPeriod(raw.PeriodNumber);

  const lineCalc = computeF402EffectiveLine(raw);

  let productClass: ProductClass = "straight";
  if (wt === "T" || lineCalc.teaserPoints !== 0) {
    productClass = "teaser";
  } else if (wt === "P") {
    productClass = "parlay";
  } else if (wt === "I") {
    productClass = "if_bet";
  } else if (isLiveWager) {
    productClass = "live";
  }

  return {
    gameId,
    period,
    subject: chosenSubject,
    marketKind: lineCalc.marketKind,
    side: lineCalc.side,
    lineHundredths: lineCalc.effectiveLineHundredths,
    productClass,
    rotationNumber: rotInfo.canonicalRotNum,
    rawLineHundredths: parseLineHundredths(lineCalc.rawLine),
    teaserPointsHundredths: parseLineHundredths(lineCalc.teaserPoints),
  };
}

export interface GroupedF402ParentTicket {
  readonly ticketGroupKey: string; // `${TicketNumber}-${WagerNumber}`
  readonly ticketNumber: string;
  readonly wagerNumber: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly wagerType: string;
  readonly riskCents: number;
  readonly toWinCents: number;
  readonly legs: readonly CanonicalLeg[];
  readonly hashes: ComboIdentityHashes;
}

/**
 * Groups flat leg rows from `api/Report/Pending` (`e.Pending`) or `api/Report/getGrading`
 * by `var m = d.TicketNumber + "-" + d.WagerNumber` BEFORE computing `computeComboIdentityHashes()`,
 * preventing multi-leg parlays and teasers from being hashed as isolated 1-leg tickets.
 */
export function groupF402PendingRowsByTicket(
  rows: readonly F402CustomerReportPendingRow[],
): GroupedF402ParentTicket[] {
  const buckets = new Map<
    string,
    {
      firstRow: F402CustomerReportPendingRow;
      legs: CanonicalLeg[];
    }
  >();

  for (const row of rows) {
    const mapped = mapF402ReportLeg(row);
    if (!mapped) continue;

    const key = getF402TicketGroupKey(row);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { firstRow: row, legs: [] };
      buckets.set(key, bucket);
    }
    bucket.legs.push(mapped);
  }

  const results: GroupedF402ParentTicket[] = [];
  for (const [key, bucket] of buckets.entries()) {
    const r = bucket.firstRow;
    const isMultiLeg = bucket.legs.length > 1;
    const normalizedLegs: CanonicalLeg[] = bucket.legs.map((leg) => {
      if (isMultiLeg && leg.productClass === "straight") {
        return { ...leg, productClass: "parlay" };
      }
      return leg;
    });

    const hashes = computeComboIdentityHashes(normalizedLegs);
    results.push({
      ticketGroupKey: key,
      ticketNumber: String(r.TicketNumber).trim(),
      wagerNumber: String(r.WagerNumber).trim(),
      customerId: (r.CustomerID ?? r.Login ?? "UNKNOWN").trim().toUpperCase(),
      agentId: (r.AgentID ?? "UNKNOWN").trim().toUpperCase(),
      wagerType: (r.WagerType ?? (isMultiLeg ? "P" : "S")).trim().toUpperCase(),
      riskCents: Math.round(Number(r.AmountWagered ?? 0)),
      toWinCents: Math.round(Number(r.ToWinAmount ?? 0)),
      legs: normalizedLegs,
      hashes,
    });
  }

  return results;
}

/**
 * Maps Fantasy402 ticket leg row to CanonicalLeg.
 * Supports both the Rosetta Stone `customer/report/report.js` JSON fields (`AdjSpread`, `AdjTotalPoints`,
 * `TotalPointsOU`, `TeaserPoints`, `ChosenTeamID`, `Team1RotNum`, `Team2RotNum`) and legacy `shortDesc` fixtures.
 */
export function mapF402Leg(raw: F402RawTicketLeg): CanonicalLeg {
  const hasRosettaFields =
    raw.AdjSpread !== undefined ||
    raw.AdjTotalPoints !== undefined ||
    raw.TotalPointsOU !== undefined ||
    raw.ChosenTeamID !== undefined ||
    raw.TeaserPoints !== undefined;

  if (hasRosettaFields) {
    const mapped = mapF402ReportLeg({
      TicketNumber: raw.ticketNumber,
      WagerNumber: raw.wagerNumber,
      CustomerID: raw.customerId,
      AgentID: raw.agentId,
      AmountWagered: raw.riskCents ?? 10000,
      ToWinAmount: raw.winCents ?? 10000,
      WagerType: raw.WagerType ?? "S",
      GameDateTime: raw.GameDateTime,
      SportType: raw.sportType,
      PeriodNumber: raw.period,
      Team1ID: raw.Team1ID,
      Team2ID: raw.Team2ID,
      ChosenTeamID: raw.ChosenTeamID ?? raw.team ?? raw.shortName,
      Team1RotNum: raw.Team1RotNum,
      Team2RotNum: raw.Team2RotNum,
      AdjSpread: raw.AdjSpread ?? (raw.TotalPointsOU ? null : raw.line),
      AdjTotalPoints:
        raw.AdjTotalPoints ?? (raw.TotalPointsOU ? raw.line : null),
      TotalPointsOU: raw.TotalPointsOU ?? null,
      TeaserPoints: raw.TeaserPoints ?? null,
      PlacedOn: raw.PlacedOn,
      TicketWriter: raw.TicketWriter,
    });
    if (mapped) return mapped;
  }

  const sport = (raw.sportType ?? "SPORTS").trim().toUpperCase();
  const subject = normalizeCanonicalSubject(
    raw.ChosenTeamID ?? raw.shortName ?? raw.team,
  );
  const gameId = deriveGameIdentifier(sport, subject);
  const period = normalizeCanonicalPeriod(raw.period);

  const desc = (raw.shortDesc ?? "").trim().toUpperCase();
  const descTypeChar = desc.charAt(0);

  let marketKind: MarketKind = "spread";
  let productClass: ProductClass = "straight";

  if (descTypeChar === "P") {
    productClass = "parlay";
  } else if (descTypeChar === "T") {
    productClass = "teaser";
    marketKind = "teaser";
  } else if (descTypeChar === "C") {
    productClass = "sgp";
  } else if (descTypeChar === "G") {
    productClass = "live";
  }

  if (desc.includes("TEAM TOTAL") || desc.includes("TT ")) {
    marketKind = "team_total";
  } else if (
    desc.includes("OVER") ||
    desc.includes("UNDER") ||
    desc.includes("TOT")
  ) {
    marketKind = "total";
  } else if (desc.includes("ML") || desc.includes("MONEYLINE")) {
    marketKind = "moneyline";
  } else if (
    desc.includes("PROP") ||
    desc.includes("PTS") ||
    desc.includes("REB") ||
    desc.includes("AST") ||
    desc.includes("YDS")
  ) {
    marketKind = "prop";
  }

  let side: MarketSide = "UNKNOWN";
  if (desc.includes("OVER")) side = "OVER";
  else if (desc.includes("UNDER")) side = "UNDER";
  else if (raw.line !== undefined && raw.line !== null) {
    const l = parseFloat(String(raw.line));
    side = l < 0 ? "FAVORITE" : "UNDERDOG";
  }

  const lineHundredths = parseLineHundredths(raw.line);

  return {
    gameId,
    period,
    subject,
    marketKind,
    side,
    lineHundredths,
    productClass,
  };
}
