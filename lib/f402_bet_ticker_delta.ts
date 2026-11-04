/**
 * @file f402_bet_ticker_delta.ts
 * @description Pure Bridge 3a projection: bounded channel/wager-type demux, once-per-ticket
 * dedupe, the ALERT zero-volume rule, the per-poll WS delta, and the sanitized R2 snapshot.
 *
 * Evidence for the row shape: the captured `getBetTicker` row carries 13 fields
 * (`docs/evidence/captures/2026-10-31/getBetTicker.post.json`): `AgentID`, `AgentLogin`,
 * `AmountWagered`, `CustomerID`, `InsertDateTime`, `Login`, `ShortDesc`, `TicketWriter`,
 * `ToWinAmount`, `VIP`, `VolumeAmount`, `WagerNumber`, `WagerType`. Two consequences that the
 * spec's wording does not state:
 *
 *  - There is no `TicketNumber` in this feed. `WagerNumber` is the ticket id here (see
 *    `lib/live_wagers.ts` and `docs/api-reference.md`), so the locked `${TicketNumber}-${WagerNumber}`
 *    key collapses to `${WagerNumber}` for every observed row and to the full two-part key if a
 *    future payload carries `TicketNumber`.
 *  - The channel is `TicketWriter`, not `ShortDesc` (observed: `Internet`, `ALERT`, `GSLIVE`,
 *    `GSBUILDER`). `ShortDesc` carries one line per leg and is parsed for the leg count only;
 *    the raw string never leaves this module.
 *
 * Money: `AmountWagered`/`ToWinAmount`/`VolumeAmount` are whole-dollar integers on the observed
 * data (a $3,500 wager with $2,188 volume), so canonical volume is `VolumeAmount × 100` computed
 * exactly. An ALERT row is a mirror of a real ticket, not handle: its canonical volume is zero.
 *
 * No identifier or free text is emitted. The snapshot and delta are asserted against a denylist
 * and an IP-literal scan before any sink sees them.
 */

import type { F402TickerRow } from "./f402_ingest.ts";
import { parseShortDesc } from "./live_wagers.ts";

/** The 11 bounded channel codes from the design note, plus the fail-closed `other`. */
export const F402_BET_TICKER_CHANNELS = [
  "Internet",
  "ALERT",
  "GSLIVE",
  "GSBUILDER",
  "LIVE_CWS",
  "CSLEVEL2",
  "PHONE",
  "HOUSE_BOOK",
  "GATEWAY",
  "BLOCKED",
  "NON_SPORTS_DROP",
] as const;

export type F402BetTickerChannel =
  (typeof F402_BET_TICKER_CHANNELS)[number] | "other";

/** The 8 bounded wager-type codes from the design note, plus the fail-closed `unknown`. */
export const F402_BET_TICKER_WAGER_TYPES = [
  "S",
  "M",
  "L",
  "E",
  "P",
  "T",
  "I",
  "G",
] as const;

export type F402BetTickerWagerType =
  (typeof F402_BET_TICKER_WAGER_TYPES)[number] | "unknown";

export const F402_BET_TICKER_KIND = "f402-bet-ticker";
export const F402_BET_TICKER_SCHEMA_VERSION = 1;
/** R2 snapshot key; the only mutable object for this stream (no daily rollup). */
export const F402_BET_TICKER_R2_KEY = "f402-bet-ticker/latest.json";
/** Gateway channel; `CHANNEL_PATTERN` in the gateway is `/^[a-z0-9-]{1,32}$/`. */
export const F402_BET_TICKER_LIVE_CHANNEL = "f402-bet-ticker";

const CHANNEL_BY_UPPER: ReadonlyMap<string, F402BetTickerChannel> = new Map(
  F402_BET_TICKER_CHANNELS.map((channel) => [channel.toUpperCase(), channel]),
);
const WAGER_TYPE_SET: ReadonlySet<string> = new Set(
  F402_BET_TICKER_WAGER_TYPES,
);
const CENTS_PER_DOLLAR = 100;
const MAX_ARTIFACT_BYTES = 256 * 1024;

