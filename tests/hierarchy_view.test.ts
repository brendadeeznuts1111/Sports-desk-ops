import { describe, expect, test } from "bun:test";
import {
  buildHierarchy,
  type HierarchyNode,
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

  /**
   * `l` is the portal's level field, and this pins the shape of its defect so a data refresh that
   * changes it fails here rather than silently shifting a UI. Below the cap it tracks the chain
   * (1,951 edges), skips a level on 208 edges, and saturates at 12 on the remaining 110 — which is
   * why the mismatch is accumulated (2,255 nodes) rather than wholesale.
   */
  test("the committed tree: level saturates and skips, depth does not", async () => {
    const tree = (await Bun.file(
      new URL("../data/agent-tree.json", import.meta.url),
    ).json()) as RawHierarchyTree;
    const nodes = tree.nodes ?? {};
    const deltas = new Map<string, number>();
    for (const node of Object.values(nodes)) {
      const parent = node.p;
      if (parent === null || parent === undefined || !(parent in nodes))
        continue;
      const a = nodes[parent]?.l;
      const b = node.l;
      const key = a == null || b == null ? "null" : String(b - a);
      deltas.set(key, (deltas.get(key) ?? 0) + 1);
    }
    expect(Object.fromEntries(deltas)).toEqual({
      "1": 1951,
      "2": 208,
      "0": 110,
      null: 3,
    });

    const atCap = Object.entries(nodes).filter(([, node]) => node.l === 12);
    expect(atCap).toHaveLength(176);
    expect(Object.values(nodes).some((node) => (node.l ?? 0) > 12)).toBe(false);
  });

  /**
   * The field drifts in two directions, and the arithmetic says which one wins per chain:
   * `level − (depth + 1) = (#+2 edges) − (#0-at-12 edges)`. A capture skip pushes the level ahead,
   * saturation pushes the depth ahead — so the 1,753 / 62 / 460 split is one phenomenon, not three.
   */
  test("the level-versus-depth identity holds, except under the collision node", async () => {
    const tree = (await Bun.file(
      new URL("../data/agent-tree.json", import.meta.url),
    ).json()) as RawHierarchyTree;
    const view = buildHierarchy(tree);
    const nodes = tree.nodes ?? {};
    const level = new Map<string, number | null>();
    const depth = new Map<string, number>();
    const walk = (node: HierarchyNode, d: number) => {
      level.set(node.id, node.level);
      depth.set(node.id, d);
      for (const child of node.children) walk(child, d + 1);
    };
    for (const root of view.roots) walk(root, 0);

    const breaks: string[] = [];
    for (const id of Object.keys(nodes)) {
      const l = level.get(id) ?? null;
      if (l === null) continue;
      let plus2 = 0;
      let zero = 0;
      let current = id;
      const seen = new Set<string>();
      while (!seen.has(current)) {
        seen.add(current);
        const parent = nodes[current]?.p;
        if (parent === undefined || parent === null || !(parent in nodes))
          break;
        const a = nodes[parent]?.l;
        const b = nodes[current]?.l;
        if (a != null && b != null) {
          if (b - a === 2) plus2 += 1;
          if (b - a === 0) zero += 1;
        }
        current = parent;
      }
      if (l - ((depth.get(id) ?? 0) + 1) !== plus2 - zero) breaks.push(id);
    }
    expect(breaks.sort()).toEqual(["C-BRANDON", "GRISBY"]);
  });
});
