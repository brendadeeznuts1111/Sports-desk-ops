/**
 * Readable small-multiple views over the structural agent tree.
 * Each view expands its focus level by level until a visual budget is reached; nodes
 * on the frontier carry `+N` badges and become the focus of their own view, so every
 * agent is drawn in at least one view.
 */

import type { CytoscapeGraphExport } from "./f402_agent_graph.ts";
import {
  type AgentViewNode,
  BRANCH_PALETTE,
  type GraphView,
  type GraphViewNode,
  type LeafBundleNode,
  UNBRANCHED_COLOR,
} from "./f402_agent_graph_dot.ts";
import type { ReadabilityMetrics } from "./f402_agent_graph_metrics.ts";
import {
  type AgentTree,
  type AgentTreeNode,
  ancestorsOf,
  type ParentDivergence,
} from "./f402_agent_tree.ts";

export const AGENT_GRAPH_VIEWS_DIR = "agent-graph-views";

export interface AgentGraphViewIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly focusId: string | null;
  readonly parentViewId: string | null;
  readonly boxes: number;
  readonly agentsShown: number;
  readonly hidden: number;
  readonly frontier: readonly string[];
  readonly svg: string;
  readonly webp: string;
  readonly webpWidth: number;
  readonly webpHeight: number;
  readonly metrics: ReadabilityMetrics;
}

export interface AgentGraphViewIndex {
  readonly version: 1;
  readonly envelopeSha256: string;
  readonly generatedAt: string;
  readonly options: ViewBuildOptions & { readonly rankdir: "TB" | "LR" };
  readonly coverage: { readonly agents: number; readonly covered: number };
  readonly reconciled: boolean;
  readonly overflowTotal: number;
  readonly overflowDrawn: number;
  readonly radial: { readonly svg: string; readonly webp: string } | null;
  /** Agent id → id of the view where it is drawn with its children (or as a leaf). */
  readonly agentView: Readonly<Record<string, string>>;
  readonly views: readonly AgentGraphViewIndexEntry[];
  readonly parentDivergence: {
    readonly count: number;
    readonly byLevel: Readonly<Record<number, number>>;
    readonly samples: readonly ParentDivergence[];
  };
}

export interface ViewBuildOptions {
  /** Visual weight per view: agent box = 1, leaf table = 1 + ⌊n / 12⌋. */
  readonly budget: number;
  /** Bundle a parent's leaf children into one table when there are at least this many. */
  readonly leafBundleMin: number;
}

/** Chosen from the budget × rankdir sweep: fewest views with worst font ≥ 11px (LR). */
export const DEFAULT_VIEW_OPTIONS: ViewBuildOptions = {
  budget: 140,
  leafBundleMin: 3,
};
export const DEFAULT_VIEW_RANKDIR = "LR" as const;

export function treeToCytoscapeExport(tree: AgentTree): CytoscapeGraphExport {
  const nodes = [...tree.nodes.values()].map((n) => ({
    data: { id: n.id, label: n.login, level: n.level, seqNumber: null, metrics: null },
  }));
  const edges = [...tree.nodes.values()]
    .filter((n) => n.parentId !== null)
    .map((n) => ({
      data: {
        id: `${n.parentId}->${n.id}`,
        source: n.parentId as string,
        target: n.id,
      },
    }));
  return { nodes, edges };
}

export interface StructuralNodeData {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  /** Not `parent`: Cytoscape reads `data.parent` as a compound-node container. */
  readonly upline: string | null;
  readonly branch: string;
  readonly color: string;
  readonly subtree: number;
  readonly overflow: number;
  readonly childCount: number;
}

export interface StructuralGraphExport {
  readonly nodes: readonly { readonly data: StructuralNodeData }[];
  readonly edges: readonly {
    readonly data: { id: string; source: string; target: string };
  }[];
}

/** Cytoscape-ready structural graph with encodings precomputed (served to browser pages). */
export function structuralGraphExport(tree: AgentTree): StructuralGraphExport {
  const colors = branchColors(tree);
  const base = treeToCytoscapeExport(tree);
  return {
    nodes: [...tree.nodes.values()].map((n) => ({
      data: {
        id: n.id,
        label: n.login,
        level: n.level,
        upline: n.parentId,
        branch: n.branchId,
        color: colors[n.branchId] ?? UNBRANCHED_COLOR,
        subtree: n.descendantCount + 1,
        overflow: n.overflowCount,
        childCount: n.children.length,
      },
    })),
    edges: base.edges,
  };
}

