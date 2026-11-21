import { describe, expect, test } from "bun:test";
import {
  capturePendingAccountWeblog,
  parseWeblogAccountCoverage,
} from "../lib/f402_weblog_capture.ts";
const NOW = Date.parse("2026-11-20T00:10:00Z");
const snapshot = {
  capturedAt: new Date(NOW - 1000).toISOString(),
  dataSource: "live:pending",
  games: [
    { customerID: "A" },
    { customerID: "A " },
    { customerID: "B" },
    { customerID: "" },
  ],
};
const activity = {
  AccessDateTime: "2026-11-19 18:00:00.000",
  Operation: "LOGIN",
  LoginID: "actor",
  IPAddress: "203.0.113.1",
  Data: "private payload",
};
describe("scheduled pending-account weblog capture", () => {
  test("deduplicates account scope, uses Central date and counts empty accounts", async () => {
    const requests: URLSearchParams[] = [];
    const result = await capturePendingAccountWeblog({
      snapshot,
      agentId: "OWNER",
      now: () => NOW,
      fetchActivity: async (body) => {
        requests.push(body);
        return Response.json({
          LIST: body.get("customerID") === "A" ? [activity] : [],
        });
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.get("ip")).toBe("A");
    expect(requests[0]?.get("start")).toBe("11/19/2026");
    expect(requests[0]?.get("type")).toBe("A");
    expect(result.coverage).toMatchObject({
      snapshotTicketRows: 4,
      unidentifiedTicketRows: 1,
      eligibleAccounts: 2,
      requestedAccounts: 2,
      completedAccounts: 2,
      accountsWithActivity: 1,
      emptyAccounts: 1,
      failedAccounts: 0,
      activityRows: 1,
      wholeBookComplete: false,
    });
    expect(result.rows[0]).not.toHaveProperty("Data");
    expect(JSON.stringify(result.coverage)).not.toContain("OWNER");
    expect(parseWeblogAccountCoverage(result.coverage)).toEqual(
      result.coverage,
    );
    expect(
      parseWeblogAccountCoverage({
        ...result.coverage,
        wholeBookComplete: true,
      }),
    ).toBeNull();
    expect(
      parseWeblogAccountCoverage({ ...result.coverage, completedAccounts: 9 }),
    ).toBeNull();
  });
  test("rejects stale, fixture, empty and oversized scopes before provider calls", async () => {
    let calls = 0;
    const fetchActivity = async () => {
      calls++;
      return Response.json([]);
    };
    for (const bad of [
      { ...snapshot, capturedAt: new Date(NOW - 3600001).toISOString() },
      { ...snapshot, dataSource: "fixture" },
      { ...snapshot, games: [] },
      {
        ...snapshot,
        games: Array.from({ length: 201 }, (_, i) => ({
          customerID: String(i),
        })),
      },
    ]) {
      await expect(
        capturePendingAccountWeblog({
          snapshot: bad,
          agentId: "owner",
          now: () => NOW,
          fetchActivity,
        }),
      ).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  test("failed or malformed activity never produces a publishable capture", async () => {
    for (const response of [
      () => new Response(null, { status: 401 }),
      () =>
        Response.json({
          LIST: [{ LoginID: "only", IPAddress: "203.0.113.1" }],
        }),
      () => Response.json({ LIST: [] }),
    ]) {
      await expect(
        capturePendingAccountWeblog({
          snapshot,
          agentId: "owner",
          now: () => NOW,
          fetchActivity: async () => response(),
        }),
      ).rejects.toThrow("capture incomplete");
    }
  });
});

test("a later account failure refuses to publish earlier successful activity", async () => {
  let calls = 0;
  await expect(
    capturePendingAccountWeblog({
      snapshot,
      agentId: "owner",
      now: () => NOW,
      fetchActivity: async () =>
        ++calls === 1
          ? Response.json({ LIST: [activity] })
          : new Response(null, { status: 503 }),
    }),
  ).rejects.toThrow("completed=1/2");
});
