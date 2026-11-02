import { describe, expect, test } from "bun:test";

import {
  branchColors,
  buildFocusView,
  buildViewSet,
  overflowDrawnTotal,
  structuralGraphExport,
  viewFileBase,
  viewReconciles,
} from "./f402_agent_graph_views.ts";
import { buildAgentTreeFromGeneral } from "./f402_agent_tree.ts";

const row = (AgentID: string, Level: number) => ({
  AgentID,
  Login: AgentID,
  Level,
});

/** R → {A → (A1..A6 leaves, AX → AX1..AX3 → overflow), B → B1 → B2 → B3}; S root singleton. */
function fixture() {
  const rows = [row("R", 1), row("A", 2)];
  for (let i = 1; i <= 6; i++) rows.push(row(`A${i}`, 3));
  rows.push(
    row("AX", 3),
    row("AX1", 4),
    row("AX2", 4),
    row("AX3", 4),
    row("OV", 5),
  );
  rows.push(row("B", 2), row("B1", 3), row("B2", 4), row("B3", 5));
  rows.push(row("S", 1));
  return buildAgentTreeFromGeneral(rows, 4);
}

describe("agent graph views", () => {
  test("small budget spills into frontier views and every view reconciles", () => {
    const tree = fixture();
    const set = buildViewSet(tree, { budget: 4, leafBundleMin: 3 });
    expect(set.views.length).toBeGreaterThan(1);
    expect(set.views.every(viewReconciles)).toBe(true);
    expect(set.coverage).toEqual({
      agents: tree.nodes.size,
      covered: tree.nodes.size,
    });
    expect(overflowDrawnTotal(tree, set)).toBe(tree.overflowTotal);
    for (const v of set.views.slice(1)) expect(v.parentViewId).not.toBeNull();
  });

  test("large budget yields one overview with leaf bundles", () => {
    const tree = fixture();
    const set = buildViewSet(tree, { budget: 100, leafBundleMin: 3 });
    expect(set.views.length).toBe(1);
    const bundles = set.views[0]!.view.nodes.filter((n) => n.kind === "leaves");
    expect(bundles.map((b) => b.id).sort()).toEqual([
      "__leaves_A",
      "__leaves_AX",
    ]);
    const a = bundles.find((b) => b.id === "__leaves_A");
    expect(a?.kind === "leaves" && a.logins.length).toBe(6);
    const ax = bundles.find((b) => b.id === "__leaves_AX");
    expect(ax?.kind === "leaves" && ax.overflowByAgent).toEqual({ AX3: 1 });
    expect(set.views[0]!.reconciliation).toEqual({
      focusSubtree: tree.nodes.size,
      shown: tree.nodes.size,
      hidden: 0,
    });
  });

  test("focus view of a subtree counts hidden descendants in +N badges", () => {
    const tree = fixture();
    const fv = buildFocusView(tree, "R", branchColors(tree), {
      budget: 2,
      leafBundleMin: 3,
    });
    expect(viewReconciles(fv)).toBe(true);
    const hidden = fv.view.nodes.filter(
      (n) => n.kind === "agent" && n.hiddenDescendants > 0,
    );
    expect(hidden.length).toBeGreaterThan(0);
    expect(fv.frontier.length).toBe(hidden.length);
  });

  test("focus view title carries the full upline chain", () => {
    const tree = fixture();
    const fv = buildFocusView(tree, "B2", branchColors(tree), {
      budget: 10,
      leafBundleMin: 3,
    });
    expect(fv.view.title).toBe(
      "B2 · level 4 · 1 agent in subtree\nupline: R > B > B1 > B2",
    );
  });

  test("view file names are path-safe and collision-resistant", () => {
    expect(viewFileBase("agent-AB1")).toBe("agent-AB1");
    const a = viewFileBase("agent-XY/ZZ");
    const b = viewFileBase("agent-XY$ZZ");
    expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(a).not.toBe(b);
  });

  test("structural export colors by level-2 branch", () => {
    const tree = fixture();
    const g = structuralGraphExport(tree);
    const colors = branchColors(tree);
    expect(g.nodes.find((n) => n.data.id === "AX1")?.data.color).toBe(
      colors["A"],
    );
    expect(g.edges.length).toBe(tree.nodes.size - tree.roots.length);
  });
});
