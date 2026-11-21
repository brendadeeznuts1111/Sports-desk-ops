/** Private, account-scoped Fantasy402 graded-report capture. */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { PROBE_HOST } from "../lib/f402_hierarchy_config.ts";
import { buildManagerWagersByFigureDateBody } from "../lib/f402_probe.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";
import {
  F402_KEYCHAIN_NAMES,
  readSecretCanonicalThenLegacy,
} from "../lib/secrets.ts";

const identity = z.string().trim().min(1);
const nativeId = z
  .union([identity, z.number().int().nonnegative()])
  .transform(String);
const amount = z.union([z.string(), z.number(), z.null()]).optional();
const gradedRow = z.object({
  CustomerID: identity,
  TicketNumber: nativeId,
  WagerNumber: nativeId,
  AcceptedDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/),
  WagerStatus: identity,
  AmountWagered: amount,
  AmountWon: amount,
  AmountLost: amount,
  AmountRefunded: amount,
  FreePlayFlag: z.string().optional(),
  TicketWriter: z.string().optional(),
});
const gradedRows = z.array(gradedRow).max(10_000);
const report = z.object({ LIST: z.object({ INFO: gradedRows }) });
const pending = z.object({
  dataSource: z.string().startsWith("live:"),
  capturedAt: z.string().datetime(),
  games: z.array(z.object({ customerID: z.string().optional() })),
});
const deskDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export async function captureGradedWagers(options: {
  readonly snapshot: unknown;
  readonly agentId: string;
  readonly capturedAt: number;
  readonly previous: unknown;
  readonly fetchReport: (body: string) => Promise<Response>;
}) {
  const snapshot = pending.parse(options.snapshot);
  const age = options.capturedAt - Date.parse(snapshot.capturedAt);
  if (age < -60_000 || age > 3_600_000)
    throw new Error("Graded capture requires a recent live pending snapshot");
  const accounts = new Set<string>();
  for (const row of snapshot.games) {
    const account = row.customerID?.trim().toUpperCase();
    if (account) accounts.add(account);
  }
  if (accounts.size < 1 || accounts.size > 100)
    throw new Error(
      "Graded capture requires 1..100 identified pending accounts",
    );
  const date = deskDate.format(options.capturedAt);
  const figureDate = deskDate.format(options.capturedAt - 6 * 86_400_000);
  const retained = z.array(gradedRow).max(100_000).parse(options.previous);
  const observations = new Set(retained.map((row) => JSON.stringify(row)));
  let added = 0;
  let responseRows = 0;
  let accountsWithRows = 0;
  let latestAcceptedTime: string | null = null;
  for (const customerID of accounts) {
    const response = await options.fetchReport(
      buildManagerWagersByFigureDateBody({
        agentID: options.agentId,
        customerID,
        date,
        figureDate,
        graded: 1,
      }),
    );
    if (!response.ok)
      throw new Error(`Fantasy402 graded report HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const rows = report.parse(payload).LIST.INFO;
    if (rows.length) accountsWithRows++;
    responseRows += rows.length;
    for (const row of rows) {
      if (row.CustomerID.toUpperCase() !== customerID)
        throw new Error("Graded report returned a different account");
      if (
        latestAcceptedTime === null ||
        row.AcceptedDateTime > latestAcceptedTime
      )
        latestAcceptedTime = row.AcceptedDateTime;
      const key = JSON.stringify(row);
      if (observations.has(key)) continue;
      if (retained.length >= 100_000)
        throw new Error("Graded export reached its retention limit");
      observations.add(key);
      retained.push(row);
      added++;
    }
  }
  return {
    retained,
    coverage: {
      fromFigureDate: figureDate,
      throughDeskDate: date,
      snapshotCapturedAt: snapshot.capturedAt,
      requestedAccounts: accounts.size,
      completedAccounts: accounts.size,
      accountsWithRows,
      responseRows,
      addedObservations: added,
      retainedObservations: retained.length,
      latestAcceptedTime,
      wholeBookComplete: false,
    },
  };
}

export async function refreshGradedWagerExport(
  output: string,
  snapshotPath: string,
) {
  const target = resolve(output);
  if (target === resolve(snapshotPath))
    throw new Error("Invalid graded capture output path");
  const input = Bun.file(snapshotPath);
  const previous = Bun.file(target);
  if (input.size > 8 * 1024 * 1024 || previous.size > 64 * 1024 * 1024)
    throw new Error("Graded capture input exceeds its size limit");
  let snapshot: unknown = Bun.env.SPORTSDESK_GRADED_ROSTER_JSON?.trim()
    ? null
    : await input.json();
  let progress:
    { rosterHash: string; deskDate: string; next: number } | undefined;
  let coverage: object = {};
  const rosterPath = Bun.env.SPORTSDESK_GRADED_ROSTER_JSON?.trim();
  if (rosterPath) {
    const rosterFile = Bun.file(rosterPath);
    if (rosterFile.size > 32 * 1024 * 1024)
      throw new Error("Roster exceeds size limit");
    const roster = z
      .object({
        schemaVersion: z.literal(1),
        players: z.array(z.object({ customerId: identity })),
      })
      .parse(await rosterFile.json());
    const accounts = [
      ...new Set(roster.players.map((row) => row.customerId.toUpperCase())),
    ].sort();
    if (!accounts.length) throw new Error("Roster is empty");
    const rosterHash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(accounts))
      .digest("hex");
    const date = deskDate.format(Date.now());
    const checkpoint = z.object({
      rosterHash: z.string(),
      deskDate: z.string(),
      next: z.number().int().nonnegative(),
    });
    let offset = 0;
    try {
      const saved = checkpoint.parse(
        await Bun.file(target + ".cursor.json").json(),
      );
      if (saved.rosterHash === rosterHash && saved.next < accounts.length)
        offset = saved.next;
    } catch {
      /* A missing checkpoint starts a new roster sweep. */
    }
    const selected = accounts.slice(offset, offset + 50);
    progress = { rosterHash, deskDate: date, next: offset + selected.length };
    coverage = {
      scope: "live-book-roster",
      rosterAccounts: accounts.length,
      batchStart: offset,
      sweepCompletedAccounts: progress.next,
      remainingAccounts: accounts.length - progress.next,
      sweepComplete: progress.next === accounts.length,
      rosterHash,
    };
    snapshot = {
      capturedAt: new Date().toISOString(),
      dataSource: "live:roster-selection",
      games: selected.map((customerID) => ({ customerID })),
    };
  }
  const existed = await previous.exists();
  const prior: unknown = existed ? await previous.json() : [];
  const agentId =
    Bun.env.F402_AGENT_ID?.trim() ||
    (await readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.agentId));
  if (!agentId) throw new Error("Graded capture requires a Fantasy402 agent");
  const transport = await createF402ReplayTransport();
  const budget = AbortSignal.timeout(90_000);
  try {
    const result = await captureGradedWagers({
      snapshot,
      previous: prior,
      agentId,
      capturedAt: Date.now(),
      fetchReport: (body) =>
        transport.fetch(
          `${PROBE_HOST}/cloud/api/Report/getWagersByFigureDate`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            redirect: "manual",
            signal: AbortSignal.any([budget, AbortSignal.timeout(10_000)]),
          },
        ),
    });
    if (!existed || result.coverage.addedObservations > 0) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(result.retained), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, target);
    }
    if (progress) {
      const temp = target + ".cursor.tmp-" + crypto.randomUUID();
      await writeFile(temp, JSON.stringify(progress), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, target + ".cursor.json");
    }
    return {
      capturedAt: new Date().toISOString(),
      ...result.coverage,
      ...coverage,
    };
  } finally {
    await transport.close();
  }
}
