/**
 * @file packages/backend/src/agents.ts
 * @description Sub-agent hierarchy, 30d conduit rollup, and customer/wager lookup service (`/api/agent/:id`).
 */

import { resolve } from "node:path";
import type {
  AgentDetailApiResponse,
  WagerTier,
} from "@sportsdesk-ops/contracts";
import { BoundedStampCache, statStamp } from "./cache.ts";

interface AgentTreeNode {
  readonly l?: number | null;
  readonly p?: string | null;
  readonly t?: string | null;
}

interface AgentTreeFile {
  readonly nodes?: Readonly<Record<string, AgentTreeNode>>;
}

export interface AgentConduitSummaryInput {
  readonly agentId: string;
  readonly masterAgent?: string | null | undefined;
  readonly handleUsd: number;
  readonly wagers: number;
  readonly customers?: number | undefined;
  readonly topCustomer?: string | null | undefined;
  readonly concentrationPct?: number | undefined;
  readonly isProxyConduit?: boolean | undefined;
}

export interface AgentCustomerInput {
  readonly id: string;
  readonly agentId: string;
  readonly tier: string;
  readonly score: number;
  readonly recommendedLimitUsd: number;
  readonly holdPct: number;
}

export interface AgentDetailServiceOptions {
  readonly cwd?: string | undefined;
  readonly agentTreePath?: string | undefined;
  readonly getConduits?:
    (() => Promise<readonly AgentConduitSummaryInput[]>) | undefined;
  readonly getCustomers?:
    | (() =>
        Promise<readonly AgentCustomerInput[]> | readonly AgentCustomerInput[])
    | undefined;
  readonly getRecentWagers?:
    (() => Promise<ReadonlyArray<Record<string, unknown>>>) | undefined;
}

export function createAgentDetailService(
  options: AgentDetailServiceOptions = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const agentTreePath =
    options.agentTreePath ?? resolve(cwd, "data/agent-tree.json");
  const treeCache = new BoundedStampCache<AgentTreeFile>(4);

  async function loadAgentTree(): Promise<AgentTreeFile | null> {
    const stamp = await statStamp(agentTreePath);
    if (stamp === null) return null;
    const hit = treeCache.getIfFresh(agentTreePath, stamp);
    if (hit !== undefined) return hit;

    try {
      const parsed = (await Bun.file(agentTreePath).json()) as AgentTreeFile;
      treeCache.set(agentTreePath, stamp, parsed);
      return parsed;
    } catch {
      // signal-honesty: intentional-agent-tree-optional-fallback
      return null;
    }
  }

  async function getAgentDetail(
    rawId: string,
  ): Promise<AgentDetailApiResponse> {
    const agentId = rawId.trim().toUpperCase();
    const observedAt = new Date().toISOString();

    const [tree, conduits, customers, wagers] = await Promise.all([
      loadAgentTree(),
      options.getConduits
        ? options.getConduits().catch(() => [])
        : Promise.resolve([] as readonly AgentConduitSummaryInput[]),
      options.getCustomers
        ? Promise.resolve(options.getCustomers()).catch(() => [])
        : Promise.resolve([] as readonly AgentCustomerInput[]),
      options.getRecentWagers
        ? options.getRecentWagers().catch(() => [])
        : Promise.resolve([] as ReadonlyArray<Record<string, unknown>>),
    ]);

    const nodes = tree?.nodes ?? {};
    const node = nodes[agentId];
    const childAgents: string[] = [];
    for (const [childId, entry] of Object.entries(nodes)) {
      if (
        typeof entry?.p === "string" &&
        entry.p.trim().toUpperCase() === agentId
      ) {
        childAgents.push(childId);
      }
    }
    childAgents.sort();

    const matchedConduit = conduits.find(
      (c) => c.agentId.trim().toUpperCase() === agentId,
    );
    const matchedCustomers = customers
      .filter((c) => c.agentId.trim().toUpperCase() === agentId)
      .sort((a, b) => b.score - a.score)
      .map((c) => ({
        id: c.id,
        tier: c.tier,
        score: c.score,
        recommendedLimitUsd: c.recommendedLimitUsd,
        holdPct: c.holdPct,
      }));

    const matchedWagers = wagers
      .filter(
        (w) =>
          String(w.agentId ?? w.AgentID ?? "")
            .trim()
            .toUpperCase() === agentId,
      )
      .slice(0, 50)
      .map((w) => ({
        ticketId: String(w.ticketId ?? w.WagerNumber ?? "—"),
        customerId: String(w.customerId ?? w.CustomerID ?? "—"),
        sport: String(w.sport ?? "MULTI"),
        betType: String(w.betType ?? "Straight"),
        selection: String(w.selection ?? w.lineDisplay ?? "—"),
        riskUsd: Number(w.riskUsd ?? w.AmountWagered ?? 0) || 0,
        toWinUsd: Number(w.toWinUsd ?? w.ToWinAmount ?? 0) || 0,
        writer: String(w.ticketWriter ?? w.TicketWriter ?? "Internet").trim(),
        alertTier: String(w.alertTier ?? "RECREATIONAL") as WagerTier,
        timestamp: String(w.timestamp ?? w.InsertDateTime ?? "—"),
      }));

    const masterAgent =
      typeof node?.p === "string" && node.p.trim() !== ""
        ? node.p.trim().toUpperCase()
        : typeof matchedConduit?.masterAgent === "string" &&
            matchedConduit.masterAgent.trim() !== ""
          ? matchedConduit.masterAgent.trim().toUpperCase()
          : null;

    const found =
      node !== undefined ||
      childAgents.length > 0 ||
      matchedConduit !== undefined ||
      matchedCustomers.length > 0 ||
      matchedWagers.length > 0;

    return {
      schemaVersion: 1,
      agentId,
      found,
      masterAgent,
      level: typeof node?.l === "number" ? node.l : null,
      agentType: typeof node?.t === "string" ? node.t : null,
      childAgents,
      conduit30d: matchedConduit
        ? {
            handleUsd: matchedConduit.handleUsd,
            wagers: matchedConduit.wagers,
            customers: matchedConduit.customers ?? matchedCustomers.length,
            topCustomer: matchedConduit.topCustomer ?? null,
            concentrationPct: matchedConduit.concentrationPct ?? 0,
            isProxyConduit: Boolean(matchedConduit.isProxyConduit),
          }
        : null,
      customers: matchedCustomers,
      recentWagers: matchedWagers,
      observedAt,
      autoExecute: false,
    };
  }

  return {
    getAgentDetail,
    clearCache: () => treeCache.clear(),
  };
}
