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
import { countShortDescLegs } from "./live_wagers.ts";

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

export {
  F402_BET_TICKER_BINARY_SCHEMA_VERSION,
  F402_BET_TICKER_BINARY_PAYLOAD_KIND,
  F402_BET_TICKER_BINARY_FLAGS_LE,
  F402_BET_TICKER_BINARY_BUFFER_BYTES,
  F402_BET_TICKER_JSON_BYTE0,
  F402_BET_TICKER_BINARY_BYTE0,
  F402_BET_TICKER_R2_BINARY_KEY,
  SchemaVersionMismatchError,
  encodeF402TickerBinarySnapshot,
  decodeF402TickerBinarySnapshot,
  parseF402TickerSnapshotOrBinary,
} from "./f402_bet_ticker_binary.ts";

export const ORD_CHANNEL_UNKNOWN = 0;
export const ORD_CHANNEL_INTERNET = 1;
export const ORD_CHANNEL_ALERT = 2;
export const ORD_CHANNEL_GSLIVE = 3;
export const ORD_CHANNEL_GSBUILDER = 4;
export const ORD_CHANNEL_LIVE_CWS = 5;
export const ORD_CHANNEL_CSLEVEL2 = 6;
export const ORD_CHANNEL_PHONE = 7;
export const ORD_CHANNEL_HOUSE_BOOK = 8;
export const ORD_CHANNEL_GATEWAY = 9;
export const ORD_CHANNEL_BLOCKED = 10;
export const ORD_CHANNEL_NON_SPORTS_DROP = 11;

export const CHANNEL_BY_ORDINAL: readonly F402BetTickerChannel[] = [
  "other",
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
];

export const CHANNEL_RANK_ORDINALS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0,
];

export const ORD_WAGER_TYPE_UNKNOWN = 0;
export const ORD_WAGER_TYPE_S = 1;
export const ORD_WAGER_TYPE_M = 2;
export const ORD_WAGER_TYPE_L = 3;
export const ORD_WAGER_TYPE_E = 4;
export const ORD_WAGER_TYPE_P = 5;
export const ORD_WAGER_TYPE_T = 6;
export const ORD_WAGER_TYPE_I = 7;
export const ORD_WAGER_TYPE_G = 8;

export const WAGER_TYPE_BY_ORDINAL: readonly F402BetTickerWagerType[] = [
  "unknown",
  "S",
  "M",
  "L",
  "E",
  "P",
  "T",
  "I",
  "G",
];

export const WAGER_TYPE_RANK_ORDINALS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 0,
];

export const CHANNEL_ORDINAL_COUNT = CHANNEL_BY_ORDINAL.length;
export const WAGER_TYPE_ORDINAL_COUNT = WAGER_TYPE_BY_ORDINAL.length;

if (
  CHANNEL_BY_ORDINAL.length !== CHANNEL_RANK_ORDINALS.length ||
  WAGER_TYPE_BY_ORDINAL.length !== WAGER_TYPE_RANK_ORDINALS.length
) {
  throw new Error(
    "Bridge 3a ordinal table length mismatch with rank ordinals: check channel/wagerType declarations",
  );
}

const CENTS_PER_DOLLAR = 100;
const MAX_ARTIFACT_BYTES = 256 * 1024;

/** Demux `TicketWriter` to bounded channel ordinal; unknown writers map to `ORD_CHANNEL_UNKNOWN` (0). */
export function ticketWriterToChannelOrdinal(ticketWriter: unknown): number {
  if (typeof ticketWriter !== "string") return ORD_CHANNEL_UNKNOWN;
  const raw = ticketWriter.trim().toUpperCase();
  switch (raw) {
    case "INTERNET":
      return ORD_CHANNEL_INTERNET;
    case "ALERT":
      return ORD_CHANNEL_ALERT;
    case "GSLIVE":
      return ORD_CHANNEL_GSLIVE;
    case "GSBUILDER":
      return ORD_CHANNEL_GSBUILDER;
    case "LIVE_CWS":
      return ORD_CHANNEL_LIVE_CWS;
    case "CSLEVEL2":
      return ORD_CHANNEL_CSLEVEL2;
    case "PHONE":
      return ORD_CHANNEL_PHONE;
    case "HOUSE_BOOK":
      return ORD_CHANNEL_HOUSE_BOOK;
    case "GATEWAY":
      return ORD_CHANNEL_GATEWAY;
    case "BLOCKED":
      return ORD_CHANNEL_BLOCKED;
    case "NON_SPORTS_DROP":
      return ORD_CHANNEL_NON_SPORTS_DROP;
    default:
      return ORD_CHANNEL_UNKNOWN;
  }
}

