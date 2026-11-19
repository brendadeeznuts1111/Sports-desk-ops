/**
 * @file lib/ppm_bootstrap.ts
 * @description The price bootstrap: `GET /betLobbyV2/getUpdates/?groupId=…`.
 *
 * The socket feed ships market *descriptors* and per-event deltas; the full
 * price table comes from this HTTP call. Measured 2026-11-13, anonymously:
 *
 *   /betLobbyV2/getUpdates/?since=0&store=U0VWU1NWUkJSMFU9
 *     &includeNotStarted=1&groupId=72105&partnerId=118     -> 23 MB
 *   /betLobbyV2/getUpdates/?since=0&store=…                -> [{},{},{},{}]
 *
 * **The `groupId` (and `includeNotStarted`) are what unlock it** — not a
 * session, and not credentials. That corrects an earlier reading of the empty
 * per-event coefficient frames: those carry descriptors, and an event with no
 * open market legitimately has `c: []`.
 *
 * Shape of the first payload section:
 *
 *   { t, s, c, m, f, db }
 *   c[eventId].c = { m?: { [marketId]: market }, h1?: …, s1?: …, … }
 *   market      = { o: { [selectionKey]: number | [number, number] },
 *                   r?: line, d?: { [key]: name } }
 *
 * Prices are **decimal** already (1.909091 = -110), so they never pass through
 * the display quantization that `ppm_price_math` documents.
 *
 * A pair is either two offers or one offer plus a filler, and the difference
 * is arithmetic, not positional: two offers price a book (`1/a + 1/b` in
 * 1.03–1.23 on this feed), while the filler is `1.00001` / `1.000001` and is
 * filtered before the test. When both elements survive, both are emitted, with
 * `side` 0/1 and — where the market type says so — a named `role`:
 *
 * - totals (5/7/8): `over` / `under`
 * - spread (6): `quoted` / `other`
 * - any other two-price pair (an exact total, a player prop): role `null`,
 *   because the payload does not say what the second side means
 *
 * A key is a line only in the line-keyed markets; elsewhere it is a
 * selection/outcome id, even when it is numeric. `line`, `side`, `role` and
 * `twoSided` record exactly that, so a consumer never has to re-guess.
 */

/** Which side of a pair a price is, where the market type names them. */
export type PpmSideRole = "over" | "under" | "quoted" | "other";

/** What a market's `o` keys name. */
export type PpmMarketKeyKind = "line" | "outcome";

export interface PpmPricePoint {
  /** Selection id (`"1"`, `"2"`) or the line as a string (`"48.5"`, `"-3.5"`). */
  readonly key: string;
  /** Numeric value of the key when it is a line; `null` for a selection id. */
  readonly line: number | null;
  /** Index inside a two-price pair; `null` for a single price. */
  readonly side: number | null;
  /**
   * Named role of the side when the market type encodes it: totals are
   * `over`/`under`, a spread is the `quoted` side and `other`. `null` when only
   * the pair position is known (an outcome-keyed two-price quote).
   */
  readonly role: PpmSideRole | null;
  readonly decimal: number;
}

export interface PpmMarketPrices {
  readonly marketId: number;
  /**
   * Period code as the feed names it: `m` is mapped to `full`; `h1`/`h2` and
   * the `s1`…`s13` codes (set/period markets) pass through unchanged rather
   * than being folded into `full`.
   */
  readonly period: string;
  /** Line carried by the market node itself (`r`), when present. */
  readonly line: number | null;
  /** What the keys mean: a line (Total/Spread/Team Total) or an outcome id. */
  readonly keyKind: PpmMarketKeyKind;
  /**
   * True when at least one key prices both sides of a book. Measured: 101,643
   * two-real pairs in markets 5/6/7/8 sum to 1.0289–1.2329 implied probability
   * (median 1.0722), i.e. a 3–23% hold — see `pairPricesLikeBook`.
   */
  readonly twoSided: boolean;
  readonly points: readonly PpmPricePoint[];
}

