/**
 * Customer profiles: the book's lifetime numbers joined to its own ticket sample, the agent tree,
 * and the channel split.
 *
 * The customer book (`enriched_customers_full.json`, 220 rows) already carries lifetime and 7-day
 * aggregates plus five recent tickets per customer — 1,100 tickets with `league`, `market`,
 * `channel`, `result`, `risk_usd` and `net_usd`. That is enough to answer "profit and loss per
 * market, per sport, live versus pregame" **offline**, per customer, without a portal session.
 *
 * Two limits are facts about the data, not gaps in the code:
 *  - The ticket sample is five rows per customer. It supports a *recent* view, never a lifetime
 *    one; every aggregate below is labelled with the window it covers and `sampleOnly: true`.
 *  - "Live" has no verified flag. `WagerType: L` is not it (the account flags contradict each other
 *    and an `L` row has never been matched to a live game), so the channel split treats `GSLIVE`
 *    as a *proxy* and says so. Period (`Game` vs halves) is a market property, not a timing one.
 */

import { portalIso } from "./bet_flags.ts";
import { competitionFamilyFromDirectory } from "./candidate_match_evaluation.ts";
import type { BunInspectOptions } from "./cli_inspect.ts";
import { normalizeCanonicalPeriod } from "./combo_identity.ts";
import {
  enrichTicketWithBuyPoints,
  parseBuyPointsFromDesc,
  type EnrichedTicketMaster,
  type FigureDateWagerRow,
} from "./f402_figure_date_enricher.ts";
import {
  isPendingBlobRow,
  parsePendingBlobDescription,
} from "./f402_pending_blob.ts";
import {
  compareSignatures,
  createSignatureSpecs,
  DEFAULT_THRESHOLDS,
  makeHalfPointBuys,
  makeSecondHalfConcentration,
  resolveCustomerSpreadKeyNumber,
  SIGNATURE_SPECS,
  type ActiveSignatureKind,
  type CbbUnderConcentrationSignature,
  type CustomerSportMix,
  type CustomerTotals,
  type FootballKeyNumberDisciplineSignature,
  type HalfPointBuysSignature,
  type InPlayActivitySignature,
  type NormalizedObservationTicket,
  type PostHalftimeActivitySignature,
  type PreMoveBettingSignature,
  type RankedSignatureEntry,
  type SecondHalfConcentrationSignature,
  type Signature,
  type SignatureSpec,
  type SignatureThresholds,
  type WagerTiming,
} from "./signatures/index.ts";
import { sportCategoryFor } from "./sport_taxonomy.ts";

export {
  compareSignatures,
  createSignatureSpecs,
  DEFAULT_THRESHOLDS,
  enrichTicketWithBuyPoints,
  makeHalfPointBuys,
  makeSecondHalfConcentration,
  parseBuyPointsFromDesc,
  resolveCustomerSpreadKeyNumber,
  SIGNATURE_SPECS,
  type ActiveSignatureKind,
  type CbbUnderConcentrationSignature,
  type CustomerSportMix,
  type CustomerTotals,
  type EnrichedTicketMaster,
  type FigureDateWagerRow,
  type FootballKeyNumberDisciplineSignature,
  type HalfPointBuysSignature,
  type InPlayActivitySignature,
  type NormalizedObservationTicket,
  type PostHalftimeActivitySignature,
  type PreMoveBettingSignature,
  type RankedSignatureEntry,
  type SecondHalfConcentrationSignature,
  type Signature,
  type SignatureSpec,
  type SignatureThresholds,
  type WagerTiming,
};

export {
  batchRateCustomers,
  computeBayesianSkillProfile,
  computeClvSignificance,
  computeKellyMetrics,
  formatCustomerRatingMarkdown,
  rateCustomerFromObservations,
  rateCustomerFromTickets,
  rateIncomingWager,
  renderCustomerRatingAnsi,
  type BayesianSkillProfile,
  type ClvStatisticalSignificance,
  type CustomerComponentScores,
  type CustomerRating,
  type CustomerRiskLevel,
  type CustomerSharpnessTier,
  type KellySizingMetrics,
  type RatedIncomingWager,
  type RatingAction,
} from "./customer_rating.ts";

export {
  buildComprehensiveCustomerProfile,
  buildCorrelatedParlayProfile,
  buildDeskActionDirectives,
  buildMarketSpecializationProfile,
  buildPortfolioRiskForensics,
  buildStakeDistributionProfile,
  buildSyndicateClusterProfile,
  buildTimingFingerprintProfile,
  computeSharpnessCompositeIndex,
  computeStakeGini,
  enrichSyndicateWithIpClassification,
  evaluateIncomingTickerProfiling,
  formatComprehensiveProfileAnsi,
  formatComprehensiveProfileMarkdown,
  renderComprehensiveProfileAnsi,
  type CompositeSharpnessTier,
  type ComprehensiveCustomerProfile,
  type CorrelatedExploitType,
  type CorrelatedParlayLeg,
  type CorrelatedParlayProfile,
  type CorrelatedWagerGroup,
  type DeskActionDirectives,
  type MarketSpecializationProfile,
  type PortfolioRiskForensics,
  type RealtimeTickerProfilingAlert,
  type SharpnessCompositeIndex,
  type StakeDistributionProfile,
  type StakeSizingStrategy,
  type SyndicateClusterProfile,
  type TimingArchetype,
  type TimingFingerprintProfile,
} from "./customer_profiling_enhanced.ts";

export type Channel = "GSLIVE" | "GSBUILDER" | "Internet" | string;

/**
 * Deterministic, locale-independent integer formatter (ASCII `,` thousands separator).
 * Avoids `Number.prototype.toLocaleString`, whose output varies by ICU locale (`956,931` vs
 * `956.931` vs `956\u202f931`) and breaks snapshot/diff pipelines.
 */
export const fmtInt = (v: number): string => {
  if (!Number.isFinite(v)) return "n/a";
  const n = Math.round(v);
  return (
    (n < 0 ? "-" : "") +
    Math.abs(n)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  );
};

/**
 * Deterministic USD formatter with leading sign (`-$1,234`, never `$-1,234`).
 */
export const fmtUsd = (v: number): string => {
  if (!Number.isFinite(v)) return "n/a";
  const n = Math.round(v);
  return (n < 0 ? "-$" : "$") + fmtInt(Math.abs(n));
};

/**
 * Deterministic cents formatter (`+12.4¢`, `-3.5¢`, `+0.0¢` with `-0` normalized).
 */
export const fmtCents = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const n = Object.is(v, -0) ? 0 : v;
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "¢";
};

/** Parse a customer-profile XML document with Bun's native parser (compact shape). */
export function parseCustomerProfileXml(
  input: string | Uint8Array,
): Bun.XML.Document {
  return Bun.XML.parse(input);
}

/** Parse a customer-performance XML document with Bun's native parser (compact shape). */
export function parseCustomerPerformanceXml(
  input: string | Uint8Array,
): Bun.XML.Document {
  return Bun.XML.parse(input);
}

/** Parse a transactions XML document with Bun's native parser (compact shape). */
export function parseTransactionsXml(
  input: string | Uint8Array,
): Bun.XML.Document {
  return Bun.XML.parse(input);
}

/** Parse an AJAX-delivered XML response with Bun's native parser (compact shape). */
export function parseAjaxXml(input: string | Uint8Array): Bun.XML.Document {
  return Bun.XML.parse(input);
}

/** Parse a Fantasy402 AJAX XML response with Bun's native parser (compact shape). */
export function parseFantasy402AjaxXml(
  input: string | Uint8Array,
): Bun.XML.Document {
  return Bun.XML.parse(input);
}

/** Unwrap Bun.XML compact one-or-many values into a string (or null). */
function xmlText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return v.length ? xmlText(v[0]) : null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#text" in o) return xmlText(o["#text"]);
    return null;
  }
  return String(v).trim() || null;
}

/** Map a customer-profile XML document onto a CustomerRow (best-effort, field names are loose). */
export function customerRowFromXml(input: string | Uint8Array): CustomerRow {
  const doc = parseCustomerProfileXml(input) as Record<string, unknown>;
  // Accept <profile>, <customer>, or a bare root.
  const root = (doc.profile ??
    doc.customer ??
    doc.Customer ??
    doc.Profile ??
    doc) as Record<string, unknown>;
  const get = (k: string) => xmlText(root[k] ?? root[`@${k}`]);
  const numAttr = (k: string) => {
    const t = get(k);
    if (t === null) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    customer_id: get("customer_id") ?? get("id") ?? get("customerId") ?? "",
    ...((get("agent_id") ?? get("agentId"))
      ? { agent_id: get("agent_id") ?? get("agentId") ?? undefined }
      : {}),
    ...((get("master_agent") ?? get("masterAgent"))
      ? { master_agent: get("master_agent") ?? get("masterAgent") ?? undefined }
      : {}),
    ...(get("status") ? { status: get("status") ?? undefined } : {}),
    ...((numAttr("wager_limit_usd") ?? numAttr("wagerLimit"))
      ? { wager_limit_usd: numAttr("wager_limit_usd") ?? numAttr("wagerLimit") }
      : {}),
    ...((numAttr("lifetime_volume_usd") ?? numAttr("volume"))
      ? {
          lifetime_volume_usd:
            numAttr("lifetime_volume_usd") ?? numAttr("volume"),
        }
      : {}),
    ...((numAttr("lifetime_net_usd") ?? numAttr("net"))
      ? { lifetime_net_usd: numAttr("lifetime_net_usd") ?? numAttr("net") }
      : {}),
    ...((numAttr("hold_pct") ?? numAttr("holdPct"))
      ? { hold_pct: numAttr("hold_pct") ?? numAttr("holdPct") }
      : {}),
  } as CustomerRow;
}

