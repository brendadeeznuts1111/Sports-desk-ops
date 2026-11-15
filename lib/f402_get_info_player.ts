/**
 * Parse Manager `getInfoPlayer` responses (`{ INFO: { data, balance, … } }`).
 * Response bodies may include credentials-adjacent fields; use {@link redactGetInfoPlayer}
 * before logging or writing scratch artifacts.
 */

import { CUSTOMER_TO_POLY_WALLET } from "./parlay_combo_backtest_engine.ts";

export interface ParlaySpecRow {
  readonly ParlayName?: string;
  readonly MaxPicks?: number;
  readonly DefaultPrice?: number;
  readonly ParlayDescription?: string | null;
  readonly ParlayDisplayName?: string | null;
}

export interface GetInfoPlayerData {
  readonly CustomerID?: string;
  readonly Login?: string;
  readonly AgentID?: string;
  readonly AgentLogin?: string;
  readonly AgentType?: string | null;
  readonly Active?: string;
  readonly Status?: string;
  readonly NameFirst?: string | null;
  readonly NameLast?: string | null;
  readonly CreditLimit?: number;
  readonly CurrentBalance?: number;
  readonly PendingWagerBalance?: number;
  readonly PendingWagerCount?: number;
  readonly CarryOverAmount?: number;
  readonly SettleFigure?: number;
  readonly WagerLimit?: number;
  readonly TeaserLimit?: number;
  readonly ContestLimit?: number;
  readonly ParlayTeamMaxWager?: number;
  readonly maxparlaypayout?: number;
  readonly ConfirmationDelay?: number;
  readonly WiseLineMovementWeight?: number;
  readonly InetTarget?: string;
  readonly AllowEZLive?: string;
  readonly AllowNewLiveBetting?: string;
  readonly AllowUltraLive?: string;
  readonly AllowBuyPointsExtraGames?: string;
  readonly HalfPointInetBasketballFlag?: string;
  readonly HalfPointInetFootballFlag?: string;
  readonly ActivateBettingAlerts?: string;
  readonly EnforceAccumWagerLimitsFlag?: string;
  readonly ParlayName?: string;
  readonly Currency?: string;
  readonly SuspectedBot?: string;
  readonly SuspectedBotType?: number;
  readonly BasketballFlatPrice?: number;
  readonly FootballFlatPrice?: number;
  readonly VigDiscountPercent?: number;
  readonly EncryptPassword?: string;
  readonly Password?: string;
  readonly Passwordt?: string;
  readonly [key: string]: unknown;
}

export interface GetInfoPlayerEnvelope {
  readonly INFO: {
    readonly data: GetInfoPlayerData;
    readonly balance?: { readonly AvailableBalance?: number };
    readonly totalNonPostedCasino?: { readonly TotalAmount?: number | null };
    readonly added?: {
      readonly CustomerID?: string;
      readonly RebatePercent?: number;
      readonly RebateAmount?: number;
      readonly NotifyTelegram?: string;
      readonly MaxAmountNotifyTelegram?: number;
      readonly ParlayBuyout?: string;
      readonly ParlayBuyoutAmount?: number;
      readonly [key: string]: unknown;
    };
    readonly thisWeek?:
      | boolean
      | {
          readonly PreviousBalance?: number | string | null;
          readonly [key: string]: unknown;
        };
    readonly parlaySpecs?: ParlaySpecRow[];
  };
}

const SENSITIVE_INFO_DATA_KEYS = new Set([
  // credentials
  "Password",
  "Passwordt",
  "EncryptTempPassExpiredDate",
  // customer PII / free text
  "NameFirst",
  "NameLast",
  "NameMI",
  "HomePhone",
  "BusinessPhone",
  "Fax",
  "SMSPhoneNumber",
  "email",
  "address",
  "city",
  "state",
  "PlayerNotes",
  "CommentsForCustomer",
  "CommentsForTW",
  "TickerMessage",
  "ImportantMessage",
  "TelegramID",
]);

const SENSITIVE_INFO_ADDED_KEYS = new Set(["TelegramID"]);

export function trimPaddedId(raw: string | undefined): string {
  return (raw ?? "").trim();
}

