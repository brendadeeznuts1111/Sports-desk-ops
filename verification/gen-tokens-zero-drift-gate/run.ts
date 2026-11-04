#!/usr/bin/env bun
/**
 * Run TLC via pstack /statechart on GenTokensGate.tla and render chart.svg (blueprint Pele).
 * Exit code matches TLC: expect 1 while checkout reset allows silent skip (documented finding).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render, PeleError } from "pele";
import { injectBlueprintStyle } from "./pele-blueprint-style.ts";

const dir = import.meta.dir;
const spec = path.join(dir, "GenTokensGate.tla");
const config = path.join(dir, "GenTokensGate.cfg");
const view = path.join(dir, "view.mjs");
const outScratch = path.join(dir, "out");
const chartMmd = path.join(dir, "chart.mmd");
const chartSvg = path.join(dir, "chart.svg");
const reportMd = path.join(dir, "report.md");

const PELE_OPTS = {
  limit: 1_000_000,
  outputLimit: 8_000_000,
  maxEdges: 10_000,
} as const;

const HELP =
  "verify:gen-tokens-gate [--no-render]\n" +
  "  Runs TLC (pstack statechart) on verification/gen-tokens-zero-drift-gate/.\n" +
  "  Expect exit 1 until the gate matches NoSilentPassWhenGenSkips (checkout skip hole).\n" +
  "  Env: PSTACK_STATECHART, TLA2TOOLS, JAVA; mise on PATH installs Java/TLC on first run.";

function findStatechart(): string {
  const fromEnv = Bun.env.PSTACK_STATECHART?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const root = path.join(
    os.homedir(),
    ".cursor/plugins/cache/cursor-public/pstack",
  );
  if (!fs.existsSync(root)) {
    throw new Error(
      "Cannot find pstack statechart. Set PSTACK_STATECHART to the statechart script path.",
    );
  }
  const versions = fs
    .readdirSync(root)
    .map((name) =>
      path.join(root, name, "skills/statechart/scripts/statechart"),
    )
    .filter((p) => fs.existsSync(p));
  if (versions.length === 0) {
    throw new Error(
      "No statechart script under ~/.cursor/plugins/cache/cursor-public/pstack. Install pstack or set PSTACK_STATECHART.",
    );
  }
  versions.sort(
    (a, b) => (fs.statSync(b).mtimeMs ?? 0) - (fs.statSync(a).mtimeMs ?? 0),
  );
  return versions[0]!;
}

function emptyDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

function runStatechart(): number {
  const statechart = findStatechart();
  const env = { ...Bun.env };
  const homeBin = path.join(os.homedir(), ".local/bin");
  if (!env.PATH?.includes(homeBin)) {
    env.PATH = `${homeBin}:${env.PATH ?? ""}`;
  }

  emptyDir(outScratch);
  const r = spawnSync(
    statechart,
    [spec, "--config", config, "--view", view, "--out", outScratch],
    { env, stdio: "inherit", encoding: "utf-8" },
  );
  if (r.error) {
    console.error(r.error.message);
    return 2;
  }
  if (r.signal) return r.status === null ? 143 : 130;

  const scratchReport = path.join(outScratch, "report.md");
  const scratchChart = path.join(outScratch, "chart.mmd");
  if (fs.existsSync(scratchReport)) {
    fs.copyFileSync(scratchReport, reportMd);
  }
  if (fs.existsSync(scratchChart)) {
    fs.copyFileSync(scratchChart, chartMmd);
  }

  return r.status ?? 2;
}

function renderChart(): void {
  if (!fs.existsSync(chartMmd)) {
    console.error("No chart.mmd from statechart (no rule break or TLC error).");
    return;
  }
  const mmd = fs.readFileSync(chartMmd, "utf-8");
  try {
    const { svg } = render(mmd, PELE_OPTS);
    fs.writeFileSync(chartSvg, injectBlueprintStyle(svg));
    console.log(`Wrote ${chartSvg}`);
  } catch (e) {
    console.error("Pele render failed; Mermaid source is in chart.mmd");
    if (e instanceof PeleError) console.error(e.message);
    else console.error(e);
  }
}

const noRender = process.argv.includes("--no-render");
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const code = runStatechart();
if (!noRender) renderChart();
if (fs.existsSync(reportMd)) {
  console.log(fs.readFileSync(reportMd, "utf-8"));
}
process.exit(code);
