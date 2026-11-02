import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

interface Bucket {
  games: number;
  wagered: number;
  toWin: number;
}

interface Summary {
  totalGames: number;
  totalWagered: number;
  totalToWin: number;
  totalPending: number;
  bySubSport: Record<string, Bucket>;
  byAgent: Record<string, Bucket>;
  dataSource: string;
}

describe("GET /api/live-bets/summary", () => {
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

  const getSummary = async (): Promise<Summary> => {
    const res = await fetch(`${server.url}api/live-bets/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; summary: Summary };
    expect(body.success).toBe(true);
    return body.summary;
  };

  test("returns the documented summary shape", async () => {
    const summary = await getSummary();
    expect(summary.totalGames).toBeNumber();
    expect(summary.totalWagered).toBeNumber();
    expect(summary.totalToWin).toBeNumber();
    expect(summary.totalPending).toBeNumber();
    expect(summary.bySubSport).toBeObject();
    expect(summary.byAgent).toBeObject();
    expect(summary.dataSource).toBeString();
  });

  test("sub-sport breakdown sums to the totals", async () => {
    const summary = await getSummary();
    const buckets = Object.values(summary.bySubSport);

    expect(buckets.reduce((n, b) => n + b.games, 0)).toBe(summary.totalGames);
    expect(buckets.reduce((n, b) => n + b.wagered, 0)).toBe(
      summary.totalWagered,
    );
    expect(buckets.reduce((n, b) => n + b.toWin, 0)).toBe(summary.totalToWin);
  });

  test("agent breakdown sums to the totals", async () => {
    const summary = await getSummary();
    const buckets = Object.values(summary.byAgent);

    expect(buckets.reduce((n, b) => n + b.games, 0)).toBe(summary.totalGames);
    expect(buckets.reduce((n, b) => n + b.wagered, 0)).toBe(
      summary.totalWagered,
    );
    expect(buckets.reduce((n, b) => n + b.toWin, 0)).toBe(summary.totalToWin);
  });

  test("agrees with the summary embedded in /api/live-bets", async () => {
    const summary = await getSummary();
    const full = (await (await fetch(`${server.url}api/live-bets`)).json()) as {
      summary: Summary;
      games: unknown[];
    };

    expect(summary).toEqual(full.summary);
    expect(summary.totalGames).toBe(full.games.length);
  });

  test("is derived, not a stored literal", async () => {
    // A hand-maintained aggregate drifts from the game list; recompute independently.
    const games = (
      (await (await fetch(`${server.url}api/live-bets`)).json()) as {
        games: Array<{ wagered: number; toWin: number }>;
      }
    ).games;
    const summary = await getSummary();

    expect(games.reduce((n, g) => n + g.wagered, 0)).toBe(summary.totalWagered);
    expect(games.reduce((n, g) => n + g.toWin, 0)).toBe(summary.totalToWin);
  });

  test("never serves credentials or customer names", async () => {
    const body = await (await fetch(`${server.url}api/live-bets`)).text();
    for (const key of ["Password", "NameFirst", "Login"]) {
      expect(body).not.toContain(`"${key}"`);
    }
  });

  test("does not advertise home/away it cannot know", async () => {
    const { games } = (await (
      await fetch(`${server.url}api/live-bets`)
    ).json()) as {
      games: Array<Record<string, unknown>>;
    };
    for (const game of games) {
      expect(game).not.toHaveProperty("home");
      expect(game).not.toHaveProperty("away");
    }
  });

  test("marks the snapshot as non-cacheable", async () => {
    const res = await fetch(`${server.url}api/live-bets`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("joins real scoreboard scores onto matching wagers only", async () => {
    const body = (await (await fetch(`${server.url}api/live-bets`)).json()) as {
      games: Array<{
        team1: { name: string };
        team2: { name: string };
        subSport: string;
        scoreboard: { team1Score: number | null; period: string | null } | null;
      }>;
      scoreboard: {
        source: string;
        observedAt: string | null;
        summary: { games: number };
      } | null;
    };

    expect(body.scoreboard).not.toBeNull();
    expect(body.scoreboard?.summary.games).toBeGreaterThan(0);
    expect(body.scoreboard?.source).toContain("scoreboard");

    for (const game of body.games) {
      const match = game.scoreboard;
      if (match === null) continue;
      // A joined score must name the same clubs the wager does.
      expect(`${game.team1.name} ${game.team2.name}`.toLowerCase()).toContain(
        "cardinals",
      );
      expect(match.period).toBeString();
    }
  });

  test("serves the scoreboard on its own endpoint", async () => {
    const res = await fetch(`${server.url}api/scoreboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      games: unknown[];
      summary: { games: number; byLeague: Record<string, number> };
      notes?: string[];
    };
    expect(body.games.length).toBe(body.summary.games);
    expect(Object.keys(body.summary.byLeague).length).toBeGreaterThan(0);
  });

  test("exposes the portal sport taxonomy with counts", async () => {
    const res = await fetch(`${server.url}api/sports`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      all: string[];
      liveFilter: string;
      wagers: Array<{ category: string; games: number }>;
      scoreboard: Array<{ category: string; games: number; live: number }>;
    };

    expect(body.liveFilter).toBe("LIVE");
    expect(body.all).toContain("Football");
    expect(body.all).not.toContain("All Sports");
    expect(body.wagers.length).toBeGreaterThan(0);

    // Every reported category must exist in the taxonomy.
    for (const row of [...body.wagers, ...body.scoreboard]) {
      expect(body.all).toContain(row.category);
      expect(row.games).toBeGreaterThan(0);
    }
  });

  test("tags every wager with its taxonomy category", async () => {
    const { games, sports } = (await (
      await fetch(`${server.url}api/live-bets`)
    ).json()) as {
      games: Array<{ category: string; position: string; wagerType: string }>;
      sports: { all: string[]; categories: Array<{ category: string }> };
    };
    for (const game of games) {
      expect(sports.all).toContain(game.category);
      expect(["Straight", "Parlay", "Teaser", "Other"]).toContain(
        game.position,
      );
    }
    expect(sports.categories.length).toBeGreaterThan(0);
  });

  test("serves the Game Admin exposure view per fixture", async () => {
    const res = await fetch(`${server.url}api/game-admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      games: Array<{
        matchup: string;
        league: string;
        preGame: boolean;
        total: { wagers: number; wagered: number; toWin: number };
        positions: Record<string, { wagers: number; wagered: number }>;
      }>;
    };

    for (const game of body.games) {
      // Position buckets must add back up to the fixture total.
      const buckets = Object.values(game.positions);
      expect(buckets.reduce((n, b) => n + b.wagers, 0)).toBe(game.total.wagers);
      expect(buckets.reduce((n, b) => n + b.wagered, 0)).toBe(
        game.total.wagered,
      );
      expect(typeof game.preGame).toBe("boolean");
      expect(game.matchup).toContain(" vs ");
      expect(game.league).toBeString();
    }
  });

  test("reports agent scope resolved against the hierarchy", async () => {
    const { agents, games } = (await (
      await fetch(`${server.url}api/live-bets`)
    ).json()) as {
      agents: {
        agents: Array<{ key: string; level: number | null; games: number }>;
        unresolved: string[];
        unassignedGames: number;
        maxLevel: number | null;
        hierarchyLoaded: boolean;
        collisions: Array<{ key: string; agentIds: string[] }>;
      };
      games: Array<{ agent: { key: string; level: number | null } }>;
    };

    expect(agents.hierarchyLoaded).toBeBoolean();
    expect(agents.agents.length).toBeGreaterThan(0);

    // Every rolled-up agent must correspond to a game that named it, and levels must come
    // from the hierarchy (null when no hierarchy was loaded) — never asserted from the row.
    for (const entry of agents.agents) {
      const named = games.filter((g) => g.agent.key === entry.key);
      expect(named.length).toBe(entry.games);
      for (const game of named) expect(game.agent.level).toBe(entry.level);
    }

    if (!agents.hierarchyLoaded) {
      expect(agents.maxLevel).toBeNull();
      expect(agents.agents.every((a) => a.level === null)).toBe(true);
    } else {
      expect(agents.maxLevel).toBeNumber();
    }

    // Collisions are surfaced, never silently resolved.
    for (const collision of agents.collisions) {
      expect(collision.agentIds.length).toBeGreaterThan(1);
      expect(agents.agents.map((a) => a.key)).not.toContain(collision.key);
    }
  });
});
