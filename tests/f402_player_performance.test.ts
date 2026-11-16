/**
 * The performance tab read.
 *
 * Fixture: the operator-supplied 2026-11-13 response (31 rows). It is the observed body, but not a
 * probe capture — no headers or status travel with it — so the parse/money math is exercised and
 * the live-capture half stays tracked separately.
 */
import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  buildPerformancePlayerRequest,
  parsePlayerPerformancePayload,
  summarizePlayerPerformance,
} from "../lib/f402_player_performance.ts";

const FIXTURE = resolve(
  import.meta.dir,
  "fixtures/f402-get-performance-player.response.json",
);

describe("buildPerformancePlayerRequest", () => {
  it("reproduces the observed body", () => {
    expect(
      buildPerformancePlayerRequest({ acc: "BRT106", agentID: "BILLY666" }),
    ).toEqual({
      acc: "BRT106",
      period: 0,
      operation: "getPerformancePlayer",
      RRO: 1,
      agentID: "BILLY666",
      agentOwner: "BILLY666",
    });
  });

  it("keeps period and agentOwner overridable", () => {
    const body = buildPerformancePlayerRequest({
      acc: "BRT106",
      agentID: "BILLY666",
      agentOwner: "MASTER_A",
      period: 2,
    });
    expect(body.agentOwner).toBe("MASTER_A");
    expect(body.period).toBe(2);
  });
});

describe("parsePlayerPerformancePayload", () => {
  it("parses the saved 31-day series and sums cents", async () => {
    const raw = (await Bun.file(FIXTURE).json()) as unknown;
    const days = parsePlayerPerformancePayload(raw);
    expect(days.length).toBe(31);
    expect(days[1]).toEqual({
      Date: "11/12/2026 Thursday",
      Won: 1500000,
      Lost: 1150000,
    });

    const summary = summarizePlayerPerformance(days);
    expect(summary.activeDays).toBe(10);
    expect(summary.totalWonCents).toBe(17_750_000);
    expect(summary.totalLostCents).toBe(10_055_000);
    expect(summary.netCents).toBe(7_695_000);
  });

  it("rejects a payload that is not an array", () => {
    expect(() => parsePlayerPerformancePayload({ LIST: [] })).toThrow(/array/);
  });

  it("rejects a row that would become NaN", () => {
    expect(() =>
      parsePlayerPerformancePayload([
        { Date: "11/12/2026 Thursday", Won: "15", Lost: 0 },
      ]),
    ).toThrow(/Won/);
    expect(() =>
      parsePlayerPerformancePayload([{ Date: "yesterday", Won: 1, Lost: 0 }]),
    ).toThrow(/Date/);
  });
});
