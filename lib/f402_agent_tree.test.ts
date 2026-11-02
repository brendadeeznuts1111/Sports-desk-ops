import { describe, expect, test } from "bun:test";

import {
  AgentTreeOrderError,
  agentTreeStats,
  ancestorsOf,
  buildAgentTreeFromGeneral,
  parentDivergence,
} from "./f402_agent_tree.ts";

const row = (AgentID: string, Level: number) => ({
  AgentID,
  Login: AgentID,
  Level,
});

describe("buildAgentTreeFromGeneral", () => {
  test("parent is the nearest preceding row one level up (pre-order)", () => {
    const tree = buildAgentTreeFromGeneral([
      row("R", 1),
      row("A", 2),
      row("A1", 3),
      row("A2", 3),
      row("B", 2),
      row("B1", 3),
      row("S", 1),
    ]);
    expect(tree.nodes.get("A2")?.parentId).toBe("A");
    expect(tree.nodes.get("B1")?.parentId).toBe("B");
    expect(tree.roots).toEqual(["R", "S"]);
    expect(tree.nodes.get("R")?.descendantCount).toBe(5);
    expect(tree.nodes.get("B1")?.branchId).toBe("B");
    expect(ancestorsOf(tree, "B1").map((n) => n.id)).toEqual(["R", "B"]);
  });

  test("levels above max are overflow owned by the deepest in-graph ancestor", () => {
    const tree = buildAgentTreeFromGeneral(
      [
        row("R", 1),
        row("A", 2),
        row("X", 3),
        row("Y", 4),
        row("Z", 3),
        row("B", 2),
      ],
      2,
    );
    expect(tree.nodes.size).toBe(3);
    expect(tree.overflowTotal).toBe(3);
    expect(tree.overflowByLevel).toEqual({ 3: 2, 4: 1 });
    expect(tree.nodes.get("A")?.overflowCount).toBe(3);
    expect(tree.nodes.get("B")?.overflowCount).toBe(0);
  });

  test("rejects level jumps and duplicate ids", () => {
    expect(() => buildAgentTreeFromGeneral([row("R", 1), row("X", 3)])).toThrow(
      AgentTreeOrderError,
    );
    expect(() => buildAgentTreeFromGeneral([row("R", 1), row("R", 1)])).toThrow(
      AgentTreeOrderError,
    );
  });

  test("parentDivergence reports portal parents that disagree with nesting", () => {
    const tree = buildAgentTreeFromGeneral([
      row("R", 1),
      row("A", 2),
      row("B", 3),
      row("C", 3),
    ]);
    const portal = new Map<string, string | null>([
      ["R", null],
      ["A", "R"],
      ["B", "A"],
      ["C", "B"],
    ]);
    expect(parentDivergence(tree, portal)).toEqual([
      { agentId: "C", level: 3, structuralParent: "A", portalParent: "B" },
    ]);
  });

  test("stats: fanout, cumulative levels, overflow owners", () => {
    const tree = buildAgentTreeFromGeneral(
      [row("R", 1), row("A", 2), row("A1", 3), row("A2", 3), row("B", 2)],
      2,
    );
    const s = agentTreeStats(tree);
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(2);
    expect(s.cumulativeByLevel).toEqual({ 1: 1, 2: 3 });
    expect(s.overflowOwners).toEqual([{ id: "A", rootId: "R", overflow: 2 }]);
    expect(s.roots).toEqual([{ id: "R", size: 3 }]);
  });
});
