import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("GET /api/sports/catalog", () => {
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

  test("serves sports, sub-sports and periods with counts", async () => {
    const res = await get("api/sports/catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      provider: string;
      capturedAt: string;
      source: string;
      summary: {
        sports: number;
        subSports: number;
        periodEntries: number;
        collisions: number;
      };
      sports: Array<{
        sport: string;
        subSports: Array<{ code: string; name: string }>;
        periods: Array<{ name: string; number: number }>;
      }>;
    };

    expect(body.provider).toBe("fantasy402");
    expect(body.source).toContain("fantasy402-sport-catalog");
    expect(body.summary.sports).toBe(body.sports.length);
    expect(body.summary.subSports).toBe(230);
    expect(body.summary.periodEntries).toBe(42);
    expect(body.summary.collisions).toBe(2);

    for (const sport of body.sports) {
      expect(sport.subSports.length).toBeGreaterThan(0);
      expect(sport.periods[0]).toEqual({ name: "Game", number: 0 });
    }
  });

  test("reports period numbers as sport-specific rather than one global name", async () => {
    const body = (await (await get("api/sports/catalog")).json()) as {
      periodTypes: Array<{
        number: number;
        names: string[];
        sports: string[];
        sportSpecific: boolean;
      }>;
    };

    const one = body.periodTypes.find((entry) => entry.number === 1);
    expect(one?.names).toEqual(["1st 5 Innings", "1st Half", "1st Period"]);
    expect(one?.sportSpecific).toBe(true);
    expect(body.periodTypes[0]?.number).toBe(0);
    expect(body.periodTypes[0]?.sportSpecific).toBe(false);
  });

  test("exposes sub-sport collisions instead of hiding them", async () => {
    const body = (await (await get("api/sports/catalog")).json()) as {
      subSports: Array<{ code: string; sports: string[]; collision: boolean }>;
      collisions: Array<{ code: string; sports: string[] }>;
    };

    const arena = body.subSports.find((entry) => entry.code === "Arena");
    expect(arena?.collision).toBe(true);
    expect(arena?.sports).toEqual(["Football", "Horse Racing"]);
    expect(body.collisions.map((c) => c.code).sort()).toEqual([
      "Arena",
      "NCAA Extra",
    ]);
  });

  test("filters to one sport, including its period menu", async () => {
    const res = await get("api/sports/catalog?sport=Hockey");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sports: Array<{ sport: string; periods: Array<{ name: string }> }>;
    };
    expect(body.sports).toHaveLength(1);
    expect(body.sports[0]?.sport).toBe("Hockey");
    expect(body.sports[0]?.periods.map((p) => p.name)).toContain("1st Period");
  });

  test("resolves a sub-sport only with its sport", async () => {
    const ok = await get(
      "api/sports/catalog?sport=Horse%20Racing&subSport=Arena",
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      sport: string;
      subSport: { code: string; name: string };
      periods: Array<{ name: string }>;
    };
    expect(body.sport).toBe("Horse Racing");
    expect(body.subSport.code).toBe("Arena");
    expect(body.periods.length).toBeGreaterThan(0);

    const wrongSport = await get(
      "api/sports/catalog?sport=Hockey&subSport=Arena",
    );
    expect(wrongSport.status).toBe(404);
    const wrongBody = (await wrongSport.json()) as {
      error: string;
      periods: Array<{ name: string }>;
    };
    expect(wrongBody.error).toContain("Hockey has no sub-sport");
    // The period menu still comes back, so a caller can show the sport's own types.
    expect(wrongBody.periods.length).toBeGreaterThan(0);
  });

  test("404s an unknown sport with the known list", async () => {
    const res = await get("api/sports/catalog?sport=Kabaddi");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { known: string[] };
    expect(body.known).toContain("Football");
    expect(body.known).toHaveLength(19);
  });

  test("the taxonomy endpoint links to the catalog", async () => {
    const body = (await (await get("api/sports")).json()) as {
      catalog: string;
    };
    expect(body.catalog).toBe("/api/sports/catalog");
  });
});
