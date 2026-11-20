#!/usr/bin/env bun
/**
 * @file build_agent_tree.ts
 * @description Builds `data/agent-tree.json` (parent pointers + level) from the agent graph.
 *
 * Offline (`--graph`) reduces a cytoscape graph already on disk. That path stamps `source`
 * with the graph path, and a `scratch/` path stays a fixture.
 *
 * Live (`--live`) fetches the portal downline through the replay transport and stamps
 * `source: live:f402-list-agents-by-agent` plus `capturedAt`. It does not read
 * `scratch/agent-graph.json`, and it does not write the tree when the account fixture
 * or the manager session is missing.
 *
 * Usage:
 *   bun run build:agent-tree -- --live
 *   bun run build:agent-tree -- --graph scratch/agent-graph.json
 *   bun run build:agent-tree -- --graph scratch/agent-graph.json --hierarchy scratch/raw-f402-list-agents.json
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readHierarchyRows } from "../lib/live_bets.ts";
import {
  agentIndexDocument,
  buildAgentTreeFileFromGraph,
} from "../lib/agent_tree_build.ts";
import type { AgentTreeFile } from "../lib/agent_tree.ts";
import {
  fetchLiveAgentTree,
  missingLiveAccountMessage,
  resolveLiveAccountPath,
} from "../lib/agent_tree_live.ts";

interface Args {
  live: boolean;
  account: string | null;
  graph: string;
  graphExplicit: boolean;
  hierarchy: string | null;
  out: string;
  /** Identity + level index derived from the same hierarchy rows; empty string disables. */
  indexOut: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    live: false,
    account: null,
    graph: "scratch/agent-graph.json",
    graphExplicit: false,
    hierarchy: null,
    out: "data/agent-tree.json",
    indexOut: "data/agent-index.json",
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--live":
        args.live = true;
        break;
      case "--account":
        if (value === undefined) throw new Error("--account needs a path");
        args.account = value;
        i++;
        break;
      case "--graph":
        if (value === undefined) throw new Error("--graph needs a path");
        args.graph = value;
        args.graphExplicit = true;
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
            "  --live              fetch the portal downline (needs --account or F402_GRAPH_ACCOUNT,",
            "                      and a manager session). Does not read scratch/agent-graph.json",
            "  --account <path>    getAccountInfoOwner JSON (or set F402_GRAPH_ACCOUNT)",
            "  --graph <path>      cytoscape agent graph (default scratch/agent-graph.json)",
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

async function writeOutputs(
  args: Args,
  file: AgentTreeFile,
  hierarchy: unknown,
  indexSource: string | null,
): Promise<void> {
  const outPath = resolve(process.cwd(), args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, `${JSON.stringify(file)}\n`);
  console.log(
    `[build:agent-tree] wrote ${args.out}: ${file.agentCount} agents, ${file.roots.length} root(s)` +
      (file.capturedAt !== undefined ? `, capturedAt ${file.capturedAt}` : "") +
      `, source ${file.source}`,
  );
  console.log(`[build:agent-tree] roots: ${file.roots.join(", ")}`);
  const { summarizeTree } = await import("../lib/agent_tree.ts");
  const summary = summarizeTree(file);
  console.log(
    `[build:agent-tree] depth ${summary.depth}, ${summary.leaves} leaf agent(s)`,
  );

  if (args.indexOut === "") return;
  const index = agentIndexDocument(hierarchy, file.collisions, indexSource);
  const indexPath = resolve(process.cwd(), args.indexOut);
  mkdirSync(dirname(indexPath), { recursive: true });
  await Bun.write(indexPath, `${JSON.stringify(index)}\n`);
  console.log(
    `[build:agent-tree] index -> ${args.indexOut}: ${index.agentCount} agent(s)`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.live) {
    if (args.graphExplicit) {
      throw new Error(
        "--live does not read --graph. Refusing to mix a local graph with a portal fetch.",
      );
    }
    const accountPath = resolveLiveAccountPath(args.account);
    if (accountPath === "") throw new Error(missingLiveAccountMessage());
    const { file, hierarchy } = await fetchLiveAgentTree(accountPath);
    await writeOutputs(args, file, hierarchy, file.source);
    return;
  }

  const graphFile = Bun.file(resolve(process.cwd(), args.graph));
  if (!(await graphFile.exists())) {
    throw new Error(`agent graph not found: ${args.graph}`);
  }
  const hierarchy =
    args.hierarchy === null
      ? []
      : await Bun.file(resolve(process.cwd(), args.hierarchy)).json();
  if (args.hierarchy !== null) {
    console.log(
      `[build:agent-tree] hierarchy: ${readHierarchyRows(hierarchy).length} row(s)`,
    );
  }
  const file = buildAgentTreeFileFromGraph({
    graph: await graphFile.json(),
    hierarchy,
    source: args.graph,
  });
  const collisions = file.collisions ?? [];
  if (collisions.length > 0) {
    console.log(
      `[build:agent-tree] ${collisions.length} ambiguous key(s): ${collisions.map((c) => c.key).join(", ")}`,
    );
  }
  await writeOutputs(args, file, hierarchy, args.hierarchy);
}

try {
  await main();
} catch (err) {
  console.error(
    `build:agent-tree: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
