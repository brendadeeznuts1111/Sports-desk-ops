import { describe, expect, test } from "bun:test";

import {
  type LaidOutGraph,
  scoreLayout,
  segmentsCross,
} from "./f402_agent_graph_metrics.ts";

const box = (id: string, x: number, y: number) => ({ id, x, y, w: 10, h: 10 });

describe("segmentsCross", () => {
  const seg = (
    a: string,
    b: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => ({
    a,
    b,
    x1,
    y1,
    x2,
    y2,
  });
  test("proper X crossing counts", () => {
    expect(
      segmentsCross(seg("a", "b", 0, 0, 10, 10), seg("c", "d", 0, 10, 10, 0)),
    ).toBe(true);
  });
  test("shared endpoint and parallel segments do not", () => {
    expect(
      segmentsCross(seg("a", "b", 0, 0, 10, 10), seg("a", "d", 0, 0, 10, 0)),
    ).toBe(false);
    expect(
      segmentsCross(seg("a", "b", 0, 0, 10, 0), seg("c", "d", 0, 5, 10, 5)),
    ).toBe(false);
  });
});

describe("scoreLayout", () => {
  test("K2,2 drawn crossed has exactly one crossing", () => {
    const g: LaidOutGraph = {
      nodes: [
        box("p", 0, 0),
        box("q", 100, 0),
        box("r", 0, 100),
        box("s", 100, 100),
      ],
      edges: [
        { source: "p", target: "s" },
        { source: "q", target: "r" },
      ],
      fontSize: 10,
      flow: "down",
    };
    const m = scoreLayout(g, { width: 110, height: 110 });
    expect(m.crossings).toBe(1);
    expect(m.overlaps).toBe(0);
    expect(m.againstFlowEdgeShare).toBe(0);
    expect(m.widestRow).toBe(2);
    expect(m.effectiveFontPx).toBe(10);
  });

  test("overlaps, flow direction, and fit scale", () => {
    const g: LaidOutGraph = {
      nodes: [box("a", 0, 0), box("b", 5, 0), box("c", 1000, 0)],
      edges: [
        { source: "a", target: "c" },
        { source: "c", target: "b" },
      ],
      fontSize: 12,
      flow: "right",
    };
    const m = scoreLayout(g, { width: 101, height: 1000 });
    expect(m.overlaps).toBe(1);
    expect(m.againstFlowEdgeShare).toBe(0.5);
    expect(m.fitScale).toBeCloseTo(0.1, 2);
    expect(m.effectiveFontPx).toBeCloseTo(1.2, 1);
  });

  test("radial flow skips direction check", () => {
    const m = scoreLayout(
      { nodes: [box("a", 0, 0)], edges: [], fontSize: 12, flow: "radial" },
      { width: 100, height: 100 },
    );
    expect(m.againstFlowEdgeShare).toBeNull();
  });
});
