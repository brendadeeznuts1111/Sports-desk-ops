/**
 * @file lib/f402_customer_view.ts
 * @description Read-only GSLive Manager customer view: per-customer and per-ticket links.
 *
 * v1 is a link handoff, not a customer read. There is no configured F402 customer GET, so
 * `resolveCustomerView()` builds the canonical URLs (the same builders the operator console uses)
 * and returns `read: { available: false, reason: "customer_read_not_configured" }` rather than
 * pretending a live read happened. Nothing here opens a socket, reads a session, or logs an
 * identifier from one.
 *
 * The per-ticket link is a `#/events/bet-history` sidecar URL: `partnerUserId` scopes it to the
 * customer, `state` is the SPA's own state filter and `betId` is the SPA's bet-id filter, both
 * normalized by `lib/gslive_manager_deeplink_sidecar.ts`.
 */

import type { IncomingBetRecord } from "./bet_flags.ts";
import {
  GSLIVE_BET_HISTORY_STATES,
  type GsLiveBetHistoryState,
  addDaysYmd,
  buildGsLiveBetHistorySidecarUrl,
  buildGsLiveManagerSurfaceUrls,
  computeDeskDayStartEpochSeconds,
  computeDeskDayToTimeSeconds,
  resolveDeskDateYmd,
} from "./gslive_manager_deeplink_sidecar.ts";

export interface CustomerViewRequest {
  readonly customerId: string;
  readonly betIds?: readonly string[];
  /** Desk day the bet-history window ends on; defaults to today in America/Chicago. */
  readonly dateYmd?: string;
  /** GSLive `#/events/bet-history` state filter (SPA vocabulary); default `""` (all). */
  readonly state?: string;
  /** Desk days in the bet-history window, 1..31 (clamped); default 1. */
  readonly windowDays?: number;
  /** Cache-buster tick for the links; default `Date.now()`. */
  readonly tickEpochMs?: number;
}

export interface CustomerViewLinks {
  readonly gsLivePlayerId: string;
  readonly betHistoryUrl: string;
  readonly playerReportUrl: string;
  readonly openBetReportUrl: string;
}

export interface CustomerViewResult {
  readonly ok: true;
  readonly customerId: string;
  readonly links: CustomerViewLinks;
  readonly read: {
    readonly available: false;
    readonly reason: "customer_read_not_configured" | "no_session";
    readonly message: string;
  };
}

/** Honest statement of what this view does not do. */
const NO_CUSTOMER_READ_MESSAGE =
  "v1 is a read-only link handoff: no F402 customer read is configured, so this result carries GSLive Manager deep links only and made no authenticated customer request.";

const DATE_YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 31;

/** Resolves the desk day: explicit `dateYmd` when valid, otherwise today in the desk timezone. */
function resolveDateYmd(dateYmd: string | undefined): string {
  if (dateYmd === undefined) return resolveDeskDateYmd();
  const trimmed = dateYmd.trim();
  const match = DATE_YMD.exec(trimmed);
  if (match === null) {
    throw new Error(
      `dateYmd must be a desk date in YYYY-MM-DD form, got ${JSON.stringify(dateYmd)}`,
    );
  }
  const [, y, m, d] = match;
  const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    parsed.getUTCFullYear() !== Number(y) ||
    parsed.getUTCMonth() !== Number(m) - 1 ||
    parsed.getUTCDate() !== Number(d)
  ) {
    throw new Error(
      `dateYmd must be a real calendar day, got ${JSON.stringify(dateYmd)}`,
    );
  }
  return trimmed;
}

/** Window length clamped into the SPA-supported 1..31 desk days. */
function resolveWindowDays(windowDays: number | undefined): number {
  if (windowDays === undefined || !Number.isFinite(windowDays)) {
    return MIN_WINDOW_DAYS;
  }
  return Math.min(
    MAX_WINDOW_DAYS,
    Math.max(MIN_WINDOW_DAYS, Math.trunc(windowDays)),
  );
}

/**
 * Narrows an arbitrary `--state` string to the SPA's shipped vocabulary. An unknown state would
 * be silently ignored by the console, so it is refused here instead of producing a link that
 * looks filtered but is not.
 */
