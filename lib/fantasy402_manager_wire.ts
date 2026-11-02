/**
 * @file fantasy402_manager_wire.ts
 * @description Specification-Grade Fantasy402 Manager Wire Client & Mutation Engine (Bun v1.4+).
 *
 * Implements:
 *  1. Wire Invariants & Routing:
 *     - POST /cloud/api/Manager/updateByColumn with application/x-www-form-urlencoded
 *     - Strict PaddedCustomerId (11-char space-padded) on writes
 *     - Direct sub-agent scope enforcement (fails fast on master agent BILLY666)
 *     - Poisoned path guard (rejects options with 'path' field fail-fast)
 *  2. Result-Code Discrimination & Read-Back Verification:
 *     - Result: 1 (SUCCESS) -> read-back against POST /cloud/api/Manager/getInfoPlayer
 *     - Result: 0 (FAILURE) -> SILENT_NO_OP
 *     - Result: -1 (REJECTED_SCOPE) -> REJECTED
 *  3. Vig Setup Engine:
 *     - POST /cloud/api/Manager/vigSetupInsert (application/json, 20-char padded sportType)
 *     - POST /cloud/api/Manager/getSportsVigSetup read-back (application/x-www-form-urlencoded)
 *  4. IP Tracker Forensic Surveillance:
 *     - POST /cloud/api/Manager/getWebLog across modes A, B, C, I
 */

import { SPORT_FIELD_WIDTH, padField } from "./f402_field_widths.ts";
import {
  type PaddedCustomerId,
  type AgentIdentifier,
  padCustomerIdCanonical,
  customerIdentifier,
  agentIdentifier,
} from "../design/domain-branded-types.ts";

export const PlayerMutationResultCode = {
  SUCCESS: 1,
  FAILURE: 0,
  REJECTED_SCOPE: -1,
} as const;
export type PlayerMutationResultCode =
  (typeof PlayerMutationResultCode)[keyof typeof PlayerMutationResultCode];

export const MutationClassification = {
  COMMITTED: "COMMITTED",
  UNVERIFIED_COMMIT: "UNVERIFIED_COMMIT",
  SILENT_NO_OP: "SILENT_NO_OP",
  REJECTED: "REJECTED",
  MODEL_ERROR: "MODEL_ERROR",
  QUBIC_UI_ONLY_404: "QUBIC_UI_ONLY_404",
  POISONED_PATH_500: "POISONED_PATH_500",
  GATEWAY_FAULT_500: "GATEWAY_FAULT_500",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  SHAPE_DRIFT: "SHAPE_DRIFT",
} as const;
export type MutationClassification =
  (typeof MutationClassification)[keyof typeof MutationClassification];

export const WirePayloadErrorClassification = {
  AUTHENTICATION_SESSION_EXPIRED: "AUTHENTICATION_SESSION_EXPIRED",
  WIRE_PAYLOAD_TRUNCATED: "WIRE_PAYLOAD_TRUNCATED",
  WIRE_PAYLOAD_SHAPE_DRIFT: "WIRE_PAYLOAD_SHAPE_DRIFT",
  CSRF_PAIRING_MISMATCH: "CSRF_PAIRING_MISMATCH",
  TRANSPORT_TIMEOUT: "TRANSPORT_TIMEOUT",
  CALLER_ABORTED: "CALLER_ABORTED",
  POISONED_PATH_DETECTED: "POISONED_PATH_DETECTED",
  INVALID_IDENTIFIER_LENGTH: "INVALID_IDENTIFIER_LENGTH",
  GATEWAY_FAULT_500: "GATEWAY_FAULT_500",
} as const;
export type WirePayloadErrorClassification =
  (typeof WirePayloadErrorClassification)[keyof typeof WirePayloadErrorClassification];

export class WirePayloadError extends Error {
  public readonly classification: WirePayloadErrorClassification;
  public readonly exitCode: number;

  constructor(
    classification: WirePayloadErrorClassification,
    message: string,
    exitCode = 72,
  ) {
    super(`[WirePayloadError:${classification}] ${message}`);
    this.name = "WirePayloadError";
    this.classification = classification;
    this.exitCode = exitCode;
  }
}

