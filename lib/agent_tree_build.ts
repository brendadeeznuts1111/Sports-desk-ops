/**
 * Reduce a cytoscape agent graph to the compact `data/agent-tree.json` file.
 * The live refresh stamps `live:f402-list-agents-by-agent`; an offline `--graph`
 * keeps the path it read, which KPI provenance treats as a fixture when it is
 * under `scratch/` or `tests/`.
 */

import { agentKeyOf, readHierarchyRows } from "./live_bets.ts";
import type { AgentTreeFile, AgentTreeWireNode } from "./agent_tree.ts";

export interface AgentTreeGraphInput {
  readonly nodes?: ReadonlyArray<{
    data?: { id?: unknown; level?: unknown };
  }>;
  readonly edges?: ReadonlyArray<{
    data?: { source?: unknown; target?: unknown };
  }>;
}

export interface AgentTreeBuildInput {
  readonly graph: AgentTreeGraphInput;
  /** list-agents envelope or a bare GENERAL array. Omit to keep types unset. */
  readonly hierarchy?: unknown;
  readonly source: string;
  readonly capturedAt?: string;
}

export function buildAgentTreeFileFromGraph(
  input: AgentTreeBuildInput,
): AgentTreeFile {
  const nodes = input.graph.nodes ?? [];
  const edges = input.graph.edges ?? [];
  if (nodes.length === 0) throw new Error("agent graph has no nodes");

  const rows = readHierarchyRows(input.hierarchy ?? []);
  const keyByAgentId = new Map<string, string>();
  const types = new Map<string, string | null>();
  const idsByKey = new Map<string, Set<string>>();
  for (const row of rows) {
    const agentId = String(row.AgentID ?? "").trim();
    const key = agentKeyOf(row);
    if (agentId === "" || key === "") continue;
    keyByAgentId.set(agentId, key);
    types.set(key, (row.AgentType as string | undefined) ?? null);
    const ids = idsByKey.get(key) ?? new Set<string>();
    ids.add(agentId);
    idsByKey.set(key, ids);
  }

  const collisions = [...idsByKey]
    .filter(([, ids]) => ids.size > 1)
    .map(([key, ids]) => ({ key, agentIds: [...ids].sort() }));
  const ambiguous = new Set(collisions.map((c) => c.key));

  const canonical = (agentId: string): string | null => {
    const key = keyByAgentId.get(agentId) ?? agentKeyOf({ AgentID: agentId });
    return key === "" ? null : key;
  };

  const levels = new Map<string, number | null>();
  for (const node of nodes) {
    const id = String(node.data?.id ?? "").trim();
    if (id === "") continue;
    const key = canonical(id);
    if (key === null) continue;
    const level = Number(node.data?.level);
    levels.set(key, Number.isFinite(level) ? level : null);
  }

  const parentOf = new Map<string, string>();
  for (const edge of edges) {
    const source = String(edge.data?.source ?? "").trim();
    const target = String(edge.data?.target ?? "").trim();
    if (source === "" || target === "") continue;
    const parent = canonical(source);
    const child = canonical(target);
    if (parent === null || child === null || parent === child) continue;
    if (parentOf.has(child)) continue;
    parentOf.set(child, parent);
    if (!levels.has(parent)) levels.set(parent, null);
    if (!levels.has(child)) levels.set(child, null);
  }

  const keys = [...levels.keys()].sort();
  const outNodes: Record<string, AgentTreeWireNode> = {};
  const roots: string[] = [];
  for (const key of keys) {
    const parent = parentOf.get(key) ?? null;
    if (parent === null) roots.push(key);
    const isAmbiguous = ambiguous.has(key);
    outNodes[key] = {
      l: isAmbiguous ? null : (levels.get(key) ?? null),
      p: parent,
      t: isAmbiguous ? null : (types.get(key) ?? null),
      ...(isAmbiguous ? { a: true as const } : {}),
    };
  }

  return {
    schemaVersion: 1,
    source: input.source,
    ...(input.capturedAt !== undefined ? { capturedAt: input.capturedAt } : {}),
    agentCount: keys.length,
    roots,
    collisions,
    nodes: outNodes,
  };
}

/** Identity index written beside the tree. `source` is the hierarchy the rows came from. */
export function agentIndexDocument(
  hierarchy: unknown,
  collisions: AgentTreeFile["collisions"],
  source: string | null,
): {
  schemaVersion: 1;
  source: string | null;
  agentCount: number;
  agents: Record<
    string,
    {
      i: string | string[];
      l: number | null;
      t: string | null;
      s: number | null;
    }
  >;
} {
  const rows = readHierarchyRows(hierarchy ?? []);
  const agents: Record<
    string,
    {
      i: string | string[];
      l: number | null;
      t: string | null;
      s: number | null;
    }
  > = {};
  for (const row of rows) {
    const key = agentKeyOf(row);
    if (key === "") continue;
    const id = String(row.AgentID ?? "").trim();
    const s = Number(row.SeqNumber);
    agents[key] = {
      i: id,
      l: Number.isFinite(Number(row.Level)) ? Number(row.Level) : null,
      t: (row.AgentType as string | undefined) ?? null,
      s: Number.isFinite(s) ? s : null,
    };
  }
  for (const collision of collisions ?? []) {
    const entry = agents[collision.key];
    agents[collision.key] = {
      i: [...collision.agentIds],
      l: null,
      t: null,
      s: entry?.s ?? null,
    };
  }
  return {
    schemaVersion: 1,
    source,
    agentCount: Object.keys(agents).length,
    agents,
  };
}
