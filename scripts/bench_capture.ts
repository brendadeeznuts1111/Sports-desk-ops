#!/usr/bin/env bun
/**
 * Times captureAgentGraphWebp in-process: N runs, each writing its own /tmp file, reported as
 * min / p50 / max with the cold first run listed apart. --stages splits each run into the
 * pieces captureAgentGraphWebp is built from, to show whether the time is the browser or the encode.
 *
 *   bun run bench:capture                 # 5 runs
 *   bun run bench:capture --runs 10 --stages
 *   hyperfine --warmup 2 'bun scripts/bench_capture.ts --runs 1 --quiet'   # whole-command wall clock
 *
 * Serves capture.html from scratch/agent-graph.json on an ephemeral local port; no live API.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  writeAgentGraphWebp,
  webpBytesFromScreenshotBlob,
} from "../lib/f402_agent_graph_capture.ts";
import { AGENT_GRAPH_READY_EVAL } from "../lib/f402_agent_graph_capture_page.ts";
import {
  defaultAgentGraphViewPaths,
  handleAgentGraphViewRequest,
} from "../lib/f402_agent_graph_view_http.ts";
import { ManagedWebView } from "./capture/webview.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    runs: { type: "string", default: "5" },
    stages: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`bench:capture — time captureAgentGraphWebp (WebView → PNG → Bun.Image WebP)

Options:
  --runs <n>   Runs (default 5); each writes /tmp/bench-capture-<pid>-<i>.webp
  --stages     Also time navigate / layout-ready / screenshot / webp-encode per run
  --quiet      Print nothing (for hyperfine)
  -h, --help`);
  process.exit(0);
}

const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
  console.error(
    `bench:capture: --runs must be a positive integer, got ${values.runs}`,
  );
  process.exit(2);
}

const paths = defaultAgentGraphViewPaths(join(import.meta.dir, ".."));
if (!(await Bun.file(paths.graphJson).exists())) {
  console.error(
    `bench:capture: missing ${paths.graphJson} — run graph:agent with --envelope first`,
  );
  process.exit(1);
}

const VIEWPORT = { width: 1920, height: 1080 };
const WEBP = {
  maxWidth: VIEWPORT.width,
  maxHeight: VIEWPORT.height,
  quality: 85,
};
const STAGES = [
  "navigate",
  "layout-ready",
  "screenshot",
  "webp-encode",
] as const;
type Stage = (typeof STAGES)[number];

await using server = Bun.serve({
  port: 0,
  fetch: (req) => handleAgentGraphViewRequest(req, paths),
});
const captureUrl = `http://127.0.0.1:${server.port}/capture.html`;

const ms = (from: number) => (Bun.nanoseconds() - from) / 1e6;

/** captureAgentGraphWebp's steps, lapped. The WebView process starts on the first navigate. */
async function stagedRun(): Promise<Record<Stage, number>> {
  const lap = {} as Record<Stage, number>;
  let t = Bun.nanoseconds();
  const mark = (stage: Stage) => {
    lap[stage] = ms(t);
    t = Bun.nanoseconds();
  };
  await using view = ManagedWebView.launch({ ...VIEWPORT, backend: "webkit" });
  await view.navigate(captureUrl, { timeoutMs: 30_000 });
  mark("navigate");
  await view.evaluate(AGENT_GRAPH_READY_EVAL);
  mark("layout-ready");
  const png = await view.screenshotBlob({ format: "png" });
  mark("screenshot");
  await webpBytesFromScreenshotBlob(png, WEBP);
  mark("webp-encode");
  return lap;
}

const totals: number[] = [];
const outputs: string[] = [];
for (let i = 0; i < runs; i++) {
  const out = `/tmp/bench-capture-${process.pid}-${i}.webp`;
  outputs.push(out);
  const t = Bun.nanoseconds();
  const { bytes } = await writeAgentGraphWebp(out, {
    captureUrl,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
    webp: WEBP,
  });
  totals.push(ms(t));
  if (!values.quiet)
    console.error(
      `run ${i}: ${totals[i]!.toFixed(0)} ms, ${bytes} bytes → ${out}`,
    );
}

const stageRows: Record<Stage, number>[] = [];
if (values.stages)
  for (let i = 0; i < runs; i++) stageRows.push(await stagedRun());

for (const out of outputs) await Bun.file(out).delete();

if (!values.quiet) {
  const summary = (xs: number[]) => {
    const s = xs.toSorted((a, b) => a - b);
    return `min ${s[0]!.toFixed(0)}  p50 ${s[Math.floor(s.length / 2)]!.toFixed(0)}  max ${s.at(-1)!.toFixed(0)} ms`;
  };
  const warm = totals.slice(1);
  console.log(`first (cold) ${totals[0]!.toFixed(0)} ms`);
  if (warm.length > 0) console.log(`warm ×${warm.length}  ${summary(warm)}`);
  if (stageRows.length > 0) {
    const p50 = (stage: Stage) => {
      const s = stageRows.map((r) => r[stage]).toSorted((a, b) => a - b);
      return s[Math.floor(s.length / 2)]!;
    };
    const total = STAGES.reduce((n, stage) => n + p50(stage), 0);
    console.log(
      `stages p50 ×${stageRows.length} (process start is inside navigate):`,
    );
    for (const stage of STAGES)
      console.log(
        `  ${stage.padEnd(13)} ${p50(stage).toFixed(0).padStart(5)} ms  ${((100 * p50(stage)) / total).toFixed(0).padStart(3)}%`,
      );
  }
}
