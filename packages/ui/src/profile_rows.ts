/**
 * Map the customer book's rows (the `/api/customers` `fixtures` array) onto the shape the
 * Profiles tab renders.
 *
 * Only derivable values are computed: sharpness from `sharp_score`, CLV from `clv_bps`, sizing
 * strategy and Gini from the row's recent tickets, specialization from the most common
 * league/market. Fields the book does not carry (syndicate probability, line shading, LTV) are
 * left at their explicit zero/none values rather than guessed.
 */
import type {
  CustomerRatingApiPayload,
  LiveWager,
  RankedPlayer30d,
  ShowcaseCustomer,
} from "./types.ts";

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const DECIMAL_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function nonNegativeFinite(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !DECIMAL_NUMERIC.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

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

/** Map ranking / API tier codes onto the Profiles tab vocabulary (data-first). */
export function mapRankingTierCode(
  tier: string,
): ShowcaseCustomer["tier"] | null {
  const t = tier.trim().toUpperCase();
  if (t === "TIER_1" || t.includes("ELITE") || t.includes("ORIGINATOR")) {
    return "TIER_1_ELITE_ORIGINATOR";
  }
  if (t === "TIER_2" || t.includes("STEAM") || t.includes("SYNDICATE")) {
    return "TIER_2_STEAM_SYNDICATE";
  }
  if (t === "TIER_3" || t.includes("DISCIPLINED") || t.includes("SHARP")) {
    return "TIER_3_SHARP_DISCIPLINED";
  }
  if (t === "TIER_4" || t.includes("SEMI")) {
    return "TIER_4_SEMI_SHARP";
  }
  if (t === "TIER_5" || t.includes("RECREATIONAL") || t.includes("RETAIL")) {
    return "TIER_5_RECREATIONAL";
  }
  if (SOURCE_TIERS.has(t)) {
    return t as ShowcaseCustomer["tier"];
  }
  return null;
}

function tierFromRow(row: Row, score: number): ShowcaseCustomer["tier"] {
  const rawTier = typeof row.tier === "string" ? row.tier.trim() : "";
  const rawLabel =
    typeof row.tierLabel === "string" ? row.tierLabel.trim() : "";
  for (const candidate of [rawTier, rawLabel]) {
    if (!candidate) continue;
    const mapped = mapRankingTierCode(candidate);
    if (mapped !== null) return mapped;
  }
  return tierFor(score);
}

/** True when the row represents a synthetic demo fixture account (`SYNTH_*`). */
export function isSyntheticShowcaseCustomer(
  customer: Pick<ShowcaseCustomer, "id" | "masterAgent" | "synthetic">,
): boolean {
  if (customer.synthetic === true) return true;
  const id = customer.id.trim().toUpperCase();
  const master = customer.masterAgent.trim().toUpperCase();
  return id.startsWith("SYNTH_") || master.startsWith("SYNTH_");
}

const RADAR_CAPS: readonly [number, number, number, number, number] = [
  3.0, 2.5, 1.5, 2.0, 1.0,
];

/** Adjust 5 radar axes proportionally so integer-hundredths conserve `targetScore` within caps. */
function conserveRadarAxes(
  raw: readonly [number, number, number, number, number],
  targetScore: number,
): readonly [number, number, number, number, number] {
  const targetUnits = Math.round(clamp(targetScore, 0, 10) * 100);
  const maxUnits = RADAR_CAPS.map((cap) => Math.round(cap * 100));
  const units = raw.map((val, i) =>
    Math.min(maxUnits[i]!, Math.max(0, Math.round(val * 100))),
  );
  let sum = units.reduce((acc, u) => acc + u, 0);
  if (sum !== targetUnits) {
    if (sum < targetUnits) {
      let need = targetUnits - sum;
      const rooms = units.map((u, i) => maxUnits[i]! - u);
      const totalRoom = rooms.reduce((acc, r) => acc + r, 0);
      if (totalRoom > 0) {
        for (let i = 0; i < 5 && need > 0; i++) {
          const add = Math.min(
            rooms[i]!,
            Math.floor((need * rooms[i]!) / totalRoom),
          );
          units[i] = units[i]! + add;
          need -= add;
        }
        for (let i = 0; i < 5 && need > 0; i++) {
          const room = maxUnits[i]! - units[i]!;
          if (room <= 0) continue;
          const add = Math.min(room, need);
          units[i] = units[i]! + add;
          need -= add;
        }
      }
    } else {
      let excess = sum - targetUnits;
      const origSum = sum;
      if (origSum > 0) {
        for (let i = 0; i < 5 && excess > 0; i++) {
          const cut = Math.min(
            units[i]!,
            Math.floor((excess * units[i]!) / origSum),
          );
          units[i] = units[i]! - cut;
          excess -= cut;
        }
        for (let i = 0; i < 5 && excess > 0; i++) {
          if (units[i]! <= 0) continue;
          const cut = Math.min(units[i]!, excess);
          units[i] = units[i]! - cut;
          excess -= cut;
        }
      }
    }
    sum = units.reduce((acc, u) => acc + u, 0);
  }
  return [
    units[0]! / 100,
    units[1]! / 100,
    units[2]! / 100,
    units[3]! / 100,
    units[4]! / 100,
  ] as const;
}

export function bookRowsToProfiles(
  rows: ReadonlyArray<Row>,
  source: "book" | "fixture" = "book",
): ShowcaseCustomer[] {
  return rows.map((row, idx) => {
    const id = String(row.customer_id ?? row.customerId ?? `BOOK-${idx}`);
    const agentId = String(row.agent_id ?? row.agentId ?? "—");
    const masterAgent = String(row.master_agent ?? row.masterAgent ?? "—");
    const isSynth =
      row.synthetic === true ||
      id.trim().toUpperCase().startsWith("SYNTH_") ||
      masterAgent.trim().toUpperCase().startsWith("SYNTH_");
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
    const rawClv = row.clv_bps ?? row.clvBps;
    const clvBps =
      typeof rawClv === "number" && Number.isFinite(rawClv) ? rawClv : null;
    const rawClvLegs = nonNegativeFinite(row.clv_legs ?? row.clvLegs);
    const clvScore = clamp(num(row.clv_bps) / 100, -10, 10);
    const rawDelay = nonNegativeFinite(row.delay_seconds);
    const delayKnown = rawDelay !== null;
    const delay = rawDelay ?? 0;
    const league = topKey(tickets, "league");
    const market = topKey(tickets, "market");
    const sizingKnown = stakes.length >= 2;
    const rawLastActive =
      typeof row.last_active_at === "string" && row.last_active_at.trim() !== ""
        ? row.last_active_at.trim()
        : undefined;
    const rawTotalWagers = nonNegativeFinite(row.total_wagers);

    const unknown: string[] = [];
    if (!sharpKnown) unknown.push("sharpness");
    if (stakes.length === 0) {
      // A mean of zero observations is undefined; a mean of one is just that stake.
      unknown.push("meanStake");
    }
    if (!sizingKnown) {
      // Gini/VaR of one observation are convention, not measurement; sizing derives from
      // a spread that does not exist yet.
      unknown.push("sizing", "gini", "var95");
    }
    if (!league && !market) unknown.push("specialization");
    // The book carries no syndicate or correlation signal at all.
    unknown.push("syndicate", "correlation");
    if (!delayKnown) unknown.push("delay");

    return {
      id,
      name: id,
      agentId,
      masterAgent,
      tier: tierFromRow(row, score),
      score: round(score, 2),
      clvScore: round(clvScore, 2),
      skillScore: clvScore,
      sizingScore: sizingKnown ? round(clamp(1 - cv, 0, 2), 2) : 0,
      sigScore: 0,
      timingScore: delayKnown && delay > 0 ? 1 : 0,
      sizingStrategy: sizingKnown
        ? cv < 0.15
          ? "FLAT_UNIT"
          : "PROPORTIONAL_KELLY"
        : "PENDING_TICKETS",
      gini: sizingKnown ? round(gini(stakes), 4) : 0,
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
      var95Usd: sizingKnown ? round(meanStake + 1.645 * sd, 2) : 0,
      cvar95Usd: sizingKnown ? round(meanStake + 2 * sd, 2) : 0,
      holdPct: num(row.hold_pct),
      ltvUsd: num(row.lifetime_net_usd),
      recommendedLimitUsd: num(row.wager_limit_usd),
      inPlayDelaySec: delay,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: score >= 7 ? "ALERT_OPERATOR" : "ACCEPT_NORMAL",
      ipAddress: String(row.ip_subnet ?? "—"),
      ...(clvBps === null ? {} : { clvBps }),
      ...(rawClvLegs !== null && rawClvLegs > 0 ? { clvLegs: rawClvLegs } : {}),
      ...(isSynth ? { synthetic: true } : {}),
      ...(rawLastActive !== undefined ? { lastWagerAt: rawLastActive } : {}),
      ...(rawTotalWagers !== null && rawTotalWagers > 0
        ? { totalWagers: rawTotalWagers }
        : {}),
      unknown,
      source,
    };
  });
}

/**
 * Map the backtest leaderboard (`/api/customers` `backtestAll`) onto the Profiles shape.
 * The rows carry parlay exposure and CLV, not a per-ticket book: everything that would need
 * tickets or a live profile (Gini, VaR, syndicate, correlation, limits, delay) is listed in
 * `unknown` and rendered as "—" rather than as a measured zero.
 */
export function backtestRowsToProfiles(
  rows: ReadonlyArray<Row>,
): ShowcaseCustomer[] {
  return rows.map((row, idx) => {
    const id = String(
      row.customerId ?? row.customer_id ?? row.customer ?? `BACKTEST-${idx}`,
    );
    const rawSharp = Number(row.sharpScore ?? row.sharp_score);
    const sharpKnown = Number.isFinite(rawSharp) && rawSharp > 0;
    const score = sharpKnown ? clamp(rawSharp / 10, 0, 10) : 0;
    const rawClv = row.avgClvBps ?? row.clv_bps ?? row.clvBps;
    const measuredClvBps =
      typeof rawClv === "number" && Number.isFinite(rawClv) ? rawClv : null;
    const clvBps = num(rawClv);
    const clvScore = clamp(clvBps / 100, -10, 10);
    const tickets = num(row.totalParlayTickets);
    const handle = num(row.totalParlayHandleUsd);
    const meanStake = tickets > 0 && handle > 0 ? handle / tickets : 0;
    const contextType = String(
      row.contextType ?? row.context_type ?? "UNKNOWN",
    );
    const unknown: string[] = [
      "syndicate",
      "correlation",
      "gini",
      "sizing",
      "var95",
      "holdPct",
      "ltv",
      "limit",
      "delay",
      "tickets",
    ];
    if (!sharpKnown) unknown.push("sharpness");
    if (meanStake === 0) unknown.push("meanStake");

    return {
      id,
      name: id,
      agentId: String(row.agentId ?? row.agent_id ?? "—"),
      masterAgent: String(row.masterAgent ?? row.master_agent ?? "—"),
      tier: tierFor(score),
      score: round(score, 2),
      clvScore: round(clvScore, 2),
      skillScore: round(clvScore, 2),
      sizingScore: 0,
      sigScore: 0,
      timingScore: 0,
      sizingStrategy: "PENDING_TICKETS",
      gini: 0,
      meanStake: round(meanStake, 2),
      specialization: String(row.dominantComboFamily ?? contextType),
      timingArchetype: contextType,
      correlatedRisk: "NONE",
      correlatedExploitRate: 0,
      syndicateRisk: "LOW",
      syndicateProb: 0,
      subAccountIndex: null,
      var95Usd: 0,
      cvar95Usd: 0,
      holdPct: 0,
      ltvUsd: 0,
      recommendedLimitUsd: 0,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: score >= 7 ? "ALERT_OPERATOR" : "ACCEPT_NORMAL",
      ipAddress: String(row.ipSubnet ?? row.ip_subnet ?? "—"),
      ...(measuredClvBps === null ? {} : { clvBps: measuredClvBps }),
      unknown,
      source: "backtest",
    };
  });
}

/** Union by customer ID; earlier groups win, so a richer row beats a backtest row. */
export function mergeProfileRows(
  ...groups: ReadonlyArray<ReadonlyArray<ShowcaseCustomer>>
): ShowcaseCustomer[] {
  const byId = new Map<string, ShowcaseCustomer>();
  for (const group of groups) {
    for (const row of group) {
      const key = row.id.trim().toUpperCase();
      if (key && !byId.has(key)) byId.set(key, row);
    }
  }
  return [...byId.values()];
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
  return bookRowsToProfiles(
    authoritative,
    kind === "capture" || kind === "live" ? "book" : "fixture",
  );
}

/** 30d batch rankings → Profiles shape; tier and score come from the ranking payload. */
export function rankingsPlayersToProfiles(
  players: readonly RankedPlayer30d[],
): ShowcaseCustomer[] {
  return players.map((player) => {
    const score = round(clamp(player.score, 0, 10), 2);
    const mappedTier = mapRankingTierCode(player.tier) ?? tierFor(score);
    const hasLifetimeNet =
      typeof player.lifetimeNetUsd === "number" &&
      Number.isFinite(player.lifetimeNetUsd);
    const unknown: string[] = hasLifetimeNet
      ? ["holdPct", "tickets"]
      : ["holdPct", "ltv", "tickets"];
    if (player.handleUsd <= 0) unknown.push("meanStake");

    const sc = player.scoreComponents;
    const rawAxes: readonly [number, number, number, number, number] = sc
      ? [sc.clv, sc.volume, sc.sizing, sc.timing, sc.combo]
      : [
          round(clamp(player.alertRate / 40, 0, 3), 2),
          round(clamp(score * 0.26, 0, 2.5), 2),
          round(clamp(1.5 - player.gini * 0.8, 0, 1.5), 2),
          round(clamp(1 + player.alertRate / 100, 0, 2), 2),
          player.isProxy ? 0.9 : 0.6,
        ];
    const [clvScore, skillScore, sizingScore, sigScore, timingScore] =
      conserveRadarAxes(rawAxes, score);

    const hasClvBps =
      typeof player.clvBps === "number" && Number.isFinite(player.clvBps);

    return {
      id: player.id,
      name: player.id,
      agentId: player.agentId,
      masterAgent: player.masterAgent,
      tier: mappedTier,
      tierLabel: player.tierLabel,
      score,
      clvScore,
      skillScore,
      sizingScore,
      sigScore,
      timingScore,
      sizingStrategy: player.gini > 0.35 ? "VARIABLE_STAKE" : "FLAT_UNIT",
      gini: round(player.gini, 4),
      meanStake:
        player.wagers > 0 ? round(player.handleUsd / player.wagers, 2) : 0,
      specialization: player.dominantSport || "MIXED",
      timingArchetype: player.tierLabel,
      correlatedRisk: player.isProxy ? "HIGH" : "MODERATE",
      correlatedExploitRate: round(player.alertRate / 100, 2),
      syndicateRisk:
        player.isProxy || player.isMultiSeatCluster ? "HIGH" : "LOW",
      syndicateProb: player.isProxy
        ? 0.75
        : player.isMultiSeatCluster
          ? 0.6
          : 0,
      subAccountIndex: null,
      var95Usd: round(Math.max(500, player.handleUsd * 0.05), 2),
      cvar95Usd: round(Math.max(750, player.handleUsd * 0.08), 2),
      holdPct: 0,
      ltvUsd: hasLifetimeNet ? round(player.lifetimeNetUsd!, 2) : 0,
      recommendedLimitUsd: player.limitUsd,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action:
        player.tier === "TIER_1" || player.tier === "TIER_2"
          ? "ALERT_OPERATOR"
          : "MONITOR",
      ipAddress: "—",
      ...(hasClvBps ? { clvBps: player.clvBps! } : {}),
      ...(typeof player.clvLegs === "number" && player.clvLegs > 0
        ? { clvLegs: player.clvLegs }
        : {}),
      ...(player.lastWagerAt ? { lastWagerAt: player.lastWagerAt } : {}),
      ...(typeof player.keyNumberBuys30d === "number" &&
      player.keyNumberBuys30d > 0
        ? { keyNumberBuys30d: player.keyNumberBuys30d }
        : {}),
      ...(typeof player.halfPointBuys30d === "number" &&
      player.halfPointBuys30d > 0
        ? { halfPointBuys30d: player.halfPointBuys30d }
        : {}),
      ...(typeof player.halfPointBuyRatePct === "number" &&
      player.halfPointBuyRatePct > 0
        ? { halfPointBuyRatePct: player.halfPointBuyRatePct }
        : {}),
      ...(typeof player.seatCount === "number" && player.seatCount > 1
        ? { seatCount: player.seatCount }
        : {}),
      ...(player.isKeyNumberBuyer === true ? { isKeyNumberBuyer: true } : {}),
      ...(player.isHalfPointHookBuyer === true
        ? { isHalfPointHookBuyer: true }
        : {}),
      ...(player.isMultiSeatCluster === true
        ? { isMultiSeatCluster: true }
        : {}),
      ...(player.isProxy ? { isProxyConduit: true } : {}),
      ...(typeof player.sharpCandidateGatePassed === "boolean"
        ? { sharpCandidateGatePassed: player.sharpCandidateGatePassed }
        : {}),
      totalWagers: player.wagers,
      handle30dUsd: round(player.handleUsd, 2),
      unknown,
      source: "rankings",
    };
  });
}

/** Open wager tape → one profile per active customer (live-open overlay). */
export function liveOpenWagersToProfiles(
  wagers: readonly LiveWager[],
): ShowcaseCustomer[] {
  const byCustomer = new Map<
    string,
    {
      agentId: string;
      masterAgent: string;
      riskUsd: number;
      stakes: number[];
      sports: Map<string, number>;
      alerts: number;
      clvBps: number | null;
      latestTs: string;
    }
  >();
  for (const w of wagers) {
    const id = w.customerId.trim().toUpperCase();
    if (!id) continue;
    let acc = byCustomer.get(id);
    if (!acc) {
      acc = {
        agentId: w.agentId,
        masterAgent: w.masterAgent,
        riskUsd: 0,
        stakes: [],
        sports: new Map(),
        alerts: 0,
        clvBps:
          typeof w.customerClvBps === "number" &&
          Number.isFinite(w.customerClvBps)
            ? w.customerClvBps
            : null,
        latestTs: w.timestamp,
      };
      byCustomer.set(id, acc);
    }
    acc.riskUsd += w.riskUsd;
    acc.stakes.push(w.riskUsd);
    const sp = w.sport.trim().toUpperCase() || "OTHER";
    acc.sports.set(sp, (acc.sports.get(sp) ?? 0) + 1);
    if (w.alertTier !== "BASELINE") acc.alerts += 1;
    if (
      acc.clvBps === null &&
      typeof w.customerClvBps === "number" &&
      Number.isFinite(w.customerClvBps)
    ) {
      acc.clvBps = w.customerClvBps;
    }
    if (w.timestamp && w.timestamp > acc.latestTs) {
      acc.latestTs = w.timestamp;
    }
  }

  const out: ShowcaseCustomer[] = [];
  for (const [id, acc] of byCustomer) {
    const meanStake = acc.stakes.length
      ? acc.stakes.reduce((s, v) => s + v, 0) / acc.stakes.length
      : 0;
    const g = gini(acc.stakes);
    let topSport = "MIXED";
    let topCount = 0;
    for (const [sport, count] of acc.sports) {
      if (count > topCount) {
        topSport = sport;
        topCount = count;
      }
    }
    const alertRate =
      acc.stakes.length > 0 ? acc.alerts / acc.stakes.length : 0;
    const sizingScore = round(clamp(1.5 - g * 0.8, 0, 1.5), 2);
    const sigScore = round(clamp(alertRate, 0, 2), 2);
    const timingScore = 0.5;
    const score = round(sizingScore + sigScore + timingScore, 2);
    const unknown: string[] = [
      "holdPct",
      "ltv",
      "sharpness",
      "limit",
      "delay",
      "syndicate",
      "correlation",
    ];

    out.push({
      id,
      name: id,
      agentId: acc.agentId,
      masterAgent: acc.masterAgent,
      tier: "TIER_5_RECREATIONAL",
      tierLabel: "Open book — tier pending 30d rank",
      score,
      clvScore: 0,
      skillScore: 0,
      sizingScore,
      sigScore,
      timingScore,
      sizingStrategy: g < 0.2 ? "FLAT_UNIT" : "VARIABLE_STAKE",
      gini: round(g, 4),
      meanStake: round(meanStake, 2),
      specialization: topSport,
      timingArchetype: "LIVE_OPEN",
      correlatedRisk: "MODERATE",
      correlatedExploitRate: round(alertRate, 2),
      syndicateRisk: "LOW",
      syndicateProb: 0,
      subAccountIndex: null,
      var95Usd: round(meanStake + 1.645 * Math.sqrt(meanStake), 2),
      cvar95Usd: round(meanStake * 1.35, 2),
      holdPct: 0,
      ltvUsd: 0,
      recommendedLimitUsd: 0,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: alertRate > 0.25 ? "ALERT_OPERATOR" : "MONITOR",
      ipAddress: "—",
      openRiskUsd: round(acc.riskUsd, 2),
      totalWagers: acc.stakes.length,
      ...(acc.clvBps !== null ? { clvBps: acc.clvBps } : {}),
      ...(acc.latestTs && acc.latestTs !== "—"
        ? { lastWagerAt: acc.latestTs }
        : {}),
      unknown,
      source: "live-open",
    });
  }
  return out;
}

/**
 * Attaches live open risk (`openRiskUsd`) from tonight's wager tape onto existing rows without
 * replacing richer book/backtest/ranked profiles when both match the same customer ID.
 */
export function mergeOpenRiskOverlay(
  rows: readonly ShowcaseCustomer[],
  liveWagers: readonly LiveWager[] | null | undefined,
): ShowcaseCustomer[] {
  if (!liveWagers?.length || rows.length === 0) return [...rows];
  const openRiskById = new Map<string, number>();
  for (const w of liveWagers) {
    const id = w.customerId.trim().toUpperCase();
    if (!id) continue;
    openRiskById.set(id, (openRiskById.get(id) ?? 0) + w.riskUsd);
  }
  return rows.map((row) => {
    if (row.openRiskUsd !== undefined) return row;
    const risk = openRiskById.get(row.id.trim().toUpperCase());
    if (risk === undefined || risk <= 0) return row;
    return { ...row, openRiskUsd: round(risk, 2) };
  });
}

/** `?matrix=1` overlay: live-open and 30d rankings under cohort fixtures (cohort wins on id clash). */
export function mergeMatrixProfileOverlay(
  cohortProfiles: readonly ShowcaseCustomer[],
  rankingsPlayers: readonly RankedPlayer30d[] | null | undefined,
  liveWagers: readonly LiveWager[] | null | undefined,
): ShowcaseCustomer[] {
  const ranked = rankingsPlayers?.length
    ? rankingsPlayersToProfiles(rankingsPlayers)
    : [];
  const liveOpen = liveWagers?.length
    ? liveOpenWagersToProfiles(liveWagers)
    : [];
  return mergeProfileRows(cohortProfiles, ranked, liveOpen);
}

/**
 * Hydrates a `/api/customer/profile` + optional `/api/customer/rating` response
 * into a UI `ShowcaseCustomer` for on-demand cross-tab inspection.
 */
export function profileApiPayloadToShowcase(
  raw: unknown,
  rating?: CustomerRatingApiPayload | null,
): ShowcaseCustomer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const outer = raw as Record<string, unknown>;
  const prof =
    typeof outer.profile === "object" && outer.profile !== null
      ? (outer.profile as Record<string, unknown>)
      : outer;
  const rawId = prof.customerId ?? prof.customer_id ?? rating?.customerId;
  if (typeof rawId !== "string" || rawId.trim() === "") return null;
  const id = rawId.trim().toUpperCase();

  const risk =
    typeof prof.riskForensics === "object" && prof.riskForensics !== null
      ? (prof.riskForensics as Record<string, unknown>)
      : {};
  const stake =
    typeof prof.stakeProfile === "object" && prof.stakeProfile !== null
      ? (prof.stakeProfile as Record<string, unknown>)
      : {};
  const market =
    typeof prof.marketProfile === "object" && prof.marketProfile !== null
      ? (prof.marketProfile as Record<string, unknown>)
      : {};
  const syndicate =
    typeof prof.syndicateProfile === "object" && prof.syndicateProfile !== null
      ? (prof.syndicateProfile as Record<string, unknown>)
      : {};
  const timing =
    typeof prof.timingProfile === "object" && prof.timingProfile !== null
      ? (prof.timingProfile as Record<string, unknown>)
      : {};
  const correlated =
    typeof prof.correlatedParlayProfile === "object" &&
    prof.correlatedParlayProfile !== null
      ? (prof.correlatedParlayProfile as Record<string, unknown>)
      : {};
  const directives =
    typeof prof.deskDirectives === "object" && prof.deskDirectives !== null
      ? (prof.deskDirectives as Record<string, unknown>)
      : {};
  const composite =
    typeof prof.compositeSharpness === "object" &&
    prof.compositeSharpness !== null
      ? (prof.compositeSharpness as Record<string, unknown>)
      : {};
  const ratingObj =
    rating ??
    (typeof prof.rating === "object" && prof.rating !== null
      ? (prof.rating as unknown as CustomerRatingApiPayload)
      : null);

  const comp = ratingObj?.componentScores;
  const clvBps =
    typeof ratingObj?.clvBps === "number" && Number.isFinite(ratingObj.clvBps)
      ? ratingObj.clvBps
      : null;
  const sampleCount = num(stake.sampleCount);
  const giniVal = num(stake.giniCoefficient);

  // Decompose onto exact SharpnessDecomposition axis caps [3.0, 2.5, 1.5, 2.0, 1.0]
  // so `score` always conserves `sum(axes)` (`ConservationError` delta === 0).
  const cc =
    typeof composite.components === "object" && composite.components !== null
      ? (composite.components as Record<string, unknown>)
      : null;
  const clvScore = cc
    ? round(clamp(num(cc.clvScore), 0, 3), 2)
    : round(clamp((comp?.clvEdgeScore ?? 0) * 0.3, 0, 3), 2);
  const skillScore = cc
    ? round(clamp(num(cc.bayesianSkillScore), 0, 2.5), 2)
    : round(clamp((comp?.keyNumberScore ?? 0) * 0.25, 0, 2.5), 2);
  const sizingScore = cc
    ? round(clamp(num(cc.sizingDisciplineScore), 0, 1.5), 2)
    : round(clamp(1 - giniVal, 0, 1.5), 2);
  const sigScore = cc
    ? round(clamp(num(cc.signatureSpecializationScore), 0, 2), 2)
    : round(clamp((comp?.steamLatencyScore ?? 0) * 0.2, 0, 2), 2);
  const timingScore = cc
    ? round(clamp(num(cc.timingExploitationScore), 0, 1), 2)
    : round(clamp((comp?.timingDisciplineScore ?? 0) * 0.1, 0, 1), 2);
  const score = round(
    clamp(clvScore + skillScore + sizingScore + sigScore + timingScore, 0, 10),
    2,
  );

  const unknown: string[] = [];
  if (sampleCount === 0) unknown.push("meanStake");
  if (sampleCount < 2) unknown.push("sizing", "gini", "var95");
  if (clvBps === null && comp?.clvEdgeScore === undefined)
    unknown.push("clvBps");

  const mappedTier =
    mapRankingTierCode(
      ratingObj?.tier ?? (composite.tier as string | undefined) ?? "",
    ) ?? tierFor(score);

  return {
    id,
    name: id,
    agentId: String(prof.agentId ?? "—"),
    masterAgent: String(prof.masterAgent ?? "—"),
    tier: mappedTier,
    tierLabel: ratingObj?.tier,
    score,
    clvScore,
    skillScore,
    sizingScore,
    sigScore,
    timingScore,
    sizingStrategy: String(stake.sizingStrategy ?? "PENDING_TICKETS"),
    gini: round(giniVal, 4),
    meanStake: round(num(stake.meanStakeUsd), 2),
    specialization:
      [market.dominantLeague, market.dominantMarket]
        .filter((s) => typeof s === "string" && s !== "")
        .join(" ") || String(prof.contextType ?? "UNKNOWN"),
    timingArchetype: String(timing.archetype ?? prof.contextType ?? "UNKNOWN"),
    correlatedRisk:
      correlated.exploitRisk === "CRITICAL" ||
      correlated.exploitRisk === "HIGH" ||
      correlated.exploitRisk === "MODERATE"
        ? correlated.exploitRisk
        : "NONE",
    correlatedExploitRate: round(num(correlated.exploitRate), 2),
    syndicateRisk:
      syndicate.syndicateRisk === "HIGH" ||
      syndicate.syndicateRisk === "ELEVATED"
        ? syndicate.syndicateRisk
        : "LOW",
    syndicateProb: round(num(syndicate.syndicateProbability), 2),
    subAccountIndex: null,
    var95Usd: round(num(risk.portfolioVar95Usd), 2),
    cvar95Usd: round(num(risk.portfolioCvar95Usd), 2),
    holdPct: round(num(risk.holdPct), 1),
    ltvUsd: round(num(risk.estimatedLtvUsd ?? risk.lifetimeNetUsd), 2),
    recommendedLimitUsd: round(num(directives.recommendedMaxLimitUsd), 2),
    inPlayDelaySec: num(directives.inPlayDelaySec),
    lineShadeCents: num(directives.lineShadeCents),
    shadowCopyMultiplier: num(directives.shadowCopyMultiplier) || 1,
    action: String(
      ratingObj?.recommendedAction ?? directives.primaryAction ?? "MONITOR",
    ),
    ipAddress: "—",
    ...(clvBps === null ? {} : { clvBps }),
    unknown,
    source: "book",
  };
}
