#!/usr/bin/env bun
/**
 * Times scoreLayout in-process on the real agent graph: every layout engine on the structural
 * tree, plus cytoscape-grid and level-rows on the shipped portal edges, as graph:agent:readability
 * scores them. Each layout is scored N times after one discarded run; min / p50 are reported.
 *
 *   bun run bench:score-layout                                   # build layouts (~10 s), 15 runs
 *   bun run bench:score-layout --save-fixtures /tmp/layouts.json # build once, keep the layouts
 *   bun run bench:score-layout --fixtures /tmp/layouts.json --json > after.json
 *
 * `--json` prints the metrics per layout, so two revisions can be diffed for identical output.
 * Reads the local envelope and scratch/agent-graph.json; no live API.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import { resolveDefaultAgentGraphEnvelope } from "../lib/f402_agent_graph_artifacts.ts";
import {
  LAYOUT_ENGINES,
  runLayoutEngine,
} from "../lib/f402_agent_graph_layouts.ts";
import {
  type LaidOutGraph,
  type ReadabilityMetrics,
  scoreLayout,
} from "../lib/f402_agent_graph_metrics.ts";
import { loadAgentGraphExport } from "../lib/f402_agent_graph_view_http.ts";
import { treeToCytoscapeExport } from "../lib/f402_agent_graph_views.ts";
import { buildAgentTreeFromGeneral } from "../lib/f402_agent_tree.ts";
import { parseListAgentsByAgentWireText } from "../lib/f402_list_agents_wire_boundary.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: "string", default: "15" },
    fixtures: { type: "string" },
    "save-fixtures": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`bench:score-layout — time scoreLayout on the real agent graph's layouts

Options:
  --runs <n>               Timed runs per layout after one discarded run (default 15)
  --fixtures <path>        Read laid-out graphs from <path> instead of running the engines
  --save-fixtures <path>   Write the laid-out graphs to <path> after building them
  --json                   Print { layout: ReadabilityMetrics } on stdout (timings go to stderr)
  -h, --help`);
  process.exit(0);
}

const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
  console.error(
    `bench:score-layout: --runs must be a positive integer, got ${values.runs}`,
  );
  process.exit(2);
}

const REPO = join(import.meta.dir, "..");
const RASTER = { width: 1920, height: 1080 };

async function buildLayouts(): Promise<Record<string, LaidOutGraph>> {
  const graphJson = join(REPO, "scratch/agent-graph.json");
  if (!(await Bun.file(graphJson).exists())) {
    console.error(
      `bench:score-layout: missing ${graphJson} — run graph:agent with --envelope first`,
    );
    process.exit(1);
  }
  const envelope = parseListAgentsByAgentWireText(
    await Bun.file(resolveDefaultAgentGraphEnvelope(REPO)).text(),
  );
  const structural = treeToCytoscapeExport(
    buildAgentTreeFromGeneral(envelope.GENERAL),
  );
  const shipped = await loadAgentGraphExport(graphJson);
  const layouts: Record<string, LaidOutGraph> = {
    "portal/cytoscape-grid": await runLayoutEngine("cytoscape-grid", shipped),
    "portal/level-rows": await runLayoutEngine("level-rows", shipped),
  };
  for (const engine of LAYOUT_ENGINES) {
    console.error(`[bench:score-layout] layout ${engine}`);
    layouts[`structural/${engine}`] = await runLayoutEngine(engine, structural);
  }
  return layouts;
}

const layouts: Record<string, LaidOutGraph> =
  values.fixtures === undefined
    ? await buildLayouts()
    : await Bun.file(values.fixtures).json();
if (values["save-fixtures"] !== undefined) {
  await Bun.write(values["save-fixtures"], JSON.stringify(layouts));
  console.error(`[bench:score-layout] wrote ${values["save-fixtures"]}`);
}

const ms = (from: number) => (Bun.nanoseconds() - from) / 1e6;
const metrics: Record<string, ReadabilityMetrics> = {};
let p50Sum = 0;
for (const [name, graph] of Object.entries(layouts)) {
  metrics[name] = scoreLayout(graph, RASTER);
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = Bun.nanoseconds();
    scoreLayout(graph, RASTER);
    times.push(ms(t));
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)]!;
  p50Sum += p50;
  const m = metrics[name]!;
  console.error(
    `${name.padEnd(34)} ${String(m.nodes).padStart(5)} nodes ${String(m.edges).padStart(5)} edges  p50 ${p50.toFixed(2).padStart(6)} ms  min ${times[0]!.toFixed(2).padStart(6)} ms  crossings ${m.crossings}`,
  );
}
console.error(`sum of p50: ${p50Sum.toFixed(1)} ms (${runs} runs per layout)`);
if (values.json) console.log(JSON.stringify(metrics, null, 2));
