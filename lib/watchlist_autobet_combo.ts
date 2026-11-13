/**
 * Combo-arb paper intents: the multi-leg counterpart of the watchlist autobet intent.
 *
 * Why this module exists
 * ----------------------
 * `watchlist_autobet.ts` trades one market at a time: a single `marketKey`, one reference
 * probability, one paper fill. The combo plugin produces the opposite shape - a set of legs whose
 * sum is a structural statement. This module is the seam between them, and it is deliberately
 * narrower than the combo plugin:
 *
 *   - only `field` combos are tradable (buy every outcome of a complete field, cost < 1.00);
 *   - the paper fill buys each leg at its top-of-book ask, worsened by `paperSlippageBps`;
 *   - settlement reads a per-leg payout vector, not a won/lost verdict per leg. In a complete
 *     field exactly one outcome pays 1.00 and every other pays 0, so "all legs won" can never be
 *     true. P&L is `shares * sum(payouts) - stake`, which is the only accounting that survives
 *     an incomplete field resolving to zero.
 *
 * No I/O, no network, no ledger, no credentials: pure functions over a snapshot the combo side
 * writes, so the desk keeps one ledger and one fill convention.
 */
import {
  centsToUsd,
  dollarsToCents,
  impliedProbToAmerican,
} from "./watchlist_autobet.ts";

export const COMBO_SCHEMA_VERSION = 1 as const;

/** `field` = buy every priced outcome of a complete event field (expected payout 1.00). */
export const COMBO_KINDS = ["field"] as const;
export type ComboKind = (typeof COMBO_KINDS)[number];

export const COMBO_GATE_CHECKS = [
  "enabled",
  "league_allowed",
  "executable",
  "freshness",
  "edge",
  "stake_available",
  "daily_stake_cap",
  "duplicate_intent",
] as const;
export type ComboGateCheckId = (typeof COMBO_GATE_CHECKS)[number];

/** One priced outcome inside a combo. `askProb` is the top-of-book ask in probability units. */
export interface ComboLegQuote {
  readonly legId: string;
  readonly marketId: string;
  readonly tokenId: string | null;
  readonly outcome: string;
  readonly askProb: number;
}

export interface ComboQuote {
  readonly comboId: string;
  readonly name: string;
  readonly kind: ComboKind;
  readonly league: string;
  /** Sum of every leg payout when the field resolves exactly once (1.00 for a complete field). */
  readonly expectedPayout: number;
  /** Sum of the leg asks - what one share of every outcome costs before slippage. */
  readonly buyAllCost: number;
  /** `expectedPayout - buyAllCost`, recomputed at parse time rather than trusted. */
  readonly edge: number;
  readonly executable: boolean;
  readonly ageSec: number;
  readonly legs: readonly ComboLegQuote[];
}

export interface ComboSnapshot {
  readonly schemaVersion: typeof COMBO_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly combos: readonly ComboQuote[];
}

export type ComboSnapshotParseResult =
  | { readonly ok: true; readonly snapshot: ComboSnapshot }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value < 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseLeg(raw: unknown): ComboLegQuote | string {
  if (!isRecord(raw)) return "leg must be an object";
  const legId = raw["legId"];
  if (!isNonEmptyString(legId)) return "leg.legId must be a non-empty string";
  const marketId = raw["marketId"];
  if (!isNonEmptyString(marketId))
    return `leg ${legId}: marketId must be a non-empty string`;
  const tokenIdRaw = raw["tokenId"];
  if (tokenIdRaw !== null && !isNonEmptyString(tokenIdRaw)) {
    return `leg ${legId}: tokenId must be a non-empty string or null`;
  }
  const outcome = raw["outcome"];
  if (!isNonEmptyString(outcome))
    return `leg ${legId}: outcome must be a non-empty string`;
  const askProb = raw["askProb"];
  if (!isProbability(askProb)) return `leg ${legId}: askProb must be in (0, 1)`;
  return {
    legId,
    marketId,
    tokenId: tokenIdRaw === null ? null : tokenIdRaw,
    outcome,
    askProb,
  };
}

