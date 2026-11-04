import { afterEach, describe, expect, test } from "bun:test";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";
import {
  buildF402PendingRollup,
  effectiveLineHundredths,
  normalizeRotation,
  toCents,
} from "../lib/f402_pending_rollup.ts";
import { createF402PendingSink } from "../lib/f402_pending_sink.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(rows: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge3b-"));
  dirs.push(dir);
  const path = join(dir, "pending.json");
  await writeFile(path, JSON.stringify({ Pending: rows }));
  return path;
}
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  Login: "L",
  WagerNumber: 1,
  TicketNumber: 1000 + n,
  AmountWagered: 1_000_000,
  ToWinAmount: 2_000_000,
  AdjSpread: -4,
  TeaserPoints: 0,
  SportType: "Football",
  PeriodDescription: "Game",
  AcceptedDateTime: "2026-11-03 14:00:00.900",
  ChosenTeamID: "Away",
  Team1ID: "Home",
  Team2ID: "Away",
  Team1RotNum: 243,
  Team2RotNum: 244,
  ...extra,
});
describe("bridge 3b", () => {
  test("normalizes the 20-bit rotation and Alt-Spread shift", () => {
    expect(normalizeRotation(243)).toBe(243);
    expect(normalizeRotation(5244)).toBe(244);
    expect(() => normalizeRotation(1_048_576)).toThrow();
    expect(() => normalizeRotation(-1)).toThrow();
  });
  test("effective line flips for the away side", () => {
    expect(effectiveLineHundredths(-4, 0, 1)).toBe(-400);
    expect(effectiveLineHundredths(-4, 0, -1)).toBe(400);
    expect(effectiveLineHundredths(3, 1, 1)).toBe(400);
    expect(toCents("100.50")).toBe(10_050n);
  });
  test("dedupes parent tickets and suppresses k<5 cells", async () => {
    const rollup = await buildF402PendingRollup(
      await fixture([row(1), row(2), row(3), row(4), row(5)]),
    );
    expect(rollup.ticketCount).toBe(5);
    expect(rollup.legCount).toBe(5);
    expect(rollup.totals.totalStakeCents).toBe(5_000_000);
    expect(rollup.cells).toHaveLength(1);
    expect(rollup.cells[0]?.definedLiabilityCents).toBe(10_000_000);
    expect(rollup.suppressed.cellCount).toBe(0);
    const sparse = await buildF402PendingRollup(await fixture([row(1)]));
    expect(sparse.cells).toHaveLength(0);
    expect(sparse.suppressed.ticketCount).toBe(1);
    expect(sparse.ticketCount).toBe(1);
    expect(sparse.provenance.live).toBe(false);
    expect(JSON.stringify(sparse)).not.toContain('"Login"');
    expect(sparse.gates.find((g) => g.gate === 8)?.status).toBe("skipped");
  });
  test("fixture artifacts never publish to the live channel; gateway smoke delivers a live one", async () => {
    const server = createBlobLiveBetsServer({
      blobs: new MemoryBlobStore(),
      apiToken: "t",
      ticketSecret: "s",
      port: 0,
      hostname: "127.0.0.1",
    });
    try {
      const ticket = (await fetch(
        `http://127.0.0.1:${server.server.port}/api/v1/ws-tickets`,
        { method: "POST", headers: { authorization: "Bearer t" } },
      ).then((r) => r.json())) as { ticket: string };
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.server.port}/ws/live-bets?ticket=${ticket.ticket}`,
      );
      await new Promise<void>((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = () => rej(new Error("ws"));
      });
      const sub = new Promise<void>((res) => {
        ws.onmessage = () => res();
      });
      ws.send(JSON.stringify({ type: "SUBSCRIBE", channel: "f402-pending" }));
      await sub;
      const msg = new Promise<string>((res) => {
        ws.onmessage = (e) => res(String(e.data));
      });
      const sink = createF402PendingSink({
        liveBets: true,
        r2: false,
        gatewayUrl: `http://127.0.0.1:${server.server.port}`,
        apiToken: "t",
      });
      const rollup = await buildF402PendingRollup(await fixture([row(1)]), {
        live: true,
        sourceKind: "capture",
      });
      expect((await sink.publishLiveBets(rollup)).ok).toBe(true);
      expect(JSON.parse(await msg).kind).toBe("f402-pending");
      const fixtureRollup = await buildF402PendingRollup(
        await fixture([row(1)]),
      );
      expect(await sink.publishLiveBets(fixtureRollup)).toEqual({
        ok: true,
        skipped: true,
      });
      ws.close();
    } finally {
      server.close(true);
    }
  });
});