export interface TicketRow {
  readonly wager_number?: number | string;
  readonly league?: string;
  readonly market?: string;
  readonly selection?: string;
  readonly risk_usd?: number;
  readonly win_usd?: number;
  readonly result?: string;
  readonly net_usd?: number;
  readonly channel?: string;
  readonly placed_at?: string;
}

export interface CustomerRow {
  readonly customer_id: string;
  readonly agent_id?: string;
  readonly master_agent?: string;
  readonly context_type?: string;
  readonly status?: string;
  readonly wager_limit_usd?: number;
  readonly delay_seconds?: number;
  readonly ip_subnet?: string;
  readonly lifetime_volume_usd?: number;
  readonly lifetime_net_usd?: number;
  readonly hold_pct?: number;
  readonly sports_7d_volume_usd?: number;
  readonly sports_7d_net_usd?: number;
  readonly clv_bps?: number;
  readonly sharp_score?: number;
  readonly churn_hazard?: number;
  readonly churn_mode?: string;
  readonly recent_tickets?: readonly TicketRow[];
}

export interface Bucket {
  readonly n: number;
  readonly riskUsd: number;
  readonly netUsd: number;
}

export interface TicketSummary {
  /** The window these rows cover. Five rows per customer, so this is a sample, not a history. */
  readonly window: "recent-sample";
  readonly sampleOnly: true;
  readonly n: number;
  readonly voids: number;
  readonly riskUsd: number;
  readonly netUsd: number;
  /** Win rate over settled rows (voids excluded), 0–1, `null` when nothing settled. */
  readonly winRate: number | null;
  /** `net / risk`, the customer's hold on this sample. `null` when nothing was risked. */
  readonly holdPct: number | null;
  readonly byLeague: Readonly<Record<string, Bucket>>;
  readonly byMarket: Readonly<Record<string, Bucket>>;
  readonly byChannel: Readonly<Record<string, Bucket>>;
}

export interface Placement {
  readonly inTree: boolean;
  readonly depth: number | null;
  readonly level: number | null;
  /** Ancestor logins, root first, excluding the customer's own agent. */
  readonly chain: readonly string[];
  readonly office: string | null;
  readonly store: string | null;
}

