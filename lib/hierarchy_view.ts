/**
 * Flatten → tree, with the per-node rollups the flat list cannot answer.
 *
 * `data/agent-tree.json` is a flat map: `{ nodes: { <login>: { l: level, p: parent, t: "M"|"A" } },
 * roots: [...] }`. 2,276 nodes, 506 parents, one root carrying 2,272 descendants twelve levels
 * deep, plus three isolated roots. "How many agents sit under this node" is therefore a full walk
 * per question; the browser cannot answer it on every render, and the flat payload never carries it.
 *
 * This builds the children edges once and folds the subtree counts bottom-up. It is deliberately
 * tolerant of the payload's real defects: a missing parent, a cycle, a login owned by two AgentIDs
 * (the file flags that as `collisions`) and a node with no type. Ambiguity is reported, never
 * silently dropped, because a tree that quietly loses a branch is worse than one that says so.
 */

export interface RawHierarchyNode {
  readonly l?: number | null;
  readonly p?: string | null;
  readonly t?: string | null;
  readonly a?: number | null;
}

export interface RawHierarchyTree {
  readonly nodes?: Readonly<Record<string, RawHierarchyNode>>;
  readonly roots?: readonly string[];
  readonly collisions?: readonly {
    readonly key: string;
    readonly agentIds: readonly string[];
  }[];
}

export type HierarchyKind = "master" | "agent" | "unknown";

export interface HierarchyRollup {
  /** Agents strictly below this node, direct and transitive. */
  readonly agents: number;
  /** Longest chain below this node; 0 for a leaf. */
  readonly depth: number;
}

/** Per-node exposure, in the shape `/api/agent-tree` already computes from the wager capture. */
export interface HierarchyAction {
  readonly games: number;
  readonly wagered: number;
  readonly toWin: number;
}

export interface BuildHierarchyOptions {
  /** Sparse: only agents with captured wagers appear. */
  readonly actionByAgent?: Readonly<Record<string, HierarchyAction>>;
}

export interface HierarchyNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: HierarchyKind;
  /** The portal's `l` field, verbatim. Not depth — see `depth`. */
  readonly level: number | null;
  /** Parent-chain depth from this node's root. The only depth signal the payload supports. */
  readonly depth: number;
  readonly childrenCount: number;
  readonly rollup: HierarchyRollup;
  /** `null` when the capture has no wager rows for this agent — not zero. */
  readonly action: HierarchyAction | null;
  readonly children: readonly HierarchyNode[];
}

export interface HierarchyStats {
  readonly nodes: number;
  readonly reachable: number;
  readonly roots: number;
  /** Nodes whose parent is not in the tree and that are not declared roots. */
  readonly unparented: number;
  readonly maxDepth: number;
  /** Nodes whose `l` disagrees with their parent-chain depth. */
  readonly levelMismatches: number;
  readonly byKind: Readonly<Record<HierarchyKind, number>>;
}

export interface HierarchyView {
  readonly roots: readonly HierarchyNode[];
  readonly stats: HierarchyStats;
  /** Defects in the payload, phrased so an operator can act on them. */
  readonly problems: readonly string[];
}

function kindOf(type: string | null | undefined): HierarchyKind {
  if (type === "M") return "master";
  if (type === "A") return "agent";
  return "unknown";
}

export function buildHierarchy(
  tree: RawHierarchyTree,
  options: BuildHierarchyOptions = {},
): HierarchyView {
  const nodes = tree.nodes ?? {};
  const action = options.actionByAgent ?? {};
  const declaredRoots = [...new Set(tree.roots ?? [])].filter(
    (id) => id in nodes,
  );
  const problems: string[] = [];

  for (const id of tree.roots ?? []) {
    if (!(id in nodes)) problems.push(`declared root ${id} is not a node`);
  }
  for (const collision of tree.collisions ?? []) {
    problems.push(
      `${collision.key} is owned by ${collision.agentIds.length} AgentIDs (${collision.agentIds.join(", ")}); the key resolves to one branch only`,
    );
  }

  // Children edges, and every node that has no usable parent edge.
  const childrenOf = new Map<string, string[]>();
  const roots = new Set<string>(declaredRoots);
  let unparented = 0;

  for (const [id, node] of Object.entries(nodes)) {
    const parent = node.p ?? null;
    if (parent === null || parent === "") {
      if (!roots.has(id)) roots.add(id);
      continue;
    }
    if (!(parent in nodes)) {
      unparented += 1;
      problems.push(`${id}: parent ${parent} is not in the tree`);
      roots.add(id);
      continue;
    }
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(id);
    childrenOf.set(parent, siblings);
  }

  const byKind: Record<HierarchyKind, number> = {
    master: 0,
    agent: 0,
    unknown: 0,
  };
  for (const node of Object.values(nodes)) byKind[kindOf(node.t)] += 1;

  const built = new Map<string, HierarchyNode>();
  const visiting = new Set<string>();

  /** Post-order build: children first, so the rollup is a fold over already-built subtrees. */
  function build(id: string, depthFromRoot: number): HierarchyNode {
    const existing = built.get(id);
    if (existing !== undefined) return existing;
    const raw = nodes[id] ?? {};
    if (visiting.has(id)) {
      // Cut the cycle; the node is reported once and attached without its back-edge.
      problems.push(`cycle through ${id}; the back-edge was cut`);
      return {
        id,
        parentId: raw.p ?? null,
        kind: kindOf(raw.t),
        level: raw.l ?? null,
        depth: depthFromRoot,
        childrenCount: 0,
        rollup: { agents: 0, depth: 0 },
        action: action[id] ?? null,
        children: [],
      };
    }
    visiting.add(id);
    const childIds = childrenOf.get(id) ?? [];
    const children = childIds.map((child) => build(child, depthFromRoot + 1));
    visiting.delete(id);

    let agents = 0;
    let depth = 0;
    for (const child of children) {
      agents += 1 + child.rollup.agents;
      depth = Math.max(depth, 1 + child.rollup.depth);
    }

    const node: HierarchyNode = {
      id,
      parentId: raw.p ?? null,
      kind: kindOf(raw.t),
      level: raw.l ?? null,
      depth: depthFromRoot,
      childrenCount: children.length,
      rollup: { agents, depth },
      action: action[id] ?? null,
      children,
    };
    built.set(id, node);
    return node;
  }

  const rootNodes = [...roots]
    .filter((id) => id in nodes)
    .sort()
    .map((id) => build(id, 0));

  let levelMismatches = 0;
  for (const node of built.values()) {
    if (node.level !== null && node.level !== node.depth) levelMismatches += 1;
  }
  if (levelMismatches > 0) {
    const maxLevel = Math.max(
      ...[...built.values()].map((node) => node.level ?? 0),
    );
    const maxEdgeDepth = Math.max(
      ...[...built.values()].map((node) => node.depth),
    );
    problems.push(
      `the portal's level field disagrees with parent-chain depth for ${levelMismatches} node(s) (max level ${maxLevel}, max edge depth ${maxEdgeDepth}); depth is taken from the edges`,
    );
  }

  const totalNodes = Object.keys(nodes).length;
  if (built.size !== totalNodes) {
    problems.push(
      `${totalNodes - built.size} node(s) are unreachable from any root`,
    );
  }

  return {
    roots: rootNodes,
    stats: {
      nodes: totalNodes,
      reachable: built.size,
      roots: rootNodes.length,
      unparented,
      maxDepth: rootNodes.reduce(
        (max, node) => Math.max(max, node.rollup.depth),
        0,
      ),
      levelMismatches,
      byKind,
    },
    problems,
  };
}