/** One focus view as Cytoscape elements (for the WebView capture raster). */
export function focusViewCytoscapeExport(fv: FocusView): StructuralGraphExport {
  const nodes = fv.view.nodes.map((n) => {
    const color = fv.view.branchColors[n.branchId] ?? UNBRANCHED_COLOR;
    if (n.kind === "leaves") {
      const overflow = Object.values(n.overflowByAgent).reduce(
        (s, x) => s + x,
        0,
      );
      return {
        data: {
          id: n.id,
          label: `${n.logins.length} leaf agents`,
          level: n.level,
          upline: n.parentId,
          branch: n.branchId,
          color,
          subtree: n.logins.length,
          overflow,
          childCount: 0,
        },
      };
    }
    const extra =
      n.hiddenDescendants > 0 ? `\n+${n.hiddenDescendants} below` : "";
    return {
      data: {
        id: n.id,
        label: `${n.label}${extra}`,
        level: n.level,
        upline: null,
        branch: n.branchId,
        color,
        subtree: n.subtreeSize,
        overflow: n.overflowCount,
        childCount: 0,
      },
    };
  });
  return {
    nodes,
    edges: fv.view.edges.map((e) => ({
      data: {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
      },
    })),
  };
}

export function branchColors(tree: AgentTree): Record<string, string> {
  const branches = [...tree.nodes.values()]
    .filter((n) => n.level === 2)
    .sort(
      (a, b) =>
        b.descendantCount - a.descendantCount || a.id.localeCompare(b.id),
    );
  const out: Record<string, string> = {};
  branches.forEach((b, i) => {
    out[b.id] = BRANCH_PALETTE[i % BRANCH_PALETTE.length]!;
  });
  return out;
}

function isLeaf(n: AgentTreeNode): boolean {
  return n.children.length === 0;
}

function bundleWeight(count: number): number {
  return 1 + Math.floor(count / 12);
}

/** Weight of drawing `parents`' children as one more level. */
function levelWeight(
  tree: AgentTree,
  parents: readonly AgentTreeNode[],
  opts: ViewBuildOptions,
): number {
  let w = 0;
  for (const p of parents) {
    const kids = p.children.map((id) => tree.nodes.get(id)!);
    const leaves = kids.filter(isLeaf).length;
    if (leaves >= opts.leafBundleMin)
      w += bundleWeight(leaves) + (kids.length - leaves);
    else w += kids.length;
  }
  return w;
}

export interface FocusView {
  readonly view: GraphView;
  /** Agents drawn in this view (boxes + leaf-table rows). */
  readonly shownAgentIds: readonly string[];
  /** Frontier agents with hidden descendants → their own views. */
  readonly frontier: readonly string[];
  readonly reconciliation: {
    readonly focusSubtree: number;
    readonly shown: number;
    readonly hidden: number;
  };
}

export function viewIdFor(focusId: string | null): string {
  return focusId === null ? "overview" : `agent-${focusId}`;
}

/** Agent ids may contain `/`, `$`, `%`; file names must match the viewer's safe-name pattern. */
export function viewFileBase(viewId: string): string {
  const safe = viewId.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe === viewId ? safe : `${safe}-${Bun.hash(viewId).toString(36)}`;
}