export function parseGetInfoPlayerEnvelope(
  raw: unknown,
): GetInfoPlayerEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error("getInfoPlayer envelope must be an object");
  const info = (raw as { INFO?: unknown }).INFO;
  if (typeof info !== "object" || info === null)
    throw new Error("INFO must be an object");
  const data = (info as { data?: unknown }).data;
  if (typeof data !== "object" || data === null)
    throw new Error("INFO.data must be an object");
  const parlaySpecs = (info as { parlaySpecs?: unknown }).parlaySpecs;
  if (
    parlaySpecs !== undefined &&
    parlaySpecs !== null &&
    !Array.isArray(parlaySpecs)
  ) {
    throw new Error("INFO.parlaySpecs must be an array when present");
  }
  return raw as GetInfoPlayerEnvelope;
}

export type GetInfoPlayerProbe =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly envelope: GetInfoPlayerEnvelope;
      readonly summary: GetInfoPlayerSummary;
    };

/**
 * The UI treats `INFO: null` as "player not found" (`player-info.js`, the
 * `#not-account-load` modal). This wrapper is the probe classifier; it does not throw on a
 * legitimate absence.
 */
export function parseGetInfoPlayerProbe(raw: unknown): GetInfoPlayerProbe {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("getInfoPlayer response must be an object");
  }
  const info = (raw as { INFO?: unknown }).INFO;
  if (info === null) return { found: false };
  const envelope = parseGetInfoPlayerEnvelope(raw);
  return {
    found: true,
    envelope,
    summary: summarizeGetInfoPlayer(envelope),
  };
}

// test-fixture helper; not used in production paths
/** Strip password and PII/free-text fields from a parsed envelope (shallow copy). */
export function redactGetInfoPlayer(
  envelope: GetInfoPlayerEnvelope,
): GetInfoPlayerEnvelope {
  const data: Record<string, unknown> = { ...envelope.INFO.data };
  for (const key of SENSITIVE_INFO_DATA_KEYS) {
    if (key in data) data[key] = "<redacted>";
  }
  const sourceAdded = envelope.INFO.added;
  const added: Record<string, unknown> | undefined =
    sourceAdded === undefined ? undefined : { ...sourceAdded };
  if (added !== undefined) {
    for (const key of SENSITIVE_INFO_ADDED_KEYS) {
      if (key in added) added[key] = "<redacted>";
    }
  }
  return {
    INFO: {
      ...envelope.INFO,
      data,
      ...(added === undefined ? {} : { added }),
    },
  };
}

export interface GetInfoPlayerSummary {
  readonly customerId: string;
  readonly login: string;
  readonly agentId: string;
  readonly agentLogin: string | null;
  readonly status: string | null;
  readonly agentType: string | null;
  readonly active: string | null;
  readonly creditLimit: number | null;
  readonly currentBalance: number | null;
  readonly pendingWagerBalance: number | null;
  readonly availableBalance: number | null;
  readonly carryOverAmount: number | null;
  readonly previousBalanceUsd: number | null;
  readonly settleFigureUsd: number | null;
  readonly wagerLimit: number | null;
  readonly pendingWagerCount: number | null;
  readonly confirmationDelaySec: number | null;
  readonly wiseLineMovementWeight: number | null;
  readonly lineMoverWeightTier:
    "ZEROED" | "DEFAULT_BASELINE_1" | "ELEVATED_SHARP" | "UNKNOWN";
  readonly inetTarget: string | null;
  readonly allowEzLive: string | null;
  readonly allowNewLiveBetting: string | null;
  readonly allowUltraLive: string | null;
  readonly allowBuyPointsExtraGames: string | null;
  readonly halfPointInetFootballFlag: string | null;
  readonly halfPointInetBasketballFlag: string | null;
  readonly activateBettingAlerts: string | null;
  readonly notifyTelegram: string | null;
  readonly assignedParlayName: string | null;
  readonly parlaySpecCount: number;
  readonly suspectedBot: string | null;
  readonly suspectedBotType: number | null;
  readonly footballFlatPrice: number | null;
  readonly basketballFlatPrice: number | null;
  readonly vigDiscountPercent: number | null;
  readonly encryptPassword: string | null;
  readonly plaintextPasswordExposed: boolean;
  readonly mappedProxyWallet: string | null;
}

