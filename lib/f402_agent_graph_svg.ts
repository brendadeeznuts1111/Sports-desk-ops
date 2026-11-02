import type { CytoscapeGraphExport } from "./f402_agent_graph.ts";

export interface AgentGraphSvgOptions {
  readonly nodeW?: number;
  readonly nodeH?: number;
  readonly gapX?: number;
  readonly gapY?: number;
  readonly padding?: number;
}

export interface LevelRowLayout {
  readonly pos: ReadonlyMap<string, { x: number; y: number }>;
  readonly width: number;
  readonly height: number;
  readonly nodeW: number;
  readonly nodeH: number;
}

/** One centered row per level; positions are box top-left corners. */
export function layoutLevelRows(
  graph: CytoscapeGraphExport,
  options?: AgentGraphSvgOptions,
): LevelRowLayout {
  const nodeW = options?.nodeW ?? 120;
  const nodeH = options?.nodeH ?? 36;
  const gapX = options?.gapX ?? 24;
  const gapY = options?.gapY ?? 56;
  const pad = options?.padding ?? 32;
  const nodes = graph.nodes.map((n) => n.data);

  const byLevel = new Map<number, typeof nodes>();
  let maxLevel = 1;
  for (const n of nodes) {
    const level = Math.max(1, Number(n.level) || 1);
    maxLevel = Math.max(maxLevel, level);
    const row = byLevel.get(level) ?? [];
    row.push(n);
    byLevel.set(level, row);
  }
  for (const row of byLevel.values()) {
    row.sort((a, b) => a.id.localeCompare(b.id));
  }

  const pos = new Map<string, { x: number; y: number }>();
  let maxRowWidth = 0;
  for (let level = 1; level <= maxLevel; level++) {
    const row = byLevel.get(level) ?? [];
    const rowW = row.length * nodeW + Math.max(0, row.length - 1) * gapX;
    maxRowWidth = Math.max(maxRowWidth, rowW);
    const y = pad + (level - 1) * (nodeH + gapY);
    row.forEach((n, i) => {
      const x = pad + i * (nodeW + gapX);
      pos.set(n.id, { x, y });
    });
  }

  // Center each row within maxRowWidth
  for (let level = 1; level <= maxLevel; level++) {
    const row = byLevel.get(level) ?? [];
    if (row.length === 0) continue;
    const rowW = row.length * nodeW + Math.max(0, row.length - 1) * gapX;
    const offset = pad + (maxRowWidth - rowW) / 2;
    row.forEach((n, i) => {
      pos.set(n.id, {
        x: offset + i * (nodeW + gapX),
        y: pad + (level - 1) * (nodeH + gapY),
      });
    });
  }

  const width = pad * 2 + maxRowWidth;
  const height = pad * 2 + maxLevel * (nodeH + gapY);
  return { pos, width, height, nodeW, nodeH };
}

/** Server-side layout — no browser / cytoscape required. */
export function cytoscapeExportToSvg(
  graph: CytoscapeGraphExport,
  options?: AgentGraphSvgOptions,
): string {
  const { pos, width, height, nodeW, nodeH } = layoutLevelRows(graph, options);
  const nodes = graph.nodes.map((n) => n.data);
  const edges = graph.edges.map((e) => e.data);

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  const edgeLines: string[] = [];
  for (const e of edges) {
    const a = pos.get(e.source);
    const b = pos.get(e.target);
    if (!a || !b) continue;
    const x1 = a.x + nodeW / 2;
    const y1 = a.y + nodeH;
    const x2 = b.x + nodeW / 2;
    const y2 = b.y;
    edgeLines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="2" marker-end="url(#arrow)"/>`,
    );
  }

  const nodeRects: string[] = [];
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    nodeRects.push(
      `<g><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="6" fill="#0ea5e9" stroke="#38bdf8"/>` +
        `<text x="${p.x + nodeW / 2}" y="${p.y + nodeH / 2 + 4}" text-anchor="middle" fill="#f8fafc" font-family="system-ui,sans-serif" font-size="11">${esc(n.label)}</text>` +
        `<text x="${p.x + nodeW / 2}" y="${p.y + nodeH + 14}" text-anchor="middle" fill="#94a3b8" font-size="9">L${Number(n.level)}</text></g>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#64748b"/>
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#0b1220"/>
  ${edgeLines.join("\n  ")}
  ${nodeRects.join("\n  ")}
</svg>`;
}
