import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { agentKeyOf } from "../lib/live_bets.ts";
import { buildAgentTree, readAgentTreeFile } from "../lib/agent_tree.ts";
import {
  areAgentTreesEquivalent,
  ensureAgentTree,
  matchAgentNode,
  matchAgentTree,
} from "../lib/agent_tree_matcher.ts";

describe("Agent Tree Matcher & Ensure", () => {
  const raw = JSON.parse(readFileSync("data/agent-tree.json", "utf8"));
  const parsed = readAgentTreeFile(raw)!;
  const { tree, problems } = buildAgentTree(parsed);

  it("matches individual nodes with Bun.deepMatch", () => {
    const key = agentKeyOf({ AgentID: "NOLAWOLF" });
    const node = tree.nodes.get(key);
    expect(node).toBeDefined();
    if (node) {
      expect(matchAgentNode(node, { level: 1 })).toBe(true);
      expect(matchAgentNode(node, { level: 1, agentType: "M" })).toBe(true);
      expect(matchAgentNode(node, { level: 2 })).toBe(false);
    }
  });

  it("filters agents using matchAgentTree query predicates", () => {
    const roots = matchAgentTree(tree, { rootsOnly: true });
    expect(roots.length).toBe(4);
    const nolaKey = agentKeyOf({ AgentID: "NOLAWOLF" });
    expect(roots.map((r) => r.key)).toContain(nolaKey);

    const underNola = matchAgentTree(tree, { underRoot: nolaKey });
    expect(underNola.length).toBeGreaterThan(100);

    const level2 = matchAgentTree(tree, { pattern: { level: 2 } });
    expect(level2.length).toBeGreaterThan(0);
    for (const n of level2) {
      expect(n.level).toBe(2);
    }
  });

  it("passes integrity check with ensureAgentTree", () => {
    const nolaKey = agentKeyOf({ AgentID: "NOLAWOLF" });
    const result = ensureAgentTree(tree, problems, {
      minAgents: 1000,
      maxCycles: 0,
      disallowMissingParents: true,
      expectedRoots: [nolaKey],
    });

    expect(result.valid).toBe(true);
    expect(result.violations.length).toBe(0);
    expect(result.summary.agents).toBeGreaterThan(2000);
  });

  it("catches violations with ensureAgentTree when constraints fail", () => {
    const fakeKey = agentKeyOf({ AgentID: "NON_EXISTENT_ROOT" });
    const result = ensureAgentTree(tree, problems, {
      minAgents: 5000, // exceeds actual 2276
      expectedRoots: [fakeKey],
    });

    expect(result.valid).toBe(false);
    expect(result.violations.length).toBe(2);
  });

  it("compares equivalent trees with areAgentTreesEquivalent using Bun.deepEquals", () => {
    const treeCopy = buildAgentTree(parsed).tree;
    expect(areAgentTreesEquivalent(tree, treeCopy)).toBe(true);
  });
});
