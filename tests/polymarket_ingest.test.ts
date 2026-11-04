import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  POLYMARKET_POSITIONS_URL,
  aggregatePositions,
  cacheFromSnapshot,
  fetchPolymarketSnapshot,
  fetchWalletPositions,
  isValidWalletAddress,
  parsePolymarketPosition,
  parsePositionsEnvelope,
  parseRetryAfterMs,
  reconcileSnapshot,
  resolveRetryDelayMs,
  type PositionCache,
} from "../lib/polymarket_ingest.ts";

const ADDRESS = (suffix: string): string => `0x${"0".repeat(38)}${suffix}`;
const W1 = ADDRESS("01");
const W_PAGED = ADDRESS("02");
const W_RETRY_429 = ADDRESS("03");
const W_SLOW = ADDRESS("04");
const W_MISS = ADDRESS("05");
const W_EMPTY = ADDRESS("06");
const W_429_FOREVER = ADDRESS("07");
const W_500 = ADDRESS("08");
const W_500_ONCE = ADDRESS("09");
const W_400 = ADDRESS("0a");
const W_410 = ADDRESS("0b");
const W_LEGACY = ADDRESS("0c");
const W_NO_PAGINATION = ADDRESS("0d");
const W_BAD_DATA = ADDRESS("0e");
const W_NUMBERS = ADDRESS("0f");
const W_REJECT = ADDRESS("10");
const W_HAS_MORE_NO_CURSOR = ADDRESS("11");

