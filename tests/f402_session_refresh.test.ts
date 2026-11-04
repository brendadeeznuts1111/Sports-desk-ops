/**
 * @file f402_session_refresh.test.ts
 * @description Unit coverage for `lib/f402_session_refresh.ts`: every input a `decideRefresh`
 * call could receive, and the journal-line shape the runner writes. The production bug this
 * guards against is the "session expired 30 min after mint, nothing noticed" outage of
 * 2026-11-04. Each boundary (now == expiry, now == expiry - graceMs, missing session,
 * unparseable expiry) has its own test so a regression in the comparator is a loud test name.
 */

import { describe, expect, test } from "bun:test";

import type { F402Session } from "../lib/f402_session.ts";
import {
  DEFAULT_REFRESH_GRACE_MS,
  DEFAULT_REFRESH_TTL_MINUTES,
  REFRESH_EXIT,
  decideRefresh,
  journalLine,
  type RefreshOutcome,
} from "../lib/f402_session_refresh.ts";

const NOW = Date.parse("2026-11-04T20:00:00.000Z");

function sessionExpiringAt(ms: number): F402Session {
  return {
    cookieHeader: "irrelevant=x",
    cookieNames: ["irrelevant"],
    obtainedAtIso: new Date(ms - 30 * 60 * 1000).toISOString(),
    expiresAtIso: new Date(ms).toISOString(),
  };
}

describe("decideRefresh", () => {
  test("null session → refresh with reason 'missing'", () => {
    const d = decideRefresh(null, NOW);
    expect(d.shouldRefresh).toBe(true);
    expect(d.reason).toBe("missing");
    expect(d.msUntilExpiry).toBeNull();
  });

  test("session with unparseable expiry → refresh with reason 'unparseable-expiry'", () => {
    const session: F402Session = {
      ...sessionExpiringAt(NOW + 60 * 60 * 1000),
      expiresAtIso: "not a date",
    };
    const d = decideRefresh(session, NOW);
    expect(d.shouldRefresh).toBe(true);
    expect(d.reason).toBe("unparseable-expiry");
    expect(d.msUntilExpiry).toBeNull();
  });

  test("expiry == now → expired (<= boundary)", () => {
    const d = decideRefresh(sessionExpiringAt(NOW), NOW);
    expect(d.shouldRefresh).toBe(true);
    expect(d.reason).toBe("expired");
    expect(d.msUntilExpiry).toBe(0);
  });

  test("expiry in the past → expired", () => {
    const d = decideRefresh(sessionExpiringAt(NOW - 1000), NOW);
    expect(d.shouldRefresh).toBe(true);
    expect(d.reason).toBe("expired");
    expect(d.msUntilExpiry).toBe(-1000);
  });

  test("expiry just under grace window → expiring-soon", () => {
    const d = decideRefresh(
      sessionExpiringAt(NOW + DEFAULT_REFRESH_GRACE_MS - 1),
      NOW,
    );
    expect(d.shouldRefresh).toBe(true);
    expect(d.reason).toBe("expiring-soon");
    expect(d.msUntilExpiry).toBe(DEFAULT_REFRESH_GRACE_MS - 1);
  });

  test("expiry exactly at grace boundary → fresh (< not ≤)", () => {
    const d = decideRefresh(
      sessionExpiringAt(NOW + DEFAULT_REFRESH_GRACE_MS),
      NOW,
    );
    expect(d.shouldRefresh).toBe(false);
    expect(d.reason).toBe("fresh");
  });

  test("expiry comfortably in the future → fresh", () => {
    const d = decideRefresh(sessionExpiringAt(NOW + 60 * 60 * 1000), NOW);
    expect(d.shouldRefresh).toBe(false);
    expect(d.reason).toBe("fresh");
    expect(d.msUntilExpiry).toBe(60 * 60 * 1000);
  });

  test("custom grace is honored", () => {
    const customGraceMs = 10 * 60 * 1000;
    const d = decideRefresh(
      sessionExpiringAt(NOW + 7 * 60 * 1000),
      NOW,
      customGraceMs,
    );
    expect(d.shouldRefresh).toBe(true);
    expect(d.reason).toBe("expiring-soon");
  });
});

describe("journalLine", () => {
  test("fresh no-op entry carries no `error`", () => {
    const outcome: RefreshOutcome = {
      observedAtMs: NOW,
      decision: {
        shouldRefresh: false,
        reason: "fresh",
        msUntilExpiry: 1200000,
      },
      attempted: false,
      ok: true,
      mintDurationMs: 0,
    };
    const line = journalLine(outcome);
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed.kind).toBe("f402-session-refresh");
    expect(parsed.reason).toBe("fresh");
    expect(parsed.attempted).toBe(false);
    expect(parsed.ok).toBe(true);
    expect("error" in parsed).toBe(false);
  });

  test("failed refresh carries an `error` classifier (never stderr)", () => {
    const outcome: RefreshOutcome = {
      observedAtMs: NOW,
      decision: {
        shouldRefresh: true,
        reason: "expired",
        msUntilExpiry: -60_000,
      },
      attempted: true,
      ok: false,
      mintDurationMs: 3200,
      error: "exit-nonzero",
    };
    const line = journalLine(outcome);
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("exit-nonzero");
    expect(parsed.mintDurationMs).toBe(3200);
  });

  test("journal line ends with exactly one newline (JSONL contract)", () => {
    const outcome: RefreshOutcome = {
      observedAtMs: NOW,
      decision: { shouldRefresh: false, reason: "fresh", msUntilExpiry: 0 },
      attempted: false,
      ok: true,
      mintDurationMs: 0,
    };
    const line = journalLine(outcome);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  test("journal never leaks a cookie, password, or 'session' field", () => {
    const outcome: RefreshOutcome = {
      observedAtMs: NOW,
      decision: {
        shouldRefresh: true,
        reason: "expiring-soon",
        msUntilExpiry: 60_000,
      },
      attempted: true,
      ok: true,
      mintDurationMs: 2100,
    };
    const parsed = JSON.parse(journalLine(outcome).trim()) as Record<
      string,
      unknown
    >;
    expect("cookieHeader" in parsed).toBe(false);
    expect("password" in parsed).toBe(false);
    expect("session" in parsed).toBe(false);
    expect("value" in parsed).toBe(false);
  });
});

describe("constants", () => {
  test("DEFAULT_REFRESH_GRACE_MS is 5 minutes", () => {
    expect(DEFAULT_REFRESH_GRACE_MS).toBe(5 * 60 * 1000);
  });
  test("DEFAULT_REFRESH_TTL_MINUTES is 24 hours", () => {
    expect(DEFAULT_REFRESH_TTL_MINUTES).toBe(24 * 60);
  });
  test("REFRESH_EXIT codes are distinct and ok === 0", () => {
    const codes = new Set([
      REFRESH_EXIT.ok,
      REFRESH_EXIT.runnerError,
      REFRESH_EXIT.refreshFailed,
    ]);
    expect(codes.size).toBe(3);
    expect(REFRESH_EXIT.ok).toBe(0);
  });
});