export function buildFocusView(
  tree: AgentTree,
  focusId: string | null,
  colors: Readonly<Record<string, string>>,
  opts: ViewBuildOptions = DEFAULT_VIEW_OPTIONS,
): FocusView {
  const start =
    focusId === null
      ? tree.roots.map((id) => tree.nodes.get(id)!)
      : [tree.nodes.get(focusId) ?? missing(focusId)];
  // Best-first: always open the cheapest frontier node that still fits, so small
  // subtrees are absorbed whole and only heavy branches spill into their own views.
  // The focus level is always opened, even past the budget.
  const expanded = new Set<string>();
  const open = (n: AgentTreeNode): AgentTreeNode[] => {
    expanded.add(n.id);
    return n.children
      .map((id) => tree.nodes.get(id)!)
      .filter((c) => c.children.length > 0);
  };
  let weight = start.length;
  let candidates: AgentTreeNode[] = [];
  for (const s of start) {
    if (s.children.length === 0) continue;
    weight += levelWeight(tree, [s], opts);
    candidates.push(...open(s));
  }
  for (;;) {
    let best: AgentTreeNode | undefined;
    let bestW = Infinity;
    for (const c of candidates) {
      const w = levelWeight(tree, [c], opts);
      if (w < bestW || (w === bestW && best !== undefined && c.id < best.id)) {
        best = c;
        bestW = w;
      }
    }
    if (best === undefined || weight + bestW > opts.budget) break;
    weight += bestW;
    candidates = candidates.filter((c) => c !== best).concat(open(best));
  }

  const nodes: GraphViewNode[] = [];
  const edges: { source: string; target: string }[] = [];
  const shown: string[] = [];
  const nextFoci: string[] = [];
  let hidden = 0;

  const agentNode = (n: AgentTreeNode): AgentViewNode => {
    const isHidden = !expanded.has(n.id) && n.children.length > 0;
    if (isHidden) {
      hidden += n.descendantCount;
      nextFoci.push(n.id);
    }
    return {
      kind: "agent",
      id: n.id,
      label: n.login,
      level: n.level,
      branchId: n.branchId,
      subtreeSize: n.descendantCount + 1,
      hiddenDescendants: isHidden ? n.descendantCount : 0,
      overflowCount: n.overflowCount,
    };
  };

  const visit = (n: AgentTreeNode): void => {
    nodes.push(agentNode(n));
    shown.push(n.id);
    if (!expanded.has(n.id)) return;
    const kids = n.children.map((id) => tree.nodes.get(id)!);
    const leaves = kids.filter(isLeaf);
    const bundle = leaves.length >= opts.leafBundleMin;
    if (bundle) {
      const sorted = [...leaves].sort((a, b) => a.login.localeCompare(b.login));
      const overflowByAgent: Record<string, number> = {};
      for (const l of sorted)
        if (l.overflowCount > 0) overflowByAgent[l.id] = l.overflowCount;
      const leafNode: LeafBundleNode = {
        kind: "leaves",
        id: `__leaves_${n.id}`,
        parentId: n.id,
        level: n.level + 1,
        branchId: sorted[0]?.branchId ?? n.branchId,
        logins: sorted.map((l) => l.login),
        agentIds: sorted.map((l) => l.id),
        overflowByAgent,
      };
      nodes.push(leafNode);
      edges.push({ source: n.id, target: leafNode.id });
      shown.push(...leafNode.agentIds);
    }
    for (const k of kids) {
      if (bundle && isLeaf(k)) continue;
      edges.push({ source: n.id, target: k.id });
      visit(k);
    }
  };
  for (const s of start) visit(s);

  const focusSubtree =
    focusId === null
      ? tree.nodes.size
      : (tree.nodes.get(focusId)?.descendantCount ?? 0) + 1;
  const focusNode = focusId === null ? null : tree.nodes.get(focusId)!;
  const title =
    focusNode === null
      ? `F402 downline overview · ${tree.nodes.size} agents`
      : [
          `${focusNode.login} · level ${focusNode.level} · ${focusSubtree} agent${focusSubtree === 1 ? "" : "s"} in subtree`,
          `upline: ${[...ancestorsOf(tree, focusNode.id), focusNode].map((a) => a.login).join(" > ")}`,
        ].join("\n");

  return {
    view: {
      id: viewIdFor(focusId),
      title,
      focusId,
      nodes,
      edges,
      branchColors: colors,
    },
    shownAgentIds: shown,
    frontier: nextFoci,
    reconciliation: { focusSubtree, shown: shown.length, hidden },
  };
}

function missing(id: string): never {
  throw new Error(`Unknown agent ${id}`);
}

export interface ViewSetEntry extends FocusView {
  readonly parentViewId: string | null;
}

export interface ViewSet {
  readonly views: readonly ViewSetEntry[];
  readonly coverage: { readonly agents: number; readonly covered: number };
  /** Agent id → view where the agent is drawn expanded (its own view if it was a frontier). */
  readonly agentView: Readonly<Record<string, string>>;
}

/** Overview + recursive frontier views until every agent appears in some view. */
export function buildViewSet(
  tree: AgentTree,
  opts: ViewBuildOptions = DEFAULT_VIEW_OPTIONS,
): ViewSet {
  const colors = branchColors(tree);
  const views: ViewSetEntry[] = [];
  const covered = new Set<string>();
  const agentView: Record<string, string> = {};
  const queue: { focus: string | null; parent: string | null }[] = [
    { focus: null, parent: null },
  ];
  while (queue.length > 0) {
    const { focus, parent } = queue.shift()!;
    const fv = buildFocusView(tree, focus, colors, opts);
    views.push({ ...fv, parentViewId: parent });
    const frontier = new Set(fv.frontier);
    for (const id of fv.shownAgentIds) {
      covered.add(id);
      if (!frontier.has(id) && agentView[id] === undefined)
        agentView[id] = fv.view.id;
    }
    for (const f of fv.frontier) queue.push({ focus: f, parent: fv.view.id });
  }
  return {
    views,
    coverage: { agents: tree.nodes.size, covered: covered.size },
    agentView,
  };
}

/** Every view must account for its whole focus subtree: shown + hidden badges = subtree. */
export function viewReconciles(fv: FocusView): boolean {
  const r = fv.reconciliation;
  return r.shown + r.hidden === r.focusSubtree;
}

/** Sum of overflow markers over distinct agents drawn anywhere in the view set. */
export function overflowDrawnTotal(tree: AgentTree, set: ViewSet): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const fv of set.views) {
    for (const id of fv.shownAgentIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      sum += tree.nodes.get(id)?.overflowCount ?? 0;
    }
  }
  return sum;
}