function resolveState(raw: string): GsLiveBetHistoryState {
  const match = GSLIVE_BET_HISTORY_STATES.find((state) => state === raw);
  if (match === undefined) {
    throw new Error(
      `state must be one of ${GSLIVE_BET_HISTORY_STATES.map((s) => JSON.stringify(s)).join(", ")}, got ${JSON.stringify(raw)}`,
    );
  }
  return match;
}

function normalizeBetIds(betIds: readonly string[] | undefined): string[] {
  return (betIds ?? [])
    .map((betId) => betId.trim())
    .filter((betId) => betId !== "");
}

/**
 * Builds the read-only GSLive Manager view for one customer. Pure and synchronous: no session
 * read, no network call, no writes.
 */
export function resolveCustomerView(
  request: CustomerViewRequest,
): CustomerViewResult {
  const customerId = request.customerId.trim();
  if (customerId === "") {
    throw new Error("customerId is required");
  }
  const dateYmd = resolveDateYmd(request.dateYmd);
  const windowDays = resolveWindowDays(request.windowDays);
  const state = resolveState(request.state ?? "");
  const betIds = normalizeBetIds(request.betIds);
  const tickEpochMs = request.tickEpochMs ?? Date.now();

  const surfaces = buildGsLiveManagerSurfaceUrls({
    customerLogin: customerId,
    dateYmd,
    tickEpochMs,
    reportWindowDays: windowDays,
  });

  const dayStartEpoch = computeDeskDayStartEpochSeconds(dateYmd);
  const windowFromEpoch = computeDeskDayStartEpochSeconds(
    addDaysYmd(dateYmd, -(windowDays - 1)),
  );
  const betHistoryUrl = buildGsLiveBetHistorySidecarUrl({
    minVolume: 0,
    maxTimeUntilScore: 0,
    dateYmd,
    fromEpochSec: windowFromEpoch,
    toEpochSec: dayStartEpoch,
    toTimeSec: computeDeskDayToTimeSeconds(dateYmd),
    dateFilterBy: "calcTime",
    tickEpochMs,
    customerLogin: customerId,
    state,
    ...(betIds.length > 0 ? { filters: { betId: betIds.join(" ") } } : {}),
  });

  return {
    ok: true,
    customerId,
    links: {
      gsLivePlayerId: surfaces.gsLivePlayerId,
      betHistoryUrl,
      playerReportUrl: surfaces.playerReportUrl,
      openBetReportUrl: surfaces.openBetReportUrl,
    },
    read: {
      available: false,
      reason: "customer_read_not_configured",
      message: NO_CUSTOMER_READ_MESSAGE,
    },
  };
}

/**
 * Customer view for one incoming bet: the customer comes from the widened record and the bet id
 * is the ticket/wager key, so the bet-history link opens that customer's view filtered to the
 * bet. `dateYmd`/`windowDays` override the window; `state` and `tickEpochMs` are optional
 * pass-throughs so callers that already resolved them (the CLI's `locate --bet`) keep a
 * deterministic, correctly-filtered link.
 */
export function customerViewForBet(
  bet: IncomingBetRecord,
  options?: {
    readonly dateYmd?: string;
    readonly windowDays?: number;
    /** Optional SPA state filter; default `""` (all). */
    readonly state?: string;
    /** Optional cache-buster tick; default `Date.now()`. */
    readonly tickEpochMs?: number;
  },
): CustomerViewResult {
  const betIds = Array.from(
    new Set(
      [bet.betKey, bet.ticketNumber]
        .map((value) => value.trim())
        .filter((value) => value !== ""),
    ),
  );
  return resolveCustomerView({
    customerId: bet.customerId,
    betIds,
    ...(options?.dateYmd !== undefined ? { dateYmd: options.dateYmd } : {}),
    ...(options?.windowDays !== undefined
      ? { windowDays: options.windowDays }
      : {}),
    ...(options?.state !== undefined ? { state: options.state } : {}),
    ...(options?.tickEpochMs !== undefined
      ? { tickEpochMs: options.tickEpochMs }
      : {}),
  });
}