/** Demux `TicketWriter` into a bounded channel code; unknown writers are `other`. */
export function demuxChannel(ticketWriter: unknown): F402BetTickerChannel {
  const raw = typeof ticketWriter === "string" ? ticketWriter.trim() : "";
  if (raw === "") return "other";
  return CHANNEL_BY_UPPER.get(raw.toUpperCase()) ?? "other";
}

/** Demux `WagerType` into a bounded code; anything outside the eight codes is `unknown`. */
export function demuxWagerType(wagerType: unknown): F402BetTickerWagerType {
  const raw =
    typeof wagerType === "string" ? wagerType.trim().toUpperCase() : "";
  return WAGER_TYPE_SET.has(raw) ? (raw as F402BetTickerWagerType) : "unknown";
}

/**
 * Sentinel channels: `ALERT` mirrors a real ticket, `BLOCKED` is a portal sentinel, and
 * `NON_SPORTS_DROP` is outside the accepted book. Their rows stay counted for observability
 * (`ticketCount`/`legCount`) but every money axis is pinned to zero, so none of them can enter
 * handle, risk, or to-win totals.
 */
export const F402_BET_TICKER_SENTINEL_CHANNELS = [
  "ALERT",
  "BLOCKED",
  "NON_SPORTS_DROP",
] as const;

export function isSentinelChannel(channel: F402BetTickerChannel): boolean {
  return (F402_BET_TICKER_SENTINEL_CHANNELS as readonly string[]).includes(
    channel,
  );
}

/**
 * The locked dedupe key. The ticker payload has no `TicketNumber`, so this is
 * `${wagerNumber}-${wagerNumber}` on every observed row unless a future payload carries
 * `TicketNumber`; the identical ALERT twin shares the key either way.
 */
export function ticketKey(row: F402TickerRow): string {
  const ticket =
    row.ticketNumber.trim() === ""
      ? row.wagerNumber.trim()
      : row.ticketNumber.trim();
  return `${ticket}-${row.wagerNumber.trim()}`;
}

/** Numeric wager number, or null when the row's value is not a non-negative integer. */
export function numericWagerNumber(row: F402TickerRow): number | null {
  const raw = row.wagerNumber.trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Exact dollars→cents for a whole-dollar ticker amount; absent/negative reads as zero. */
export function amountToCents(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * CENTS_PER_DOLLAR);
}

/** `VolumeAmount` in cents, pinned to zero for every sentinel channel. */
export function canonicalVolumeCents(row: F402TickerRow): number {
  return isSentinelChannel(demuxChannel(row.ticketWriter))
    ? 0
    : amountToCents(row.volumeAmount);
}

/** `AmountWagered` in cents, pinned to zero for every sentinel channel. */
export function canonicalRiskCents(row: F402TickerRow): number {
  return isSentinelChannel(demuxChannel(row.ticketWriter))
    ? 0
    : amountToCents(row.amountWagered);
}

/** `ToWinAmount` in cents, pinned to zero for every sentinel channel. */
export function canonicalToWinCents(row: F402TickerRow): number {
  return isSentinelChannel(demuxChannel(row.ticketWriter))
    ? 0
    : amountToCents(row.toWinAmount);
}

/** One deduped ticket: the non-sentinel owner carries money and legs; an ALERT twin is kept aside. */
interface DedupedTicket {
  readonly key: string;
  readonly owner: F402TickerRow;
  readonly alert: F402TickerRow | null;
  readonly channel: F402BetTickerChannel;
  readonly wagerType: F402BetTickerWagerType;
  readonly legCount: number;
  readonly canonicalVolumeCents: number;
  /** Internal money axes; unpublished, but pinned to zero for sentinel channels. */
  readonly riskCents: number;
  readonly toWinCents: number;
}

function legCountOf(row: F402TickerRow): number {
  return parseShortDesc(row.shortDesc).legs.length;
}

function makeTicket(
  key: string,
  owner: F402TickerRow,
  alert: F402TickerRow | null,
): DedupedTicket {
  return {
    key,
    owner,
    alert,
    channel: demuxChannel(owner.ticketWriter),
    wagerType: demuxWagerType(owner.wagerType),
    legCount: legCountOf(owner),
    canonicalVolumeCents: canonicalVolumeCents(owner),
    riskCents: canonicalRiskCents(owner),
    toWinCents: canonicalToWinCents(owner),
  };
}

