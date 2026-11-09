/**
 * @file lib/combo_legs.ts
 * @description The combo construct: how a raw Polymarket combo record becomes normalized legs,
 * how a leg is identified and attributed to a game, and the stable combo id.
 * Consumes the CFB game index; does not know how events are fetched, cached or scored.
 */

import type { GameIndex } from "./cfb_events.ts";
import { asRecord, text } from "./json_fetch.ts";

const ELIGIBLE_LEG_TYPES = new Set(["moneyline", "spreads", "totals"]);

export interface NormalizedCombo {
  readonly comboId: string;
  readonly wallet: string;
  readonly gameSlugs: ReadonlySet<string>;
  readonly legKeys: readonly string[];
  /** `legKey|outcome|marketType` — distinguishes legs that share a condition id. */
  readonly legSignatures: readonly string[];
  /** Legs with no outcome/side token; those rows cannot dedupe against a sided source. */
  readonly legsWithoutSide: number;
  /** Legs whose identity fell back to `JSON.stringify(leg)`. */
  readonly unstableLegs: number;
  readonly allLegsCfb: boolean;
  readonly allCfbLegsEligible: boolean;
  readonly fullyWithinGame: boolean;
  /** `legKey` of every leg that could not be attributed to a CFB game. */
  readonly unresolvedLegKeys: readonly string[];
}

function legConditionIds(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = text(leg.leg_condition_id) || text(leg.conditionId);
  if (direct !== "") out.push(direct.toLowerCase());
  const market = asRecord(leg.market);
  if (market !== null) {
    const nested = text(market.condition_id) || text(market.conditionId);
    if (nested !== "") out.push(nested.toLowerCase());
  }
  return out;
}

function legMarketSlugs(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const market = leg.market;
  if (typeof market === "string" && market !== "") out.push(market);
  const direct = text(leg.marketSlug);
  if (direct !== "") out.push(direct);
  const nested = asRecord(market);
  if (nested !== null) {
    const slug = text(nested.slug) || text(nested.market_slug);
    if (slug !== "") out.push(slug);
  }
  return out;
}

function legTokenIds(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = text(leg.clobTokenId) || text(leg.tokenId);
  if (direct !== "") out.push(direct);
  return out;
}

function legMarketType(leg: Record<string, unknown>): string {
  const market = asRecord(leg.market);
  return (
    text(market?.sports_market_type) ||
    text(market?.sportsMarketType) ||
    text(leg.sports_market_type) ||
    text(leg.sportsMarketType) ||
    text(leg.market_type)
  ).toLowerCase();
}

function legKey(leg: Record<string, unknown>): string {
  return (
    text(leg.leg_condition_id) ||
    text(leg.conditionId) ||
    text(asRecord(leg.market)?.condition_id) ||
    text(asRecord(leg.market)?.conditionId) ||
    text(leg.clobTokenId) ||
    text(leg.tokenId) ||
    text(leg.marketSlug) ||
    (typeof leg.market === "string" ? leg.market : "") ||
    text(asRecord(leg.market)?.slug) ||
    text(asRecord(leg.market)?.market_slug) ||
    text(leg.symbol) ||
    JSON.stringify(leg)
  ).toLowerCase();
}

/**
 * Dedupe signature for a single leg. `legKey` alone is too coarse: two combos can reference the
 * same condition id on different outcomes or market types (moneyline vs player_props).
 */

function legSignature(leg: Record<string, unknown>): string {
  const outcome = legOutcome(leg);
  return `${legKey(leg)}|${outcome}|${legMarketType(leg)}`;
}

function legOutcome(leg: Record<string, unknown>): string {
  return (
    text(leg.leg_outcome_label) ||
    text(leg.outcome) ||
    text(leg.leg_outcome)
  ).toUpperCase();
}

/** A stable id is anything but the `JSON.stringify` fallback in `legKey`. */

function hasStableLegId(leg: Record<string, unknown>): boolean {
  return !legKey(leg).startsWith("{");
}

function attributeLeg(
  leg: Record<string, unknown>,
  index: GameIndex,
): { game: string | null; type: string } {
  for (const id of legConditionIds(leg)) {
    const game = index.byConditionId.get(id);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  for (const slug of legMarketSlugs(leg)) {
    const game = index.byMarketSlug.get(slug);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  for (const token of legTokenIds(leg)) {
    const game = index.byTokenId.get(token);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  return { game: null, type: legMarketType(leg) };
}

type NormalizeResult =
  | { readonly ok: true; readonly combo: NormalizedCombo }
  | { readonly ok: false; readonly reason: "NO_LEGS" | "NO_ATTRIBUTION" };

export function normalizeCombo(
  raw: unknown,
  fallbackWallet: string,
  index: GameIndex,
): NormalizeResult {
  const record = asRecord(raw);
  if (record === null) return { ok: false, reason: "NO_LEGS" };
  const legsRaw = Array.isArray(record.legs)
    ? record.legs
    : Array.isArray(record.components)
      ? record.components
      : [];
  if (legsRaw.length === 0) return { ok: false, reason: "NO_LEGS" };
  const legs = legsRaw
    .map(asRecord)
    .filter((leg): leg is Record<string, unknown> => leg !== null);
  if (legs.length === 0) return { ok: false, reason: "NO_LEGS" };

  const games = new Set<string>();
  const unresolvedLegKeys: string[] = [];
  let attributed = 0;
  let eligible = true;
  for (const leg of legs) {
    const result = attributeLeg(leg, index);
    if (result.game === null) {
      unresolvedLegKeys.push(legKey(leg));
      continue;
    }
    attributed += 1;
    games.add(result.game);
    if (!ELIGIBLE_LEG_TYPES.has(result.type)) eligible = false;
  }
  if (games.size === 0) return { ok: false, reason: "NO_ATTRIBUTION" };

  const legKeys = legs.map(legKey).sort();
  const legSignatures = legs.map(legSignature).sort();
  const comboId =
    text(record.comboId) ||
    text(record.id) ||
    `sha256:${hashKeys(legSignatures)}`;
  const wallet = (
    text(record.user) ||
    text(record.wallet) ||
    fallbackWallet
  ).toLowerCase();
  return {
    ok: true,
    combo: {
      comboId,
      wallet,
      gameSlugs: games,
      legKeys,
      legSignatures,
      legsWithoutSide: legs.filter((leg) => legOutcome(leg) === "").length,
      unstableLegs: legs.filter((leg) => !hasStableLegId(leg)).length,
      allLegsCfb: attributed === legs.length,
      allCfbLegsEligible: eligible,
      fullyWithinGame: games.size === 1,
      unresolvedLegKeys,
    },
  };
}

export function hashKeys(keys: readonly string[]): string {
  return new Bun.CryptoHasher("sha256").update(keys.join("|")).digest("hex");
}

/** Zero-padded condition ids look like combo conditions; CLOB answers 404 for them. */

export function looksLikeComboCondition(key: string): boolean {
  return /^0x[0-9a-f]{40,}0{16,}$/.test(key);
}

/** Seeds wallets from public CFB trades (one request per sampled market). */
