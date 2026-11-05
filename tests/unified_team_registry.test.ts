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

test("CFB seed resolves Kalshi team names and codes", () => {
  resetUnifiedTeamRegistryCache();
  const reg = loadUnifiedTeamRegistry();
  expect(reg.canonicalCode("CFB", "FLORIDA ATLANTIC")).toBe("FAU");
  expect(reg.canonicalCode("CFB", "UTSA")).toBe("UTSA");
  expect(reg.kalshiCode("CFB", "UTSA")).toBe("UTSA");
  expect(unifiedTeamCodesMatch("CFB", "FAU", "FAU")).toBe(true);
});

test("capture-derived aliases resolve full F402 names to venue codes", () => {
  resetUnifiedTeamRegistryCache();
  const reg = loadUnifiedTeamRegistry();
  expect(reg.canonicalCode("NBA", "MIAMI HEAT")).toBe("MIA");
  expect(reg.kalshiCode("NHL", "SEATTLE KRAKEN")).toBe("SEA");
  expect(reg.canonicalCode("NFL", "LAS VEGAS RAIDERS")).toBe("LV");
  expect(reg.canonicalCode("NBA", "CLEVELAND CAVALIERS")).toBe("CLE");
});
