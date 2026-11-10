import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPORT_PENDING_OPERATION } from "../lib/f402_live_pending.ts";
import { WAGER_TYPE_LABELS } from "../lib/game_admin.ts";
import {
  buildArtifact,
  hierarchyIndexFromAgentIndex,
  readPendingRows,
  type AgentKey,
} from "../lib/live_bets.ts";
import {
  LIVE_BETS_V1_DEPRECATION_HEADER,
  startServer,
} from "../services/sportsdesk_webview_server.ts";
import type {
  LiveBetsV2Request,
  LiveBetsV2Response,
} from "../src/contracts/live_bets.v2.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SAMPLE_FIXTURE_REL = "tests/f402-pending-wager-sample.json";

const V2_FIXTURE_REQUEST: LiveBetsV2Request = {
  source: "fixture",
  fallback: "sample",
  path: SAMPLE_FIXTURE_REL,
};

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
  capturedAt: string | null;
}

describe("live-bets v2 contract, summary parity, and frozen v1", () => {
  let server: ReturnType<typeof startServer>;
  let fixtureDir: string;
  let liveBetsPath: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "live-bets-summary-"));
    liveBetsPath = join(fixtureDir, "live-bets.json");
    const samplePayload: unknown = await Bun.file(
      join(REPO_ROOT, SAMPLE_FIXTURE_REL),
    ).json();
    const agentIndexPayload: unknown = await Bun.file(
      join(REPO_ROOT, "data/agent-index.json"),
    ).json();
    const built = buildArtifact(readPendingRows(samplePayload), {
      operation: REPORT_PENDING_OPERATION,
      capturedAt: null,
      hierarchyIndex: hierarchyIndexFromAgentIndex(agentIndexPayload),
    });
    await Bun.write(
      liveBetsPath,
      JSON.stringify({
        ...built,
        dataSource: `fixture:${SAMPLE_FIXTURE_REL}`,
      }),
    );

    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      liveBetsPath,
      livePending: { enabled: false },
      liveTicker: { enabled: false },
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const getSummary = async (): Promise<Summary> => {
    const res = await fetch(`${server.url}api/live-bets/summary?source=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; summary: Summary };
    expect(body.success).toBe(true);
    return body.summary;
  };

  const getV2 = async (
    req: LiveBetsV2Request = V2_FIXTURE_REQUEST,
  ): Promise<{ res: Response; body: LiveBetsV2Response }> => {
    const params = new URLSearchParams({
      source: req.source,
      fallback: req.fallback,
      ...(req.path === undefined ? {} : { path: req.path }),
    });
    const res = await fetch(
      `${server.url}api/v2/live-bets?${params.toString()}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as LiveBetsV2Response;
    return { res, body };
  };

  test("returns the documented summary shape with exact fixture totals", async () => {
    const summary = await getSummary();
    expect(summary).toEqual({
      totalGames: 1,
      totalWagered: 22400000,
      totalToWin: 20000000,
      totalPending: 1,
      bySubSport: {
        NFL: { games: 1, wagered: 22400000, toWin: 20000000 },
      },
      byAgent: {
        HRGROUP: { games: 1, wagered: 22400000, toWin: 20000000 },
      },
      dataSource: `fixture:${SAMPLE_FIXTURE_REL}`,
      capturedAt: null,
    });
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

  test("agrees with the summary embedded in /api/v2/live-bets", async () => {
    const summary = await getSummary();
    const { body: full } = await getV2();

    expect(summary).toEqual(full.summary);
    expect(summary.totalGames).toBe(full.games.length);
  });

  test("is derived, not a stored literal", async () => {
    // A hand-maintained aggregate drifts from the game list; recompute independently.
    const {
      body: { games },
    } = await getV2();
    const summary = await getSummary();

    expect(games.reduce((n, g) => n + g.wagered, 0)).toBe(summary.totalWagered);
    expect(games.reduce((n, g) => n + g.toWin, 0)).toBe(summary.totalToWin);
  });

  test("never serves credentials or customer names", async () => {
    const params = new URLSearchParams({
      source: V2_FIXTURE_REQUEST.source,
      fallback: V2_FIXTURE_REQUEST.fallback,
      path: SAMPLE_FIXTURE_REL,
    });
    const body = await (
      await fetch(`${server.url}api/v2/live-bets?${params.toString()}`)
    ).text();
    for (const key of ["Password", "NameFirst", "Login"]) {
      expect(body).not.toContain(`"${key}"`);
    }
  });

  test("does not advertise home/away it cannot know", async () => {
    const {
      body: { games },
    } = await getV2();
    for (const game of games) {
      expect(game).not.toHaveProperty("home");
      expect(game).not.toHaveProperty("away");
    }
  });

  test("marks the snapshot as non-cacheable", async () => {
    const { res } = await getV2();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("joins real scoreboard scores onto matching wagers", async () => {
    const { body } = await getV2();

    expect(body.scoreboard).not.toBeNull();
    expect(body.scoreboard?.summary.games).toBeGreaterThan(0);
    expect(body.scoreboard?.source).toContain("scoreboard");

    expect(body.games).toHaveLength(1);
    const [game] = body.games;
    expect(game?.team1?.name).toBe("Arizona Cardinals");
    expect(game?.team2?.name).toBe("Dallas Cowboys");
    expect(game?.subSport).toBe("NFL");
    expect(game?.scoreboard).toEqual({
      team1Score: 33,
      team2Score: 30,
      status: "final",
      period: "Final",
      league: "NFL",
      broadcast: "FOX",
      observedAt: "2026-11-01",
      source: "operator paste of fantasy402 manager.html scoreboard",
    });
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
      wagers: Array<{ category: string; games: number; live: number }>;
      scoreboard: Array<{ category: string; games: number; live: number }>;
    };

    expect(body.liveFilter).toBe("LIVE");
    expect(body.all).toContain("Football");
    expect(body.all).not.toContain("All Sports");
    expect(body.wagers).toEqual([{ category: "Football", games: 1, live: 0 }]);

    // Every reported category must exist in the taxonomy.
    for (const row of [...body.wagers, ...body.scoreboard]) {
      expect(body.all).toContain(row.category);
      expect(row.games).toBeGreaterThan(0);
    }
  });

  test("tags every wager with its taxonomy category and exact category rollup", async () => {
    const {
      body: { games, sports },
    } = await getV2();
    const positions = new Set<string>([
      ...Object.values(WAGER_TYPE_LABELS),
      "Other",
    ]);
    for (const game of games) {
      expect(sports.all).toContain(game.category);
      expect(positions).toContain(game.position);
    }
    expect(games).toHaveLength(1);
    expect(games[0]?.category).toBe("Football");
    expect(games[0]?.position).toBe("Straight");
    expect(games[0]?.wagerType).toBe("S");
    expect(sports.categories).toEqual([
      { category: "Football", games: 1, live: 0 },
    ]);
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

    expect(body.games).toHaveLength(1);
    expect(body.games[0]?.matchup).toBe("Cardinals vs Cowboys");
    expect(body.games[0]?.league).toBe("NFL");
    expect(body.games[0]?.total).toEqual({
      wagers: 1,
      wagered: 22400000,
      toWin: 20000000,
    });

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

  test("reports agent scope resolved against the committed hierarchy", async () => {
    const {
      body: { agents, games },
    } = await getV2();

    expect(agents.hierarchyLoaded).toBe(true);
    expect(agents.maxLevel).toBe(19);
    expect(agents.unassignedGames).toBe(0);
    expect(agents.unresolved).toEqual([]);
    expect(agents.agents).toEqual([
      {
        key: "HRGROUP" as AgentKey,
        id: "HRGROUP",
        level: 6,
        agentType: "A",
        games: 1,
        wagered: 22400000,
        toWin: 20000000,
      },
    ]);
    expect(games[0]?.agent).toEqual({
      key: "HRGROUP" as AgentKey,
      id: "HRGROUP",
      level: 6,
      agentType: "A",
    });

    // Collisions are surfaced, never silently resolved.
    for (const collision of agents.collisions) {
      expect(collision.agentIds.length).toBeGreaterThan(1);
      expect(agents.agents.map((a) => a.key)).not.toContain(collision.key);
    }
  });

  test("strict + present file returns dataSource 'file', fallbackUsed false, and empty warnings", async () => {
    const { body } = await getV2({
      source: "file",
      fallback: "strict",
      path: liveBetsPath,
    });

    expect(body.apiVersion).toBe("2");
    expect(body.dataSource).toBe("file");
    expect(body.fallbackUsed).toBe(false);
    expect(body.provenance.path).toBe(liveBetsPath);
    expect(body.provenance.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.games).toHaveLength(1);
    expect(body.pendingCount).toBe(1);
    expect(body.warnings).toEqual([]);
  });

  test("sample + present file returns dataSource 'file', fallbackUsed false, and empty warnings", async () => {
    const { body } = await getV2({
      source: "file",
      fallback: "sample",
      path: liveBetsPath,
    });

    expect(body.apiVersion).toBe("2");
    expect(body.dataSource).toBe("file");
    expect(body.fallbackUsed).toBe(false);
    expect(body.provenance.path).toBe(liveBetsPath);
    expect(body.provenance.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.games).toHaveLength(1);
    expect(body.pendingCount).toBe(1);
    expect(body.warnings).toEqual([]);
  });

  test("strict + missing file returns dataSource 'none' with non-empty warnings", async () => {
    const missingPath = join(fixtureDir, "does-not-exist.json");
    const { body } = await getV2({
      source: "file",
      fallback: "strict",
      path: missingPath,
    });

    expect(body.apiVersion).toBe("2");
    expect(body.dataSource).toBe("none");
    expect(body.fallbackUsed).toBe(false);
    expect(body.provenance.path).toBeNull();
    expect(body.provenance.hash).toBeNull();
    expect(body.games).toEqual([]);
    expect(body.pendingCount).toBe(0);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings).toContain("no data");
    expect(body.warnings.some((w) => w.includes("missing file"))).toBe(true);
  });

  test("sample + missing file falls back to sample fixture and records provenance", async () => {
    const missingPath = join(fixtureDir, "does-not-exist.json");
    const { body } = await getV2({
      source: "file",
      fallback: "sample",
      path: missingPath,
    });

    expect(body.apiVersion).toBe("2");
    expect(body.dataSource).toBe("fixture");
    expect(body.fallbackUsed).toBe(true);
    expect(body.provenance.path).toBe(SAMPLE_FIXTURE_REL);
    expect(body.provenance.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.games).toHaveLength(1);
    expect(body.pendingCount).toBe(1);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings.some((w) => w.includes(SAMPLE_FIXTURE_REL))).toBe(
      true,
    );
  });

  test("v1 route keeps old shape, /api/live-bets 308-redirects, and v2 returns apiVersion '2' (rejecting auto)", async () => {
    const v1Res = await fetch(`${server.url}api/v1/live-bets?source=file`);
    expect(v1Res.status).toBe(200);
    const v1Body = (await v1Res.json()) as Record<string, unknown>;
    expect(v1Body.success).toBe(true);
    expect(v1Body.freshness).toBeObject();
    expect(v1Body.live).toBeObject();
    expect(v1Body.generatedAt).toBeString();
    expect(v1Body).not.toHaveProperty("apiVersion");
    expect(v1Body).not.toHaveProperty("fallbackUsed");

    const redirectRes = await fetch(`${server.url}api/live-bets?source=file`, {
      redirect: "manual",
    });
    expect(redirectRes.status).toBe(308);
    expect(redirectRes.headers.get("location")).toBe(
      "/api/v1/live-bets?source=file",
    );
    expect(redirectRes.headers.get("x-deprecation")).toBe(
      LIVE_BETS_V1_DEPRECATION_HEADER,
    );

    const v2PostRes = await fetch(`${server.url}api/v2/live-bets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(V2_FIXTURE_REQUEST),
    });
    expect(v2PostRes.status).toBe(200);
    const v2Body = (await v2PostRes.json()) as LiveBetsV2Response;
    expect(v2Body.apiVersion).toBe("2");
    expect(v2Body.dataSource).toBe("fixture");
    expect(v2Body.fallbackUsed).toBe(false);
    expect(v2Body.provenance.path).toBe(SAMPLE_FIXTURE_REL);
    expect(v2Body.provenance.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v2Body.warnings).toEqual([]);

    const autoRes = await fetch(`${server.url}api/v2/live-bets?source=auto`);
    expect(autoRes.status).toBe(400);
  });
});