function parseCombo(raw: unknown): ComboQuote | string {
  if (!isRecord(raw)) return "combo must be an object";
  const comboId = raw["comboId"];
  if (!isNonEmptyString(comboId))
    return "combo.comboId must be a non-empty string";
  const name = raw["name"];
  if (!isNonEmptyString(name))
    return `combo ${comboId}: name must be a non-empty string`;
  const kind = raw["kind"];
  if (typeof kind !== "string" || !COMBO_KINDS.includes(kind as ComboKind)) {
    return `combo ${comboId}: kind must be one of ${COMBO_KINDS.join(", ")}`;
  }
  const league = raw["league"];
  if (!isNonEmptyString(league))
    return `combo ${comboId}: league must be a non-empty string`;
  const expectedPayout = raw["expectedPayout"];
  if (!isFiniteNumber(expectedPayout) || expectedPayout <= 0) {
    return `combo ${comboId}: expectedPayout must be a finite number > 0`;
  }
  const executable = raw["executable"];
  if (typeof executable !== "boolean") {
    return `combo ${comboId}: executable must be a boolean`;
  }
  const ageSec = raw["ageSec"];
  if (!isFiniteNumber(ageSec) || ageSec < 0) {
    return `combo ${comboId}: ageSec must be a finite number >= 0`;
  }
  const rawLegs = raw["legs"];
  if (!Array.isArray(rawLegs) || rawLegs.length < 2) {
    return `combo ${comboId}: legs must be an array of at least 2 quotes`;
  }
  const legs: ComboLegQuote[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawLegs.length; index += 1) {
    const parsed = parseLeg(rawLegs[index]);
    if (typeof parsed === "string") return `combo ${comboId}: ${parsed}`;
    if (seen.has(parsed.legId)) {
      return `combo ${comboId}: duplicate legId ${parsed.legId}`;
    }
    seen.add(parsed.legId);
    legs.push(parsed);
  }
  const buyAllCost = round6(legs.reduce((sum, leg) => sum + leg.askProb, 0));
  if (buyAllCost <= 0 || buyAllCost >= 10) {
    return `combo ${comboId}: leg asks sum to ${String(buyAllCost)}, outside a usable range`;
  }
  return {
    comboId,
    name,
    kind: kind as ComboKind,
    league,
    expectedPayout,
    buyAllCost,
    edge: round6(expectedPayout - buyAllCost),
    executable,
    ageSec,
    legs,
  };
}

/**
 * Strict snapshot parse. `buyAllCost` and `edge` are recomputed from the legs, so a producer bug
 * cannot smuggle in an edge the leg quotes do not support; a declared value is never trusted.
 */
export function parseComboSnapshot(raw: unknown): ComboSnapshotParseResult {
  if (!isRecord(raw))
    return { ok: false, message: "snapshot must be a JSON object" };
  if (raw["schemaVersion"] !== COMBO_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `unsupported schemaVersion ${String(raw["schemaVersion"])}`,
    };
  }
  const generatedAt = raw["generatedAt"];
  if (
    typeof generatedAt !== "string" ||
    !Number.isFinite(Date.parse(generatedAt))
  ) {
    return { ok: false, message: "generatedAt must be an ISO-8601 timestamp" };
  }
  const rawCombos = raw["combos"];
  if (!Array.isArray(rawCombos)) {
    return { ok: false, message: "combos must be an array" };
  }
  const combos: ComboQuote[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawCombos.length; index += 1) {
    const parsed = parseCombo(rawCombos[index]);
    if (typeof parsed === "string") return { ok: false, message: parsed };
    if (seen.has(parsed.comboId)) {
      return { ok: false, message: `duplicate comboId ${parsed.comboId}` };
    }
    seen.add(parsed.comboId);
    combos.push(parsed);
  }
  return {
    ok: true,
    snapshot: { schemaVersion: COMBO_SCHEMA_VERSION, generatedAt, combos },
  };
}

