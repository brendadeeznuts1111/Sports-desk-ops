import { describe, expect, test } from "bun:test";

import {
  loadUnifiedTeamRegistry,
  resetUnifiedTeamRegistryCache,
  unifiedTeamCodesMatch,
} from "../lib/unified_team_registry.ts";

describe("unified team registry", () => {
  test("WSH and WAS are the same NBA franchise in registry", () => {
    resetUnifiedTeamRegistryCache();
    expect(unifiedTeamCodesMatch("NBA", "WSH", "WAS")).toBe(true);
  });

  test("F402 full name resolves to canonical code", () => {
    resetUnifiedTeamRegistryCache();
    const reg = loadUnifiedTeamRegistry();
    expect(reg.canonicalCode("NBA", "ATLANTA HAWKS")).toBe("ATL");
    expect(reg.canonicalCode("NFL", "KANSAS CITY CHIEFS")).toBe("KC");
  });

  test("Kalshi code maps from canonical", () => {
    resetUnifiedTeamRegistryCache();
    const reg = loadUnifiedTeamRegistry();
    expect(reg.kalshiCode("NBA", "WSH")).toBe("WAS");
    expect(reg.kalshiCode("NBA", "BKN")).toBe("BKN");
  });

  test("resolveTeamSide returns stable registry ids for F402 names", () => {
    resetUnifiedTeamRegistryCache();
    const reg = loadUnifiedTeamRegistry();
    const side = reg.resolveTeamSide("NBA", [
      "ATLANTA HAWKS",
      "WASHINGTON WIZARDS",
    ]);
    expect(side.slots[0]?.registryTeamId).toBe("nba:atl");
    expect(side.slots[1]?.registryTeamId).toBe("nba:was");
  });
});
