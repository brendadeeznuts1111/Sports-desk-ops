/**
 * The agent tree the desk counts is a live hierarchy capture, or it says it is not one.
 * `--live` must refuse to rewrite `data/agent-tree.json` from the scratch graph.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentTreeFileFromGraph } from "../lib/agent_tree_build.ts";
import {
  fixtureEscapeSource,
  LIVE_AGENT_TREE_SOURCE,
  liveTreeOverflow,
} from "../lib/agent_tree_live.ts";
import { isFixtureAgentTreeGraphSource } from "../lib/agent_tree.ts";

const REPO = join(import.meta.dir, "..");

describe("buildAgentTreeFileFromGraph", () => {
  test("a live build stamps the portal source and capturedAt, not the scratch path", () => {
    const capturedAt = "2026-11-20T16:00:00.000Z";
    const file = buildAgentTreeFileFromGraph({
      graph: {
        nodes: [{ data: { id: "A1", level: 1 } }],
        edges: [],
      },
      source: LIVE_AGENT_TREE_SOURCE,
      capturedAt,
    });
    expect(file.source).toBe("live:f402-list-agents-by-agent");
    expect(file.capturedAt).toBe(capturedAt);
    expect(file.agentCount).toBe(1);
    expect(isFixtureAgentTreeGraphSource(file.source)).toBe(false);
  });

  test("level 13+ rows the portal parser drops are stamped partial, not a complete capture", () => {
    expect(liveTreeOverflow([])).toEqual({ partial: false, omittedCount: 0 });
    expect(liveTreeOverflow([{ level: 13 }, { level: 14 }])).toEqual({
      partial: true,
      omittedCount: 2,
    });
    const file = buildAgentTreeFileFromGraph({
      graph: {
        nodes: [{ data: { id: "A1", level: 12 } }],
        edges: [],
      },
      source: LIVE_AGENT_TREE_SOURCE,
      capturedAt: "2026-11-20T16:00:00.000Z",
      ...liveTreeOverflow([{ level: 13 }]),
    });
    expect(file.partial).toBe(true);
    expect(file.omittedCount).toBe(1);
    expect(file.agentCount).toBe(1);
  });
});

describe("build:agent-tree --live", () => {
  test("refuses to write when the account fixture and the session are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tree-live-"));
    const out = join(dir, "agent-tree.json");
    const result = Bun.spawnSync(
      ["bun", "scripts/build_agent_tree.ts", "--live", "--out", out],
      {
        cwd: REPO,
        env: {
          ...Bun.env,
          F402_GRAPH_ACCOUNT: "",
          F402_SESSION_FILE: join(dir, "no-session.json"),
          F402_REPLAY_PROXY_URL: "",
          F402_COOKIE: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("F402_GRAPH_ACCOUNT");
    expect(stderr).toContain("scratch/agent-graph.json");
    expect(stderr).toContain("--allow-fixture");
    expect(Bun.file(out).size).toBe(0);
  });

  test("refuses to write when the account fixture is set and the session is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tree-live-"));
    const out = join(dir, "agent-tree.json");
    const account = join(
      REPO,
      "tests/fixtures/f402-get-account-info-owner-fixture.json",
    );
    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/build_agent_tree.ts",
        "--live",
        "--account",
        account,
        "--out",
        out,
      ],
      {
        cwd: REPO,
        env: {
          ...Bun.env,
          F402_GRAPH_ACCOUNT: "",
          F402_SESSION_FILE: join(dir, "no-session.json"),
          F402_REPLAY_PROXY_URL: "",
          F402_COOKIE: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = result.stderr.toString();
    expect(result.exitCode).not.toBe(0);
    expect(stderr).toContain("manager session");
    expect(stderr).toContain("scratch/agent-graph.json");
    expect(stderr).toContain("--allow-fixture");
    expect(stderr).not.toContain("FIXTURE_LOGIN");
    expect(Bun.file(out).size).toBe(0);
  });

  test("--allow-fixture writes the local graph as a fixture when live cannot run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tree-live-"));
    const out = join(dir, "agent-tree.json");
    const graph = join(dir, "graph.json");
    await Bun.write(
      graph,
      JSON.stringify({
        nodes: [{ data: { id: "A1", level: 1 } }],
        edges: [],
      }),
    );
    const result = Bun.spawnSync(
      [
        "bun",
        "scripts/build_agent_tree.ts",
        "--live",
        "--allow-fixture",
        "--graph",
        graph,
        "--out",
        out,
        "--no-index",
      ],
      {
        cwd: REPO,
        env: {
          ...Bun.env,
          F402_GRAPH_ACCOUNT: "",
          F402_SESSION_FILE: join(dir, "no-session.json"),
          F402_REPLAY_PROXY_URL: "",
          F402_COOKIE: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = result.stderr.toString();
    expect(result.exitCode).toBe(0);
    expect(stderr).toContain("escape hatch");
    expect(stderr).toContain("--allow-fixture");
    const written = await Bun.file(out).json();
    expect(written.source).toBe(fixtureEscapeSource(graph));
    expect(written.capturedAt).toBeUndefined();
    expect(written.agentCount).toBe(1);
    expect(isFixtureAgentTreeGraphSource(written.source)).toBe(true);
  });
});
