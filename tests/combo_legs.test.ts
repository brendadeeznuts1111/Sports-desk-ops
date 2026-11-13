import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { GameIndex } from "../lib/cfb_events.ts";
import {
  hashKeys,
  looksLikeComboCondition,
  normalizeCombo,
} from "../lib/combo_legs.ts";

const GAME_A = "cfb-ohiost-usc-2026-10-31";
const GAME_B = "cfb-game-b";
const GAME_TOKEN = "cfb-game-token";

const index: GameIndex = {
  byConditionId: new Map([["0xcond1", GAME_A]]),
  byMarketSlug: new Map([
    ["cfb-slug-a", GAME_A],
    ["cfb-slug-b", GAME_B],
  ]),
  byTokenId: new Map([
    ["tok-1", GAME_TOKEN],
    ["tok-2", GAME_B],
  ]),
};

const COMBO = {
  comboId: "g-777",
  user: "0xABC",
  legs: [
    {
      leg_condition_id: "0xCOND1",
      leg_outcome_label: "Ohio State",
      market: { sports_market_type: "spreads" },
    },
    {
      marketSlug: "cfb-slug-a",
      outcome: "USC",
      market: { sportsMarketType: "moneyline" },
    },
    { clobTokenId: "tok-1", leg_outcome: "Over", sports_market_type: "totals" },
  ],
};

function normalize(raw: unknown, fallbackWallet = "fallback") {
  const result = normalizeCombo(raw, fallbackWallet, index);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.combo;
}

