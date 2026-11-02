/**
 * @file agent_tree.ts
 * @description Parent/child index over the portal agent forest, keyed by the canonical
 * `agentLoginKey` (trimmed + upper-cased) so a wager's agent always resolves.
 *
 * The wire file is deliberately compact — 2.2k agents in `data/agent-tree.json`:
 * `{ "KEY": { "l": level, "p": parent, "t": agentType } }`.
 *
 * Invariants enforced here rather than trusted from the file:
 *  - no cycles (a malformed parent pointer must fail loudly, not hang a renderer)
 *  - no duplicate children
 *  - a parent that is not itself a node is reported, not silently invented
 */

import { agentKeyOf, type AgentKey } from "./live_bets.ts";
import type { ListAgentsByAgentGeneralWireRow } from "./f402_list_agents_by_agent.ts";

export interface AgentTreeWireNode {
  /** `GENERAL.Level` */
  readonly l: number | null;
  /** Parent key, or null for a root. */
  readonly p: string | null;
  /** `GENERAL.AgentType` */
  readonly t: string | null;
  /** True when several `AgentID`s normalise to this key: no level can be attributed. */
  readonly a?: boolean;
}

export interface AgentTreeFile {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly agentCount: number;
  readonly roots: readonly string[];
  /** Canonical keys owned by more than one `AgentID`; those nodes are flagged, never levelled. */
  readonly collisions?: readonly {
    readonly key: string;
    readonly agentIds: readonly string[];
  }[];
  readonly nodes: Readonly<Record<string, AgentTreeWireNode>>;
}

export interface AgentNode {
  readonly key: AgentKey;
  readonly level: number | null;
  readonly agentType: string | null;
  readonly parent: AgentKey | null;
  readonly children: readonly AgentKey[];
  /** Identity is shared by several `AgentID`s; the node renders but carries no level. */
  readonly ambiguous: boolean;
}

export interface AgentTree {
  readonly roots: readonly AgentKey[];
  readonly nodes: ReadonlyMap<AgentKey, AgentNode>;
}

export interface AgentTreeSummary {
  readonly agents: number;
  readonly roots: number;
  readonly leaves: number;
  /** Longest root-to-leaf chain. */
  readonly depth: number;
}

/** Structural problems that make the tree untrustworthy. */
export interface AgentTreeProblems {
  readonly cycles: readonly AgentKey[][];
  readonly missingParents: readonly AgentKey[];
}

export function readAgentTreeFile(payload: unknown): AgentTreeFile | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Partial<AgentTreeFile>;
  if (record.schemaVersion !== 1) return null;
  if (typeof record.nodes !== "object" || record.nodes === null) return null;
  return {
    schemaVersion: 1,
    source: typeof record.source === "string" ? record.source : "",
    agentCount:
      typeof record.agentCount === "number"
        ? record.agentCount
        : Object.keys(record.nodes).length,
    roots: Array.isArray(record.roots) ? record.roots.map(String) : [],
    nodes: record.nodes,
  };
}

/**
 * Builds the in-memory tree. Cycles and missing parents are returned rather than thrown so a
 * caller can decide: the server renders what is consistent and reports the rest.
 */
export function buildAgentTree(file: AgentTreeFile): {
  tree: AgentTree;
  problems: AgentTreeProblems;
} {
  const nodes = new Map<AgentKey, AgentNode>();
  const childrenOf = new Map<AgentKey, AgentKey[]>();

  const entries = Object.entries(file.nodes).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [rawKey, wire] of entries) {
    const key = agentKeyOf({ AgentID: rawKey });
    if (key === "") continue;

    const parent =
      wire.p === null || wire.p === undefined || String(wire.p).trim() === ""
        ? null
        : agentKeyOf({ AgentID: String(wire.p) });

    const ambiguous = wire.a === true;
    nodes.set(key, {
      key,
      level:
        !ambiguous && typeof wire.l === "number" && Number.isFinite(wire.l)
          ? wire.l
          : null,
      agentType: ambiguous ? null : (wire.t ?? null),
      parent,
      children: [],
      ambiguous,
    });
  }

  const missingParents = new Set<AgentKey>();
  for (const node of nodes.values()) {
    if (node.parent === null) continue;
    if (!nodes.has(node.parent)) {
      missingParents.add(node.parent);
      continue;
    }
    const siblings = childrenOf.get(node.parent) ?? [];
    if (!siblings.includes(node.key)) siblings.push(node.key);
    childrenOf.set(node.parent, siblings);
  }

  for (const [parent, children] of childrenOf) {
    const node = nodes.get(parent);
    if (node !== undefined) {
      nodes.set(parent, { ...node, children: [...children].sort() });
    }
  }

  const cycles = findCycles(nodes);
  const roots = [...nodes.values()]
    .filter((node) => node.parent === null)
    .map((node) => node.key)
    .sort();

  return {
    tree: { roots, nodes },
    problems: { cycles, missingParents: [...missingParents].sort() },
  };
}

