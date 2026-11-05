/**
 * @file wager_composition.ts
 * @description Classify a wager's leg structure: single, same-game combo, cross-game combo,
 * cross-sport combo, or mixed. This is the "what kind of ticket is this" layer above market kind.
 *
 * Evidence source: the wire description already separates legs with " | " (Report/Pending) or
 * CRLF / `&#x0D;` (getBetTicker ShortDesc). Each leg is parsed with `parseBetMarket`, so event and
 * sport identity come from the existing parser rather than a new grammar.
 *
 * Futures are deliberately out of scope for the wager coverage (the user does not need them); a
 * golf/futures-looking description is counted under `excludedFutures` instead of being forced
 * into a combo class.
 */

import {
  eventKeyFor,
  parseBetMarket,
  type ParsedMarket,
} from "./bet_market_parse.ts";

export type WagerCompositionKind =
  "single" | "same_game" | "cross_game" | "cross_sport" | "mixed" | "unknown";

export interface ComboLegSummary {
  readonly sport: string | null;
  readonly eventLabel: string | null;
  readonly eventKey: string | null;
  readonly marketType: string | null;
  readonly parsed: boolean;
}

export interface WagerComposition {
  /** Number of picks the wire claims, when it says; null when it does not. */
  readonly declaredPicks: number | null;
  /** Number of legs recovered from the description after splitting. */
  readonly splitLegs: number;
  /** Effective leg count: declared picks when present, else the split count. */
  readonly legCount: number;
  readonly kind: WagerCompositionKind;
  readonly sports: readonly string[];
  readonly events: readonly string[];
  readonly unparsedLegs: number;
  /** True when the description looks like golf/futures, which this coverage excludes. */
  readonly excludedFutures: boolean;
  readonly legs: readonly ComboLegSummary[];
}

const LEG_SEPARATOR = /\s+\|\s+|\r?\n|&#x0D;/i;
const LEADING_TICKET_PREFIX = /^(?:[A-Z]:|[A-Z]\.)\s*/;
/** A standalone ticket reference ("M.G320197818") is metadata, not a leg. */
const TICKET_REFERENCE = /^[A-Z]:?\.?G?\d{3,}$/i;
const FUTURES_HINT = /\bgolf\b|futures|round leader|top \d+|outright/i;

/** Split a wire description into leg descriptions; never throws, keeps empty input empty. */
export function splitWireLegs(
  description: string | null | undefined,
): string[] {
  const text = (description ?? "").trim();
  if (text === "") return [];
  return text
    .split(LEG_SEPARATOR)
    .map((part) => part.trim().replace(LEADING_TICKET_PREFIX, "").trim())
    .filter((part) => part !== "" && !TICKET_REFERENCE.test(part));
}

function legSummary(market: ParsedMarket | null): ComboLegSummary {
  if (market === null) {
    return {
      sport: null,
      eventLabel: null,
      eventKey: null,
      marketType: null,
      parsed: false,
    };
  }
  const eventKey = eventKeyFor(market);
  return {
    sport: market.sport === "" ? null : market.sport,
    eventLabel: market.eventLabel === "" ? null : market.eventLabel,
    eventKey: eventKey === "" ? null : eventKey,
    marketType: market.marketType,
    parsed: true,
  };
}

/**
 * Describe the ticket's leg composition from its description (and declared picks when known).
 *
 * Classification order is deliberate: a cross-sport ticket is `cross_sport` even when legs span
 * events; a same-game ticket has one event; a same-sport multi-event ticket is `cross_game`;
 * a ticket that both repeats and varies events is `mixed`; anything with no recoverable event
 * identity is `unknown` rather than being guessed.
 */
export function describeWagerComposition(
  description: string | null | undefined,
  declaredPicks: number | null = null,
): WagerComposition {
  const legsText = splitWireLegs(description);
  const parsed = legsText.map((leg) => {
    try {
      return parseBetMarket(leg);
    } catch {
      return null;
    }
  });
  const legs = parsed.map(legSummary);
  const unparsedLegs = legs.filter((leg) => !leg.parsed).length;
  const sports = [
    ...new Set(
      legs
        .map((leg) => leg.sport)
        .filter((sport): sport is string => sport !== null),
    ),
  ];
  const events = [
    ...new Set(
      legs
        .map((leg) => leg.eventKey)
        .filter((event): event is string => event !== null),
    ),
  ];
  const excludedFutures =
    FUTURES_HINT.test(description ?? "") && sports.includes("Golf");
  const effectiveDeclared =
    declaredPicks !== null && Number.isFinite(declaredPicks)
      ? Math.trunc(declaredPicks)
      : null;
  const legCount =
    effectiveDeclared ?? (legsText.length > 0 ? legsText.length : 0);

  let kind: WagerCompositionKind;
  if (legCount <= 1) {
    kind = "single";
  } else if (sports.length > 1) {
    kind = "cross_sport";
  } else if (events.length === 1 && legsText.length > 1) {
    kind = "same_game";
  } else if (events.length > 1) {
    // If any two legs share an event while another differs, call it mixed (same-game +
    // cross-game tickets are a real shape and should not be rounded to cross_game).
    const perLeg = legs.map((leg) => leg.eventKey);
    const hasRepeat = perLeg.some(
      (event, index) => event !== null && perLeg.indexOf(event) !== index,
    );
    kind = hasRepeat ? "mixed" : "cross_game";
  } else {
    kind = "unknown";
  }

  return {
    declaredPicks: effectiveDeclared,
    splitLegs: legsText.length,
    legCount,
    kind,
    sports,
    events,
    unparsedLegs,
    excludedFutures,
    legs,
  };
}

/** Compact one-line label for reports and findings. */
export function compositionLabel(composition: WagerComposition): string {
  if (composition.excludedFutures) return "futures (excluded)";
  if (composition.kind === "single") return "single";
  return `${composition.kind} (${composition.legCount} legs, ${composition.sports.join("+") || "unknown sport"})`;
}
