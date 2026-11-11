#!/usr/bin/env bun
/**
 * Agent Tree CLI & Deep Inspector
 *
 * Queries, ensures, and visualizes the portal agent forest (`data/agent-tree.json`)
 * with declarative pattern matching (`--match`), subtree scopes (`--under`),
 * ASCII trees (`--tree`), Mermaid diagrams (`--mermaid`), JSON (`--json`),
 * and architectural integrity assertions (`--ensure`).
 *
 * Usage:
 *   bun scripts/agent-tree.ts [options]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentKeyOf, type AgentKey } from "../lib/live_bets.ts";
import {
  type AgentTree,
  buildAgentTree,
  readAgentTreeFile,
} from "../lib/agent_tree.ts";
import {
  type AgentNodePattern,
  type AgentTreeEnsureOptions,
  type AgentTreeMatchQuery,
  ensureAgentTree,
  matchAgentTree,
} from "../lib/agent_tree_matcher.ts";

export interface CliOptions {
  file: string;
  query: string | null;
  underRoot: AgentKey | null;
  matchLevel: number | null;
  matchType: string | null;
  leavesOnly: boolean;
  rootsOnly: boolean;
  tree: boolean;
  mermaid: boolean;
  json: boolean;
  ensure: boolean;
  minAgents: number | null;
  maxCycles: number | null;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    file: "data/agent-tree.json",
    query: null,
    underRoot: null,
    matchLevel: null,
    matchType: null,
    leavesOnly: false,
    rootsOnly: false,
    tree: false,
    mermaid: false,
    json: false,
    ensure: false,
    minAgents: null,
    maxCycles: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--file") {
      const next = args[++i];
      if (next) options.file = next;
    } else if (arg.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
    } else if (arg === "--under") {
      const next = args[++i];
      if (next) options.underRoot = agentKeyOf({ AgentID: next });
    } else if (arg.startsWith("--under=")) {
      options.underRoot = agentKeyOf({ AgentID: arg.slice("--under=".length) });
    } else if (arg === "--level") {
      const next = args[++i];
      if (next) options.matchLevel = parseInt(next, 10);
    } else if (arg.startsWith("--level=")) {
      options.matchLevel = parseInt(arg.slice("--level=".length), 10);
    } else if (arg === "--type") {
      const next = args[++i];
      if (next) options.matchType = next.toUpperCase();
    } else if (arg.startsWith("--type=")) {
      options.matchType = arg.slice("--type=".length).toUpperCase();
    } else if (arg === "--leaves") {
      options.leavesOnly = true;
    } else if (arg === "--roots") {
      options.rootsOnly = true;
    } else if (arg === "--tree") {
      options.tree = true;
    } else if (arg === "--mermaid") {
      options.mermaid = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--ensure") {
      options.ensure = true;
    } else if (arg === "--min-agents") {
      const next = args[++i];
      if (next) options.minAgents = parseInt(next, 10);
    } else if (arg.startsWith("--min-agents=")) {
      options.minAgents = parseInt(arg.slice("--min-agents=".length), 10);
    } else if (arg === "--max-cycles") {
      const next = args[++i];
      if (next) options.maxCycles = parseInt(next, 10);
    } else if (arg.startsWith("--max-cycles=")) {
      options.maxCycles = parseInt(arg.slice("--max-cycles=".length), 10);
    } else if (!arg.startsWith("-") && !options.query) {
      options.query = arg;
    }
  }

  return options;
}

export function formatAgentTreeAscii(
  tree: AgentTree,
  rootKeys: readonly AgentKey[],
  maxDepth: number = 4,
): string {
  const lines: string[] = [];

  function printBranch(
    key: AgentKey,
    prefix: string,
    isTail: boolean,
    depth: number,
  ) {
    if (depth > maxDepth) return;
    const node = tree.nodes.get(key);
    const marker = isTail ? "└── " : "├── ";
    const typeLabel = node?.agentType ? ` [${node.agentType}]` : "";
    const levelLabel = node ? ` (L${node.level})` : "";
    lines.push(`${prefix}${marker}${key}${typeLabel}${levelLabel}`);

    if (!node || depth === maxDepth) return;

    const childPrefix = prefix + (isTail ? "    " : "│   ");
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const childTail = i === children.length - 1;
      printBranch(child, childPrefix, childTail, depth + 1);
    }
  }

  for (let i = 0; i < rootKeys.length; i++) {
    const root = rootKeys[i];
    if (!root) continue;
    const isTail = i === rootKeys.length - 1;
    printBranch(root, "", isTail, 0);
  }

  return lines.join("\n");
}

export function formatAgentTreeMermaid(
  tree: AgentTree,
  nodes: readonly AgentKey[],
): string {
  const lines: string[] = ["graph TD"];
  const nodeSet = new Set(nodes);

  for (const key of nodes) {
    const node = tree.nodes.get(key);
    if (!node) continue;
    const typeLabel = node.agentType ? ` [${node.agentType}]` : "";
    lines.push(`  N_${key}["${key}${typeLabel} (L${node.level})"]`);
    if (node.parent && nodeSet.has(node.parent)) {
      lines.push(`  N_${node.parent} --> N_${key}`);
    }
  }

  return lines.join("\n");
}

if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));
  const absPath = resolve(options.file);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read agent tree file "${options.file}": ${msg}`);
    process.exit(1);
  }

  const parsedFile = readAgentTreeFile(raw);
  if (!parsedFile) {
    console.error(`Invalid AgentTreeFile format in "${options.file}"`);
    process.exit(1);
  }

  const { tree, problems } = buildAgentTree(parsedFile);

  if (options.ensure) {
    const ensureOpts: AgentTreeEnsureOptions = {
      maxCycles: options.maxCycles ?? 0,
      disallowMissingParents: true,
      minAgents: options.minAgents ?? 100,
    };
    const result = ensureAgentTree(tree, problems, ensureOpts);
    if (!result.valid) {
      console.error("Agent tree integrity check FAILED:");
      for (const v of result.violations) {
        console.error(`  ✕ ${v}`);
      }
      process.exit(1);
    }
    console.log("✓ Agent tree integrity check passed:");
    console.log(`  Agents: ${result.summary.agents}`);
    console.log(`  Roots: ${result.summary.roots}`);
    console.log(`  Leaves: ${result.summary.leaves}`);
    console.log(`  Depth: ${result.summary.depth}`);
    process.exit(0);
  }

  const pattern: AgentNodePattern | undefined =
    options.matchLevel !== null || options.matchType !== null
      ? {
          level: options.matchLevel ?? undefined,
          agentType: options.matchType ?? undefined,
        }
      : undefined;

  const query: AgentTreeMatchQuery = {
    query: options.query ?? undefined,
    underRoot: options.underRoot ?? undefined,
    leavesOnly: options.leavesOnly ? true : undefined,
    rootsOnly: options.rootsOnly ? true : undefined,
    pattern,
  };

  const matchedNodes = matchAgentTree(tree, query);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          totalMatched: matchedNodes.length,
          query,
          nodes: matchedNodes,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (options.mermaid) {
    const keys = matchedNodes.slice(0, 100).map((n) => n.key);
    console.log(formatAgentTreeMermaid(tree, keys));
    process.exit(0);
  }

  if (options.tree) {
    const roots = options.underRoot ? [options.underRoot] : tree.roots;
    console.log(formatAgentTreeAscii(tree, roots));
    process.exit(0);
  }

  console.log(`Agent Tree: ${options.file}`);
  console.log(`  Total Nodes: ${tree.nodes.size}`);
  console.log(`  Roots (${tree.roots.length}): ${tree.roots.join(", ")}`);
  console.log(`  Matched Nodes: ${matchedNodes.length}`);
  if (matchedNodes.length > 0 && matchedNodes.length <= 25) {
    for (const m of matchedNodes) {
      console.log(
        `    ${String(m.key).padEnd(16)} (L${m.level}, type: ${m.agentType ?? "none"}, parent: ${m.parent ?? "ROOT"})`,
      );
    }
  } else if (matchedNodes.length > 25) {
    for (const m of matchedNodes.slice(0, 15)) {
      console.log(
        `    ${String(m.key).padEnd(16)} (L${m.level}, type: ${m.agentType ?? "none"}, parent: ${m.parent ?? "ROOT"})`,
      );
    }
    console.log(`    ... and ${matchedNodes.length - 15} more.`);
  }
}