/**
 * Dedupe once per ticket. A non-ALERT row owns the money and the legs; an ALERT row is an
 * alert-twin marker only. When only ALERT rows exist for a key, the first one is the owner and
 * its volume is zero by the ALERT rule.
 */
function dedupeTickets(
  rows: readonly F402TickerRow[],
): ReadonlyMap<string, DedupedTicket> {
  const tickets = new Map<string, DedupedTicket>();
  for (const row of rows) {
    const key = ticketKey(row);
    const channel = demuxChannel(row.ticketWriter);
    const existing = tickets.get(key);
    if (existing === undefined) {
      tickets.set(key, makeTicket(key, row, channel === "ALERT" ? row : null));
      continue;
    }
    if (channel === "ALERT") {
      tickets.set(key, { ...existing, alert: existing.alert ?? row });
      continue;
    }
    // The non-ALERT row owns the money; replace an ALERT-only ticket, keep the first real owner.
    if (demuxChannel(existing.owner.ticketWriter) === "ALERT") {
      tickets.set(key, makeTicket(key, row, existing.alert));
    }
  }
  return tickets;
}

const DESK_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

/** The desk calendar day and hour in America/Chicago, never the raw timestamp. */
export function deskClock(polledAt: string): {
  readonly deskDate: string;
  readonly deskHour: number;
} {
  const date = new Date(polledAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`projectF402TickerDelta: invalid polledAt ${polledAt}`);
  }
  const TemporalApi = (
    globalThis as {
      Temporal?: {
        Instant?: {
          fromEpochMilliseconds(ms: number): {
            toZonedDateTimeISO(zone: string): {
              year: number;
              month: number;
              day: number;
              hour: number;
            };
          };
        };
      };
    }
  ).Temporal;
  if (TemporalApi?.Instant !== undefined) {
    const zoned = TemporalApi.Instant.fromEpochMilliseconds(
      date.getTime(),
    ).toZonedDateTimeISO("America/Chicago");
    const pad = (n: number): string => String(n).padStart(2, "0");
    return {
      deskDate: `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`,
      deskHour: zoned.hour,
    };
  }
  const parts = DESK_FORMAT.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    deskDate: `${part("year")}-${part("month")}-${part("day")}`,
    deskHour: Number(part("hour")),
  };
}

/** Deterministic JSON: object keys sorted at every depth, so hashes are stable. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** SHA-256 of the canonical sanitized artifact text (Bun runtime; the service is Bun). */
export function sha256Hex(text: string): string {
  return Bun.CryptoHasher.hash("sha256", text, "hex");
}

export interface F402TickerChannelAggregate {
  readonly channel: F402BetTickerChannel;
  readonly ticketCount: number;
  readonly legCount: number;
  readonly canonicalVolumeCents: number;
}

export interface F402TickerWagerTypeAggregate {
  readonly wagerType: F402BetTickerWagerType;
  readonly ticketCount: number;
  readonly legCount: number;
}

/** The locked WS delta contract (`docs/design/bridge3a_f402_betticker.md`). */
export interface F402TickerDeltaEvent {
  readonly schemaVersion: typeof F402_BET_TICKER_SCHEMA_VERSION;
  readonly kind: typeof F402_BET_TICKER_KIND;
  readonly polledAt: string;
  readonly deskDate: string;
  readonly deskHour: number;
  readonly watermark: string;
  readonly newTickets: number;
  readonly goneTickets: number;
  readonly changedTickets: number;
  readonly alertTwinCount: number;
  readonly confirmCount: number;
  readonly lateCount: number;
  readonly orphanCount: number;
  readonly byChannel: readonly F402TickerChannelAggregate[];
  readonly byWagerType: readonly F402TickerWagerTypeAggregate[];
  readonly sourceSha256: string;
}

