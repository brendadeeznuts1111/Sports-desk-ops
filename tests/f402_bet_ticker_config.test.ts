import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The bet-ticker configuration, read side and write side.
 *
 * Three traps live in this one pair of calls, all of them silent:
 *  - the write names buckets by their upper bound (`play499`) and the read names them as ranges
 *    (`play1-499`), so a round-trip has to translate;
 *  - an enabled bucket reads `"on "` with a trailing space and a disabled one reads `"off"` without
 *    it, so equality against `"on"` is false for every enabled bucket;
 *  - `AgentID` is padded to 50 characters in the response and unpadded in the request.
 */
const config = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "fixtures/f402-bet-ticker-config-2026-11-01.json"),
    "utf8",
  ),
) as {
  agentPlaceholder: string;
  neverReplay: string;
  write: {
    operation: string;
    path: string;
    mutation: boolean;
    fields: Record<string, string>;
    fieldsNote: string;
  };
  read: {
    operation: string;
    path: string;
    requestFields: Record<string, string>;
    responseEnvelope: string;
    agentIdPaddedLength: number;
    buckets: Array<{
      requestPlay: string;
      requestColor: string;
      responsePlay: string;
      responseColor: string;
      playValue: string;
      color: string;
    }>;
    showFlags: Record<string, string>;
    valuesNote: string;
  };
};

describe("the ticker write is recorded, never replayed", () => {
  test("it is marked a mutation and says so", () => {
    expect(config.write.mutation).toBe(true);
    expect(config.neverReplay).toContain("never calls it");
    expect(config.write.operation).toBe("updateBetTickerConfig");
  });

  test("its form fields cover six play buckets, six colours and five flags", () => {
    const fields = config.write.fields;
    const plays = Object.keys(fields).filter((key) => key.startsWith("play"));
    const colors = Object.keys(fields).filter((key) => key.startsWith("color"));
    const flags = Object.keys(fields).filter((key) => key.startsWith("show"));
    expect(plays).toHaveLength(6);
    expect(colors).toHaveLength(6);
    expect(flags).toEqual([
      "showHorses",
      "showIfbets",
      "showTeasers",
      "showParlays",
      "showStraights",
    ]);
    // The write sends plain "on"/"off"; the whitespace padding appears only on the read side.
    for (const key of plays.concat(flags)) {
      expect(["on", "off"]).toContain(fields[key] ?? "");
    }
  });
});

describe("write fields and read keys name the same buckets differently", () => {
  test("every write field has a range-named read key", () => {
    const fields = config.write.fields;
    for (const bucket of config.read.buckets) {
      expect(fields[bucket.requestPlay]).toBeDefined();
      expect(fields[bucket.requestColor]).toBeDefined();
    }
  });

  test("the write's upper bound is the read range's end", () => {
    for (const bucket of config.read.buckets) {
      const upper = bucket.requestPlay.replace("play", "");
      expect(bucket.responsePlay.endsWith(`-${upper}`)).toBe(true);
      expect(bucket.requestColor).toBe(`color${upper}`);
      expect(bucket.responseColor).toBe(
        `color${bucket.responsePlay.replace("play", "")}`,
      );
    }
  });

  test("six buckets, each starting where the previous one ended", () => {
    // 1-499, 500-999, 1000-1999, 2000-4999, 5000-9999, 10000-100000: contiguous, no gaps.
    const ranges = config.read.buckets.map((bucket) => {
      const [low, high] = bucket.responsePlay.replace("play", "").split("-");
      return [Number(low), Number(high)] as const;
    });
    expect(ranges).toHaveLength(6);
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index]?.[0]).toBe((ranges[index - 1]?.[1] ?? 0) + 1);
    }
  });
});

describe("the values are padded asymmetrically", () => {
  test("an enabled bucket reads 'on ' and a disabled one reads 'off'", () => {
    const values = new Set(
      config.read.buckets.map((bucket) => bucket.playValue),
    );
    expect([...values].sort()).toEqual(["off", "on "].sort());
  });

  test("equality against 'on' fails for every enabled bucket, which is the bug", () => {
    // This is the trap stated as code: the naive check reports "disabled" for everything enabled.
    const enabled = config.read.buckets.filter(
      (bucket) => bucket.playValue === "on",
    );
    expect(enabled).toHaveLength(0);

    const trimmed = config.read.buckets.filter(
      (bucket) => bucket.playValue.trim() === "on",
    );
    expect(trimmed).toHaveLength(4);
  });

  test("'off' compares true, so the bug is one-sided", () => {
    // Only the on-value carries padding, so a naive parser looks half-correct: it reports every
    // bucket as either really off or wrongly off, and never as on.
    const off = config.read.buckets.filter(
      (bucket) => bucket.playValue === "off",
    );
    expect(off).toHaveLength(2);
    expect(config.read.valuesNote).toContain("Trim before comparing");
  });

  test("the show flags are padded the same way", () => {
    for (const value of Object.values(config.read.showFlags)) {
      expect(value).toBe("on ");
      expect(value.trim()).toBe("on");
    }
  });
});

describe("identifiers and envelope", () => {
  test("AgentID is padded to 50 in the response and unpadded in the request", () => {
    expect(config.read.agentIdPaddedLength).toBe(50);
    expect(config.write.fields.agentID).toBe(config.agentPlaceholder);
    expect(config.read.requestFields.agentID).toBe(config.agentPlaceholder);
  });

  test("the response is an INFO object, not the misconfigured INFO:false", () => {
    // The capture-request for this operation asks for the INFO:false shape. This observation is the
    // healthy shape: an object of buckets, flags and colours.
    expect(config.read.responseEnvelope).toBe("INFO");
  });

  test("colours are six-digit hex", () => {
    for (const bucket of config.read.buckets) {
      expect(bucket.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
