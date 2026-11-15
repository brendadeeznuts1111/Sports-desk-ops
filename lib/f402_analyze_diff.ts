/**
 * Diff two pull snapshots (two pull directories). Counts and identity
 * sets only; IPs stay hashed by the caller before output.
 */

import type { PullProjection } from "./f402_analyze_ingest.ts";

export const DIFF_DISCLAIMER =
  "Diffs are evidence-scored guesses about what changed between two pulls, not confirmed causes.";

export interface NamedDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
  }[];
}

export interface PullDiff {
  readonly disclaimer: typeof DIFF_DISCLAIMER;
  readonly leftDir: string;
  readonly rightDir: string;
  readonly label: "evidence-scored guess";
  readonly accounts: NamedDiff;
  readonly agents: NamedDiff;
  readonly creditLimits: NamedDiff;
  readonly statuses: NamedDiff;
  readonly ledgerRows: {
    readonly left: number;
    readonly right: number;
    readonly delta: number;
  };
  readonly wagers: {
    readonly left: number;
    readonly right: number;
    readonly delta: number;
  };
  readonly weblog: {
    readonly left: number;
    readonly right: number;
    readonly delta: number;
  };
}

function setDiff(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): NamedDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: { id: string; from: string; to: string }[] = [];
  for (const [id, value] of right) {
    if (!left.has(id)) added.push(id);
    else if (left.get(id) !== value) {
      changed.push({ id, from: left.get(id) ?? "", to: value });
    }
  }
  for (const id of left.keys()) {
    if (!right.has(id)) removed.push(id);
  }
  added.sort();
  removed.sort();
  changed.sort((a, b) => a.id.localeCompare(b.id));
  return { added, removed, changed };
}

function latestSnapshotValue(
  projection: PullProjection,
  field: "agent" | "creditLimitCents" | "status",
): Map<string, string> {
  const latest = new Map<string, { at: string; value: string }>();
  for (const row of projection.censusSnapshots) {
    const value =
      field === "agent"
        ? row.agent
        : field === "status"
          ? row.status
          : row.creditLimitCents === null
            ? ""
            : String(row.creditLimitCents);
    const prev = latest.get(row.accountId);
    if (prev === undefined || row.takenAtIso >= prev.at) {
      latest.set(row.accountId, { at: row.takenAtIso, value });
    }
  }
  for (const account of projection.accounts) {
    if (latest.has(account.accountId)) continue;
    if (field === "agent") {
      const snaps = account.snapshots;
      const last = snaps[snaps.length - 1];
      latest.set(account.accountId, {
        at: "",
        value: last ? (account.agentBySnapshot[last] ?? "") : "",
      });
    } else if (field === "creditLimitCents") {
      latest.set(account.accountId, {
        at: "",
        value:
          account.creditLimitCents === null
            ? ""
            : String(account.creditLimitCents),
      });
    }
  }
  return new Map([...latest].map(([id, row]) => [id, row.value]));
}

export function diffPulls(
  left: PullProjection,
  right: PullProjection,
): PullDiff {
  const leftAccounts = new Map(
    left.accounts.map((row) => [row.accountId, row.login]),
  );
  const rightAccounts = new Map(
    right.accounts.map((row) => [row.accountId, row.login]),
  );
  return {
    disclaimer: DIFF_DISCLAIMER,
    leftDir: left.inDir,
    rightDir: right.inDir,
    label: "evidence-scored guess",
    accounts: setDiff(leftAccounts, rightAccounts),
    agents: setDiff(
      latestSnapshotValue(left, "agent"),
      latestSnapshotValue(right, "agent"),
    ),
    creditLimits: setDiff(
      latestSnapshotValue(left, "creditLimitCents"),
      latestSnapshotValue(right, "creditLimitCents"),
    ),
    statuses: setDiff(
      latestSnapshotValue(left, "status"),
      latestSnapshotValue(right, "status"),
    ),
    ledgerRows: {
      left: left.ledger.length,
      right: right.ledger.length,
      delta: right.ledger.length - left.ledger.length,
    },
    wagers: {
      left: left.wagers.length,
      right: right.wagers.length,
      delta: right.wagers.length - left.wagers.length,
    },
    weblog: {
      left: left.weblog.length,
      right: right.weblog.length,
      delta: right.weblog.length - left.weblog.length,
    },
  };
}