export interface ComboGateContext {
  readonly enabled: boolean;
  readonly eligibleLeagues: readonly string[];
  readonly maxSignalAgeSeconds: number;
  readonly minEdge: number;
  readonly stakeUsd: number;
  readonly stakeAvailableUsd: number;
  readonly dailyRemainingUsd: number;
  /** The active intent already holding this combo's dedupe slot, if any. */
  readonly existingIntentId: string | null;
}

export interface ComboGateCheck {
  readonly check: ComboGateCheckId;
  readonly ok: boolean;
  readonly actual: number | string | boolean | null;
  readonly required: string;
  readonly detail?: string;
}

export interface ComboGateResult {
  readonly eligible: boolean;
  readonly reasons: readonly ComboGateCheckId[];
  readonly checks: readonly ComboGateCheck[];
}

/** Gates are advisory to the caller: an ineligible combo never reaches `buildComboIntent`. */
export function evaluateComboGates(
  quote: ComboQuote,
  context: ComboGateContext,
): ComboGateResult {
  const checks: ComboGateCheck[] = [];
  const reasons: ComboGateCheckId[] = [];
  const add = (check: ComboGateCheck, failedDetail?: string) => {
    checks.push(check);
    if (!check.ok) reasons.push(check.check);
    if (failedDetail !== undefined) void failedDetail;
  };

  add({
    check: "enabled",
    ok: context.enabled,
    actual: context.enabled,
    required: "autobet enabled",
  });
  add({
    check: "league_allowed",
    ok: context.eligibleLeagues.includes(quote.league),
    actual: quote.league,
    required: context.eligibleLeagues.join(", "),
  });
  add({
    check: "executable",
    ok: quote.executable,
    actual: quote.executable,
    required: "buy-all executable at top of book",
  });
  add({
    check: "freshness",
    ok: quote.ageSec <= context.maxSignalAgeSeconds,
    actual: quote.ageSec,
    required: `ageSec <= ${String(context.maxSignalAgeSeconds)}`,
  });
  add({
    check: "edge",
    ok: quote.edge >= context.minEdge,
    actual: quote.edge,
    required: `edge >= ${String(context.minEdge)}`,
  });
  add({
    check: "stake_available",
    ok: context.stakeUsd > 0 && context.stakeUsd <= context.stakeAvailableUsd,
    actual: context.stakeUsd,
    required: `stake <= available ${String(context.stakeAvailableUsd)}`,
  });
  add({
    check: "daily_stake_cap",
    ok: context.dailyRemainingUsd >= context.stakeUsd,
    actual: context.dailyRemainingUsd,
    required: `remaining desk-day stake >= ${String(context.stakeUsd)}`,
  });
  add({
    check: "duplicate_intent",
    ok: context.existingIntentId === null,
    actual: context.existingIntentId,
    required: "no active intent for this combo",
  });

  return { eligible: reasons.length === 0, reasons, checks };
}

/** Collapse a gate result to the persisted shape (no `detail` key unless present). */
function snapshotGateCheck(check: ComboGateCheck): ComboGateCheck {
  return check.detail === undefined
    ? {
        check: check.check,
        ok: check.ok,
        actual: check.actual,
        required: check.required,
      }
    : {
        check: check.check,
        ok: check.ok,
        actual: check.actual,
        required: check.required,
        detail: check.detail,
      };
}

