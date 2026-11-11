/**
 * Agent Tree Ensure & Pattern Matching Primitives
 *
 * Provides project-wide declarative query matching, structural invariant assertions,
 * and subtree filtering over the agent hierarchy tree using native Bun primitives
 * (`Bun.deepEquals`).
 */

import { deepEquals } from "bun";
import type { AgentKey } from "./live_bets.ts";
import {
  type AgentNode,
  type AgentTree,
  type AgentTreeProblems,
  type AgentTreeSummary,
  subtreeKeys,
  summarizeTree,
} from "./agent_tree.ts";

export interface AgentNodePattern {
  readonly level?: number | undefined;
  readonly agentType?: string | null | undefined;
  readonly parent?: AgentKey | null | undefined;
  readonly ambiguous?: boolean | undefined;
}

export interface AgentTreeMatchQuery {
  /** Match specific node properties */
  readonly pattern?: AgentNodePattern | undefined;
  /** Filter to nodes residing within a specific subtree root */
  readonly underRoot?: AgentKey | undefined;
  /** Filter to leaf nodes only */
  readonly leavesOnly?: boolean | undefined;
  /** Filter to root nodes only */
  readonly rootsOnly?: boolean | undefined;
  /** Max depth from root */
  readonly maxDepth?: number | undefined;
  /** Search substring across agent key or parent */
  readonly query?: string | undefined;
}

export interface AgentTreeEnsureOptions {
  /** Maximum allowable circular dependency chains (default 0) */
  readonly maxCycles?: number | undefined;
  /** Disallow missing parents */
  readonly disallowMissingParents?: boolean | undefined;
  /** Require at least N total agents */
  readonly minAgents?: number | undefined;
  /** Require specific root keys to exist */
  readonly expectedRoots?: readonly AgentKey[] | undefined;
}

export interface AgentTreeEnsureResult {
  readonly valid: boolean;
  readonly summary: AgentTreeSummary;
  readonly problems: AgentTreeProblems;
  readonly violations: readonly string[];
}

/**
 * Checks whether an AgentNode satisfies a pattern.
 */
export function matchAgentNode(
  node: AgentNode,
  pattern: AgentNodePattern,
): boolean {
  if (pattern.level !== undefined && node.level !== pattern.level) {
    return false;
  }
  if (pattern.agentType !== undefined && node.agentType !== pattern.agentType) {
    return false;
  }
  if (pattern.parent !== undefined && node.parent !== pattern.parent) {
    return false;
  }
  if (pattern.ambiguous !== undefined && node.ambiguous !== pattern.ambiguous) {
    return false;
  }
  return true;
}

/**
 * Searches and filters the entire AgentTree using pattern matching, subtree bounds, and predicates.
 */
export function matchAgentTree(
  tree: AgentTree,
  query: AgentTreeMatchQuery = {},
): AgentNode[] {
  const matches: AgentNode[] = [];
  const allowedKeys = query.underRoot
    ? new Set(subtreeKeys(tree, query.underRoot))
    : null;

  for (const node of tree.nodes.values()) {
    if (allowedKeys && !allowedKeys.has(node.key)) {
      continue;
    }
    if (query.rootsOnly && node.parent !== null) {
      continue;
    }
    if (query.leavesOnly && node.children.length > 0) {
      continue;
    }
    if (query.query) {
      const q = query.query.toUpperCase();
      const matchesKey = String(node.key).includes(q);
      const matchesParent = node.parent
        ? String(node.parent).includes(q)
        : false;
      if (!matchesKey && !matchesParent) continue;
    }
    if (query.pattern && !matchAgentNode(node, query.pattern)) {
      continue;
    }
    matches.push(node);
  }

  return matches.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/**
 * Validates the agent tree against project-wide integrity constraints and returns diagnostic violations.
 */
export function ensureAgentTree(
  tree: AgentTree,
  problems: AgentTreeProblems,
  options: AgentTreeEnsureOptions = {},
): AgentTreeEnsureResult {
  const summary = summarizeTree(tree);
  const violations: string[] = [];

  const maxCycles = options.maxCycles ?? 0;
  if (problems.cycles.length > maxCycles) {
    violations.push(
      `Detected ${problems.cycles.length} circular references in agent tree (max allowed: ${maxCycles})`,
    );
  }

  if (options.disallowMissingParents && problems.missingParents.length > 0) {
    violations.push(
      `Detected ${problems.missingParents.length} nodes referencing non-existent parents: ${problems.missingParents.slice(0, 5).join(", ")}`,
    );
  }

  if (options.minAgents !== undefined && summary.agents < options.minAgents) {
    violations.push(
      `Agent tree total nodes (${summary.agents}) below minimum required (${options.minAgents})`,
    );
  }

  if (options.expectedRoots) {
    const liveRoots = new Set(tree.roots);
    for (const expected of options.expectedRoots) {
      if (!liveRoots.has(expected)) {
        violations.push(
          `Expected root "${expected}" not found among tree roots: [${tree.roots.join(", ")}]`,
        );
      }
    }
  }

  return {
    valid: violations.length === 0,
    summary,
    problems,
    violations,
  };
}

/**
 * Compares two AgentTree structures for equivalence using Bun.deepEquals.
 */
export function areAgentTreesEquivalent(a: AgentTree, b: AgentTree): boolean {
  if (a.roots.length !== b.roots.length || a.nodes.size !== b.nodes.size) {
    return false;
  }
  if (!deepEquals(a.roots, b.roots)) {
    return false;
  }
  for (const [key, nodeA] of a.nodes.entries()) {
    const nodeB = b.nodes.get(key);
    if (!nodeB || !deepEquals(nodeA, nodeB)) {
      return false;
    }
  }
  return true;
}
