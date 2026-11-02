#!/usr/bin/env bun
/**
 * Readability baseline + layout benchmark + view-budget sweep (graph-drawing metrics).
 *
 *   bun run graph:agent:readability
 *   bun run graph:agent:readability -- --skip-engines   # sweep only
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { CytoscapeGraphExport } from "../lib/f402_agent_graph.ts";
import {
  atomicWrite,
  resolveDefaultAgentGraphEnvelope,
  sha256HexFile,
} from "../lib/f402_agent_graph_artifacts.ts";
import {
  type RankDir,
  VIEW_FONT_SIZE,
  graphvizLayout,
  renderViewDot,
} from "../lib/f402_agent_graph_dot.ts";
import {
  LAYOUT_ENGINES,
  type LayoutEngineName,
  runLayoutEngine,
} from "../lib/f402_agent_graph_layouts.ts";
import {
  type RasterFit,
  type ReadabilityMetrics,
  scoreLayout,
} from "../lib/f402_agent_graph_metrics.ts";
import { loadAgentGraphExport } from "../lib/f402_agent_graph_view_http.ts";
import {
  buildViewSet,
  treeToCytoscapeExport,
  viewReconciles,
} from "../lib/f402_agent_graph_views.ts";
import {
  agentTreeStats,
  buildAgentTreeFromGeneral,
} from "../lib/f402_agent_tree.ts";
import { parseListAgentsByAgentWireText } from "../lib/f402_list_agents_wire_boundary.ts";

import { envPositiveInt } from "../lib/env.ts";

const REPO = join(import.meta.dir, "..");
const OUT = join(REPO, "scratch/agent-graph-readability.json");

/** Current capture viewport (graph:agent:image). */
export const FULL_RASTER: RasterFit = {
  width: envPositiveInt("F402_GRAPH_VIEWPORT_W", 1920),
  height: envPositiveInt("F402_GRAPH_VIEWPORT_H", 1080),
};
/** Per-view raster bound for small multiples (scrollable page, WebP-safe). */
export const VIEW_RASTER: RasterFit = {
  width: envPositiveInt("F402_GRAPH_VIEW_RASTER_W", 2400),
  height: envPositiveInt("F402_GRAPH_VIEW_RASTER_H", 4800),
};

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "skip-engines": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(`graph:agent:readability — score layouts on graph-drawing metrics

Writes scratch/agent-graph-readability.json (keyed by envelope SHA-256).
  --skip-engines   skip full-graph engine benchmark (view sweep only)
`);
  process.exit(0);
}

interface EngineRow {
  readonly engine: LayoutEngineName;
  readonly edges: "portal" | "structural";
  readonly ms: number;
  readonly metrics: ReadabilityMetrics;
}

async function scoreEngine(
  engine: LayoutEngineName,
  graph: CytoscapeGraphExport,
  edges: EngineRow["edges"],
): Promise<EngineRow> {
  const t0 = performance.now();
  const laid = await runLayoutEngine(engine, graph);
  const ms = performance.now() - t0;
  return {
    engine,
    edges,
    ms: Math.round(ms),
    metrics: scoreLayout(laid, FULL_RASTER),
  };
}

interface SweepRow {
  readonly budget: number;
  readonly rankdir: RankDir;
  readonly views: number;
  readonly reconciled: boolean;
  readonly coverage: number;
  readonly worstFontPx: number;
  readonly medianFontPx: number;
  readonly viewsUnder8px: number;
  readonly totalCrossings: number;
  readonly totalOverlaps: number;
}

