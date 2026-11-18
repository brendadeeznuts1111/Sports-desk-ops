import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WATCH_MAX_AGE_MINUTES,
  evaluateSessionWatch,
  parseWatchTick,
} from "../lib/f402_session_watch.ts";

const NOW = Date.parse("2026-11-17T17:00:00.000Z");
const JOURNAL = "scratch/f402-session-refresh.jsonl";

const tick = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: "f402-session-refresh",
    observedAtMs: NOW,
    reason: "fresh",
    attempted: false,
    ok: true,
    ...overrides,
  });

const input = (mtimeMinutesAgo: number | null, lines: string[]) => ({
  nowMs: NOW,
  journalPath: JOURNAL,
  journalMtimeMs:
    mtimeMinutesAgo === null ? null : NOW - mtimeMinutesAgo * 60_000,
  recentLines: lines,
});

describe("f402 session watch", () => {
  test("a recent healthy tick is ok", () => {
    const verdict = evaluateSessionWatch(input(1, [tick()]));
    expect(verdict.status).toBe("ok");
    expect(verdict.code).toBeNull();
    expect(verdict.ageMinutes).toBe(1);
    expect(verdict.message).toContain(JOURNAL);
  });

  test("the default threshold is 12 minutes", () => {
    expect(DEFAULT_WATCH_MAX_AGE_MINUTES).toBe(12);
  });

  test("a missing journal alerts", () => {
    const verdict = evaluateSessionWatch(input(null, []));
    expect(verdict.status).toBe("alert");
    expect(verdict.code).toBe("journal-missing");
    expect(verdict.ageMinutes).toBeNull();
  });

  test("a stale journal alerts", () => {
    const verdict = evaluateSessionWatch(input(13, [tick()]));
    expect(verdict.code).toBe("journal-stale");
    expect(verdict.message).toContain("older than 12 min");
  });

  test("exactly at the threshold is not stale", () => {
    const verdict = evaluateSessionWatch(input(12, [tick()]));
    expect(verdict.status).toBe("ok");
  });

  test("no readable tick lines alerts", () => {
    const verdict = evaluateSessionWatch(
      input(1, ["not json", JSON.stringify({ kind: "other" })]),
    );
    expect(verdict.code).toBe("journal-unreadable");
  });

  test("a single failed last tick alerts", () => {
    const verdict = evaluateSessionWatch(
      input(1, [
        tick(),
        tick({ ok: false, reason: "expiring-soon", error: "exit-nonzero" }),
      ]),
    );
    expect(verdict.code).toBe("last-failed");
    expect(verdict.lastError).toBe("exit-nonzero");
    expect(verdict.message).toContain("error=exit-nonzero");
  });

  test("two consecutive failures alert as repeated", () => {
    const verdict = evaluateSessionWatch(
      input(1, [
        tick({ ok: false, reason: "expiring-soon", error: "exit-nonzero" }),
        tick({ ok: false, reason: "expiring-soon", error: "exit-nonzero" }),
      ]),
    );
    expect(verdict.code).toBe("repeated-failure");
    expect(verdict.message).toContain("last 2 ticks");
  });

  test("token-window alert lines are ignored", () => {
    const verdict = evaluateSessionWatch(
      input(1, [
        tick(),
        JSON.stringify({ kind: "f402-token-window-alert", windowMin: 19 }),
      ]),
    );
    expect(verdict.status).toBe("ok");
  });

  test("a custom threshold is honored", () => {
    const verdict = evaluateSessionWatch(input(8, [tick()]), {
      maxAgeMinutes: 5,
    });
    expect(verdict.code).toBe("journal-stale");
  });

  test("parseWatchTick ignores malformed and non-tick lines", () => {
    expect(parseWatchTick("not json")).toBeNull();
    expect(
      parseWatchTick(JSON.stringify({ kind: "f402-token-window-alert" })),
    ).toBeNull();
    expect(parseWatchTick(tick({ reason: "fresh", ok: true }))).toEqual({
      reason: "fresh",
      ok: true,
      error: null,
      observedAtMs: NOW,
    });
  });
});