describe("normalizeCombo", () => {
  test("attributes legs by condition id, market slug and token id", () => {
    const combo = normalize(COMBO);
    expect(combo.legKeys).toEqual(["0xcond1", "cfb-slug-a", "tok-1"]);
    expect([...combo.gameSlugs].sort()).toEqual([GAME_A, GAME_TOKEN].sort());
    expect(combo.allLegsCfb).toBe(true);
    expect(combo.unresolvedLegKeys).toEqual([]);
  });

  test("builds leg signatures from key, uppercased outcome and market type", () => {
    const combo = normalize(COMBO);
    expect(combo.legSignatures).toEqual([
      "0xcond1|OHIO STATE|spreads",
      "cfb-slug-a|USC|moneyline",
      "tok-1|OVER|totals",
    ]);
  });

  test("is fully within one game only when every attributed leg shares it", () => {
    expect(normalize(COMBO).fullyWithinGame).toBe(false);
    const oneGame = normalize({ legs: [COMBO.legs[0], COMBO.legs[1]] });
    expect([...oneGame.gameSlugs]).toEqual([GAME_A]);
    expect(oneGame.fullyWithinGame).toBe(true);
  });

  test("falls back to the components array", () => {
    const combo = normalize({
      components: [{ clobTokenId: "tok-1", outcome: "Over" }],
    });
    expect(combo.legKeys).toEqual(["tok-1"]);
    expect([...combo.gameSlugs]).toEqual([GAME_TOKEN]);
  });

  test("refuses snapshots with no usable legs", () => {
    expect(normalizeCombo(null, "w", index)).toEqual({
      ok: false,
      reason: "NO_LEGS",
    });
    expect(normalizeCombo({}, "w", index)).toEqual({
      ok: false,
      reason: "NO_LEGS",
    });
    expect(normalizeCombo({ legs: [] }, "w", index)).toEqual({
      ok: false,
      reason: "NO_LEGS",
    });
    expect(normalizeCombo({ legs: ["not a leg", 42] }, "w", index)).toEqual({
      ok: false,
      reason: "NO_LEGS",
    });
  });

  test("refuses a combo whose legs attribute to no game", () => {
    expect(
      normalizeCombo({ legs: [{ clobTokenId: "tok-unknown" }] }, "w", index),
    ).toEqual({
      ok: false,
      reason: "NO_ATTRIBUTION",
    });
  });

  test("records unresolved legs without failing the attributed ones", () => {
    const combo = normalize({
      legs: [COMBO.legs[0], { clobTokenId: "tok-unknown", outcome: "X" }],
    });
    expect(combo.unresolvedLegKeys).toEqual(["tok-unknown"]);
    expect(combo.allLegsCfb).toBe(false);
    expect([...combo.gameSlugs]).toEqual([GAME_A]);
  });

  test("marks the combo ineligible when an attributed leg is not a game market", () => {
    const combo = normalize({
      legs: [{ clobTokenId: "tok-1", sports_market_type: "player_prop" }],
    });
    expect(combo.allCfbLegsEligible).toBe(false);
    expect(combo.allLegsCfb).toBe(true);
  });

  test("is not fully within a game when legs span two games", () => {
    const combo = normalize({
      legs: [{ clobTokenId: "tok-1" }, { clobTokenId: "tok-2" }],
    });
    expect(combo.fullyWithinGame).toBe(false);
    expect([...combo.gameSlugs].sort()).toEqual([GAME_B, GAME_TOKEN].sort());
  });

  test("counts legs without a side", () => {
    const combo = normalize({
      legs: [
        { clobTokenId: "tok-1", outcome: "Over" },
        { clobTokenId: "tok-2" },
      ],
    });
    expect(combo.legsWithoutSide).toBe(1);
    expect(combo.unstableLegs).toBe(0);
  });

  test("counts a leg whose identity falls back to JSON as unstable", () => {
    const unstableLeg = { unsupported: "shape" };
    const combo = normalize({
      legs: [{ clobTokenId: "tok-1", outcome: "Over" }, unstableLeg],
    });
    expect(combo.unstableLegs).toBe(1);
    expect(combo.unresolvedLegKeys).toEqual([
      JSON.stringify(unstableLeg).toLowerCase(),
    ]);
  });

  test("takes comboId from comboId, then id, then a sha256 of the signatures", () => {
    expect(normalize({ ...COMBO, comboId: "g-1" }).comboId).toBe("g-1");
    const withoutComboId = { ...COMBO, comboId: undefined, id: "g-2" };
    expect(normalize(withoutComboId).comboId).toBe("g-2");
    const hashed = normalize({ ...COMBO, comboId: undefined, id: undefined });
    expect(hashed.comboId).toBe(`sha256:${hashKeys(hashed.legSignatures)}`);
  });

  test("takes the wallet from user, then wallet, then the fallback; always lowercased", () => {
    expect(normalize({ ...COMBO, user: "0xABC" }).wallet).toBe("0xabc");
    expect(
      normalize({ ...COMBO, user: undefined, wallet: "0xDEF" }).wallet,
    ).toBe("0xdef");
    expect(
      normalize({ ...COMBO, user: undefined, wallet: undefined }, "0xFALLBACK")
        .wallet,
    ).toBe("0xfallback");
  });
});

describe("hashKeys", () => {
  test("hashes the pipe-joined keys with sha256, matching node:crypto", () => {
    const expected = createHash("sha256").update("a|b").digest("hex");
    expect(hashKeys(["a", "b"])).toBe(expected);
  });

  test("is order-sensitive", () => {
    expect(hashKeys(["a", "b"])).not.toBe(hashKeys(["b", "a"]));
  });
});

describe("looksLikeComboCondition", () => {
  test("accepts 40+ hex characters followed by 16+ zeros", () => {
    expect(
      looksLikeComboCondition(`0x${"a".repeat(40)}${"0".repeat(16)}`),
    ).toBe(true);
  });

  test("rejects short hex runs, short zero runs and a non-lowercase 0x prefix", () => {
    expect(
      looksLikeComboCondition(`0x${"a".repeat(39)}${"0".repeat(16)}`),
    ).toBe(false);
    expect(
      looksLikeComboCondition(`0x${"a".repeat(40)}${"0".repeat(15)}`),
    ).toBe(false);
    expect(
      looksLikeComboCondition(`0X${"a".repeat(40)}${"0".repeat(16)}`),
    ).toBe(false);
    expect(looksLikeComboCondition("0xnothex")).toBe(false);
  });
});
