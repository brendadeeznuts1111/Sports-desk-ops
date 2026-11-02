#!/usr/bin/env bun
/**
 * Attach office / store / skin to the hierarchy, from captured `getAccountInfoOwner` responses.
 *
 *   bun run hierarchy:enrich <dir-or-file> [--db data/hierarchy.sqlite] [--json]
 *
 * `<dir-or-file>` is a directory of `*.json` account-info responses, or one JSON file holding an
 * array of them. The tree carries only `{ l, p, t }`, so this is the only way to learn which office
 * a node sits under — and (Office, Store) is the grouping that would explain the tree's isolated
 * roots: if two roots report the same office, they are siblings above the level the tree models.
 *
 * The load is idempotent and additive: unmatched responses are reported, never inserted, because a
 * response for an agent the tree does not know is evidence of a missing node, not a new one to
 * invent.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { groupByOfficeStore, parseAccountInfo } from "../lib/account_info.ts";
import {
  applyAccountInfo,
  enrichedRows,
  loadHierarchy,
} from "../lib/hierarchy_store.ts";
import type { RawHierarchyTree } from "../lib/hierarchy_view.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";

const REPO = join(import.meta.dir, "..");
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: "string", default: join(REPO, "data", "hierarchy.sqlite") },
    tree: { type: "string", default: join(REPO, "data", "agent-tree.json") },
    json: { type: "boolean", default: false },
  },
});

const source = positionals[0];
if (source === undefined) {
  console.error(
    "usage: bun run hierarchy:enrich <dir-or-file> [--db <path>] [--json]",
  );
  process.exit(2);
}

const sourcePath = resolve(source);
const files = statSync(sourcePath).isDirectory()
  ? readdirSync(sourcePath)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(sourcePath, name))
  : [sourcePath];

const raw: unknown[] = [];
for (const file of files) {
  const parsed: unknown = await Bun.file(file).json();
  if (Array.isArray(parsed)) raw.push(...parsed);
  else raw.push(parsed);
}

const accounts = [];
for (const entry of raw) {
  try {
    accounts.push(parseAccountInfo(entry));
  } catch (error) {
    console.error(`hierarchy:enrich: skipping a response: ${String(error)}`);
  }
}

const db = openSportsdeskSqlite(resolve(values.db ?? ""));
try {
  // Loading is idempotent, so a first run does not need a separate setup step.
  loadHierarchy(
    db,
    (await Bun.file(resolve(values.tree ?? "")).json()) as RawHierarchyTree,
  );
  const applied = applyAccountInfo(db, accounts);
  const groups = groupByOfficeStore(enrichedRows(db));
  const enriched = groups.reduce((total, group) => total + group.nodes, 0);
  const unassigned = groups
    .filter((group) => group.office === "" && group.store === "")
    .reduce((total, group) => total + group.nodes, 0);

  const report = {
    responses: accounts.length,
    matched: applied.matched,
    unmatched: applied.unmatched,
    enriched,
    unassigned,
    groups,
  };

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `hierarchy:enrich: ${report.matched}/${report.responses} response(s) matched, ${report.unmatched.length} unmatched`,
    );
    console.log(
      `  nodes with office+store: ${enriched - unassigned} · none: ${unassigned}`,
    );
    for (const group of groups) {
      const label = `${group.office === "" ? "(no office)" : group.office} / ${group.store === "" ? "(no store)" : group.store}`;
      console.log(`  ${label} — ${group.nodes} node(s)`);
      if (group.roots.length > 0) {
        console.log(`      roots: ${group.roots.join(", ")}`);
      }
    }
    if (report.unmatched.length > 0) {
      console.log(
        `  unmatched (not in the tree — evidence of missing nodes): ${report.unmatched.join(", ")}`,
      );
    }
  }
} finally {
  db.close();
}