export interface ComboIntentCore {
  readonly kind: "combo";
  readonly intentId: string;
  readonly signalId: string;
  readonly comboId: string;
  readonly comboName: string;
  readonly comboKind: ComboKind;
  readonly league: string;
  readonly expectedPayout: number;
  readonly buyAllCost: number;
  readonly edge: number;
  readonly ageSec: number;
  readonly snapshotGeneratedAt: string;
  readonly legs: readonly ComboLegQuote[];
  /** Reference price for one share of the whole field (the buy-all cost). */
  readonly referenceCostPerShare: number;
  /** Bought with the stake: `stakeUsd / effectiveBuyAllCost`. */
  readonly referenceShares: number;
  /** Win payout if the field resolves exactly once. */
  readonly referencePayoutIfWinUsd: number;
  readonly referenceAmericanOdds: number;
  readonly stakeUsd: number;
  readonly gates: readonly ComboGateCheck[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly status: "queued";
  readonly fill: null;
  readonly settlement: null;
}

export function comboSignalId(comboId: string): string {
  return `combo-arb:${comboId}`;
}

export interface BuildComboIntentOptions {
  readonly snapshotGeneratedAt: string;
  readonly now: Date;
  readonly actor: string;
  readonly expiresAt: string;
  /** Dollars; the caller validates it `> 0` like `watchlist_autobet`'s config. */
  readonly stakeUsd: number;
}

/** Build a `queued` combo intent for a quote that passed every gate. Never called when rejected. */
export function buildComboIntent(
  quote: ComboQuote,
  gate: ComboGateResult,
  options: BuildComboIntentOptions,
): ComboIntentCore {
  if (!gate.eligible) {
    throw new Error(
      `refusing to build a combo intent for ineligible combo ${quote.comboId}`,
    );
  }
  const stakeCents = dollarsToCents(options.stakeUsd);
  if (stakeCents <= 0) {
    throw new Error("combo intent stake must be a positive number of cents");
  }
  const referenceShares = round6(options.stakeUsd / quote.buyAllCost);
  const referencePayoutIfWinUsd = round2(
    referenceShares * quote.expectedPayout,
  );
  return {
    kind: "combo",
    intentId: `wc-${crypto.randomUUID()}`,
    signalId: comboSignalId(quote.comboId),
    comboId: quote.comboId,
    comboName: quote.name,
    comboKind: quote.kind,
    league: quote.league,
    expectedPayout: quote.expectedPayout,
    buyAllCost: quote.buyAllCost,
    edge: quote.edge,
    ageSec: quote.ageSec,
    snapshotGeneratedAt: options.snapshotGeneratedAt,
    legs: quote.legs.map((leg) => ({ ...leg })),
    referenceCostPerShare: quote.buyAllCost,
    referenceShares,
    referencePayoutIfWinUsd,
    referenceAmericanOdds: impliedProbToAmerican(quote.buyAllCost),
    stakeUsd: centsToUsd(stakeCents),
    gates: gate.checks.map(snapshotGateCheck),
    createdAt: options.now.toISOString(),
    createdBy: options.actor,
    expiresAt: options.expiresAt,
    status: "queued",
    fill: null,
    settlement: null,
  };
}

export interface ComboLegFill {
  readonly legId: string;
  readonly marketId: string;
  readonly tokenId: string | null;
  readonly outcome: string;
  readonly askProb: number;
  readonly effectiveAskProb: number;
  readonly stakeUsd: number;
}

export interface ComboPaperFill {
  readonly kind: "combo";
  readonly venue: "paper";
  readonly filledAt: string;
  readonly stakeUsd: number;
  readonly shares: number;
  readonly effectiveBuyAllCost: number;
  readonly payoutIfWinUsd: number;
  readonly expectedPayout: number;
  readonly slippageBps: number;
  readonly legs: readonly ComboLegFill[];
}

export interface ComboFillInput {
  readonly intent: ComboIntentCore;
  readonly slippageBps: number;
  readonly now: Date;
}

/**
 * Paper-fill every leg at its ask, each worsened by `paperSlippageBps`. The stake buys
 * `stakeUsd / effectiveBuyAllCost` shares of the whole field; per-leg stake is
 * `shares * effectiveAsk`, and the legs must sum back to the stake within a cent.
 */
export function computeComboPaperFill(input: ComboFillInput): ComboPaperFill {
  const stakeCents = dollarsToCents(input.intent.stakeUsd);
  if (stakeCents <= 0)
    throw new Error("cannot paper-fill a combo with a zero stake");
  if (!Number.isFinite(input.slippageBps) || input.slippageBps < 0) {
    throw new Error("paperSlippageBps must be a finite number >= 0");
  }
  const worsened = 1 + input.slippageBps / 10_000;
  const legFills: ComboLegFill[] = [];
  let effectiveBuyAllCost = 0;
  for (const leg of input.intent.legs) {
    const effectiveAskProb = round6(Math.min(leg.askProb * worsened, 0.999999));
    effectiveBuyAllCost = round6(effectiveBuyAllCost + effectiveAskProb);
    legFills.push({
      legId: leg.legId,
      marketId: leg.marketId,
      tokenId: leg.tokenId,
      outcome: leg.outcome,
      askProb: leg.askProb,
      effectiveAskProb,
      stakeUsd: 0,
    });
  }
  if (effectiveBuyAllCost <= 0) {
    throw new Error("effective buy-all cost must be positive");
  }
  const shares = round6(input.intent.stakeUsd / effectiveBuyAllCost);
  let allocatedCents = 0;
  const priced: ComboLegFill[] = legFills.map((leg) => ({
    ...leg,
    stakeUsd: round6(shares * leg.effectiveAskProb),
  }));
  for (const leg of priced) allocatedCents += dollarsToCents(leg.stakeUsd);
  const drift = Math.abs(allocatedCents - stakeCents);
  if (drift > 1) {
    throw new Error(
      `per-leg paper stake drifts ${String(centsToUsd(drift))} USD from the intent stake`,
    );
  }
  return {
    kind: "combo",
    venue: "paper",
    filledAt: input.now.toISOString(),
    stakeUsd: centsToUsd(stakeCents),
    shares,
    effectiveBuyAllCost,
    payoutIfWinUsd: round2(shares * input.intent.expectedPayout),
    expectedPayout: input.intent.expectedPayout,
    slippageBps: input.slippageBps,
    legs: priced,
  };
}

export interface ComboLegResolution {
  readonly legId: string;
  /** Resolution payout per share: 1.00 for the winning outcome, 0 for the rest. */
  readonly payout: number;
}

export type ComboSettlementResult = "won" | "lost" | "void";

export interface ComboSettlement {
  readonly result: ComboSettlementResult;
  readonly settledAt: string;
  readonly payoutUsd: number;
  readonly profitUsd: number;
  readonly resolvedPayoutSum: number;
  readonly legs: readonly (ComboLegResolution & { readonly outcome: string })[];
}

/**
 * Settlement from a payout vector: `profit = shares * sum(payouts) - stake`.
 *
 * This is the accounting a complete field needs. One outcome pays 1.00, every other pays 0, so
 * `sum(payouts)` is 1.00 on a clean resolve, 0 on an incomplete field, and a partial sum when a
 * leg voids at half. A missing leg, a duplicate leg or a payout outside [0, 1] is refused.
 */
export function computeComboSettlement(
  fill: ComboPaperFill,
  resolutions: readonly ComboLegResolution[],
  now: Date,
): ComboSettlement {
  if (resolutions.length !== fill.legs.length) {
    throw new Error(
      `need exactly ${String(fill.legs.length)} leg resolutions, got ${String(resolutions.length)}`,
    );
  }
  const byLeg = new Map<string, number>();
  for (const resolution of resolutions) {
    if (byLeg.has(resolution.legId)) {
      throw new Error(`duplicate resolution for leg ${resolution.legId}`);
    }
    if (
      !Number.isFinite(resolution.payout) ||
      resolution.payout < 0 ||
      resolution.payout > 1
    ) {
      throw new Error(`leg ${resolution.legId} payout must be in [0, 1]`);
    }
    byLeg.set(resolution.legId, resolution.payout);
  }
  const legs: (ComboLegResolution & { readonly outcome: string })[] = [];
  let resolvedPayoutSum = 0;
  for (const leg of fill.legs) {
    const payout = byLeg.get(leg.legId);
    if (payout === undefined) {
      throw new Error(`missing resolution for leg ${leg.legId}`);
    }
    resolvedPayoutSum = round6(resolvedPayoutSum + payout);
    legs.push({ legId: leg.legId, payout, outcome: leg.outcome });
  }
  const payoutUsd = round2(fill.shares * resolvedPayoutSum);
  const profitUsd = round2(payoutUsd - fill.stakeUsd);
  const result: ComboSettlementResult =
    profitUsd > 0 ? "won" : profitUsd < 0 ? "lost" : "void";
  return {
    result,
    settledAt: now.toISOString(),
    payoutUsd,
    profitUsd,
    resolvedPayoutSum,
    legs,
  };
}
