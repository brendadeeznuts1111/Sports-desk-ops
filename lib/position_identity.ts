/**
 * @file lib/position_identity.ts
 * @description How one live position is identified, with the refusal made explicit.
 *
 * The pending capture sets `wagerNumber` to the literal "1" on every row; `ticketNumber` is its
 * per-row identity. The ticker capture has no ticket number, so its `WagerNumber` is the identity.
 * A single `ticketNumber ?? wagerNumber` fallback re-adopts the assumption that failed (that a
 * wager number is unique), so the rule is source-aware: a pending row without a ticket is refused
 * and counted, never keyed on "1".
 */

export type PositionRefusal = "null_ticket" | "null_wager";

export interface PositionIdentityFields {
  readonly ticketNumber?: string | null | undefined;
  readonly ticket_number?: string | null | undefined;
  readonly wagerNumber?: string | null | undefined;
  readonly wager_number?: string | null | undefined;
  readonly source?: string | null | undefined;
}

export interface PositionIdentity {
  readonly key: string | null;
  readonly refusal: PositionRefusal | null;
}

/** The dedupe key for one position, or the named reason it has none. */
export function positionIdentity(
  fields: PositionIdentityFields,
): PositionIdentity {
  const ticket = (fields.ticketNumber ?? fields.ticket_number ?? "").trim();
  if (ticket !== "") return { key: ticket, refusal: null };

  // A pending row's only honest identity is its ticket. Falling back to its wager number ("1")
  // would silently collapse every ticket for that customer into one position.
  if ((fields.source ?? "") === "live-bets") {
    return { key: null, refusal: "null_ticket" };
  }

  const wager = (fields.wagerNumber ?? fields.wager_number ?? "").trim();
  if (wager !== "") return { key: wager, refusal: null };
  return { key: null, refusal: "null_wager" };
}
