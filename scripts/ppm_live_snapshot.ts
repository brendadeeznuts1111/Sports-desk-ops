/**
 * @file scripts/ppm_live_snapshot.ts
 * @description Fetches the PPM player-site fixture snapshot and prints a
 * normalized summary. This is the ingestion half of the PPM mapping: the
 * parser in `lib/ppm_live_feed.ts` stays pure, so the same bytes can be
 * replayed in tests.
 *
 *   bun scripts/ppm_live_snapshot.ts
 *   bun scripts/ppm_live_snapshot.ts --out scratch/ppm/all-events.json
 *
 * The site issues a `GSID` session cookie on the page load; `/live/allEvents`
 * answers without credentials once that cookie is present. Nothing here writes
 * to the repository: the default output is stdout.
 */
import { parsePpmAllEvents } from "../lib/ppm_live_feed.ts";
import { toDeskBoard } from "../lib/ppm_desk_board.ts";
import { parsePpmMetadata } from "../lib/ppm_metadata.ts";
import { assertSportIdSpaceOverlap } from "../lib/ppm_join_guard.ts";

const BASE = Bun.env.PPM_BASE_URL ?? "https://ppm.sportswidgets.pro/live";

function parseOutputPath(argv: readonly string[]): string | null {
  const index = argv.indexOf("--out");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value) throw new Error("--out requires a path");
  return value;
}

async function sessionCookie(): Promise<string> {
  const page = await fetch(`${BASE}/`, {
    headers: { "user-agent": "sportsdesk-ops/ppm-snapshot" },
  });
  if (!page.ok) {
    throw new Error(`page load failed: HTTP ${page.status}`);
  }
  const cookies = page.headers.getSetCookie();
  const gsid = cookies.find((cookie) => cookie.startsWith("GSID="));
  if (!gsid) throw new Error("no GSID cookie on the page response");
  return gsid.split(";")[0]!;
}

async function loadMetadata(): Promise<ReturnType<typeof parsePpmMetadata>> {
  // The metadata endpoint lives at the host root, not under the app's /live/ path.
  const url = new URL("/betLobbyV2/eventsMetadata/", BASE);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`eventsMetadata failed: HTTP ${response.status}`);
  }
  return parsePpmMetadata(await response.json());
}

async function main(): Promise<void> {
  const cookie = await sessionCookie();
  const response = await fetch(`${BASE}/allEvents`, {
    headers: { cookie, accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`allEvents failed: HTTP ${response.status}`);
  }
  const snapshot = parsePpmAllEvents(await response.json());
  const metadata = await loadMetadata();
  assertSportIdSpaceOverlap(metadata.sportNames.keys(), snapshot.sportIds);
  const wantsUpcoming = process.argv.includes("--upcoming");
  const board = toDeskBoard(snapshot, {
    sportNames: metadata.sportNames,
    ...(wantsUpcoming ? { sinceUnix: Math.floor(Date.now() / 1000) } : {}),
  });

  const summary = {
    base: BASE,
    counts: snapshot.counts,
    metadata: metadata.counts,
    board: board.counts,
    window: wantsUpcoming ? "upcoming-only" : "all",
    nextGames: board.games.slice(0, 5).map((game) => ({
      id: game.id,
      sport: game.sportName ?? `sport ${game.sportId}`,
      leagueId: game.leagueId,
      home: game.home.name,
      away: game.away.name,
      startsAt: new Date(game.startTimeUnix * 1000).toISOString(),
      pricedEvents: game.eventIds.length,
    })),
  };

  const out = parseOutputPath(process.argv);
  const wantsBoard = process.argv.includes("--board");
  const payload = wantsBoard ? { summary, board } : summary;
  if (out) {
    await Bun.write(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ ...summary, writtenTo: out }, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

if (import.meta.main) {
  await main();
}
