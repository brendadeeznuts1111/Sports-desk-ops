import { describe, expect, test } from "bun:test";

import {
  countPairs,
  laidOutGraph,
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
  const boxesOf = (rects: readonly Rect[]) =>
    Float64Array.from(
      rects.flatMap((r) => [
        r.x - r.w / 2,
        r.y - r.h / 2,
        r.x + r.w / 2,
        r.y + r.h / 2,
      ]),
    );
  const overlap = (p: Rect, q: Rect) =>
    Math.abs(p.x - q.x) * 2 < p.w + q.w && Math.abs(p.y - q.y) * 2 < p.h + q.h;
  const count = (rects: readonly Rect[], cell: number) =>
    countPairs(boxesOf(rects), (i, j) => overlap(rects[i]!, rects[j]!), cell);
  const bruteForce = (rects: Rect[]) => {
    let n = 0;
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        if (overlap(rects[i]!, rects[j]!)) n += 1;
    return n;
  };

  test("empty and single inputs have no pairs", () => {
    expect(count([], 10)).toBe(0);
    expect(count([{ x: 0, y: 0, w: 5, h: 5 }], 10)).toBe(0);
  });

  test("a pair sharing many cells counts once", () => {
    const r = { x: -3, y: -3, w: 40, h: 40 };
    expect(count([r, { ...r }, { ...r }], 1)).toBe(3);
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
      expect(count(rects, cell)).toBe(bruteForce(rects));
    }
  });
});

describe("scoreLayout", () => {
  test("K2,2 drawn crossed has exactly one crossing", () => {
    const g: LaidOutGraph = laidOutGraph(
      [box("p", 0, 0), box("q", 100, 0), box("r", 0, 100), box("s", 100, 100)],
      [
        { source: "p", target: "s" },
        { source: "q", target: "r" },
      ],
      10,
      "down",
    );
    const m = scoreLayout(g, { width: 110, height: 110 });
    expect(m.crossings).toBe(1);
    expect(m.overlaps).toBe(0);
    expect(m.againstFlowEdgeShare).toBe(0);
    expect(m.widestRow).toBe(2);
    expect(m.effectiveFontPx).toBe(10);
  });

  test("overlaps, flow direction, and fit scale", () => {
    const g: LaidOutGraph = laidOutGraph(
      [box("a", 0, 0), box("b", 5, 0), box("c", 1000, 0)],
      [
        { source: "a", target: "c" },
        { source: "c", target: "b" },
      ],
      12,
      "right",
    );
    const m = scoreLayout(g, { width: 101, height: 1000 });
    expect(m.overlaps).toBe(1);
    expect(m.againstFlowEdgeShare).toBe(0.5);
    expect(m.fitScale).toBeCloseTo(0.1, 2);
    expect(m.effectiveFontPx).toBeCloseTo(1.2, 1);
  });

  test("crossings match all-pairs segmentsCross on wide and tall random layouts", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let t = 0; t < 40; t++) {
      // Alternate wide/tall so both sweep axes are exercised; integer grids force shared
      // endpoints, collinear runs and equal sweep keys.
      const [sx, sy] = t % 2 === 0 ? [400, 40] : [40, 400];
      const n = 2 + Math.floor(rnd() * 60);
      const nodes = Array.from({ length: n }, (_, i) =>
        box(`n${i}`, Math.round(rnd() * sx), Math.round(rnd() * sy)),
      );
      const edges = Array.from({ length: Math.floor(rnd() * 90) }, () => ({
        source: `n${Math.floor(rnd() * n)}`,
        target: `n${Math.floor(rnd() * n)}`,
      }));
      edges.push({ source: "n0", target: "missing" });
      const at = new Map(nodes.map((p) => [p.id, p]));
      const segs = edges.flatMap((e) => {
        const a = at.get(e.source);
        const b = at.get(e.target);
        return a && b
          ? [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y, a: a.id, b: b.id }]
          : [];
      });
      let expected = 0;
      for (let i = 0; i < segs.length; i++)
        for (let j = i + 1; j < segs.length; j++)
          if (segmentsCross(segs[i]!, segs[j]!)) expected += 1;
      const m = scoreLayout(laidOutGraph(nodes, edges, 10, "down"), {
        width: 100,
        height: 100,
      });
      expect(m.crossings).toBe(expected);
      expect(m.edges).toBe(segs.length);
    }
  });

  test("widestRow counts nodes per rounded y", () => {
    const m = scoreLayout(
      {
        nodes: [
          box("a", 0, 0.4),
          box("b", 20, -0.4),
          box("c", 40, 7),
          box("d", 60, 7.2),
          box("e", 80, 6.6),
        ],
        edges: [],
        fontSize: 10,
      },
      { width: 100, height: 100 },
    );
    expect(m.widestRow).toBe(3);
  });

  test("radial flow skips direction check", () => {
    const m = scoreLayout(
      { nodes: [box("a", 0, 0)], edges: [], fontSize: 12, flow: "radial" },
      { width: 100, height: 100 },
    );
    expect(m.againstFlowEdgeShare).toBeNull();
  });
});