export function summarizeGetInfoPlayer(
  envelope: GetInfoPlayerEnvelope,
): GetInfoPlayerSummary {
  const { data, balance, added, thisWeek, parlaySpecs } = envelope.INFO;
  const customerId =
    trimPaddedId(added?.CustomerID) || trimPaddedId(data.Login) || "";
  // server returns whole USD as number; see capture 2026-11-13 (also coerces formatted strings like "79325.00" or "79,325")
  const rawPrevBal =
    typeof thisWeek === "object" && thisWeek !== null
      ? thisWeek.PreviousBalance
      : null;
  const parsedPrevBal =
    typeof rawPrevBal === "number"
      ? rawPrevBal
      : typeof rawPrevBal === "string" && rawPrevBal.trim().length > 0
        ? Number(rawPrevBal.replaceAll(",", "").trim())
        : Number.NaN;
  const previousBalanceUsd = Number.isFinite(parsedPrevBal)
    ? parsedPrevBal
    : null;
  const wiseWeight =
    typeof data.WiseLineMovementWeight === "number"
      ? data.WiseLineMovementWeight
      : null;
  const lineMoverWeightTier: GetInfoPlayerSummary["lineMoverWeightTier"] =
    wiseWeight === null
      ? "UNKNOWN"
      : wiseWeight <= 0
        ? "ZEROED"
        : wiseWeight === 1
          ? "DEFAULT_BASELINE_1"
          : "ELEVATED_SHARP";
  return {
    customerId,
    login: trimPaddedId(data.Login),
    agentId:
      trimPaddedId(data.AgentID) ||
      trimPaddedId(data.AgentLogin) ||
      trimPaddedId(added?.CustomerID),
    agentLogin: trimPaddedId(data.AgentLogin) || null,
    status: data.Status ?? data.Active ?? null,
    agentType: data.AgentType ?? null,
    active: data.Active ?? null,
    creditLimit: typeof data.CreditLimit === "number" ? data.CreditLimit : null,
    currentBalance:
      typeof data.CurrentBalance === "number" ? data.CurrentBalance : null,
    pendingWagerBalance:
      typeof data.PendingWagerBalance === "number"
        ? data.PendingWagerBalance
        : null,
    availableBalance:
      typeof balance?.AvailableBalance === "number"
        ? balance.AvailableBalance
        : null,
    carryOverAmount:
      typeof data.CarryOverAmount === "number" ? data.CarryOverAmount : null,
    previousBalanceUsd,
    settleFigureUsd:
      typeof data.SettleFigure === "number" ? data.SettleFigure : null,
    wagerLimit: typeof data.WagerLimit === "number" ? data.WagerLimit : null,
    pendingWagerCount:
      typeof data.PendingWagerCount === "number"
        ? data.PendingWagerCount
        : null,
    confirmationDelaySec:
      typeof data.ConfirmationDelay === "number"
        ? data.ConfirmationDelay
        : null,
    wiseLineMovementWeight: wiseWeight,
    lineMoverWeightTier,
    inetTarget:
      typeof data.InetTarget === "string"
        ? trimPaddedId(data.InetTarget) || null
        : null,
    allowEzLive: typeof data.AllowEZLive === "string" ? data.AllowEZLive : null,
    allowNewLiveBetting:
      typeof data.AllowNewLiveBetting === "string"
        ? data.AllowNewLiveBetting
        : null,
    allowUltraLive:
      typeof data.AllowUltraLive === "string" ? data.AllowUltraLive : null,
    allowBuyPointsExtraGames:
      typeof data.AllowBuyPointsExtraGames === "string"
        ? data.AllowBuyPointsExtraGames
        : null,
    halfPointInetFootballFlag:
      typeof data.HalfPointInetFootballFlag === "string"
        ? data.HalfPointInetFootballFlag
        : null,
    halfPointInetBasketballFlag:
      typeof data.HalfPointInetBasketballFlag === "string"
        ? data.HalfPointInetBasketballFlag
        : null,
    activateBettingAlerts:
      typeof data.ActivateBettingAlerts === "string"
        ? data.ActivateBettingAlerts
        : null,
    notifyTelegram:
      typeof added?.NotifyTelegram === "string" ? added.NotifyTelegram : null,
    assignedParlayName: trimPaddedId(data.ParlayName) || null,
    parlaySpecCount: parlaySpecs?.length ?? 0,
    suspectedBot:
      typeof data.SuspectedBot === "string" ? data.SuspectedBot : null,
    suspectedBotType:
      typeof data.SuspectedBotType === "number" ? data.SuspectedBotType : null,
    footballFlatPrice:
      typeof data.FootballFlatPrice === "number"
        ? data.FootballFlatPrice
        : null,
    basketballFlatPrice:
      typeof data.BasketballFlatPrice === "number"
        ? data.BasketballFlatPrice
        : null,
    vigDiscountPercent:
      typeof data.VigDiscountPercent === "number"
        ? data.VigDiscountPercent
        : null,
    encryptPassword:
      typeof data.EncryptPassword === "string" ? data.EncryptPassword : null,
    plaintextPasswordExposed:
      data.EncryptPassword === "N" ||
      (typeof data.Password === "string" &&
        data.Password.trim().length > 0 &&
        data.Password !== "<redacted>") ||
      (typeof data.Passwordt === "string" &&
        data.Passwordt.trim().length > 0 &&
        data.Passwordt !== "<redacted>"),
    mappedProxyWallet:
      CUSTOMER_TO_POLY_WALLET[trimPaddedId(data.Login)] ??
      CUSTOMER_TO_POLY_WALLET[customerId] ??
      null,
  };
}

