import { describe, expect, test } from "bun:test";
import {
  buildHierarchy,
  type RawHierarchyTree,
} from "../lib/hierarchy_view.ts";

/**
 * The committed tree is flat: `nodes[login] = { p: parent, l: level, t: "M"|"A" }`. Subtree size is
 * a full walk per question, which the browser cannot do on every render — so it is folded once here
 * and the payload's defects are reported instead of silently dropped.
 */

const node = (p: string | null, t: string | null = "A", l = 1) => ({ p, t, l });

describe("buildHierarchy", () => {
  test("a chain folds its descendants and its depth", () => {
    const view = buildHierarchy({
      nodes: { A: node(null, "M"), B: node("A"), C: node("B") },
      roots: ["A"],
    });
    expect(view.roots).toHaveLength(1);
    const root = view.roots[0]!;
    expect(root.rollup).toEqual({ agents: 2, depth: 2 });
    expect(root.children[0]?.rollup).toEqual({ agents: 1, depth: 1 });
    expect(root.children[0]?.children[0]?.rollup).toEqual({
      agents: 0,
      depth: 0,
    });
    expect(view.stats).toMatchObject({ nodes: 3, reachable: 3, maxDepth: 2 });
    expect(view.roots[0]?.depth).toBe(0);
    expect(view.roots[0]?.children[0]?.depth).toBe(1);
  });

  test("a fan-out counts direct and transitive agents", () => {
    const view = buildHierarchy({
      nodes: {
        R: node(null, "M"),
        X: node("R"),
        Y: node("R"),
        X1: node("X"),
        Y1: node("Y"),
      },
      roots: ["R"],
    });
    expect(view.roots[0]?.childrenCount).toBe(2);
    expect(view.roots[0]?.rollup).toEqual({ agents: 4, depth: 2 });
  });

  test("a missing parent is reported and does not vanish", () => {
    const view = buildHierarchy({
      nodes: { A: node(null, "M"), B: node("GHOST") },
      roots: ["A"],
    });
    expect(view.stats.unparented).toBe(1);
    expect(view.problems.join("\n")).toContain(
      "parent GHOST is not in the tree",
    );
    expect(view.roots.map((root) => root.id).sort()).toEqual(["A", "B"]);
    expect(view.stats.reachable).toBe(2);
  });

  test("a cycle is cut, reported, and does not hang", () => {
    const view = buildHierarchy({
      nodes: { A: node("B"), B: node("A") },
      roots: ["A"],
    });
    expect(view.problems.join("\n")).toContain("cycle");
    expect(view.stats.reachable).toBeLessThanOrEqual(2);
  });

  test("collisions and unknown types are surfaced", () => {
    const view = buildHierarchy({
      nodes: { A: node(null, "M"), B: node("A", null) },
      roots: ["A"],
      collisions: [{ key: "BRANDON", agentIds: ["BRANDON.", "BRANDON.."] }],
    });
    expect(view.problems.join("\n")).toContain(
      "BRANDON is owned by 2 AgentIDs",
    );
    expect(view.stats.byKind).toEqual({ master: 1, agent: 0, unknown: 1 });
  });

  test("a declared root that is not a node is reported", () => {
    const view = buildHierarchy({
      nodes: { A: node(null) },
      roots: ["A", "NOPE"],
    });
    expect(view.problems.join("\n")).toContain(
      "declared root NOPE is not a node",
    );
  });

  test("the committed tree: one root carries the hierarchy, three are isolated", async () => {
    const tree = (await Bun.file(
      new URL("../data/agent-tree.json", import.meta.url),
    ).json()) as RawHierarchyTree;
    const view = buildHierarchy(tree);

    expect(view.stats.nodes).toBe(2276);
    expect(view.stats.roots).toBe(4);
    // The portal's `l` saturates at 12 while the parent edges run 24 deep, so depth comes from
    // the edges and the disagreement is reported rather than trusted.
    expect(view.stats.maxDepth).toBe(24);
    expect(view.stats.levelMismatches).toBe(2255);
    expect(view.problems.join("\n")).toContain(
      "level field disagrees with parent-chain depth",
    );

    const byId = new Map(view.roots.map((root) => [root.id, root]));
    expect(byId.get("NOLAWOLF")?.rollup.agents).toBe(2272);
    for (const isolated of ["BILLY667", "RTEST5", "SAINTS2009"]) {
      expect(byId.get(isolated)?.rollup.agents).toBe(0);
    }
    // One key is owned by two AgentIDs in the source.
    expect(view.problems.join("\n")).toContain("BRANDON");
    // Every node is reachable exactly once.
    expect(view.stats.reachable).toBe(2276);
  });
});
