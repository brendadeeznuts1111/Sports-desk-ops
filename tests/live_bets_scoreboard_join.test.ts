import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * Ticker-shaped pending rows (no team1/team2) must not 500 the scoreboard enrichment pass.
 */
describe("GET /api/live-bets scoreboard join", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-bets-minimal-"));
  const artifactPath = join(dir, "live-bets.json");
  const savedOrigins = Bun.env.SPORTSDESK_ALLOWED_ORIGINS;
  Bun.env.SPORTSDESK_ALLOWED_ORIGINS = "https://desk.example";

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(
    artifactPath,
    JSON.stringify({
      schemaVersion: 1,
      dataSource: "capture:fixture@test",
      capturedAt: "2026-11-04T19:58:00.000Z",
      operation: "fixture",
      pendingCount: 1,
      agents: { agents: [] },
      games: [
        {
          ticketNumber: "501",
          sport: "Football",
          subSport: "PREGAME",
          wagerType: "S",
          wagered: 100,
          toWin: 200,
          status: "P",
        },
      ],
    }),
  );

  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    liveBetsPath: artifactPath,
    livePending: { enabled: false, env: { NODE_ENV: "test" } },
    liveTicker: { enabled: false, env: { NODE_ENV: "test" } },
  });

  afterAll(() => {
    server.stop(true);
    if (savedOrigins === undefined)
      Reflect.deleteProperty(Bun.env, "SPORTSDESK_ALLOWED_ORIGINS");
    else Bun.env.SPORTSDESK_ALLOWED_ORIGINS = savedOrigins;
  });

  test("?source=file returns 200 with null per-game scoreboard", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/api/live-bets?source=file`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      games: Array<{ scoreboard: unknown }>;
      summary?: { byAgent?: Record<string, { games: number }> };
    };
    expect(body.games[0]?.scoreboard).toBeNull();
    expect(body.summary?.byAgent?.unassigned?.games).toBe(1);
  });
});
