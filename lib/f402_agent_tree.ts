/**
 * Structural agent tree from GENERAL row order (pre-order DFS, one row per agent).
 * Parent = nearest preceding row at level − 1. This is the envelope's own nesting,
 * independent of the pinned portal parser's `Master` field.
 */

import { PORTAL_HIERARCHY_PARSER_MAX_LEVEL } from "./f402_manager_hierarchy_ingest.ts";

/** Minimal GENERAL row shape (wire rows and portal rows both satisfy it). */
export interface AgentTreeInputRow {
  readonly AgentID?: unknown;
  readonly Login?: unknown;
  readonly Level?: unknown;
}

export interface AgentTreeNode {
  readonly id: string;
  readonly login: string;
  readonly level: number;
  readonly parentId: string | null;
  readonly rootId: string;
  /** Level-2 ancestor (or self at level ≤ 2) — the unit used for color grouping. */
  readonly branchId: string;
  readonly children: string[];
  /** Descendants at levels ≤ max level, excluding self. */
  descendantCount: number;
  /** Overflow (level > max) agents whose nearest in-graph ancestor is this node. */
  overflowCount: number;
}

export interface AgentTree {
  readonly nodes: ReadonlyMap<string, AgentTreeNode>;
  readonly roots: readonly string[];
  readonly maxLevel: number;
  readonly overflowTotal: number;
  readonly overflowByLevel: Readonly<Record<number, number>>;
}

export class AgentTreeOrderError extends Error {}

export function buildAgentTreeFromGeneral(
  general: readonly AgentTreeInputRow[],
  maxLevel: number = PORTAL_HIERARCHY_PARSER_MAX_LEVEL,
): AgentTree {
  const nodes = new Map<string, AgentTreeNode>();
  const roots: string[] = [];
  const stack: string[] = [];
  const overflowByLevel: Record<number, number> = {};
  let overflowTotal = 0;
  let prevLevel = 0;

  for (const row of general) {
    const level = Number(row.Level);
    const id = String(row.AgentID ?? "")
      .trim()
      .toUpperCase();
    if (id === "") throw new AgentTreeOrderError("GENERAL row without AgentID");
    if (!Number.isInteger(level) || level < 1) {
      throw new AgentTreeOrderError(
        `Invalid Level for ${id}: ${String(row.Level)}`,
      );
    }
    if (level > prevLevel + 1) {
      throw new AgentTreeOrderError(
        `GENERAL not pre-order: ${id} at level ${level} follows level ${prevLevel}`,
      );
    }
    prevLevel = level;
    stack.length = level - 1;

    if (level > maxLevel) {
      overflowTotal += 1;
      overflowByLevel[level] = (overflowByLevel[level] ?? 0) + 1;
      const owner = nodes.get(stack[maxLevel - 1] ?? "");
      if (owner) owner.overflowCount += 1;
      stack[level - 1] = id;
      continue;
    }
    if (nodes.has(id)) {
      throw new AgentTreeOrderError(`Duplicate AgentID ${id}`);
    }

    const parentId = level === 1 ? null : (stack[level - 2] ?? null);
    const rootId = level === 1 ? id : (stack[0] ?? id);
    nodes.set(id, {
      id,
      login: String(row.Login ?? id)
        .trim()
        .toUpperCase(),
      level,
      parentId,
      rootId,
      branchId: level <= 2 ? id : (stack[1] ?? id),
      children: [],
      descendantCount: 0,
      overflowCount: 0,
    });
    if (parentId === null) roots.push(id);
    else nodes.get(parentId)?.children.push(id);
    stack[level - 1] = id;
  }

  for (const node of nodes.values()) {
    let p = node.parentId;
    while (p !== null) {
      const parent = nodes.get(p);
      if (!parent) break;
      parent.descendantCount += 1;
      p = parent.parentId;
    }
  }

  return { nodes, roots, maxLevel, overflowTotal, overflowByLevel };
}

