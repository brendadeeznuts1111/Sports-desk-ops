#!/usr/bin/env bun
/**
 * Times captureAgentGraphWebp in-process: N runs, each writing its own /tmp file, reported as
 * min / p50 / max with the cold first run listed apart. --stages loads the page once in one view
 * and takes N screenshots from it (first discarded), splitting capture from encode and reporting
 * pixel size and bytes, since the backend decides both (WebKit follows the display scale).
 *
 *   bun run bench:capture                 # 5 runs
 *   bun run bench:capture --runs 10 --stages --backend chrome
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
    backend: { type: "string", default: "webkit" },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`bench:capture — time captureAgentGraphWebp (WebView → PNG → Bun.Image WebP)

Options:
  --runs <n>   Runs (default 5); each writes /tmp/bench-capture-<pid>-<i>.webp
  --stages     Also load once and time N screenshots on that view: PNG capture, resize+WebP
               (as captureAgentGraphWebp does), and on chrome the native WebP screenshot
  --backend    webkit (default, as captureAgentGraphWebp) or chrome
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
function parseBackend(value: string): "webkit" | "chrome" {
  if (value === "webkit" || value === "chrome") return value;
  console.error(
    `bench:capture: --backend must be webkit or chrome, got ${value}`,
  );
  process.exit(2);
}
const backend = parseBackend(values.backend);

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
await using server = Bun.serve({
  port: 0,
  fetch: (req) => handleAgentGraphViewRequest(req, paths),
});
const captureUrl = `http://127.0.0.1:${server.port}/capture.html`;

const ms = (from: number) => (Bun.nanoseconds() - from) / 1e6;
const p50 = (xs: readonly number[]) =>
  xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const pixels = async (blob: Blob) => {
  const { width, height } = await new Bun.Image(blob).metadata();
  return `${width}x${height}`;
};

type StageReport = {
  setupMs: number;
  devicePixelRatio: unknown;
  shotMs: number[];
  transformMs: number[];
  nativeMs: number[];
  png: { pixels: string; bytes: number };
  webp: { pixels: string; bytes: number };
  native: { pixels: string; bytes: number } | null;
};

/** One view, loaded once; `runs` screenshots from it with the first discarded as cold. */
async function stages(): Promise<StageReport> {
  const t = Bun.nanoseconds();
  await using view = ManagedWebView.launch({ ...VIEWPORT, backend });
  await view.navigate(captureUrl, { timeoutMs: 30_000 });
  await view.evaluate(AGENT_GRAPH_READY_EVAL);
  const report: StageReport = {
    setupMs: ms(t),
    devicePixelRatio: await view.evaluate("window.devicePixelRatio"),
    shotMs: [],
    transformMs: [],
    nativeMs: [],
    png: { pixels: "", bytes: 0 },
    webp: { pixels: "", bytes: 0 },
    native: null,
  };
  for (let i = 0; i <= runs; i++) {
    const t0 = Bun.nanoseconds();
    const png = await view.screenshotBlob({ format: "png" });
    const shot = ms(t0);
    const t1 = Bun.nanoseconds();
    const webp = await webpBytesFromScreenshotBlob(png, WEBP);
    const transform = ms(t1);
    let native: Blob | null = null;
    let nativeMs = 0;
    if (backend === "chrome") {
      const t2 = Bun.nanoseconds();
      native = await view.screenshotBlob({
        format: "webp",
        quality: WEBP.quality,
      });
      nativeMs = ms(t2);
    }
    if (i === 0) continue;
    report.shotMs.push(shot);
    report.transformMs.push(transform);
    if (native) report.nativeMs.push(nativeMs);
    report.png = { pixels: await pixels(png), bytes: png.size };
    report.webp = { pixels: await pixels(webp), bytes: webp.size };
    if (native)
      report.native = { pixels: await pixels(native), bytes: native.size };
  }
  return report;
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
    backend,
    webp: WEBP,
  });
  totals.push(ms(t));
  if (!values.quiet)
    console.error(
      `run ${i}: ${totals[i]!.toFixed(0)} ms, ${bytes} bytes → ${out}`,
    );
}

const staged = values.stages ? await stages() : null;

for (const out of outputs) await Bun.file(out).delete();

if (!values.quiet) {
  const summary = (xs: number[]) => {
    const s = xs.toSorted((a, b) => a - b);
    return `min ${s[0]!.toFixed(0)}  p50 ${s[Math.floor(s.length / 2)]!.toFixed(0)}  max ${s.at(-1)!.toFixed(0)} ms`;
  };
  const warm = totals.slice(1);
  console.log(`${backend}: first (cold) ${totals[0]!.toFixed(0)} ms`);
  if (warm.length > 0) console.log(`warm ×${warm.length}  ${summary(warm)}`);
  if (staged) {
    const row = (label: string, xs: number[], out: string) =>
      console.log(
        `  ${label.padEnd(20)} p50 ${p50(xs).toFixed(0).padStart(4)} ms  ${out}`,
      );
    const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
    console.log(
      `stages: one view, load ${staged.setupMs.toFixed(0)} ms, devicePixelRatio ${String(staged.devicePixelRatio)}, ${staged.shotMs.length} screenshots after a discarded first`,
    );
    row(
      "png screenshot",
      staged.shotMs,
      `${staged.png.pixels}, ${kb(staged.png.bytes)}`,
    );
    row(
      "resize + webp",
      staged.transformMs,
      `${staged.webp.pixels}, ${kb(staged.webp.bytes)}`,
    );
    console.log(
      `  ${"= current pipeline".padEnd(20)} p50 ${(p50(staged.shotMs) + p50(staged.transformMs)).toFixed(0).padStart(4)} ms`,
    );
    if (staged.native)
      row(
        "native webp shot",
        staged.nativeMs,
        `${staged.native.pixels}, ${kb(staged.native.bytes)}`,
      );
  }
}
