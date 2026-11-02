/**
 * The agent hierarchy as a queryable table, keyed by login.
 *
 * The repo already has a SQLite store for the *portal envelope* path: `agents` in
 * lib/f402_sqlite_agents_ingest.ts, keyed by `agent_id`, fed by `flattenNormalizedHierarchyTree`,
 * with a recursive depth CTE. `data/agent-tree.json` does not fit it — measured 2026-11-02:
 * `flattenNormalizedHierarchyTree(tree)` returns 0 rows (the shape is `nodes[login] = {p,l,t}`, not
 * nested `AgentID`/`Level` rows), and `agents.level` is `NOT NULL`, so the collision node
 * (`BRANDON`, level deliberately unset) cannot be inserted at all.
 *
 * Rather than migrate a table other code reads, this keeps a parallel table keyed by canonical
 * login with the two things `agents` cannot hold: a nullable portal level, and the level delta that
 * makes the +1 / +2 / 0-at-cap defect queryable instead of recomputed per reader.
 */

import type { Database } from "bun:sqlite";
import { buildHierarchy, type RawHierarchyTree } from "./hierarchy_view.ts";
import { sqlInt } from "./sportsdesk_sqlite.ts";

export const HIERARCHY_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS hierarchy_nodes (
    login TEXT PRIMARY KEY,
    parent_login TEXT,
    kind TEXT NOT NULL,
    portal_level INTEGER,
    capture_depth INTEGER NOT NULL,
    level_delta INTEGER,
    collision INTEGER NOT NULL DEFAULT 0,
    office TEXT,
    store TEXT,
    skin TEXT,
    loaded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hierarchy_parent ON hierarchy_nodes(parent_login);
`;

/**
 * Descendants of one login, cycles neutralised by `UNION` (dedup) rather than `UNION ALL`.
 *
 * The `agents` CTE uses `UNION ALL` and assumes every root is `level = 1`; a crawl that re-parents
 * a node could give either one a cycle. Dedup costs nothing at this size.
 */
export const DESCENDANTS_CTE = `
  WITH RECURSIVE sub(login) AS (
    SELECT login FROM hierarchy_nodes WHERE login = $login
    UNION
    SELECT n.login FROM hierarchy_nodes n JOIN sub s ON n.parent_login = s.login
  )
  SELECT login FROM sub
`;

export interface LoadedHierarchy {
  readonly rowCount: number;
  readonly roots: readonly string[];
  readonly collisions: number;
  readonly unlevelled: number;
  readonly levelDeltas: Readonly<Record<string, number>>;
}

/** Flatten the tree into rows, then upsert. Idempotent: a reload rewrites the same 2,276 rows. */
export function loadHierarchy(
  db: Database,
  tree: RawHierarchyTree,
  now = Date.now(),
): LoadedHierarchy {
  db.run(HIERARCHY_TABLE_DDL);
  const view = buildHierarchy(tree);
  const nodes = tree.nodes ?? {};
  const collisions = new Set(
    (tree.collisions ?? []).map((collision) => collision.key),
  );

  const rows: {
    login: string;
    parent: string | null;
    kind: string;
    level: number | null;
    depth: number;
    delta: number | null;
    collision: number;
  }[] = [];

  const walk = (node: (typeof view.roots)[number], depth: number) => {
    const parentLevel = node.parentId === null ? null : nodes[node.parentId]?.l;
    const delta =
      parentLevel == null || node.level == null
        ? null
        : node.level - parentLevel;
    rows.push({
      login: node.id,
      parent: node.parentId,
      kind: node.kind,
      level: node.level,
      depth,
      delta,
      collision: collisions.has(node.id) ? 1 : 0,
    });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of view.roots) walk(root, 0);

  const upsert = db.prepare(
    `INSERT INTO hierarchy_nodes
       (login, parent_login, kind, portal_level, capture_depth, level_delta, collision, loaded_at)
     VALUES ($login, $parent, $kind, $level, $depth, $delta, $collision, $now)
     ON CONFLICT(login) DO UPDATE SET
       parent_login = excluded.parent_login,
       kind = excluded.kind,
       portal_level = excluded.portal_level,
       capture_depth = excluded.capture_depth,
       level_delta = excluded.level_delta,
       collision = excluded.collision,
       loaded_at = excluded.loaded_at`,
  );

  const levelDeltas: Record<string, number> = {};
  db.transaction(() => {
    for (const row of rows) {
      upsert.run({
        $login: row.login,
        $parent: row.parent,
        $kind: row.kind,
        $level: row.level,
        $depth: row.depth,
        $delta: row.delta,
        $collision: row.collision,
        $now: now,
      });
      const key = row.delta === null ? "null" : String(row.delta);
      levelDeltas[key] = (levelDeltas[key] ?? 0) + 1;
    }
  })();

  return {
    rowCount: rows.length,
    roots: view.roots.map((root) => root.id),
    collisions: rows.filter((row) => row.collision === 1).length,
    unlevelled: rows.filter((row) => row.level === null).length,
    levelDeltas,
  };
}

/** Every login in the subtree below `login`, inclusive. */
export function descendantsOf(db: Database, login: string): readonly string[] {
  const rows = db.query(DESCENDANTS_CTE).all({ $login: login }) as {
    login: string;
  }[];
  return rows.map((row) => row.login);
}

export interface SubtreeCounts {
  readonly total: number;
  readonly byKind: Readonly<Record<string, number>>;
}

/** The rollup a tree UI asks for: how many of each kind sit under this node. */
export function subtreeCounts(db: Database, login: string): SubtreeCounts {
  const rows = db
    .query(
      `WITH RECURSIVE sub(login) AS (
         SELECT login FROM hierarchy_nodes WHERE login = $login
         UNION
         SELECT n.login FROM hierarchy_nodes n JOIN sub s ON n.parent_login = s.login
       )
       SELECT kind, COUNT(*) AS n FROM hierarchy_nodes
       JOIN sub USING (login) GROUP BY kind`,
    )
    .all({ $login: login }) as { kind: string; n: number | bigint }[];
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const count = sqlInt(row.n);
    byKind[row.kind] = count;
    total += count;
  }
  return { total, byKind };
}

/**
 * Migrate a table created before the enrichment columns existed. Cheap and idempotent, so a
 * database built by an earlier `hierarchy:load` keeps working.
 */
export function ensureEnrichmentColumns(db: Database): void {
  const columns = new Set(
    (
      db.query("PRAGMA table_info(hierarchy_nodes)").all() as { name: string }[]
    ).map((column) => column.name),
  );
  for (const column of ["office", "store", "skin"]) {
    if (!columns.has(column)) {
      db.run(`ALTER TABLE hierarchy_nodes ADD COLUMN ${column} TEXT`);
    }
  }
}

export interface EnrichmentResult {
  readonly matched: number;
  readonly unmatched: readonly string[];
}

/** Writes office/store/skin onto rows that exist; responses for unknown logins are reported. */
export function applyAccountInfo(
  db: Database,
  accounts: readonly {
    readonly key: string;
    readonly office: string;
    readonly store: string;
    readonly skin: string | null;
  }[],
): EnrichmentResult {
  ensureEnrichmentColumns(db);
  const update = db.prepare(
    "UPDATE hierarchy_nodes SET office = $office, store = $store, skin = $skin WHERE login = $login",
  );
  const unmatched: string[] = [];
  let matched = 0;
  db.transaction(() => {
    for (const account of accounts) {
      const changed = update.run({
        $office: account.office,
        $store: account.store,
        $skin: account.skin,
        $login: account.key,
      });
      if (Number(changed.changes) > 0) matched += 1;
      else unmatched.push(account.key);
    }
  })();
  return { matched, unmatched };
}

/** Every node with its group fields, for the office/store rollup. */
export function enrichedRows(db: Database): readonly {
  login: string;
  office: string | null;
  store: string | null;
  isRoot: boolean;
}[] {
  ensureEnrichmentColumns(db);
  return db
    .query(
      "SELECT login, office, store, parent_login IS NULL AS is_root FROM hierarchy_nodes",
    )
    .all()
    .map((row) => ({
      login: String((row as { login: string }).login),
      office: ((row as { office: string | null }).office ?? null) as
        string | null,
      store: ((row as { store: string | null }).store ?? null) as string | null,
      isRoot: Number((row as { is_root: number | bigint }).is_root) === 1,
    }));
}