export function ancestorsOf(tree: AgentTree, id: string): AgentTreeNode[] {
  const out: AgentTreeNode[] = [];
  let p = tree.nodes.get(id)?.parentId ?? null;
  while (p !== null) {
    const node = tree.nodes.get(p);
    if (!node) break;
    out.unshift(node);
    p = node.parentId;
  }
  return out;
}

export interface ParentDivergence {
  readonly agentId: string;
  readonly level: number;
  readonly structuralParent: string | null;
  readonly portalParent: string | null;
}

/** Agents whose portal-parser parent differs from the envelope's structural parent. */
export function parentDivergence(
  tree: AgentTree,
  portalParents: ReadonlyMap<string, string | null>,
): ParentDivergence[] {
  const out: ParentDivergence[] = [];
  for (const node of tree.nodes.values()) {
    const portal = portalParents.get(node.id) ?? null;
    if (portal !== node.parentId) {
      out.push({
        agentId: node.id,
        level: node.level,
        structuralParent: node.parentId,
        portalParent: portal,
      });
    }
  }
  return out;
}

export interface AgentTreeStats {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly roots: readonly { id: string; size: number }[];
  readonly levelHistogram: Readonly<Record<number, number>>;
  readonly fanout: {
    readonly max: number;
    readonly p50: number;
    readonly p90: number;
    readonly leaves: number;
  };
  readonly topBranches: readonly {
    id: string;
    level: number;
    rootId: string;
    size: number;
  }[];
  readonly overflowTotal: number;
  readonly overflowByLevel: Readonly<Record<number, number>>;
  readonly overflowOwners: readonly {
    id: string;
    rootId: string;
    overflow: number;
  }[];
  /** Nodes per depth (relative to root) cumulative — drives collapse-depth choice. */
  readonly cumulativeByLevel: Readonly<Record<number, number>>;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  );
}

export function agentTreeStats(tree: AgentTree, topK = 10): AgentTreeStats {
  const levelHistogram: Record<number, number> = {};
  const fan: number[] = [];
  let leaves = 0;
  let edgeCount = 0;
  for (const n of tree.nodes.values()) {
    levelHistogram[n.level] = (levelHistogram[n.level] ?? 0) + 1;
    if (n.parentId !== null) edgeCount += 1;
    if (n.children.length === 0) leaves += 1;
    else fan.push(n.children.length);
  }
  fan.sort((a, b) => a - b);
  const cumulativeByLevel: Record<number, number> = {};
  let running = 0;
  for (let l = 1; l <= tree.maxLevel; l++) {
    running += levelHistogram[l] ?? 0;
    cumulativeByLevel[l] = running;
  }
  const branches = [...tree.nodes.values()]
    .filter((n) => n.level >= 2)
    .sort(
      (a, b) =>
        b.descendantCount - a.descendantCount || a.id.localeCompare(b.id),
    )
    .slice(0, topK)
    .map((n) => ({
      id: n.id,
      level: n.level,
      rootId: n.rootId,
      size: n.descendantCount + 1,
    }));
  const overflowOwners = [...tree.nodes.values()]
    .filter((n) => n.overflowCount > 0)
    .sort(
      (a, b) => b.overflowCount - a.overflowCount || a.id.localeCompare(b.id),
    )
    .map((n) => ({ id: n.id, rootId: n.rootId, overflow: n.overflowCount }));
  return {
    nodeCount: tree.nodes.size,
    edgeCount,
    roots: tree.roots.map((id) => ({
      id,
      size: (tree.nodes.get(id)?.descendantCount ?? 0) + 1,
    })),
    levelHistogram,
    fanout: {
      max: fan.at(-1) ?? 0,
      p50: percentile(fan, 0.5),
      p90: percentile(fan, 0.9),
      leaves,
    },
    topBranches: branches,
    overflowTotal: tree.overflowTotal,
    overflowByLevel: tree.overflowByLevel,
    overflowOwners,
    cumulativeByLevel,
  };
}
