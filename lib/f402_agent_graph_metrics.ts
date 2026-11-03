/**
 * Readability scoring for agent-graph layouts (layout space, y downward).
 *
 * Purpose: compare layout engines and view budgets on one rubric — crossings, overlaps,
 * intended flow, fit-to-raster — so evidence in docs/evidence/agent-graph-readability.md
 * is engine-neutral. Edges are judged as center-to-center segments, not each engine's curves.
 * Wire exports are normalized into a scored graph at the layout boundary; scoring reads
 * coordinates and dense edge endpoints only.
 */

export interface LaidOutNode {
  readonly id: string;
  /** Center x/y and box size in layout units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Edge endpoints in export form (stable agent ids from Cytoscape / Graphviz). */
export type LaidOutWireEdge = {
  readonly source: string;
  readonly target: string;
};

/** Edge endpoints in scored form (indices into the laid-out node list). */
export type LaidOutEdge = {
  readonly sourceIndex: number;
  readonly targetIndex: number;
};

export interface LaidOutGraph {
  readonly nodes: readonly LaidOutNode[];
  readonly edges: readonly LaidOutEdge[];
  /** Label font size in layout units. */
  readonly fontSize: number;
  /** Intended parent→child direction; radial layouts skip the flow check. */
  readonly flow?: "down" | "right" | "radial";
}

/** Attach wire edges to a laid-out node list for scoring; omit endpoints missing from the layout. */
export function indexLaidOutEdges(
  nodes: readonly Pick<LaidOutNode, "id">[],
  wire: readonly LaidOutWireEdge[],
): LaidOutEdge[] {
  const indexOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) indexOf.set(nodes[i]!.id, i);
  const out: LaidOutEdge[] = [];
  for (const e of wire) {
    const sourceIndex = indexOf.get(e.source);
    const targetIndex = indexOf.get(e.target);
    if (sourceIndex !== undefined && targetIndex !== undefined) {
      out.push({ sourceIndex, targetIndex });
    }
  }
  return out;
}

/** Normalize engine output into the graph shape `scoreLayout` expects. */
export function laidOutGraph(
  nodes: readonly LaidOutNode[],
  wire: readonly LaidOutWireEdge[],
  fontSize: number,
  flow?: LaidOutGraph["flow"],
): LaidOutGraph {
  const edges = indexLaidOutEdges(nodes, wire);
  return flow === undefined
    ? { nodes, edges, fontSize }
    : { nodes, edges, fontSize, flow };
}

function packEndpoints(a: number, b: number): number {
  return (a << 16) | b;
}

function endpointsOf(packed: number): { a: number; b: number } {
  return { a: packed >>> 16, b: packed & 0xffff };
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

function properCross(
  sx1: number,
  sy1: number,
  sx2: number,
  sy2: number,
  tx1: number,
  ty1: number,
  tx2: number,
  ty2: number,
): boolean {
  return (
    orient(sx1, sy1, sx2, sy2, tx1, ty1) *
      orient(sx1, sy1, sx2, sy2, tx2, ty2) <
      0 &&
    orient(tx1, ty1, tx2, ty2, sx1, sy1) *
      orient(tx1, ty1, tx2, ty2, sx2, sy2) <
      0
  );
}

/** Proper crossing only: shared endpoints and collinear touches do not count. */
export function segmentsCross(s: Seg, t: Seg): boolean {
  if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) return false;
  return properCross(s.x1, s.y1, s.x2, s.y2, t.x1, t.y1, t.x2, t.y2);
}

/**
 * Uniform-grid bucketed pair test for small boxes; exact result. `boxes` holds
 * `minX, minY, maxX, maxY` per item. Cell `c` holds `cellItems[cellStart[c] .. cellStart[c + 1])`;
 * the pair bitset costs n(n-1)/2 bits.
 */
