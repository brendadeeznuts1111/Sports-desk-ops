import { afterEach, describe, expect, test } from "bun:test";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";
import {
  Bridge3bPendingColumnStore,
  Bridge3bTicketDedupeStore,
  buildF402PendingRollup,
  effectiveLineHundredths,
  hashTicketKey,
  normalizeRotation,
  packPendingKey32,
  serializeF402PendingRollup,
  serializeF402PendingRollupPayload,
  toCents,
  unpackPendingKey32,
} from "../lib/f402_pending_rollup.ts";
import { stableJson } from "../lib/f402_bet_ticker_delta.ts";
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
  test("GATE-08 passes on matching 3c exposure and fails with a variance", async () => {
    const path = await fixture([row(1), row(2), row(3), row(4), row(5)]);
    const pass = await buildF402PendingRollup(path, {
      gate8: { openExposureCents: 10_000_000 },
    });
    expect(pass.gates.find((g) => g.gate === 8)?.status).toBe("pass");
    await expect(
      buildF402PendingRollup(path, { gate8: { openExposureCents: 9_999_999 } }),
    ).rejects.toMatchObject({
      gate: expect.objectContaining({ gate: 8, status: "fail" }),
    });
  });

  test("PackedPendingKey32 packs and unpacks accurately across 20-bit rotation and 6-bit labels", () => {
    const cases = [
      { rotation: 0, sport: 0, period: 0 },
      { rotation: 243, sport: 1, period: 2 },
      { rotation: 5244 - 5000, sport: 14, period: 14 },
      { rotation: 1_048_575, sport: 63, period: 63 },
    ];
    for (const c of cases) {
      const packed = packPendingKey32(c.rotation, c.sport, c.period);
      const unpacked = unpackPendingKey32(packed);
      expect(unpacked.rotation).toBe(c.rotation);
      expect(unpacked.sport).toBe(c.sport);
      expect(unpacked.period).toBe(c.period);
    }
  });

  test("multi-leg ticket retains parent stake once and increments legCount", async () => {
    // 2 legs for the same ticket: TicketNumber 5000, WagerNumber 1, Login "L"
    const leg1 = row(1, {
      TicketNumber: 5000,
      WagerNumber: 1,
      Team1RotNum: 243,
      AmountWagered: 100_000,
      ToWinAmount: 300_000,
    });
    const leg2 = row(2, {
      TicketNumber: 5000,
      WagerNumber: 1,
      Team1RotNum: 244,
      AmountWagered: 100_000,
      ToWinAmount: 300_000,
    });
    const single1 = row(3, {
      TicketNumber: 5001,
      WagerNumber: 1,
      AmountWagered: 50_000,
      ToWinAmount: 100_000,
    });
    const single2 = row(4, {
      TicketNumber: 5002,
      WagerNumber: 1,
      AmountWagered: 50_000,
      ToWinAmount: 100_000,
    });
    const single3 = row(5, {
      TicketNumber: 5003,
      WagerNumber: 1,
      AmountWagered: 50_000,
      ToWinAmount: 100_000,
    });
    const single4 = row(6, {
      TicketNumber: 5004,
      WagerNumber: 1,
      AmountWagered: 50_000,
      ToWinAmount: 100_000,
    });

    const rollup = await buildF402PendingRollup(
      await fixture([leg1, leg2, single1, single2, single3, single4]),
    );
    // 5 parent tickets total: 5000 (2 legs), 5001, 5002, 5003, 5004 (1 leg each)
    expect(rollup.ticketCount).toBe(5);
    expect(rollup.legCount).toBe(6);
    // Total stake = 100,000 + 4 * 50,000 = 300,000 cents
    expect(rollup.totals.totalStakeCents).toBe(300_000);
    // Total potential payout = 300,000 + 4 * 100,000 = 700,000 cents
    expect(rollup.totals.potentialPayoutCents).toBe(700_000);
  });

  test("Bridge3bTicketDedupeStore open-addressing handles collisions safely", () => {
    const store = new Bridge3bTicketDedupeStore(16);
    // Insert two tickets
    store.insert("L1", 1, 1001, 0, 243, 0, 0, 100n, 200n, 0, 0);
    store.insert("L2", 1, 1002, 0, 244, 0, 0, 150n, 300n, 0, 0);

    expect(store.ticketCount).toBe(2);
    expect(store.lookup("L1", 1, 1001, 0)).toBe(0);
    expect(store.lookup("L2", 1, 1002, 0)).toBe(1);
    expect(store.lookup("L3", 1, 1003, 0)).toBe(-1);
  });

  test("deterministic serializer matches stableJson output exactly", async () => {
    const rollup = await buildF402PendingRollup(
      await fixture([row(1), row(2), row(3), row(4), row(5)]),
    );
    const customSerialized = serializeF402PendingRollup(rollup);
    const stableSerialized = stableJson(rollup);
    expect(customSerialized).toBe(stableSerialized);

    const { sourceSha256: _sha, ...payloadWithoutSha } = rollup;
    const payloadSerialized =
      serializeF402PendingRollupPayload(payloadWithoutSha);
    expect(stableJson(payloadWithoutSha)).toBe(payloadSerialized);
  });

  test("Bridge3bPendingColumnStore initializes with specified capacity and power-of-two slots", () => {
    const store = new Bridge3bPendingColumnStore(128);
    expect(store.capacity).toBe(128);
    expect(store.slotCount).toBeGreaterThanOrEqual(4096);
    expect(store.cellSlots.length).toBe(store.slotCount);
    expect(store.packedCellKeyCol.length).toBe(128);

    const h = hashTicketKey("L", 1, 1000, 0);
    expect(typeof h).toBe("number");
    expect(h).toBeGreaterThanOrEqual(0);
  });

  test("complementary sibling suppression suppresses lone visible cell in group", async () => {
    // 2 sibling cells in Football|Game across 2 rotations:
    // rot 243 has 1 ticket (k < 5 -> suppressed)
    // rot 244 has 5 tickets (k >= 5)
    // Because rot 244 is the lone visible cell in the sibling group, complementary suppression suppresses it too!
    const rows = [
      row(1, {
        Team1RotNum: 243,
        Team2RotNum: 243,
        ChosenTeamID: "Away",
        Team2ID: "Away",
      }),
      row(2, {
        Team1RotNum: 244,
        Team2RotNum: 244,
        ChosenTeamID: "Away",
        Team2ID: "Away",
      }),
      row(3, {
        Team1RotNum: 244,
        Team2RotNum: 244,
        ChosenTeamID: "Away",
        Team2ID: "Away",
      }),
      row(4, {
        Team1RotNum: 244,
        Team2RotNum: 244,
        ChosenTeamID: "Away",
        Team2ID: "Away",
      }),
      row(5, {
        Team1RotNum: 244,
        Team2RotNum: 244,
        ChosenTeamID: "Away",
        Team2ID: "Away",
      }),
      row(6, {
        Team1RotNum: 244,
        Team2RotNum: 244,
        ChosenTeamID: "Away",
        Team2ID: "Away",
      }),
    ];
    const rollup = await buildF402PendingRollup(await fixture(rows));
    // Both cells must be suppressed (0 visible cells)
    expect(rollup.cells).toHaveLength(0);
    expect(rollup.suppressed.cellCount).toBe(2);
    expect(rollup.suppressed.ticketCount).toBe(6);
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
