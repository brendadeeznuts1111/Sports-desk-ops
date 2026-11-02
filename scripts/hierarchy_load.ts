#!/usr/bin/env bun
/**
 * Load the agent hierarchy into a SQLite table you can query.
 *
 *   bun run hierarchy:load [--db <path>] [--quiet]
 *
 * Default database: data/hierarchy.sqlite (gitignored via data/*.sqlite*). The loader is
 * idempotent — known logins are updated, not duplicated — and prints the level-delta distribution
 * so the field's defects travel with the store instead of living in a reader's head.
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import { loadHierarchy, subtreeCounts } from "../lib/hierarchy_store.ts";
import type { RawHierarchyTree } from "../lib/hierarchy_view.ts";

const REPO = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    db: { type: "string", default: join(REPO, "data", "hierarchy.sqlite") },
    tree: { type: "string", default: join(REPO, "data", "agent-tree.json") },
    quiet: { type: "boolean", default: false },
  },
});

const treePath = resolve(values.tree ?? "");
const tree = (await Bun.file(treePath)
  .json()
  .catch((error: unknown) => {
    console.error(`hierarchy:load: cannot read ${treePath}: ${String(error)}`);
    process.exit(2);
  })) as RawHierarchyTree;

const dbPath = resolve(values.db ?? "");
const db = openSportsdeskSqlite(dbPath);
try {
  const loaded = loadHierarchy(db, tree);
  if (!values.quiet) {
    console.log(`hierarchy:load: ${loaded.rowCount} node(s) in ${dbPath}`);
    console.log(`  roots: ${loaded.roots.join(", ")}`);
    console.log(
      `  collisions: ${loaded.collisions} · unlevelled: ${loaded.unlevelled}`,
    );
    console.log(
      `  level deltas (child − parent): ${JSON.stringify(loaded.levelDeltas)}`,
    );
    const root =
      loaded.roots.find((id) => id === "NOLAWOLF") ?? loaded.roots[0];
    if (root !== undefined) {
      const counts = subtreeCounts(db, root);
      console.log(
        `  subtree of ${root}: ${counts.total} node(s) ${JSON.stringify(counts.byKind)}`,
      );
    }
  }
} finally {
  db.close();
}
