/**
 * Parse Manager `getInfoPlayer` responses (`{ INFO: { data, balance, … } }`).
 * Response bodies may include credentials-adjacent fields; use {@link redactGetInfoPlayer}
 * before logging or writing scratch artifacts.
 */

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
  readonly inetTarget: string | null;
  readonly allowEzLive: string | null;
  readonly activateBettingAlerts: string | null;
  readonly notifyTelegram: string | null;
  readonly assignedParlayName: string | null;
  readonly parlaySpecCount: number;
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
    wiseLineMovementWeight:
      typeof data.WiseLineMovementWeight === "number"
        ? data.WiseLineMovementWeight
        : null,
    inetTarget:
      typeof data.InetTarget === "string"
        ? trimPaddedId(data.InetTarget) || null
        : null,
    allowEzLive: typeof data.AllowEZLive === "string" ? data.AllowEZLive : null,
    activateBettingAlerts:
      typeof data.ActivateBettingAlerts === "string"
        ? data.ActivateBettingAlerts
        : null,
    notifyTelegram:
      typeof added?.NotifyTelegram === "string" ? added.NotifyTelegram : null,
    assignedParlayName: trimPaddedId(data.ParlayName) || null,
    parlaySpecCount: parlaySpecs?.length ?? 0,
  };
}

export type PlayerRiskPostureFlag =
  | "BETTING_ALERTS_DISABLED"
  | "LINE_MOVER_WEIGHT_ACTIVE"
  | "LIVE_INPLAY_RESTRICTED"
  | "HALF_POINT_BUY_RESTRICTED"
  | "HAS_PENDING_WAGERS"
  | "CARRYOVER_PREVIOUS_BALANCE_MISMATCH";

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
  const isLineMover =
    summary.wiseLineMovementWeight !== null &&
    summary.wiseLineMovementWeight > 0;
  if (isLineMover) {
    riskFlags.push("LINE_MOVER_WEIGHT_ACTIVE");
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

  // Source: getInfoPlayer wire fields `INFO.data.HalfPointInetBasketballFlag === "N"` / `HalfPointInetFootballFlag === "N"` (capture 2026-11-13)
  if (
    data.HalfPointInetBasketballFlag === "N" ||
    data.HalfPointInetFootballFlag === "N"
  ) {
    riskFlags.push("HALF_POINT_BUY_RESTRICTED");
  }

  // descriptive posture flag, not an anomaly signal — Source: `INFO.data.PendingWagerCount > 0` or `INFO.data.PendingWagerBalance > 0` (capture 2026-11-13)
  if (
    (summary.pendingWagerCount ?? 0) > 0 ||
    (summary.pendingWagerBalance ?? 0) > 0
  ) {
    riskFlags.push("HAS_PENDING_WAGERS");
  }

  return {
    customerId: summary.customerId,
    agentId: summary.agentId,
    creditEquationBalanced,
    expectedAvailableBalanceCents,
    creditEquationDeltaCents,
    carryOverParityMatched,
    carryOverParityDeltaCents,
    riskFlags,
  };
}
