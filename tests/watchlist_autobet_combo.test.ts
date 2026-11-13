import { describe, expect, test } from "bun:test";
import {
  buildComboIntent,
  COMBO_GATE_CHECKS,
  COMBO_SCHEMA_VERSION,
  comboSignalId,
  computeComboPaperFill,
  computeComboSettlement,
  evaluateComboGates,
  parseComboSnapshot,
  type ComboGateContext,
  type ComboPaperFill,
  type ComboQuote,
  type ComboSnapshot,
} from "../lib/watchlist_autobet_combo.ts";

const NOW = new Date("2026-11-11T00:00:00.000Z");

const leg = (
  legId: string,
  marketId: string,
  outcome: string,
  askProb: number,
) => ({
  legId,
  marketId,
  tokenId: null,
  outcome,
  askProb,
});

/** A complete two-outcome field: asks sum to 0.95, so the clean resolve pays 1.00. */
const comboRaw = (overrides: Record<string, unknown> = {}) => ({
  comboId: "evt-1",
  name: "Event One",
  kind: "field",
  league: "NFL",
  expectedPayout: 1.0,
  executable: true,
  ageSec: 10,
  legs: [leg("leg-a", "m1", "Home", 0.4), leg("leg-b", "m2", "Away", 0.55)],
  ...overrides,
});

const snapshotRaw = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: COMBO_SCHEMA_VERSION,
  generatedAt: "2026-11-11T00:00:00.000Z",
  combos: [comboRaw()],
  ...overrides,
});

function parseOk(raw: unknown): ComboSnapshot {
  const parsed = parseComboSnapshot(raw);
  if (!parsed.ok)
    throw new Error(`expected a valid snapshot, got: ${parsed.message}`);
  return parsed.snapshot;
}

function quote(): ComboQuote {
  return parseOk(snapshotRaw()).combos[0]!;
}

const gateContext = (
  overrides: Partial<ComboGateContext> = {},
): ComboGateContext => ({
  enabled: true,
  eligibleLeagues: ["NFL"],
  maxSignalAgeSeconds: 60,
  minEdge: 0.01,
  stakeUsd: 100,
  stakeAvailableUsd: 1_000,
  dailyRemainingUsd: 1_000,
  existingIntentId: null,
  ...overrides,
});

function eligibleGate() {
  return evaluateComboGates(quote(), gateContext());
}

function paperFill(stakeUsd: number, slippageBps = 0): ComboPaperFill {
  const intent = buildComboIntent(quote(), eligibleGate(), {
    snapshotGeneratedAt: snapshotRaw().generatedAt,
    now: NOW,
    actor: "test",
    expiresAt: "2026-11-11T01:00:00.000Z",
    stakeUsd,
  });
  return computeComboPaperFill({ intent, slippageBps, now: NOW });
}