export interface PlayerMutationOptions {
  portalBaseUrl?: string;
  jwtToken?: string;
  cookieHeader?: string;
  customerIdentifier: string;
  agentOwnerIdentifier: string;
  column: string;
  value: string | number;
  timeoutMilliseconds?: number;
  verifyReadBack?: boolean;
  path?: never; // Guard: poisoned path parameter is forbidden
}

export interface PlayerMutationExecutionResult {
  readonly classification: MutationClassification;
  readonly rawResultCode: PlayerMutationResultCode;
  readonly isCommitted: boolean;
  readonly customerId: PaddedCustomerId;
  readonly agentOwner: AgentIdentifier;
  readonly column: string;
  readonly value: string | number;
  readonly readBackVerified: boolean;
  readonly rawResponse?: unknown;
}

export interface VigSetupOptions {
  portalBaseUrl?: string;
  jwtToken?: string;
  cookieHeader?: string;
  sportType: string; // e.g. "Football" -> padded to 20 chars
  customerIdentifier: string;
  vigSpread?: string; // default "15" (+15c)
  vigTotal?: string; // default "15" (+15c)
  vigDerivative?: string; // default "20" (+20c)
  timeoutMilliseconds?: number;
  verifyReadBack?: boolean;
}

export interface VigSetupExecutionResult {
  readonly success: boolean;
  readonly sportType: string;
  readonly player: PaddedCustomerId;
  readonly vigSpread: string;
  readonly vigDerivative: string;
  readonly readBackVerified: boolean;
}

export type WebLogMode = "A" | "B" | "C" | "I";

export interface WebLogQueryOptions {
  portalBaseUrl?: string;
  cookieHeader?: string;
  jwtToken?: string;
  mode: WebLogMode;
  agentId?: string;
  officeAgentId?: string; // For Mode B Per-Office IP Match (passed in customerID per ip-tracker.js)
  customerId?: string;
  startDate?: string;
  endDate?: string;
  ip?: string;
  timeoutMilliseconds?: number;
}

export interface WebLogQueryResult {
  readonly mode: WebLogMode;
  readonly queryTimestamp: string;
  readonly rowCount: number;
  readonly rows: unknown[];
  readonly rawResponse?: unknown;
}

/**
 * Deep equality helper matching Bun.deepEquals semantics across runtimes.
 */
