import { expect, test } from "bun:test";
import { buildCustomerProfiles } from "../lib/customer_profile.ts";
import { fixtureBookRows, fixtureTree } from "./__fixtures__/v1-edge-cases.ts";

test("v1 placement keeps root level zero, reports missing agents, and marks cycles", () => {
  const { profiles, summary } = buildCustomerProfiles(
    fixtureBookRows,
    fixtureTree,
  );
  const [root, missing, blank, cycle] = profiles;
  expect(root!.placement).toMatchObject({
    inTree: true,
    level: 0,
    depth: 0,
    chain: [],
  });
  expect(missing!.placement).toMatchObject({
    inTree: false,
    level: null,
    depth: null,
    chain: [],
  });
  expect(blank!.flags).toContain("agent (none) is not in the tree");
  expect(summary.notInTree).toEqual(["GHOST_AGENT"]);
  expect(cycle!.placement.chain).toEqual(["CYCLE_B", "CYCLE_A (cycle)"]);
  expect(cycle!.placement.depth).toBe(2);
});

test("v1 sample includes void risk and preserves channel case", () => {
  const { profiles, summary } = buildCustomerProfiles(
    fixtureBookRows,
    fixtureTree,
  );
  expect(profiles[0]!.tickets).toMatchObject({
    n: 2,
    voids: 1,
    riskUsd: 150,
    netUsd: 90,
    winRate: 1,
    holdPct: 60,
    byLeague: { NBA: { n: 2, riskUsd: 150, netUsd: 90 } },
    byMarket: { SPREAD: { n: 2, riskUsd: 150, netUsd: 90 } },
  });
  expect(profiles[2]!.tickets).toMatchObject({
    riskUsd: 0,
    winRate: null,
    holdPct: null,
  });
  expect(summary).toMatchObject({
    customers: 6,
    tickets: 7,
    lifetimeNetUsd: 360,
    sampleRiskUsd: 500,
    sampleNetUsd: -40,
  });
  expect(summary.byLeague.UNKNOWN).toEqual({
    n: 1,
    riskUsd: 200,
    netUsd: -200,
  });
  expect(summary.byChannel).toEqual({
    GSLIVE: { n: 2, riskUsd: 200, netUsd: 135 },
    gslive: { n: 1, riskUsd: 50, netUsd: 0 },
    unknown: { n: 1, riskUsd: 200, netUsd: -200 },
    WEB: { n: 3, riskUsd: 50, netUsd: 25 },
  });
});

test("v1 rankings preserve input order on ties and include positive nonzero nets", () => {
  // Reverse the tied rows so an ID-based tie-break would fail this check.
  const { summary } = buildCustomerProfiles(
    [fixtureBookRows[1]!, fixtureBookRows[0]!, ...fixtureBookRows.slice(2)],
    fixtureTree,
  );
  expect(summary.sharpest.map((row) => row.customerId)).toEqual([
    "C002",
    "C001",
    "C004",
    "C004",
    "C005",
    "C003",
  ]);
  expect(summary.sharpest[0]).toEqual({
    customerId: "C002",
    sharpScore: 85,
    clvBps: 0,
  });
  expect(summary.worstRecent).toEqual([
    { customerId: "C002", netUsd: -200 },
    { customerId: "C005", netUsd: 25 },
    { customerId: "C004", netUsd: 45 },
    { customerId: "C001", netUsd: 90 },
  ]);
});

test("found child keeps its ancestry without a level and counts a PUSH in win rate", () => {
  const { profiles, summary } = buildCustomerProfiles(
    fixtureBookRows,
    fixtureTree,
  );
  const child = profiles.find((row) => row.customerId === "C005");
  expect(child?.placement).toMatchObject({
    inTree: true,
    level: null,
    depth: 2,
    chain: ["CHILD_OK", "ROOT_AGENT"],
  });
  expect(child?.tickets).toMatchObject({
    n: 2,
    voids: 0,
    riskUsd: 50,
    netUsd: 25,
    winRate: 0.5,
    holdPct: 50,
  });
  expect(summary.sharpest.slice(-2).map((row) => row.sharpScore)).toEqual([
    0, -10,
  ]);
  expect(
    summary.sharpest
      .filter((row) => row.customerId === "C004")
      .map((row) => row.sharpScore),
  ).toEqual([40, 15]);
  expect(
    profiles
      .filter((row) => row.customerId === "C004")
      .map((row) => row.tickets.n),
  ).toEqual([1, 0]);
});
