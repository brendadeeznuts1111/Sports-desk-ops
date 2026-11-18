/**
 * @file lib/token_watch_daemon.ts
 * @description Fingerprint-gated sync from the SQLite profile theme registry to disk artifacts.
 *
 * PRAGMA data_version only changes when another connection writes, so a polling daemon sees real
 * external changes. Even then, an unrelated table bump is discarded by the SHA-256 of the sorted
 * profile snapshot: no rename, no mtime churn on .env, .env.example or theme.gen.ts.
 */
import type { Database } from "bun:sqlite";
import {
  atomicWrite,
  computeSnapshotFingerprint,
  renderEnvFile,
  renderThemeGenTs,
  type RegistryColorRow,
} from "./token_automation.ts";

export interface SyncState {
  lastDataVersion: number;
  lastFingerprint: string;
}

export interface SyncTargets {
  readonly envPath: string;
  readonly envExamplePath: string;
  readonly themeGenPath: string;
}

/** True when at least one artifact was rewritten. */
export async function syncIfChanged(
  db: Database,
  state: SyncState,
  targets: SyncTargets,
): Promise<boolean> {
  const versionRow = db.query("PRAGMA data_version").get() as {
    data_version: number | bigint;
  } | null;
  const dataVersion = Number(versionRow?.data_version ?? -1);
  // data_version only changes when another connection commits; using it as the
  // primary gate would miss same-connection writes. Hash the snapshot instead,
  // and use data_version only as the cheap state marker after a successful sync.
  const rows = db
    .query(
      `SELECT profile_id, color_int, color_css, color_hex, color_label
       FROM profile_themes ORDER BY profile_id ASC`,
    )
    .all() as Array<Record<string, string | number | bigint>>;
  const snapshot: RegistryColorRow[] = rows.map((row) => ({
    profile_id: String(row.profile_id) as RegistryColorRow["profile_id"],
    color_int: Number(row.color_int),
    color_css: String(row.color_css),
    color_hex: String(row.color_hex),
    color_label: String(row.color_label),
  }));

  const fingerprint = computeSnapshotFingerprint(snapshot);
  if (fingerprint === state.lastFingerprint) {
    state.lastDataVersion = dataVersion;
    return false;
  }

  await Promise.all([
    atomicWrite(targets.envPath, renderEnvFile(snapshot, fingerprint, "live")),
    atomicWrite(
      targets.envExamplePath,
      renderEnvFile(snapshot, fingerprint, "example"),
    ),
    atomicWrite(targets.themeGenPath, renderThemeGenTs(snapshot, fingerprint)),
  ]);
  // Commit the in-memory state only after every rename succeeds. A failed write
  // must be retried rather than being hidden by a previously observed version.
  state.lastDataVersion = dataVersion;
  state.lastFingerprint = fingerprint;
  return true;
}