/** The locked R2 snapshot: same bounded aggregates plus row totals, no delta counts. */
export interface F402TickerSnapshot {
  readonly schemaVersion: typeof F402_BET_TICKER_SCHEMA_VERSION;
  readonly kind: typeof F402_BET_TICKER_KIND;
  readonly generatedAt: string;
  readonly deskDate: string;
  readonly deskHour: number;
  readonly watermark: string;
  readonly rowCount: number;
  readonly ticketCount: number;
  readonly legCount: number;
  readonly alertTwinCount: number;
  readonly confirmCount: number;
  readonly lateCount: number;
  readonly orphanCount: number;
  readonly byChannel: readonly F402TickerChannelAggregate[];
  readonly byWagerType: readonly F402TickerWagerTypeAggregate[];
  readonly sourceSha256: string;
}

function channelRank(channel: F402BetTickerChannel): number {
  const index = F402_BET_TICKER_CHANNELS.indexOf(
    channel as (typeof F402_BET_TICKER_CHANNELS)[number],
  );
  return index === -1 ? F402_BET_TICKER_CHANNELS.length : index;
}

function wagerTypeRank(wagerType: F402BetTickerWagerType): number {
  const index = F402_BET_TICKER_WAGER_TYPES.indexOf(
    wagerType as (typeof F402_BET_TICKER_WAGER_TYPES)[number],
  );
  return index === -1 ? F402_BET_TICKER_WAGER_TYPES.length : index;
}

function aggregateChannels(
  tickets: ReadonlyMap<string, DedupedTicket>,
): F402TickerChannelAggregate[] {
  const byChannel = new Map<F402BetTickerChannel, F402TickerChannelAggregate>();
  for (const ticket of tickets.values()) {
    const current = byChannel.get(ticket.channel) ?? {
      channel: ticket.channel,
      ticketCount: 0,
      legCount: 0,
      canonicalVolumeCents: 0,
    };
    byChannel.set(ticket.channel, {
      channel: ticket.channel,
      ticketCount: current.ticketCount + 1,
      legCount: current.legCount + ticket.legCount,
      canonicalVolumeCents:
        current.canonicalVolumeCents + ticket.canonicalVolumeCents,
    });
  }
  return [...byChannel.values()].sort(
    (left, right) => channelRank(left.channel) - channelRank(right.channel),
  );
}

function aggregateWagerTypes(
  tickets: ReadonlyMap<string, DedupedTicket>,
): F402TickerWagerTypeAggregate[] {
  const byType = new Map<
    F402BetTickerWagerType,
    F402TickerWagerTypeAggregate
  >();
  for (const ticket of tickets.values()) {
    const current = byType.get(ticket.wagerType) ?? {
      wagerType: ticket.wagerType,
      ticketCount: 0,
      legCount: 0,
    };
    byType.set(ticket.wagerType, {
      wagerType: ticket.wagerType,
      ticketCount: current.ticketCount + 1,
      legCount: current.legCount + ticket.legCount,
    });
  }
  return [...byType.values()].sort(
    (left, right) =>
      wagerTypeRank(left.wagerType) - wagerTypeRank(right.wagerType),
  );
}

/** Highest numeric wager number across rows, or 0 when none carries one. */
export function highestWagerNumber(rows: readonly F402TickerRow[]): number {
  let highest = 0;
  for (const row of rows) {
    const value = numericWagerNumber(row);
    if (value !== null && value > highest) highest = value;
  }
  return highest;
}

/**
 * Project one completed poll into the WS delta.
 *
 * `previous` is the previous poll's fully-drained row set; on a cold start it is empty and every
 * current ticket reads as new. Counts are deduped once per ticket; ALERT rows add no money and
 * are classified as confirmed (twin in this batch), late (twin arrived after the alert) or
 * orphan (no twin yet).
 */
