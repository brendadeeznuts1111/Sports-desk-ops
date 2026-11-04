import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
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
