/**
 * Ring clustering: connected components of evidence-scored edges at a
 * minimum edge score, plus a ring-level summary. Every ring is a guess.
 */

import type { PullProjection } from "./f402_analyze_ingest.ts";
import type { AccountEdge } from "./f402_analyze_link.ts";

export const RING_DISCLAIMER =
  "Rings are evidence-scored guesses, not confirmed identities.";

export interface RingSummary {
  readonly accountCount: number;
  readonly edgeCount: number;
  readonly minEdgeScore: number;
  readonly maxEdgeScore: number;
  readonly meanEdgeScore: number;
  readonly tightness: number;
  readonly evidenceCounts: Readonly<Record<string, number>>;
  readonly sports: readonly string[];
  readonly totalStake: number;
}

export interface AccountRing {
  readonly id: string;
  readonly accounts: readonly string[];
  readonly score: number;
  readonly label: "evidence-scored guess";
  readonly edges: readonly AccountEdge[];
  readonly summary: RingSummary;
}

function pairUnion(edges: readonly AccountEdge[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const cur = parent.get(id) ?? id;
    if (cur !== id) {
      const root = find(cur);
      parent.set(id, root);
      return root;
    }
    parent.set(id, cur);
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const edge of edges) union(edge.a, edge.b);
  return parent;
}

function findRoot(parent: Map<string, string>, id: string): string {
  const cur = parent.get(id) ?? id;
  if (cur !== id) {
    const root = findRoot(parent, cur);
    parent.set(id, root);
    return root;
  }
  return cur;
}

function summarizeRing(
  accounts: readonly string[],
  edges: readonly AccountEdge[],
  projection: PullProjection | undefined,
): RingSummary {
  const scores = edges.map((edge) => edge.score);
  const min = scores.length === 0 ? 0 : Math.min(...scores);
  const max = scores.length === 0 ? 0 : Math.max(...scores);
  const mean =
    scores.length === 0
      ? 0
      : scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const possible = (accounts.length * (accounts.length - 1)) / 2;
  const evidenceCounts: Record<string, number> = {};
  for (const edge of edges) {
    for (const item of edge.evidence) {
      evidenceCounts[item.type] = (evidenceCounts[item.type] ?? 0) + 1;
    }
  }
  const accountSet = new Set(accounts);
  const sports = new Set<string>();
  let totalStake = 0;
  if (projection !== undefined) {
    for (const wager of projection.wagers) {
      if (!accountSet.has(wager.accountId)) continue;
      if (wager.sport.trim() !== "") sports.add(wager.sport);
      for (const leg of wager.legs) {
        if (leg.sport.trim() !== "") sports.add(leg.sport);
      }
      if (Number.isFinite(wager.amountWagered))
        totalStake += wager.amountWagered;
    }
  }
  return {
    accountCount: accounts.length,
    edgeCount: edges.length,
    minEdgeScore: Number(min.toFixed(4)),
    maxEdgeScore: Number(max.toFixed(4)),
    meanEdgeScore: Number(mean.toFixed(4)),
    tightness: possible <= 0 ? 0 : Number((edges.length / possible).toFixed(4)),
    evidenceCounts,
    sports: [...sports].sort(),
    totalStake: Number(totalStake.toFixed(4)),
  };
}

export function buildRings(
  edges: readonly AccountEdge[],
  options: {
    readonly minEdgeScore?: number;
    readonly projection?: PullProjection;
  } = {},
): AccountRing[] {
  const minEdgeScore = options.minEdgeScore ?? 0.2;
  const used = edges.filter((edge) => edge.score >= minEdgeScore);
  const parent = pairUnion(used);
  const groups = new Map<string, AccountEdge[]>();
  for (const edge of used) {
    const root = findRoot(parent, edge.a);
    const list = groups.get(root) ?? [];
    list.push(edge);
    groups.set(root, list);
  }
  const rings: AccountRing[] = [];
  for (const groupEdges of groups.values()) {
    const accounts = [
      ...new Set(groupEdges.flatMap((edge) => [edge.a, edge.b])),
    ].sort();
    const score = groupEdges.reduce(
      (max, edge) => Math.max(max, edge.score),
      0,
    );
    rings.push({
      id: "ring-0",
      accounts,
      score: Number(score.toFixed(4)),
      label: "evidence-scored guess",
      edges: groupEdges,
      summary: summarizeRing(accounts, groupEdges, options.projection),
    });
  }
  rings.sort(
    (a, b) =>
      b.score - a.score ||
      b.accounts.length - a.accounts.length ||
      (a.accounts[0] ?? "").localeCompare(b.accounts[0] ?? ""),
  );
  return rings.map((ring, index) => ({ ...ring, id: `ring-${index + 1}` }));
}