export interface CustomerProfile {
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly status: string;
  readonly contextType: string;
  readonly book: {
    readonly lifetimeVolumeUsd: number;
    readonly lifetimeNetUsd: number;
    readonly holdPct: number;
    readonly sports7dVolumeUsd: number;
    readonly sports7dNetUsd: number;
    readonly clvBps: number;
    readonly sharpScore: number;
    readonly churnHazard: number;
    readonly churnMode: string;
    readonly wagerLimitUsd: number;
    readonly delaySeconds: number;
    readonly ipSubnet: string;
  };
  readonly tickets: TicketSummary;
  readonly placement: Placement;
  /** Data-quality notes that change how a number should be read. */
  readonly flags: readonly string[];
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const key = (value: unknown): string => text(value).toUpperCase();

function addBucket(
  buckets: Record<string, { n: number; riskUsd: number; netUsd: number }>,
  bucket: string,
  risk: number,
  net: number,
): void {
  const current = buckets[bucket] ?? { n: 0, riskUsd: 0, netUsd: 0 };
  current.n += 1;
  current.riskUsd += risk;
  current.netUsd += net;
  buckets[bucket] = current;
}

export function summarizeTickets(tickets: readonly TicketRow[]): TicketSummary {
  let riskUsd = 0;
  let netUsd = 0;
  let voids = 0;
  let wins = 0;
  let settled = 0;
  const byLeague: Record<string, Bucket> = {};
  const byMarket: Record<string, Bucket> = {};
  const byChannel: Record<string, Bucket> = {};

  for (const ticket of tickets) {
    const risk = num(ticket.risk_usd);
    const net = num(ticket.net_usd);
    const result = key(ticket.result);
    const isVoid = result === "VOID";
    riskUsd += risk;
    netUsd += net;
    if (isVoid) voids += 1;
    else {
      settled += 1;
      if (result === "WIN") wins += 1;
    }
    addBucket(byLeague, key(ticket.league) || "UNKNOWN", risk, net);
    addBucket(byMarket, key(ticket.market) || "UNKNOWN", risk, net);
    addBucket(byChannel, text(ticket.channel) || "unknown", risk, net);
  }

  return {
    window: "recent-sample",
    sampleOnly: true,
    n: tickets.length,
    voids,
    riskUsd,
    netUsd,
    winRate: settled === 0 ? null : wins / settled,
    holdPct: riskUsd === 0 ? null : (netUsd / riskUsd) * 100,
    byLeague,
    byMarket,
    byChannel,
  };
}

export interface TreeIndex {
  /** login → { parent, level } as stored in data/agent-tree.json. */
  readonly nodes: Readonly<
    Record<string, { readonly p?: string | null; readonly l?: number | null }>
  >;
}

/** Walks the parent chain, capped, so a malformed tree cannot hang a profile build. */
export function placementOf(login: string, tree: TreeIndex): Placement {
  const start = key(login);
  const node = tree.nodes[start];
  if (node === undefined) {
    return {
      inTree: false,
      depth: null,
      level: null,
      chain: [],
      office: null,
      store: null,
    };
  }
  const chain: string[] = [];
  const seen = new Set<string>([start]);
  let current = key(node.p ?? "");
  while (current !== "" && chain.length < 64) {
    if (seen.has(current)) {
      chain.push(`${current} (cycle)`);
      break;
    }
    seen.add(current);
    chain.push(current);
    current = key(tree.nodes[current]?.p ?? "");
  }
  return {
    inTree: true,
    // Depth from the root, counting edges: a chain of N ancestors means depth N.
    depth: chain.length,
    level: typeof node.l === "number" ? node.l : null,
    chain,
    office: null,
    store: null,
  };
}

export function buildCustomerProfile(
  row: CustomerRow,
  tree: TreeIndex,
): CustomerProfile {
  const tickets = summarizeTickets(row.recent_tickets ?? []);
  const agentId = text(row.agent_id);
  const placement = placementOf(agentId, tree);
  const flags: string[] = [];

  if (!placement.inTree) {
    flags.push(`agent ${agentId || "(none)"} is not in the tree`);
  }
  if (tickets.n === 0) flags.push("no ticket sample");
  if (tickets.n > 0 && tickets.voids / tickets.n > 0.2) {
    flags.push(`${tickets.voids}/${tickets.n} tickets voided`);
  }
  const lifetime = num(row.lifetime_net_usd);
  // A five-ticket sample that points the other way is not a contradiction, but it changes how the
  // lifetime number should be read, so it is surfaced rather than smoothed over.
  if (
    lifetime !== 0 &&
    tickets.netUsd !== 0 &&
    Math.sign(lifetime) !== Math.sign(tickets.netUsd)
  ) {
    flags.push("recent sample runs opposite to the lifetime net");
  }

  return {
    customerId: text(row.customer_id),
    agentId,
    masterAgent: text(row.master_agent),
    status: text(row.status),
    contextType: text(row.context_type),
    book: {
      lifetimeVolumeUsd: num(row.lifetime_volume_usd),
      lifetimeNetUsd: lifetime,
      holdPct: num(row.hold_pct),
      sports7dVolumeUsd: num(row.sports_7d_volume_usd),
      sports7dNetUsd: num(row.sports_7d_net_usd),
      clvBps: num(row.clv_bps),
      sharpScore: num(row.sharp_score),
      churnHazard: num(row.churn_hazard),
      churnMode: text(row.churn_mode),
      wagerLimitUsd: num(row.wager_limit_usd),
      delaySeconds: num(row.delay_seconds),
      ipSubnet: text(row.ip_subnet),
    },
    tickets,
    placement,
    flags,
  };
}

export interface PortfolioSummary {
  readonly customers: number;
  readonly tickets: number;
  readonly lifetimeNetUsd: number;
  readonly sampleNetUsd: number;
  readonly sampleRiskUsd: number;
  readonly byLeague: Readonly<Record<string, Bucket>>;
  readonly byMarket: Readonly<Record<string, Bucket>>;
  readonly byChannel: Readonly<Record<string, Bucket>>;
  readonly notInTree: readonly string[];
  /** Highest `sharp_score` first. */
  readonly sharpest: readonly {
    customerId: string;
    sharpScore: number;
    clvBps: number;
  }[];
  /** Most negative sample net first — the customers whose recent tickets cost the book most. */
  readonly worstRecent: readonly { customerId: string; netUsd: number }[];
}

export function buildCustomerProfiles(
  rows: readonly CustomerRow[],
  tree: TreeIndex,
): { profiles: readonly CustomerProfile[]; summary: PortfolioSummary } {
  const profiles = rows.map((row) => buildCustomerProfile(row, tree));

  const byLeague: Record<string, Bucket> = {};
  const byMarket: Record<string, Bucket> = {};
  const byChannel: Record<string, Bucket> = {};
  const addMany = (
    target: Record<string, Bucket>,
    source: Record<string, Bucket>,
  ) => {
    for (const [bucket, value] of Object.entries(source)) {
      const current = target[bucket] ?? { n: 0, riskUsd: 0, netUsd: 0 };
      target[bucket] = {
        n: current.n + value.n,
        riskUsd: current.riskUsd + value.riskUsd,
        netUsd: current.netUsd + value.netUsd,
      };
    }
  };
  for (const profile of profiles) {
    addMany(byLeague, profile.tickets.byLeague);
    addMany(byMarket, profile.tickets.byMarket);
    addMany(byChannel, profile.tickets.byChannel);
  }

  const summary: PortfolioSummary = {
    customers: profiles.length,
    tickets: profiles.reduce((n, profile) => n + profile.tickets.n, 0),
    lifetimeNetUsd: profiles.reduce((n, p) => n + p.book.lifetimeNetUsd, 0),
    sampleNetUsd: profiles.reduce((n, p) => n + p.tickets.netUsd, 0),
    sampleRiskUsd: profiles.reduce((n, p) => n + p.tickets.riskUsd, 0),
    byLeague,
    byMarket,
    byChannel,
    notInTree: profiles
      .filter((profile) => !profile.placement.inTree)
      // Normalised: a padded or lower-case login would otherwise appear twice in the list.
      .map((profile) => key(profile.agentId))
      .filter(
        (agent, index, all) => agent !== "" && all.indexOf(agent) === index,
      )
      .sort(),
    sharpest: [...profiles]
      .sort((a, b) => b.book.sharpScore - a.book.sharpScore)
      .slice(0, 10)
      .map((profile) => ({
        customerId: profile.customerId,
        sharpScore: profile.book.sharpScore,
        clvBps: profile.book.clvBps,
      })),
    worstRecent: [...profiles]
      .filter((profile) => profile.tickets.netUsd !== 0)
      .sort((a, b) => a.tickets.netUsd - b.tickets.netUsd)
      .slice(0, 10)
      .map((profile) => ({
        customerId: profile.customerId,
        netUsd: profile.tickets.netUsd,
      })),
  };

  return { profiles, summary };
}

/* -------------------------------------------------------------------------- */
/* CustomerObservations (S1..S5, M2, M3, M9) & Signature Pipeline (Stage 4.2) */
/* -------------------------------------------------------------------------- */

function formatSignatureLine(sig: Signature): string {
  switch (sig.kind) {
    case "cbb_under_concentration": {
      const pct = ((sig.underCount / sig.cbbTotalCount) * 100).toFixed(0);
      return `  • cbb_under_concentration: ${fmtInt(sig.underCount)}/${fmtInt(sig.cbbTotalCount)} (${pct}%) CBB totals on Under`;
    }
    case "football_key_number_discipline": {
      const pct = ((sig.onKey / sig.totalSpread) * 100).toFixed(0);
      return `  • football_key_number_discipline: ${fmtInt(sig.onKey)}/${fmtInt(sig.totalSpread)} (${pct}%) on key numbers (3:${fmtInt(sig.onKey3)}, 7:${fmtInt(sig.onKey7)})`;
    }
    case "half_point_buys":
      return `  • half_point_buys: ${fmtInt(sig.buyCount)} buys, ${fmtInt(sig.keyNumberBuys)} at key numbers, avg price vs close: ${fmtCents(sig.avgPriceVsCloseCents)}`;
    case "in_play_activity": {
      const pct = ((sig.liveCount / sig.totalCount) * 100).toFixed(0);
      return `  • in_play_activity: ${fmtInt(sig.liveCount)}/${fmtInt(sig.totalCount)} (${pct}%) live [${sig.dominance}], live risk=${fmtUsd(sig.liveRiskUsd)}`;
    }
    case "post_halftime_activity": {
      const pct = ((sig.twoHalfCount / sig.totalCount) * 100).toFixed(0);
      return `  • post_halftime_activity: ${fmtInt(sig.twoHalfCount)}/${fmtInt(sig.totalCount)} (${pct}%) post-halftime${sig.reason ? ` [${sig.reason}]` : ""}`;
    }
    case "pre_move_betting":
      return `  • pre_move_betting: ${fmtInt(sig.moveCount)}/${fmtInt(sig.totalCount)} before move${sig.dominantTiming ? ` [${sig.dominantTiming}]` : ""}, avg price vs close: ${fmtCents(sig.avgPriceVsCloseCents)}`;
    case "second_half_concentration": {
      const pct = ((sig.twoHalfCount / sig.totalCount) * 100).toFixed(0);
      return `  • second_half_concentration: ${fmtInt(sig.twoHalfCount)}/${fmtInt(sig.totalCount)} (${pct}%) in 2H`;
    }
    default: {
      const _never: never = sig;
      throw new Error(`unhandled signature kind: ${JSON.stringify(_never)}`);
    }
  }
}

const DEFAULT_SPORT_MIX: CustomerSportMix = {
  footballPct: 0,
  basketballPct: 0,
  otherPct: 0,
};

/**
 * Evidence-only customer observation record with deterministic ASCII formatting (`fmtInt`,
 * `fmtUsd`, `fmtCents`), lexicographic signature ordering, zero-evidence guards, sport/family
 * descriptors (`sportMix`, `competitionFamilyMix`), and `[Bun.inspect.custom]` class method.
 */
export class CustomerObservations {
  constructor(
    public readonly customerId: string,
    public readonly nTickets: number,
    public readonly totalRiskUsd: number,
    public readonly netUsd: number,
    public readonly signatures: readonly Signature[],
    public readonly firstSeen: string,
    public readonly lastSeen: string,
    public readonly sportMix: CustomerSportMix = DEFAULT_SPORT_MIX,
    public readonly competitionFamilyMix: Readonly<Record<string, number>> = {},
  ) {
    for (let i = 1; i < signatures.length; i++) {
      const prev = signatures[i - 1]!;
      const curr = signatures[i]!;
      if (prev.kind >= curr.kind) {
        throw new Error(`signatures not sorted: ${prev.kind} >= ${curr.kind}`);
      }
    }

    for (const sig of signatures) {
      switch (sig.kind) {
        case "cbb_under_concentration":
          if (sig.underCount <= 0 || sig.cbbTotalCount <= 0) {
            throw new Error("cbb_under_concentration requires counts > 0");
          }
          break;
        case "football_key_number_discipline":
          if (sig.onKey <= 0 || sig.totalSpread <= 0) {
            throw new Error(
              "football_key_number_discipline requires counts > 0",
            );
          }
          break;
        case "half_point_buys":
          if (sig.buyCount <= 0) {
            throw new Error("half_point_buys requires buyCount > 0");
          }
          break;
        case "in_play_activity":
          if (sig.liveCount <= 0 || sig.totalCount <= 0) {
            throw new Error("in_play_activity requires counts > 0");
          }
          break;
        case "post_halftime_activity":
          if (sig.twoHalfCount <= 0 || sig.totalCount <= 0) {
            throw new Error("post_halftime_activity requires counts > 0");
          }
          break;
        case "pre_move_betting":
          if (sig.moveCount <= 0 || sig.totalCount <= 0) {
            throw new Error("pre_move_betting requires counts > 0");
          }
          break;
        case "second_half_concentration":
          if (sig.twoHalfCount <= 0 || sig.totalCount <= 0) {
            throw new Error("second_half_concentration requires counts > 0");
          }
          break;
        default: {
          const _never: never = sig;
          throw new Error(
            `unhandled signature kind: ${JSON.stringify(_never)}`,
          );
        }
      }
    }
  }

