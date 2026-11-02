/**
 * Optional `bun:sqlite` audit trail for hierarchy probes (WAL).
 * Enable with `F402_AUDIT_DB=/path/to/audit.sqlite`.
 */

import type { Database } from "bun:sqlite";

import { PROBE_HOST } from "./f402_hierarchy_config.ts";
import { recordPinnedArtifactDrift } from "./f402_portal_version_pin.ts";
import { openSportsdeskSqlite } from "./sportsdesk_sqlite.ts";

let db: Database | null = null;

function database(path: string): Database {
  if (db !== null) return db;
  db = openSportsdeskSqlite(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_log(
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      host TEXT,
      agent_id TEXT,
      agent_type TEXT,
      bust TEXT,
      status INTEGER,
      bytes INTEGER,
      players_mode TEXT,
      hash TEXT,
      trace_id TEXT
    );
    CREATE TABLE IF NOT EXISTS drift(
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quarantine(
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      agent_id TEXT,
      detail TEXT NOT NULL
    );
  `);
  return db;
}

export interface ProbeLogRow {
  readonly ts: number;
  readonly host: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly bust: string;
  readonly status: number;
  readonly bytes: number;
  readonly playersMode: string;
  readonly hash: string;
  readonly traceId?: string;
}

export function recordProbeLog(path: string, row: ProbeLogRow): void {
  const conn = database(path);
  conn
    .prepare(
      `INSERT INTO probe_log(ts,host,agent_id,agent_type,bust,status,bytes,players_mode,hash,trace_id)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.ts,
      row.host,
      row.agentId,
      row.agentType,
      row.bust,
      row.status,
      row.bytes,
      row.playersMode,
      row.hash,
      row.traceId ?? null,
    );
}

export function recordDrift(path: string, kind: string, detail: string): void {
  database(path)
    .prepare("INSERT INTO drift(ts,kind,detail) VALUES(?,?,?)")
    .run(Date.now(), kind, detail);
}

export function recordQuarantine(
  path: string,
  kind: string,
  detail: string,
  agentId?: string,
): void {
  database(path)
    .prepare("INSERT INTO quarantine(ts,kind,agent_id,detail) VALUES(?,?,?,?)")
    .run(Date.now(), kind, agentId ?? null, detail);
}

/**
 * Hash-compare live portal bundles to pinned manifest.
 * Emits `F402_PORTAL_ARTIFACT_DRIFT` on stderr and throws unless `F402_DRIFT_RECORD_ONLY=1`.
 */
export async function recordBustDrift(
  path: string,
  bust?: string,
): Promise<void> {
  const details = await recordPinnedArtifactDrift(
    path,
    PROBE_HOST,
    recordDrift,
    bust ?? "1.0.280",
  );
  if (details.length === 0) return;
  const { PortalArtifactDriftError } =
    await import("./f402_portal_drift_signal.ts");
  if (Bun.env.F402_DRIFT_RECORD_ONLY?.trim() === "1") return;
  throw new PortalArtifactDriftError(details);
}

export function closeAuditDb(): void {
  db?.close();
  db = null;
}
