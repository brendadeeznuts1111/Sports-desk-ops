import { describe, expect, test } from "bun:test";
import {
  alertAuditJson,
  alertMatchesQuery,
  countAlerts,
  formatAlertAuditJsonl,
  toAlertAuditLine,
} from "../packages/ui/src/alert_audit.ts";
import type { DashboardAlertRecord } from "../packages/ui/src/types.ts";

const DEAD: DashboardAlertRecord = {
  deliveryId: "dead-uuid-12345678",
  wagerId: "W-109281",
  tier: "CRITICAL",
  status: "dead",
  payload: {
    customerId: "GP301",
    sport: "NFL",
    event: "Kansas City Chiefs @ Buffalo Bills",
    selection: "KC Chiefs -3.5",
    oddsAmerican: "-110",
    amountUsd: 5500,
    clvCents: 14.2,
    directive: "Clamp Max $250",
  },
  createdAt: "2026-11-12T12:00:00Z",
  updatedAt: "2026-11-12T12:01:00Z",
  attempts: 5,
  finalError: "429 Too Many Requests",
  retriedFrom: "orig-uuid-00000001",
};

const DELIVERED: DashboardAlertRecord = {
  deliveryId: "sent-uuid-87654321",
  wagerId: "",
  tier: "STEAM",
  status: "delivered",
  payload: { customerId: "BRT106", amountUsd: 2500 },
  createdAt: "2026-11-12T13:00:00Z",
  updatedAt: "2026-11-12T13:00:05Z",
  attempts: 1,
  messageId: 4477,
};

describe("alert_audit · projection", () => {
  test("normalizes missing payload fields to null with a stable key order", () => {
    const line = toAlertAuditLine(DELIVERED);
    expect(Object.keys(line)).toEqual([
      "deliveryId",
      "status",
      "tier",
      "wagerId",
      "customerId",
      "amountUsd",
      "clvCents",
      "sport",
      "event",
      "selection",
      "oddsAmerican",
      "directive",
      "attempts",
      "messageId",
      "finalError",
      "retriedFrom",
      "acknowledgedBy",
      "acknowledgedNotes",
      "createdAt",
      "updatedAt",
    ]);
    expect(line.event).toBeNull();
    expect(line.messageId).toBe(4477);
    expect(line.finalError).toBeNull();
  });

  test("one JSON line per visible alert with exact fields", () => {
    const json = alertAuditJson(DEAD);
    expect(json).toContain('"deliveryId":"dead-uuid-12345678"');
    expect(json).toContain('"amountUsd":5500');
    expect(json).toContain('"clvCents":14.2');
    expect(json).toContain('"finalError":"429 Too Many Requests"');
    expect(json).toContain('"retriedFrom":"orig-uuid-00000001"');
    expect(json.includes("\n")).toBe(false);
  });

  test("JSONL has one line per alert plus a trailing newline", () => {
    const jsonl = formatAlertAuditJsonl([DEAD, DELIVERED]);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).deliveryId).toBe("dead-uuid-12345678");
    expect(JSON.parse(lines[1]!).deliveryId).toBe("sent-uuid-87654321");
    expect(jsonl.endsWith("\n")).toBe(true);
  });

  test("an empty stream is an empty string, not a blank line", () => {
    expect(formatAlertAuditJsonl([])).toBe("");
  });
});

describe("alert_audit · search", () => {
  test("matches the identifiers an operator has at hand", () => {
    for (const query of [
      "dead-uuid",
      "W-109281",
      "gp301",
      "critical",
      "429",
      "buffalo",
      "kc chiefs",
      "-110",
      "5500",
      "14.2",
      "orig-uuid",
    ]) {
      expect(alertMatchesQuery(DEAD, query)).toBe(true);
    }
  });

  test("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(alertMatchesQuery(DEAD, "  DEAD-UUID  ")).toBe(true);
  });

  test("an empty query matches everything", () => {
    expect(alertMatchesQuery(DEAD, "")).toBe(true);
    expect(alertMatchesQuery(DEAD, "   ")).toBe(true);
  });

  test("returns false for a miss", () => {
    expect(alertMatchesQuery(DEAD, "no-such-alert")).toBe(false);
  });
});

describe("alert_audit · counts", () => {
  test("counts each status for the visible rows", () => {
    expect(countAlerts([DEAD, DELIVERED])).toEqual({
      total: 2,
      dead: 1,
      queued: 0,
      delivered: 1,
      acknowledged: 0,
    });
    expect(countAlerts([])).toEqual({
      total: 0,
      dead: 0,
      queued: 0,
      delivered: 0,
      acknowledged: 0,
    });
  });
});