export function deepEqualsNormalized(a: unknown, b: unknown): boolean {
  if (
    typeof Bun !== "undefined" &&
    typeof (Bun as any).deepEquals === "function"
  ) {
    return (Bun as any).deepEquals(a, b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Executes a customer column write mutation against POST /cloud/api/Manager/updateByColumn.
 */
export async function executePlayerColumnMutation(
  options: PlayerMutationOptions,
): Promise<PlayerMutationExecutionResult> {
  // 1. Poisoned path parameter guard (fail-fast exitCode 64)
  if ("path" in options && options.path !== undefined) {
    throw new WirePayloadError(
      WirePayloadErrorClassification.POISONED_PATH_DETECTED,
      "Options object contains poisoned 'path' parameter, which causes silent upstream HTTP 500",
      64,
    );
  }

  // 2. Validate identifier length and format
  const rawId = options.customerIdentifier.trim();
  if (rawId.length > 11) {
    throw new WirePayloadError(
      WirePayloadErrorClassification.INVALID_IDENTIFIER_LENGTH,
      `Customer identifier '${rawId}' exceeds 11 characters (length: ${rawId.length})`,
      64,
    );
  }

  const paddedCustId = padCustomerIdCanonical(options.customerIdentifier);
  const cleanAgent = agentIdentifier(options.agentOwnerIdentifier);

  // 3. Scope Hierarchy Rule: Direct parent sub-agent required (never master BILLY666 on writes)
  if (cleanAgent === "BILLY666") {
    return {
      classification: MutationClassification.REJECTED,
      rawResultCode: PlayerMutationResultCode.REJECTED_SCOPE,
      isCommitted: false,
      customerId: paddedCustId,
      agentOwner: cleanAgent,
      column: options.column,
      value: options.value,
      readBackVerified: false,
    };
  }

  const baseUrl = (
    options.portalBaseUrl ??
    process.env.SPORTSDESK_PORTAL_HTTP_BASE ??
    "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const updateUrl = `${baseUrl}/cloud/api/Manager/updateByColumn`;
  const timeoutMs = options.timeoutMilliseconds ?? 8000;

  // 4. Build application/x-www-form-urlencoded payload
  const bodyParams = new URLSearchParams({
    operation: "updateByColumn",
    customerID: paddedCustId,
    agentID: cleanAgent,
    agentOwner: cleanAgent,
    column: options.column,
    value: String(options.value),
    RRO: "0",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  };

  if (options.jwtToken) {
    headers["Authorization"] = `Bearer ${options.jwtToken}`;
  }
  if (options.cookieHeader) {
    headers["Cookie"] = options.cookieHeader;
  }

  // 5. Monotonic timeout signal
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(updateUrl, {
      method: "POST",
      headers,
      body: bodyParams.toString(),
      signal,
      referrerPolicy: "no-referrer",
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      throw new WirePayloadError(
        WirePayloadErrorClassification.TRANSPORT_TIMEOUT,
        `updateByColumn timed out after ${timeoutMs}ms`,
        75,
      );
    }
    if (err?.name === "AbortError") {
      throw new WirePayloadError(
        WirePayloadErrorClassification.CALLER_ABORTED,
        "updateByColumn request aborted by caller",
        72,
      );
    }
    throw err;
  }

  if (response.status === 401 || response.status === 403) {
    throw new WirePayloadError(
      WirePayloadErrorClassification.AUTHENTICATION_SESSION_EXPIRED,
      `Session expired: HTTP ${response.status}`,
      72,
    );
  }

  if (response.status === 400) {
    return {
      classification: MutationClassification.MODEL_ERROR,
      rawResultCode: PlayerMutationResultCode.FAILURE,
      isCommitted: false,
      customerId: paddedCustId,
      agentOwner: cleanAgent,
      column: options.column,
      value: options.value,
      readBackVerified: false,
    };
  }

  if (response.status >= 500) {
    return {
      classification: MutationClassification.GATEWAY_FAULT_500,
      rawResultCode: PlayerMutationResultCode.FAILURE,
      isCommitted: false,
      customerId: paddedCustId,
      agentOwner: cleanAgent,
      column: options.column,
      value: options.value,
      readBackVerified: false,
    };
  }

  let json: any;
  try {
    json = await response.json();
  } catch {
    throw new WirePayloadError(
      WirePayloadErrorClassification.WIRE_PAYLOAD_TRUNCATED,
      "Failed to parse upstream response JSON",
      72,
    );
  }

  const rawResult = json?.Result?.Result ?? json?.Result;
  let resultCode: PlayerMutationResultCode;

  if (rawResult === 1 || rawResult === "1") {
    resultCode = PlayerMutationResultCode.SUCCESS;
  } else if (rawResult === 0 || rawResult === "0") {
    resultCode = PlayerMutationResultCode.FAILURE;
  } else if (rawResult === -1 || rawResult === "-1") {
    resultCode = PlayerMutationResultCode.REJECTED_SCOPE;
  } else {
    throw new WirePayloadError(
      WirePayloadErrorClassification.WIRE_PAYLOAD_SHAPE_DRIFT,
      `Unexpected Result code: ${JSON.stringify(rawResult)}`,
      72,
    );
  }

  if (resultCode === PlayerMutationResultCode.REJECTED_SCOPE) {
    return {
      classification: MutationClassification.REJECTED,
      rawResultCode: resultCode,
      isCommitted: false,
      customerId: paddedCustId,
      agentOwner: cleanAgent,
      column: options.column,
      value: options.value,
      readBackVerified: false,
      rawResponse: json,
    };
  }

  if (resultCode === PlayerMutationResultCode.FAILURE) {
    return {
      classification: MutationClassification.SILENT_NO_OP,
      rawResultCode: resultCode,
      isCommitted: false,
      customerId: paddedCustId,
      agentOwner: cleanAgent,
      column: options.column,
      value: options.value,
      readBackVerified: false,
      rawResponse: json,
    };
  }

  // Result: 1 (SUCCESS) confirmed
  let readBackVerified = false;
  if (options.verifyReadBack) {
    try {
      const readBackData = await fetchPlayerInfo({
        portalBaseUrl: baseUrl,
        ...(options.jwtToken === undefined
          ? {}
          : { jwtToken: options.jwtToken }),
        ...(options.cookieHeader === undefined
          ? {}
          : { cookieHeader: options.cookieHeader }),
        customerIdentifier: options.customerIdentifier,
        timeoutMilliseconds: 4000,
      });

      if (
        readBackData &&
        String(readBackData[options.column]) === String(options.value)
      ) {
        readBackVerified = true;
      }
    } catch {
      readBackVerified = false;
    }
  }

  return {
    classification:
      readBackVerified || !options.verifyReadBack
        ? MutationClassification.COMMITTED
        : MutationClassification.UNVERIFIED_COMMIT,
    rawResultCode: PlayerMutationResultCode.SUCCESS,
    isCommitted: true,
    customerId: paddedCustId,
    agentOwner: cleanAgent,
    column: options.column,
    value: options.value,
    readBackVerified,
    rawResponse: json,
  };
}

/**
 * Fetches player information via POST /cloud/api/Manager/getInfoPlayer (read-back verification).
 */
export async function fetchPlayerInfo(options: {
  portalBaseUrl?: string;
  jwtToken?: string;
  cookieHeader?: string;
  customerIdentifier: string;
  timeoutMilliseconds?: number;
}): Promise<Record<string, unknown> | null> {
  const baseUrl = (
    options.portalBaseUrl ??
    process.env.SPORTSDESK_PORTAL_HTTP_BASE ??
    "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const readUrl = `${baseUrl}/cloud/api/Manager/getInfoPlayer`;
  const timeoutMs = options.timeoutMilliseconds ?? 5000;

  // Reads send trimmed customer ID
  const cleanId = customerIdentifier(options.customerIdentifier);

  const params = new URLSearchParams({
    customerID: cleanId,
    operation: "getInfoPlayer",
    RRO: "0",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  };

  if (options.jwtToken) headers["Authorization"] = `Bearer ${options.jwtToken}`;
  if (options.cookieHeader) headers["Cookie"] = options.cookieHeader;

  const res = await fetch(readUrl, {
    method: "POST",
    headers,
    body: params.toString(),
    signal: AbortSignal.timeout(timeoutMs),
    referrerPolicy: "no-referrer",
  });

  if (!res.ok) return null;
  const json: any = await res.json();
  return json?.Result ?? json?.data ?? json ?? null;
}

/**
 * Inserts sport vig setup (+15c / +20c juice shading) via POST /cloud/api/Manager/vigSetupInsert.
 */
export async function executeVigSetupInsert(
  options: VigSetupOptions,
): Promise<VigSetupExecutionResult> {
  const baseUrl = (
    options.portalBaseUrl ??
    process.env.SPORTSDESK_PORTAL_HTTP_BASE ??
    "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const insertUrl = `${baseUrl}/cloud/api/Manager/vigSetupInsert`;
  const timeoutMs = options.timeoutMilliseconds ?? 8000;

  // Invariants: 20-char padded sportType, 11-char padded player
  const paddedSport = padField(options.sportType, SPORT_FIELD_WIDTH);
  const paddedPlayer = padCustomerIdCanonical(options.customerIdentifier);

  const vigSpread = options.vigSpread ?? "15";
  const vigTotal = options.vigTotal ?? "15";
  const vigDerivative = options.vigDerivative ?? "20";

  const payload = {
    operation: "vigSetupInsert",
    sportType: paddedSport,
    allPlayers: "off",
    agentProfile: 0,
    player: paddedPlayer,
    flagVig: "Y",
    flagDiscount: "N",
    VigSpread: vigSpread,
    VigTotal: vigTotal,
    VigDerivative: vigDerivative,
    VigDiscountPercent: "0",
    RRO: "1",
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  };

  if (options.jwtToken) headers["Authorization"] = `Bearer ${options.jwtToken}`;
  if (options.cookieHeader) headers["Cookie"] = options.cookieHeader;

  const res = await fetch(insertUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    referrerPolicy: "no-referrer",
  });

  if (!res.ok) {
    return {
      success: false,
      sportType: paddedSport,
      player: paddedPlayer,
      vigSpread,
      vigDerivative,
      readBackVerified: false,
    };
  }

  const json: any = await res.json();
  const rawResult = json?.Result?.Result ?? json?.Result;
  const committed = rawResult === 1 || rawResult === "1";

  let readBackVerified = false;
  if (committed && options.verifyReadBack) {
    try {
      const readRes = await fetch(
        `${baseUrl}/cloud/api/Manager/getSportsVigSetup`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
            ...(options.jwtToken
              ? { Authorization: `Bearer ${options.jwtToken}` }
              : {}),
          },
          body: new URLSearchParams({
            operation: "getSportsVigSetup",
            sportType: paddedSport,
            player: paddedPlayer,
            RRO: "1",
          }).toString(),
          signal: AbortSignal.timeout(4000),
        },
      );

      if (readRes.ok) {
        const readJson: any = await readRes.json();
        const rData = readJson?.Result ?? readJson;
        if (rData && String(rData.VigSpread) === vigSpread) {
          readBackVerified = true;
        }
      }
    } catch {
      readBackVerified = false;
    }
  }

  return {
    success: committed,
    sportType: paddedSport,
    player: paddedPlayer,
    vigSpread,
    vigDerivative,
    readBackVerified,
  };
}

/**
 * Queries the Fantasy402 IP Tracker via POST /cloud/api/Manager/getWebLog across modes A, B, C, I.
 */
export async function queryIpTrackerWebLog(
  options: WebLogQueryOptions,
): Promise<WebLogQueryResult> {
  const baseUrl = (
    options.portalBaseUrl ??
    process.env.SPORTSDESK_PORTAL_HTTP_BASE ??
    "https://www.fantasy402.com"
  ).replace(/\/$/, "");
  const logUrl = `${baseUrl}/cloud/api/Manager/getWebLog`;
  const timeoutMs = options.timeoutMilliseconds ?? 10000;

  // Format date: Mode C requires YYYY-MM-DD; modes A, B, I use MM/DD/YYYY
  const today = new Date();
  const defaultDateMdy = `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`;
  const defaultDateYmd = today.toISOString().slice(0, 10);

  const startDate =
    options.startDate ??
    (options.mode === "C" ? defaultDateYmd : defaultDateMdy);
  const endDate =
    options.endDate ?? (options.mode === "C" ? defaultDateYmd : defaultDateMdy);

  const bodyParams = new URLSearchParams({
    operation: "getWebLog",
    type: options.mode,
    agentID: options.agentId ?? "BILLY666",
    agentOwner: options.agentId ?? "BILLY666",
    customerID:
      options.mode === "B" && options.officeAgentId
        ? options.officeAgentId.trim().toUpperCase()
        : (options.customerId ?? "0"),
    start: startDate,
    end: endDate,
    actions: "ALL",
    ip: options.ip ?? "",
    RRO: "1",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  };

  if (options.jwtToken) headers["Authorization"] = `Bearer ${options.jwtToken}`;
  if (options.cookieHeader) headers["Cookie"] = options.cookieHeader;

  const res = await fetch(logUrl, {
    method: "POST",
    headers,
    body: bodyParams.toString(),
    signal: AbortSignal.timeout(timeoutMs),
    referrerPolicy: "no-referrer",
  });

  if (!res.ok) {
    throw new WirePayloadError(
      WirePayloadErrorClassification.GATEWAY_FAULT_500,
      `getWebLog query failed: HTTP ${res.status} ${res.statusText}`,
      res.status >= 500 ? 75 : 72,
    );
  }

  const json: any = await res.json();
  const rows = Array.isArray(json)
    ? json
    : (json?.LIST ?? json?.data ?? json?.rows ?? []);

  return {
    mode: options.mode,
    queryTimestamp: new Date().toISOString(),
    rowCount: rows.length,
    rows,
    rawResponse: json,
  };
}