export function projectF402TickerDelta(
  previous: readonly F402TickerRow[],
  current: readonly F402TickerRow[],
  polledAt: string,
): F402TickerDeltaEvent {
  const before = dedupeTickets(previous);
  const after = dedupeTickets(current);

  let newTickets = 0;
  let changedTickets = 0;
  for (const [key, ticket] of after) {
    const old = before.get(key);
    if (old === undefined) {
      newTickets += 1;
      continue;
    }
    if (
      old.channel !== ticket.channel ||
      old.wagerType !== ticket.wagerType ||
      old.legCount !== ticket.legCount ||
      old.canonicalVolumeCents !== ticket.canonicalVolumeCents ||
      old.riskCents !== ticket.riskCents ||
      old.toWinCents !== ticket.toWinCents
    ) {
      changedTickets += 1;
    }
  }
  let goneTickets = 0;
  for (const key of before.keys()) {
    if (!after.has(key)) goneTickets += 1;
  }

  // An alert that had no twin in the previous poll and gains one now is a late confirm.
  const previousAlertOnly = new Set<string>();
  for (const [key, ticket] of before) {
    if (
      ticket.alert !== null &&
      demuxChannel(ticket.owner.ticketWriter) === "ALERT"
    ) {
      previousAlertOnly.add(key);
    }
  }
  let alertTwinCount = 0;
  let confirmCount = 0;
  let lateCount = 0;
  let orphanCount = 0;
  for (const [key, ticket] of after) {
    if (ticket.alert === null) continue;
    alertTwinCount += 1;
    if (demuxChannel(ticket.owner.ticketWriter) !== "ALERT") {
      if (previousAlertOnly.has(key)) lateCount += 1;
      else confirmCount += 1;
    } else {
      orphanCount += 1;
    }
  }

  const { deskDate, deskHour } = deskClock(polledAt);
  const watermark = String(
    Math.max(highestWagerNumber(current), highestWagerNumber(previous)),
  );

  const payload = {
    schemaVersion: F402_BET_TICKER_SCHEMA_VERSION,
    kind: F402_BET_TICKER_KIND,
    polledAt,
    deskDate,
    deskHour,
    watermark,
    newTickets,
    goneTickets,
    changedTickets,
    alertTwinCount,
    confirmCount,
    lateCount,
    orphanCount,
    byChannel: aggregateChannels(after),
    byWagerType: aggregateWagerTypes(after),
  } as const;

  return { ...payload, sourceSha256: sha256Hex(stableJson(payload)) };
}

/** Build the sanitized R2 snapshot from a delta plus the raw row count of its drain. */
export function buildF402TickerSnapshot(
  event: F402TickerDeltaEvent,
  rowCount: number,
): F402TickerSnapshot {
  const byChannel = event.byChannel;
  const byWagerType = event.byWagerType;
  const payload = {
    schemaVersion: F402_BET_TICKER_SCHEMA_VERSION,
    kind: F402_BET_TICKER_KIND,
    generatedAt: event.polledAt,
    deskDate: event.deskDate,
    deskHour: event.deskHour,
    watermark: event.watermark,
    rowCount,
    ticketCount: byChannel.reduce(
      (total, entry) => total + entry.ticketCount,
      0,
    ),
    legCount: byChannel.reduce((total, entry) => total + entry.legCount, 0),
    alertTwinCount: event.alertTwinCount,
    confirmCount: event.confirmCount,
    lateCount: event.lateCount,
    orphanCount: event.orphanCount,
    byChannel,
    byWagerType,
  } as const;
  return { ...payload, sourceSha256: sha256Hex(stableJson(payload)) };
}

const FORBIDDEN_KEY =
  /^(login|customerid|customer|agentid|agentlogin|agent|ticketnumber|wagernumber|ticketwriter|shortdesc|insertedat|insertdatetime|amountwagered|towinamount|volumeamount|ipaddress|ip|payloadsha256)$/i;
const IPV4_LITERAL = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6_LITERAL = /(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}/i;

function assertNoForbiddenKeys(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(
        `sanitized ticker artifact carries forbidden key "${key}"`,
      );
    }
    assertNoForbiddenKeys(child);
  }
}

/**
 * Fail-closed guard for both sinks: under 256 KiB, no denylisted key, no IP literal. It does not
 * prove the artifact is safe; construction never puts a raw row in it.
 */
export function assertSanitizedTickerArtifact(artifact: unknown): void {
  const text = stableJson(artifact);
  if (new TextEncoder().encode(text).byteLength > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `sanitized ticker artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`,
    );
  }
  assertNoForbiddenKeys(artifact);
  if (IPV4_LITERAL.test(text) || IPV6_LITERAL.test(text)) {
    throw new Error("sanitized ticker artifact carries an IP literal");
  }
}
