import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  isFixtureAgentTreeGraphSource,
  readAgentTreeFile,
} from "../lib/agent_tree.ts";
import { deriveDeskKpis, type DeskKpiInputs } from "../lib/desk_kpis.ts";

const AGENT_TREE_PATH = resolve(import.meta.dir, "../data/agent-tree.json");
const NOW = new Date("2026-11-08T03:16:00.000Z");

const none: DeskKpiInputs = {
  agentTree: null,
  liveBets: null,
  liveWagers: null,
  customerBook: null,
};

describe("data/agent-tree.json contract", () => {
  test("stamps source and schema", async () => {
    const file = Bun.file(AGENT_TREE_PATH);
    if (!(await file.exists())) return;
    const tree = readAgentTreeFile(await file.json());
    expect(tree).not.toBeNull();
    expect(tree?.schemaVersion).toBe(1);
    expect(tree?.source.length).toBeGreaterThan(0);
    const count =
      tree?.agentCount ?? Object.keys(tree?.nodes ?? {}).length ?? 0;
    expect(count).toBeGreaterThan(0);
  });

  test("scratch-sourced trees are not labelled as live captures in KPIs", async () => {
    const file = Bun.file(AGENT_TREE_PATH);
    if (!(await file.exists())) return;
    const tree = readAgentTreeFile(await file.json());
    expect(tree).not.toBeNull();
    if (tree === null) return;

    if (!isFixtureAgentTreeGraphSource(tree.source)) return;

    const kpis = deriveDeskKpis(
      {
        ...none,
        agentTree: {
          value: { source: tree.source, nodes: tree.nodes },
          mtime: new Date(NOW.getTime() - 106 * 3600 * 1000),
        },
      },
      NOW,
    );

    expect(kpis.agents?.provenance.basis).toBe("fixture");
    expect(kpis.agents?.provenance.source).toBe(tree.source);
    expect(kpis.agents?.provenance.stale).toBe(false);
  });
});
