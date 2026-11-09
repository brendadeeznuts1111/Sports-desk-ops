/**
 * @file live_read_defaults.ts
 * @description The single source for the live-read route gates and defaults.
 *
 * `services/sportsdesk_webview_server.ts` resolves every `SPORTSDESK_LIVE_*` gate from these
 * constants, and `tests/live_read_defaults.test.ts` checks that `.env.example` and the live-desk
 * runbook document the same values. A default changed here therefore changes the daemon and the
 * docs check together instead of drifting in a prose duplicate.
 */

/** Ticker snapshot TTL shared by `/api/live-wagers` and `/api/kpis` (env `…_TTL_MS`). */
export const LIVE_TICKER_DEFAULT_TTL_MS = 10_000;
export const LIVE_TICKER_MAX_TTL_MS = 300_000;
/** Per-attempt route read timeout (env `…_TIMEOUT_MS`); distinct from the probe's longer 15 s. */
export const LIVE_TICKER_DEFAULT_TIMEOUT_MS = 4_000;
export const LIVE_TICKER_MIN_TIMEOUT_MS = 250;
export const LIVE_TICKER_MAX_TIMEOUT_MS = 30_000;

/** Pending snapshot TTL shared by `/api/live-bets*` and `/api/kpis`. */
export const LIVE_PENDING_DEFAULT_TTL_MS = 60_000;
export const LIVE_PENDING_MAX_TTL_MS = 300_000;

/** Throttle for writing live artifacts + capture-health after a fresh read. */
export const LIVE_PERSIST_DEFAULT_THROTTLE_MS = 60_000;
export const LIVE_PERSIST_MAX_THROTTLE_MS = 600_000;

/** Daemon refresh loop cadence (env `SPORTSDESK_LIVE_REFRESH_MS`; `0` disables). */
export const LIVE_REFRESH_DEFAULT_MS = 60_000;
export const LIVE_REFRESH_MAX_MS = 3_600_000;

/** The Pending reader's own defaults and clamps stay authoritative in its module. */
export {
  LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
  LIVE_PENDING_DEFAULT_TIMEOUT_MS,
  LIVE_PENDING_MAX_MAX_CUSTOMERS,
  LIVE_PENDING_MAX_TIMEOUT_MS,
  LIVE_PENDING_MIN_MAX_CUSTOMERS,
  LIVE_PENDING_MIN_TIMEOUT_MS,
} from "./f402_live_pending.ts";
