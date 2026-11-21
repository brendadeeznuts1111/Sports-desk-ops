/**
 * `scripts/agent_tree_doctor.ts` over synthetic checkouts. The command is the only place that
 * compares `scratch/agent-graph.manifest.json`'s `envelopeSha256` with the envelope on disk, so
 * these tests pin the verdicts for the three states a real checkout reaches: coherent, graph one
 * capture behind, and a scheduled argv that would rewrite the artifacts with mangled keys.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  argvHasHierarchy,
  exitCode,
  parseRepoFlag,
  renderReport,
  runDoctor,
  sha256Hex,
  type Check,
  type ScheduledJob,
} from "../scripts/agent_tree_doctor.ts";

const TREES: string[] = [];

afterEach(() => {
  for (const dir of TREES.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const WITH_HIERARCHY: ScheduledJob = {
  id: "sched_agent_tree_hourly",
  bin: "bun",
  args: [
    "--no-orphans",
    "--no-env-file",
    "run",
    "scripts/build_agent_tree.ts",
    "--hierarchy",
    "scratch/raw-f402-list-agents.json",
  ],
  requires: ["F402_BEARER_TOKEN"],
};

const WITHOUT_HIERARCHY: ScheduledJob = {
  ...WITH_HIERARCHY,
  args: ["--no-orphans", "--no-env-file", "run", "scripts/build_agent_tree.ts"],
};

function write(root: string, relative: string, payload: unknown): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
}

interface Fixture {
  readonly root: string;
  readonly envelopeSha: string;
  /** The three committed artifacts, for tests that need their exact bytes. */
  readonly artifacts: {
    readonly tree: unknown;
    readonly index: unknown;
  };
}

async function fixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-tree-doctor-test-"),
  );
  TREES.push(root);
  const envelope = {
    GENERAL: [
      { Login: "A", AgentID: 1 },
      { Login: "B", AgentID: 2 },
    ],
  };
  const tree = {
    schemaVersion: 1,
    source: "scratch/agent-graph.json",
    agentCount: 2,
    roots: ["A"],
    collisions: 0,
    nodes: {
      A: { l: 0, p: null, t: "M" },
      B: { l: 1, p: "A", t: "A" },
    },
  };
  // One key (`C`) is an overflow row the graph skipped, which is what the index legitimately
  // holds beyond the tree.
  const index = {
    schemaVersion: 1,
    source: "scratch/raw-f402-list-agents.json",
    agentCount: 3,
    agents: { A: { l: 0 }, B: { l: 1 }, C: { l: 2 } },
  };
  write(root, "scratch/raw-f402-list-agents.json", envelope);
  write(root, "scratch/agent-graph.json", { elements: { nodes: [] } });
  write(root, "data/agent-tree.json", tree);
  write(root, "data/agent-index.json", index);
  const envelopeSha = (await sha256Hex(
    path.join(root, "scratch/raw-f402-list-agents.json"),
  )) as string;
  write(root, "scratch/agent-graph.manifest.json", {
    version: 1,
    envelopeSha256: envelopeSha,
    envelopeGeneralRows: 2,
    nodeCount: 2,
    skippedOverflowCount: 1,
    builtAt: "2026-11-01T18:54:53.924Z",
  });
  return { root, envelopeSha, artifacts: { tree, index } };
}

function byId(checks: readonly Check[], id: string): Check {
  const found = checks.find((check) => check.id === id);
  expect(found).toBeDefined();
  return found as Check;
}

