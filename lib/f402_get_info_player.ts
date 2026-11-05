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
  readonly AgentType?: string;
  readonly Active?: string;
  readonly Status?: string;
  readonly NameFirst?: string;
  readonly NameLast?: string;
  readonly CreditLimit?: number;
  readonly CurrentBalance?: number;
  readonly PendingWagerBalance?: number;
  readonly PendingWagerCount?: number;
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
      readonly NotifyTelegram?: string;
      readonly [key: string]: unknown;
    };
    readonly thisWeek?: boolean;
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
  readonly availableBalance: number | null;
  readonly pendingWagerCount: number | null;
  readonly assignedParlayName: string | null;
  readonly parlaySpecCount: number;
}

export function summarizeGetInfoPlayer(
  envelope: GetInfoPlayerEnvelope,
): GetInfoPlayerSummary {
  const { data, balance, added, parlaySpecs } = envelope.INFO;
  const customerId =
    trimPaddedId(added?.CustomerID) || trimPaddedId(data.Login) || "";
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
    availableBalance:
      typeof balance?.AvailableBalance === "number"
        ? balance.AvailableBalance
        : null,
    pendingWagerCount:
      typeof data.PendingWagerCount === "number"
        ? data.PendingWagerCount
        : null,
    assignedParlayName: trimPaddedId(data.ParlayName) || null,
    parlaySpecCount: parlaySpecs?.length ?? 0,
  };
}
