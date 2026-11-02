import { describe, expect, test } from "bun:test";

import {
  countPairs,
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

describe("countPairs", () => {
  type Rect = { x: number; y: number; w: number; h: number };
  const bounds = (r: Rect) => ({
    minX: r.x - r.w / 2,
    maxX: r.x + r.w / 2,
    minY: r.y - r.h / 2,
    maxY: r.y + r.h / 2,
  });
  const overlap = (p: Rect, q: Rect) =>
    Math.abs(p.x - q.x) * 2 < p.w + q.w && Math.abs(p.y - q.y) * 2 < p.h + q.h;
  const bruteForce = (rects: Rect[]) => {
    let n = 0;
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        if (overlap(rects[i]!, rects[j]!)) n += 1;
    return n;
  };

  test("empty and single inputs have no pairs", () => {
    expect(countPairs([], bounds, overlap, 10)).toBe(0);
    expect(countPairs([{ x: 0, y: 0, w: 5, h: 5 }], bounds, overlap, 10)).toBe(
      0,
    );
  });

  test("a pair sharing many cells counts once", () => {
    const r = { x: -3, y: -3, w: 40, h: 40 };
    expect(countPairs([r, { ...r }, { ...r }], bounds, overlap, 1)).toBe(3);
  });

  test("matches brute force on seeded random layouts with negative coordinates", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let t = 0; t < 50; t++) {
      const rects = Array.from({ length: 2 + Math.floor(rnd() * 120) }, () => ({
        x: rnd() * 400 - 200,
        y: rnd() * 400 - 200,
        w: 1 + rnd() * 40,
        h: 1 + rnd() * 40,
      }));
      const cell = 1 + rnd() * 30;
      expect(countPairs(rects, bounds, overlap, cell)).toBe(bruteForce(rects));
    }
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