export type PlayerRiskPostureFlag =
  | "BETTING_ALERTS_DISABLED"
  | "LINE_MOVER_WEIGHT_ACTIVE"
  | "ELEVATED_LINE_MOVER_WEIGHT"
  | "LIVE_INPLAY_RESTRICTED"
  | "HALF_POINT_BUY_RESTRICTED"
  | "HAS_PENDING_WAGERS"
  | "CARRYOVER_PREVIOUS_BALANCE_MISMATCH"
  | "PLAINTEXT_CREDENTIAL_EXPOSURE"
  | "CONTRACTUAL_FLAT_PRICE_ACTIVE"
  | "SUSPECTED_BOT_FLAGGED"
  | "HIGH_CONFIRMATION_DELAY_CLAMP"
  | "MAPPED_POLY_SYNDICATE_WALLET";

export interface PlayerRiskPostureAudit {
  readonly customerId: string;
  readonly agentId: string;
  /** True when `CreditLimit + CurrentBalance - PendingWagerBalance === AvailableBalance`. */
  readonly creditEquationBalanced: boolean;
  /** Computed `CreditLimit + CurrentBalance - PendingWagerBalance` in cents, or `null` if inputs missing. */
  readonly expectedAvailableBalanceCents: number | null;
  /** `AvailableBalance - expectedAvailableBalanceCents` in cents (`0` when balanced). */
  readonly creditEquationDeltaCents: number | null;
  /** True when `CarryOverAmount === thisWeek.PreviousBalance * 100`. */
  readonly carryOverParityMatched: boolean;
  /** `CarryOverAmount - (thisWeek.PreviousBalance * 100)` in cents (`0` when matched). */
  readonly carryOverParityDeltaCents: number | null;
  /** Disambiguates DGS default `WiseLineMovementWeight = 1` from elevated sharp weights (`> 1`). */
  readonly lineMoverWeightTier:
    "ZEROED" | "DEFAULT_BASELINE_1" | "ELEVATED_SHARP" | "UNKNOWN";
  /** Disambiguates legacy `AllowEZLive = N` / `AllowNewLiveBetting = N` from active `AllowUltraLive = Y`. */
  readonly effectiveLiveBettingStatus:
    | "ULTRA_LIVE_ENABLED_EZLIVE_OFF"
    | "ALL_LIVE_ENGINES_DISABLED"
    | "LIVE_ENABLED";
  /** Disambiguates custom DOW schedule flags (`HalfPointInet...Flag = N`) from standard `AllowBuyPointsExtraGames = Y`. */
  readonly effectivePointBuyingStatus:
    "EXTRA_GAMES_BUY_ENABLED_DOW_SCHEDULE_OFF" | "DOW_SCHEDULE_OFF" | "ENABLED";
  readonly riskFlags: readonly PlayerRiskPostureFlag[];
}