export function countPairs(
  boxes: Float64Array,
  test: (i: number, j: number) => boolean,
  cell: number,
): number {
  const n = boxes.length >> 2;
  if (n < 2) return 0;
  const span = new Int32Array(n * 4);
  let gxMin = Infinity;
  let gyMin = Infinity;
  let gxMax = -Infinity;
  let gyMax = -Infinity;
  for (let k = 0; k < n * 4; k += 4) {
    const x0 = Math.floor(boxes[k]! / cell);
    const y0 = Math.floor(boxes[k + 1]! / cell);
    const x1 = Math.floor(boxes[k + 2]! / cell);
    const y1 = Math.floor(boxes[k + 3]! / cell);
    span[k] = x0;
    span[k + 1] = y0;
    span[k + 2] = x1;
    span[k + 3] = y1;
    gxMin = Math.min(gxMin, x0);
    gyMin = Math.min(gyMin, y0);
    gxMax = Math.max(gxMax, x1);
    gyMax = Math.max(gyMax, y1);
  }
  const cols = gxMax - gxMin + 1;
  const cells = cols * (gyMax - gyMin + 1);

  const cellStart = new Int32Array(cells + 1);
  for (let i = 0; i < n; i++)
    for (let gy = span[i * 4 + 1]!; gy <= span[i * 4 + 3]!; gy++)
      for (let gx = span[i * 4]!; gx <= span[i * 4 + 2]!; gx++)
        cellStart[(gy - gyMin) * cols + (gx - gxMin) + 1]! += 1;
  for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
  const cellItems = new Int32Array(cellStart[cells]!);
  const fill = cellStart.slice(0, cells);
  for (let i = 0; i < n; i++)
    for (let gy = span[i * 4 + 1]!; gy <= span[i * 4 + 3]!; gy++)
      for (let gx = span[i * 4]!; gx <= span[i * 4 + 2]!; gx++)
        cellItems[fill[(gy - gyMin) * cols + (gx - gxMin)]!++] = i;

  // Pair (i, j), i < j, is bit j(j-1)/2 + i. Items enter cells in index order, so p < q gives i < j.
  const seen = new Uint32Array(Math.ceil((n * (n - 1)) / 2 / 32));
  let count = 0;
  for (let c = 0; c < cells; c++) {
    const end = cellStart[c + 1]!;
    for (let p = cellStart[c]!; p < end; p++) {
      const i = cellItems[p]!;
      for (let q = p + 1; q < end; q++) {
        const j = cellItems[q]!;
        const bit = (j * (j - 1)) / 2 + i;
        const word = Math.floor(bit / 32);
        const mask = 1 << (bit & 31);
        if (seen[word]! & mask) continue;
        if (
          boxes[i * 4 + 2]! < boxes[j * 4]! ||
          boxes[j * 4 + 2]! < boxes[i * 4]! ||
          boxes[i * 4 + 3]! < boxes[j * 4 + 1]! ||
          boxes[j * 4 + 3]! < boxes[i * 4 + 1]!
        )
          continue;
        seen[word]! |= mask;
        if (test(i, j)) count += 1;
      }
    }
  }
  return count;
}

/** Proper crossings among straight segments; sub-quadratic via axis-chosen sweep-and-prune. */
function countCrossings(
  seg: Float64Array,
  packed: Uint32Array,
  m: number,
): number {
  let spanX = 0;
  let spanY = 0;
  let loX = Infinity;
  let hiX = -Infinity;
  let loY = Infinity;
  let hiY = -Infinity;
  for (let k = 0; k < m * 4; k += 4) {
    spanX += Math.abs(seg[k + 2]! - seg[k]!);
    spanY += Math.abs(seg[k + 3]! - seg[k + 1]!);
    loX = Math.min(loX, seg[k]!, seg[k + 2]!);
    hiX = Math.max(hiX, seg[k]!, seg[k + 2]!);
    loY = Math.min(loY, seg[k + 1]!, seg[k + 3]!);
    hiY = Math.max(hiY, seg[k + 1]!, seg[k + 3]!);
  }
  const byY =
    spanY * Math.max(1e-9, hiX - loX) < spanX * Math.max(1e-9, hiY - loY);
  const u = byY ? 1 : 0;
  const v = 1 - u;

  const low = new Float64Array(m);
  for (let s = 0; s < m; s++)
    low[s] = Math.min(seg[s * 4 + u]!, seg[s * 4 + 2 + u]!);
  const order = new Int32Array(m);
  for (let s = 0; s < m; s++) order[s] = s;
  order.sort((a, b) => low[a]! - low[b]!);

  // Copied into sweep order so the inner loop reads forward through memory. Per segment `ext`
  // holds sweep-axis low, other-axis low, sweep-axis high, other-axis high.
  const ext = new Float64Array(m * 4);
  const pts = new Float64Array(m * 4);
  const sweepPacked = new Uint32Array(m);
  for (let p = 0; p < m; p++) {
    const k = order[p]! * 4;
    const o = p * 4;
    ext[o] = Math.min(seg[k + u]!, seg[k + 2 + u]!);
    ext[o + 1] = Math.min(seg[k + v]!, seg[k + 2 + v]!);
    ext[o + 2] = Math.max(seg[k + u]!, seg[k + 2 + u]!);
    ext[o + 3] = Math.max(seg[k + v]!, seg[k + 2 + v]!);
    pts[o] = seg[k]!;
    pts[o + 1] = seg[k + 1]!;
    pts[o + 2] = seg[k + 2]!;
    pts[o + 3] = seg[k + 3]!;
    sweepPacked[p] = packed[order[p]!]!;
  }

  let crossings = 0;
  for (let p = 0; p < m; p++) {
    const ki = p * 4;
    const sweepHi = ext[ki + 2]!;
    const otherLo = ext[ki + 1]!;
    const otherHi = ext[ki + 3]!;
    const { a, b } = endpointsOf(sweepPacked[p]!);
    for (let q = p + 1; q < m; q++) {
      const kj = q * 4;
      if (ext[kj]! > sweepHi) break;
      if (ext[kj + 3]! < otherLo || ext[kj + 1]! > otherHi) continue;
      const { a: c, b: d } = endpointsOf(sweepPacked[q]!);
      if (a === c || a === d || b === c || b === d) continue;
      if (
        properCross(
          pts[ki]!,
          pts[ki + 1]!,
          pts[ki + 2]!,
          pts[ki + 3]!,
          pts[kj]!,
          pts[kj + 1]!,
          pts[kj + 2]!,
          pts[kj + 3]!,
        )
      )
        crossings += 1;
    }
  }
  return crossings;
}

