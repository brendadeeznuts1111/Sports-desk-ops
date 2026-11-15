/**
 * @file lib/customer_index.ts
 * @description Lookup index for customer records, backed by SQLite through `Bun.SQL`.
 *
 * The records come from several places with different trust levels, so `source` is part of the key:
 * the same id can be a demo-book row and an artifact row, and collapsing them would make a synthetic
 * id look live. Nothing here authenticates against the portal; it answers "what do we know locally".
 */

import {
  type Row,
  numberColumn,
  parseRows,
  stringColumn,
} from "./row_parse.ts";

export interface CustomerRecord {
  readonly id: string;
  readonly source: CustomerSource;
  readonly agent: string;
  readonly name: string;
  readonly updatedAt: string;
}

/**
 * Where a record came from.
 *
 * `artifact` and `demo-book` are demo cohorts; `fixture` is synthetic test data. A live portal id
 * only appears as `capture` once a capture actually retains it.
 */
export type CustomerSource =
  "live" | "artifact" | "demo-book" | "fixture" | "capture" | "dod6-spine";

export const LIVE_SOURCES: ReadonlySet<CustomerSource> =
  new Set<CustomerSource>(["live", "capture"]);

export type CustomerDatabase = InstanceType<typeof Bun.SQL>;

const CUSTOMER_SOURCES: ReadonlySet<string> = new Set([
  "live",
  "artifact",
  "demo-book",
  "fixture",
  "capture",
  "dod6-spine",
]);

function customerSource(value: string): CustomerSource {
  if (!CUSTOMER_SOURCES.has(value))
    throw new Error(`unknown customer source "${value}"`);
  return value as CustomerSource;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customers (
     id TEXT NOT NULL,
     source TEXT NOT NULL,
     agent TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL DEFAULT '',
     updated_at TEXT NOT NULL,
     PRIMARY KEY (id, source)
   )`,
  `CREATE INDEX IF NOT EXISTS customers_agent ON customers(agent)`,
];

export function openCustomerIndex(url = "sqlite://:memory:"): CustomerDatabase {
  return new Bun.SQL(url);
}

export async function ensureCustomerSchema(
  db: CustomerDatabase,
): Promise<void> {
  for (const statement of SCHEMA) await db.unsafe(statement);
}

export async function upsertCustomers(
  db: CustomerDatabase,
  records: readonly CustomerRecord[],
): Promise<number> {
  let written = 0;
  for (const record of records) {
    await db`
      INSERT INTO customers (id, source, agent, name, updated_at)
      VALUES (${record.id}, ${record.source}, ${record.agent}, ${record.name}, ${record.updatedAt})
      ON CONFLICT(id, source) DO UPDATE SET
        agent = excluded.agent,
        name = excluded.name,
        updated_at = excluded.updated_at
    `;
    written += 1;
  }
  return written;
}

function toRecord(row: Row): CustomerRecord {
  return {
    id: stringColumn(row, "id"),
    source: customerSource(stringColumn(row, "source")),
    agent: stringColumn(row, "agent"),
    name: stringColumn(row, "name"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

export async function listCustomers(
  db: CustomerDatabase,
  options: { limit?: number; source?: CustomerSource } = {},
): Promise<CustomerRecord[]> {
  const limit = Math.max(1, options.limit ?? 20);
  const rows =
    options.source === undefined
      ? await db`SELECT id, source, agent, name, updated_at FROM customers ORDER BY source, id LIMIT ${limit}`
      : await db`SELECT id, source, agent, name, updated_at FROM customers WHERE source = ${options.source} ORDER BY id LIMIT ${limit}`;
  return parseRows(rows, toRecord);
}

export async function findCustomer(
  db: CustomerDatabase,
  id: string,
): Promise<CustomerRecord[]> {
  const rows = await db`
    SELECT id, source, agent, name, updated_at FROM customers
    WHERE id = ${id} ORDER BY source
  `;
  return parseRows(rows, toRecord);
}

/** Substring match on id, agent or name; intended for interactive lookup, not bulk export. */
export async function searchCustomers(
  db: CustomerDatabase,
  query: string,
  limit = 20,
): Promise<CustomerRecord[]> {
  const pattern = `%${query}%`;
  const rows = await db`
    SELECT id, source, agent, name, updated_at FROM customers
    WHERE id LIKE ${pattern} OR agent LIKE ${pattern} OR name LIKE ${pattern}
    ORDER BY source, id LIMIT ${Math.max(1, limit)}
  `;
  return parseRows(rows, toRecord);
}

export async function countBySource(
  db: CustomerDatabase,
): Promise<Array<{ source: string; count: number }>> {
  const rows = await db`
    SELECT source, COUNT(*) AS count FROM customers GROUP BY source ORDER BY source
  `;
  return parseRows(rows, (row) => ({
    source: stringColumn(row, "source"),
    count: numberColumn(row, "count"),
  }));
}
