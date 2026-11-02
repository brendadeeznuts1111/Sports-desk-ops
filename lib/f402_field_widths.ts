/**
 * @file f402_field_widths.ts
 * @description The portal's fixed-width fields, in one place, each with its evidence status.
 *
 * Every width below was previously a bare number at a call site — `padEnd(20, " ")` in one module,
 * `padEnd(10, " ")` in another — which is how a width gets copied into a new caller with the wrong
 * justification attached. The numbers are cheap to centralise; the *status* is the part worth
 * centralising, because two of these widths are claims and two are measurements.
 *
 * Measured (a live request or response was observed):
 *  - `SPORT_FIELD_WIDTH` = 20 — `Football`, `Auto Racing`, `Tennis` and `LIVE` all arrive padded to
 *    20 in report requests, and the same 20 appears in the sports select's option values.
 *  - `TICKER_AGENT_ID_WIDTH` = 50 — `AgentID` in the `getBetTickerConfig` response: an 8-character
 *    login plus 42 spaces.
 *
 * Claims (no capture; do not cite as fact):
 *  - `CUSTOMER_ID_CANONICAL_WIDTH` = 11 — the spec's padded form for `updateByColumn`. Unconfirmed.
 *  - `LOG_WRITE_CUSTOMER_ID_WIDTH` = 10 — the runbook's note for `Log/write`. Contradicted on
 *    2026-11-01, when `Log/write`, `Log/writeDetail` and `vipListInsert` all sent the bare login
 *    (`customerID=BILLY666`). Kept at 10 because changing a probe's behaviour on the strength of a
 *    paste is not a refactor; the contradiction is recorded in `docs/evidence/capture-requests.md`.
 */

/** Space-padded sport name, as report requests and the sports select both carry it. */
export const SPORT_FIELD_WIDTH = 20;

/** `AgentID` in a `getBetTickerConfig` response. Request-side identifiers are unpadded. */
export const TICKER_AGENT_ID_WIDTH = 50;

/** Spec claim only: the padded `customerID` for `updateByColumn`. */
export const CUSTOMER_ID_CANONICAL_WIDTH = 11;

/** Runbook claim only, contradicted by the 2026-11-01 `Log/*` observations. */
export const LOG_WRITE_CUSTOMER_ID_WIDTH = 10;

/**
 * Pads `value` with spaces to `width`, never truncating.
 *
 * Truncation is deliberately absent: a value longer than the field is a contract change, and a
 * silent `slice` would hide it. Callers that need a hard limit validate before padding.
 */
export function padField(value: string, width: number): string {
  const trimmed = value.trim();
  if (trimmed.length >= width) return trimmed;
  return trimmed.padEnd(width, " ");
}

/** True when the value carries the portal's padding, i.e. it differed from its trimmed form. */
export function isPadded(value: string): boolean {
  return value !== value.trim();
}
