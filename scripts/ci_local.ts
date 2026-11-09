#!/usr/bin/env bun
/**
 * Replays the `run` steps of .github/workflows/ci.yml locally, in order. GitHub Actions cannot
 * start on this private repo, so this is the CI run.
 *
 *   bun run ci:local                 every step, stop at the first failure
 *   bun run ci:local --keep-going    run every step, report all failures
 *   bun run ci:local --list          print the steps without running them
 *   bun run ci:local --install       include the `bun install --frozen-lockfile` step
 *   bun run ci:local --event schedule replay the scheduled workflow (live CDN pin included)
 */
import path from "node:path";
import { parseArgs } from "node:util";

import workflowYaml from "../.github/workflows/ci.yml" with { type: "yaml" };
import { stepMatchesEvent } from "../lib/ci_event_filter.ts";

type Step = {
  job: string;
  name: string;
  run: string;
  condition?: string | undefined;
};

const ROOT = path.join(import.meta.dir, "..");
const WORKFLOW = path.join(ROOT, ".github/workflows/ci.yml");
const USAGE =
  "usage: bun run ci:local [--list] [--keep-going] [--install] [--event <name>] [--scheduled]";

function parseCli() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        list: { type: "boolean", default: false },
        "keep-going": { type: "boolean", default: false },
        install: { type: "boolean", default: false },
        event: { type: "string" },
        scheduled: { type: "boolean", default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadSteps(): Step[] {
  const workflow: unknown = workflowYaml;
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    throw new Error(`${WORKFLOW}: no jobs mapping`);
  }
  const steps: Step[] = [];
  for (const [job, spec] of Object.entries(workflow.jobs)) {
    if (!isRecord(spec) || !Array.isArray(spec.steps)) continue;
    for (const step of spec.steps) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      const run = step.run.trim();
      steps.push({
        job,
        name: typeof step.name === "string" ? step.name : run,
        run,
        condition: typeof step.if === "string" ? step.if : undefined,
      });
    }
  }
  return steps;
}

const values = parseCli();
const event = values.event ?? (values.scheduled ? "schedule" : "push");
const steps = loadSteps().filter(
  (step) => values.install || !step.run.startsWith("bun install"),
);
const runsForEvent = (step: Step): boolean =>
  stepMatchesEvent(step.condition, event);

if (values.list) {
  console.log(`event: ${event}\n`);
  for (const [index, step] of steps.entries()) {
    console.log(
      `${String(index + 1).padStart(2)}. ${step.name}\n    ${step.run}${
        runsForEvent(step) ? "" : `\n    (skipped: ${step.condition ?? "if"})`
      }`,
    );
  }
  process.exit(0);
}

const failed: string[] = [];
let skipped = 0;
const started = Bun.nanoseconds();
for (const [index, step] of steps.entries()) {
  if (!runsForEvent(step)) {
    skipped += 1;
    console.log(
      `\n↷ [${index + 1}/${steps.length}] ${step.name}\n  skipped for event=${event}: ${step.condition ?? "if"}`,
    );
    continue;
  }
  console.log(
    `\n▶ [${index + 1}/${steps.length}] ${step.name}\n  $ ${step.run}`,
  );
  const t0 = Bun.nanoseconds();
  // GitHub's default `shell: bash` is `bash --noprofile --norc -eo pipefail`.
  const proc = Bun.spawnSync(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
    {
      cwd: ROOT,
      env: { ...Bun.env, CI: "true" },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const seconds = ((Bun.nanoseconds() - t0) / 1e9).toFixed(1);
  if (proc.exitCode === 0) {
    console.log(`✓ ${step.name} (${seconds}s)`);
    continue;
  }
  console.log(
    `✗ ${step.name} (${seconds}s, exit ${proc.exitCode ?? proc.signalCode})`,
  );
  failed.push(step.name);
  if (!values["keep-going"]) break;
}

const total = ((Bun.nanoseconds() - started) / 1e9).toFixed(1);
if (failed.length === 0) {
  console.log(
    `\nci:local: ${steps.length - skipped} steps passed${
      skipped > 0 ? `, ${skipped} skipped (event=${event})` : ""
    } in ${total}s`,
  );
} else {
  console.log(
    `\nci:local: ${failed.length} failed in ${total}s:\n${failed.map((name) => `  - ${name}`).join("\n")}`,
  );
  process.exit(1);
}
