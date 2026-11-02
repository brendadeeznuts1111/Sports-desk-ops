import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Checks `data/agent-tree.json` against the tree the portal actually renders.
 *
 * The sidebar shows one root — the logged-in account — with four children at level 1. The committed
 * tree has four roots and no BILLY666. Both are correct: `listAgenstByAgent` returns a downline, so
 * the master node comes from the page's session, not from the response. This file exists so that
 * distinction stays explicit instead of looking like a lost node.
 */
const sidebar = readFileSync(
  resolve(
    import.meta.dir,
    "fixtures/portal-agent-tree-sidebar-2026-11-01.html",
  ),
  "utf8",
);

const tree = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../data/agent-tree.json"), "utf8"),
) as {
  agentCount: number;
  roots: string[];
  nodes: Record<
    string,
    { l: number | null; p: string | null; t: string | null }
  >;
};

/** Every `<li>` carrying a `data-header-agent`: one rendered tree row. */
const rows = [...sidebar.matchAll(/<li([^>]*)>/g)]
  .map((match) => match[1] ?? "")
  .filter((attrs) => attrs.includes("data-header-agent"))
  .map((attrs) => ({
    agent: /data-header-agent="([^"]+)"/.exec(attrs)?.[1] ?? "",
    level: /data-level="([^"]+)"/.exec(attrs)?.[1] ?? "",
    type: /data-type-a="([^"]+)"/.exec(attrs)?.[1] ?? "",
    header: /data-master-m="([^"]+)"/.exec(attrs)?.[1] ?? "",
  }));

describe("the agent tree sidebar", () => {
  test("renders four children at level 1, all under the master key", () => {
    expect(rows.map((row) => row.agent)).toEqual([
      "BILLY667",
      "NOLAWOLF",
      "RTEST5",
      "SAINTS2009",
    ]);
    expect(rows.every((row) => row.level === "1")).toBe(true);
    expect(rows.every((row) => row.header === "BILLY666")).toBe(true);
  });

  test("each row carries an agent type, and both values appear", () => {
    expect(rows.map((row) => row.type)).toEqual(["A", "M", "A", "M"]);
  });

  test("children are lazy: their containers ship empty and hidden", () => {
    // A collapsed node's ul is empty, so the tree does not serialise the whole hierarchy.
    const hideCount = (sidebar.match(/class="master-ul hide"/g) ?? []).length;
    expect(hideCount).toBe(4);
    expect(sidebar).toContain('<ul class="master-ul hide"></ul>');
  });

  test("the tree is agents-only", () => {
    // data-players="false" means this sidebar does not render player rows; they load per agent.
    expect(sidebar).toContain('data-players="false"');
    expect(sidebar).toContain('data-action="parent-check"');
    expect(sidebar).toContain('data-action="go-agent"');
  });
});

describe("the committed tree against that sidebar", () => {
  test("its roots are exactly the sidebar's four children", () => {
    expect([...tree.roots].sort()).toEqual(rows.map((row) => row.agent).sort());
  });

  test("the logged-in master is absent, on purpose", () => {
    // BILLY666 is the page's own account. It is on every report call as agentID and agentOwner, but
    // it is not a row of listAgenstByAgent, so it cannot be a node of this artifact.
    expect(sidebar).toContain('data-ag="BILLY666"');
    expect(Object.keys(tree.nodes)).not.toContain("BILLY666");
    expect(tree.roots).not.toContain("BILLY666");
  });

  test("each root has no parent in the capture and sits at level 1", () => {
    // That is what "root" means here: the top of the downline that was returned, not the top of the
    // hierarchy. The portal numbers direct children 1, so the master is implicitly level 0.
    for (const root of tree.roots) {
      const node = tree.nodes[root];
      expect(node).toBeDefined();
      expect(node?.p).toBeNull();
      expect(node?.l).toBe(1);
    }
  });

  test("the node types agree with the rendered ones", () => {
    for (const row of rows) {
      expect(tree.nodes[row.agent]?.t).toBe(row.type);
    }
  });
});
