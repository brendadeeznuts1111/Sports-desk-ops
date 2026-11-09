import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCfbGames } from "../lib/cfb_events.ts";

const GAMES = [
  {
    id: "g1",
    slug: "cfb-g1",
    title: "Game One",
    volume24hr: 1000,
    endDate: "2026-10-31",
    markets: [
      {
        conditionId: "0x1",
        slug: "g1-ml",
        clobTokenIds: '["t1","t2"]',
        sportsMarketType: "moneyline",
      },
    ],
  },
];

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cfb-events-cache-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const okFetch = (async () =>
  new Response(JSON.stringify(GAMES), {
    status: 200,
  })) as unknown as typeof fetch;

describe("CFB event index cache", () => {
  test("cacheGames writes the index and offline reuses it without fetching", async () => {
    const cacheDir = tempDir();
    const first = await loadCfbGames({
      fetchImpl: okFetch,
      cacheDir,
      cacheGames: true,
      includeClosedGames: false,
      now: Date.now(),
    });
    expect(first.map((game) => game.slug)).toEqual(["cfb-g1"]);

    let fetched = 0;
    const second = await loadCfbGames({
      fetchImpl: (async () => {
        fetched += 1;
        throw new Error("network used");
      }) as unknown as typeof fetch,
      cacheDir,
      offline: true,
      includeClosedGames: false,
    });
    expect(fetched).toBe(0);
    expect(second).toEqual(first);
  });

  test("offline without a cache fails instead of returning a short index", async () => {
    await expect(
      loadCfbGames({
        cacheDir: tempDir(),
        offline: true,
        includeClosedGames: false,
        fetchImpl: okFetch,
      }),
    ).rejects.toThrow("offline: no cached events");
  });

  test("stale entries are refetched when the TTL has passed", async () => {
    const cacheDir = tempDir();
    const now = Date.now();
    await loadCfbGames({
      fetchImpl: okFetch,
      cacheDir,
      cacheGames: true,
      includeClosedGames: false,
      now,
      cacheTtlHours: 1,
    });
    let fetched = 0;
    const refetched = await loadCfbGames({
      fetchImpl: (async () => {
        fetched += 1;
        return new Response(JSON.stringify([]), { status: 200 });
      }) as unknown as typeof fetch,
      cacheDir,
      cacheGames: true,
      includeClosedGames: false,
      now: now + 2 * 3_600_000,
      cacheTtlHours: 1,
    });
    expect(fetched).toBe(1);
    expect(refetched).toEqual([]);
  });

  test("buildComboUniquenessReport in offline mode reuses fresh wallet caches and throws on expired or missing wallet caches", async () => {
    const { buildComboUniquenessReport } =
      await import("../lib/combo_uniqueness.ts");
    const { writeFileSync } = await import("node:fs");
    const cacheDir = tempDir();
    const wallet = "0x1111111111111111111111111111111111111111";
    const walletFile = join(cacheDir, "wallets.txt");
    writeFileSync(walletFile, `${wallet}\n`, "utf8");

    const now = Date.now();
    await buildComboUniquenessReport({
      fetchImpl: (async (input: Request | string | URL) => {
        const url = String(input);
        if (url.includes("/events?")) {
          return new Response(JSON.stringify(GAMES), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
      cacheDir,
      cacheGames: true,
      includeClosedGames: false,
      leaderboard: false,
      seedTrades: false,
      walletFile,
      now,
      cacheTtlHours: 1,
    });

    // Offline reuses a fresh wallet cache without fetching.
    const freshReport = await buildComboUniquenessReport({
      fetchImpl: (async () => {
        throw new Error("network used in offline mode");
      }) as unknown as typeof fetch,
      cacheDir,
      offline: true,
      includeClosedGames: false,
      leaderboard: false,
      seedTrades: false,
      walletFile,
      now,
      cacheTtlHours: 1,
    });
    expect(freshReport.walletsScanned).toBe(1);

    // Offline TTL is enforced: an expired wallet cache cannot be refetched offline.
    await expect(
      buildComboUniquenessReport({
        fetchImpl: (async () => {
          throw new Error("network used in offline mode");
        }) as unknown as typeof fetch,
        cacheDir,
        offline: true,
        includeClosedGames: false,
        leaderboard: false,
        seedTrades: false,
        walletFile,
        now: now + 48 * 3_600_000,
        cacheTtlHours: 1,
      }),
    ).rejects.toThrow("offline: no cached combos");

    // Offline throws if a requested wallet has no cached combo file.
    const missingWalletFile = join(cacheDir, "missing-wallets.txt");
    writeFileSync(
      missingWalletFile,
      "0x2222222222222222222222222222222222222222\n",
      "utf8",
    );
    await expect(
      buildComboUniquenessReport({
        fetchImpl: okFetch,
        cacheDir,
        offline: true,
        includeClosedGames: false,
        leaderboard: false,
        seedTrades: false,
        walletFile: missingWalletFile,
      }),
    ).rejects.toThrow("offline: no cached combos");
  });
});
