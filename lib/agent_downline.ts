/**
 * @file lib/agent_downline.ts
 * @description Agent rollups from the downline snapshot and direct/descendant counts from the tree.
 *
 * The downline snapshot is a point-in-time fixture (`sportsdesk_downline_data.json`), not a live
 * feed; the artifact labels it as such. Missing agents stay absent, never zero.
 */

import { readFile } from "node:fs/promises";

export interface AgentDownlineRollup {
  readonly agent: string;
  readonly master: string | null;
  readonly totalAccounts: number | null;
  readonly activeSportsAccounts: number | null;
  readonly dormantAccounts: number | null;
  readonly lifetimeLostUsd: number | null;
  readonly lifetimeWonUsd: number | null;
  readonly lifetimeNetUsd: number | null;
  readonly sportsTickets: number | null;
  readonly sportsVolumeUsd: number | null;
  readonly sportsNetUsd: number | null;
  readonly holdPct: number | null;
  readonly toxicity: number | null;
  readonly sharpCount: number | null;
  readonly grade: string | null;
  readonly agentType: string | null;
}

export interface TreeDownlineCounts {
  readonly directAgents: number;
  readonly descendantAgents: number;
}

export interface AgentDownlineIndex {
  readonly source: string;
  readonly agents: number;
  readonly byAgent: ReadonlyMap<string, AgentDownlineRollup>;
  readonly meta: Record<string, unknown> | null;
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export async function loadAgentDownline(
  path: string,
): Promise<AgentDownlineIndex | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const rows = Array.isArray(doc.agents) ? doc.agents : [];
  const byAgent = new Map<string, AgentDownlineRollup>();
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const agent = str(row.agent)?.toUpperCase() ?? null;
    if (agent === null) continue;
    byAgent.set(agent, {
      agent,
      master: str(row.master),
      totalAccounts: num(row.total_accounts),
      activeSportsAccounts: num(row.active_sports_accounts),
      dormantAccounts: num(row.dormant_accounts),
      lifetimeLostUsd: num(row.lifetime_lost),
      lifetimeWonUsd: num(row.lifetime_won),
      lifetimeNetUsd: num(row.lifetime_net),
      sportsTickets: num(row.sports_tickets),
      sportsVolumeUsd: num(row.sports_vol),
      sportsNetUsd: num(row.sports_net),
      holdPct: num(row.hold_pct),
      toxicity: num(row.toxicity),
      sharpCount: num(row.sharp_count),
      grade: str(row.grade),
      agentType: str(row.agent_type),
    });
  }
  if (byAgent.size === 0) return null;
  return {
    source: path,
    agents: byAgent.size,
    byAgent,
    meta:
      doc.meta !== null && typeof doc.meta === "object"
        ? (doc.meta as Record<string, unknown>)
        : null,
  };
}

/** Direct children and all descendants per agent, from the tree's parent links. */
export function treeDownlineCounts(
  nodes: Readonly<Record<string, { readonly p?: string | null | undefined }>>,
  agentIds: Iterable<string>,
): ReadonlyMap<string, TreeDownlineCounts> {
  const children = new Map<string, string[]>();
  for (const [id, node] of Object.entries(nodes)) {
    const parent =
      typeof node.p === "string" ? node.p.trim().toUpperCase() : "";
    if (parent === "") continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [id.toUpperCase()]);
    else list.push(id.toUpperCase());
  }
  const counts = new Map<string, TreeDownlineCounts>();
  for (const raw of agentIds) {
    const id = raw.trim().toUpperCase();
    if (id === "" || counts.has(id)) continue;
    const direct = children.get(id) ?? [];
    const seen = new Set<string>([id]);
    const queue = [...direct];
    let descendants = 0;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      descendants++;
      queue.push(...(children.get(next) ?? []));
    }
    counts.set(id, {
      directAgents: direct.length,
      descendantAgents: descendants,
    });
  }
  return counts;
}

export interface AgentRiskBucket {
  /** Customer login, sport label, or writer name, depending on the bucket. */
  readonly key: string;
  readonly riskUsd: number;
  readonly sharePct: number;
}

