import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_DOMAIN = join(
  import.meta.dir,
  "fixtures/ingestion-replay-domain.jsonl",
);
const TMP = mkdtempSync(join(tmpdir(), "sportsdesk-ingestion-replay-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
import { SIGNAL_SLA_MS } from "../design/domain-branded-types.ts";
import {
  classifySportsdeskPricePattern,
  extractXmlBoardPrice,
  latencySlaMsForChannelCode,
  parseSportsdeskIngestionLogRow,
  createIngestionReplayDatabase,
  queryIngestionTradesAsOf,
  replayIngestionExitCode,
  replaySportsdeskIngestionLog,
  replaySportsdeskIngestionLogWithDb,
  resolveIngestionChannel,
  VALID_TIME_OPEN_SENTINEL,
  VALID_TIME_OPEN_SENTINEL_SQL,
} from "../services/sportsdesk_ingestion_replay.ts";
import { SPORTSDESK_BUN_SQLITE_OPTIONS } from "../lib/sportsdesk_sqlite.ts";

describe("sportsdesk_ingestion_replay", () => {
  test("valid-time open sentinel is exact i64 BigInt (not JS number)", () => {
    expect(VALID_TIME_OPEN_SENTINEL).toBe(9223372036854775807n);
    expect(Number.isSafeInteger(Number(VALID_TIME_OPEN_SENTINEL))).toBe(false);
    expect(VALID_TIME_OPEN_SENTINEL_SQL).toBe("9223372036854775807");
  });

  test("replay database uses strict + safeIntegers", () => {
    expect(SPORTSDESK_BUN_SQLITE_OPTIONS.strict).toBe(true);
    expect(SPORTSDESK_BUN_SQLITE_OPTIONS.safeIntegers).toBe(true);
    const db = createIngestionReplayDatabase();
    const stmt = db.prepare(
      `INSERT INTO ingestion_trades (id, channel_id) VALUES (?, ?)`,
    );
    expect(() => stmt.run(1)).toThrow(
      /Missing parameter|expected 2 values|parameter|bind/i,
    );
    db.close();
  });

  test("parse row + XML price", () => {
    const row = parseSportsdeskIngestionLogRow({
      id: 1,
      v_t: 100,
      v_to: 200,
      channel_id: "Internet",
      channel_status: "ACTIVE",
      xml: "<t><p>100</p></t>",
    });
    expect(row?.id).toBe(1);
    expect(row?.valid_to).toBe(200);
    expect(extractXmlBoardPrice(row!.xml)).toBe(100);
    expect(resolveIngestionChannel(row!)?.channelStatus).toBe("ACTIVE");
  });

  test("price patterns", () => {
    expect(classifySportsdeskPricePattern(105, 100)).toBe("UP");
    expect(classifySportsdeskPricePattern(250, 105)).toBe("SPIKE_UP");
    expect(classifySportsdeskPricePattern(240, 250)).toBe("DOWN");
  });

  test("SSOT SLA map from domain-branded-types", () => {
    expect(SIGNAL_SLA_MS.GSLIVE).toBe(500);
    expect(SIGNAL_SLA_MS.CSLEVEL2).toBe(2000);
    expect(SIGNAL_SLA_MS.GSBUILDER).toBe(1000);
    expect(SIGNAL_SLA_MS.BLOCKED).toBeUndefined();
    expect(latencySlaMsForChannelCode("GSLIVE")).toBe(500);
  });

  test("self-healing replay skips poison line", async () => {
    const file = join(TMP, `ingest-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"v_t":100,"v_to":200,"channel_id":"Internet","channel_status":"ACTIVE","xml":"<t><p>100</p></t>"}\n{"id":4,"v_t":250,"xml":"<bad\n{"id":5,"v_t":300,"v_to":400,"channel_id":"Internet","channel_status":"ACTIVE","xml":"<t><p>240</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.corruptedLineSkips).toBe(1);
    expect(result.trades.map((t) => t.id)).toEqual([1, 5]);
    await Bun.write(file, "");
  });

  test("DROPPED bypasses SQLite and XML hot path", async () => {
    const file = join(TMP, `dropped-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"v_t":100,"v_to":200,"channel_id":"BLOCKED","channel_status":"DROPPED","xml":"<t><p>0</p></t>"}\n{"id":2,"v_t":100,"v_to":200,"channel_id":"Internet","channel_status":"ACTIVE","xml":"<t><p>100</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.droppedChannelSkips).toBe(1);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.channel_id).toBe("Internet");
    await Bun.write(file, "");
  });

  test("domain fixture: DROPPED bypass vs SUPPRESSED CSLEVEL2 enforce + SLA", async () => {
    const result = await replaySportsdeskIngestionLog({
      path: FIXTURE_DOMAIN,
      bitemporal: true,
    });
    expect(result.droppedChannelSkips).toBe(1);
    expect(result.droppedByChannel.BLOCKED).toBe(1);
    expect(result.skippedInserts).toBe(1);
    expect(result.latencyViolationsSeen).toBe(4);
    expect(result.latencyViolationsAccepted).toBe(3);
    expect(result.trades.map((t) => t.id).sort()).toEqual([
      1, 2, 5, 6, 7, 8, 9,
    ]);
    expect(result.trades.find((t) => t.id === 8)!.channel_id).toBe("GATEWAY");
    expect(result.trades.find((t) => t.id === 9)!.channel_id).toBe("GSBUILDER");
    expect(SIGNAL_SLA_MS.GATEWAY).toBe(1000);
    expect(SIGNAL_SLA_MS.GSBUILDER).toBe(1000);
    const cs = result.trades.filter((t) => t.channel_id === "CSLEVEL2");
    expect(cs).toHaveLength(2);
    expect(cs.every((t) => t.channel_status === "SUPPRESSED")).toBe(true);
    expect(cs.find((t) => t.id === 5)!.latency_ms).toBe(1800);
    expect(cs.find((t) => t.id === 6)!.latency_ms).toBe(2100);
    const alert = result.trades.find((t) => t.channel_id === "ALERT");
    expect(alert?.latency_ms).toBe(260);
    expect(SIGNAL_SLA_MS.ALERT).toBe(250);
  });

  test("overlap trigger enforced without --bitemporal flag", async () => {
    const file = join(TMP, `trigger-always-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"channel_id":"GSLIVE","channel_status":"CRITICAL","v_t":100,"v_to":200,"xml":"<t><p>100</p></t>"}\n{"id":2,"channel_id":"GSLIVE","channel_status":"CRITICAL","v_t":150,"v_to":250,"xml":"<t><p>105</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.skippedInserts).toBe(1);
    expect(result.trades).toHaveLength(1);
    await Bun.write(file, "");
  });

  test("--bitemporal rejects rows missing v_to", async () => {
    const file = join(TMP, `no-vto-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"channel_id":"Internet","channel_status":"ACTIVE","v_t":100,"xml":"<t><p>100</p></t>"}\n`,
    );
    await expect(
      replaySportsdeskIngestionLog({ path: file, bitemporal: true }),
    ).rejects.toThrow(/v_to required under --bitemporal/);
    await Bun.write(file, "");
  });

  test("latency violation counted when lat exceeds SSOT SLA", async () => {
    const file = join(TMP, `sla-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"channel_id":"GSLIVE","channel_status":"CRITICAL","v_t":100,"v_to":150,"latency_ms":600,"xml":"<t><p>250</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.latencyViolationsSeen).toBe(1);
    expect(result.latencyViolationsAccepted).toBe(1);
    expect(result.trades).toHaveLength(1);
    await Bun.write(file, "");
  });

  test("inverted valid interval rejected by CHECK (never inserted)", async () => {
    const file = join(TMP, `inverted-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"channel_id":"Internet","channel_status":"ACTIVE","v_t":100,"v_to":50,"xml":"<t><p>100</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.trades).toHaveLength(0);
    expect(result.skippedInserts).toBe(1);
    await Bun.write(file, "");
  });

  test("UNIQUE index blocks two open tx rows per (channel_id, id)", () => {
    const db = createIngestionReplayDatabase();
    const insertOpen = (validFrom: number, validTo: number) => {
      db.run(
        `INSERT INTO ingestion_trades (
          id, channel_id, channel_status, valid_from, valid_to, tx_from, tx_to,
          price, link_id, xml_hash, latency_ms
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [
          10,
          "Internet",
          "ACTIVE",
          validFrom,
          validTo,
          1000,
          50,
          null,
          "abc",
          null,
        ],
      );
    };
    insertOpen(100, 200);
    expect(() => insertOpen(300, 400)).toThrow(
      /one_open_tx_per_lane_id|UNIQUE/,
    );
  });

  test("out-of-order tx_from rejected before close", async () => {
    const file = join(TMP, `tx-order-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":10,"channel_id":"Internet","channel_status":"ACTIVE","v_t":900,"v_to":950,"tx_from":2000,"xml":"<t><p>50</p></t>"}\n{"id":10,"channel_id":"Internet","channel_status":"ACTIVE","v_t":900,"v_to":950,"tx_from":1500,"xml":"<t><p>55</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.txAxisViolations).toBe(1);
    expect(result.skippedInserts).toBe(1);
    expect(replayIngestionExitCode(result)).toBe(2);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.price).toBe(50);
    await Bun.write(file, "");
  });

  test("same-millisecond correction nudges tx_from and both rows as-of", async () => {
    const file = join(TMP, `tx-samems-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":12,"channel_id":"Internet","channel_status":"ACTIVE","v_t":900,"v_to":950,"tx_from":1000,"xml":"<t><p>50</p></t>"}\n{"id":12,"channel_id":"Internet","channel_status":"ACTIVE","v_t":900,"v_to":950,"tx_from":1000,"xml":"<t><p>55</p></t>"}\n`,
    );
    const { result, db } = await replaySportsdeskIngestionLogWithDb({
      path: file,
    });
    expect(result.txAxisViolations).toBe(0);
    expect(result.physicalRowCount).toBe(2);
    expect(result.currentRowCount).toBe(1);
    expect(result.trades[0]!.price).toBe(55);
    const atFirst = queryIngestionTradesAsOf(db, "Internet", 925, 1000);
    expect(atFirst[0]!.price).toBe(50);
    const atSecond = queryIngestionTradesAsOf(db, "Internet", 925, 1001);
    expect(atSecond[0]!.price).toBe(55);
    await Bun.write(file, "");
  });

  test("supersede scoped to (channel_id, id) not global id", async () => {
    const file = join(TMP, `lane-id-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":4,"channel_id":"Internet","channel_status":"ACTIVE","v_t":1000,"v_to":1100,"tx_from":100,"xml":"<t><p>1</p></t>"}\n{"id":4,"channel_id":"GSLIVE","channel_status":"CRITICAL","v_t":100,"v_to":150,"tx_from":100,"xml":"<t><p>2</p></t>"}\n{"id":4,"channel_id":"Internet","channel_status":"ACTIVE","v_t":1000,"v_to":1100,"tx_from":200,"xml":"<t><p>3</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.transactionSupersedes).toBe(1);
    expect(result.currentRowCount).toBe(2);
    const internet = result.trades.find(
      (t) => t.channel_id === "Internet" && t.id === 4,
    );
    const gslive = result.trades.find(
      (t) => t.channel_id === "GSLIVE" && t.id === 4,
    );
    expect(internet?.price).toBe(3);
    expect(gslive?.price).toBe(2);
    await Bun.write(file, "");
  });

  test("duplicate id closes tx_to and supports as-of transaction queries", async () => {
    const file = join(TMP, `tx-supersede-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":10,"channel_id":"Internet","channel_status":"ACTIVE","v_t":900,"v_to":950,"tx_from":1000,"xml":"<t><p>50</p></t>"}\n{"id":10,"channel_id":"Internet","channel_status":"ACTIVE","v_t":900,"v_to":950,"tx_from":2000,"xml":"<t><p>55</p></t>"}\n`,
    );
    const { result, db } = await replaySportsdeskIngestionLogWithDb({
      path: file,
    });
    expect(result.transactionSupersedes).toBe(1);
    expect(result.physicalRowCount).toBe(2);
    expect(result.currentRowCount).toBe(1);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.price).toBe(55);
    const mid = queryIngestionTradesAsOf(db, "Internet", 925, 1500);
    expect(mid).toHaveLength(1);
    expect(mid[0]!.price).toBe(50);
    const later = queryIngestionTradesAsOf(db, "Internet", 925, 2500);
    expect(later[0]!.price).toBe(55);
    await Bun.write(file, "");
  });

  test("replay skips insert when open row already exists (UNIQUE)", async () => {
    const file = join(TMP, `idempotent-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":11,"channel_id":"Internet","channel_status":"ACTIVE","v_t":600,"v_to":700,"tx_from":5000,"xml":"<t><p>11</p></t>"}\n`,
    );
    const { result, db } = await replaySportsdeskIngestionLogWithDb({
      path: file,
    });
    expect(result.currentRowCount).toBe(1);
    expect(() =>
      db.run(
        `INSERT INTO ingestion_trades (
          id, channel_id, channel_status, valid_from, valid_to, tx_from, tx_to,
          price, link_id, xml_hash, latency_ms
        ) VALUES (11, 'Internet', 'ACTIVE', 800, 900, 5001, NULL, 11, NULL, 'x', NULL)`,
      ),
    ).toThrow(/one_open_tx_per_lane_id|UNIQUE/);
    await Bun.write(file, "");
  });

  test("exit code: corruption outranks SLA", async () => {
    const file = join(TMP, `exit-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"channel_id":"GSLIVE","channel_status":"CRITICAL","v_t":100,"v_to":150,"latency_ms":600,"xml":"<t><p>250</p></t>"}\n{"id":2,"v_t":200,"xml":"<bad\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.corruptedLineSkips).toBe(1);
    expect(result.latencyViolationsSeen).toBe(1);
    expect(replayIngestionExitCode(result)).toBe(1);
    await Bun.write(file, "");
  });

  test("exit code: tx-axis without SLA exits 2", async () => {
    const file = join(TMP, `exit-tx-${Date.now()}.jsonl`);
    await Bun.write(
      file,
      `{"id":1,"channel_id":"Internet","channel_status":"ACTIVE","v_t":100,"v_to":200,"tx_from":5000,"latency_ms":100,"xml":"<t><p>100</p></t>"}\n{"id":1,"channel_id":"Internet","channel_status":"ACTIVE","v_t":100,"v_to":200,"tx_from":4000,"latency_ms":100,"xml":"<t><p>90</p></t>"}\n`,
    );
    const result = await replaySportsdeskIngestionLog({ path: file });
    expect(result.txAxisViolations).toBe(1);
    expect(result.latencyViolationsSeen).toBe(0);
    expect(replayIngestionExitCode(result)).toBe(2);
    await Bun.write(file, "");
  });
});
