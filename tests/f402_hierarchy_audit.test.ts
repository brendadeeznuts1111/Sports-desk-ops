import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeAuditDb,
  recordDrift,
  recordProbeLog,
  recordQuarantine,
} from "../lib/f402_hierarchy_audit.ts";

let root: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "f402-audit-"));
});

afterAll(() => {
  closeAuditDb();
  rmSync(root, { recursive: true, force: true });
});

/** One fresh database per test; the module keeps a singleton connection, so close it first. */
function freshPath(): string {
  closeAuditDb();
  counter += 1;
  return join(root, `audit-${counter}.sqlite`);
}

function query<T>(path: string, sql: string): T[] {
  const db = new Database(path);
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

const PROBE = {
  ts: 1_700_000_000_000,
  host: "probe.example",
  agentId: "agent-1",
  agentType: "manager",
  bust: "1.0.280",
  status: 200,
  bytes: 4_096,
  playersMode: "on",
  hash: "abc123",
};

describe("recordProbeLog", () => {
  test("inserts every column, including the trace id", () => {
    const path = freshPath();
    recordProbeLog(path, { ...PROBE, traceId: "trace-9" });
    closeAuditDb();
    expect(
      query(
        path,
        "SELECT ts, host, agent_id, agent_type, bust, status, bytes, players_mode, hash, trace_id, id FROM probe_log",
      ),
    ).toEqual([
      {
        ts: PROBE.ts,
        host: PROBE.host,
        agent_id: PROBE.agentId,
        agent_type: PROBE.agentType,
        bust: PROBE.bust,
        status: PROBE.status,
        bytes: PROBE.bytes,
        players_mode: PROBE.playersMode,
        hash: PROBE.hash,
        trace_id: "trace-9",
        id: 1,
      },
    ]);
  });

  test("stores a missing trace id as null", () => {
    const path = freshPath();
    recordProbeLog(path, PROBE);
    recordProbeLog(path, { ...PROBE });
    closeAuditDb();
    const rows = query<{ trace_id: string | null; id: number }>(
      path,
      "SELECT trace_id, id FROM probe_log ORDER BY id",
    );
    expect(rows).toEqual([
      { trace_id: null, id: 1 },
      { trace_id: null, id: 2 },
    ]);
  });
});

describe("recordDrift and recordQuarantine", () => {
  test("stamps drift rows with the current time", () => {
    const path = freshPath();
    const before = Date.now();
    recordDrift(path, "portal_artifact_drift", "bundle.js sha256 mismatch");
    closeAuditDb();
    const rows = query<{ ts: number; kind: string; detail: string }>(
      path,
      "SELECT ts, kind, detail FROM drift",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("portal_artifact_drift");
    expect(rows[0]!.detail).toBe("bundle.js sha256 mismatch");
    expect(Math.abs(rows[0]!.ts - before)).toBeLessThan(10_000);
  });

  test("stores an optional agent id on quarantine rows", () => {
    const path = freshPath();
    recordQuarantine(path, "schema", "missing GENERAL", "agent-7");
    recordQuarantine(path, "schema", "missing PLAYERS");
    closeAuditDb();
    expect(
      query(path, "SELECT kind, agent_id, detail FROM quarantine ORDER BY id"),
    ).toEqual([
      { kind: "schema", agent_id: "agent-7", detail: "missing GENERAL" },
      { kind: "schema", agent_id: null, detail: "missing PLAYERS" },
    ]);
  });
});

describe("database setup", () => {
  test("creates the three tables and enables WAL", () => {
    const path = freshPath();
    recordProbeLog(path, PROBE);
    closeAuditDb();
    const tables = query<{ name: string }>(
      path,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('probe_log','drift','quarantine') ORDER BY name",
    );
    expect(tables.map((table) => table.name)).toEqual([
      "drift",
      "probe_log",
      "quarantine",
    ]);
    expect(
      query<{ journal_mode: string }>(path, "PRAGMA journal_mode")[0]
        ?.journal_mode,
    ).toBe("wal");
  });

  test("keeps one connection per module lifetime and resets on close", () => {
    const first = freshPath();
    const second = join(root, "audit-reset.sqlite");
    recordProbeLog(first, PROBE);
    closeAuditDb();
    recordDrift(second, "kind", "detail");
    closeAuditDb();
    expect(query(first, "SELECT count(*) AS n FROM probe_log")[0]).toEqual({
      n: 1,
    });
    expect(query(first, "SELECT count(*) AS n FROM drift")[0]).toEqual({
      n: 0,
    });
    expect(query(second, "SELECT count(*) AS n FROM probe_log")[0]).toEqual({
      n: 0,
    });
    expect(query(second, "SELECT count(*) AS n FROM drift")[0]).toEqual({
      n: 1,
    });
  });
});
