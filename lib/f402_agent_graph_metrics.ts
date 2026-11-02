/**
 * Graph-drawing readability metrics on laid-out coordinates (layout space, y grows downward).
 * Edges are scored as straight segments between box centers so every layout engine is
 * compared on identical terms regardless of its spline routing.
 */

export interface LaidOutNode {
  readonly id: string;
  /** Center x/y and box size in layout units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface LaidOutGraph {
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly {
    readonly source: string;
    readonly target: string;
  }[];
  /** Label font size in layout units. */
  readonly fontSize: number;
  /** Intended parent→child direction; radial layouts skip the flow check. */
  readonly flow?: "down" | "right" | "radial";
}

export interface RasterFit {
  readonly width: number;
  readonly height: number;
}

export interface ReadabilityMetrics {
  readonly nodes: number;
  readonly edges: number;
  readonly crossings: number;
  readonly overlaps: number;
  readonly boundsWidth: number;
  readonly boundsHeight: number;
  readonly aspectRatio: number;
  readonly widestRow: number;
  readonly meanEdgeLength: number;
  /** Share of parent→child edges not pointing along `flow`; null for radial. */
  readonly againstFlowEdgeShare: number | null;
  /** Scale applied when the whole drawing is fit inside the raster. */
  readonly fitScale: number;
  readonly effectiveFontPx: number;
}

interface Seg {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly a: string;
  readonly b: string;
}

function orient(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}

/** Proper crossing only: shared endpoints and collinear touches do not count. */
export function segmentsCross(s: Seg, t: Seg): boolean {
  if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) return false;
  const o1 = orient(s.x1, s.y1, s.x2, s.y2, t.x1, t.y1);
  const o2 = orient(s.x1, s.y1, s.x2, s.y2, t.x2, t.y2);
  const o3 = orient(t.x1, t.y1, t.x2, t.y2, s.x1, s.y1);
  const o4 = orient(t.x1, t.y1, t.x2, t.y2, s.x2, s.y2);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Uniform-grid bucketed pair test for small boxes; exact result. */
function countPairs<T>(
  items: readonly T[],
  box: (t: T) => { minX: number; minY: number; maxX: number; maxY: number },
  test: (a: T, b: T) => boolean,
  cell: number,
): number {
  const buckets = new Map<string, number[]>();
  const boxes = items.map(box);
  boxes.forEach((b, i) => {
    for (
      let gx = Math.floor(b.minX / cell);
      gx <= Math.floor(b.maxX / cell);
      gx++
    ) {
      for (
        let gy = Math.floor(b.minY / cell);
        gy <= Math.floor(b.maxY / cell);
        gy++
      ) {
        const key = `${gx},${gy}`;
        const list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
      }
    }
  });
  const seen = new Set<number>();
  let count = 0;
  const n = items.length;
  for (const list of buckets.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p]!;
        const j = list[q]!;
        const key = i < j ? i * n + j : j * n + i;
        if (seen.has(key)) continue;
        const bi = boxes[i]!;
        const bj = boxes[j]!;
        if (
          bi.maxX < bj.minX ||
          bj.maxX < bi.minX ||
          bi.maxY < bj.minY ||
          bj.maxY < bi.minY
        )
          continue;
        seen.add(key);
        if (test(items[i]!, items[j]!)) count += 1;
      }
    }
  }
  return count;
}

export function scoreLayout(
  graph: LaidOutGraph,
  raster: RasterFit,
): ReadabilityMetrics {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of graph.nodes) {
    minX = Math.min(minX, n.x - n.w / 2);
    maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
  }
  if (graph.nodes.length === 0) minX = minY = maxX = maxY = 0;
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);

  const segs: Seg[] = [];
  let lenSum = 0;
  let nonDown = 0;
  for (const e of graph.edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, a: a.id, b: b.id });
    lenSum += Math.hypot(b.x - a.x, b.y - a.y);
    const along = graph.flow === "right" ? b.x - a.x : b.y - a.y;
    if (!(along > 1e-6)) nonDown += 1;
  }

  const avgNode =
    graph.nodes.reduce((s, n) => s + Math.max(n.w, n.h), 0) /
    Math.max(1, graph.nodes.length);
  const cell = Math.max(avgNode * 4, Math.max(boundsWidth, boundsHeight) / 256);

  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const sMinX = Math.min(s.x1, s.x2);
    const sMaxX = Math.max(s.x1, s.x2);
    const sMinY = Math.min(s.y1, s.y2);
    const sMaxY = Math.max(s.y1, s.y2);
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]!;
      if (Math.max(t.x1, t.x2) < sMinX || Math.min(t.x1, t.x2) > sMaxX)
        continue;
      if (Math.max(t.y1, t.y2) < sMinY || Math.min(t.y1, t.y2) > sMaxY)
        continue;
      if (segmentsCross(s, t)) crossings += 1;
    }
  }
  const overlaps = countPairs(
    graph.nodes,
    (n) => ({
      minX: n.x - n.w / 2,
      maxX: n.x + n.w / 2,
      minY: n.y - n.h / 2,
      maxY: n.y + n.h / 2,
    }),
    (p, q) =>
      Math.abs(p.x - q.x) * 2 < p.w + q.w - 1e-6 &&
      Math.abs(p.y - q.y) * 2 < p.h + q.h - 1e-6,
    cell,
  );

  const rows = new Map<number, number>();
  for (const n of graph.nodes) {
    const key = Math.round(n.y);
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }

  const fitScale = Math.min(
    raster.width / boundsWidth,
    raster.height / boundsHeight,
  );
  return {
    nodes: graph.nodes.length,
    edges: segs.length,
    crossings,
    overlaps,
    boundsWidth: Math.round(boundsWidth),
    boundsHeight: Math.round(boundsHeight),
    aspectRatio: Number((boundsWidth / boundsHeight).toFixed(2)),
    widestRow: Math.max(0, ...rows.values()),
    meanEdgeLength: Math.round(lenSum / Math.max(1, segs.length)),
    againstFlowEdgeShare:
      graph.flow === "radial"
        ? null
        : Number((nonDown / Math.max(1, segs.length)).toFixed(3)),
    fitScale: Number(fitScale.toPrecision(3)),
    effectiveFontPx: Number((graph.fontSize * fitScale).toFixed(2)),
  };
}
