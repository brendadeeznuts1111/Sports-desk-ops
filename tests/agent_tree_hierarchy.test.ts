import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * `/api/agent-tree` is the flat map: it tells you an agent exists, not how much sits under it.
 * `?view=hierarchy` folds the parent edges once, server-side, and reports the payload's defects.
 */

const savedToken = process.env["SPORTSDESK_ADMIN_TOKEN"];
Reflect.deleteProperty(process.env, "SPORTSDESK_ADMIN_TOKEN");

const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  if (savedToken === undefined) {
    Reflect.deleteProperty(process.env, "SPORTSDESK_ADMIN_TOKEN");
  } else {
    Reflect.set(process.env, "SPORTSDESK_ADMIN_TOKEN", savedToken);
  }
});

interface Node {
  id: string;
  depth: number;
  level: number | null;
  childrenCount: number;
  rollup: { agents: number; depth: number };
  action: { games: number; wagered: number; toWin: number } | null;
  children: Node[];
}

describe("/api/agent-tree?view=hierarchy", () => {
  test("returns the folded tree with rollups and the payload's problems", async () => {
    const response = await fetch(`${base}/api/agent-tree?view=hierarchy`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      roots: Node[];
      stats: Record<string, number>;
      problems: string[];
    };
    expect(body.success).toBe(true);
    expect(body.stats["nodes"]).toBe(2276);
    expect(body.roots).toHaveLength(4);

    const wolf = body.roots.find((root) => root.id === "NOLAWOLF");
    expect(wolf?.rollup.agents).toBe(2272);
    expect(wolf?.depth).toBe(0);
    expect(wolf?.childrenCount).toBeGreaterThan(0);
    expect(wolf?.children[0]?.depth).toBe(1);
    // The portal's level field does not agree with the edges; both are reported.
    expect(body.stats["levelMismatches"]).toBe(2255);
    expect(body.problems.join("\n")).toContain("level field disagrees");
  });

  test("the flat view is unchanged", async () => {
    const response = await fetch(`${base}/api/agent-tree`);
    const body = (await response.json()) as {
      nodes?: Record<string, unknown>;
      counts?: Record<string, unknown>;
      roots?: string[];
    };
    expect(body.nodes).toBeDefined();
    expect(body.counts).toBeDefined();
    expect(body.roots).toEqual([
      "BILLY667",
      "NOLAWOLF",
      "RTEST5",
      "SAINTS2009",
    ]);
  });

  test("rollups are a fold over the edges, not the level field", async () => {
    const body = (await (
      await fetch(`${base}/api/agent-tree?view=hierarchy`)
    ).json()) as { roots: Node[] };
    const wolf = body.roots.find((root) => root.id === "NOLAWOLF")!;
    // Depth-first sum must equal the rollup at every level.
    const sum = (node: Node): number =>
      node.children.reduce((n, child) => n + 1 + sum(child), 0);
    expect(sum(wolf)).toBe(wolf.rollup.agents);
  });
});