/**
 * Audits a parsed `getInfoPlayer` envelope for:
 * 1. Credit-line accounting identity (`CreditLimit + CurrentBalance - PendingWagerBalance === AvailableBalance`),
 * 2. Unit parity between `INFO.data.CarryOverAmount` (cents) and `INFO.thisWeek.PreviousBalance` (whole USD),
 * 3. Direct boolean re-expressions of observed `getInfoPlayer` wire flags (no invented dollar thresholds).
 */
export function auditPlayerRiskPosture(
  envelope: GetInfoPlayerEnvelope,
): PlayerRiskPostureAudit {
  const summary = summarizeGetInfoPlayer(envelope);
  const { data } = envelope.INFO;

  const hasCreditInputs =
    summary.creditLimit !== null &&
    summary.currentBalance !== null &&
    summary.pendingWagerBalance !== null &&
    summary.availableBalance !== null;
  // holds when CurrentBalance <= 0 and PendingWagerBalance >= 0; other sign combos unsupported
  const expectedAvailableBalanceCents = hasCreditInputs
    ? summary.creditLimit! +
      summary.currentBalance! -
      summary.pendingWagerBalance!
    : null;
  const creditEquationDeltaCents =
    expectedAvailableBalanceCents !== null && summary.availableBalance !== null
      ? summary.availableBalance - expectedAvailableBalanceCents
      : null;
  const creditEquationBalanced = creditEquationDeltaCents === 0;

  // server returns whole USD as number in INFO.thisWeek.PreviousBalance and cents in INFO.data.CarryOverAmount; see capture 2026-11-13
  const hasCarryOverInputs =
    summary.carryOverAmount !== null && summary.previousBalanceUsd !== null;
  const carryOverParityDeltaCents = hasCarryOverInputs
    ? summary.carryOverAmount! - Math.round(summary.previousBalanceUsd! * 100)
    : null;
  const carryOverParityMatched = carryOverParityDeltaCents === 0;

  const riskFlags: PlayerRiskPostureFlag[] = [];
  if (hasCarryOverInputs && !carryOverParityMatched) {
    riskFlags.push("CARRYOVER_PREVIOUS_BALANCE_MISMATCH");
  }

  // Source: getInfoPlayer wire field `INFO.data.WiseLineMovementWeight` (observed `1` on capture 2026-11-13)
  // Note: `1` is the DGS factory default across standard accounts; `> 1` is an elevated sharp weight.
  const isLineMover =
    summary.wiseLineMovementWeight !== null &&
    summary.wiseLineMovementWeight > 0;
  if (isLineMover) {
    riskFlags.push("LINE_MOVER_WEIGHT_ACTIVE");
  }
  if (
    summary.wiseLineMovementWeight !== null &&
    summary.wiseLineMovementWeight > 1
  ) {
    riskFlags.push("ELEVATED_LINE_MOVER_WEIGHT");
  }

  // descriptive posture flag, not an anomaly signal — Source: `INFO.data.ActivateBettingAlerts === "N"` and `INFO.added.NotifyTelegram === "N"` (capture 2026-11-13)
  const alertsDisabled =
    summary.activateBettingAlerts === "N" &&
    (summary.notifyTelegram === "N" || summary.notifyTelegram === null);
  if (alertsDisabled) {
    riskFlags.push("BETTING_ALERTS_DISABLED");
  }

  // Source: getInfoPlayer wire fields `INFO.data.AllowEZLive === "N"` and `INFO.data.AllowNewLiveBetting === "N"` (capture 2026-11-13)
  if (data.AllowEZLive === "N" && data.AllowNewLiveBetting === "N") {
    riskFlags.push("LIVE_INPLAY_RESTRICTED");
  }
  const effectiveLiveBettingStatus: PlayerRiskPostureAudit["effectiveLiveBettingStatus"] =
    data.AllowEZLive === "N" && data.AllowNewLiveBetting === "N"
      ? data.AllowUltraLive === "Y"
        ? "ULTRA_LIVE_ENABLED_EZLIVE_OFF"
        : "ALL_LIVE_ENGINES_DISABLED"
      : "LIVE_ENABLED";

  // Source: getInfoPlayer wire fields `INFO.data.HalfPointInetBasketballFlag === "N"` / `HalfPointInetFootballFlag === "N"` (capture 2026-11-13)
  if (
    data.HalfPointInetBasketballFlag === "N" ||
    data.HalfPointInetFootballFlag === "N"
  ) {
    riskFlags.push("HALF_POINT_BUY_RESTRICTED");
  }
  const effectivePointBuyingStatus: PlayerRiskPostureAudit["effectivePointBuyingStatus"] =
    data.HalfPointInetBasketballFlag === "N" ||
    data.HalfPointInetFootballFlag === "N"
      ? data.AllowBuyPointsExtraGames === "Y"
        ? "EXTRA_GAMES_BUY_ENABLED_DOW_SCHEDULE_OFF"
        : "DOW_SCHEDULE_OFF"
      : "ENABLED";

  // descriptive posture flag, not an anomaly signal — Source: `INFO.data.PendingWagerCount > 0` or `INFO.data.PendingWagerBalance > 0` (capture 2026-11-13)
  if (
    (summary.pendingWagerCount ?? 0) > 0 ||
    (summary.pendingWagerBalance ?? 0) > 0
  ) {
    riskFlags.push("HAS_PENDING_WAGERS");
  }

  // Security posture: unencrypted or plaintext credentials returned on wire (capture 2026-11-14)
  if (data.EncryptPassword === "N" || summary.plaintextPasswordExposed) {
    riskFlags.push("PLAINTEXT_CREDENTIAL_EXPOSURE");
  }

  // Fixed/flat pricing contract overrides dynamic line movement (capture 2026-11-14)
  if (
    (typeof data.BasketballFlatPrice === "number" &&
      data.BasketballFlatPrice !== 0) ||
    (typeof data.FootballFlatPrice === "number" && data.FootballFlatPrice !== 0)
  ) {
    riskFlags.push("CONTRACTUAL_FLAT_PRICE_ACTIVE");
  }

  // Explicit DGS bot tagging (capture 2026-11-14)
  if (data.SuspectedBot === "Y") {
    riskFlags.push("SUSPECTED_BOT_FLAGGED");
  }

  // Clamp on order submission confirmation delay exceeding standard default (capture 2026-11-14)
  if (
    typeof data.ConfirmationDelay === "number" &&
    data.ConfirmationDelay > 5
  ) {
    riskFlags.push("HIGH_CONFIRMATION_DELAY_CLAMP");
  }

  // Cross-venue surveillance: account mapped to an on-chain Polymarket proxy wallet
  if (summary.mappedProxyWallet !== null) {
    riskFlags.push("MAPPED_POLY_SYNDICATE_WALLET");
  }

  return {
    customerId: summary.customerId,
    agentId: summary.agentId,
    creditEquationBalanced,
    expectedAvailableBalanceCents,
    creditEquationDeltaCents,
    carryOverParityMatched,
    carryOverParityDeltaCents,
    lineMoverWeightTier: summary.lineMoverWeightTier,
    effectiveLiveBettingStatus,
    effectivePointBuyingStatus,
    riskFlags,
  };
}

