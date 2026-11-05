/**
 * @file bet_ticker_labels.ts
 * @description Labels from the portal client config (`getTypeInfo`, `BET.SUB_TYPE` and
 * `typePeriod`). These are the single source of truth for wire codes.
 *
 * Two namespaces are deliberately separate:
 * - `WAGER_TYPE_LABEL` is `getTypeInfo` for the ticket/leg `WagerType` field:
 *   `S` = Spread, `M` = Moneyline, `L` = Total, `E` = Team Total, `C` = Future/Props,
 *   `A` = Manual Play, `P` = Parlay, `T` = Teaser, `I` = If-Bet, `G` = Live/Racebook.
 * - `TICKET_STRUCTURE` is the HTML "Type" column: `Straight`, `Parlay`, `Prop`, `Teaser`.
 *
 * They are not interchangeable. A single-leg spread ticket is `WagerType S` (Spread) but
 * its ticket structure is Straight. `game_admin.ts` still carries a legacy position map that
 * treats `S` as Straight for the Game Admin view; new code should import this module.
 */

export const WAGER_TYPE_LABEL = {
  A: "Manual Play",
  M: "Moneyline",
  C: "Future/Props",
  S: "Spread",
  T: "Teaser",
  L: "Total",
  E: "Team Total",
  I: "If-Bet",
  P: "Parlay",
  G: "Live/Racebook",
} as const;

/** `BET.SUB_TYPE` — the leg-level `LegWagerType` in `getLineGameFull`. */
export const SUB_TYPE = {
  L: "total",
  E: "team-total",
  S: "spread",
  M: "money",
  G: "live",
} as const;

/** `typePeriod` → the canonical period code. */
export const TYPE_PERIOD = {
  Game: "Game",
  Prop: "Prop",
  "1st Half": "1H",
  "2nd Half": "2H",
  "1st Quarter": "1Q",
  "2nd Quarter": "2Q",
  "3rd Quarter": "3Q",
  "4th Quarter": "4Q",
  "1st Period": "1P",
  "2nd Period": "2P",
  "3rd Period": "3P",
  "1st 5 Innings": "1st 5",
  "Last 4 Innings": "Last 4",
} as const;

/** The HTML "Type" column; `getTypeInfo`'s `M` label is not this namespace. */
export const TICKET_STRUCTURE = [
  "Straight",
  "Parlay",
  "Prop",
  "Teaser",
] as const;

export type WagerTypeLabel =
  (typeof WAGER_TYPE_LABEL)[keyof typeof WAGER_TYPE_LABEL] | "Other";
export type SubType = (typeof SUB_TYPE)[keyof typeof SUB_TYPE];
export type TicketStructure = (typeof TICKET_STRUCTURE)[number];

/** `S` → `Spread`, `P` → `Parlay`; unknown codes stay `Other`. */
export function wagerTypeLabel(code: string): WagerTypeLabel {
  const key = String(code ?? "")
    .trim()
    .toUpperCase();
  const label = (WAGER_TYPE_LABEL as Record<string, string | undefined>)[key];
  return (label as WagerTypeLabel | undefined) ?? "Other";
}

/** `1st Half` → `1H`; a period already outside the map is returned trimmed. */
export function periodCode(period: string): string {
  const key = period.trim();
  const mapped = (TYPE_PERIOD as Record<string, string | undefined>)[key];
  return mapped ?? key;
}