export interface PpmEventPrices {
  readonly eventId: string;
  readonly markets: readonly PpmMarketPrices[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The feed writes `1.00001` (and `1.000001`) into the side of a quote that has
 * no offer — a placeholder, not a price. Measured over the full 2026-11-13
 * bootstrap: 285,981 of 859,006 two-element values carried exactly one of those
 * two numbers, and nothing real appeared between them and 1.83. The floor sits
 * below the 1.005–1.01 quotes a few exotic markets do carry, so those survive
 * while the placeholders do not.
 */
export const PPM_PLACEHOLDER_DECIMAL = 1.001;

function asDecimal(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > PPM_PLACEHOLDER_DECIMAL
    ? value
    : null;
}

/**
 * Markets whose `o` is keyed by a **line** and whose pair is the two sides of
 * that line (`[over, under]`, `[home, away]`). GSLive's wagertype metadata
 * names them: 5 Total (bId 2), 6 Spread (bId 1), 7/8 Team Total (bId 3/4).
 * Every other market keys on an outcome/selection id; its pair is two offers
 * only when it passes `pairPricesLikeBook` (e.g. a player prop quoted both
 * ways), and the second side is then emitted without a named role.
 *
 * This is metadata the payload does not carry — `parsePpmBootstrap` accepts an
 * override so a caller holding `eventsMetadata` can extend or replace it.
 */
export const PPM_LINE_KEYED_MARKETS: ReadonlySet<number> = new Set([
  5, 6, 7, 8,
]);

export interface PpmBootstrapOptions {
  readonly lineKeyedMarkets?: ReadonlySet<number>;
}

/**
 * A pair prices a book when its two implied probabilities (1/decimal each) sum
 * to a positive hold. Measured on the 2026-11-13 bootstrap: 101,643 pairs in
 * the known line markets land in 1.0289–1.2329, median 1.0722. Outside that
 * band the two numbers are not two sides of the same market (the feed also
 * writes `[price, 1.00001]`, which is filtered before this test).
 */
const BOOK_SUM_MIN = 1.0;
const BOOK_SUM_MAX = 1.3;

function pairPricesLikeBook(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  const sum = 1 / a + 1 / b;
  return sum >= BOOK_SUM_MIN && sum <= BOOK_SUM_MAX;
}

function sideRole(
  marketId: number,
  side: number,
  lineKeyed: boolean,
): PpmSideRole | null {
  if (!lineKeyed) return null;
  if (marketId === 6) return side === 0 ? "quoted" : "other";
  return side === 0 ? "over" : "under";
}

/** Prices quoted at the market's reference line (`r`), if it is a line market. */
export function referencePrices(
  market: PpmMarketPrices,
): readonly PpmPricePoint[] {
  if (market.line === null) return [];
  return market.points.filter((point) => point.line === market.line);
}

function parseMarketNode(
  marketId: number,
  period: string,
  node: unknown,
  lineKeyed: boolean,
): PpmMarketPrices | null {
  if (!isRecord(node) || !isRecord(node.o)) return null;
  const points: PpmPricePoint[] = [];
  let twoSided = false;
  for (const [key, raw] of Object.entries(node.o)) {
    const numericKey = Number(key);
    const numeric = Number.isFinite(numericKey) && key.trim() !== "";
    if (Array.isArray(raw)) {
      const values = raw.map(asDecimal);
      const bothSides = pairPricesLikeBook(
        values[0] ?? null,
        values[1] ?? null,
      );
      if (bothSides) {
        // Both elements price a book, so both are offers. On a line market the
        // key is the line; on an outcome market it is a selection/player id.
        twoSided = true;
        values.forEach((decimal, side) => {
          if (decimal === null) return;
          points.push({
            key,
            line: lineKeyed && numeric ? numericKey : null,
            side,
            role: sideRole(marketId, side, lineKeyed),
            decimal,
          });
        });
        continue;
      }
      // One-sided. On a line market the missing side is a placeholder, so the
      // offer that exists keeps its own index (`[1.000001, 15.88]` is side 1).
      // On an outcome market only the first element is a price at all.
      if (lineKeyed) {
        values.forEach((decimal, side) => {
          if (decimal !== null) {
            points.push({
              key,
              line: numeric ? numericKey : null,
              side,
              role: sideRole(marketId, side, true),
              decimal,
            });
          }
        });
        continue;
      }
      const decimal = values[0] ?? null;
      if (decimal !== null) {
        points.push({
          key,
          line: null,
          side: null,
          role: null,
          decimal,
        });
      }
      continue;
    }
    const decimal = asDecimal(raw);
    if (decimal !== null) {
      points.push({ key, line: null, side: null, role: null, decimal });
    }
  }
  if (points.length === 0) return null;
  return {
    marketId,
    period,
    line: typeof node.r === "number" ? node.r : null,
    keyKind: lineKeyed ? "line" : "outcome",
    twoSided,
    points,
  };
}

/** Parses one event's coefficient entry (`c[eventId].c`). */
export function parsePpmEventPrices(
  eventId: string,
  entry: unknown,
  options: PpmBootstrapOptions = {},
): PpmEventPrices {
  if (!isRecord(entry) || !isRecord(entry.c)) {
    return { eventId, markets: [] };
  }
  const lineKeyedMarkets = options.lineKeyedMarkets ?? PPM_LINE_KEYED_MARKETS;
  const markets: PpmMarketPrices[] = [];
  for (const [periodKey, periodValue] of Object.entries(entry.c)) {
    // `m` is the full match; `h1`/`h2` and `s1`…`s13` are already the feed's
    // own names. Folding an unknown code into `full` would claim a market the
    // payload did not say it was.
    const period = periodKey === "m" ? "full" : periodKey;
    if (!isRecord(periodValue)) continue;
    for (const [marketKey, node] of Object.entries(periodValue)) {
      const marketId = Number(marketKey);
      if (!Number.isSafeInteger(marketId)) continue;
      const parsed = parseMarketNode(
        marketId,
        period,
        node,
        lineKeyedMarkets.has(marketId),
      );
      if (parsed) markets.push(parsed);
    }
  }
  return { eventId, markets };
}

export interface PpmBootstrap {
  /** Feed timestamp of the payload, epoch milliseconds. */
  readonly updatedAtMs: number | null;
  readonly events: readonly PpmEventPrices[];
  readonly counts: {
    readonly eventsWithPrices: number;
    readonly markets: number;
    readonly twoSidedMarkets: number;
    readonly pricePoints: number;
  };
}

/**
 * Parses the first section of a `getUpdates` payload. Events without open
 * markets are returned with `markets: []` rather than dropped, so "no price" is
 * visible instead of absent.
 */
export function parsePpmBootstrap(
  payload: unknown,
  options: PpmBootstrapOptions = {},
): PpmBootstrap {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!isRecord(first) || !isRecord(first.c)) {
    throw new Error("ppm bootstrap: expected [{ c: { eventId: … } }]");
  }
  const events: PpmEventPrices[] = [];
  let markets = 0;
  let twoSidedMarkets = 0;
  let pricePoints = 0;
  for (const [eventId, entry] of Object.entries(first.c)) {
    const parsed = parsePpmEventPrices(eventId, entry, options);
    events.push(parsed);
    markets += parsed.markets.length;
    for (const market of parsed.markets) {
      pricePoints += market.points.length;
      if (market.twoSided) twoSidedMarkets += 1;
    }
  }
  return {
    updatedAtMs: typeof first.t === "number" ? first.t : null,
    events,
    counts: {
      eventsWithPrices: events.filter((event) => event.markets.length > 0)
        .length,
      markets,
      twoSidedMarkets,
      pricePoints,
    },
  };
}
