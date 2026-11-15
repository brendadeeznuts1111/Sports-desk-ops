/**
 * Timeline of account changes from census snapshot diffs: agent moves,
 * credit/wager-limit changes, balance changes, and status changes.
 * Each event is an evidence-scored guess about what changed, not a cause.
 */

import type {
  CensusAccountSnapshot,
  PullProjection,
} from "./f402_analyze_ingest.ts";

export const TIMELINE_DISCLAIMER =
  "Timeline events are evidence-scored guesses from snapshot diffs, not confirmed causes.";

export type TimelineChangeKind =
  | "agent_move"
  | "credit_limit_change"
  | "wager_limit_change"
  | "balance_change"
  | "status_change";

export interface TimelineEvent {
  readonly accountId: string;
  readonly login: string;
  readonly kind: TimelineChangeKind;
  readonly fromSnapshotId: string;
  readonly toSnapshotId: string;
  readonly atIso: string;
  readonly fromValue: string;
  readonly toValue: string;
  readonly label: "evidence-scored guess";
}

export interface AccountTimeline {
  readonly accountId: string;
  readonly login: string;
  readonly events: readonly TimelineEvent[];
}

function snapshotsForAccount(
  projection: PullProjection,
  accountId: string,
): CensusAccountSnapshot[] {
  return projection.censusSnapshots
    .filter(
      (row) =>
        row.accountId === accountId ||
        row.login.toLowerCase() === accountId.toLowerCase(),
    )
    .slice()
    .sort((a, b) => {
      const d = Date.parse(a.takenAtIso) - Date.parse(b.takenAtIso);
      if (d !== 0) return d;
      return a.snapshotId.localeCompare(b.snapshotId);
    });
}

function money(value: number | null): string {
  return value === null ? "" : String(value);
}

export function timelineForAccount(
  projection: PullProjection,
  accountId: string,
): AccountTimeline {
  const snaps = snapshotsForAccount(projection, accountId);
  const login = snaps[0]?.login ?? accountId;
  const events: TimelineEvent[] = [];
  for (let i = 1; i < snaps.length; i += 1) {
    const prev = snaps[i - 1]!;
    const cur = snaps[i]!;
    const push = (
      kind: TimelineChangeKind,
      fromValue: string,
      toValue: string,
    ): void => {
      if (fromValue === toValue) return;
      events.push({
        accountId: cur.accountId,
        login: cur.login || login,
        kind,
        fromSnapshotId: prev.snapshotId,
        toSnapshotId: cur.snapshotId,
        atIso: cur.takenAtIso,
        fromValue,
        toValue,
        label: "evidence-scored guess",
      });
    };
    push("agent_move", prev.agent, cur.agent);
    push(
      "credit_limit_change",
      money(prev.creditLimitCents),
      money(cur.creditLimitCents),
    );
    push(
      "wager_limit_change",
      money(prev.wagerLimitCents),
      money(cur.wagerLimitCents),
    );
    push("balance_change", money(prev.balanceCents), money(cur.balanceCents));
    push("status_change", prev.status, cur.status);
  }
  return { accountId, login, events };
}

export function buildAccountTimeline(
  projection: PullProjection,
  options: { readonly accounts?: readonly string[] } = {},
): {
  readonly disclaimer: typeof TIMELINE_DISCLAIMER;
  readonly accounts: readonly AccountTimeline[];
} {
  const allow =
    options.accounts !== undefined && options.accounts.length > 0
      ? new Set(options.accounts.map((id) => id.toLowerCase()))
      : null;
  const ids = [
    ...new Set(
      projection.accounts
        .filter(
          (row) =>
            allow === null ||
            allow.has(row.accountId.toLowerCase()) ||
            allow.has(row.login.toLowerCase()),
        )
        .map((row) => row.accountId),
    ),
  ].sort();
  const accounts = ids
    .map((id) => timelineForAccount(projection, id))
    .filter((row) => row.events.length > 0);
  accounts.sort(
    (a, b) =>
      b.events.length - a.events.length ||
      a.accountId.localeCompare(b.accountId),
  );
  return { disclaimer: TIMELINE_DISCLAIMER, accounts };
}
