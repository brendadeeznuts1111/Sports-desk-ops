import { describe, expect, test } from "bun:test";
import {
  KALSHI_EVENTS_TTL_MS,
  KALSHI_ORDERBOOK_TTL_MS,
  KalshiClient,
  parseKalshiEvent,
  parseKalshiMarket,
  parseKalshiOrderbook,
} from "../lib/kalshi_client.ts";
import {
  kalshiFixtureFetch,
  readKalshiFixture,
} from "./fixtures/kalshi/fixture_fetch.ts";

/**
 * The Kalshi client is the only place this feature touches the network, so its contract is pinned
 * against captured public responses: parse, cache by TTL, cap concurrency, and turn every failure
 * into `degraded` with a reason. No test reaches the internet.
 */

const NOW = 1_790_000_000_000;

describe("Kalshi response parsing", () => {
  test("parses a captured KXNBAGAME event and its markets", () => {
    const fixture = readKalshiFixture("kxnbagame-events.json") as {
      events: unknown[];
    };
    const event = parseKalshiEvent(fixture.events[0]);
    expect(event).not.toBeNull();
    expect(event?.eventTicker).toBe("KXNBAGAME-26NOV04ATLWAS");
    expect(event?.seriesTicker).toBe("KXNBAGAME");
    expect(event?.markets.length).toBeGreaterThan(0);
    const atl = event?.markets.find((market) => market.ticker.endsWith("-ATL"));
    expect(atl?.yesBid).toBe(0.55);
    expect(atl?.yesAsk).toBe(0.56);
    expect(atl?.yesBidSize).toBe(13281.82);
    expect(atl?.title).toBe("Atlanta wins");
  });

  test("a market without a ticker is unusable", () => {
    expect(parseKalshiMarket({ title: "no ticker" })).toBeNull();
    expect(parseKalshiMarket(null)).toBeNull();
  });

  test("parses the captured order book into numeric levels", () => {
    const fixture = readKalshiFixture("orderbook-kxnbagame-atl.json");
    const book = parseKalshiOrderbook(fixture);
    expect(book).not.toBeNull();
    expect(book?.yes.length).toBeGreaterThan(0);
    expect(book?.no.length).toBeGreaterThan(0);
    expect(book?.yes[0]?.price).toBe(0.46);
    expect(book?.no.at(-1)?.price).toBe(0.44);
  });

  test("garbage order-book levels are dropped, not coerced", () => {
    const book = parseKalshiOrderbook({
      orderbook_fp: {
        yes_dollars: [
          ["0.5000", "10.00"],
          ["nonsense", "1"],
          ["0.3000", "0"],
        ],
        no_dollars: [],
      },
    });
    expect(book?.yes).toEqual([{ price: 0.5, size: 10 }]);
  });
});

describe("KalshiClient cache, TTL and failure", () => {
  test("serves the first call from the fixture and the second from cache", async () => {
    const fixture = kalshiFixtureFetch();
    let clock = NOW;
    const client = new KalshiClient({
      fetchImpl: fixture.fetch,
      now: () => clock,
    });
    const first = await client.listOpenEvents("KXNBAGAME");
    const second = await client.listOpenEvents("KXNBAGAME");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.value).toEqual(first.value);
    }
    expect(fixture.calls).toHaveLength(1);
    expect(client.telemetry()).toMatchObject({
      ok: true,
      degraded: false,
      requests: 1,
      cacheHits: 1,
      cache: {
        eventsTtlSec: KALSHI_EVENTS_TTL_MS / 1000,
        orderbookTtlSec: KALSHI_ORDERBOOK_TTL_MS / 1000,
      },
    });

    clock += KALSHI_EVENTS_TTL_MS + 1;
    const third = await client.listOpenEvents("KXNBAGAME");
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.cached).toBe(false);
    expect(fixture.calls).toHaveLength(2);
  });

  test("order books use their own 30s TTL", async () => {
    const fixture = kalshiFixtureFetch();
    let clock = NOW;
    const client = new KalshiClient({
      fetchImpl: fixture.fetch,
      now: () => clock,
    });
    expect((await client.getOrderbook("KXNBAGAME-26NOV04ATLWAS-ATL")).ok).toBe(
      true,
    );
    clock += KALSHI_ORDERBOOK_TTL_MS + 1;
    expect((await client.getOrderbook("KXNBAGAME-26NOV04ATLWAS-ATL")).ok).toBe(
      true,
    );
    expect(fixture.calls).toHaveLength(2);
  });

  test("a network failure is degraded, never a value", async () => {
    const fixture = kalshiFixtureFetch({ failOn: "events" });
    const client = new KalshiClient({
      fetchImpl: fixture.fetch,
      now: () => NOW,
    });
    const result = await client.listOpenEvents("KXNBAGAME");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("network");
    const telemetry = client.telemetry();
    expect(telemetry.ok).toBe(false);
    expect(telemetry.degraded).toBe(true);
    expect(telemetry.errors).toHaveLength(1);
    expect(telemetry.errors[0]?.scope).toBe("events");
  });

  test("an unexpected body shape is degraded, not parsed hopefully", async () => {
    const client = new KalshiClient({
      fetchImpl: (async () =>
        Response.json({ nope: true })) as unknown as typeof fetch,
      now: () => NOW,
    });
    const result = await client.listOpenEvents("KXNBAGAME");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unexpected response shape");
    expect(client.telemetry().degraded).toBe(true);
  });

  test("no auth header and no credential on any request URL", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization") });
      return Response.json({ events: [] });
    }) as unknown as typeof fetch;
    const client = new KalshiClient({ fetchImpl, now: () => NOW });
    await client.listOpenEvents("KXNBAGAME");
    await client.getOrderbook("KXNBAGAME-26NOV04ATLWAS-ATL");
    expect(seen.length).toBe(2);
    for (const request of seen) {
      expect(request.authorization).toBeNull();
      expect(request.url).not.toContain("api_key");
      expect(request.url).not.toContain("token");
      expect(request.url).toContain("api.elections.kalshi.com");
    }
  });

  test("never exceeds maxConcurrency in flight", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ events: [] });
    }) as unknown as typeof fetch;
    const client = new KalshiClient({
      fetchImpl,
      now: () => NOW,
      maxConcurrency: 3,
    });
    await Promise.all(
      ["A", "B", "C", "D", "E", "F"].map((series) =>
        client.listOpenEvents(`KXN${series}`),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
