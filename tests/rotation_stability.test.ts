import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { rotationInstability } from "../scripts/check_rotation_stability.ts";

/**
 * `Team1ID`/`Team1RotNum` (and the Team2 pair) are the board's team + rotation number. One team
 * with two rotations is either a mis-keyed row or a board reset mid-capture, and any join on the
 * rotation is then wrong.
 *
 * The one-liner this replaced grouped `[undefined, rot]` pairs into one bucket, so a payload whose
 * IDs were absent reported "no instability" — the failure mode the missing-id count exists for.
 */

const row = (
  home: [string | undefined, number | undefined],
  away: [string | undefined, number | undefined],
) => ({
  Team1ID: home[0],
  Team1RotNum: home[1],
  Team2ID: away[0],
  Team2RotNum: away[1],
});

describe("rotationInstability", () => {
  test("a stable payload has no findings", () => {
    const report = rotationInstability({
      Scores: [
        row(["Arizona Cardinals", 243], ["Dallas Cowboys", 244]),
        row(["Arizona Cardinals", 243], ["Detroit Lions", 245]),
      ],
    });
    expect(report.unstable).toEqual([]);
    expect(report.teams).toBe(3);
    expect(report.rows).toBe(2);
    expect(report.missingId).toBe(0);
    expect(report.shapeUnknown).toBe(false);
  });

  test("one team with two rotations is reported, sorted", () => {
    const report = rotationInstability({
      Scores: [
        row(["Team A", 243], ["Team B", 244]),
        row(["Team A", 999], ["Team B", 244]),
      ],
    });
    expect(report.unstable).toEqual([
      { teamId: "Team A", rotations: ["243", "999"] },
    ]);
  });

  test("a missing team id is counted, not grouped under undefined", () => {
    const report = rotationInstability({
      Scores: [
        row([undefined, 100], ["Team B", 101]),
        row([undefined, 200], ["Team B", 101]),
      ],
    });
    expect(report.unstable).toEqual([]);
    expect(report.missingId).toBe(2);
    expect(report.teams).toBe(1);
  });

  test("a payload with none of the fields says so instead of passing", () => {
    const report = rotationInstability({
      Scores: [
        { LogoTeam1: "Boston-Celtics.png", LogoTeam2: "Orlando-Magic.png" },
      ],
    });
    expect(report.shapeUnknown).toBe(true);
    expect(report.teams).toBe(0);
  });

  test("accepts a bare array, a single row and a LIST wrapper", () => {
    expect(rotationInstability([row(["A", 1], ["B", 2])]).rows).toBe(1);
    expect(rotationInstability(row(["A", 1], ["B", 2])).rows).toBe(1);
    expect(rotationInstability({ LIST: [row(["A", 1], ["B", 2])] }).rows).toBe(
      1,
    );
  });

  test("the committed pending sample is stable", async () => {
    const payload: unknown = await Bun.file(
      resolve(import.meta.dir, "f402-pending-wager-sample.json"),
    ).json();
    const report = rotationInstability(payload);
    expect(report.shapeUnknown).toBe(false);
    expect(report.unstable).toEqual([]);
  });
});
