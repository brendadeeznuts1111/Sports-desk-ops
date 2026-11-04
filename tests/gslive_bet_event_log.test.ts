import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditEventTimeline,
  parseGsliveTimestampMs,
  extractBetLogAuditTargets,
  parseBetLog,
  parseEventLog,
  validateAndAuditBetTimeline,
} from "../lib/gslive_bet_event_log.ts";

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "fixtures/gslive-bet-event-log-350826311.json"),
    "utf8",
  ),
) as {
  betId: string;
  betLog: unknown;
  eventLog: unknown;
  event: { state: string };
};

describe("gslive bet/event log audit", () => {
  test("parses the measured bet log", () => {
    const bet = parseBetLog(fixture.betLog);
    expect(bet.inferredState).toBe("accepted");
    expect(bet.f402TicketNumber).toBe("1074652273");
    expect(bet.observedDelayMs).toBe(6000);
    expect(bet.placedOddsAmerican).toBe(2431);
    expect(bet.acceptedOddsAmerican).toBe(2731);
    expect(bet.oddsDeltaAmerican).toBe(300);
    expect(bet.isManuallyEntered).toBe(false);
  });

  test("parses tick scores and audit metrics", () => {
    expect(parseEventLog(fixture.eventLog)).toHaveLength(9);
    const audit = validateAndAuditBetTimeline({
      betId: fixture.betId,
      expectedWagerState: "accepted",
      betLog: fixture.betLog,
      eventLog: fixture.eventLog,
      eventState: fixture.event.state,
    });
    expect(audit.observedDelayMs).toBe(6000);
    expect(audit.feedGapAtPlacementMs).toBe(6237);
    expect(audit.scoreAtPlace).toEqual([10, 4]);
    expect(audit.nextScore).toEqual([13, 4]);
    expect(audit.msFromPlaceToNextScore).toBe(11842);
    expect(audit.msFromAcceptToNextScore).toBe(5842);
    expect(audit.would12sDelayInterceptScore).toBe(true);
    expect(audit.stateMatchesExpected).toBe(true);
    expect(audit.anomalies).toContain("SUB_15S_SCORE_SNIPE");
    expect(audit.anomalies).toContain("FEED_STALL_AT_PLACEMENT");
    expect(audit.anomalies).toContain("ODDS_IMPROVEMENT_DURING_DELAY");
    expect(audit.anomalies).not.toContain("SCORE_DURING_DELAY_WINDOW");
    expect(audit.anomalies).not.toContain("POSSESSION_FLIP_DURING_DELAY");
    expect(audit.anomalies).not.toContain("MANUAL_ADMIN_INTERVENTION");
  });

  test("resolves PDT vs PST offsets across the Nov 1 transition", () => {
    const pdt = parseGsliveTimestampMs("2026-10-27 12:00:00");
    const pst = parseGsliveTimestampMs("2026-11-03 12:00:00");
    expect(new Date(pdt as number).toISOString()).toBe(
      "2026-10-27T19:00:00.000Z",
    );
    expect(new Date(pst as number).toISOString()).toBe(
      "2026-11-03T20:00:00.000Z",
    );
    expect(parseGsliveTimestampMs("1793163519")).toBe(1793163519000);
    expect(parseGsliveTimestampMs(1793163519000)).toBe(1793163519000);
  });

  test("detects frozen-clock scoring and extended outage on 207059641", () => {
    const fixture206 = JSON.parse(
      readFileSync(
        resolve(import.meta.dir, "fixtures/gslive-event-log-207059641.json"),
        "utf8",
      ),
    ) as { eventLog: unknown; event: { state: string } };
    const ticks = parseEventLog(fixture206.eventLog);
    expect(ticks).toHaveLength(23);
    const audit = auditEventTimeline(
      fixture206.eventLog,
      fixture206.event.state,
    );
    expect(audit.maxFeedGapMs).toBe(120717);
    expect(audit.frozenClockScoreChanges).toBe(3);
    expect(audit.anomalies).toContain("FROZEN_CLOCK_SCORING_OR_PLAY");
    expect(audit.anomalies).toContain("EXTENDED_FEED_OUTAGE");
  });

  test("pre-screens 69-field rows for audit triggers", () => {
    const rows = [
      {
        id: "1",
        eID: "10",
        logTime: "1793761946",
        acceptTime: "1793761952000",
        delay: "6",
        fVal: "2.4",
        fVal_new: "2.5",
        adminUser: null,
        manualLogExists: "0",
        isSuspectedBot: "0",
        reversedCredit: null,
        eventResult: "settled directly",
      },
      {
        id: "2",
        eID: "10",
        logTime: "1793761946",
        acceptTime: "1793761953000",
        delay: "5",
        fVal: "2.4",
        fVal_new: "2.4",
        adminUser: "admin",
        manualLogExists: "1",
        isSuspectedBot: "1",
        reversedCredit: "5",
        eventResult: JSON.stringify({ m: [10, 4] }),
      },
      {
        id: "3",
        eID: "10",
        logTime: "1793761946",
        acceptTime: "1793761952000",
        delay: "6",
        fVal: "2.4",
        fVal_new: "2.4",
        adminUser: null,
        manualLogExists: "0",
        isSuspectedBot: "0",
        reversedCredit: null,
        eventResult: "settled directly",
      },
    ];
    const targets = extractBetLogAuditTargets(rows);
    expect(targets).toHaveLength(2);
    expect(targets[0]?.reasons).toContain("ODDS_DRIFT");
    expect(targets[1]?.reasons).toEqual(
      expect.arrayContaining([
        "DELAY_MISMATCH",
        "ADMIN_USER",
        "MANUAL_LOG",
        "SUSPECTED_BOT",
        "REVERSED_CREDIT",
      ]),
    );
    expect(targets[1]?.placementSnapshotM).toEqual([10, 4]);
  });

  test("flags state mismatch and a score inside the delay window", () => {
    const mismatch = validateAndAuditBetTimeline({
      betId: fixture.betId,
      expectedWagerState: "placed_only",
      betLog: fixture.betLog,
      eventLog: fixture.eventLog,
      eventState: "blocked",
    });
    expect(mismatch.stateMatchesExpected).toBe(false);
    expect(mismatch.anomalies).toContain("WAGER_STATE_MISMATCH");
    expect(mismatch.anomalies).toContain("ACCEPTED_WHILE_BLOCKED");
    const logs = fixture.eventLog as {
      r: { updateTime: string; eventResult: string }[];
    };
    const shifted = structuredClone(logs);
    shifted.r.push({
      updateTime: "1793761949000",
      eventResult: JSON.stringify({
        m: [12, 4],
        p: 2,
        s: [[12, 4]],
        t: 970,
        gp: 1,
        ht: false,
        tu: 1793761949,
        ls_guid: "x",
      }),
    });
    const during = validateAndAuditBetTimeline({
      betId: fixture.betId,
      betLog: fixture.betLog,
      eventLog: shifted,
    });
    expect(during.anomalies).toContain("SCORE_DURING_DELAY_WINDOW");
    expect(during.anomalies).toContain("POSSESSION_FLIP_DURING_DELAY");
  });
});