describe("parseComboSnapshot", () => {
  test("recomputes buyAllCost and edge from the legs, ignoring declared values", () => {
    const snapshot = parseOk(
      snapshotRaw({
        combos: [comboRaw({ buyAllCost: 0.01, edge: 0.99 })],
      }),
    );
    const parsed = snapshot.combos[0]!;
    expect(parsed.buyAllCost).toBe(0.95);
    expect(parsed.edge).toBe(0.05);
    expect(parsed.legs).toHaveLength(2);
  });

  test("refuses a non-object snapshot", () => {
    const result = parseComboSnapshot([]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain("snapshot must be a JSON object");
  });

  test("refuses an unsupported schemaVersion", () => {
    const result = parseComboSnapshot(snapshotRaw({ schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain("unsupported schemaVersion");
  });

  test("refuses a non-ISO generatedAt", () => {
    const result = parseComboSnapshot(
      snapshotRaw({ generatedAt: "yesterday" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain(
        "generatedAt must be an ISO-8601 timestamp",
      );
  });

  test("refuses a duplicate comboId", () => {
    const result = parseComboSnapshot(
      snapshotRaw({ combos: [comboRaw(), comboRaw()] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("duplicate comboId evt-1");
  });

  test("refuses fewer than two legs", () => {
    const result = parseComboSnapshot(
      snapshotRaw({
        combos: [comboRaw({ legs: [leg("leg-a", "m1", "Home", 0.4)] })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain(
        "legs must be an array of at least 2 quotes",
      );
  });

  test("refuses a duplicate legId", () => {
    const result = parseComboSnapshot(
      snapshotRaw({
        combos: [
          comboRaw({
            legs: [
              leg("leg-a", "m1", "Home", 0.4),
              leg("leg-a", "m2", "Away", 0.55),
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("duplicate legId leg-a");
  });

  test("refuses a leg ask outside (0, 1)", () => {
    for (const askProb of [0, 1, Number.NaN]) {
      const result = parseComboSnapshot(
        snapshotRaw({
          combos: [
            comboRaw({
              legs: [
                leg("leg-a", "m1", "Home", askProb),
                leg("leg-b", "m2", "Away", 0.55),
              ],
            }),
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.message).toContain("askProb must be in (0, 1)");
    }
  });

  test("refuses an unknown combo kind", () => {
    const result = parseComboSnapshot(
      snapshotRaw({ combos: [comboRaw({ kind: "parlay" })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain("kind must be one of field");
  });

  test("refuses a negative age", () => {
    const result = parseComboSnapshot(
      snapshotRaw({ combos: [comboRaw({ ageSec: -1 })] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.message).toContain("ageSec must be a finite number >= 0");
  });
});

describe("evaluateComboGates", () => {
  test("passes every check for an in-bounds combo", () => {
    const gate = eligibleGate();
    expect(gate.eligible).toBe(true);
    expect(gate.reasons).toEqual([]);
    expect(gate.checks.map((check) => check.check)).toEqual([
      ...COMBO_GATE_CHECKS,
    ]);
  });

  test("reports each failing check by id, in declaration order", () => {
    const gate = evaluateComboGates(
      quote(),
      gateContext({
        enabled: false,
        eligibleLeagues: ["NBA"],
        maxSignalAgeSeconds: 5,
        minEdge: 0.06,
        stakeUsd: 2_000,
        stakeAvailableUsd: 1_000,
        dailyRemainingUsd: 50,
        existingIntentId: "wa-existing",
      }),
    );
    expect(gate.eligible).toBe(false);
    expect(gate.reasons).toEqual([
      "enabled",
      "league_allowed",
      "freshness",
      "edge",
      "stake_available",
      "daily_stake_cap",
      "duplicate_intent",
    ]);
  });

  test("fails the executable check when the buy-all is not executable", () => {
    const parsed = parseOk(
      snapshotRaw({ combos: [comboRaw({ executable: false })] }),
    );
    const gate = evaluateComboGates(parsed.combos[0]!, gateContext());
    expect(gate.reasons).toEqual(["executable"]);
  });
});

describe("buildComboIntent", () => {
  test("refuses to build from an ineligible gate", () => {
    const ineligible = evaluateComboGates(
      quote(),
      gateContext({ enabled: false }),
    );
    expect(() =>
      buildComboIntent(quote(), ineligible, {
        snapshotGeneratedAt: snapshotRaw().generatedAt,
        now: NOW,
        actor: "test",
        expiresAt: "2026-11-11T01:00:00.000Z",
        stakeUsd: 100,
      }),
    ).toThrow("refusing to build a combo intent for ineligible combo evt-1");
  });

  test("refuses a stake that rounds to zero cents", () => {
    expect(() =>
      buildComboIntent(quote(), eligibleGate(), {
        snapshotGeneratedAt: snapshotRaw().generatedAt,
        now: NOW,
        actor: "test",
        expiresAt: "2026-11-11T01:00:00.000Z",
        stakeUsd: 0.004,
      }),
    ).toThrow("combo intent stake must be a positive number of cents");
  });

  test("builds a queued intent sized by the buy-all cost", () => {
    const intent = buildComboIntent(quote(), eligibleGate(), {
      snapshotGeneratedAt: snapshotRaw().generatedAt,
      now: NOW,
      actor: "operator",
      expiresAt: "2026-11-11T01:00:00.000Z",
      stakeUsd: 100,
    });
    expect(intent.kind).toBe("combo");
    expect(intent.status).toBe("queued");
    expect(intent.fill).toBeNull();
    expect(intent.settlement).toBeNull();
    expect(intent.signalId).toBe(comboSignalId("evt-1"));
    expect(intent.referenceCostPerShare).toBe(0.95);
    expect(intent.referenceShares).toBe(105.263158);
    expect(intent.referencePayoutIfWinUsd).toBe(105.26);
    expect(intent.referenceAmericanOdds).toBe(-1900);
    expect(intent.stakeUsd).toBe(100);
    expect(intent.createdAt).toBe(NOW.toISOString());
    expect(intent.createdBy).toBe("operator");
    expect(intent.legs).toHaveLength(2);
    expect(intent.gates).toHaveLength(COMBO_GATE_CHECKS.length);
    expect(intent.gates.every((check) => check.ok)).toBe(true);
  });
});

describe("computeComboPaperFill", () => {
  test("buys shares at the buy-all cost and splits the stake across legs", () => {
    const fill = paperFill(100);
    expect(fill.shares).toBe(105.263158);
    expect(fill.effectiveBuyAllCost).toBe(0.95);
    expect(fill.payoutIfWinUsd).toBe(105.26);
    expect(fill.legs.map((entry) => entry.stakeUsd)).toEqual([
      42.105263, 57.894737,
    ]);
    const allocated = fill.legs.reduce((sum, entry) => sum + entry.stakeUsd, 0);
    expect(Math.abs(allocated - fill.stakeUsd)).toBeLessThanOrEqual(0.01);
  });

  test("worsens every leg by the configured slippage", () => {
    const fill = paperFill(100, 100);
    expect(fill.legs[0]!.effectiveAskProb).toBe(0.404);
    expect(fill.legs[1]!.effectiveAskProb).toBe(0.5555);
    expect(fill.effectiveBuyAllCost).toBe(0.9595);
    expect(fill.shares).toBe(104.220948);
  });

  test("clamps a worsened ask below certainty", () => {
    const parsed = parseOk(
      snapshotRaw({
        combos: [
          comboRaw({
            legs: [
              leg("leg-a", "m1", "Home", 0.9999),
              leg("leg-b", "m2", "Away", 0.00005),
            ],
          }),
        ],
      }),
    );
    const intent = buildComboIntent(parsed.combos[0]!, eligibleGate(), {
      snapshotGeneratedAt: snapshotRaw().generatedAt,
      now: NOW,
      actor: "test",
      expiresAt: "2026-11-11T01:00:00.000Z",
      stakeUsd: 100,
    });
    const fill = computeComboPaperFill({
      intent,
      slippageBps: 10_000,
      now: NOW,
    });
    expect(fill.legs[0]!.effectiveAskProb).toBe(0.999999);
  });

  test("refuses a zero stake and a negative slippage", () => {
    const fill = paperFill(100);
    const intent = { ...fill, stakeUsd: 0 } as unknown as Parameters<
      typeof computeComboPaperFill
    >[0]["intent"];
    expect(() =>
      computeComboPaperFill({ intent, slippageBps: 0, now: NOW }),
    ).toThrow("cannot paper-fill a combo with a zero stake");
    const good = buildComboIntent(quote(), eligibleGate(), {
      snapshotGeneratedAt: snapshotRaw().generatedAt,
      now: NOW,
      actor: "test",
      expiresAt: "2026-11-11T01:00:00.000Z",
      stakeUsd: 100,
    });
    expect(() =>
      computeComboPaperFill({ intent: good, slippageBps: -1, now: NOW }),
    ).toThrow("paperSlippageBps must be a finite number >= 0");
  });
});

describe("computeComboSettlement", () => {
  test("pays one winning outcome and reports the profit", () => {
    const settlement = computeComboSettlement(
      paperFill(100),
      [
        { legId: "leg-a", payout: 1 },
        { legId: "leg-b", payout: 0 },
      ],
      NOW,
    );
    expect(settlement.result).toBe("won");
    expect(settlement.resolvedPayoutSum).toBe(1);
    expect(settlement.payoutUsd).toBe(105.26);
    expect(settlement.profitUsd).toBe(5.26);
    expect(settlement.settledAt).toBe(NOW.toISOString());
  });

  test("treats an incomplete field that resolves to zero as a full loss", () => {
    const settlement = computeComboSettlement(
      paperFill(100),
      [
        { legId: "leg-a", payout: 0 },
        { legId: "leg-b", payout: 0 },
      ],
      NOW,
    );
    expect(settlement.result).toBe("lost");
    expect(settlement.resolvedPayoutSum).toBe(0);
    expect(settlement.payoutUsd).toBe(0);
    expect(settlement.profitUsd).toBe(-100);
  });

  test("reports void when the payout vector exactly returns the stake", () => {
    // buyAllCost 0.95 and no slippage: 95 USD buys exactly 100 shares, so a 0.95
    // payout sum returns the stake and the result is neither a win nor a loss.
    const settlement = computeComboSettlement(
      paperFill(95),
      [
        { legId: "leg-a", payout: 0.95 },
        { legId: "leg-b", payout: 0 },
      ],
      NOW,
    );
    expect(settlement.resolvedPayoutSum).toBe(0.95);
    expect(settlement.payoutUsd).toBe(95);
    expect(settlement.profitUsd).toBe(0);
    expect(settlement.result).toBe("void");
  });

  test("counts a half-paying leg without flipping the result to won", () => {
    const settlement = computeComboSettlement(
      paperFill(100),
      [
        { legId: "leg-a", payout: 0.5 },
        { legId: "leg-b", payout: 0 },
      ],
      NOW,
    );
    expect(settlement.resolvedPayoutSum).toBe(0.5);
    expect(settlement.profitUsd).toBe(-47.37);
    expect(settlement.result).toBe("lost");
  });

  test("refuses a resolution count that does not match the fill", () => {
    expect(() =>
      computeComboSettlement(
        paperFill(100),
        [{ legId: "leg-a", payout: 1 }],
        NOW,
      ),
    ).toThrow("need exactly 2 leg resolutions, got 1");
  });

  test("refuses duplicate, missing and out-of-range resolutions", () => {
    const fill = paperFill(100);
    expect(() =>
      computeComboSettlement(
        fill,
        [
          { legId: "leg-a", payout: 1 },
          { legId: "leg-a", payout: 0 },
        ],
        NOW,
      ),
    ).toThrow("duplicate resolution for leg leg-a");
    expect(() =>
      computeComboSettlement(
        fill,
        [
          { legId: "leg-a", payout: 1 },
          { legId: "leg-zzz", payout: 0 },
        ],
        NOW,
      ),
    ).toThrow("missing resolution for leg leg-b");
    expect(() =>
      computeComboSettlement(
        fill,
        [
          { legId: "leg-a", payout: 1.5 },
          { legId: "leg-b", payout: 0 },
        ],
        NOW,
      ),
    ).toThrow("leg leg-a payout must be in [0, 1]");
  });
});
