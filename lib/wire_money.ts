/**
 * @file lib/wire_money.ts
 * @description The one wire-cents → USD conversion.
 *
 * The F402/GSLive wire reports money in cents (`wagered: 2000` = $20.00, `"5000.0"` = $50.00).
 * The scale was measured on the 2026-11 graded exports and the suspected-bot bundle; reading a
 * wire value as dollars overstates it by 100×. Every artifact loader must convert here once, at
 * its boundary, instead of each module carrying its own `/ 100`.
 */

export const WIRE_MONEY_PER_USD = 100;

/** Wire cents → USD. Callers pass an already-validated number, not a raw unknown. */
export function usdFromWireCents(cents: number): number {
  return cents / WIRE_MONEY_PER_USD;
}
