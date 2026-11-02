#!/usr/bin/env bun
/**
 * @file build_agent_tree.ts
 * @description Builds `data/agent-tree.json` (parent pointers + level) from the agent graph.
 *
 * The portal's "Agent Tree" sidebar renders `baseHeriarchy`; this repository already has the
 * same forest in `Scratch/agent-graph.json` (nodes + `parent->child` edges). This script reduces
 * it to the minimum the scoreboard needs, keyed by the canonical `agentLoginKey` so lookups
 * against wagers can never miss by case.
 *
 * Output shape (compact on purpose — 2.2k agents):
 *   { schemaVersion: 1, roots: [key...], nodes: { key: { l: level, p: parent, t: agentType } } }
 *
 * PII: agent ids only. No logins-with-passwords, no rates, no customers.
 *
 * Usage:
 *   bun run build:agent-tree --graph Scratch/agent-graph.json
 *   bun run build:agent-tree --graph Scratch/agent-graph.json --hierarchy Scratch/raw-f402-list-agents.json
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { agentKeyOf, readHierarchyRows } from "../lib/live_bets.ts";
import {
  type AgentTreeFile,
  type AgentTreeWireNode,
} from "../lib/agent_tree.ts";

interface Args {
  graph: string;
  hierarchy: string | null;
  out: string;
  /** Identity + level index derived from the same hierarchy rows; empty string disables. */
  indexOut: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    graph: "Scratch/agent-graph.json",
    hierarchy: null,
    out: "data/agent-tree.json",
    indexOut: "data/agent-index.json",
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--graph":
        if (value === undefined) throw new Error("--graph needs a path");
        args.graph = value;
        i++;
        break;
      case "--hierarchy":
        if (value === undefined) throw new Error("--hierarchy needs a path");
        args.hierarchy = value;
        i++;
        break;
      case "--out":
        if (value === undefined) throw new Error("--out needs a path");
        args.out = value;
        i++;
        break;
      case "--index-out":
        if (value === undefined) throw new Error("--index-out needs a path");
        args.indexOut = value;
        i++;
        break;
      case "--no-index":
        args.indexOut = "";
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: bun run build:agent-tree [flags]",
            "",
            "  --graph <path>      cytoscape agent graph (default Scratch/agent-graph.json)",
            "  --hierarchy <path>  list-agents envelope, adds AgentType",
            "  --out <path>        output (default data/agent-tree.json)",
            "  --index-out <path>  identity index (default data/agent-index.json)",
            "  --no-index          skip the identity index",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${String(flag)}`);
    }
  }
  return args;
}

interface CytoscapeGraph {
  readonly nodes?: ReadonlyArray<{ data?: { id?: unknown; level?: unknown } }>;
  readonly edges?: ReadonlyArray<{
    data?: { source?: unknown; target?: unknown };
  }>;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  const graphFile = Bun.file(resolve(process.cwd(), args.graph));
  if (!(await graphFile.exists())) {
    throw new Error(`agent graph not found: ${args.graph}`);
  }
  const graph = (await graphFile.json()) as CytoscapeGraph;

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0) throw new Error("agent graph has no nodes");

  // The graph keys nodes by AgentID; the scoreboard keys agents by agentLoginKey (Login first).
  // Both must agree or a wager resolves to a key the tree does not contain.
  const rows =
    args.hierarchy === null
      ? []
      : readHierarchyRows(
          await Bun.file(resolve(process.cwd(), args.hierarchy)).json(),
        );

  const keyByAgentId = new Map<string, string>();
  const types = new Map<string, string | null>();
  const idsByKey = new Map<string, Set<string>>();
  for (const row of rows) {
    const agentId = String(row.AgentID ?? "").trim();
    const key = agentKeyOf(row);
    if (agentId === "" || key === "") continue;
    keyByAgentId.set(agentId, key);
    types.set(key, (row.AgentType as string | undefined) ?? null);
    const ids = idsByKey.get(key) ?? new Set<string>();
    ids.add(agentId);
    idsByKey.set(key, ids);
  }
  if (args.hierarchy !== null) {
    console.log(`[build:agent-tree] hierarchy: ${rows.length} row(s)`);
  }

  // A canonical key owned by two AgentIDs cannot be levelled truthfully: omit it and report.
  const collisions = [...idsByKey]
    .filter(([, ids]) => ids.size > 1)
    .map(([key, ids]) => ({ key, agentIds: [...ids].sort() }));
  const ambiguous = new Set(collisions.map((c) => c.key));

  // Ambiguous keys stay in the tree so their children keep a parent; they are flagged and
  // never given a level, because two agents own the key and picking one would be a guess.
  const canonical = (agentId: string): string | null => {
    const key = keyByAgentId.get(agentId) ?? agentKeyOf({ AgentID: agentId });
    return key === "" ? null : key;
  };

  const levels = new Map<string, number | null>();
  for (const node of nodes) {
    const id = String(node.data?.id ?? "").trim();
    if (id === "") continue;
    const key = canonical(id);
    if (key === null) continue;
    const level = Number(node.data?.level);
    levels.set(key, Number.isFinite(level) ? level : null);
  }

  const parentOf = new Map<string, string>();
  let orphans = 0;
  let selfLoops = 0;
  for (const edge of edges) {
    const source = String(edge.data?.source ?? "").trim();
    const target = String(edge.data?.target ?? "").trim();
    if (source === "" || target === "") continue;

    const parent = canonical(source);
    const child = canonical(target);
    if (parent === null || child === null) {
      orphans += 1;
      continue;
    }
    if (parent === child) {
      // Canonicalising AgentID -> Login can collapse a parent/child pair into one agent.
      selfLoops += 1;
      continue;
    }
    // The portal tree is single-parent; a second parent would be a data surprise, not a rule.
    if (parentOf.has(child)) {
      orphans += 1;
      continue;
    }
    parentOf.set(child, parent);
    if (!levels.has(parent)) levels.set(parent, null);
    if (!levels.has(child)) levels.set(child, null);
  }

  const keys = [...levels.keys()].sort();
  const outNodes: Record<string, AgentTreeWireNode> = {};
  const roots: string[] = [];
  for (const key of keys) {
    const parent = parentOf.get(key) ?? null;
    if (parent === null) roots.push(key);
    const isAmbiguous = ambiguous.has(key);
    outNodes[key] = {
      l: isAmbiguous ? null : (levels.get(key) ?? null),
      p: parent,
      t: isAmbiguous ? null : (types.get(key) ?? null),
      ...(isAmbiguous ? { a: true as const } : {}),
    };
  }

  const file: AgentTreeFile = {
    schemaVersion: 1,
    source: args.graph,
    agentCount: keys.length,
    roots,
    collisions,
    nodes: outNodes,
  };

  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, `${JSON.stringify(file)}\n`);

  console.log(
    `[build:agent-tree] wrote ${args.out}: ${keys.length} agents, ${roots.length} root(s)` +
      (orphans > 0 ? `, ${orphans} edge(s) dropped` : "") +
      (selfLoops > 0 ? `, ${selfLoops} self-loop(s)` : "") +
      (collisions.length > 0
        ? `, ${collisions.length} ambiguous key(s): ${collisions.map((c) => c.key).join(", ")}`
        : ""),
  );
  console.log(`[build:agent-tree] roots: ${roots.join(", ")}`);
  const { summarizeTree } = await import("../lib/agent_tree.ts");
  const summary = summarizeTree(file);
  console.log(
    `[build:agent-tree] depth ${summary.depth}, ${summary.leaves} leaf agent(s)`,
  );

  if (args.indexOut !== "") {
    const agents: Record<
      string,
      {
        i: string | string[];
        l: number | null;
        t: string | null;
        s: number | null;
      }
    > = {};
    for (const row of rows) {
      const key = agentKeyOf(row);
      if (key === "") continue;
      const id = String(row.AgentID ?? "").trim();
      const s = Number(row.SeqNumber);
      agents[key] = {
        i: id,
        l: Number.isFinite(Number(row.Level)) ? Number(row.Level) : null,
        t: (row.AgentType as string | undefined) ?? null,
        s: Number.isFinite(s) ? s : null,
      };
    }
    // Ambiguous keys keep every id and lose the level: two agents cannot share one tier.
    for (const collision of collisions) {
      const entry = agents[collision.key];
      agents[collision.key] = {
        i: collision.agentIds,
        l: null,
        t: null,
        s: entry?.s ?? null,
      };
    }

    const indexPath = resolve(process.cwd(), args.indexOut);
    mkdirSync(dirname(indexPath), { recursive: true });
    await Bun.write(
      indexPath,
      `${JSON.stringify({
        schemaVersion: 1,
        source: args.hierarchy,
        agentCount: Object.keys(agents).length,
        agents,
      })}\n`,
    );
    console.log(
      `[build:agent-tree] index -> ${args.indexOut}: ${Object.keys(agents).length} agent(s)`,
    );
  }
}

try {
  await main();
} catch (err) {
  console.error(
    `build:agent-tree: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
