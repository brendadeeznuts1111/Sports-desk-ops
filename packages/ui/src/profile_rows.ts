/**
 * Map the customer book's rows (the `/api/customers` `fixtures` array) onto the shape the
 * Profiles tab renders.
 *
 * Only derivable values are computed: sharpness from `sharp_score`, CLV from `clv_bps`, sizing
 * strategy and Gini from the row's recent tickets, specialization from the most common
 * league/market. Fields the book does not carry (syndicate probability, line shading, LTV) are
 * left at their explicit zero/none values rather than guessed.
 */
import type { ShowcaseCustomer } from "./types.ts";

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function stakesOf(row: Row): number[] {
  const tickets = Array.isArray(row.recent_tickets) ? row.recent_tickets : [];
  return tickets
    .map((ticket) => num((ticket as Row).risk_usd))
    .filter((risk) => risk > 0);
}

function gini(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;
  const weighted = sorted.reduce((acc, v, i) => acc + (i + 1) * v, 0);
  return (
    (2 * weighted) / (sorted.length * sum) - (sorted.length + 1) / sorted.length
  );
}

function topKey(tickets: readonly Row[], key: string): string {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    const value = String(ticket[key] ?? "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const SOURCE_TIERS: ReadonlySet<string> = new Set([
  "TIER_1_ELITE_ORIGINATOR",
  "TIER_2_STEAM_SYNDICATE",
  "TIER_3_SHARP_DISCIPLINED",
  "TIER_4_SEMI_SHARP",
  "TIER_5_RECREATIONAL",
]);

function tierFor(score: number): ShowcaseCustomer["tier"] {
  if (score >= 9) return "TIER_1_ELITE_ORIGINATOR";
  if (score >= 7) return "TIER_2_STEAM_SYNDICATE";
  if (score >= 5) return "TIER_3_SHARP_DISCIPLINED";
  if (score >= 3) return "TIER_4_SEMI_SHARP";
  return "TIER_5_RECREATIONAL";
}

export function bookRowsToProfiles(
  rows: ReadonlyArray<Row>,
): ShowcaseCustomer[] {
  return rows.map((row, idx) => {
    const id = String(row.customer_id ?? row.customerId ?? `BOOK-${idx}`);
    const tickets = Array.isArray(row.recent_tickets)
      ? (row.recent_tickets as Row[])
      : [];
    const stakes = stakesOf(row);
    const meanStake = stakes.length
      ? stakes.reduce((acc, v) => acc + v, 0) / stakes.length
      : 0;
    const variance = stakes.length
      ? stakes.reduce((acc, v) => acc + (v - meanStake) ** 2, 0) / stakes.length
      : 0;
    const sd = Math.sqrt(variance);
    const cv = meanStake > 0 ? sd / meanStake : 0;
    const rawSharp = Number(row.sharp_score);
    const sharpKnown = Number.isFinite(rawSharp);
    const score = sharpKnown ? clamp(rawSharp / 10, 0, 10) : 0;
    const clvScore = clamp(num(row.clv_bps) / 100, -10, 10);
    const delay = num(row.delay_seconds);
    const league = topKey(tickets, "league");
    const market = topKey(tickets, "market");

    const unknown: string[] = [];
    if (!sharpKnown) unknown.push("sharpness");
    if (stakes.length === 0) {
      // A mean of zero observations is undefined; a mean of one is just that stake.
      unknown.push("meanStake");
    }
    if (stakes.length < 2) {
      // Gini/VaR of one observation are convention, not measurement; sizing derives from
      // a spread that does not exist yet.
      unknown.push("sizing", "gini", "var95");
    }
    if (!league && !market) unknown.push("specialization");
    // The book carries no syndicate or correlation signal at all.
    unknown.push("syndicate", "correlation");

    return {
      id,
      name: id,
      agentId: String(row.agent_id ?? row.agentId ?? "—"),
      masterAgent: String(row.master_agent ?? row.masterAgent ?? "—"),
      // A source tier wins when present; the score derivation is the fallback, not a replacement.
      tier:
        typeof row.tier === "string" &&
        SOURCE_TIERS.has(row.tier.trim().toUpperCase())
          ? (row.tier.trim().toUpperCase() as ShowcaseCustomer["tier"])
          : tierFor(score),
      score: round(score, 2),
      clvScore: round(clvScore, 2),
      skillScore: clvScore,
      sizingScore: round(clamp(1 - cv, 0, 2), 2),
      sigScore: 0,
      timingScore: delay > 0 ? 1 : 0,
      sizingStrategy: cv < 0.15 ? "FLAT_UNIT" : "PROPORTIONAL_KELLY",
      gini: round(gini(stakes), 4),
      meanStake: round(meanStake, 2),
      specialization:
        [league, market].filter(Boolean).join(" ") ||
        String(row.context_type ?? "UNKNOWN"),
      timingArchetype: String(row.context_type ?? "UNKNOWN"),
      correlatedRisk: "NONE",
      correlatedExploitRate: 0,
      syndicateRisk: "LOW",
      syndicateProb: 0,
      subAccountIndex: null,
      var95Usd: round(meanStake + 1.645 * sd, 2),
      cvar95Usd: round(meanStake + 2 * sd, 2),
      holdPct: num(row.hold_pct),
      ltvUsd: num(row.lifetime_net_usd),
      recommendedLimitUsd: num(row.wager_limit_usd),
      inPlayDelaySec: delay,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: score >= 7 ? "ALERT_OPERATOR" : "ACCEPT_NORMAL",
      ipAddress: String(row.ip_subnet ?? "—"),
      unknown,
    };
  });
}

/**
 * Which array is the data? `provenance.kind` answers it, so an empty capture stays empty instead
 * of falling back to the fixture corpus (a loaded-but-empty book is not "no book").
 */
export function selectProfileRows(payload: {
  readonly book?: ReadonlyArray<Row> | undefined;
  readonly fixtures: ReadonlyArray<Row>;
  readonly provenance: { readonly kind: string };
}): ShowcaseCustomer[] {
  const kind = payload.provenance.kind;
  const authoritative =
    kind === "capture" || kind === "live"
      ? (payload.book ?? [])
      : payload.fixtures;
  return bookRowsToProfiles(authoritative);
}
