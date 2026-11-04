/**
 * @file lib/f402_ingest.ts
 * @description Read-only F402 connectivity probe over a cached session.
 *
 * Uses `POST /cloud/api/Manager/getBetTicker` (tier A: live request+response captured) to prove the
 * session works, count rows, and normalize the captured identity/timing fields into a tick preview.
 * Money fields are carried as raw wire numbers only: their units are unverified here, and the
 * Bridge 3a projection (not this probe) owns the cents conversion and its documented assumption.
 */

import type { F402Session } from "./f402_session.ts";

/** Minimal fetch face the probe needs; the global fetch and the replay transport both satisfy it. */
export type F402ProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface F402ProbeOptions {
  readonly baseUrl?: string;
  readonly agentId: string;
  readonly fetchImpl?: F402ProbeFetch;
  readonly timeoutMs?: number;
  /**
   * `wagerNumber` sent with `getBetTicker`; `"0"` asks for the whole current list (the captured
   * shape). Paging callers pass the last processed wager number to ask for the next page.
   */
  readonly wagerNumber?: string;
  /**
   * Cap on normalized `ticks` (default 200, the preview budget). Bridge 3a passes a larger cap so
   * a full list is fully processed; `rows` always reports the raw `LIST` length.
   */
  readonly maxTicks?: number;
}

export interface F402TickerRow {
  readonly login: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly agentLogin: string;
  readonly ticketWriter: string;
  readonly wagerNumber: string;
  /**
   * `TicketNumber` when the payload carries one. The captured ticker row does not: in this feed
   * `wagerNumber` is the ticket id (`lib/live_wagers.ts`), so this stays empty and the Bridge 3a
   * dedupe key falls back to the single field.
   */
  readonly ticketNumber: string;
  readonly wagerType: string;
  readonly shortDesc: string;
  readonly insertedAt: string;
  readonly vip: string;
  /** Whole-dollar amounts from the wire, or null when absent/non-numeric. Units are unverified. */
  readonly amountWagered: number | null;
  readonly toWinAmount: number | null;
  readonly volumeAmount: number | null;
}

export interface F402Probe {
  readonly endpoint: string;
  readonly httpStatus: number;
  readonly rows: number;
  readonly fields: readonly string[];
  readonly ticks: readonly F402TickerRow[];
  readonly durationMs: number;
  readonly fetchedAtIso: string;
  readonly error: string | null;
}

function extractRows(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["LIST", "data", "rows"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";

const cleanText = (value: unknown): string =>
  text(value)
    .replace(/[^\x20-\x7E\u00BD]/g, "")
    .trim();

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Normalizes the captured identity/timing fields; money stays raw until the Bridge 3a projection. */
export function parseF402TickerRow(value: unknown): F402TickerRow | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const login = text(row.Login) || text(row.CustomerID);
  if (login === "") return null;
  return {
    login,
    customerId: text(row.CustomerID),
    agentId: text(row.AgentID),
    agentLogin: text(row.AgentLogin),
    ticketWriter: text(row.TicketWriter),
    wagerNumber: text(row.WagerNumber),
    ticketNumber: text(row.TicketNumber),
    wagerType: text(row.WagerType),
    shortDesc: cleanText(row.ShortDesc),
    insertedAt: text(row.InsertDateTime),
    vip: text(row.VIP),
    amountWagered: numberOrNull(row.AmountWagered),
    toWinAmount: numberOrNull(row.ToWinAmount),
    volumeAmount: numberOrNull(row.VolumeAmount),
  };
}

/**
 * Probes `getBetTicker` with the captured form shape. 401/403 returns `error: "unauthorized"` so the
 * caller can refresh the session once.
 */
export async function probeF402BetTicker(
  session: F402Session,
  options: F402ProbeOptions,
): Promise<F402Probe> {
  const startedAt = Date.now();
  const fetchedAtIso = new Date(startedAt).toISOString();
  const baseUrl = (options.baseUrl ?? "https://fantasy402.com").replace(
    /\/$/,
    "",
  );
  const endpoint = `${baseUrl}/cloud/api/Manager/getBetTicker`;
  const fetchImpl: F402ProbeFetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const agentId = options.agentId.trim();

  const body = new URLSearchParams({
    RRO: "0",
    agentID: agentId,
    agentOwner: agentId,
    operation: "getBetTicker",
    wagerNumber: options.wagerNumber ?? "0",
  });

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    cookie: session.cookieHeader,
  };
  if (session.authorizationHeader !== undefined) {
    headers["authorization"] = session.authorizationHeader;
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body,
      proxy: false,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    } as RequestInit);
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        endpoint,
        httpStatus: response.status,
        rows: 0,
        fields: [],
        ticks: [],
        durationMs,
        fetchedAtIso,
        error:
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : `HTTP ${response.status}`,
      };
    }
    const parsed: unknown = await response.json();
    const rows = extractRows(parsed);
    const maxTicks =
      options.maxTicks !== undefined &&
      Number.isSafeInteger(options.maxTicks) &&
      options.maxTicks > 0
        ? options.maxTicks
        : 200;
    const ticks = (rows ?? [])
      .map(parseF402TickerRow)
      .filter((tick): tick is F402TickerRow => tick !== null)
      .slice(0, maxTicks);
    const firstRow = rows?.[0];
    const fields =
      firstRow !== null && typeof firstRow === "object"
        ? Object.keys(firstRow as Record<string, unknown>).sort()
        : [];
    return {
      endpoint,
      httpStatus: response.status,
      rows: rows?.length ?? 0,
      fields,
      ticks,
      durationMs,
      fetchedAtIso,
      error: rows === null ? "unexpected body" : null,
    };
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      endpoint,
      httpStatus: 0,
      rows: 0,
      fields: [],
      ticks: [],
      durationMs: Date.now() - startedAt,
      fetchedAtIso,
      error: message,
    };
  }
}
