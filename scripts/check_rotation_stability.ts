#!/usr/bin/env bun
/**
 * A team's rotation number must not change between rows.
 *
 *   bun run scripts/check_rotation_stability.ts <scores.json> [--json]
 *
 * `Team1ID`/`Team1RotNum` and `Team2ID`/`Team2RotNum` come from the Pending/`getScoresLiveDynamic`
 * payloads; the portal's `RotationNumber` is a 3-to-6 digit board number for the team, so two
 * different values for one `Team*ID` mean either a mis-keyed row or a board reset mid-capture, and
 * either one silently corrupts any join done on the rotation.
 *
 * The shape accepted is the one observed in the wire payloads: `{Scores: [...]}`, `{LIST: [...]}`,
 * `{Pending: [...]}`, a bare array, or a single row object.
 *
 * A row whose `Team*ID` is missing is counted separately instead of being grouped under
 * `undefined`: the one-liner this replaces filtered `[undefined, rot]` pairs into a single bucket,
 * which reports nothing on a payload where the IDs were never there.
 */

export interface RotationReport {
  /** Rows read from the payload. */
  readonly rows: number;
  /** Distinct team ids seen. */
  readonly teams: number;
  /** Teams with more than one rotation number, sorted by id. */
  readonly unstable: readonly {
    readonly teamId: string;
    readonly rotations: readonly string[];
  }[];
  /** Team slots with no id — excluded from the grouping, reported so silence is not success. */
  readonly missingId: number;
  /** True when no row carried any of the four fields, i.e. the check could not run. */
  readonly shapeUnknown: boolean;
}

const PAIRS = [
  ["Team1ID", "Team1RotNum"],
  ["Team2ID", "Team2RotNum"],
] as const;

function rowsOf(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  for (const key of ["Scores", "LIST", "Pending", "data", "rows"]) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  // A single row.
  return Object.keys(payload).length > 0 ? [payload] : [];
}

export function rotationInstability(payload: unknown): RotationReport {
  const rows = rowsOf(payload);
  const byTeam = new Map<string, Set<string>>();
  let missingId = 0;
  let sawPair = false;

  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    for (const [idField, rotField] of PAIRS) {
      const id = row[idField];
      const rotation = row[rotField];
      if (rotation === undefined || rotation === null || rotation === "")
        continue;
      sawPair = true;
      if (id === undefined || id === null || String(id).trim() === "") {
        missingId += 1;
        continue;
      }
      const key = String(id).trim();
      const seen = byTeam.get(key) ?? new Set<string>();
      seen.add(String(rotation).trim());
      byTeam.set(key, seen);
    }
  }

  const unstable = [...byTeam.entries()]
    .filter(([, rotations]) => rotations.size > 1)
    .map(([teamId, rotations]) => ({
      teamId,
      rotations: [...rotations].sort(),
    }))
    .sort((a, b) => a.teamId.localeCompare(b.teamId));

  return {
    rows: rows.length,
    teams: byTeam.size,
    unstable,
    missingId,
    shapeUnknown: rows.length > 0 && !sawPair,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const path = args.find((arg) => !arg.startsWith("--"));

  if (path === undefined) {
    console.error(
      "usage: bun run scripts/check_rotation_stability.ts <scores.json> [--json]",
    );
    process.exit(2);
  }

  const payload: unknown = await Bun.file(path)
    .json()
    .catch((error: unknown) => {
      console.error(`check:rotations: cannot read ${path}: ${String(error)}`);
      process.exit(2);
    });

  const report = rotationInstability(payload);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `check:rotations: ${report.rows} row(s), ${report.teams} team(s) with a rotation`,
    );
    if (report.shapeUnknown) {
      console.log(
        "  no Team1ID/Team1RotNum or Team2ID/Team2RotNum field found — nothing was checked",
      );
    }
    if (report.missingId > 0) {
      console.log(
        `  ${report.missingId} rotation(s) had no team id and were not grouped`,
      );
    }
    for (const { teamId, rotations } of report.unstable) {
      console.log(
        `  UNSTABLE ${teamId}: ${rotations.join(", ")} (${rotations.length} rotations)`,
      );
    }
  }

  process.exit(report.unstable.length === 0 && !report.shapeUnknown ? 0 : 1);
}
