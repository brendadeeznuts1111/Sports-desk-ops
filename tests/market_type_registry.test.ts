import { describe, expect, test } from "bun:test";

import {
  classifyMarketLabel,
  comboProfile,
  kalshiSeriesFor,
  loadMarketTypeRegistry,
  marketFamilyFor,
  periodTokenFor,
  wagerTypeMeta,
} from "../lib/market_type_registry.ts";

describe("market type registry", () => {
  test("loads the 10 documented wager codes and the market kinds", () => {
    const registry = loadMarketTypeRegistry();
    expect(registry.wagerTypes).toHaveLength(10);
    expect(registry.wagerTypes.map((entry) => entry.code).sort()).toEqual([
      "A",
      "C",
      "E",
      "G",
      "I",
      "L",
      "M",
      "P",
      "S",
      "T",
    ]);
    expect(registry.marketTypes.map((entry) => entry.id)).toContain(
      "moneyline",
    );
    expect(registry.marketTypes.map((entry) => entry.id)).toContain("combo");
    expect(registry.combos.venueEquivalence["kalshi"]?.product).toBe("none");
  });

  test("classifies observed picker labels and dynamic labels", () => {
    expect(classifyMarketLabel("Winner (2 way)")).toBe("moneyline");
    expect(classifyMarketLabel("Point spread")).toBe("spread");
    expect(classifyMarketLabel("Total")).toBe("total");
    expect(classifyMarketLabel("Miami Heat team total")).toBe("team_total");
    expect(classifyMarketLabel("Total Player Receiving Yds")).toBe(
      "player_prop",
    );
    expect(classifyMarketLabel("Total Assists")).toBe("player_prop");
    expect(classifyMarketLabel("Game winner")).toBe("moneyline");
    expect(classifyMarketLabel("Winner (3 way)")).toBe("moneyline");
    expect(classifyMarketLabel("Total 3pt FG Made")).toBe("prop");
    expect(classifyMarketLabel("nonsense")).toBeNull();
  });

  test("maps period labels to canonical tokens", () => {
    expect(periodTokenFor("2nd Period")).toBe("2p");
    expect(periodTokenFor("Match (Including OT)")).toBe("game");
    expect(periodTokenFor("1st Quarter")).toBe("1q");
    expect(periodTokenFor("nonsense")).toBeNull();
  });

  test("wager metadata comes from the documented F402 map", () => {
    expect(wagerTypeMeta("P")?.name).toBe("Parlay");
    expect(wagerTypeMeta("p")?.appendsTotalPicks).toBe(true);
    expect(wagerTypeMeta("C")?.isSportsCanonicalEligible).toBe(false);
    expect(wagerTypeMeta("Z")).toBeNull();
  });

  test("combo classification uses code, kind and known legs", () => {
    expect(comboProfile({ wagerType: "P", picks: 3 }).isCombo).toBe(true);
    expect(
      comboProfile({ wagerType: "P", picks: 3 }).venue["kalshi"]?.product,
    ).toBe("none");
    expect(
      comboProfile({ wagerType: "S", wagerKind: "straight", picks: 1 }).isCombo,
    ).toBe(false);
    expect(
      comboProfile({ wagerType: "M", wagerKind: "other", picks: 1 }).isCombo,
    ).toBe(false);
    expect(comboProfile({ wagerKind: "teaser" }).isCombo).toBe(true);
    // A casino row is not a sports combo even with two picks.
    expect(comboProfile({ wagerType: "C", picks: 2 }).isCombo).toBe(false);
    // A multi-leg description is combo evidence even when the wire code is single-looking.
    expect(
      comboProfile({
        wagerType: "M",
        description:
          "Basketball - A vs B / Game / Total / Over 1 -110 | Basketball - A vs B / Game / Winner (2 way) / A -110",
      }).isCombo,
    ).toBe(true);
  });

  test("Kalshi series lookups use the single source of truth", () => {
    expect(kalshiSeriesFor("NBA", "moneyline")).toBe("KXNBAGAME");
    expect(kalshiSeriesFor("NBA", "2h_total")).toBe("KXNBA2HTOTAL");
    expect(kalshiSeriesFor("MLB", "team_total")).toBe("KXMLBTEAMTOTAL");
    expect(kalshiSeriesFor("UNKNOWN", "moneyline")).toBeNull();
    expect(marketFamilyFor("total")).toContain("over/under");
  });
});