function formatCentsToUsd(cents: number | null): string {
  if (cents === null) return "N/A";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUsd(usd: number | null): string {
  if (usd === null) return "N/A";
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface DecisionInstrumentReportOverlay {
  readonly decisionTier: string;
  readonly recommendedAction: string;
  readonly rankOverallSharp: number;
  readonly rankSystematicSignature: number;
  readonly totalBetsN: number;
  readonly powerStatus: string;
  readonly correctedUnionRateShrunkKappa20: number;
  readonly unionClvBhQValueAllCustomers: number;
  readonly estimatedNetEvAfterVigPct: number;
  readonly realizedPlayerNetUsd: number;
  readonly limitHeuristicScore: number;
  readonly costRatioThresholdTau: number;
  readonly systematicSignatureClass: string;
  readonly minDistinctTicketGapSeconds: number | null;
}

/** Formats an executive, PII-redacted inspection report for terminal/log output. */
export function formatPlayerRiskPostureReport(
  audit: PlayerRiskPostureAudit,
  summary: GetInfoPlayerSummary,
  decisionOverlay?: DecisionInstrumentReportOverlay | null,
): string {
  const lines: string[] = [
    "=".repeat(80),
    "                     F402 / DGS PLAYER PROFILE AUDIT REPORT",
    "=".repeat(80),
    `  Customer ID       : ${summary.customerId || "N/A"} (Login: ${summary.login || "N/A"})`,
    `  Agent ID          : ${summary.agentId || "N/A"}${summary.agentLogin ? ` (Agent Login: ${summary.agentLogin})` : ""}`,
    `  Account Status    : ${summary.status ?? "N/A"} (Active: ${summary.active ?? "N/A"})`,
    `  Target Domain     : ${summary.inetTarget ?? "N/A"}`,
    `  Assigned Parlay   : ${summary.assignedParlayName ?? "None"} (${summary.parlaySpecCount} specs)`,
    "-".repeat(80),
    "1. ACCOUNTING & BALANCE IDENTITIES",
    "-".repeat(80),
    `  Credit Limit      : ${formatCentsToUsd(summary.creditLimit)} (${summary.creditLimit?.toLocaleString() ?? "N/A"} cents)`,
    `  Current Balance   : ${formatCentsToUsd(summary.currentBalance)} (${summary.currentBalance?.toLocaleString() ?? "N/A"} cents)`,
    `  Pending Wagers    : ${formatCentsToUsd(summary.pendingWagerBalance)} (${summary.pendingWagerBalance?.toLocaleString() ?? "N/A"} cents across ${summary.pendingWagerCount ?? 0} bets)`,
    `  Available Balance : ${formatCentsToUsd(summary.availableBalance)} (${summary.availableBalance?.toLocaleString() ?? "N/A"} cents)`,
    `  -> Credit Identity: ${
      audit.expectedAvailableBalanceCents === null
        ? "INCOMPLETE [INPUTS MISSING]"
        : audit.creditEquationBalanced
          ? "BALANCED [OK]"
          : "UNBALANCED [ANOMALY]"
    } (Delta: ${formatCentsToUsd(audit.creditEquationDeltaCents)})`,
    "",
    `  CarryOver Amount  : ${formatCentsToUsd(summary.carryOverAmount)} (${summary.carryOverAmount?.toLocaleString() ?? "N/A"} cents)`,
    `  Previous Balance  : ${formatUsd(summary.previousBalanceUsd)} (from thisWeek)`,
    `  -> Carryover Parity: ${
      audit.carryOverParityDeltaCents === null
        ? "N/A [INPUTS MISSING]"
        : audit.carryOverParityMatched
          ? "MATCHED [OK]"
          : "MISMATCH [ANOMALY]"
    } (Delta: ${formatCentsToUsd(audit.carryOverParityDeltaCents)})`,
    `  Settle Figure     : ${formatUsd(summary.settleFigureUsd)}`,
    `  Wager Limit       : ${formatCentsToUsd(summary.wagerLimit)}`,
    "-".repeat(80),
    "2. RISK & SURVEILLANCE POSTURE",
    "-".repeat(80),
    `  Credential Wire Security : ${summary.plaintextPasswordExposed ? "EXPOSED [SECURITY WARNING: PLAINTEXT CREDENTIAL ON WIRE]" : "SECURE [MASKED/ENCRYPTED]"}`,
    `  Surveillance Proxy Wallet: ${summary.mappedProxyWallet ? `${summary.mappedProxyWallet} [FLAGGED: CROSS-VENUE SYNDICATE]` : "UNMAPPED [Standard Customer Account]"}`,
    `  Suspected Bot Flag       : ${summary.suspectedBot ?? "N"} (Type: ${summary.suspectedBotType ?? 0})`,
    `  Flat Pricing Contract    : ${summary.basketballFlatPrice || summary.footballFlatPrice ? `ACTIVE (BB: ${summary.basketballFlatPrice}, FB: ${summary.footballFlatPrice})` : "INACTIVE (0 / 0)"}`,
    `  Line Mover Weight        : ${summary.wiseLineMovementWeight ?? 0} [${audit.lineMoverWeightTier}]`,
    `  Confirmation Delay       : ${summary.confirmationDelaySec ?? 0}s`,
    `  Betting Alerts           : Alerts=${summary.activateBettingAlerts ?? "N"}, Telegram=${summary.notifyTelegram ?? "N"}`,
    `  In-Play / Live Betting   : EZLive=${summary.allowEzLive ?? "N"}, NewLive=${summary.allowNewLiveBetting ?? "N"}, UltraLive=${summary.allowUltraLive ?? "N/A"} [${audit.effectiveLiveBettingStatus}]`,
    `  Half-Point Buying        : ExtraGames=${summary.allowBuyPointsExtraGames ?? "N/A"}, FB_DOW=${summary.halfPointInetFootballFlag ?? "N/A"}, BB_DOW=${summary.halfPointInetBasketballFlag ?? "N/A"} [${audit.effectivePointBuyingStatus}]`,
    "-".repeat(80),
    `3. AUDIT FINDINGS (${audit.riskFlags.length} flags)`,
    "-".repeat(80),
  ];

  if (audit.riskFlags.length === 0) {
    lines.push("  [None] All standard baseline checks passed.");
  } else {
    for (const flag of audit.riskFlags) {
      let note = "";
      if (
        flag === "LINE_MOVER_WEIGHT_ACTIVE" &&
        audit.lineMoverWeightTier === "DEFAULT_BASELINE_1"
      ) {
        note =
          " (DGS baseline default weight=1; verify empirical CLV/EV before treating as sharp)";
      } else if (
        flag === "LIVE_INPLAY_RESTRICTED" &&
        audit.effectiveLiveBettingStatus === "ULTRA_LIVE_ENABLED_EZLIVE_OFF"
      ) {
        note =
          " (Legacy EZLive/NewLive=N, but UltraLive=Y in-play engine is enabled)";
      } else if (flag === "HALF_POINT_BUY_RESTRICTED") {
        note =
          " (Custom DOW schedule=N; standard half-point buying governed by AllowBuyPointsExtraGames)";
      }
      lines.push(`  - ${flag}${note}`);
    }
  }

  if (decisionOverlay) {
    lines.push(
      "-".repeat(80),
      "4. EMPIRICAL DECISION-INSTRUMENT TELEMETRY (v3.0.0)",
      "-".repeat(80),
      `  Decision Tier     : ${decisionOverlay.decisionTier}`,
      `  Recommended Action: ${decisionOverlay.recommendedAction}`,
      `  Sharp / Sys Ranks : #${decisionOverlay.rankOverallSharp} Sharp | #${decisionOverlay.rankSystematicSignature} Systematic`,
      `  Sample & Power    : n=${decisionOverlay.totalBetsN} (${decisionOverlay.powerStatus})`,
      `  Shrunk Union CLV  : ${(decisionOverlay.correctedUnionRateShrunkKappa20 * 100).toFixed(2)}% (BH FDR q=${decisionOverlay.unionClvBhQValueAllCustomers.toFixed(4)})`,
      `  Post-Vig Net EV   : ${decisionOverlay.estimatedNetEvAfterVigPct.toFixed(2)}% (Realized Player Net: ${formatUsd(decisionOverlay.realizedPlayerNetUsd)})`,
      `  Limit Score vs τ* : ${decisionOverlay.limitHeuristicScore.toFixed(4)} vs τ*=${decisionOverlay.costRatioThresholdTau.toFixed(4)}`,
      `  Systematic Class  : ${decisionOverlay.systematicSignatureClass} (Min Distinct-Ticket Gap: ${decisionOverlay.minDistinctTicketGapSeconds !== null ? `${decisionOverlay.minDistinctTicketGapSeconds.toFixed(3)}s` : "N/A"})`,
    );
  }

  lines.push("=".repeat(80));
  return lines.join("\n");
}