export interface AgentExposure {
  readonly customers: number;
  readonly positions: number;
  readonly openRiskUsd: number;
  readonly openToWinUsd: number;
  /** The agent's own customers only (not its descendants). */
  readonly ownCustomers: number;
  readonly ownPositions: number;
  readonly ownRiskUsd: number;
  readonly ownToWinUsd: number;
  /** Everyone below the agent; totals = own + downline. */
  readonly downlineCustomers: number;
  readonly downlinePositions: number;
  readonly downlineRiskUsd: number;
  readonly downlineToWinUsd: number;
  readonly topCustomerRiskUsd: number;
  readonly topCustomerSharePct: number;
  readonly maxTicketRiskUsd: number;
  readonly avgTicketRiskUsd: number;
  /** Largest sport bucket in the subtree; null when positions carry no sport. */
  readonly topSport: string | null;
  readonly topSportRiskUsd: number;
  readonly topSportSharePct: number;
  readonly sportCount: number;
  /** Largest customer risks in the subtree (top 3). */
  readonly topCustomers: readonly AgentRiskBucket[];
  /** Sport buckets in the subtree (top 5). */
  readonly sports: readonly AgentRiskBucket[];
  /** Writer buckets in the subtree (top 5); pending rows have no writer. */
  readonly writers: readonly AgentRiskBucket[];
}

export interface TreeCollision {
  readonly key: string;
  readonly agentIds: readonly string[];
}

