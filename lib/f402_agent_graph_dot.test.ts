import { describe, expect, test } from "bun:test";

import {
  OVERFLOW_COLOR,
  graphvizLayout,
  renderViewDot,
} from "./f402_agent_graph_dot.ts";
import { scoreLayout } from "./f402_agent_graph_metrics.ts";
import { branchColors, buildFocusView } from "./f402_agent_graph_views.ts";
import { buildAgentTreeFromGeneral } from "./f402_agent_tree.ts";

const row = (AgentID: string, Level: number) => ({
  AgentID,
  Login: AgentID,
  Level,
});

function view() {
  const tree = buildAgentTreeFromGeneral(
    [
      row("R", 1),
      row("A", 2),
      row('Q"UOTE', 3),
      row("QC", 4),
      row("L1", 3),
      row("L2", 3),
      row("L3", 3),
      row("OV", 4),
      row("OV2", 5),
    ],
    4,
  );
  return buildFocusView(tree, null, branchColors(tree), {
    budget: 50,
    leafBundleMin: 3,
  }).view;
}

describe("renderViewDot", () => {
  test("escapes quotes, emits real line breaks, legend, overflow marker", () => {
    const dot = renderViewDot(view(), { rankdir: "LR" });
    expect(dot).toContain("rankdir=LR");
    expect(dot).toContain('Q\\"UOTE');
    expect(dot).toContain("\\nL3 · 2 agents");
    expect(dot).not.toContain("\\\\n");
    expect(dot).toContain("__legend");
    expect(dot).toContain(OVERFLOW_COLOR);
    expect(dot).toContain("leaf agents");
  });

  test.skipIf(Bun.which("dot") === null)(
    "Graphviz layout of a tree view has no crossings",
    async () => {
      const v = view();
      const laid = await graphvizLayout(
        "dot",
        renderViewDot(v, { rankdir: "LR", legend: false }),
        v.edges,
        12,
      );
      expect(laid.nodes.length).toBe(v.nodes.length);
      const m = scoreLayout(
        { ...laid, flow: "right" },
        { width: 2400, height: 4800 },
      );
      expect(m.crossings).toBe(0);
      expect(m.overlaps).toBe(0);
      expect(m.againstFlowEdgeShare).toBe(0);
    },
  );
});
