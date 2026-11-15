/**
 * @file tests/ppm_live_feed.test.ts
 * @description Contract tests for the PPM `/live/allEvents` parser, driven by a
 * crop of a real snapshot (17 fixtures across 4 sports, captured 2026-11-12).
 */
import { describe, expect, test } from "bun:test";
import { PpmFeedError, parsePpmAllEvents } from "../lib/ppm_live_feed.ts";

const CROP = new URL("./fixtures/ppm/all-events.crop.json", import.meta.url);
const RAW: unknown = await Bun.file(CROP).json();

function team(name: string, teamId: number): unknown[] {
  return [name, "", "", teamId, "", "", ""];
}

function payload(events: Record<string, unknown>): unknown {
  return { s: { 1: { 4: events } } };
}

describe("parsePpmAllEvents on a real snapshot crop", () => {
  const snapshot = parsePpmAllEvents(RAW);

  test("flattens sport → league → fixture → betting event", () => {
    expect(snapshot.fixtures.length).toBeGreaterThan(0);
    expect(snapshot.counts.fixtures).toBe(snapshot.fixtures.length);
    expect(snapshot.counts.sports).toBe(snapshot.sportIds.length);
    expect(snapshot.counts.leagues).toBe(snapshot.leagues.length);
  });

  test("maps a known fixture to the desk fields", () => {
    const fixture = snapshot.fixtures.find((f) => f.eventId === 185442391);
    expect(fixture).toBeDefined();
    expect(fixture!.slateId).toBe(9430);
    expect(fixture!.sportId).toBe(1);
    expect(fixture!.leagueId).toBe(4);
    expect(fixture!.home).toEqual({ name: "Great Britain", teamId: 3434274 });
    expect(fixture!.away).toEqual({ name: "China", teamId: 3434273 });
    expect(fixture!.startTimeUnix).toBe(1795669200);
  });

  test("every fixture carries a usable team name and a positive team id", () => {
    for (const fixture of snapshot.fixtures) {
      expect(fixture.home.name.length).toBeGreaterThan(0);
      expect(fixture.away.name.length).toBeGreaterThan(0);
      expect(fixture.home.teamId).toBeGreaterThan(0);
      expect(fixture.away.teamId).toBeGreaterThan(0);
      expect(fixture.startTimeUnix).toBeGreaterThan(0);
    }
  });

  test("is ordered by start time, then event id", () => {
    for (let i = 1; i < snapshot.fixtures.length; i += 1) {
      const prev = snapshot.fixtures[i - 1]!;
      const next = snapshot.fixtures[i]!;
      const ordered =
        prev.startTimeUnix < next.startTimeUnix ||
        (prev.startTimeUnix === next.startTimeUnix &&
          prev.eventId <= next.eventId);
      expect(ordered).toBe(true);
    }
  });

  test("sport ids are unique and a league is always (sportId, leagueId)", () => {
    expect(new Set(snapshot.sportIds).size).toBe(snapshot.sportIds.length);
    const leagueKeys = snapshot.leagues.map(
      (league) => `${league.sportId}:${league.leagueId}`,
    );
    expect(new Set(leagueKeys).size).toBe(leagueKeys.length);
    // The crop repeats league id 4 under more than one sport: keying leagues by
    // id alone would merge unrelated competitions.
    expect(snapshot.leagues.length).toBeGreaterThan(
      new Set(snapshot.leagues.map((league) => league.leagueId)).size,
    );
  });
});

describe("rejections", () => {
  test("a payload without the s dimension is rejected", () => {
    expect(() => parsePpmAllEvents(null)).toThrow(PpmFeedError);
    expect(() => parsePpmAllEvents({})).toThrow(PpmFeedError);
    expect(() => parsePpmAllEvents({ s: null })).toThrow(PpmFeedError);
  });

  test("non-numeric dimension keys are rejected", () => {
    expect(() => parsePpmAllEvents({ s: { abc: {} } })).toThrow(
      /sportId key is not numeric/,
    );
  });

  test("a placeholder team row is reported as unresolved, not thrown", () => {
    // fixture 9 holds betting event 9001 (placeholder teams);
    // fixture 10 holds betting event 9002 (resolved).
    const live = payload({
      9: { 9001: [[""], [""], 1_700_000_000] },
      10: { 9002: [["A", "", "", 1], ["B", "", "", 2], 1_700_000_100] },
    });
    const snapshot = parsePpmAllEvents(live);
    expect(snapshot.counts.fixtures).toBe(1);
    expect(snapshot.counts.unresolved).toBe(1);
    expect(snapshot.unresolved[0]).toEqual({
      sportId: 1,
      leagueId: 4,
      eventId: 9001,
      reason: "missing_team_name",
    });
  });

  test("a missing start time is rejected with invalid_fixture", () => {
    const bad = payload({
      7: { 9: [team("A", 1), team("B", 2), 0] },
    });
    try {
      parsePpmAllEvents(bad);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as PpmFeedError).code).toBe("invalid_fixture");
    }
  });

  test("a non-numeric betting event key is rejected", () => {
    const bad = payload({
      7: { notAnId: [team("A", 1), team("B", 2), 1_700_000_000] },
    });
    expect(() => parsePpmAllEvents(bad)).toThrow(/eventId key is not numeric/);
  });
});