/** Demux `TicketWriter` into a bounded channel code; unknown writers are `other`. */
export function demuxChannel(ticketWriter: unknown): F402BetTickerChannel {
  return CHANNEL_BY_ORDINAL[ticketWriterToChannelOrdinal(ticketWriter)]!;
}

/** Demux `WagerType` to bounded wager type ordinal; unknown types map to `ORD_WAGER_TYPE_UNKNOWN` (0). */
export function demuxWagerTypeOrdinal(wagerType: unknown): number {
  if (typeof wagerType !== "string") return ORD_WAGER_TYPE_UNKNOWN;
  const raw = wagerType.trim().toUpperCase();
  switch (raw) {
    case "S":
      return ORD_WAGER_TYPE_S;
    case "M":
      return ORD_WAGER_TYPE_M;
    case "L":
      return ORD_WAGER_TYPE_L;
    case "E":
      return ORD_WAGER_TYPE_E;
    case "P":
      return ORD_WAGER_TYPE_P;
    case "T":
      return ORD_WAGER_TYPE_T;
    case "I":
      return ORD_WAGER_TYPE_I;
    case "G":
      return ORD_WAGER_TYPE_G;
    default:
      return ORD_WAGER_TYPE_UNKNOWN;
  }
}

/** Demux `WagerType` into a bounded code; anything outside the eight codes is `unknown`. */
export function demuxWagerType(wagerType: unknown): F402BetTickerWagerType {
  return WAGER_TYPE_BY_ORDINAL[demuxWagerTypeOrdinal(wagerType)]!;
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

/** Maximum cents representable in a 32-bit signed integer (~$21.47 Million). */
export const MAX_INT32_CENTS = 2_147_483_647;

/** Maximum legs representable in a 16-bit unsigned integer (65,535). */
export const MAX_UINT16_LEGS = 65_535;

/** Maximum numeric wager number representable in a 32-bit unsigned integer (~4.29 Billion). */
export const MAX_UINT32_WAGER_NUMBER = 4_294_967_295;

/** Numeric wager number, or null when the row's value is not a non-negative integer within Uint32 bounds. */
export function numericWagerNumber(row: F402TickerRow): number | null {
  const raw = row.wagerNumber.trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_UINT32_WAGER_NUMBER
    ? value
    : null;
}

/** Exact dollars→cents for a whole-dollar ticker amount; absent/negative reads as zero. */
export function amountToCents(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value < 0) return 0;
  const cents = Math.round(value * CENTS_PER_DOLLAR);
  if (!Number.isSafeInteger(cents) || cents > MAX_INT32_CENTS) {
    throw new RangeError(
      `amountToCents: amount ${value} (${cents} cents) overflows Int32Array boundary (${MAX_INT32_CENTS} cents / ~$21.47M)`,
    );
  }
  return cents;
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

export const BRIDGE3A_FLAG_IS_ALERT = 1 << 0;
export const BRIDGE3A_FLAG_IS_SENTINEL = 1 << 1;
export const BRIDGE3A_FLAG_HAS_ALERT_TWIN = 1 << 2;
export const BRIDGE3A_FLAG_IS_CONFIRMED = 1 << 3;
export const BRIDGE3A_FLAG_IS_LATE = 1 << 4;
export const BRIDGE3A_FLAG_IS_ORPHAN = 1 << 5;

export function isSentinelChannelOrdinal(ordinal: number): boolean {
  return (
    ordinal === ORD_CHANNEL_ALERT ||
    ordinal === ORD_CHANNEL_BLOCKED ||
    ordinal === ORD_CHANNEL_NON_SPORTS_DROP
  );
}

export function legCountOf(row: F402TickerRow): number {
  const count = countShortDescLegs(row.shortDesc);
  return count > MAX_UINT16_LEGS ? MAX_UINT16_LEGS : count;
}

/**
 * 32-bit FNV-1a hash for open-addressed slot lookups.
 * Paired with full-string key equality on collision probes to guarantee distinct ticket isolation.
 */
function hashKey(key: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Fixed-capacity open-addressed slot table and SoA column store for Bridge 3a.
 * Avoids collection allocations (Map, Set, dense boolean arrays) on the dedupe & aggregation path.
 * String columns (login, agentLogin, shortDesc, ticketWriter) stay in a narrow side-channel.
 */
export class Bridge3aTicketColumnStore {
  public readonly capacity: number;
  public readonly slotCount: number;
  public readonly slotMask: number;
  public count: number = 0;
  public highestNumericWagerNumber: number = 0;
  public overflowRejectionCount: number = 0;

  public readonly slots: Uint32Array;
  public readonly routeFlagsBitSet32Col: Uint32Array;
  public readonly channelOrdinalCol: Uint8Array;
  public readonly wagerTypeOrdinalCol: Uint8Array;
  public readonly legCountCol: Uint16Array;
  public readonly canonicalVolumeCentsCol: Int32Array;
  public readonly riskCentsCol: Int32Array;
  public readonly toWinCentsCol: Int32Array;
  public readonly wagerNumberCol: Uint32Array;
  public readonly keyCol: string[];
  public readonly rawStringsCol: Array<{
    readonly login: string;
    readonly agentLogin: string;
    readonly shortDesc: string;
    readonly ticketWriter: string;
  } | null>;

  constructor(capacity: number) {
    this.capacity = capacity;
    const rawSlots = Math.max(
      16,
      1 << (32 - Math.clz32(Math.max(1, capacity * 4) - 1)),
    );
    this.slotCount = rawSlots;
    this.slotMask = rawSlots - 1;
    this.slots = new Uint32Array(rawSlots);
    this.routeFlagsBitSet32Col = new Uint32Array(capacity);
    this.channelOrdinalCol = new Uint8Array(capacity);
    this.wagerTypeOrdinalCol = new Uint8Array(capacity);
    this.legCountCol = new Uint16Array(capacity);
    this.canonicalVolumeCentsCol = new Int32Array(capacity);
    this.riskCentsCol = new Int32Array(capacity);
    this.toWinCentsCol = new Int32Array(capacity);
    this.wagerNumberCol = new Uint32Array(capacity);
    this.keyCol = Array.from<string>({ length: capacity });
    this.rawStringsCol = Array.from({ length: capacity });
  }

  public lookup(key: string): number {
    const h = hashKey(key);
    let slot = h & this.slotMask;
    for (let probe = 0; probe < this.slotCount; probe++) {
      const entry = this.slots[slot]!;
      if (entry === 0) return -1;
      const idx = entry - 1;
      if (this.keyCol[idx] === key) return idx;
      slot = (slot + 1) & this.slotMask;
    }
    return -1;
  }

  public insertOrUpdate(row: F402TickerRow): number {
    const numWager = numericWagerNumber(row);
    if (numWager !== null && numWager > this.highestNumericWagerNumber) {
      this.highestNumericWagerNumber = numWager;
    }

    const key = ticketKey(row);
    const h = hashKey(key);
    let slot = h & this.slotMask;
    let foundIndex = -1;

    for (let probe = 0; probe < this.slotCount; probe++) {
      const entry = this.slots[slot]!;
      if (entry === 0) break;
      const idx = entry - 1;
      if (this.keyCol[idx] === key) {
        foundIndex = idx;
        break;
      }
      slot = (slot + 1) & this.slotMask;
    }

    const chOrd = ticketWriterToChannelOrdinal(row.ticketWriter);
    const isAlertRow = chOrd === ORD_CHANNEL_ALERT;
    const isSentinel = isSentinelChannelOrdinal(chOrd);

    // Guard amounts against Int32 overflow; reject corrupt row without aborting the batch
    let volCents = 0;
    let riskCents = 0;
    let winCents = 0;
    if (!isSentinel) {
      try {
        volCents = amountToCents(row.volumeAmount);
        riskCents = amountToCents(row.amountWagered);
        winCents = amountToCents(row.toWinAmount);
      } catch (err) {
        if (err instanceof RangeError) {
          this.overflowRejectionCount += 1;
          return -1;
        }
        throw err;
      }
    }

    if (foundIndex === -1) {
      if (this.count >= this.capacity) {
        throw new Error(
          `Bridge3aTicketColumnStore capacity exhausted at ${this.capacity}`,
        );
      }
      const index = this.count++;
      this.slots[slot] = index + 1;
      this.keyCol[index] = key;
      this.channelOrdinalCol[index] = chOrd;
      this.wagerTypeOrdinalCol[index] = demuxWagerTypeOrdinal(row.wagerType);
      this.legCountCol[index] = legCountOf(row);
      this.wagerNumberCol[index] = numWager ?? 0;
      this.rawStringsCol[index] = {
        login: row.login,
        agentLogin: row.agentLogin,
        shortDesc: row.shortDesc,
        ticketWriter: row.ticketWriter,
      };

      let flags = 0;
      if (isAlertRow) {
        flags |=
          BRIDGE3A_FLAG_IS_ALERT |
          BRIDGE3A_FLAG_HAS_ALERT_TWIN |
          BRIDGE3A_FLAG_IS_ORPHAN;
      }
      if (isSentinel) {
        flags |= BRIDGE3A_FLAG_IS_SENTINEL;
      }
      this.routeFlagsBitSet32Col[index] = flags;

      this.canonicalVolumeCentsCol[index] = volCents;
      this.riskCentsCol[index] = riskCents;
      this.toWinCentsCol[index] = winCents;
      return index;
    }

    const currentFlags = this.routeFlagsBitSet32Col[foundIndex]!;
    if (isAlertRow) {
      this.routeFlagsBitSet32Col[foundIndex] =
        currentFlags | BRIDGE3A_FLAG_HAS_ALERT_TWIN;
      return foundIndex;
    }

    if ((currentFlags & BRIDGE3A_FLAG_IS_ALERT) !== 0) {
      this.channelOrdinalCol[foundIndex] = chOrd;
      this.wagerTypeOrdinalCol[foundIndex] = demuxWagerTypeOrdinal(
        row.wagerType,
      );
      this.legCountCol[foundIndex] = legCountOf(row);
      this.rawStringsCol[foundIndex] = {
        login: row.login,
        agentLogin: row.agentLogin,
        shortDesc: row.shortDesc,
        ticketWriter: row.ticketWriter,
      };

      let newFlags =
        (currentFlags & ~BRIDGE3A_FLAG_IS_ALERT) | BRIDGE3A_FLAG_HAS_ALERT_TWIN;
      if (isSentinel) {
        newFlags |= BRIDGE3A_FLAG_IS_SENTINEL;
      } else {
        newFlags &= ~BRIDGE3A_FLAG_IS_SENTINEL;
      }
      this.routeFlagsBitSet32Col[foundIndex] = newFlags;

      this.canonicalVolumeCentsCol[foundIndex] = volCents;
      this.riskCentsCol[foundIndex] = riskCents;
      this.toWinCentsCol[foundIndex] = winCents;
    }
    return foundIndex;
  }
}

export function serializeChannelAggregate(
  agg: F402TickerChannelAggregate,
): string {
  return `{"canonicalVolumeCents":${agg.canonicalVolumeCents},"channel":${JSON.stringify(agg.channel)},"legCount":${agg.legCount},"ticketCount":${agg.ticketCount}}`;
}

export function serializeWagerTypeAggregate(
  agg: F402TickerWagerTypeAggregate,
): string {
  return `{"legCount":${agg.legCount},"ticketCount":${agg.ticketCount},"wagerType":${JSON.stringify(agg.wagerType)}}`;
}

export function serializeF402TickerDeltaPayload(
  payload: Omit<F402TickerDeltaEvent, "sourceSha256">,
): string {
  let byChannelJson = "";
  for (let i = 0; i < payload.byChannel.length; i++) {
    if (i > 0) byChannelJson += ",";
    byChannelJson += serializeChannelAggregate(payload.byChannel[i]!);
  }
  let byWagerTypeJson = "";
  for (let i = 0; i < payload.byWagerType.length; i++) {
    if (i > 0) byWagerTypeJson += ",";
    byWagerTypeJson += serializeWagerTypeAggregate(payload.byWagerType[i]!);
  }
  return (
    `{"alertTwinCount":${payload.alertTwinCount}` +
    `,"byChannel":[${byChannelJson}]` +
    `,"byWagerType":[${byWagerTypeJson}]` +
    `,"changedTickets":${payload.changedTickets}` +
    `,"confirmCount":${payload.confirmCount}` +
    `,"deskDate":${JSON.stringify(payload.deskDate)}` +
    `,"deskHour":${payload.deskHour}` +
    `,"goneTickets":${payload.goneTickets}` +
    `,"kind":${JSON.stringify(payload.kind)}` +
    `,"lateCount":${payload.lateCount}` +
    `,"newTickets":${payload.newTickets}` +
    `,"orphanCount":${payload.orphanCount}` +
    `,"polledAt":${JSON.stringify(payload.polledAt)}` +
    `,"schemaVersion":${payload.schemaVersion}` +
    `,"watermark":${JSON.stringify(payload.watermark)}}`
  );
}

export function serializeF402TickerSnapshotPayload(
  payload: Omit<F402TickerSnapshot, "sourceSha256">,
): string {
  let byChannelJson = "";
  for (let i = 0; i < payload.byChannel.length; i++) {
    if (i > 0) byChannelJson += ",";
    byChannelJson += serializeChannelAggregate(payload.byChannel[i]!);
  }
  let byWagerTypeJson = "";
  for (let i = 0; i < payload.byWagerType.length; i++) {
    if (i > 0) byWagerTypeJson += ",";
    byWagerTypeJson += serializeWagerTypeAggregate(payload.byWagerType[i]!);
  }
  return (
    `{"alertTwinCount":${payload.alertTwinCount}` +
    `,"byChannel":[${byChannelJson}]` +
    `,"byWagerType":[${byWagerTypeJson}]` +
    `,"confirmCount":${payload.confirmCount}` +
    `,"deskDate":${JSON.stringify(payload.deskDate)}` +
    `,"deskHour":${payload.deskHour}` +
    `,"generatedAt":${JSON.stringify(payload.generatedAt)}` +
    `,"kind":${JSON.stringify(payload.kind)}` +
    `,"lateCount":${payload.lateCount}` +
    `,"legCount":${payload.legCount}` +
    `,"orphanCount":${payload.orphanCount}` +
    `,"rowCount":${payload.rowCount}` +
    `,"schemaVersion":${payload.schemaVersion}` +
    `,"ticketCount":${payload.ticketCount}` +
    `,"watermark":${JSON.stringify(payload.watermark)}}`
  );
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
 *
 * Implements strict zero-collection allocation on the dedupe & aggregation path:
 * open-addressed hash slots, SoA TypedArray columns, per-row bitset flags, and bounded ordinal tables.
 */
export interface F402TickerBatchDiagnostics {
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly overflowRejectionCount: number;
}

/**
 * Projects a delta event directly from populated column stores.
 * Shared between standard and diagnostic projection paths to avoid code duplication.
 */
export function projectF402TickerDeltaFromStores(
  beforeStore: Bridge3aTicketColumnStore,
  afterStore: Bridge3aTicketColumnStore,
  polledAt: string,
): F402TickerDeltaEvent {
  let newTickets = 0;
  let changedTickets = 0;
  for (let i = 0; i < afterStore.count; i++) {
    const key = afterStore.keyCol[i]!;
    const beforeIdx = beforeStore.lookup(key);
    if (beforeIdx === -1) {
      newTickets += 1;
      continue;
    }
    if (
      afterStore.channelOrdinalCol[i] !==
        beforeStore.channelOrdinalCol[beforeIdx] ||
      afterStore.wagerTypeOrdinalCol[i] !==
        beforeStore.wagerTypeOrdinalCol[beforeIdx] ||
      afterStore.legCountCol[i] !== beforeStore.legCountCol[beforeIdx] ||
      afterStore.canonicalVolumeCentsCol[i] !==
        beforeStore.canonicalVolumeCentsCol[beforeIdx] ||
      afterStore.riskCentsCol[i] !== beforeStore.riskCentsCol[beforeIdx] ||
      afterStore.toWinCentsCol[i] !== beforeStore.toWinCentsCol[beforeIdx]
    ) {
      changedTickets += 1;
    }
  }
  let goneTickets = 0;
  for (let i = 0; i < beforeStore.count; i++) {
    if (afterStore.lookup(beforeStore.keyCol[i]!) === -1) goneTickets += 1;
  }

  let alertTwinCount = 0;
  let confirmCount = 0;
  let lateCount = 0;
  let orphanCount = 0;
  for (let i = 0; i < afterStore.count; i++) {
    const flags = afterStore.routeFlagsBitSet32Col[i]!;
    if ((flags & BRIDGE3A_FLAG_HAS_ALERT_TWIN) === 0) continue;
    alertTwinCount += 1;

    const isAlertOwner = (flags & BRIDGE3A_FLAG_IS_ALERT) !== 0;
    if (!isAlertOwner) {
      const beforeIdx = beforeStore.lookup(afterStore.keyCol[i]!);
      const isLate =
        beforeIdx !== -1 &&
        (beforeStore.routeFlagsBitSet32Col[beforeIdx]! &
          (BRIDGE3A_FLAG_IS_ALERT | BRIDGE3A_FLAG_HAS_ALERT_TWIN)) ===
          (BRIDGE3A_FLAG_IS_ALERT | BRIDGE3A_FLAG_HAS_ALERT_TWIN);
      if (isLate) {
        lateCount += 1;
      } else {
        confirmCount += 1;
      }
    } else {
      orphanCount += 1;
    }
  }

  // Bounded aggregates using derived TypedArray capacities (no Map, no Set)
  const channelTicketCounts = new Uint32Array(CHANNEL_ORDINAL_COUNT);
  const channelLegCounts = new Uint32Array(CHANNEL_ORDINAL_COUNT);
  const channelVolumeCents = new Float64Array(CHANNEL_ORDINAL_COUNT);

  const wagerTypeTicketCounts = new Uint32Array(WAGER_TYPE_ORDINAL_COUNT);
  const wagerTypeLegCounts = new Uint32Array(WAGER_TYPE_ORDINAL_COUNT);

  for (let i = 0; i < afterStore.count; i++) {
    const chOrd = afterStore.channelOrdinalCol[i]!;
    channelTicketCounts[chOrd] = channelTicketCounts[chOrd]! + 1;
    channelLegCounts[chOrd] =
      channelLegCounts[chOrd]! + afterStore.legCountCol[i]!;
    channelVolumeCents[chOrd] =
      channelVolumeCents[chOrd]! + afterStore.canonicalVolumeCentsCol[i]!;

    const wtOrd = afterStore.wagerTypeOrdinalCol[i]!;
    wagerTypeTicketCounts[wtOrd] = wagerTypeTicketCounts[wtOrd]! + 1;
    wagerTypeLegCounts[wtOrd] =
      wagerTypeLegCounts[wtOrd]! + afterStore.legCountCol[i]!;
  }

  const byChannel: F402TickerChannelAggregate[] = [];
  for (const chOrd of CHANNEL_RANK_ORDINALS) {
    if (channelTicketCounts[chOrd]! > 0) {
      byChannel.push({
        channel: CHANNEL_BY_ORDINAL[chOrd]!,
        ticketCount: channelTicketCounts[chOrd]!,
        legCount: channelLegCounts[chOrd]!,
        canonicalVolumeCents: channelVolumeCents[chOrd]!,
      });
    }
  }

  const byWagerType: F402TickerWagerTypeAggregate[] = [];
  for (const wtOrd of WAGER_TYPE_RANK_ORDINALS) {
    if (wagerTypeTicketCounts[wtOrd]! > 0) {
      byWagerType.push({
        wagerType: WAGER_TYPE_BY_ORDINAL[wtOrd]!,
        ticketCount: wagerTypeTicketCounts[wtOrd]!,
        legCount: wagerTypeLegCounts[wtOrd]!,
      });
    }
  }

  const { deskDate, deskHour } = deskClock(polledAt);
  // O(1) watermark advancement tracked during insertion into open-addressed slots
  const watermark = String(
    Math.max(
      afterStore.highestNumericWagerNumber,
      beforeStore.highestNumericWagerNumber,
    ),
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
    byChannel,
    byWagerType,
  } as const;

  return {
    ...payload,
    sourceSha256: sha256Hex(serializeF402TickerDeltaPayload(payload)),
  };
}

/**
 * Project one completed poll into the WS delta.
 *
 * `previous` is the previous poll's fully-drained row set; on a cold start it is empty and every
 * current ticket reads as new. Counts are deduped once per ticket; ALERT rows add no money and
 * are classified as confirmed (twin in this batch), late (twin arrived after the alert) or
 * orphan (no twin yet).
 *
 * Implements strict zero-collection allocation on the dedupe & aggregation path:
 * open-addressed hash slots, SoA TypedArray columns, per-row bitset flags, and bounded ordinal tables.
 */
export function projectF402TickerDelta(
  previous: readonly F402TickerRow[],
  current: readonly F402TickerRow[],
  polledAt: string,
  outDiagnostics?: { overflowRejectionCount?: number },
): F402TickerDeltaEvent {
  const beforeStore = new Bridge3aTicketColumnStore(
    Math.max(16, previous.length),
  );
  for (let i = 0; i < previous.length; i++) {
    beforeStore.insertOrUpdate(previous[i]!);
  }

  const afterStore = new Bridge3aTicketColumnStore(
    Math.max(16, current.length),
  );
  for (let i = 0; i < current.length; i++) {
    afterStore.insertOrUpdate(current[i]!);
  }

  if (outDiagnostics !== undefined) {
    outDiagnostics.overflowRejectionCount =
      beforeStore.overflowRejectionCount + afterStore.overflowRejectionCount;
  }

  return projectF402TickerDeltaFromStores(beforeStore, afterStore, polledAt);
}

/**
 * Project a completed poll with full caller observability, returning both the delta event
 * and batch-level diagnostics (counts, overflow rejections).
 */
export function projectF402TickerDeltaWithDiagnostics(
  previous: readonly F402TickerRow[],
  current: readonly F402TickerRow[],
  polledAt: string,
): {
  readonly event: F402TickerDeltaEvent;
  readonly diagnostics: F402TickerBatchDiagnostics;
} {
  const beforeStore = new Bridge3aTicketColumnStore(
    Math.max(16, previous.length),
  );
  for (let i = 0; i < previous.length; i++) {
    beforeStore.insertOrUpdate(previous[i]!);
  }

  const afterStore = new Bridge3aTicketColumnStore(
    Math.max(16, current.length),
  );
  for (let i = 0; i < current.length; i++) {
    afterStore.insertOrUpdate(current[i]!);
  }

  const event = projectF402TickerDeltaFromStores(
    beforeStore,
    afterStore,
    polledAt,
  );
  return {
    event,
    diagnostics: {
      beforeCount: beforeStore.count,
      afterCount: afterStore.count,
      overflowRejectionCount:
        beforeStore.overflowRejectionCount + afterStore.overflowRejectionCount,
    },
  };
}

/** Build the sanitized R2 snapshot from a delta plus the raw row count of its drain. */
export function buildF402TickerSnapshot(
  event: F402TickerDeltaEvent,
  rowCount: number,
): F402TickerSnapshot {
  const byChannel = event.byChannel;
  const byWagerType = event.byWagerType;
  let ticketCount = 0;
  let legCount = 0;
  for (let i = 0; i < byChannel.length; i++) {
    ticketCount += byChannel[i]!.ticketCount;
    legCount += byChannel[i]!.legCount;
  }
  const payload = {
    schemaVersion: F402_BET_TICKER_SCHEMA_VERSION,
    kind: F402_BET_TICKER_KIND,
    generatedAt: event.polledAt,
    deskDate: event.deskDate,
    deskHour: event.deskHour,
    watermark: event.watermark,
    rowCount,
    ticketCount,
    legCount,
    alertTwinCount: event.alertTwinCount,
    confirmCount: event.confirmCount,
    lateCount: event.lateCount,
    orphanCount: event.orphanCount,
    byChannel,
    byWagerType,
  } as const;
  return {
    ...payload,
    sourceSha256: sha256Hex(serializeF402TickerSnapshotPayload(payload)),
  };
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
