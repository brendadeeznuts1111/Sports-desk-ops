#!/usr/bin/env bun
/**
 * Which agents the ticker knows that the hierarchy tree does not — and vice versa is not asked.
 *
 *   bun run ticker:coverage <ticker.json> [--tree data/agent-tree.json] [--json] [--fail-on-missing]
 *
 * The tree is built from the portal's `baseHeriarchy` parent pointers, and 208 of its 2,272 edges
 * skip a level — so some agents are demonstrably absent. The ticker is a second, independent view
 * of who exists: every `AgentLogin` that has wagered must be a real downline node. Diffing the two
 * turns "the tree may be incomplete" into a count.
 *
 * The join key is `AgentLogin` (trimmed), not `AgentID`:
 *  - the ticker pads `AgentLogin`/`CustomerID` to CHAR(10) and `AgentID` not at all;
 *  - `AgentID` carries trailing periods the login does not (`GB3500.` vs `GB3500`);
 *  - trailing punctuation is part of some real keys (`RM11.` is in the tree), so it must not be
 *    stripped — hence the near-match report instead of a normalisation rule.
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { RawHierarchyTree } from "../lib/hierarchy_view.ts";

const REPO = join(import.meta.dir, "..");
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    tree: { type: "string", default: join(REPO, "data", "agent-tree.json") },
    json: { type: "boolean", default: false },
    "fail-on-missing": { type: "boolean", default: false },
  },
});

const tickerPath = positionals[0];
if (tickerPath === undefined) {
  console.error(
    "usage: bun run ticker:coverage <ticker.json> [--tree <path>] [--json] [--fail-on-missing]",
  );
  process.exit(2);
}

function rowsOf(payload: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["LIST", "wagers", "rows"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return [];
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim().toUpperCase() : "";

const ticker = rowsOf(await Bun.file(resolve(tickerPath)).json());
const tree = (await Bun.file(resolve(values.tree)).json()) as RawHierarchyTree;
const treeKeys = new Set(Object.keys(tree.nodes ?? {}).map(text));

const agents = new Map<string, number>();
for (const row of ticker) {
  // AgentLogin is the padded CHAR(10) login; AgentID is the unpadded one with trailing periods.
  const key = text(row["AgentLogin"]) || text(row["AgentID"]);
  if (key === "") continue;
  agents.set(key, (agents.get(key) ?? 0) + 1);
}

/**
 * A hint, never a join: same stem after dropping a trailing period or `_N` suffix, or one key is a
 * prefix of the other. `CUB22A` is not `CUB22` — the ticker and the tree can disagree about whether
 * a suffix is a sub-account — so this only tells the reader what to look at.
 */
function nearMatch(key: string): readonly string[] {
  const stem = (value: string) =>
    value.replace(/\.+$/, "").replace(/_\d+$/, "");
  const target = stem(key);
  return [...treeKeys].filter((candidate) => {
    const other = stem(candidate);
    if (other === target) return true;
    const [short, long] =
      other.length <= target.length ? [other, target] : [target, other];
    return short.length >= 4 && long.startsWith(short);
  });
}

const present: string[] = [];
const missing: { agent: string; rows: number; near: readonly string[] }[] = [];
for (const [agent, rows] of [...agents].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  if (treeKeys.has(agent)) present.push(agent);
  else missing.push({ agent, rows, near: nearMatch(agent) });
}

const report = {
  tickerRows: ticker.length,
  distinctAgents: agents.size,
  inTree: present.length,
  missing,
};
if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `ticker:coverage: ${report.tickerRows} row(s), ${report.distinctAgents} agent(s) — ${present.length} in the tree, ${missing.length} missing`,
  );
  for (const entry of missing) {
    const near =
      entry.near.length > 0 ? ` (near: ${entry.near.join(", ")})` : "";
    console.log(`  MISSING ${entry.agent} — ${entry.rows} row(s)${near}`);
  }
}
if (values["fail-on-missing"] && missing.length > 0) process.exit(1);
