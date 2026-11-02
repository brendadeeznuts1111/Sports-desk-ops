#!/usr/bin/env bun
/**
 * Structural tree → budgeted small-multiple views → Graphviz SVG + Bun.Image WebP.
 * Build-time only; the viewer serves these files from disk.
 *
 *   bun run graph:agent:views
 *   bun run graph:agent:views -- --budget 90 --rankdir TB --force
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  agentGraphArtifactPathsFromJsonOut,
  atomicWrite,
  isAgentGraphViewsFresh,
  markAgentGraphViewsBuilt,
  readAgentGraphManifest,
  resolveDefaultAgentGraphEnvelope,
  sha256HexFile,
} from "../lib/f402_agent_graph_artifacts.ts";
import {
  type GraphView,
  type GraphvizEngine,
  type RankDir,
  VIEW_FONT_SIZE,
  graphvizLayout,
  renderViewDot,
  runGraphviz,
} from "../lib/f402_agent_graph_dot.ts";
import {
  type RasterFit,
  scoreLayout,
} from "../lib/f402_agent_graph_metrics.ts";
import {
  AGENT_GRAPH_VIEWS_DIR,
  type AgentGraphViewIndex,
  type AgentGraphViewIndexEntry,
  DEFAULT_VIEW_OPTIONS,
  DEFAULT_VIEW_RANKDIR,
  buildViewSet,
  focusViewCytoscapeExport,
  overflowDrawnTotal,
  structuralGraphExport,
  viewFileBase,
  viewReconciles,
} from "../lib/f402_agent_graph_views.ts";
import {
  buildAgentTreeFromGeneral,
  parentDivergence,
} from "../lib/f402_agent_tree.ts";
import { parseListAgentsByAgentWireText } from "../lib/f402_list_agents_wire_boundary.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const REPO = join(import.meta.dir, "..");
const SCRATCH = join(REPO, "scratch");
const OUT_DIR = join(SCRATCH, AGENT_GRAPH_VIEWS_DIR);
const paths = agentGraphArtifactPathsFromJsonOut(
  join(SCRATCH, "agent-graph.json"),
);
const VIEW_RASTER: RasterFit = { width: 2400, height: 4800 };
const RENDER_DPI = 96;
const WEBP_QUALITY = Number(Bun.env.F402_GRAPH_WEBP_QUALITY ?? 85);

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    budget: { type: "string" },
    rankdir: { type: "string" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`graph:agent:views — readable small multiples (Graphviz, build-time)

Options:
  --budget <n>     visual weight per view (default ${DEFAULT_VIEW_OPTIONS.budget})
  --rankdir TB|LR  layout direction (default ${DEFAULT_VIEW_RANKDIR})
  --force          rebuild even when manifest says views are fresh
  -h, --help

Writes scratch/${AGENT_GRAPH_VIEWS_DIR}/{index.json,*.svg,*.webp}; records readability in the manifest.
`);
  process.exit(0);
}

const budget = Number(values.budget ?? DEFAULT_VIEW_OPTIONS.budget);
if (!Number.isInteger(budget) || budget < 4)
  throw new Error(`Invalid --budget ${values.budget}`);
const rankdirArg = (values.rankdir ?? DEFAULT_VIEW_RANKDIR).toUpperCase();
if (rankdirArg !== "TB" && rankdirArg !== "LR") {
  throw new Error(`Invalid --rankdir ${values.rankdir} (TB|LR)`);
}
const rankdir: RankDir = rankdirArg;

async function renderFiles(
  view: GraphView,
  engine: GraphvizEngine,
  dir: RankDir,
  base: string,
): Promise<{
  svg: string;
  webp: string;
  width: number;
  height: number;
  pxPerPt: number;
}> {
  const dot = renderViewDot(view, { engine, rankdir: dir });
  const svgName = `${base}.svg`;
  const webpName = `${base}.webp`;
  await atomicWrite(
    join(OUT_DIR, svgName),
    await runGraphviz(engine, dot, "svg"),
  );
  const png = await runGraphviz(engine, dot, "png", [`-Gdpi=${RENDER_DPI}`]);
  const source = await new Bun.Image(png).metadata();
  let image = new Bun.Image(png);
  if (source.width > VIEW_RASTER.width || source.height > VIEW_RASTER.height) {
    image = image.resize(VIEW_RASTER.width, VIEW_RASTER.height, {
      fit: "inside",
    });
  }
  const webp = await image.webp({ quality: WEBP_QUALITY }).bytes();
  await atomicWrite(join(OUT_DIR, webpName), webp);
  const meta = await new Bun.Image(webp).metadata();
  const pxPerPt = (RENDER_DPI / 72) * (meta.width / source.width);
  return {
    svg: svgName,
    webp: webpName,
    width: meta.width,
    height: meta.height,
    pxPerPt,
  };
}

async function main(): Promise<void> {
  const manifest = await readAgentGraphManifest(paths.manifest);
  if (manifest === null)
    throw new Error("Missing manifest — run graph:agent first");
  const envelopePath = resolveDefaultAgentGraphEnvelope(REPO);
  const envelopeSha256 = await sha256HexFile(envelopePath);
  if (envelopeSha256 !== manifest.envelopeSha256) {
    throw new Error(
      "Envelope changed since graph:agent — rerun graph:agent first",
    );
  }
  const sameOptions =
    manifest.readability?.budget === budget &&
    manifest.readability?.rankdir === rankdir;
  if (
    values.force !== true &&
    sameOptions &&
    (await isAgentGraphViewsFresh(paths.manifest))
  ) {
    console.error(
      `[graph:agent:views] up-to-date (envelope sha256=${envelopeSha256.slice(0, 12)}…)`,
    );
    return;
  }

  const envelope = parseListAgentsByAgentWireText(
    await Bun.file(envelopePath).text(),
  );
  const tree = buildAgentTreeFromGeneral(envelope.GENERAL);
  const set = buildViewSet(tree, {
    budget,
    leafBundleMin: DEFAULT_VIEW_OPTIONS.leafBundleMin,
  });

  const db = openSportsdeskSqlite(join(SCRATCH, "agent-graph.sqlite"));
  let portalParents: Map<string, string | null>;
  try {
    const rows = db.query("SELECT agent_id, parent_id FROM agents").all() as {
      agent_id: string;
      parent_id: string | null;
    }[];
    portalParents = new Map(rows.map((r) => [r.agent_id, r.parent_id || null]));
  } finally {
    db.close();
  }
  const divergence = parentDivergence(tree, portalParents);
  const byLevel: Record<number, number> = {};
  for (const d of divergence) byLevel[d.level] = (byLevel[d.level] ?? 0) + 1;

  await mkdir(OUT_DIR, { recursive: true });
  for (const f of await readdir(OUT_DIR)) {
    if (/\.(svg|webp|json)$/.test(f)) await rm(join(OUT_DIR, f));
  }

  const entries: AgentGraphViewIndexEntry[] = [];
  let worstFont = Infinity;
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
    const metrics = scoreLayout(
      { ...laid, flow: rankdir === "LR" ? "right" : "down" },
      VIEW_RASTER,
    );
    const files = await renderFiles(
      fv.view,
      "dot",
      rankdir,
      viewFileBase(fv.view.id),
    );
    const actualFont = VIEW_FONT_SIZE * files.pxPerPt;
    worstFont = Math.min(worstFont, actualFont);
    crossings += metrics.crossings;
    overlaps += metrics.overlaps;
    entries.push({
      id: fv.view.id,
      title: fv.view.title,
      focusId: fv.view.focusId,
      parentViewId: fv.parentViewId,
      boxes: fv.view.nodes.length,
      agentsShown: fv.reconciliation.shown,
      hidden: fv.reconciliation.hidden,
      frontier: fv.frontier,
      svg: files.svg,
      webp: files.webp,
      webpWidth: files.width,
      webpHeight: files.height,
      metrics: { ...metrics, effectiveFontPx: Number(actualFont.toFixed(2)) },
    });
  }

  const overview = set.views[0]!;
  const radialFiles = await renderFiles(
    overview.view,
    "twopi",
    "TB",
    "overview-radial",
  );

  const overflowDrawn = overflowDrawnTotal(tree, set);
  const reconciled = set.views.every(viewReconciles);
  const index: AgentGraphViewIndex = {
    version: 1,
    envelopeSha256,
    generatedAt: new Date().toISOString(),
    options: {
      budget,
      leafBundleMin: DEFAULT_VIEW_OPTIONS.leafBundleMin,
      rankdir,
    },
    coverage: set.coverage,
    reconciled,
    overflowTotal: tree.overflowTotal,
    overflowDrawn,
    radial: { svg: radialFiles.svg, webp: radialFiles.webp },
    agentView: set.agentView,
    views: entries,
    parentDivergence: {
      count: divergence.length,
      byLevel,
      samples: divergence.slice(0, 20),
    },
  };
  await atomicWrite(
    join(OUT_DIR, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  await atomicWrite(
    join(OUT_DIR, "structural.json"),
    `${JSON.stringify(structuralGraphExport(tree))}\n`,
  );
  await atomicWrite(
    join(OUT_DIR, "overview.cy.json"),
    `${JSON.stringify(focusViewCytoscapeExport(overview))}\n`,
  );

  await markAgentGraphViewsBuilt(paths.manifest, {
    viewCount: entries.length,
    coverage: set.coverage.covered,
    reconciled,
    overflowDrawn,
    worstFontPx: Number(worstFont.toFixed(2)),
    totalCrossings: crossings,
    totalOverlaps: overlaps,
    parentDivergence: divergence.length,
    budget,
    rankdir,
  });

  console.error(
    `[graph:agent:views] views=${entries.length} coverage=${set.coverage.covered}/${set.coverage.agents} reconciled=${reconciled} overflow=${overflowDrawn}/${tree.overflowTotal} worstFontPx=${worstFont.toFixed(2)} crossings=${crossings} overlaps=${overlaps} parentDivergence=${divergence.length}`,
  );
  console.error(`[graph:agent:views] wrote ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