async function sweep(
  tree: ReturnType<typeof buildAgentTreeFromGeneral>,
  budget: number,
  rankdir: RankDir,
): Promise<SweepRow> {
  const set = buildViewSet(tree, { budget, leafBundleMin: 3 });
  const fonts: number[] = [];
  let crossings = 0;
  let overlaps = 0;
  for (const fv of set.views) {
    const dot = renderViewDot(fv.view, {
      engine: "dot",
      rankdir,
      legend: false,
    });
    const laid = await graphvizLayout(
      "dot",
      dot,
      fv.view.edges,
      VIEW_FONT_SIZE,
    );
    const m = scoreLayout(
      { ...laid, flow: rankdir === "LR" ? "right" : "down" },
      VIEW_RASTER,
    );
    fonts.push(Math.min(m.effectiveFontPx, VIEW_FONT_SIZE * 2));
    crossings += m.crossings;
    overlaps += m.overlaps;
  }
  fonts.sort((a, b) => a - b);
  return {
    budget,
    rankdir,
    views: set.views.length,
    reconciled: set.views.every(viewReconciles),
    coverage: set.coverage.covered,
    worstFontPx: fonts[0] ?? 0,
    medianFontPx: fonts[fonts.length >> 1] ?? 0,
    viewsUnder8px: fonts.filter((f) => f < 8).length,
    totalCrossings: crossings,
    totalOverlaps: overlaps,
  };
}

function table(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]!);
  const lines = [
    `| ${keys.join(" | ")} |`,
    `|${keys.map(() => "---").join("|")}|`,
  ];
  for (const r of rows)
    lines.push(`| ${keys.map((k) => String(r[k])).join(" | ")} |`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const envelopePath = resolveDefaultAgentGraphEnvelope(REPO);
  const envelopeSha256 = await sha256HexFile(envelopePath);
  const envelope = parseListAgentsByAgentWireText(
    await Bun.file(envelopePath).text(),
  );
  const tree = buildAgentTreeFromGeneral(envelope.GENERAL);
  const stats = agentTreeStats(tree);
  const structural = treeToCytoscapeExport(tree);

  const baseline: EngineRow[] = [];
  const engines: EngineRow[] = [];
  if (values["skip-engines"] !== true) {
    const shipped = await loadAgentGraphExport(
      join(REPO, "scratch/agent-graph.json"),
    );
    baseline.push(await scoreEngine("cytoscape-grid", shipped, "portal"));
    baseline.push(await scoreEngine("level-rows", shipped, "portal"));
    for (const engine of LAYOUT_ENGINES) {
      console.error(`[readability] engine ${engine}`);
      engines.push(await scoreEngine(engine, structural, "structural"));
    }
  }

  const sweepRows: SweepRow[] = [];
  for (const budget of [40, 60, 90, 140]) {
    for (const rankdir of ["TB", "LR"] as const) {
      console.error(`[readability] sweep budget=${budget} rankdir=${rankdir}`);
      sweepRows.push(await sweep(tree, budget, rankdir));
    }
  }

  const report = {
    version: 1,
    envelopeSha256,
    generatedAt: new Date().toISOString(),
    fullRaster: FULL_RASTER,
    viewRaster: VIEW_RASTER,
    stats,
    baseline,
    engines,
    sweep: sweepRows,
  };
  await atomicWrite(OUT, `${JSON.stringify(report, null, 2)}\n`);

  const flat = (r: EngineRow) => ({
    engine: r.engine,
    edges: r.edges,
    ms: r.ms,
    crossings: r.metrics.crossings,
    overlaps: r.metrics.overlaps,
    bounds: `${r.metrics.boundsWidth}x${r.metrics.boundsHeight}`,
    widestRow: r.metrics.widestRow,
    againstFlow: r.metrics.againstFlowEdgeShare ?? "n/a",
    fontPx: r.metrics.effectiveFontPx,
  });
  if (baseline.length > 0) {
    console.log("## Baseline (shipped artifacts, portal edges, 1920x1080)\n");
    console.log(table(baseline.map(flat)));
    console.log(
      "\n## Engine benchmark (structural edges, full tree, 1920x1080)\n",
    );
    console.log(table(engines.map(flat)));
  }
  console.log(
    "\n## View budget sweep (Graphviz dot, per-view raster 2400x4800)\n",
  );
  console.log(table(sweepRows.map((r) => ({ ...r }))));
  console.error(`[readability] wrote ${OUT}`);
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
