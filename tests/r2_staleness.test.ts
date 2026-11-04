/**
 * @file r2_staleness.test.ts
 * @description Unit coverage for `lib/r2_staleness.ts`: every state transition in `evaluateProbe`,
 * the `formatAge` boundaries that are easy to get wrong (60s boundary, 60m boundary, 24h
 * boundary), the "all fresh → empty string" rule in `formatReport`, and the HTML escape for
 * Telegram's `parse_mode=HTML`.
 *
 * The library is pure (no fetch, no Date.now, no process state) so the tests are too — every
 * timestamp is passed in explicitly as `nowMs`.
 */

import { describe, expect, test } from "bun:test";

import {
  ALERTER_EXIT,
  BRIDGE_STALENESS_TARGETS,
  buildReport,
  evaluateProbe,
  formatAge,
  formatReport,
  parseLastModified,
  publicUrlFor,
  R2_PUBLIC_BASE,
  type StalenessProbe,
  type StalenessTarget,
} from "../lib/r2_staleness.ts";

const SAMPLE_TARGET: StalenessTarget = {
  key: "f402-bet-ticker/latest.json",
  slaMs: 60 * 60 * 1000,
  label: "bet ticker",
};
const NOW = Date.parse("2026-11-04T20:00:00.000Z");

describe("publicUrlFor", () => {
  test("builds the canonical pub.r2.dev URL", () => {
    expect(publicUrlFor(SAMPLE_TARGET)).toBe(
      `${R2_PUBLIC_BASE}/f402-bet-ticker/latest.json`,
    );
  });
});

describe("parseLastModified", () => {
  test("parses an RFC-7231 header", () => {
    const ms = parseLastModified("Wed, 04 Nov 2026 03:01:51 GMT");
    expect(ms).toBe(Date.parse("2026-11-04T03:01:51Z"));
  });
  test("null → null", () => {
    expect(parseLastModified(null)).toBeNull();
  });
  test("empty → null", () => {
    expect(parseLastModified("")).toBeNull();
  });
  test("garbage → null (never leak NaN)", () => {
    expect(parseLastModified("not a date")).toBeNull();
  });
});

describe("evaluateProbe", () => {
  test("200 + fresh Last-Modified → fresh with ageMs", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: NOW - 10 * 60 * 1000,
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("fresh");
    expect(v.ageMs).toBe(10 * 60 * 1000);
  });

  test("200 + Last-Modified older than SLA → stale", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: NOW - 2 * 60 * 60 * 1000,
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("stale");
    expect(v.ageMs).toBe(2 * 60 * 60 * 1000);
    expect(v.reason).toContain("2h old");
    expect(v.reason).toContain("SLA 1h");
  });

  test("200 + Last-Modified exactly at SLA boundary → fresh (< not ≤)", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: NOW - SAMPLE_TARGET.slaMs,
    };
    expect(evaluateProbe(probe, NOW).state).toBe("fresh");
  });

  test("200 + Last-Modified one ms past SLA → stale", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: NOW - SAMPLE_TARGET.slaMs - 1,
    };
    expect(evaluateProbe(probe, NOW).state).toBe("stale");
  });

  test("200 + null Last-Modified → error (don't silently classify as fresh)", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: null,
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("error");
    expect(v.reason).toMatch(/Last-Modified absent/);
  });

  test("404 → missing (distinct from stale)", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 404,
      lastModifiedMs: null,
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("missing");
    expect(v.reason).toContain("404");
  });

  test("other non-200 → error", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 503,
      lastModifiedMs: null,
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("error");
    expect(v.reason).toContain("HTTP 503");
  });

  test("status 0 (fetch threw) → error with the message", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 0,
      lastModifiedMs: null,
      error: "DNS lookup failed",
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("error");
    expect(v.reason).toContain("DNS lookup failed");
  });

  test("clock skew ≤ 5 min → fresh with age 0", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: NOW + 60 * 1000, // 1 min in the future
    };
    const v = evaluateProbe(probe, NOW);
    expect(v.state).toBe("fresh");
    expect(v.ageMs).toBe(0);
  });

  test("clock skew > 5 min into the future → error", () => {
    const probe: StalenessProbe = {
      target: SAMPLE_TARGET,
      status: 200,
      lastModifiedMs: NOW + 10 * 60 * 1000,
    };
    expect(evaluateProbe(probe, NOW).state).toBe("error");
  });
});

