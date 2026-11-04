#!/usr/bin/env bun
/** Audit one GSLive bet's placement/acceptance/score timeline (fixture or live). */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  ensureGsid,
  fetchBetLog,
  fetchEventLog,
} from "../lib/gslive_auto_session.ts";
import {
  extractBetLogAuditTargets,
  parseBetLog,
  validateAndAuditBetTimeline,
} from "../lib/gslive_bet_event_log.ts";

const scanArgs = Bun.argv
  .slice(2)
  .map((arg, index, all) =>
    arg === "--scan-report" &&
    (all[index + 1] === undefined || all[index + 1]?.startsWith("--"))
      ? "--scan-report=Scratch/betReport-all.json"
      : arg,
  );
const { values } = parseArgs({
  args: scanArgs,
  options: {
    "bet-id": { type: "string" },
    "event-id": { type: "string" },
    "from-fixture": { type: "string" },
    "scan-report": { type: "string" },
    expected: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: bun run gslive:audit-bet [--bet-id 350826311 --event-id 207059651] [--from-fixture path] [--expected accepted] [--json]",
  );
  process.exit(0);
}
if (values["scan-report"] !== undefined) {
  const payload = JSON.parse(
    readFileSync(values["scan-report"] as string, "utf8"),
  ) as { r?: { bets?: Record<string, unknown>[] } } | Record<string, unknown>[];
  const rows = Array.isArray(payload) ? payload : (payload.r?.bets ?? []);
  const targets = extractBetLogAuditTargets(rows);
  const reasonCounts: Record<string, number> = {};
  for (const target of targets) {
    for (const reason of target.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  console.log(
    JSON.stringify(
      {
        file: values["scan-report"],
        rows: rows.length,
        targets: targets.length,
        reasonCounts,
        note: "summary only — bet ids/event ids not printed",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
let betLog: unknown,
  eventLog: unknown,
  betId: string,
  eventState: string | undefined;
if (values["from-fixture"] !== undefined || values["bet-id"] === undefined) {
  const fixture = JSON.parse(
    readFileSync(
      values["from-fixture"] ??
        "tests/fixtures/gslive-bet-event-log-350826311.json",
      "utf8",
    ),
  ) as {
    betId?: string;
    betLog: unknown;
    eventLog: unknown;
    event?: { state?: string };
  };
  betLog = fixture.betLog;
  eventLog = fixture.eventLog;
  betId = values["bet-id"] ?? fixture.betId ?? "unknown";
  eventState = fixture.event?.state;
} else {
  if (values["event-id"] === undefined)
    throw new Error("--event-id is required for a live audit");
  const gsid = await ensureGsid();
  betLog = await fetchBetLog(values["bet-id"] as string, gsid);
  const placed = parseBetLog(betLog).placedAtMs;
  eventLog = await fetchEventLog(
    values["bet-id"] as string,
    values["event-id"] as string,
    String(Math.floor(placed / 1000)),
    gsid,
  );
  betId = values["bet-id"] as string;
}
const audit = validateAndAuditBetTimeline({
  betId,
  ...(values.expected === undefined
    ? {}
    : { expectedWagerState: values.expected }),
  betLog,
  eventLog,
  ...(eventState === undefined ? {} : { eventState }),
});
if (values.json) console.log(JSON.stringify(audit, null, 2));
else {
  console.log(
    `bet ${audit.betId} state=${audit.inferredState} delay=${audit.observedDelayMs}ms feedGap=${audit.feedGapAtPlacementMs}ms fromAccept=${audit.msFromAcceptToNextScore}ms intercept=${audit.would12sDelayInterceptScore}`,
  );
  console.log(`anomalies: ${audit.anomalies.join(",") || "none"}`);
}