/** One v2 wire row (snake_case, `*_usdc` money fields, current_size in shares). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proxy_wallet: W1,
    token_id: "token-1",
    condition_id: "0xcondition",
    current_size: 100,
    avg_price: 0.5,
    entry_cost_usdc: 50,
    entry_fees_usdc: 0,
    total_cost_usdc: 50,
    current_price: 0.6,
    current_value: 60,
    total_size: 100,
    realized_pnl: 0,
    unrealized_pnl: 10,
    total_pnl: 10,
    percent_pnl: 20,
    percent_realized_pnl: 20,
    status: "OPEN",
    redeemable: false,
    mergeable: false,
    negative_risk: false,
    archived: false,
    title: "Will Team A win?",
    slug: "team-a",
    icon: "",
    event_id: "1",
    event_slug: "event-1",
    outcome: "Yes",
    outcome_index: 0,
    opposite_outcome: "No",
    opposite_token_id: "token-2",
    end_date: "2026-12-31",
    last_event_at: 1,
    first_entry_at: 1,
    name: "wallet",
    profile_image: "",
    verified: false,
    ...overrides,
  };
}

function envelope(
  data: readonly unknown[] | null,
  pagination: {
    readonly limit?: number;
    readonly offset?: number;
    readonly has_more?: boolean;
    readonly next_cursor?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    data,
    pagination: {
      limit: pagination.limit ?? data?.length ?? 0,
      offset: pagination.offset ?? 0,
      has_more: pagination.has_more ?? false,
      next_cursor: pagination.next_cursor ?? null,
    },
  };
}

interface SeenRequest {
  readonly user: string;
  readonly cursor: string | null;
  readonly limit: string | null;
  readonly offset: string | null;
  readonly pathname: string;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let inFlight = 0;
let maxInFlight = 0;
const attempts = new Map<string, number>();
const seen: SeenRequest[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const user = url.searchParams.get("user") ?? "";
      const cursor = url.searchParams.get("cursor");
      seen.push({
        user,
        cursor,
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        pathname: url.pathname,
      });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const attempt = (attempts.get(user) ?? 0) + 1;
      attempts.set(user, attempt);
      try {
        if (user === W_SLOW) {
          await Bun.sleep(120);
          return Response.json(envelope([row()]));
        }
        if (user === W_429_FOREVER) {
          return new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: { "retry-after": "0", "content-type": "application/json" },
          });
        }
        if (user === W_RETRY_429) {
          if (attempt === 1) {
            return new Response(JSON.stringify({ error: "slow down" }), {
              status: 429,
              headers: {
                "retry-after": "0",
                "content-type": "application/json",
              },
            });
          }
          return Response.json(envelope([row({ token_id: "retried" })]));
        }
        if (user === W_500) {
          return new Response(JSON.stringify({ error: "upstream exploded" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (user === W_500_ONCE) {
          if (attempt === 1) {
            return new Response(JSON.stringify({ error: "flaky" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          return Response.json(envelope([row({ token_id: "recovered" })]));
        }
        if (user === W_400) {
          return new Response(JSON.stringify({ error: "cursor: invalid" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (user === W_410) {
          return new Response(
            JSON.stringify({ error: "Data API v1 has been retired" }),
            { status: 410, headers: { "content-type": "application/json" } },
          );
        }
        if (user === W_LEGACY) return Response.json([row()]);
        if (user === W_NO_PAGINATION) {
          return Response.json({ data: [row()] });
        }
        if (user === W_BAD_DATA) {
          return Response.json({
            data: "not-an-array",
            pagination: { has_more: false, next_cursor: null },
          });
        }
        if (user === W_MISS) return Response.json(envelope(null));
        if (user === W_EMPTY) return Response.json(envelope([]));
        if (user === W_NUMBERS) {
          return Response.json(
            envelope([
              row({
                token_id: "numbers",
                current_value: null,
                entry_cost_usdc: null,
                total_pnl: null,
                unrealized_pnl: null,
              }),
            ]),
          );
        }
        if (user === W_REJECT) {
          return Response.json(
            envelope([row({ token_id: "kept" }), row({ token_id: "" })]),
          );
        }
        if (user === W_HAS_MORE_NO_CURSOR) {
          return Response.json(
            envelope([row({ token_id: "only" })], {
              has_more: true,
              next_cursor: null,
            }),
          );
        }
        if (user === W_PAGED) {
          if (cursor === null) {
            return Response.json(
              envelope(
                [
                  row({
                    token_id: "a1",
                    title: "Paged one",
                    current_value: 10,
                  }),
                  row({
                    token_id: "a2",
                    title: "Paged two",
                    current_value: 20,
                  }),
                ],
                { has_more: true, next_cursor: "page-2" },
              ),
            );
          }
          if (cursor === "page-2") {
            return Response.json(
              envelope(
                [
                  row({
                    token_id: "a3",
                    title: "Paged three",
                    current_value: 30,
                  }),
                  row({
                    token_id: "a4",
                    title: "Paged four",
                    current_value: 40,
                  }),
                ],
                { has_more: true, next_cursor: "page-3" },
              ),
            );
          }
          if (cursor === "page-3") {
            return Response.json(
              envelope(
                [
                  row({
                    token_id: "a5",
                    title: "Paged five",
                    current_value: 50,
                  }),
                ],
                { has_more: false, next_cursor: null },
              ),
            );
          }
          return new Response(JSON.stringify({ error: "unknown cursor" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        if (user === W1) {
          return Response.json(
            envelope([
              row(),
              row({
                token_id: "token-redeemable",
                status: "REDEEMABLE",
                redeemable: true,
                title: "Redeemable",
                current_value: 30,
              }),
            ]),
          );
        }
        return Response.json(envelope([]));
      } finally {
        inFlight -= 1;
      }
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/v2/positions`;
});

afterAll(() => {
  server.stop(true);
});

describe("Polymarket Data API v2 positions ingestion", () => {
  test("targets the v2 route, not the retired v1 route", () => {
    expect(POLYMARKET_POSITIONS_URL).toBe(
      "https://data-api.polymarket.com/v2/positions",
    );
  });

  test("validates 20-byte addresses", () => {
    expect(isValidWalletAddress(`0x${"0".repeat(40)}`)).toBe(true);
    expect(
      isValidWalletAddress("0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612"),
    ).toBe(true);
    expect(isValidWalletAddress("0x9cD44e12A8b7F30192c44d8E11a08B3e7")).toBe(
      false,
    );
    expect(isValidWalletAddress("")).toBe(false);
  });

  test("parses v2 snake_case rows onto the feed field names", () => {
    const parsed = parsePolymarketPosition(row());
    expect(parsed).not.toBeNull();
    expect(parsed?.asset).toBe("token-1");
    expect(parsed?.proxyWallet).toBe(W1);
    expect(parsed?.conditionId).toBe("0xcondition");
    expect(parsed?.size).toBe(100);
    expect(parsed?.avgPrice).toBe(0.5);
    expect(parsed?.initialValue).toBe(50);
    expect(parsed?.currentValue).toBe(60);
    expect(parsed?.cashPnl).toBe(10);
    expect(parsed?.curPrice).toBe(0.6);
    expect(parsed?.status).toBe("OPEN");
    expect(parsed?.redeemable).toBe(false);
    expect(parsed?.slug).toBe("team-a");
    expect(parsed?.eventId).toBe("1");
    expect(parsed?.outcome).toBe("Yes");
    expect(parsed?.endDate).toBe("2026-12-31");
    expect(parsed?.missingFields).toEqual([]);
  });

  test("rejects rows missing token, condition or title", () => {
    expect(parsePolymarketPosition(row({ token_id: "" }))).toBeNull();
    expect(parsePolymarketPosition(row({ condition_id: "" }))).toBeNull();
    expect(parsePolymarketPosition(row({ title: "" }))).toBeNull();
    expect(parsePolymarketPosition("not-an-object")).toBeNull();
    expect(parsePolymarketPosition(null)).toBeNull();
  });

  test("maps status to redeemable and open-leg eligibility", () => {
    const open = parsePolymarketPosition(row())!;
    expect(open.status).toBe("OPEN");
    expect(open.redeemable).toBe(false);
    expect(open.cashPnl).toBe(10);

    const redeemable = parsePolymarketPosition(
      row({ status: "REDEEMABLE", redeemable: true }),
    )!;
    expect(redeemable.status).toBe("REDEEMABLE");
    expect(redeemable.redeemable).toBe(true);

    // REDEEMABLE_LOST rows keep the narrower status; they are not open legs.
    const lost = parsePolymarketPosition(
      row({ status: "REDEEMABLE_LOST", redeemable: false }),
    )!;
    expect(lost.status).toBe("REDEEMABLE_LOST");
    expect(lost.redeemable).toBe(false);

    const closed = parsePolymarketPosition(row({ status: "CLOSED" }))!;
    expect(closed.redeemable).toBe(false);

    // Unrecognised status is never counted as an open leg.
    const unknown = parsePolymarketPosition(row({ status: "BOGUS" }))!;
    expect(unknown.status).toBe("");

    // Retired v1 row shape (no `status`): derived from its `redeemable` boolean.
    const legacyOpen = parsePolymarketPosition(row({ status: undefined }))!;
    expect(legacyOpen.status).toBe("OPEN");
    const legacyWon = parsePolymarketPosition(
      row({ status: undefined, redeemable: true }),
    )!;
    expect(legacyWon.status).toBe("REDEEMABLE");
    expect(legacyWon.redeemable).toBe(true);
  });

  test("keeps missing numerics out of sums but records them", () => {
    const parsed = parsePolymarketPosition(
      row({
        current_value: null,
        entry_cost_usdc: null,
        total_pnl: null,
        unrealized_pnl: null,
      }),
    )!;
    expect(parsed.currentValue).toBe(0);
    expect(parsed.initialValue).toBe(0);
    expect(parsed.cashPnl).toBe(0);
    expect(parsed.unrealizedPnlUsd).toBe(0);
    expect(parsed.missingFields).toContain("current_value");
    expect(parsed.missingFields).toContain("entry_cost_usdc");
    expect(parsed.missingFields).toContain("total_pnl");
    expect(parsed.missingFields).toContain("unrealized_pnl");
  });

  test("parses the v2 envelope; data null/[] is a documented miss", () => {
    const page = parsePositionsEnvelope(envelope([row()], { has_more: true }));
    expect(page?.rows).toHaveLength(1);
    expect(page?.hasMore).toBe(true);
    expect(page?.nextCursor).toBeNull();

    const nullPage = parsePositionsEnvelope({
      data: null,
      pagination: { limit: 500, offset: 0, has_more: false, next_cursor: null },
    });
    expect(nullPage?.rows).toEqual([]);
    expect(nullPage?.nextCursor).toBeNull();

    // No `has_more` on the wire: the cursor alone decides whether to continue.
    const cursorOnly = parsePositionsEnvelope({
      data: [row()],
      pagination: { next_cursor: "c1" },
    });
    expect(cursorOnly?.nextCursor).toBe("c1");
    expect(cursorOnly?.hasMore).toBe(true);

    // A bare array is the retired v1 shape, and a missing pagination block is not the contract.
    expect(parsePositionsEnvelope([row()])).toBeNull();
    expect(parsePositionsEnvelope({ data: [row()] })).toBeNull();
    expect(parsePositionsEnvelope("nope")).toBeNull();
  });

  test("aggregates only OPEN rows; redeemable and closed are excluded", () => {
    const openA = parsePolymarketPosition(row())!;
    const openB = parsePolymarketPosition(
      row({
        token_id: "b",
        initialValue: 2,
        current_value: 1,
        entry_cost_usdc: 2,
        unrealized_pnl: -1,
        total_pnl: -1,
        title: "Small",
      }),
    )!;
    const redeemed = parsePolymarketPosition(
      row({
        token_id: "c",
        status: "REDEEMABLE",
        redeemable: true,
        current_value: 30,
        total_pnl: 15,
        title: "Redeemed",
      }),
    )!;
    const closed = parsePolymarketPosition(
      row({ token_id: "d", status: "CLOSED", current_value: 0 }),
    )!;

    const aggregate = aggregatePositions([openA, openB, redeemed, closed]);
    expect(aggregate.openPositionsCount).toBe(4);
    expect(aggregate.openLegsCount).toBe(2);
    expect(aggregate.openCostUsd).toBe(52);
    expect(aggregate.openValueUsd).toBe(61);
    expect(aggregate.openPnlUsd).toBe(9);
    expect(aggregate.openUnrealizedPnlUsd).toBe(9);
    expect(aggregate.openRowsWithMissingNumerics).toBe(0);
    expect(aggregate.summary).toContain("Will Team A win? (Yes) $60");
    expect(aggregate.summary).not.toContain("Redeemed");
  });

  test("fetches one wallet over HTTP", async () => {
    const result = await fetchWalletPositions(W1, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(result.status).toBe("ok");
    expect(result.error).toBeNull();
    expect(result.positions).toHaveLength(2);
    expect(result.aggregate?.openLegsCount).toBe(1);
    expect(result.aggregate?.openPositionsCount).toBe(2);
    expect(result.rejectedRows).toBe(0);
    expect(result.pages).toBe(1);

    const requests = seen.filter((entry) => entry.user === W1);
    expect(requests.length).toBeGreaterThan(0);
    const last = requests.at(-1)!;
    expect(last.pathname).toBe("/v2/positions");
    expect(last.limit).toBe("500");
    expect(last.offset).toBeNull();
  });

  test("follows cursor pagination and never sends offset", async () => {
    seen.length = 0;
    const result = await fetchWalletPositions(W_PAGED, {
      baseUrl,
      pageSize: 2,
      maxPages: 5,
      retryDelayMs: 0,
    });
    expect(result.status).toBe("ok");
    expect(result.pages).toBe(3);
    expect(result.positions).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(result.aggregate?.openLegsCount).toBe(5);

    const paged = seen.filter((entry) => entry.user === W_PAGED);
    expect(paged).toHaveLength(3);
    expect(paged.every((entry) => entry.pathname === "/v2/positions")).toBe(
      true,
    );
    expect(paged.every((entry) => entry.offset === null)).toBe(true);
    // `limit` only travels with the first request; the cursor binds the walk after that.
    expect(paged[0]?.limit).toBe("2");
    expect(paged[0]?.cursor).toBeNull();
    expect(paged[1]?.limit).toBeNull();
    expect(paged[1]?.cursor).toBe("page-2");
    expect(paged[2]?.cursor).toBe("page-3");
  });

  test("stops at maxPages and reports truncation", async () => {
    const capped = await fetchWalletPositions(W_PAGED, {
      baseUrl,
      pageSize: 2,
      maxPages: 1,
      retryDelayMs: 0,
    });
    expect(capped.status).toBe("ok");
    expect(capped.pages).toBe(1);
    expect(capped.positions).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    const snapshot = await fetchPolymarketSnapshot([W_PAGED], {
      baseUrl,
      pageSize: 2,
      maxPages: 1,
      retryDelayMs: 0,
    });
    expect(snapshot.truncatedWallets).toEqual([W_PAGED]);
  });

  test("stops on has_more false even when a cursor is echoed", async () => {
    const result = await fetchWalletPositions(W_HAS_MORE_NO_CURSOR, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(result.status).toBe("ok");
    expect(result.pages).toBe(1);
    expect(result.positions).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  test("treats data:null and data:[] as an empty successful page", async () => {
    for (const address of [W_MISS, W_EMPTY]) {
      const result = await fetchWalletPositions(address, {
        baseUrl,
        retryDelayMs: 0,
      });
      expect(result.status).toBe("ok");
      expect(result.error).toBeNull();
      expect(result.positions).toEqual([]);
      expect(result.pages).toBe(1);
      expect(result.aggregate?.openLegsCount).toBe(0);
    }
  });

  test("retries once on 429 after the Retry-After delay", async () => {
    const result = await fetchWalletPositions(W_RETRY_429, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(result.status).toBe("ok");
    expect(attempts.get(W_RETRY_429)).toBe(2);
    expect(result.positions.map((position) => position.asset)).toEqual([
      "retried",
    ]);
  });

  test("retries once on 5xx", async () => {
    const result = await fetchWalletPositions(W_500_ONCE, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(result.status).toBe("ok");
    expect(attempts.get(W_500_ONCE)).toBe(2);
    expect(result.positions).toHaveLength(1);
  });

  test("surfaces HTTP errors with the v2 body message", async () => {
    const capped = await fetchWalletPositions(W_429_FOREVER, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(capped.status).toBe("error");
    expect(capped.error).toBe("HTTP 429: rate limited");
    expect(attempts.get(W_429_FOREVER)).toBe(2);

    const bad = await fetchWalletPositions(W_400, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(bad.error).toBe("HTTP 400: cursor: invalid");

    const boom = await fetchWalletPositions(W_500, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(boom.error).toBe("HTTP 500: upstream exploded");
    expect(attempts.get(W_500)).toBe(2);

    const retired = await fetchWalletPositions(W_410, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(retired.error).toBe("HTTP 410: Data API v1 has been retired");
    // No fallback: the poller never silently reuses v1.
    expect(retired.positions).toEqual([]);
    expect(retired.aggregate).toBeNull();
  });

  test("rejects a bare-array body, the retired v1 shape", async () => {
    const legacy = await fetchWalletPositions(W_LEGACY, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(legacy.status).toBe("error");
    expect(legacy.error).toContain("unexpected body");
    expect(legacy.positions).toEqual([]);

    const noPagination = await fetchWalletPositions(W_NO_PAGINATION, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(noPagination.status).toBe("error");
    expect(noPagination.error).toContain("unexpected body");

    const badData = await fetchWalletPositions(W_BAD_DATA, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(badData.status).toBe("error");
    expect(badData.error).toContain("unexpected body");
  });

  test("classifies timeouts as errors", async () => {
    const slow = await fetchWalletPositions(W_SLOW, {
      baseUrl,
      timeoutMs: 20,
      retryDelayMs: 0,
    });
    expect(slow.status).toBe("error");
    expect(slow.error).toBe("timeout");
  });

  test("counts rejected rows and keeps missing numerics visible", async () => {
    const rejected = await fetchWalletPositions(W_REJECT, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(rejected.status).toBe("ok");
    expect(rejected.positions).toHaveLength(1);
    expect(rejected.rejectedRows).toBe(1);

    const numbers = await fetchWalletPositions(W_NUMBERS, {
      baseUrl,
      retryDelayMs: 0,
    });
    expect(numbers.status).toBe("ok");
    expect(numbers.aggregate?.openRowsWithMissingNumerics).toBe(1);
    expect(numbers.aggregate?.openValueUsd).toBe(0);
  });

  test("bounds concurrency and preserves input order", async () => {
    const addresses = [W1, W_PAGED, W_RETRY_429, W_SLOW, W_500, W_410];
    const snapshot = await fetchPolymarketSnapshot(addresses, {
      baseUrl,
      concurrency: 2,
      timeoutMs: 300,
      retryDelayMs: 0,
    });
    expect(snapshot.requested).toBe(6);
    expect(snapshot.wallets.map((wallet) => wallet.address)).toEqual(addresses);
    // Handler-side accounting includes a response whose body is still streaming to the client,
    // so allow one transport overlap on top of the two-worker pool.
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(snapshot.ok).toBe(4);
    expect(snapshot.failed).toBe(2);
    expect(snapshot.source).toBe(baseUrl);
  });

  test("retry timing helpers parse and bound the header", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(
      0,
    );

    expect(resolveRetryDelayMs("7", 250, 5000)).toBe(5000);
    expect(resolveRetryDelayMs("7", 250, 1)).toBe(1);
    expect(resolveRetryDelayMs(null, 250, 5000)).toBe(250);
    expect(resolveRetryDelayMs("0", 250, 5000)).toBe(0);
  });

  test("reconciles LIVE, STALE and FIXTURE", async () => {
    const ok = await fetchWalletPositions(W1, { baseUrl, retryDelayMs: 0 });
    const failed = await fetchWalletPositions(W_410, {
      baseUrl,
      retryDelayMs: 0,
    });
    const snapshot = {
      source: baseUrl,
      fetchedAtIso: "2026-11-04T11:00:00.000Z",
      durationMs: 10,
      requested: 3,
      ok: 1,
      failed: 1,
      truncatedWallets: [],
      wallets: [ok, failed, { ...failed, address: ADDRESS("12") }],
    };
    const cache: PositionCache = {
      schemaVersion: 1,
      wallets: {
        [W_410]: {
          aggregate: aggregatePositions([parsePolymarketPosition(row())!]),
          fetchedAtIso: "2026-11-04T10:00:00.000Z",
        },
      },
    };

    const states = reconcileSnapshot(snapshot, cache);
    expect(states.find((state) => state.address === W1)?.dataSource).toBe(
      "LIVE",
    );
    const stale = states.find((state) => state.address === W_410);
    expect(stale?.dataSource).toBe("STALE");
    expect(stale?.staleSinceIso).toBe("2026-11-04T10:00:00.000Z");
    expect(stale?.lastError).toContain("HTTP 410");
    expect(
      states.find((state) => state.address === ADDRESS("12"))?.dataSource,
    ).toBe("FIXTURE");

    const saved = cacheFromSnapshot(snapshot);
    expect(Object.keys(saved.wallets)).toEqual([W1]);
    expect(saved.wallets[W1]?.aggregate.openLegsCount).toBe(1);
  });
});