describe("buildReport", () => {
  test("counts stale + missing + error as degraded; fresh as not", () => {
    const freshTarget: StalenessTarget = { ...SAMPLE_TARGET, key: "ok/x.json" };
    const staleTarget: StalenessTarget = {
      ...SAMPLE_TARGET,
      key: "stale/x.json",
    };
    const missingTarget: StalenessTarget = {
      ...SAMPLE_TARGET,
      key: "missing/x.json",
    };
    const errorTarget: StalenessTarget = {
      ...SAMPLE_TARGET,
      key: "error/x.json",
    };
    const probes: StalenessProbe[] = [
      { target: freshTarget, status: 200, lastModifiedMs: NOW - 60_000 },
      {
        target: staleTarget,
        status: 200,
        lastModifiedMs: NOW - 3 * 60 * 60 * 1000,
      },
      { target: missingTarget, status: 404, lastModifiedMs: null },
      { target: errorTarget, status: 500, lastModifiedMs: null },
    ];
    const report = buildReport(probes, NOW);
    expect(report.verdicts).toHaveLength(4);
    expect(report.degradedCount).toBe(3);
    expect(report.observedAtMs).toBe(NOW);
  });
});

describe("formatAge boundaries", () => {
  test("< 60s → seconds", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(59_000)).toBe("59s");
  });
  test("60s → 1m", () => {
    expect(formatAge(60_000)).toBe("1m");
  });
  test("< 60m → minutes", () => {
    expect(formatAge(59 * 60_000)).toBe("59m");
  });
  test("exactly 1h → 1h", () => {
    expect(formatAge(60 * 60_000)).toBe("1h");
  });
  test("1h minutes → 2h13m", () => {
    expect(formatAge((2 * 60 + 13) * 60_000)).toBe("2h13m");
  });
  test("< 24h", () => {
    expect(formatAge(23 * 60 * 60_000)).toBe("23h");
  });
  test(">= 24h → days", () => {
    expect(formatAge(24 * 60 * 60_000)).toBe("1d");
    expect(formatAge((24 + 4) * 60 * 60_000)).toBe("1d4h");
  });
  test("negative / NaN / infinity → ?", () => {
    expect(formatAge(-1)).toBe("?");
    expect(formatAge(Number.NaN)).toBe("?");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("?");
  });
});

describe("formatReport", () => {
  test("all fresh → empty string (runner must not post)", () => {
    const probes: StalenessProbe[] = BRIDGE_STALENESS_TARGETS.map((t) => ({
      target: t,
      status: 200,
      lastModifiedMs: NOW - 60_000,
    }));
    const report = buildReport(probes, NOW);
    expect(formatReport(report)).toBe("");
  });

  test("one stale → message names the stale key, lists fresh ones at bottom", () => {
    const probes: StalenessProbe[] = BRIDGE_STALENESS_TARGETS.map(
      (t, idx): StalenessProbe =>
        idx === 0
          ? {
              target: t,
              status: 200,
              lastModifiedMs: NOW - 10 * 60 * 60 * 1000,
            }
          : { target: t, status: 200, lastModifiedMs: NOW - 60_000 },
    );
    const report = buildReport(probes, NOW);
    const message = formatReport(report);
    expect(message).toContain("<b>R2 staleness alert</b>");
    expect(message).toContain("1 of 4 key(s) degraded");
    expect(message).toContain("f402-bet-ticker/latest.json");
    expect(message).toContain("STALE");
    expect(message).toContain("<i>Fresh:</i>");
    expect(message).toContain("gslive-tally/latest.json");
  });

  test("HTML metachars in the key are escaped", () => {
    const probe: StalenessProbe = {
      target: {
        key: "a<b>&c/latest.json",
        slaMs: 60_000,
        label: "x",
      },
      status: 200,
      lastModifiedMs: NOW - 10 * 60_000,
    };
    const message = formatReport(buildReport([probe], NOW));
    expect(message).toContain("a&lt;b&gt;&amp;c/latest.json");
    expect(message).not.toContain("<b>&c");
  });

  test("message stays under Telegram's 4096 char limit for the v1 set", () => {
    const probes: StalenessProbe[] = BRIDGE_STALENESS_TARGETS.map((t) => ({
      target: t,
      status: 404,
      lastModifiedMs: null,
    }));
    const message = formatReport(buildReport(probes, NOW));
    expect(message.length).toBeLessThan(4096);
  });
});

describe("BRIDGE_STALENESS_TARGETS registry", () => {
  test("every target has a non-empty key, positive SLA, non-empty label", () => {
    for (const t of BRIDGE_STALENESS_TARGETS) {
      expect(t.key.length).toBeGreaterThan(0);
      expect(t.slaMs).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
  test("keys are unique (no accidental duplicates)", () => {
    const keys = BRIDGE_STALENESS_TARGETS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("v1 scope is exactly the four bridge keys", () => {
    expect(BRIDGE_STALENESS_TARGETS.map((t) => t.key)).toEqual([
      "f402-bet-ticker/latest.json",
      "gslive-tally/latest.json",
      "f402-weblog/latest.json",
      "wagers-by-state/latest.json",
    ]);
  });
});

describe("ALERTER_EXIT", () => {
  test("distinct exit codes for allFresh, alerterError, degraded", () => {
    const codes = new Set([
      ALERTER_EXIT.allFresh,
      ALERTER_EXIT.alerterError,
      ALERTER_EXIT.degraded,
    ]);
    expect(codes.size).toBe(3);
    expect(ALERTER_EXIT.allFresh).toBe(0);
  });
});
