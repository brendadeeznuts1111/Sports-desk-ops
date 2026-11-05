/**
 * @file live_ticket_view.ts
 * @description PII-free projection of a `getBetTicker` wager for CLIs, JSON responses and
 * dashboards. The parser's `LiveWager` keeps the wire's field names and raw leg line; this view
 * is the stable public shape: ticket id as a string, channel as `product`, desk-zone ISO time,
 * and legs split into `eventName` / `period` / `market` / `selection` / `price`.
 *
 * Customer logins, customer ids and agent logins never cross this boundary. `writer` is always
 * `null`; `product` carries the channel that `TicketWriter` named.
 */

import { wagerTypeLabel } from "./game_admin.ts";
import { portalWallClockIso } from "./gslive_manager_deeplink_sidecar.ts";
import {
  toLiveWager,
  type LiveWager,
  type LiveWagerLeg,
} from "./live_wagers.ts";

export interface NormalizedTicketLeg {
  /** 1-based position in the ticket. */
  readonly index: number;
  readonly sport: string;
  readonly eventName: string;
  readonly period: string;
  readonly market: string;
  /** The pick with the American price removed: `"Los Angeles Rams"`. */
  readonly selection: string;
  /** `"-140"`; `null` when the line carried no price. */
  readonly price: string | null;
  readonly live: boolean;
  readonly gameNumber: string | null;
}

export interface NormalizedTicket {
  /** Ticket ids are identifiers, not quantities; keep them as strings. */
  readonly wagerNumber: string;
  /** `GSLIVE`, `GSBUILDER`, `INTERNET`, `ALERT`, … from `TicketWriter`. */
  readonly product: string;
  readonly wagerType: string;
  readonly wagerTypeLabel: string;
  readonly phase: "live" | "pregame";
  readonly live: boolean;
  readonly vip: boolean;
  /** Dollars, as printed by the portal. */
  readonly stake: number;
  readonly toWin: number;
  /** Volume override; `null` when the wire volume equals the stake. */
  readonly volume: number | null;
  /** Portal wall-clock converted from the desk zone (`America/Chicago`). */
  readonly insertedAt: string | null;
  /** `P.G319747616` — the game code line, safe to keep and useful for joins. */
  readonly descCode: string | null;
  /** Always `null`: agent/writer identity is not part of the public view. */
  readonly writer: null;
  readonly ticketWriter: string;
  readonly legs: readonly NormalizedTicketLeg[];
  readonly source: string;
  readonly provenance: {
    readonly file: string | null;
    readonly capturedAt: string | null;
  };
}

export interface NormalizedTicketMeta {
  /** Artifact the row came from (`--file`), for provenance. */
  readonly file?: string | null;
  /** Artifact `source`; defaults to `unlabelled`. */
  readonly source?: string;
  /** Artifact `observedAt`; defaults to `null`. */
  readonly capturedAt?: string | null;
}

const AMERICAN_PRICE = /\s([+-]\d+)$/;

/** `"Los Angeles Rams -140"` → `{ selection: "Los Angeles Rams", price: "-140" }`. */
export function splitPickPrice(pick: string): {
  selection: string;
  price: string | null;
} {
  const trimmed = pick.trim();
  const match = AMERICAN_PRICE.exec(trimmed);
  if (match === null || match.index === 0) {
    return { selection: trimmed, price: null };
  }
  return {
    selection: trimmed.slice(0, match.index).trim(),
    price: match[1] ?? null,
  };
}

function normalizeLeg(leg: LiveWagerLeg, index: number): NormalizedTicketLeg {
  const { selection, price } = splitPickPrice(leg.pick);
  return {
    index,
    sport: leg.sport,
    eventName: leg.game,
    period: leg.period,
    market: leg.market,
    selection,
    price,
    live: leg.live,
    gameNumber: leg.gameNumber,
  };
}

function isLiveWager(
  value: LiveWager | Record<string, unknown>,
): value is LiveWager {
  const candidate = value as Partial<LiveWager>;
  return (
    typeof candidate.wagerNumber === "number" && Array.isArray(candidate.legs)
  );
}

/**
 * Accepts a raw `LIST` row or an already-parsed `LiveWager`.
 *
 *   normalizeTicket(fixture[0], { file: "tests/fixtures/live-wagers-list-sample.json" })
 */
export function normalizeTicket(
  input: LiveWager | Record<string, unknown>,
  meta: NormalizedTicketMeta = {},
): NormalizedTicket {
  const wager = isLiveWager(input) ? input : toLiveWager(input);
  const ticketWriter = wager.ticketWriter.trim();
  return {
    wagerNumber: String(wager.wagerNumber),
    product: ticketWriter === "" ? "OTHER" : ticketWriter.toUpperCase(),
    wagerType: wager.wagerType,
    wagerTypeLabel: wagerTypeLabel(wager.wagerType),
    phase: wager.live ? "live" : "pregame",
    live: wager.live,
    vip: wager.vip,
    stake: wager.amountWagered,
    toWin: wager.toWinAmount,
    volume: wager.volumeDiffers ? wager.volumeAmount : null,
    insertedAt: portalWallClockIso(wager.insertedAt),
    descCode: wager.descCode,
    writer: null,
    ticketWriter,
    legs: wager.legs.map((leg, index) => normalizeLeg(leg, index + 1)),
    source: meta.source ?? "unlabelled",
    provenance: {
      file: meta.file ?? null,
      capturedAt: meta.capturedAt ?? null,
    },
  };
}