  [Bun.inspect.custom](depth: number = 0, options?: BunInspectOptions): string {
    const c = options?.colors === true;
    const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
    const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[22m` : s);

    if (depth <= 0) {
      return `CustomerObservations(${bold(this.customerId)}, N=${fmtInt(this.nTickets)})`;
    }

    const header =
      `${bold(this.customerId)} N=${fmtInt(this.nTickets)} ` +
      `risk=${fmtUsd(this.totalRiskUsd)} ` +
      `net=${fmtUsd(this.netUsd)} ` +
      `${dim(`(${this.firstSeen}..${this.lastSeen})`)}`;

    if (this.signatures.length === 0) {
      return header;
    }

    const sigLines: string[] = [];
    for (const sig of this.signatures) {
      sigLines.push(formatSignatureLine(sig));
    }
    return [header, ...sigLines].join("\n");
  }
}

export interface SignatureBuckets {
  readonly cbb_under_concentration: readonly RankedSignatureEntry<"cbb_under_concentration">[];
  readonly football_key_number_discipline: readonly RankedSignatureEntry<"football_key_number_discipline">[];
  readonly in_play_activity: readonly RankedSignatureEntry<"in_play_activity">[];
  readonly post_halftime_activity: readonly RankedSignatureEntry<"post_halftime_activity">[];
  readonly pre_move_betting: readonly RankedSignatureEntry<"pre_move_betting">[];
  /** @deprecated Retired in favor of `football_key_number_discipline`. */
  readonly half_point_buys: readonly RankedSignatureEntry<"half_point_buys">[];
  /** @deprecated Renamed to `post_halftime_activity`. */
  readonly second_half_concentration: readonly RankedSignatureEntry<"second_half_concentration">[];
}

export interface CustomerSignaturePipelineResult {
  readonly observations: ReadonlyMap<string, CustomerObservations>;
  readonly bySignature: SignatureBuckets;
}

const GSLIVE_SID_TO_SPORT: Readonly<Record<string, string>> = {
  "1": "Baseball",
  "26": "Baseball",
  "37": "Baseball",
  "2": "Basketball",
  "24": "Basketball",
  "36": "Basketball",
  "102": "Basketball",
  "131": "Basketball",
  "3": "Football",
  "33": "Football",
  "60": "Football",
  "201": "Football",
  "203": "Football",
  "217": "Football",
  "4": "Hockey",
  "25": "Hockey",
  "64": "Hockey",
  "202": "Hockey",
  "216": "Hockey",
  "5": "Soccer",
  "14": "Soccer",
  "15": "Soccer",
  "55": "Soccer",
  "119": "Soccer",
  "123": "Soccer",
  "214": "Soccer",
  "220": "Soccer",
  "264": "Soccer",
  "6": "Martial Arts",
  "13": "Martial Arts",
  "27": "Martial Arts",
  "107": "Martial Arts",
  "127": "Martial Arts",
  "7": "Golf",
  "53": "Golf",
  "8": "Tennis",
  "63": "Tennis",
};

const GSLIVE_LID_TO_FAMILY: Readonly<Record<string, string>> = {
  // Football
  "4": "NFL",
  "473": "NFL",
  "540": "NFL",
  "5": "NCAAF",
  "37": "NCAAF",
  "576": "NCAAF",
  "20701": "NCAAF",
  // Basketball
  "6": "NBA",
  "2": "NBA",
  "391": "NBA",
  "11": "WNBA",
  "7": "NCAAB",
  "878": "NCAAB",
  "882": "NCAAB",
  // Baseball
  "8": "MLB",
  "423": "MLB",
  "424": "MLB",
  "9": "NCAAB",
  // Hockey
  "10": "NHL",
  "18": "NCAAH",
  // Tennis
  "359": "ATP",
  "386": "ATP",
  "578": "ATP",
  "354": "WTA",
  "402": "WTA",
  "577": "WTA",
  "604": "WTA",
};

/**
 * Normalizes an F402 timestamp string (from `InsertDateTime`, `AcceptedDateTime`, or `GameDateTime`)
 * to UTC ISO-8601 (`"YYYY-MM-DDTHH:MM:SS.sssZ"`).
 *
 * Wire timestamps without timezone offset are in Eastern Time (`America/New_York`).
 * We delegate to `portalIso` to ensure DST-aware offset resolution without clock skew.
 */
export function parseF402TimestampToIso(rawVal: unknown): string | null {
  return portalIso(rawVal);
}

/**
 * Normalizes customer login IDs to group sub-accounts (e.g. `BK119_0` -> `BK119`).
 */
export function normalizeCustomerId(rawId: string): string {
  return rawId.trim().toUpperCase().replace(/_\d+$/, "");
}

function classifyWagerTiming(
  sport: string,
  canonicalPeriod: string,
  elapsedMin: number | null,
  isGslive: boolean,
): WagerTiming {
  // Window guard: bets placed > 5 minutes before scheduled start are pregame (even on GSLive or postponed games)
  if (elapsedMin !== null && elapsedMin < -5) {
    return "pregame";
  }
  const isPostStart = isGslive || (elapsedMin !== null && elapsedMin >= -5);
  if (!isPostStart) {
    return "pregame";
  }
  // Halftime window: explicit 2H period bet placed after kickoff/tipoff, or in-play bet placed during halftime intermission
  if (
    canonicalPeriod === "2h" &&
    elapsedMin !== null &&
    ((sport === "Football" && elapsedMin >= 40 && elapsedMin <= 70) ||
      (sport === "Basketball" && elapsedMin >= 18 && elapsedMin <= 40) ||
      (!isGslive && elapsedMin >= 0))
  ) {
    return "halftime";
  }
  if (
    elapsedMin !== null &&
    ((sport === "Football" && elapsedMin >= 45 && elapsedMin <= 60) ||
      (sport === "Basketball" && elapsedMin >= 22 && elapsedMin <= 35))
  ) {
    return "halftime";
  }
  return "in_play";
}

function normalizeGsliveBetReportRow(
  record: Record<string, unknown>,
): NormalizedObservationTicket {
  const sid = text(record["sID"]);
  const lid = text(record["lID"]);
  const sport = GSLIVE_SID_TO_SPORT[sid] ?? "Other";
  const competitionFamily =
    GSLIVE_LID_TO_FAMILY[lid] ??
    (sid === "102"
      ? "NCAAB"
      : sport === "Soccer"
        ? "SOCCER"
        : sport === "Martial Arts"
          ? "UFC"
          : "");
  const canonicalPeriod = normalizeCanonicalPeriod(
    record["period"] as string | number | null | undefined,
  );

  let marketKind: NormalizedObservationTicket["marketKind"] = "other";
  let side: NormalizedObservationTicket["side"] = "other";
  let adjSpread: number | null = null;
  const rawDetails = record["betDetails"];
  if (typeof rawDetails === "string" && rawDetails.startsWith("{")) {
    try {
      const bd = JSON.parse(rawDetails) as Record<string, unknown>;
      const m = Number(bd["m"]);
      const sk = Number(bd["sk"]);
      const k = Number(bd["k"]);
      if (m === 5) {
        marketKind = "total";
        side = sk === 2 ? "under" : sk === 1 ? "over" : "other";
        if (Number.isFinite(k)) adjSpread = k;
      } else if (m === 6) {
        marketKind = "spread";
        side = sk === 1 ? "home" : sk === 2 ? "away" : "other";
        if (Number.isFinite(k)) adjSpread = k;
      } else if (m === 1 || m === 3) {
        marketKind = "moneyline";
      }
    } catch {
      /* ignore malformed betDetails */
    }
  }

  const rawPriceVsClose = record["priceVsCloseCents"];
  let priceVsCloseCents: number | null =
    typeof rawPriceVsClose === "number" && Number.isFinite(rawPriceVsClose)
      ? rawPriceVsClose
      : null;
  const rawMoved = record["movedInFavor"];
  let movedInFavor: boolean | null =
    typeof rawMoved === "boolean" ? rawMoved : null;

  if (priceVsCloseCents === null) {
    const f1 = Number(record["fVal"]);
    const f2 = Number(record["fVal_new"]);
    if (
      Number.isFinite(f1) &&
      Number.isFinite(f2) &&
      f1 > 1 &&
      f2 > 1 &&
      f1 !== f2
    ) {
      // Positive = placed odds (f1) were better than post-delay acceptance odds (f2).
      priceVsCloseCents = (1 / f2 - 1 / f1) * 100;
      movedInFavor = priceVsCloseCents > 0;
    }
  }

  const riskUsd = Number(record["bet"]) || 0;
  const parentSettled = record["betGroupResult"];
  const netUsd =
    parentSettled !== null &&
    parentSettled !== undefined &&
    String(parentSettled).trim() !== ""
      ? Number(parentSettled) || 0
      : Number(record["result"]) || 0;
  const logSec = Number(record["logTime"]);
  const startSec = Number(record["eventStartTime"]);
  const elapsedMin =
    Number.isFinite(logSec) &&
    Number.isFinite(startSec) &&
    logSec > 0 &&
    startSec > 0
      ? Math.round(((logSec - startSec) / 60) * 100) / 100
      : null;
  const [fbLo, fbHi] = DEFAULT_THRESHOLDS.postHalftime.footballInPlayWindowMin;
  const [bkLo, bkHi] =
    DEFAULT_THRESHOLDS.postHalftime.basketballInPlayWindowMin;
  const placedIn2HWindow =
    elapsedMin !== null &&
    ((sport === "Football" && elapsedMin >= fbLo && elapsedMin <= fbHi) ||
      (sport === "Basketball" && elapsedMin >= bkLo && elapsedMin <= bkHi));

  const placedAtIso =
    Number.isFinite(logSec) && logSec > 0
      ? new Date(logSec * 1000).toISOString()
      : "1970-01-01T00:00:00.000Z";
  const eventStartsAtIso =
    Number.isFinite(startSec) && startSec > 0
      ? new Date(startSec * 1000).toISOString()
      : null;
  const placedAtYmd = placedAtIso.slice(0, 10);
  const timing = classifyWagerTiming(sport, canonicalPeriod, elapsedMin, true);

  const betGroupId = text(record["betGroupId"]);
  const ticketNumber = text(record["ticketNumber"] ?? record["id"]);
  const wagerGroupKey =
    betGroupId !== ""
      ? `GSLIVE:${betGroupId}`
      : ticketNumber !== ""
        ? `GSLIVE:${ticketNumber}`
        : undefined;

  return {
    ticketNumber,
    ...(wagerGroupKey !== undefined ? { wagerGroupKey } : {}),
    customerId: normalizeCustomerId(
      text(record["partnerUserID"] ?? record["userID"]),
    ),
    agentId: text(record["agent"]).toUpperCase(),
    placedAtYmd,
    placedAt: placedAtIso,
    eventStartsAt: eventStartsAtIso,
    timing,
    sport,
    competitionFamily,
    canonicalPeriod,
    elapsedMinutesFromStart: elapsedMin,
    placedIn2HWindow,
    marketKind,
    side,
    origSpread: adjSpread,
    adjSpread,
    buyPoints: 0,
    touchedKeyNumber: null,
    priceVsCloseCents,
    movedInFavor,
    riskUsd,
    netUsd,
  };
}

/**
 * Normalizes a raw wager row (F402 `Report/Pending`, Figure Date, Live Ticker, or GSLive
 * `getBetReport`) into `NormalizedObservationTicket` (Stage 1).
 */
export function normalizeObservationTicket(
  rawRow: FigureDateWagerRow | Record<string, unknown>,
): NormalizedObservationTicket {
  const record = rawRow as Record<string, unknown>;
  if (
    record["partnerUserID"] !== undefined &&
    record["sID"] !== undefined &&
    record["CustomerID"] === undefined &&
    record["customerID"] === undefined
  ) {
    return normalizeGsliveBetReportRow(record);
  }

  const enriched = enrichTicketWithBuyPoints(record);

  let rawSportType = enriched.sportType || text(record["SportType"]);
  let rawSportSubType = enriched.sportSubType || text(record["SportSubType"]);
  let rawPeriodDesc: unknown =
    enriched.periodDescription ||
    record["PeriodDescription"] ||
    record["PeriodNumber"];

  if (rawSportType === "" && isPendingBlobRow(record)) {
    const blob = parsePendingBlobDescription(
      record["Description"] ?? record["ShortDesc"],
      text(record["WagerType"]),
    );
    if (blob !== null) {
      rawSportType = blob.sport;
      rawSportSubType = blob.subSport ?? blob.market;
      rawPeriodDesc = blob.period;
    }
  }

  const sport = sportCategoryFor({
    sportType: rawSportType,
    sportSubType: rawSportSubType,
  });
  const { competitionFamily } = competitionFamilyFromDirectory(
    sport !== "Other" ? sport : rawSportType || null,
    rawSportSubType || null,
  );

  // When PeriodDescription is explicitly present (e.g. "2nd Half"), prefer it over PeriodNumber;
  // when PeriodDescription is blank on a structured row, use PeriodNumber (`2` -> `2h`, etc.).
  const explicitPeriodDesc = text(record["PeriodDescription"]);
  const periodInput =
    explicitPeriodDesc !== ""
      ? explicitPeriodDesc
      : record["PeriodNumber"] !== undefined &&
          record["PeriodNumber"] !== null &&
          Number(record["PeriodNumber"]) > 0
        ? record["PeriodNumber"]
        : rawPeriodDesc;
  const canonicalPeriod = normalizeCanonicalPeriod(
    typeof periodInput === "string" || typeof periodInput === "number"
      ? periodInput
      : undefined,
  );

  // Structured LegWagerType ("S" = spread, "L" = total, "M" = moneyline) takes precedence over
  // multi-leg parlay Description regex so leg 2+ is never misclassified as leg 1's marketKind.
  // Note: "derivative_points" (WagerType "E", alt-lines, team totals) intentionally maps to "other"
  // to preserve game-spread purity in football_key_number_discipline.
  const legWt = text(record["LegWagerType"]).toUpperCase();
  const wagerWt = text(record["WagerType"]).toUpperCase();
  const marketKind: NormalizedObservationTicket["marketKind"] =
    legWt === "S"
      ? "spread"
      : legWt === "L"
        ? "total"
        : legWt === "M"
          ? "moneyline"
          : wagerWt === "S" && enriched.adjSpread !== null
            ? "spread"
            : wagerWt === "L"
              ? "total"
              : wagerWt === "M"
                ? "moneyline"
                : enriched.marketKind;

  const totalOu = text(record["TotalPointsOU"]).toUpperCase();
  let side: NormalizedObservationTicket["side"] = "other";
  if (marketKind === "total") {
    if (totalOu === "U") side = "under";
    else if (totalOu === "O") side = "over";
    else if (/\b(?:Under|U)\s+\d/i.test(enriched.shortDesc)) side = "under";
    else if (/\b(?:Over|O)\s+\d/i.test(enriched.shortDesc)) side = "over";
  }

  const keyCheck = isKeyNumberBuy(enriched.adjSpread, enriched.buyPoints);

  const rawPriceVsClose = record["priceVsCloseCents"];
  const priceVsCloseCents =
    typeof rawPriceVsClose === "number" && Number.isFinite(rawPriceVsClose)
      ? rawPriceVsClose
      : null;
  const rawMovedInFavor = record["movedInFavor"];
  const movedInFavor =
    typeof rawMovedInFavor === "boolean" ? rawMovedInFavor : null;

  // `Report/Pending` rows carry `PlayNumber` + `WagerStatus` and store `AmountWagered` in cents.
  const isPendingCentsSchema =
    record["PlayNumber"] !== undefined && record["WagerStatus"] !== undefined;
  const riskUsd = isPendingCentsSchema
    ? enriched.amountWageredUsd / 100
    : enriched.amountWageredUsd;

  const rawNet = record["netUsd"] ?? record["NetAmount"];
  const netUsd =
    typeof rawNet === "number" && Number.isFinite(rawNet) ? rawNet : 0;

  const placedAtIso =
    parseF402TimestampToIso(
      record["AcceptedDateTime"] ??
        record["InsertDateTime"] ??
        enriched.placedAt,
    ) ?? "1970-01-01T00:00:00.000Z";
  const eventStartsAtIso = parseF402TimestampToIso(record["GameDateTime"]);
  const placedAtYmd =
    enriched.placedAt.slice(0, 10) || placedAtIso.slice(0, 10) || "1970-01-01";

  const elapsedMin =
    placedAtIso !== "1970-01-01T00:00:00.000Z" && eventStartsAtIso !== null
      ? Math.round(
          ((Date.parse(placedAtIso) - Date.parse(eventStartsAtIso)) / 60000) *
            100,
        ) / 100
      : null;

  const isGsliveChannel =
    enriched.ticketWriter.toUpperCase() === "GSLIVE" ||
    text(record["PlacedOn"]).toUpperCase() === "GSLIVE";
  const timing = classifyWagerTiming(
    sport,
    canonicalPeriod,
    elapsedMin,
    isGsliveChannel,
  );
  const [fbLo, fbHi] = DEFAULT_THRESHOLDS.postHalftime.footballInPlayWindowMin;
  const [bkLo, bkHi] =
    DEFAULT_THRESHOLDS.postHalftime.basketballInPlayWindowMin;
  const placedIn2HWindow =
    elapsedMin !== null &&
    ((sport === "Football" && elapsedMin >= fbLo && elapsedMin <= fbHi) ||
      (sport === "Basketball" && elapsedMin >= bkLo && elapsedMin <= bkHi));

  const ticketNumber = enriched.TicketNumber || enriched.WagerNumber;
  const wagerGroupKey =
    record["TicketNumber"] !== undefined && record["WagerNumber"] !== undefined
      ? `F402:${String(record["TicketNumber"]).trim()}:${String(record["WagerNumber"]).trim()}`
      : undefined;

  return {
    ticketNumber,
    ...(wagerGroupKey !== undefined ? { wagerGroupKey } : {}),
    customerId: normalizeCustomerId(enriched.CustomerID),
    agentId: enriched.AgentID,
    placedAtYmd,
    placedAt: placedAtIso,
    eventStartsAt: eventStartsAtIso,
    timing,
    sport,
    competitionFamily: competitionFamily ?? "",
    canonicalPeriod,
    elapsedMinutesFromStart: elapsedMin,
    placedIn2HWindow,
    marketKind,
    side,
    origSpread: enriched.origSpread,
    adjSpread: enriched.adjSpread,
    buyPoints: enriched.buyPoints,
    touchedKeyNumber: keyCheck.key,
    priceVsCloseCents,
    movedInFavor,
    riskUsd,
    netUsd,
  };
}

/**
 * Converts American odds (`-110`, `+120`) to implied probability in cents (`0..100`).
 */
export function americanOddsToImpliedCents(odds: number): number | null {
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds < 0) {
    const abs = Math.abs(odds);
    return (abs / (abs + 100)) * 100;
  }
  return (100 / (odds + 100)) * 100;
}

/**
 * Normalizes a batch of raw wager rows and attaches closing/reference price deltas
 * (`priceVsCloseCents` and `movedInFavor`) with separate pregame vs. live reference windows:
 * 1. **F402 pregame rows**: Compared against the final pregame closing line on
 *    `F402:${rot1}:${canonicalPeriod}:${marketKind}:${sideKey}` (with numeric `Team1RotNum`
 *    stringification and base `-110` juice normalization on point-buy tickets).
 * 2. **GSLive in-play rows**: Never compared against full-game closes. Uses explicit
 *    acceptance-delay repricing (`fVal !== fVal_new`), or the latest wager on the exact same
 *    `GSLIVE:${eid}:${canonicalPeriod}:${m}:${sk}:${k}` within `liveReferenceWindowSec` (`60s`)
 *    after placement.
 */
export function normalizeObservationCorpus(
  rawRows: readonly (FigureDateWagerRow | Record<string, unknown>)[],
  liveReferenceWindowSec: number = DEFAULT_THRESHOLDS.preMove
    .liveReferenceWindowSec,
): NormalizedObservationTicket[] {
  const normalized = rawRows.map((row) => normalizeObservationTicket(row));

  interface PregameMarketPoint {
    readonly index: number;
    readonly timeKey: string;
    readonly line: number;
    readonly impliedCents: number;
  }

  interface LiveMarketPoint {
    readonly index: number;
    readonly logSec: number;
    readonly impliedCents: number;
  }

  const pregameGroups = new Map<string, PregameMarketPoint[]>();
  const liveGroups = new Map<string, LiveMarketPoint[]>();

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i] as Record<string, unknown>;
    const t = normalized[i]!;

    if (raw["partnerUserID"] !== undefined && raw["sID"] !== undefined) {
      // GSLive in-play row: collect all timestamped wagers on `(eid, period, m, sk, k)`
      // so rows without explicit `fVal !== fVal_new` can reference the latest wager within `liveReferenceWindowSec`.
      const eid = String(raw["eID"] ?? "").trim();
      if (eid === "") continue;
      let m = "";
      let sk = "";
      let kRaw = "";
      try {
        const bd = JSON.parse(String(raw["betDetails"] ?? "{}")) as Record<
          string,
          unknown
        >;
        m = String(bd["m"] ?? "");
        sk = String(bd["sk"] ?? "");
        kRaw = String(bd["k"] ?? "");
      } catch {
        continue;
      }
      const fVal = Number(raw["fVal"]);
      const logSec = Number(raw["logTime"]);
      if (!Number.isFinite(fVal) || fVal <= 1 || !Number.isFinite(logSec)) {
        continue;
      }
      const eventKey = `GSLIVE:${eid}:${t.canonicalPeriod}:${m}:${sk}:${kRaw}`;
      const point: LiveMarketPoint = {
        index: i,
        logSec,
        impliedCents: (1 / fVal) * 100,
      };
      const list = liveGroups.get(eventKey);
      if (list === undefined) liveGroups.set(eventKey, [point]);
      else list.push(point);
    } else {
      // F402 Pending / Ticker row: convert numeric Team1RotNum (`477`) via String(...)
      if (t.priceVsCloseCents !== null && t.movedInFavor !== null) continue;
      const rot1 = String(raw["Team1RotNum"] ?? "").trim();
      if (rot1 === "" || rot1 === "0") continue;
      const chosen = String(raw["ChosenTeamID"] ?? "").trim();
      const sideKey =
        t.marketKind === "total" ? t.side : chosen !== "" ? chosen : t.side;
      const eventKey = `F402:${rot1}:${t.canonicalPeriod}:${t.marketKind}:${sideKey}`;
      let line = 0;
      if (t.marketKind === "spread") {
        line = t.origSpread ?? t.adjSpread ?? 0;
      } else if (t.marketKind === "total") {
        const rawPts = Number(
          raw["OrigTotalPoints"] ?? raw["AdjTotalPoints"] ?? t.adjSpread ?? 0,
        );
        line = t.side === "over" ? -rawPts : rawPts;
      } else {
        line = 0;
      }
      // Strip the half-point purchase fee when comparing `origSpread` against pregame close
      const finalMoney = Number(raw["FinalMoney"]);
      const baseMoney =
        t.buyPoints > 0 && t.marketKind === "spread" ? -110 : finalMoney;
      const impliedCents = americanOddsToImpliedCents(baseMoney);
      if (impliedCents === null) continue;
      const timeKey = String(
        raw["AcceptedDateTime"] ??
          raw["InsertDateTime"] ??
          raw["TicketNumber"] ??
          i,
      ).trim();
      const point: PregameMarketPoint = {
        index: i,
        timeKey,
        line,
        impliedCents,
      };
      const list = pregameGroups.get(eventKey);
      if (list === undefined) pregameGroups.set(eventKey, [point]);
      else list.push(point);
    }
  }

  // 1. Evaluate F402 pregame closing-line deltas
  for (const points of pregameGroups.values()) {
    if (points.length < 2) continue;
    points.sort((a, b) =>
      a.timeKey < b.timeKey
        ? -1
        : a.timeKey > b.timeKey
          ? 1
          : a.index - b.index,
    );
    const closing = points[points.length - 1]!;
    for (let j = 0; j < points.length - 1; j++) {
      const pt = points[j]!;
      const lineDeltaPts = pt.line - closing.line;
      const priceDeltaCents = closing.impliedCents - pt.impliedCents;
      const totalEdgeCents =
        Math.round((lineDeltaPts * 8 + priceDeltaCents) * 100) / 100;
      if (pt.line === closing.line && Math.abs(priceDeltaCents) < 1e-6) {
        continue;
      }
      const prev = normalized[pt.index]!;
      normalized[pt.index] = {
        ...prev,
        priceVsCloseCents: prev.priceVsCloseCents ?? totalEdgeCents,
        movedInFavor: prev.movedInFavor ?? totalEdgeCents > 0,
      };
    }
  }

  // 2. Evaluate GSLive local-window (`<= liveReferenceWindowSec`) deltas for rows without `fVal !== fVal_new`
  for (const points of liveGroups.values()) {
    if (points.length < 2) continue;
    points.sort((a, b) =>
      a.logSec !== b.logSec ? a.logSec - b.logSec : a.index - b.index,
    );
    for (let j = 0; j < points.length - 1; j++) {
      const pt = points[j]!;
      const prev = normalized[pt.index]!;
      if (prev.priceVsCloseCents !== null && prev.movedInFavor !== null) {
        continue;
      }
      let localRef: LiveMarketPoint | null = null;
      for (let k = j + 1; k < points.length; k++) {
        const cand = points[k]!;
        if (cand.logSec - pt.logSec <= liveReferenceWindowSec) {
          localRef = cand;
        } else {
          break;
        }
      }
      if (localRef === null) continue;
      const priceDeltaCents =
        Math.round((localRef.impliedCents - pt.impliedCents) * 100) / 100;
      if (Math.abs(priceDeltaCents) < 1e-6) continue;
      normalized[pt.index] = {
        ...prev,
        priceVsCloseCents: priceDeltaCents,
        movedInFavor: priceDeltaCents > 0,
      };
    }
  }

  return normalized;
}

/**
 * Stage 4.2 pipeline: executes all 5 active `SIGNATURE_SPECS` per customer, deduplicates
 * `CustomerTotals` (`nTickets`, `totalRiskUsd`, `netUsd`) across multi-leg `wagerGroupKey`s,
 * computes `sportMix` and `competitionFamilyMix` descriptors on `CustomerObservations`, and
 * populates deterministically ranked `bySignature[K]` cohort buckets via `compareSignatures`.
 */
export function runCustomerSignaturePipeline(
  tickets: readonly NormalizedObservationTicket[],
  thresholds: SignatureThresholds = DEFAULT_THRESHOLDS,
): CustomerSignaturePipelineResult {
  const specs = createSignatureSpecs(thresholds);
  const legacyHalfPointSpec = makeHalfPointBuys(thresholds.halfPoint);
  const legacySecondHalfSpec = makeSecondHalfConcentration(
    thresholds.postHalftime,
  );
  const byCustomer = new Map<string, NormalizedObservationTicket[]>();

  for (const ticket of tickets) {
    const cid = normalizeCustomerId(ticket.customerId);
    if (cid === "") continue;
    const list = byCustomer.get(cid);
    if (list === undefined) byCustomer.set(cid, [ticket]);
    else list.push(ticket);
  }

  const observations = new Map<string, CustomerObservations>();
  const buckets: {
    [K in Signature["kind"]]: RankedSignatureEntry<K>[];
  } = {
    cbb_under_concentration: [],
    football_key_number_discipline: [],
    half_point_buys: [],
    in_play_activity: [],
    post_halftime_activity: [],
    pre_move_betting: [],
    second_half_concentration: [],
  };

  const sortedCustomerIds = [...byCustomer.keys()].sort();
  for (const customerId of sortedCustomerIds) {
    const custTickets = byCustomer.get(customerId)!;
    let nTickets = 0;
    let totalRiskUsd = 0;
    let netUsd = 0;
    let firstSeen = custTickets[0]?.placedAtYmd ?? "1970-01-01";
    let lastSeen = firstSeen;
    const seenGroups = new Set<string>();

    let fbLegs = 0;
    let bkLegs = 0;
    let otherLegs = 0;
    const familyCounts: Record<string, number> = {};

    for (const t of custTickets) {
      if (t.placedAtYmd < firstSeen) firstSeen = t.placedAtYmd;
      if (t.placedAtYmd > lastSeen) lastSeen = t.placedAtYmd;

      if (t.sport === "Football") fbLegs += 1;
      else if (t.sport === "Basketball") bkLegs += 1;
      else otherLegs += 1;

      const fam = t.competitionFamily.trim() || "OTHER";
      familyCounts[fam] = (familyCounts[fam] ?? 0) + 1;

      const gk = t.wagerGroupKey?.trim() ?? "";
      if (gk !== "") {
        if (seenGroups.has(gk)) continue;
        seenGroups.add(gk);
      }
      nTickets += 1;
      totalRiskUsd += t.riskUsd;
      netUsd += t.netUsd;
    }

    const totalLegs = custTickets.length;
    const sportMix: CustomerSportMix =
      totalLegs > 0
        ? {
            footballPct: Math.round((fbLegs / totalLegs) * 1000) / 1000,
            basketballPct: Math.round((bkLegs / totalLegs) * 1000) / 1000,
            otherPct: Math.round((otherLegs / totalLegs) * 1000) / 1000,
          }
        : DEFAULT_SPORT_MIX;

    const competitionFamilyMix: Record<string, number> = {};
    if (totalLegs > 0) {
      for (const [fam, cnt] of Object.entries(familyCounts)) {
        competitionFamilyMix[fam] = Math.round((cnt / totalLegs) * 1000) / 1000;
      }
    }

    const totals: CustomerTotals = {
      nTickets,
      totalRiskUsd,
      netUsd,
    };

    const signatures: Signature[] = [];
    for (const spec of specs) {
      const anySpec = spec as SignatureSpec<Signature["kind"], unknown>;
      const state = anySpec.init();
      for (const t of custTickets) {
        anySpec.observe(state, t);
      }
      const sig = anySpec.emit(state, totals);
      if (sig !== null) {
        signatures.push(sig);
        (buckets[sig.kind] as RankedSignatureEntry<typeof sig.kind>[]).push({
          customerId,
          sig,
          totals,
        });
      }
    }

    // Populate deprecated alias buckets for backward compatibility
    const hpState = legacyHalfPointSpec.init();
    const shState = legacySecondHalfSpec.init();
    for (const t of custTickets) {
      legacyHalfPointSpec.observe(hpState, t);
      legacySecondHalfSpec.observe(shState, t);
    }
    const hpSig = legacyHalfPointSpec.emit(hpState, totals);
    if (hpSig !== null) {
      buckets.half_point_buys.push({ customerId, sig: hpSig, totals });
    }
    const shSig = legacySecondHalfSpec.emit(shState, totals);
    if (shSig !== null) {
      buckets.second_half_concentration.push({
        customerId,
        sig: shSig,
        totals,
      });
    }

    observations.set(
      customerId,
      new CustomerObservations(
        customerId,
        totals.nTickets,
        totals.totalRiskUsd,
        totals.netUsd,
        signatures,
        firstSeen,
        lastSeen,
        sportMix,
        competitionFamilyMix,
      ),
    );
  }

  for (const spec of specs) {
    const list = buckets[spec.kind] as RankedSignatureEntry<
      Signature["kind"]
    >[];
    list.sort((a, b) =>
      compareSignatures(
        spec as unknown as SignatureSpec<Signature["kind"], unknown>,
        a,
        b,
      ),
    );
  }
  buckets.half_point_buys.sort((a, b) =>
    compareSignatures(legacyHalfPointSpec, a, b),
  );
  buckets.second_half_concentration.sort((a, b) =>
    compareSignatures(legacySecondHalfSpec, a, b),
  );

  return {
    observations,
    bySignature: buckets,
  };
}

/* -------------------------------------------------------------------------- */
/* Behavioral Profiling & Key-Number Hook Surveillance                        */
/* -------------------------------------------------------------------------- */

export const FOOTBALL_KEY_NUMBERS = [3, 7, 10, 14, 21] as const;
export type FootballKeyNumber = (typeof FOOTBALL_KEY_NUMBERS)[number];

export type CustomerBehavioralArchetype =
  | "key_number_buyer"
  | "second_half_concentration"
  | "cbb_under_concentration"
  | "early_line_mover"
  | "in_play_specialist"
  | "post_halftime_specialist"
  | "closing_line_sharp"
  | "recreational"
  | "square";

export interface CustomerBehavioralProfile {
  readonly customerId: string;
  readonly profile: CustomerBehavioralArchetype;
  readonly evidence: {
    readonly buyRate: number;
    readonly keyNumberConcentration: Readonly<Record<string, number>>;
    readonly touches3or7Rate: number;
    readonly avgPriceVsCloseCents: number;
    readonly avgEdgeCents: number;
    readonly twoHalfBetRate: number;
  };
  readonly nTickets: number;
  readonly totalRiskUsd: number;
  readonly avgRiskUsd: number;
  readonly estDeskLossUsd: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly confidence: number;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString?: () => string;
}

export function formatCustomerBehavioralProfile(
  profile: CustomerBehavioralProfile,
  options: BunInspectOptions = {},
): string {
  const c = options?.colors === true;
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
  const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const entries = Object.entries(profile.evidence.keyNumberConcentration);
  const sumVals = entries.reduce((acc, [, v]) => acc + v, 0);
  const isCounts = entries.some(([, v]) => v > 1);
  const keyConc = entries
    .map(([k, v]) => {
      const ratio = isCounts && sumVals > 0 ? v / sumVals : v;
      return `${k}:${pct(ratio)}`;
    })
    .join(" ");
  const priceDiff =
    profile.evidence.avgPriceVsCloseCents ?? profile.evidence.avgEdgeCents;
  return (
    `${bold(profile.customerId)} [${cyan(profile.profile)}] N=${fmtInt(profile.nTickets)} ` +
    `risk=${fmtUsd(profile.totalRiskUsd)} ` +
    `edge=${fmtCents(priceDiff)} ` +
    `2H=${pct(profile.evidence.twoHalfBetRate)} ` +
    `keys={${keyConc}} ` +
    `conf=${profile.confidence.toFixed(2)}`
  );
}

export function createCustomerBehavioralProfile(
  data: Omit<CustomerBehavioralProfile, typeof Bun.inspect.custom | "toString">,
): CustomerBehavioralProfile {
  return {
    ...data,
    [Bun.inspect.custom](
      _depth: number = 0,
      options: BunInspectOptions = {},
    ): string {
      return formatCustomerBehavioralProfile(this, options);
    },
    toString(): string {
      return formatCustomerBehavioralProfile(this, { colors: false });
    },
  };
}

export interface KeyNumberBuyCheck {
  readonly isKey: boolean;
  readonly is3or7: boolean;
  readonly key: FootballKeyNumber | null;
  readonly touchedKeys: readonly FootballKeyNumber[];
  readonly preBuySpread: number;
  readonly postBuySpread: number;
}

/**
 * Evaluates whether a spread point-buy (`adjSpread` with `buyPoints > 0`) moves onto, off, or
 * across a football key number (3, 7, 10, 14, 21).
 *
 * Since buying points always improves the bettor's spread (`preBuySpread = adjSpread - buyPoints`,
 * `postBuySpread = adjSpread`), any key margin `k` where `+k` or `-k` lies within
 * `[preBuySpread, postBuySpread]` is touched by the purchase.
 */
export function isKeyNumberBuy(
  adjSpread: number | null | undefined,
  buyPoints: number,
): KeyNumberBuyCheck {
  if (
    adjSpread === null ||
    adjSpread === undefined ||
    !Number.isFinite(adjSpread) ||
    !Number.isFinite(buyPoints) ||
    buyPoints <= 0
  ) {
    return {
      isKey: false,
      is3or7: false,
      key: null,
      touchedKeys: [],
      preBuySpread: adjSpread ?? 0,
      postBuySpread: adjSpread ?? 0,
    };
  }

  const preBuySpread = Math.round((adjSpread - buyPoints) * 100) / 100;
  const postBuySpread = Math.round(adjSpread * 100) / 100;
  const lo = Math.min(preBuySpread, postBuySpread) - 1e-9;
  const hi = Math.max(preBuySpread, postBuySpread) + 1e-9;

  const touchedKeys: FootballKeyNumber[] = [];
  for (const k of FOOTBALL_KEY_NUMBERS) {
    const touchesPositive = k >= lo && k <= hi;
    const touchesNegative = -k >= lo && -k <= hi;
    if (touchesPositive || touchesNegative) {
      touchedKeys.push(k);
    }
  }

  const is3or7 = touchedKeys.includes(3) || touchedKeys.includes(7);
  const primaryKey: FootballKeyNumber | null = touchedKeys.includes(3)
    ? 3
    : touchedKeys.includes(7)
      ? 7
      : (touchedKeys[0] ?? null);

  return {
    isKey: touchedKeys.length > 0,
    is3or7,
    key: primaryKey,
    touchedKeys,
    preBuySpread,
    postBuySpread,
  };
}

export interface ProfileAlert {
  readonly type: "PROFILE_ALERT";
  readonly level: "CRITICAL" | "WARN";
  readonly customerId: string;
  readonly ticketNumber: string;
  readonly profile: CustomerBehavioralArchetype;
  readonly keyNumber: FootballKeyNumber;
  readonly buyPoints: number;
  readonly preBuySpread: number;
  readonly postBuySpread: number;
  readonly message: string;
  readonly riskUsd: number;
  /** Informational desk/Telegram alert only; NEVER auto-execute on Kalshi/Polymarket. */
  readonly autoExecute: false;
  readonly [Bun.inspect.custom]?: (
    depth: number,
    options?: BunInspectOptions,
  ) => string;
  readonly toString?: () => string;
}

/**
 * Empirical key-number buyer profiles derived from the 930,791-ticket live feed (`f402-bets.jsonl`).
 */
export const KEY_NUMBER_BUYER_PROFILES: ReadonlyMap<
  string,
  CustomerBehavioralProfile
> = new Map<string, CustomerBehavioralProfile>([
  [
    "GP301",
    createCustomerBehavioralProfile({
      customerId: "GP301",
      profile: "key_number_buyer",
      evidence: {
        buyRate: 48 / 827,
        keyNumberConcentration: { "3": 19, "7": 16, "10": 2, "14": 4, "21": 3 },
        touches3or7Rate: 35 / 48,
        avgPriceVsCloseCents: 11.5,
        avgEdgeCents: 11.5,
        twoHalfBetRate: 10 / 827,
      },
      nTickets: 827,
      totalRiskUsd: 3_718_372.5,
      avgRiskUsd: 4_496.22,
      estDeskLossUsd: 88_420,
      firstSeen: "2026-10-02",
      lastSeen: "2026-11-09",
      confidence: 0.96,
    }),
  ],
  [
    "BRT5229",
    createCustomerBehavioralProfile({
      customerId: "BRT5229",
      profile: "key_number_buyer",
      evidence: {
        buyRate: 7 / 194,
        keyNumberConcentration: { "3": 3, "7": 3, "14": 1 },
        touches3or7Rate: 6 / 7,
        avgPriceVsCloseCents: 10.2,
        avgEdgeCents: 10.2,
        twoHalfBetRate: 32 / 194,
      },
      nTickets: 194,
      totalRiskUsd: 3_123_000,
      avgRiskUsd: 16_097.94,
      estDeskLossUsd: 17_748,
      firstSeen: "2026-10-02",
      lastSeen: "2026-11-09",
      confidence: 0.89,
    }),
  ],
  [
    "BRT5235",
    createCustomerBehavioralProfile({
      customerId: "BRT5235",
      profile: "key_number_buyer",
      evidence: {
        buyRate: 57 / 610,
        keyNumberConcentration: { "3": 17, "7": 14, "14": 2, "21": 1 },
        touches3or7Rate: 31 / 46,
        avgPriceVsCloseCents: 10.8,
        avgEdgeCents: 10.8,
        twoHalfBetRate: 49 / 610,
      },
      nTickets: 610,
      totalRiskUsd: 2_464_420,
      avgRiskUsd: 4_040.03,
      estDeskLossUsd: 27_226,
      firstSeen: "2026-10-02",
      lastSeen: "2026-11-09",
      confidence: 0.94,
    }),
  ],
  [
    "CCC88412",
    createCustomerBehavioralProfile({
      customerId: "CCC88412",
      profile: "key_number_buyer",
      evidence: {
        buyRate: 23 / 604,
        keyNumberConcentration: { "3": 4, "7": 3, "14": 1 },
        touches3or7Rate: 7 / 13,
        avgPriceVsCloseCents: 9.5,
        avgEdgeCents: 9.5,
        twoHalfBetRate: 106 / 604,
      },
      nTickets: 604,
      totalRiskUsd: 7_915_950,
      avgRiskUsd: 13_105.88,
      estDeskLossUsd: 31_065,
      firstSeen: "2026-10-02",
      lastSeen: "2026-11-09",
      confidence: 0.91,
    }),
  ],
  [
    "MJ107",
    createCustomerBehavioralProfile({
      customerId: "MJ107",
      profile: "key_number_buyer",
      evidence: {
        buyRate: 7 / 142,
        keyNumberConcentration: { "3": 2, "7": 2, "14": 1 },
        touches3or7Rate: 4 / 5,
        avgPriceVsCloseCents: 12.0,
        avgEdgeCents: 12.0,
        twoHalfBetRate: 12 / 142,
      },
      nTickets: 142,
      totalRiskUsd: 3_905_000,
      avgRiskUsd: 27_500,
      estDeskLossUsd: 24_300,
      firstSeen: "2026-10-02",
      lastSeen: "2026-11-09",
      confidence: 0.92,
    }),
  ],
]);

export const HALF_POINT_HOOK_SYNDICATE_PROFILES = KEY_NUMBER_BUYER_PROFILES;

function formatProfileAlert(
  alert: ProfileAlert,
  depth: number = 0,
  options: BunInspectOptions = {},
): string {
  const c = options?.colors === true;
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
  const redOrYellow = (s: string) =>
    c
      ? alert.level === "CRITICAL"
        ? `\x1b[31m${s}\x1b[39m`
        : `\x1b[33m${s}\x1b[39m`
      : s;
  const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
  if (depth <= 0) {
    return `[${redOrYellow(alert.level)}] ${bold(alert.customerId)} fired on ${alert.keyNumber}`;
  }
  return `[${redOrYellow(alert.level)}] ${cyan(alert.customerId)} fired on ${alert.keyNumber} (${alert.preBuySpread} → ${alert.postBuySpread}, +${alert.buyPoints}pt) · ticket #${alert.ticketNumber} · ${fmtUsd(alert.riskUsd)} risk`;
}

/**
 * Evaluates an enriched ticket against behavioral customer profiles.
 * Emits an informational `PROFILE_ALERT` (`autoExecute: false`) when a `key_number_buyer`
 * account buys onto, off, or across a football key number (3, 7, 10, 14, 21).
 */
export function evaluateTicketForProfileAlert(
  ticket: EnrichedTicketMaster,
  profiles: ReadonlyMap<
    string,
    CustomerBehavioralProfile
  > = KEY_NUMBER_BUYER_PROFILES,
): ProfileAlert | null {
  const normalizedCustomerId = normalizeCustomerId(ticket.CustomerID);
  const customerProfile = profiles.get(normalizedCustomerId);
  if (!customerProfile) return null;

  if (customerProfile.profile === "key_number_buyer" && ticket.buyPoints > 0) {
    const touchesKey = isKeyNumberBuy(ticket.adjSpread, ticket.buyPoints);
    if ((touchesKey.is3or7 || touchesKey.isKey) && touchesKey.key !== null) {
      const level = touchesKey.is3or7 ? "CRITICAL" : "WARN";
      const keyNumber = touchesKey.key;
      const priceDiff =
        customerProfile.evidence.avgPriceVsCloseCents ??
        customerProfile.evidence.avgEdgeCents;
      const message = `Account ${normalizedCustomerId} bought ${ticket.buyPoints}pt on key number ${keyNumber} (${touchesKey.preBuySpread} -> ${touchesKey.postBuySpread}; avg price vs close: ${fmtCents(priceDiff)})`;
      const alert: ProfileAlert = {
        type: "PROFILE_ALERT",
        level,
        customerId: normalizedCustomerId,
        ticketNumber: ticket.TicketNumber || ticket.WagerNumber,
        profile: customerProfile.profile,
        keyNumber,
        buyPoints: ticket.buyPoints,
        preBuySpread: touchesKey.preBuySpread,
        postBuySpread: touchesKey.postBuySpread,
        message,
        riskUsd: ticket.amountWageredUsd,
        autoExecute: false,
        [Bun.inspect.custom](
          depth: number = 0,
          options: BunInspectOptions = {},
        ): string {
          return formatProfileAlert(this, depth, options);
        },
        toString(): string {
          return formatProfileAlert(this, 2, { colors: false });
        },
      };
      return alert;
    }
  }
  return null;
}

/**
 * Convenience watcher entrypoint for raw `getBetTicker`, `Report/Pending`, or Figure Date rows.
 */
export function watchNewTicket(
  rawRow: FigureDateWagerRow | Record<string, unknown>,
  profiles: ReadonlyMap<
    string,
    CustomerBehavioralProfile
  > = KEY_NUMBER_BUYER_PROFILES,
): ProfileAlert | null {
  const enriched = enrichTicketWithBuyPoints(rawRow);
  return evaluateTicketForProfileAlert(enriched, profiles);
}