/** Walks parent pointers from every node; any node revisited within one walk is a cycle. */
function findCycles(nodes: ReadonlyMap<AgentKey, AgentNode>): AgentKey[][] {
  const settled = new Set<AgentKey>();
  const cycles: AgentKey[][] = [];

  for (const start of nodes.keys()) {
    if (settled.has(start)) continue;
    const path: AgentKey[] = [];
    const onPath = new Map<AgentKey, number>();
    let current: AgentKey | null = start;

    while (current !== null) {
      const seenAt = onPath.get(current);
      if (seenAt !== undefined) {
        cycles.push(path.slice(seenAt));
        break;
      }
      if (settled.has(current)) break;
      onPath.set(current, path.length);
      path.push(current);
      current = nodes.get(current)?.parent ?? null;
    }
    for (const key of path) settled.add(key);
  }
  return cycles;
}

export function summarizeTree(
  file: AgentTreeFile | AgentTree,
): AgentTreeSummary {
  const tree =
    file instanceof Object && "nodes" in file && file.nodes instanceof Map
      ? (file as AgentTree)
      : buildAgentTree(file as AgentTreeFile).tree;

  let leaves = 0;
  for (const node of tree.nodes.values()) {
    if (node.children.length === 0) leaves += 1;
  }

  let depth = 0;
  for (const root of tree.roots) {
    depth = Math.max(depth, longestChain(tree, root));
  }

  return { agents: tree.nodes.size, roots: tree.roots.length, leaves, depth };
}

function longestChain(tree: AgentTree, root: AgentKey): number {
  let best = 0;
  const stack: Array<{ key: AgentKey; depth: number }> = [
    { key: root, depth: 1 },
  ];
  const seen = new Set<AgentKey>();

  while (stack.length > 0) {
    const { key, depth } = stack.pop() as { key: AgentKey; depth: number };
    if (seen.has(key)) continue;
    seen.add(key);
    best = Math.max(best, depth);
    for (const child of tree.nodes.get(key)?.children ?? []) {
      stack.push({ key: child, depth: depth + 1 });
    }
  }
  return best;
}

/** The key plus every descendant — the scope "this agent and everyone under them". */
export function subtreeKeys(tree: AgentTree, root: AgentKey): Set<AgentKey> {
  const out = new Set<AgentKey>();
  const stack: AgentKey[] = [root];
  while (stack.length > 0) {
    const key = stack.pop() as AgentKey;
    if (out.has(key)) continue;
    out.add(key);
    for (const child of tree.nodes.get(key)?.children ?? []) stack.push(child);
  }
  return out;
}

/**
 * Case-insensitive search that also returns the ancestors of every hit, so a match stays
 * reachable in a collapsed tree instead of appearing from nowhere.
 */
export function searchTree(tree: AgentTree, query: string): Set<AgentKey> {
  const needle = query.trim().toUpperCase();
  if (needle === "") return new Set(tree.nodes.keys());

  const visible = new Set<AgentKey>();
  for (const node of tree.nodes.values()) {
    if (!String(node.key).includes(needle)) continue;
    visible.add(node.key);
    let parent = node.parent;
    let guard = 0;
    while (parent !== null && guard < 64) {
      visible.add(parent);
      parent = tree.nodes.get(parent)?.parent ?? null;
      guard += 1;
    }
  }
  return visible;
}

/** Applies captured `AgentType` values to a tree that was built without them. */
export function withAgentTypes(
  file: AgentTreeFile,
  rows: readonly ListAgentsByAgentGeneralWireRow[],
): AgentTreeFile {
  const types = new Map<string, string>();
  for (const row of rows) {
    const key = agentKeyOf(row);
    const type = row.AgentType;
    if (key !== "" && typeof type === "string" && type !== "") {
      types.set(key, type);
    }
  }
  if (types.size === 0) return file;

  const nodes: Record<string, AgentTreeWireNode> = {};
  for (const [key, wire] of Object.entries(file.nodes)) {
    nodes[key] = { ...wire, t: wire.t ?? types.get(key) ?? null };
  }
  return { ...file, nodes };
}