describe("runDoctor", () => {
  test("a coherent chain has no FAIL check", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, { scheduledJob: WITH_HIERARCHY });
    expect(checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(byId(checks, "graph-envelope-sha").status).toBe("ok");
    expect(byId(checks, "tree-covered-by-index").status).toBe("ok");
    expect(byId(checks, "overflow-invariant").status).toBe("ok");
    expect(byId(checks, "schedule-argv").status).toBe("ok");
  });

  test("a replaced envelope is the staleness signal, not the file age", async () => {
    const { root } = await fixture();
    write(root, "scratch/raw-f402-list-agents.json", {
      GENERAL: [{ Login: "A", AgentID: 1 }],
    });
    const checks = await runDoctor(root, { scheduledJob: WITH_HIERARCHY });
    const freshness = byId(checks, "graph-envelope-sha");
    expect(freshness.status).toBe("fail");
    expect(freshness.detail).toContain("manifest expects");
    expect(freshness.fix).toContain("graph:agent");
    expect(exitCode(checks)).toBe(1);
  });

  test("a missing index fails instead of reporting a covered tree", async () => {
    const { root } = await fixture();
    fs.rmSync(path.join(root, "data/agent-index.json"));
    const checks = await runDoctor(root, { scheduledJob: WITH_HIERARCHY });
    expect(byId(checks, "index").status).toBe("fail");
    expect(checks.some((check) => check.id === "tree-covered-by-index")).toBe(
      false,
    );
  });

  test("a tree node absent from the index fails the coverage check", async () => {
    const { root, artifacts } = await fixture();
    write(root, "data/agent-index.json", {
      schemaVersion: 1,
      agentCount: 2,
      agents: { A: { l: 0 }, C: { l: 2 } },
    });
    const checks = await runDoctor(root, { scheduledJob: WITH_HIERARCHY });
    const coverage = byId(checks, "tree-covered-by-index");
    expect(coverage.status).toBe("fail");
    expect(coverage.detail).toContain("B");
    expect(artifacts.index).toBeDefined();
  });

  test("overflow drift is a warn, because both artifacts can be valid but out of step", async () => {
    const { root } = await fixture();
    write(root, "scratch/agent-graph.manifest.json", {
      envelopeSha256: (await sha256Hex(
        path.join(root, "scratch/raw-f402-list-agents.json"),
      )) as string,
      nodeCount: 2,
      skippedOverflowCount: 5,
      builtAt: "2026-11-01T18:54:53.924Z",
    });
    const checks = await runDoctor(root, { scheduledJob: WITH_HIERARCHY });
    expect(byId(checks, "overflow-invariant").status).toBe("warn");
    expect(exitCode(checks)).toBe(0);
  });

  test("a scheduled argv without --hierarchy fails and states the consequence", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, { scheduledJob: WITHOUT_HIERARCHY });
    const argv = byId(checks, "schedule-argv");
    expect(argv.status).toBe("fail");
    expect(argv.title).toContain("empty the index");
    expect(argv.fix).toContain("--hierarchy");
  });

  test("an absent schedule fails instead of implying a rebuild cadence", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, { scheduledJob: null });
    expect(byId(checks, "schedule").status).toBe("fail");
  });

  test("an unreadable scheduler spec is a warn, not a crash", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, {
      loadSchedule: async () => {
        throw new Error("scheduler module exploded");
      },
    });
    const schedule = byId(checks, "schedule");
    expect(schedule.status).toBe("warn");
    expect(schedule.detail).toContain("scheduler module exploded");
    expect(exitCode(checks)).toBe(0);
  });

  test("a credential gate unmet in this process is only a warn", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, {
      scheduledJob: { ...WITH_HIERARCHY, requires: ["DSH_DOCTOR_ABSENT_VAR"] },
    });
    expect(byId(checks, "schedule-requires").status).toBe("warn");
    expect(exitCode(checks)).toBe(0);
  });

  test("--rebuild-check passes when the scheduled argv reproduces the pair", async () => {
    const { root, artifacts } = await fixture();
    const checks = await runDoctor(root, {
      scheduledJob: WITH_HIERARCHY,
      rebuildCheck: true,
      runBuild: async (_argv, dir) => {
        const tree = path.join(dir, "agent-tree.json");
        const index = path.join(dir, "agent-index.json");
        fs.writeFileSync(tree, JSON.stringify(artifacts.tree));
        fs.writeFileSync(index, JSON.stringify(artifacts.index));
        return { tree, index };
      },
    });
    expect(byId(checks, "rebuild").status).toBe("ok");
    expect(exitCode(checks)).toBe(0);
  });

  test("--rebuild-check fails when the rebuild empties the index", async () => {
    const { root, artifacts } = await fixture();
    const checks = await runDoctor(root, {
      scheduledJob: WITHOUT_HIERARCHY,
      rebuildCheck: true,
      runBuild: async (_argv, dir) => {
        const tree = path.join(dir, "agent-tree.json");
        const index = path.join(dir, "agent-index.json");
        fs.writeFileSync(tree, JSON.stringify(artifacts.tree));
        fs.writeFileSync(
          index,
          JSON.stringify({
            schemaVersion: 1,
            agentCount: 0,
            agents: {},
          }),
        );
        return { tree, index };
      },
    });
    const rebuild = byId(checks, "rebuild");
    expect(rebuild.status).toBe("fail");
    expect(rebuild.detail).toContain("0 agent(s)");
  });

  test("--rebuild-check reports an unmeasured build as a warn, never as a pass", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, {
      scheduledJob: WITH_HIERARCHY,
      rebuildCheck: true,
      runBuild: async () => null,
    });
    expect(byId(checks, "rebuild").status).toBe("warn");
  });
});

