/**
 * Layout engines → common `LaidOutGraph` coordinates for readability scoring.
 */

import cytoscape from "cytoscape";
import ELK from "elkjs/lib/elk.bundled.js";

import type { CytoscapeGraphExport } from "./f402_agent_graph.ts";
import {
  type GraphView,
  graphvizLayout,
  renderViewDot,
} from "./f402_agent_graph_dot.ts";
import type { LaidOutGraph } from "./f402_agent_graph_metrics.ts";
import { layoutLevelRows } from "./f402_agent_graph_svg.ts";

export type LayoutEngineName =
  | "level-rows"
  | "cytoscape-grid"
  | "cytoscape-breadthfirst"
  | "elk-mrtree"
  | "elk-layered"
  | "graphviz-dot"
  | "graphviz-dot-lr"
  | "graphviz-twopi";

export const LAYOUT_ENGINES: readonly LayoutEngineName[] = [
  "level-rows",
  "cytoscape-grid",
  "cytoscape-breadthfirst",
  "elk-mrtree",
  "elk-layered",
  "graphviz-dot",
  "graphviz-dot-lr",
  "graphviz-twopi",
];

/** Current capture page: 44px circles, 11px labels, grid in a 1920×1080 viewport. */
const CAPTURE_NODE = 44;
const CAPTURE_FONT = 11;
const BOX_H = 28;
const BOX_FONT = 11;

function boxWidth(label: string): number {
  return Math.max(48, label.length * 7 + 16);
}

function edgesOf(graph: CytoscapeGraphExport): LaidOutGraph["edges"] {
  return graph.edges.map((e) => ({
    source: e.data.source,
    target: e.data.target,
  }));
}

function rootsOf(graph: CytoscapeGraphExport): string[] {
  const targets = new Set(graph.edges.map((e) => e.data.target));
  return graph.nodes.map((n) => n.data.id).filter((id) => !targets.has(id));
}

function levelRows(graph: CytoscapeGraphExport): LaidOutGraph {
  const { pos, nodeW, nodeH } = layoutLevelRows(graph);
  return {
    nodes: [...pos].map(([id, p]) => ({
      id,
      x: p.x + nodeW / 2,
      y: p.y + nodeH / 2,
      w: nodeW,
      h: nodeH,
    })),
    edges: edgesOf(graph),
    fontSize: 11,
    flow: "down",
  };
}

function cytoscapeHeadless(
  graph: CytoscapeGraphExport,
  layout: cytoscape.LayoutOptions,
  nodeSize: (label: string) => { w: number; h: number },
  fontSize: number,
  flow: NonNullable<LaidOutGraph["flow"]>,
): LaidOutGraph {
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: [
      ...graph.nodes.map((n) => ({ data: { ...n.data, metrics: null } })),
      ...graph.edges.map((e) => ({ data: e.data })),
    ],
    style: [
      {
        selector: "node",
        style: {
          width: (el: cytoscape.NodeSingular) =>
            nodeSize(String(el.data("label"))).w,
          height: (el: cytoscape.NodeSingular) =>
            nodeSize(String(el.data("label"))).h,
        },
      },
    ],
  });
  cy.layout(layout).run();
  const nodes = cy.nodes().map((n: cytoscape.NodeSingular) => {
    const p = n.position();
    const s = nodeSize(String(n.data("label")));
    return { id: n.id(), x: p.x, y: p.y, w: s.w, h: s.h };
  });
  cy.destroy();
  return { nodes, edges: edgesOf(graph), fontSize, flow };
}

async function elkLayout(
  graph: CytoscapeGraphExport,
  algorithm: "mrtree" | "layered",
): Promise<LaidOutGraph> {
  const elk = new ELK();
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": algorithm,
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "8",
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.mrtree.searchOrder": "DFS",
    },
    children: graph.nodes.map((n) => ({
      id: n.data.id,
      width: boxWidth(n.data.label),
      height: BOX_H,
    })),
    edges: graph.edges.map((e) => ({
      id: e.data.id,
      sources: [e.data.source],
      targets: [e.data.target],
    })),
  });
  return {
    nodes: (res.children ?? []).map((c) => ({
      id: c.id,
      x: (c.x ?? 0) + (c.width ?? 0) / 2,
      y: (c.y ?? 0) + (c.height ?? 0) / 2,
      w: c.width ?? 0,
      h: c.height ?? 0,
    })),
    edges: edgesOf(graph),
    fontSize: BOX_FONT,
    flow: "down",
  };
}

function plainView(graph: CytoscapeGraphExport): GraphView {
  return {
    id: "benchmark",
    title: "",
    focusId: null,
    nodes: graph.nodes.map((n) => ({
      kind: "agent" as const,
      id: n.data.id,
      label: n.data.label,
      level: n.data.level,
      branchId: "",
      subtreeSize: 1,
      hiddenDescendants: 0,
      overflowCount: 0,
    })),
    edges: edgesOf(graph),
    branchColors: {},
  };
}

export async function runLayoutEngine(
  engine: LayoutEngineName,
  graph: CytoscapeGraphExport,
): Promise<LaidOutGraph> {
  switch (engine) {
    case "level-rows":
      return levelRows(graph);
    case "cytoscape-grid":
      return cytoscapeHeadless(
        graph,
        {
          name: "grid",
          padding: 48,
          avoidOverlap: true,
          avoidOverlapPadding: 12,
          boundingBox: { x1: 0, y1: 0, w: 1920, h: 1080 },
        } as cytoscape.LayoutOptions,
        () => ({ w: CAPTURE_NODE, h: CAPTURE_NODE }),
        CAPTURE_FONT,
        "down",
      );
    case "cytoscape-breadthfirst":
      return cytoscapeHeadless(
        graph,
        {
          name: "breadthfirst",
          directed: true,
          roots: rootsOf(graph),
          spacingFactor: 1,
          avoidOverlap: true,
        } as cytoscape.LayoutOptions,
        (label) => ({ w: boxWidth(label), h: BOX_H }),
        BOX_FONT,
        "down",
      );
    case "elk-mrtree":
      return elkLayout(graph, "mrtree");
    case "elk-layered":
      return elkLayout(graph, "layered");
    case "graphviz-dot":
    case "graphviz-dot-lr":
    case "graphviz-twopi": {
      const gv = engine === "graphviz-twopi" ? "twopi" : "dot";
      const rankdir = engine === "graphviz-dot-lr" ? "LR" : "TB";
      const dot = renderViewDot(plainView(graph), {
        engine: gv,
        legend: false,
        rankdir,
      });
      const laid = await graphvizLayout(gv, dot, edgesOf(graph), 12);
      return {
        ...laid,
        flow:
          engine === "graphviz-twopi"
            ? "radial"
            : rankdir === "LR"
              ? "right"
              : "down",
      };
    }
  }
}