/** Most nodes sharing one rounded y: the longest run in the sorted row keys. */
function widestRow(ys: Float64Array): number {
  const keys = ys.map(Math.round).sort();
  let best = 0;
  for (let start = 0, k = 1; k <= keys.length; k++) {
    if (k === keys.length || keys[k] !== keys[start]) {
      best = Math.max(best, k - start);
      start = k;
    }
  }
  return best;
}

export function scoreLayout(
  graph: LaidOutGraph,
  raster: RasterFit,
): ReadabilityMetrics {
  const n = graph.nodes.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const ws = new Float64Array(n);
  const hs = new Float64Array(n);
  const boxes = new Float64Array(n * 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sizeSum = 0;
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i]!;
    xs[i] = node.x;
    ys[i] = node.y;
    ws[i] = node.w;
    hs[i] = node.h;
    boxes[i * 4] = node.x - node.w / 2;
    boxes[i * 4 + 1] = node.y - node.h / 2;
    boxes[i * 4 + 2] = node.x + node.w / 2;
    boxes[i * 4 + 3] = node.y + node.h / 2;
    minX = Math.min(minX, boxes[i * 4]!);
    minY = Math.min(minY, boxes[i * 4 + 1]!);
    maxX = Math.max(maxX, boxes[i * 4 + 2]!);
    maxY = Math.max(maxY, boxes[i * 4 + 3]!);
    sizeSum += Math.max(node.w, node.h);
  }
  if (n === 0) minX = minY = maxX = maxY = 0;
  if (n >= 65536) {
    throw new RangeError(
      `scoreLayout: ${n} nodes exceeds packed endpoint limit (65535)`,
    );
  }
  const boundsWidth = Math.max(1, maxX - minX);
  const boundsHeight = Math.max(1, maxY - minY);

  const edgeCount = graph.edges.length;
  const seg = new Float64Array(edgeCount * 4);
  const packed = new Uint32Array(edgeCount);
  let m = 0;
  let lenSum = 0;
  let nonDown = 0;
  for (const e of graph.edges) {
    const a = e.sourceIndex;
    const b = e.targetIndex;
    seg[m * 4] = xs[a]!;
    seg[m * 4 + 1] = ys[a]!;
    seg[m * 4 + 2] = xs[b]!;
    seg[m * 4 + 3] = ys[b]!;
    packed[m] = packEndpoints(a, b);
    m += 1;
    lenSum += Math.hypot(xs[b]! - xs[a]!, ys[b]! - ys[a]!);
    const along = graph.flow === "right" ? xs[b]! - xs[a]! : ys[b]! - ys[a]!;
    if (!(along > 1e-6)) nonDown += 1;
  }

  const avgNode = sizeSum / Math.max(1, n);
  const cell = Math.max(avgNode * 4, Math.max(boundsWidth, boundsHeight) / 256);
  const crossings = countCrossings(seg, packed, m);
  const overlaps = countPairs(
    boxes,
    (p, q) =>
      Math.abs(xs[p]! - xs[q]!) * 2 < ws[p]! + ws[q]! - 1e-6 &&
      Math.abs(ys[p]! - ys[q]!) * 2 < hs[p]! + hs[q]! - 1e-6,
    cell,
  );

  const fitScale = Math.min(
    raster.width / boundsWidth,
    raster.height / boundsHeight,
  );
  return {
    nodes: n,
    edges: m,
    crossings,
    overlaps,
    boundsWidth: Math.round(boundsWidth),
    boundsHeight: Math.round(boundsHeight),
    aspectRatio: Number((boundsWidth / boundsHeight).toFixed(2)),
    widestRow: widestRow(ys),
    meanEdgeLength: Math.round(lenSum / Math.max(1, m)),
    againstFlowEdgeShare:
      graph.flow === "radial"
        ? null
        : Number((nonDown / Math.max(1, m)).toFixed(3)),
    fitScale: Number(fitScale.toPrecision(3)),
    effectiveFontPx: Number((graph.fontSize * fitScale).toFixed(2)),
  };
}
