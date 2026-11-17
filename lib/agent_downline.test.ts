import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAgentDownline,
  treeCollisionIndex,
  treeDownlineCounts,
  treeSubtreeExposure,
} from "./agent_downline.ts";

describe("agent downline", () => {
  test("indexes agents by uppercase login and keeps missing fields null", async () => {
    const path = join(tmpdir(), `downline-${Date.now()}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        meta: { master_agent: "M1" },
        agents: [
          { agent: "a1", master: "M1", total_accounts: 2, lifetime_net: -50 },
          { agent: "A2" },
          { agent: "" },
        ],
      }),
    );
    const index = await loadAgentDownline(path);
    expect(index?.agents).toBe(2);
    expect(index?.byAgent.get("A1")?.totalAccounts).toBe(2);
    expect(index?.byAgent.get("A1")?.grade).toBeNull();
    expect(index?.byAgent.get("A2")?.lifetimeNetUsd).toBeNull();
  });

  test("a missing file is null, not an empty index", async () => {
    expect(
      await loadAgentDownline("/tmp/does-not-exist-downline.json"),
    ).toBeNull();
  });

  test("counts direct and descendant agents from parent links", () => {
    const counts = treeDownlineCounts(
      {
        ROOT: {},
        A1: { p: "ROOT" },
        A2: { p: "ROOT" },
        B1: { p: "A1" },
        B2: { p: "A1" },
        C1: { p: "B1" },
      },
      ["root", "A1"],
    );
    expect(counts.get("ROOT")).toEqual({
      directAgents: 2,
      descendantAgents: 5,
    });
    expect(counts.get("A1")).toEqual({ directAgents: 2, descendantAgents: 3 });
  });
});

describe("tree subtree exposure", () => {
  test("a customer counts toward its agent and every ancestor", () => {
    const exposure = treeSubtreeExposure(
      {
        ROOT: {},
        A1: { p: "ROOT" },
        B1: { p: "A1" },
        LEAF: { p: "B1" },
      },
      [
        {
          customerId: "C1",
          agentId: "A1",
          positions: [
            {
              risk_usd: 100,
              to_win_usd: 250,
              sport: "Football",
              writer: "Internet",
            },
          ],
        },
        {
          customerId: "C2",
          agentId: "LEAF",
          positions: [
            {
              risk_usd: 50,
              to_win_usd: 90,
              sport: "Basketball",
              writer: "GSBUILDER",
            },
          ],
        },
        {
          customerId: "C3",
          agentId: "OUTSIDE",
          positions: [{ risk_usd: 10, to_win_usd: 20 }],
        },
      ],
    );
    expect(exposure.get("ROOT")).toMatchObject({
      customers: 2,
      positions: 2,
      openRiskUsd: 150,
      openToWinUsd: 340,
      ownCustomers: 0,
      downlineCustomers: 2,
      ownRiskUsd: 0,
      downlineRiskUsd: 150,
      topSport: "Football",
      topSportSharePct: 66.7,
      sportCount: 2,
      topCustomerRiskUsd: 100,
      topCustomerSharePct: 66.7,
      maxTicketRiskUsd: 100,
      avgTicketRiskUsd: 75,
    });
    expect(exposure.get("A1")?.openRiskUsd).toBe(150);
    expect(exposure.get("A1")?.topCustomers[0]).toMatchObject({
      key: "C1",
      riskUsd: 100,
      sharePct: 66.7,
    });
    expect(exposure.get("A1")?.sports[0]).toMatchObject({
      key: "Football",
      riskUsd: 100,
    });
    expect(exposure.get("A1")?.writers.map((w) => w.key)).toEqual([
      "Internet",
      "GSBUILDER",
    ]);
    expect(exposure.get("B1")?.openRiskUsd).toBe(50);
    expect(exposure.get("LEAF")?.customers).toBe(1);
    expect(exposure.get("OUTSIDE")).toMatchObject({
      customers: 1,
      positions: 1,
      openRiskUsd: 10,
      openToWinUsd: 20,
      ownCustomers: 1,
      downlineCustomers: 0,
      topSport: null,
      sportCount: 0,
      topCustomerRiskUsd: 10,
      topCustomerSharePct: 100,
      maxTicketRiskUsd: 10,
      avgTicketRiskUsd: 10,
    });
  });
});

describe("tree collisions", () => {
  test("indexes every colliding agent id under the shared key", () => {
    const index = treeCollisionIndex([
      { key: "BRANDON", agentIds: ["BRANDON.", "BRANDON.."] },
    ]);
    expect(index.get("BRANDON.")?.key).toBe("BRANDON");
    expect(index.get("BRANDON..")?.agentIds).toEqual(["BRANDON.", "BRANDON.."]);
    expect(index.get("OTHER")).toBeUndefined();
  });
});
