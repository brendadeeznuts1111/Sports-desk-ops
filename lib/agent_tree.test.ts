import { describe, expect, test } from "bun:test";
import {
  buildAgentTree,
  readAgentTreeFile,
  searchTree,
  subtreeKeys,
  summarizeTree,
  withAgentTypes,
  type AgentTreeFile,
} from "./agent_tree.ts";

/** Shape mirrors a real slice of `data/agent-tree.json` (BILLY666's four children). */
const file: AgentTreeFile = {
  schemaVersion: 1,
  source: "Scratch/agent-graph.json",
  agentCount: 6,
  roots: ["BILLY667", "NOLAWOLF"],
  nodes: {
    BILLY667: { l: 1, p: null, t: "A" },
    NOLAWOLF: { l: 1, p: null, t: "M" },
    BOTMASTER: { l: 2, p: "NOLAWOLF", t: "A" },
    RO337: { l: 3, p: "BOTMASTER", t: "A" },
    HRGROUP: { l: 6, p: "NOLAWOLF", t: "A" },
    DEEP: { l: 12, p: "RO337", t: "A" },
  },
};

describe("buildAgentTree", () => {
  test("links children to parents without inventing any", () => {
    const { tree, problems } = buildAgentTree(file);
    expect(problems).toEqual({ cycles: [], missingParents: [] });
    expect(tree.roots.map(String)).toEqual(["BILLY667", "NOLAWOLF"]);
    expect(tree.nodes.get("NOLAWOLF" as never)?.children.map(String)).toEqual([
      "BOTMASTER",
      "HRGROUP",
    ]);
    expect(tree.nodes.get("BILLY667" as never)?.children).toEqual([]);
  });

  test("keeps level separate from nesting depth", () => {
    // The portal's Level is a tier; a level-12 agent can sit five edges down.
    const { tree } = buildAgentTree(file);
    const deep = tree.nodes.get("DEEP" as never);
    expect(deep?.level).toBe(12);
    expect(deep?.parent).toBe("RO337" as never);
  });

  test("normalizes keys exactly like the hierarchy index", () => {
    const { tree } = buildAgentTree({
      ...file,
      nodes: { " billy667 ": { l: 1, p: null, t: "A" } },
      roots: [" billy667 "],
    });
    expect([...tree.nodes.keys()].map(String)).toEqual(["BILLY667"]);
  });

  test("reports a parent that is not a node instead of inventing one", () => {
    const { problems } = buildAgentTree({
      ...file,
      nodes: { LOST: { l: 4, p: "GHOSTPARENT", t: "A" } },
      roots: [],
    });
    expect(problems.missingParents.map(String)).toEqual(["GHOSTPARENT"]);
  });

  test("detects a cycle rather than recursing forever", () => {
    const { problems } = buildAgentTree({
      ...file,
      nodes: {
        A: { l: 1, p: "B", t: "A" },
        B: { l: 2, p: "A", t: "A" },
      },
      roots: [],
    });
    expect(problems.cycles.length).toBe(1);
    expect(problems.cycles[0]?.map(String).sort()).toEqual(["A", "B"]);
  });
});

describe("readAgentTreeFile", () => {
  test("accepts the committed shape", () => {
    expect(readAgentTreeFile(file)?.agentCount).toBe(6);
  });

  test("rejects foreign payloads", () => {
    expect(readAgentTreeFile(null)).toBeNull();
    expect(readAgentTreeFile({ nodes: {} })).toBeNull();
    expect(readAgentTreeFile({ schemaVersion: 2, nodes: {} })).toBeNull();
  });
});

describe("tree queries", () => {
  const { tree } = buildAgentTree(file);

  test("summarizeTree counts leaves and structural depth", () => {
    const summary = summarizeTree(tree);
    expect(summary.agents).toBe(6);
    expect(summary.roots).toBe(2);
    expect(summary.leaves).toBe(3);
    expect(summary.depth).toBe(4);
  });

  test("subtreeKeys includes every descendant and nothing else", () => {
    const scope = subtreeKeys(tree, "NOLAWOLF" as never);
    expect([...scope].map(String).sort()).toEqual([
      "BOTMASTER",
      "DEEP",
      "HRGROUP",
      "NOLAWOLF",
      "RO337",
    ]);
  });

  test("searchTree keeps ancestors of a match visible", () => {
    const visible = [...searchTree(tree, "deep")].map(String).sort();
    expect(visible).toEqual(["BOTMASTER", "DEEP", "NOLAWOLF", "RO337"]);
  });

  test("empty search reveals everything", () => {
    expect(searchTree(tree, "   ").size).toBe(6);
  });

  test("no match reveals nothing", () => {
    expect(searchTree(tree, "ZZZZ").size).toBe(0);
  });
});

describe("withAgentTypes", () => {
  test("fills AgentType from hierarchy rows without overwriting known values", () => {
    const patched = withAgentTypes(
      {
        ...file,
        nodes: {
          HRGROUP: { l: 6, p: null, t: null },
          BILLY667: { l: 1, p: null, t: "M" },
        },
      },
      [
        { AgentID: "HRGROUP ", Login: "HRGROUP", Level: 6, AgentType: "A" },
        { AgentID: "BILLY667", Login: "BILLY667", Level: 1, AgentType: "A" },
      ],
    );
    expect(patched.nodes.HRGROUP?.t).toBe("A");
    expect(patched.nodes.BILLY667?.t).toBe("M");
  });
});
