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

export type Channel = "GSLIVE" | "GSBUILDER" | "Internet" | string;

/** Parse a customer-profile XML document with Bun's native parser (compact shape). */
export function parseCustomerProfileXml(text: string): Bun.XML.Document {
  return Bun.XML.parse(text);
}

/** Parse a customer-performance XML document with Bun's native parser (compact shape). */
export function parseCustomerPerformanceXml(text: string): Bun.XML.Document {
  return Bun.XML.parse(text);
}

/** Parse a transactions XML document with Bun's native parser (compact shape). */
export function parseTransactionsXml(text: string): Bun.XML.Document {
  return Bun.XML.parse(text);
}

/** Parse an AJAX-delivered XML response with Bun's native parser (compact shape). */
export function parseAjaxXml(text: string): Bun.XML.Document {
  return Bun.XML.parse(text);
}

/** Parse a Fantasy402 AJAX XML response with Bun's native parser (compact shape). */
export function parseFantasy402AjaxXml(text: string): Bun.XML.Document {
  return Bun.XML.parse(text);
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
export function customerRowFromXml(text: string): CustomerRow {
  const doc = parseCustomerProfileXml(text) as Record<string, unknown>;
  // Accept <profile>, <customer>, or a bare root.
  const root = (doc.profile ??
    doc.customer ??
    doc.Customer ??
    doc.Profile ??
    doc) as Record<string, unknown>;
  const get = (k: string) => xmlText(root[k] ?? root[`@${k}`]);
  const num = (k: string) => {
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
    ...((num("wager_limit_usd") ?? num("wagerLimit"))
      ? { wager_limit_usd: num("wager_limit_usd") ?? num("wagerLimit") }
      : {}),
    ...((num("lifetime_volume_usd") ?? num("volume"))
      ? { lifetime_volume_usd: num("lifetime_volume_usd") ?? num("volume") }
      : {}),
    ...((num("lifetime_net_usd") ?? num("net"))
      ? { lifetime_net_usd: num("lifetime_net_usd") ?? num("net") }
      : {}),
    ...((num("hold_pct") ?? num("holdPct"))
      ? { hold_pct: num("hold_pct") ?? num("holdPct") }
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
