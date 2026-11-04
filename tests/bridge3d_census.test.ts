/**
 * Pins the Bridge 3d Phase-1 census to the committed aggregate record. The census is a gate, not a
 * transcription: recompute from the four graded fixtures through the production parser and fail on
 * drift. Only aggregate counts are asserted; no row or identifier leaves the fixtures.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareGradedCensus,
  computeGradedCensus,
  percentile,
} from "../scripts/bridge3d_census.ts";

const CENSUS = "docs/design/census/2026-11-04.json";
const dir = mkdtempSync(join(tmpdir(), "bridge3d-census-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("graded census derivation", () => {
  const census = computeGradedCensus();

  test("matches the documented 3d aggregate", () => {
    expect(census.files).toBe(4);
    expect(census.rows).toBe(7);
    expect(census.wireFields).toBe(22);
    expect(census.CmaxTickets).toBe(6);
    expect(census.Bmax).toBe(6);
    expect(census.fanout).toEqual({
      p50: 1,
      p95: 1,
      p99: 1,
      p99_9: 1,
      p100: 2,
    });
    expect(census.ticketNumberBits).toBe(31);
    expect(census.wagerSuffixBits).toBe(1);
    expect(census.freePlayFieldPresent).toBe(false);
    expect(census.loginFieldPresent).toBe(false);
  });

  test("nullable fields are the G-row set", () => {
    expect(census.nullableFields).toEqual({
      team1: 2,
      team2: 2,
      line: 2,
      price: 2,
      score: 2,
      league: 2,
      market: 2,
      scheduled: 2,
    });
  });

  test("populations match the design doc", () => {
    expect(census.statusCounts).toEqual({
      Canceled: 1,
      Loss: 1,
      Lost: 1,
      Win: 3,
      Won: 1,
    });
    expect(census.wagerTypeCounts).toEqual({ E: 1, G: 2, M: 1, S: 2, T: 1 });
    expect(census.placedOnCounts).toEqual({
      Desktop: 1,
      Internet: 5,
      Mobile: 1,
    });
  });

  test("the committed census has no drift", () => {
    const committed = JSON.parse(readFileSync(CENSUS, "utf8")) as unknown;
    expect(compareGradedCensus(census, committed)).toEqual([]);
  });

  test("a mutated record reports a field diff", () => {
    const committed = JSON.parse(readFileSync(CENSUS, "utf8")) as {
      streams: Record<string, Record<string, unknown>>;
    };
    committed.streams["3d-f402-graded"]!.Bmax = 999;
    const diffs = compareGradedCensus(census, committed);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("Bmax");
  });

  test("percentiles use floor((n-1)p), so P100 catches the cross-fixture duplicate", () => {
    const sorted = [1, 1, 1, 1, 1, 2];
    expect(percentile(sorted, 0.95)).toBe(1);
    expect(percentile(sorted, 0.999)).toBe(1);
    expect(percentile(sorted, 1)).toBe(2);
  });

  test("a missing fixture directory aborts without partial numbers", () => {
    expect(() => computeGradedCensus(join(dir, "absent"))).toThrow(
      /no graded fixtures/,
    );
  });
});

describe("census:3d:check CLI", () => {
  const script = join(import.meta.dir, "../scripts/bridge3d_census.ts");

  function run(checkPath: string) {
    return Bun.spawnSync({
      cmd: ["bun", "--no-env-file", "run", script, "--check", checkPath],
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("passes against the committed record", () => {
    const result = run(CENSUS);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("census:3d: ok");
  });

  test("fails on a tampered record", () => {
    const tampered = JSON.parse(readFileSync(CENSUS, "utf8")) as {
      streams: Record<string, Record<string, unknown>>;
    };
    tampered.streams["3d-f402-graded"]!.rows = 6;
    const path = join(dir, "tampered-census.json");
    writeFileSync(path, JSON.stringify(tampered));
    const result = run(path);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("DRIFT");
    expect(result.stderr.toString()).toContain("rows");
  });
});