/** Index the tree's collision list (one login presented under several agent ids). */
export function treeCollisionIndex(
  collisions: unknown,
): ReadonlyMap<string, TreeCollision> {
  const index = new Map<string, TreeCollision>();
  if (!Array.isArray(collisions)) return index;
  for (const value of collisions) {
    if (value === null || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const key = str(row.key);
    if (key === null || !Array.isArray(row.agentIds)) continue;
    const agentIds = row.agentIds
      .map((id) => str(id)?.toUpperCase() ?? null)
      .filter((id): id is string => id !== null);
    for (const agentId of agentIds) {
      index.set(agentId, { key, agentIds });
    }
  }
  return index;
}

interface ExposureAccumulator {
  ownCustomers: number;
  ownPositions: number;
  ownRiskUsd: number;
  ownToWinUsd: number;
  downlineCustomers: number;
  downlinePositions: number;
  downlineRiskUsd: number;
  downlineToWinUsd: number;
  maxTicketRiskUsd: number;
  riskByCustomer: Map<string, number>;
  riskBySport: Map<string, number>;
  riskByWriter: Map<string, number>;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Open-position exposure per agent subtree, split into the agent's own customers and its downline.
 * A customer counts once toward its own agent (own) and every ancestor (downline), so totals are
 * own + downline and ancestors intentionally overlap. Concentration and sport mix are measured
 * per subtree, never inferred.
 */
export function treeSubtreeExposure(
  nodes: Readonly<Record<string, { readonly p?: string | null | undefined }>>,
  profiles: Iterable<{
    readonly customerId: string;
    readonly agentId: string;
    readonly positions: readonly {
      readonly risk_usd?: number | undefined;
      readonly to_win_usd?: number | undefined;
      readonly sport?: string | undefined;
      readonly writer?: string | undefined;
    }[];
  }>,
): ReadonlyMap<string, AgentExposure> {
  const parent = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    const key = id.trim().toUpperCase();
    const up = typeof node.p === "string" ? node.p.trim().toUpperCase() : "";
    if (key !== "" && up !== "") parent.set(key, up);
  }
  const accumulated = new Map<string, ExposureAccumulator>();
  const empty = (): ExposureAccumulator => ({
    ownCustomers: 0,
    ownPositions: 0,
    ownRiskUsd: 0,
    ownToWinUsd: 0,
    downlineCustomers: 0,
    downlinePositions: 0,
    downlineRiskUsd: 0,
    downlineToWinUsd: 0,
    maxTicketRiskUsd: 0,
    riskByCustomer: new Map<string, number>(),
    riskBySport: new Map<string, number>(),
    riskByWriter: new Map<string, number>(),
  });
  for (const profile of profiles) {
    const agent = profile.agentId.trim().toUpperCase();
    if (agent === "") continue;
    const customer = profile.customerId.trim().toUpperCase();
    const riskUsd = profile.positions.reduce(
      (total, position) => total + (position.risk_usd ?? 0),
      0,
    );
    const toWinUsd = profile.positions.reduce(
      (total, position) => total + (position.to_win_usd ?? 0),
      0,
    );
    const maxTicket = profile.positions.reduce(
      (max, position) => Math.max(max, position.risk_usd ?? 0),
      0,
    );
    const seen = new Set<string>();
    let current = agent;
    let isOwn = true;
    while (current !== "" && !seen.has(current)) {
      seen.add(current);
      const acc = accumulated.get(current) ?? empty();
      if (isOwn) {
        acc.ownCustomers += 1;
        acc.ownPositions += profile.positions.length;
        acc.ownRiskUsd += riskUsd;
        acc.ownToWinUsd += toWinUsd;
      } else {
        acc.downlineCustomers += 1;
        acc.downlinePositions += profile.positions.length;
        acc.downlineRiskUsd += riskUsd;
        acc.downlineToWinUsd += toWinUsd;
      }
      acc.maxTicketRiskUsd = Math.max(acc.maxTicketRiskUsd, maxTicket);
      if (customer !== "") {
        acc.riskByCustomer.set(
          customer,
          (acc.riskByCustomer.get(customer) ?? 0) + riskUsd,
        );
      }
      for (const position of profile.positions) {
        const sport = position.sport?.trim();
        if (sport !== undefined && sport !== "") {
          acc.riskBySport.set(
            sport,
            (acc.riskBySport.get(sport) ?? 0) + (position.risk_usd ?? 0),
          );
        }
        const writer = position.writer?.trim() ?? "";
        const writerKey = writer === "" ? "unknown" : writer;
        acc.riskByWriter.set(
          writerKey,
          (acc.riskByWriter.get(writerKey) ?? 0) + (position.risk_usd ?? 0),
        );
      }
      accumulated.set(current, acc);
      current = parent.get(current) ?? "";
      isOwn = false;
    }
  }
  const exposure = new Map<string, AgentExposure>();
  for (const [agent, acc] of accumulated) {
    const customers = acc.ownCustomers + acc.downlineCustomers;
    const positions = acc.ownPositions + acc.downlinePositions;
    const riskUsd = acc.ownRiskUsd + acc.downlineRiskUsd;
    const toWinUsd = acc.ownToWinUsd + acc.downlineToWinUsd;
    const topCustomerRiskUsd = Math.max(0, ...acc.riskByCustomer.values());
    const [topSport, topSportRiskUsd] = [...acc.riskBySport.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0] ?? [null, 0];
    const bucket = (
      map: Map<string, number>,
      limit: number,
    ): AgentRiskBucket[] =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([key, risk]) => ({
          key,
          riskUsd: round2(risk),
          sharePct: riskUsd > 0 ? round1((risk / riskUsd) * 100) : 0,
        }));
    exposure.set(agent, {
      customers,
      positions,
      openRiskUsd: round2(riskUsd),
      openToWinUsd: round2(toWinUsd),
      ownCustomers: acc.ownCustomers,
      ownPositions: acc.ownPositions,
      ownRiskUsd: round2(acc.ownRiskUsd),
      ownToWinUsd: round2(acc.ownToWinUsd),
      downlineCustomers: acc.downlineCustomers,
      downlinePositions: acc.downlinePositions,
      downlineRiskUsd: round2(acc.downlineRiskUsd),
      downlineToWinUsd: round2(acc.downlineToWinUsd),
      topCustomerRiskUsd: round2(topCustomerRiskUsd),
      topCustomerSharePct:
        riskUsd > 0 ? round1((topCustomerRiskUsd / riskUsd) * 100) : 0,
      maxTicketRiskUsd: round2(acc.maxTicketRiskUsd),
      avgTicketRiskUsd: positions > 0 ? round2(riskUsd / positions) : 0,
      topSport,
      topSportRiskUsd: round2(topSportRiskUsd),
      topSportSharePct:
        riskUsd > 0 ? round1((topSportRiskUsd / riskUsd) * 100) : 0,
      sportCount: acc.riskBySport.size,
      topCustomers: bucket(acc.riskByCustomer, 3),
      sports: bucket(acc.riskBySport, 5),
      writers: bucket(acc.riskByWriter, 5),
    });
  }
  return exposure;
}
