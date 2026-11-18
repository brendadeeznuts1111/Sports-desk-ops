import { describe, expect, test } from "bun:test";
import { createWagerSoATable } from "./wager_soa.ts";
import { wagerSoAForLog } from "./wager_soa_log_view.ts";

describe("createWagerSoATable", () => {
  test("columns share one ArrayBuffer slab", () => {
    const table = createWagerSoATable(4);
    expect(table.capacity).toBe(4);
    expect(table.spreadCol.buffer).toBe(table.totalCol.buffer);
    expect(table.totalCol.buffer).toBe(table.oddsCol.buffer);
    expect(table.spreadCol.byteLength).toBe(16);
    expect(table.totalCol.byteOffset).toBe(16);
    expect(table.oddsCol.byteOffset).toBe(32);
  });

  test("writes in one column are visible via shared backing store", () => {
    const table = createWagerSoATable(2);
    table.spreadCol[0] = 110;
    table.totalCol[1] = 220;
    table.oddsCol[0] = -115;
    const raw = new Int32Array(table.spreadCol.buffer);
    expect(raw[0]).toBe(110);
    expect(raw[3]).toBe(220);
    expect(raw[4]).toBe(-115);
  });
});

describe("wagerSoAForLog", () => {
  test("inspect and JSON omit column payloads", () => {
    const table = createWagerSoATable(8);
    table.oddsCol[0] = 99999;
    const view = wagerSoAForLog(table);
    const inspected = Bun.inspect(view);
    expect(inspected).toContain("[REDACTED]");
    expect(inspected).not.toContain("99999");
    expect(view.toJSON()).toEqual({ kind: "WagerSoATable", capacity: 8 });
  });
});
