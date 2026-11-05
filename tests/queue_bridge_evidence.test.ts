import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  QUEUE_BRIDGE_COVERAGE_KIND,
  QUEUE_BRIDGE_COVERAGE_REL_PATH,
  QUEUE_BRIDGE_STUDY_KIND,
  QUEUE_BRIDGE_STUDY_REL_PATH,
  readQueueBridgeCoverage,
  readQueueBridgeStudy,
} from "../lib/queue_bridge_evidence.ts";
import { makeRoot, writeAt } from "./fixtures/fraud/support.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function root(): string {
  const created = makeRoot();
  roots.push(created);
  return created;
}

function coverage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: QUEUE_BRIDGE_COVERAGE_KIND,
    measuredAt: "2026-11-05T05:50:00.006Z",
    population: "gslive-accounts",
    matched: 102,
    total: 2586,
    ...overrides,
  };
}

function study(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: QUEUE_BRIDGE_STUDY_KIND,
    measuredAt: "2026-11-12T12:00:00.000Z",
    corpusSha: "8afe7684a1b2c3d4",
    covered: { n: 34, precision: 0.71, wilson: [0.54, 0.84] },
    uncovered: { n: 21, precision: 0.62, wilson: [0.41, 0.79] },
    representative: true,
    ...overrides,
  };
}

describe("queue bridge evidence", () => {
  test("reports coverage as matched/total and keeps the measurement time", async () => {
    const dir = root();
    writeAt(dir, QUEUE_BRIDGE_COVERAGE_REL_PATH, coverage());
    const read = await readQueueBridgeCoverage(dir);
    expect(read.present).toBe(true);
    expect(read.reason).toBeNull();
    expect(read.artifact).toMatchObject({
      measuredAt: "2026-11-05T05:50:00.006Z",
      population: "gslive-accounts",
      matched: 102,
      total: 2586,
    });
    expect(read.artifact?.value).toBeCloseTo(102 / 2586, 12);
  });

  test("a missing coverage artifact is named, not reported as zero", async () => {
    const dir = root();
    const read = await readQueueBridgeCoverage(dir);
    expect(read.present).toBe(false);
    expect(read.artifact).toBeNull();
    expect(read.reason).toBe("missing");
  });

  test("rejects a coverage artifact whose matched exceeds total", async () => {
    const dir = root();
    writeAt(dir, QUEUE_BRIDGE_COVERAGE_REL_PATH, coverage({ matched: 3000 }));
    const read = await readQueueBridgeCoverage(dir);
    expect(read.present).toBe(false);
    expect(read.reason).toContain("0 <= matched <= total");
  });

  test("reads representative and precision arms from the study", async () => {
    const dir = root();
    writeAt(dir, QUEUE_BRIDGE_STUDY_REL_PATH, study());
    const read = await readQueueBridgeStudy(dir);
    expect(read.present).toBe(true);
    expect(read.reason).toBeNull();
    expect(read.artifact).toMatchObject({
      corpusSha: "8afe7684a1b2c3d4",
      representative: true,
      covered: { n: 34, precision: 0.71, wilson: [0.54, 0.84] },
      uncovered: { n: 21, precision: 0.62, wilson: [0.41, 0.79] },
    });
  });

  test("a representative:false study with divergent intervals is readable", async () => {
    const dir = root();
    writeAt(
      dir,
      QUEUE_BRIDGE_STUDY_REL_PATH,
      study({
        representative: false,
        covered: { n: 34, precision: 0.9, wilson: [0.75, 0.98] },
        uncovered: { n: 21, precision: 0.2, wilson: [0.08, 0.42] },
      }),
    );
    const read = await readQueueBridgeStudy(dir);
    expect(read.present).toBe(true);
    expect(read.artifact?.representative).toBe(false);
  });

  test("representative:true is rejected when the intervals do not overlap", async () => {
    const dir = root();
    writeAt(
      dir,
      QUEUE_BRIDGE_STUDY_REL_PATH,
      study({
        representative: true,
        covered: { n: 34, precision: 0.9, wilson: [0.75, 0.98] },
        uncovered: { n: 21, precision: 0.2, wilson: [0.08, 0.42] },
      }),
    );
    const read = await readQueueBridgeStudy(dir);
    expect(read.present).toBe(false);
    expect(read.reason).toContain("contradicts the Wilson intervals");
  });

  test("representative:false is rejected when the intervals overlap", async () => {
    const dir = root();
    writeAt(dir, QUEUE_BRIDGE_STUDY_REL_PATH, study({ representative: false }));
    const read = await readQueueBridgeStudy(dir);
    expect(read.present).toBe(false);
    expect(read.reason).toContain("contradicts the Wilson intervals");
  });

  test("rejects an inverted Wilson interval", async () => {
    const dir = root();
    writeAt(
      dir,
      QUEUE_BRIDGE_STUDY_REL_PATH,
      study({
        covered: { n: 34, precision: 0.71, wilson: [0.84, 0.54] },
      }),
    );
    const read = await readQueueBridgeStudy(dir);
    expect(read.present).toBe(false);
    expect(read.reason).toContain("low <= high");
  });

  test("rejects a study without a boolean representative", async () => {
    const dir = root();
    writeAt(dir, QUEUE_BRIDGE_STUDY_REL_PATH, study({ representative: "yes" }));
    const read = await readQueueBridgeStudy(dir);
    expect(read.present).toBe(false);
    expect(read.reason).toContain("representative must be a boolean");
  });
});