describe("flags", () => {
  test("argvHasHierarchy ignores a flag that is only a value of another argument", () => {
    expect(argvHasHierarchy(WITH_HIERARCHY.args)).toBe(true);
    expect(argvHasHierarchy(WITHOUT_HIERARCHY.args)).toBe(false);
  });

  test("parseRepoFlag reads both forms and refuses a missing value", () => {
    expect(parseRepoFlag([])).toBeNull();
    expect(parseRepoFlag(["--repo", "/tmp/x"])).toBe("/tmp/x");
    expect(parseRepoFlag(["--repo=/tmp/x"])).toBe("/tmp/x");
    expect(parseRepoFlag(["--repo", "--json"])).toBe("");
  });
});

describe("renderReport", () => {
  test("fails are summarised, and a clean run says so", () => {
    const failing: Check[] = [
      {
        id: "x",
        status: "fail",
        title: "graph is stale",
        detail: "sha mismatch",
        fix: "bun run graph:agent",
      },
    ];
    const rendered = renderReport(failing, "/repo");
    expect(rendered).toContain("agent-tree:doctor · /repo");
    expect(rendered).toContain("FAIL graph is stale");
    expect(rendered).toContain("fix: bun run graph:agent");
    expect(rendered).toContain("RESULT: FAIL");

    const clean = renderReport(
      [{ id: "y", status: "ok", title: "all good" }],
      "/repo",
    );
    expect(clean).toContain("RESULT: PASS — the chain is coherent");
    expect(exitCode([{ id: "y", status: "ok", title: "all good" }])).toBe(0);
  });
});

describe("schedule run state from /api/status", () => {
  const statusWith = (lastRun: unknown) => ({
    telegram: {
      schedules: [{ id: "sched_agent_tree_hourly", lastRun }],
    },
  });

  const run = (root: string, payload: unknown) =>
    runDoctor(root, {
      scheduledJob: WITH_HIERARCHY,
      readStatus: async () => payload,
    });

  test("an unreadable status is a warn, never a crash", async () => {
    const { root } = await fixture();
    const checks = await run(root, null);
    expect(byId(checks, "schedule-run").status).toBe("warn");
    expect(byId(checks, "schedule-run").title).toContain("could not be read");
  });

  test("a schedule with no lastRun has not run since the daemon started", async () => {
    const { root } = await fixture();
    const checks = await run(root, statusWith(undefined));
    const check = byId(checks, "schedule-run");
    expect(check.status).toBe("warn");
    expect(check.title).toContain("has not run");
  });

  test("a skipped run names the unmet requirement", async () => {
    const { root } = await fixture();
    const checks = await run(
      root,
      statusWith({
        at: new Date().toISOString(),
        status: "skipped",
        detail: "missing F402_BEARER_TOKEN",
        missing: ["F402_BEARER_TOKEN"],
      }),
    );
    const check = byId(checks, "schedule-run");
    expect(check.status).toBe("warn");
    expect(check.title).toContain("missing F402_BEARER_TOKEN");
    expect(check.fix).toContain("restart");
  });

  test("a failed run is the only failing verdict", async () => {
    const { root } = await fixture();
    const checks = await run(
      root,
      statusWith({
        at: new Date().toISOString(),
        status: "failed",
        detail: "exit 2",
        missing: [],
      }),
    );
    expect(byId(checks, "schedule-run").status).toBe("fail");
    expect(exitCode(checks)).toBe(1);
  });

  test("an ok run reports its age", async () => {
    const { root } = await fixture();
    const checks = await run(
      root,
      statusWith({
        at: new Date(Date.now() - 12 * 60_000).toISOString(),
        status: "ok",
        detail: null,
        missing: [],
      }),
    );
    const check = byId(checks, "schedule-run");
    expect(check.status).toBe("ok");
    expect(check.title).toContain("12 min ago");
  });

  test("an unprobed status adds no run-state check at all", async () => {
    const { root } = await fixture();
    const checks = await runDoctor(root, { scheduledJob: WITH_HIERARCHY });
    expect(checks.some((check) => check.id === "schedule-run")).toBe(false);
  });
});
