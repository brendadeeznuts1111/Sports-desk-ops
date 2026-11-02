import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("GET /api/game-admin/board", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  test("serves four games with their markets and exposure", async () => {
    const res = await get("api/game-admin/board");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      source: string;
      observedAt: string;
      games: Array<{
        gameNum: number;
        teams: [string, string];
        status: string;
        spread: Array<{ amount: string; amountExact: number | null }>;
        teamTotal: unknown[];
      }>;
      summary: {
        games: number;
        live: number;
        scheduled: number;
        byMarket: Array<{
          market: string;
          proven: number;
          approximate: number;
          sumExact: number;
        }>;
      };
      biggest: { side: { amountExact: number | null }; market: string } | null;
    };

    expect(body.source).toContain("Game Admin");
    expect(body.observedAt).toBe("2026-11-01");
    expect(body.games).toHaveLength(4);
    expect(body.summary.live).toBe(3);
    expect(body.summary.scheduled).toBe(1);
    expect(body.games[0]?.teams[0]).toBe("Los Angeles Chargers");

    const spread = body.summary.byMarket.find((m) => m.market === "spread");
    expect(spread).toEqual({
      market: "spread",
      proven: 4,
      approximate: 4,
      sumExact: 223163,
    });
    expect(body.biggest?.side.amountExact).toBe(91003);
    expect(body.biggest?.market).toBe("spread");
  });

  test("keeps abbreviated amounts marked, not invented", async () => {
    const body = (await (
      await get("api/game-admin/board?game=619115916")
    ).json()) as {
      markets: {
        spread: Array<{
          side: string;
          amount: string;
          amountExact: number | null;
        }>;
      };
    };
    const rams = body.markets.spread.find((s) => s.side.includes("Rams"));
    expect(rams?.amount).toBe("120k");
    expect(rams?.amountExact).toBeNull();
  });

  test("expands team totals into over and under per team", async () => {
    const body = (await (
      await get("api/game-admin/board?game=619115916")
    ).json()) as {
      markets: { teamTotal: Array<{ side: string; amount: string }> };
    };
    expect(body.markets.teamTotal.map((s) => s.side)).toEqual([
      "Los Angeles Chargers OVER",
      "Los Angeles Chargers UNDER",
      "Los Angeles Rams OVER",
      "Los Angeles Rams UNDER",
    ]);
  });

  test("404s an unknown game with the known ids", async () => {
    const res = await get("api/game-admin/board?game=1");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { known: number[] };
    expect(body.known).toContain(619115916);
  });

  test("the wager-derived Game Admin view still answers separately", async () => {
    const wagers = (await (await get("api/game-admin")).json()) as {
      games: Array<{ matchup: string }>;
    };
    expect(Array.isArray(wagers.games)).toBe(true);
    expect(
      wagers.games.every((g) => !("spread" in (g as Record<string, unknown>))),
    ).toBe(true);
  });
});

describe("board window selector", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  test("defaults to Today and advertises all three windows", async () => {
    const body = (await (await get("api/game-admin/board")).json()) as {
      window: string;
      windows: Array<{ value: string; label: string }>;
    };
    expect(body.window).toBe("24");
    expect(body.windows.map((w) => `${w.value}:${w.label}`)).toEqual([
      "48:Yesterday",
      "24:Today",
      "-1:Current Board",
    ]);
  });

  test("Yesterday is empty rather than repeating today's games", async () => {
    const res = await get("api/game-admin/board?window=48");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      games: unknown[];
      summary: { games: number };
    };
    expect(body.games).toEqual([]);
    expect(body.summary.games).toBe(0);
  });

  test("Current Board keeps live and scheduled games", async () => {
    const body = (await (
      await get("api/game-admin/board?window=-1")
    ).json()) as {
      games: Array<{ status: string }>;
    };
    expect(body.games).toHaveLength(4);
    expect(body.games.every((g) => g.status !== "final")).toBe(true);
  });

  test("rejects an unknown window with the allowed values", async () => {
    const res = await get("api/game-admin/board?window=99");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; windows: unknown[] };
    expect(body.error).toContain("48, 24 or -1");
    expect(body.windows).toHaveLength(3);
  });
});
