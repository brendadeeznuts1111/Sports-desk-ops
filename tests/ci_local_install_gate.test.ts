import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import workflowYaml from "../.github/workflows/ci.yml" with { type: "yaml" };
import { isInstallStep } from "../lib/ci_install_step.ts";

/**
 * The workflows install with `bun ci --no-env-file`, and `ci:local` documents that it omits the
 * install steps unless `--install`. Those two facts have to agree. The gate matched
 * `bun install` only, so once the workflows moved to `bun ci` every plain replay installed
 * dependencies and `--install` added nothing. These cases pin the predicate against the real
 * workflow, so a future rename cannot reopen the gate without failing here.
 */

const ROOT = join(import.meta.dir, "..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkflowStep {
  readonly job: string;
  readonly run: string;
}

function workflowRunSteps(): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  if (!isRecord(workflowYaml)) return steps;
  const jobs = workflowYaml["jobs"];
  if (!isRecord(jobs)) return steps;
  for (const [job, spec] of Object.entries(jobs)) {
    if (!isRecord(spec)) continue;
    const list = spec["steps"];
    if (!Array.isArray(list)) continue;
    for (const step of list) {
      if (!isRecord(step)) continue;
      const run = step["run"];
      if (typeof run === "string") steps.push({ job, run });
    }
  }
  return steps;
}

describe("isInstallStep", () => {
  test("recognizes both spellings, with and without arguments", () => {
    const installs = [
      "bun ci",
      "bun ci --no-env-file",
      "bun ci --dry-run --os=linux --libc=musl --no-env-file",
      "bun install",
      "bun install --frozen-lockfile",
      "  bun ci --no-env-file  ",
    ];
    expect(installs.filter((run) => !isInstallStep(run))).toEqual([]);
  });

  test("leaves commands that merely begin with the same letters alone", () => {
    const others = [
      "bun run ci:local",
      "bun run ci:local --install",
      "bun test tests/",
      "bun run format:check",
      "npm ci",
      "bun cix",
    ];
    expect(others.filter((run) => isInstallStep(run))).toEqual([]);
  });
});

describe("ci:local install gate", () => {
  function listed(extra: readonly string[]): string {
    const proc = Bun.spawnSync(
      [process.execPath, "run", "scripts/ci_local.ts", "--list", ...extra],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...Bun.env, NO_COLOR: "1" },
      },
    );
    expect(proc.exitCode).toBe(0);
    return proc.stdout.toString();
  }

  const installLines = (listing: string): string[] =>
    listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => isInstallStep(line));

  test("the real workflow still has install steps for the gate to cover", () => {
    const installShaped = workflowRunSteps().filter((step) =>
      /^bun (ci|install)\b/.test(step.run.trim()),
    );
    // Zero here would make the replay cases below vacuous.
    expect(installShaped.length).toBeGreaterThan(0);
    expect(installShaped.filter((step) => !isInstallStep(step.run))).toEqual(
      [],
    );
    expect(
      installShaped.some((step) => step.run.trim().startsWith("bun ci")),
    ).toBe(true);
  }, 30_000);

  test("a plain replay omits the install steps", () => {
    expect(installLines(listed([]))).toEqual([]);
  }, 30_000);

  test("--install runs them", () => {
    expect(installLines(listed(["--install"])).length).toBeGreaterThan(0);
  }, 30_000);
});
