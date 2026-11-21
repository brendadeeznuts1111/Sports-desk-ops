/** Account-scoped Mode A capture for the existing hourly weblog bridge. */
import { parseAccessMs } from "./f402_weblog.ts";
import { parseWebLogListPayload } from "./f402_weblog_fetch.ts";

export interface WeblogAccountCoverage {
  readonly scope: "live-pending-accounts";
  readonly wholeBookComplete: false;
  readonly snapshotCapturedAt: string;
  readonly capturedAt: string;
  readonly reportDate: string;
  readonly snapshotTicketRows: number;
  readonly unidentifiedTicketRows: number;
  readonly eligibleAccounts: number;
  readonly requestedAccounts: number;
  readonly completedAccounts: number;
  readonly accountsWithActivity: number;
  readonly emptyAccounts: number;
  readonly failedAccounts: number;
  readonly activityRows: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reconstruct count-only public coverage; never forward private capture fields. */
export function parseWeblogAccountCoverage(
  value: unknown,
): WeblogAccountCoverage | null {
  if (
    !isRecord(value) ||
    value.scope !== "live-pending-accounts" ||
    value.wholeBookComplete !== false
  )
    return null;
  const {
    snapshotCapturedAt,
    capturedAt,
    reportDate,
    snapshotTicketRows,
    unidentifiedTicketRows,
    eligibleAccounts,
    requestedAccounts,
    completedAccounts,
    accountsWithActivity,
    emptyAccounts,
    failedAccounts,
    activityRows,
  } = value;
  if (
    typeof snapshotCapturedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshotCapturedAt)) ||
    typeof capturedAt !== "string" ||
    !Number.isFinite(Date.parse(capturedAt)) ||
    typeof reportDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)
  )
    return null;
  if (
    typeof snapshotTicketRows !== "number" ||
    typeof unidentifiedTicketRows !== "number" ||
    typeof eligibleAccounts !== "number" ||
    typeof requestedAccounts !== "number" ||
    typeof completedAccounts !== "number" ||
    typeof accountsWithActivity !== "number" ||
    typeof emptyAccounts !== "number" ||
    typeof failedAccounts !== "number" ||
    typeof activityRows !== "number"
  )
    return null;
  if (
    ![
      snapshotTicketRows,
      unidentifiedTicketRows,
      eligibleAccounts,
      requestedAccounts,
      completedAccounts,
      accountsWithActivity,
      emptyAccounts,
      failedAccounts,
      activityRows,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    unidentifiedTicketRows > snapshotTicketRows ||
    requestedAccounts !== eligibleAccounts ||
    completedAccounts + failedAccounts !== requestedAccounts ||
    accountsWithActivity + emptyAccounts !== completedAccounts
  )
    return null;
  return {
    scope: "live-pending-accounts",
    wholeBookComplete: false,
    snapshotCapturedAt,
    capturedAt,
    reportDate,
    snapshotTicketRows,
    unidentifiedTicketRows,
    eligibleAccounts,
    requestedAccounts,
    completedAccounts,
    accountsWithActivity,
    emptyAccounts,
    failedAccounts,
    activityRows,
  };
}

export async function capturePendingAccountWeblog(options: {
  readonly snapshot: unknown;
  readonly agentId: string;
  readonly fetchActivity: (body: URLSearchParams) => Promise<Response>;
  readonly now?: () => number;
}): Promise<{
  readonly rows: readonly Record<string, unknown>[];
  readonly coverage: WeblogAccountCoverage;
}> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const snapshot = options.snapshot;
  if (
    !isRecord(snapshot) ||
    typeof snapshot.capturedAt !== "string" ||
    typeof snapshot.dataSource !== "string" ||
    !snapshot.dataSource.startsWith("live:") ||
    !Array.isArray(snapshot.games)
  )
    throw new Error("weblog capture requires a live pending-ticket snapshot");
  const capturedMs = Date.parse(snapshot.capturedAt);
  if (
    !Number.isFinite(capturedMs) ||
    startedAt - capturedMs > 3_600_000 ||
    capturedMs > startedAt + 60_000
  )
    throw new Error(
      "weblog pending snapshot is stale or future-dated; refresh positions:cron first",
    );
  const customers = new Set<string>();
  let unidentifiedTicketRows = 0;
  for (const game of snapshot.games) {
    if (!isRecord(game))
      throw new Error("weblog pending snapshot has an invalid ticket row");
    if (typeof game.customerID !== "string" || !game.customerID.trim()) {
      unidentifiedTicketRows++;
      continue;
    }
    customers.add(game.customerID.trim());
  }
  if (customers.size === 0 || customers.size > 200)
    throw new Error(
      "weblog capture requires 1..200 pending accounts; refusing an empty or truncated scope",
    );
  if (!options.agentId.trim())
    throw new Error("weblog capture requires F402_AGENT_ID");
  const reportDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(startedAt));
  const [year, month, day] = reportDate.split("-");
  const rows: Record<string, unknown>[] = [];
  let completedAccounts = 0;
  let accountsWithActivity = 0;
  let failedAccounts = 0;
  // Sequential reads stay below the existing two-request provider concurrency ceiling.
  for (const customer of customers) {
    if (now() - startedAt >= 120_000) {
      failedAccounts = customers.size - completedAccounts;
      break;
    }
    try {
      const response = await options.fetchActivity(
        new URLSearchParams({
          agentID: options.agentId,
          agentOwner: options.agentId,
          customerID: customer,
          ip: customer,
          start: `${month}/${day}/${year}`,
          end: `${month}/${day}/${year}`,
          type: "A",
          actions: "ALL",
          operation: "getWebLog",
          RRO: "1",
        }),
      );
      if (!response.ok) throw new Error("upstream request failed");
      const payload: unknown = await response.json();
      const activity = parseWebLogListPayload(payload);
      if (
        activity === null ||
        activity.some(
          (row) =>
            typeof row.AccessDateTime !== "string" ||
            !Number.isFinite(parseAccessMs(row.AccessDateTime)) ||
            typeof row.Operation !== "string" ||
            typeof row.LoginID !== "string" ||
            typeof row.IPAddress !== "string",
        )
      )
        throw new Error("invalid activity rows");
      if (rows.length + activity.length > 50_000)
        throw new Error("activity row budget exceeded");
      for (const row of activity)
        rows.push({
          AccessDateTime: row.AccessDateTime,
          LoginID: row.LoginID,
          IPAddress: row.IPAddress,
          Operation: row.Operation,
        });
      completedAccounts++;
      if (activity.length > 0) accountsWithActivity++;
    } catch {
      failedAccounts = customers.size - completedAccounts;
      break;
    }
  }
  if (failedAccounts > 0 || rows.length === 0)
    throw new Error(
      `weblog capture incomplete: completed=${completedAccounts}/${customers.size}, failed-or-unattempted=${failedAccounts}, rows=${rows.length}; previous artifact not republished`,
    );
  return {
    rows,
    coverage: {
      scope: "live-pending-accounts",
      wholeBookComplete: false,
      snapshotCapturedAt: snapshot.capturedAt,
      capturedAt: new Date(now()).toISOString(),
      reportDate,
      snapshotTicketRows: snapshot.games.length,
      unidentifiedTicketRows,
      eligibleAccounts: customers.size,
      requestedAccounts: customers.size,
      completedAccounts,
      accountsWithActivity,
      emptyAccounts: completedAccounts - accountsWithActivity,
      failedAccounts: 0,
      activityRows: rows.length,
    },
  };
}
