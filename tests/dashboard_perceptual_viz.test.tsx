/**
 * @file tests/dashboard_perceptual_viz.test.tsx
 * @description Staging, conservation, zero-baseline, regime, outlier, label-spacing and contrast
 * oracles for the perceptual dashboard makeover (docs/dashboard-perceptual-makeover.md).
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConservationError,
  DayKeyError,
  InsufficientSeriesError,
  StagingValueError,
  VIZ_CONTEXT_SHARE,
  VIZ_LABEL_MIN_GAP_PX,
  ZeroBaselineError,
  assertConservation,
  assertScaledConservation,
  assertZeroBaseline,
  barScale,
  classifyDayRegime,
  contrastRatio,
  dayKeyInZone,
  deltaE2000,
  isFooterKey,
  isModifiedZOutlier,
  labelsHonourMinGap,
  mixSrgb,
  modifiedZScores,
  parseUsdCents,
  sortDescendingBy,
  spreadLabels,
  stageCentsSeries,
  steadyStateTrend,
  verifyConservation,
  xmrLimits,
  zeroAnchoredDomain,
  type Lab,
} from "../packages/ui/src/viz/perceptual.ts";
import {
  HorizontalBarChart,
  type ChartDatum,
} from "../packages/ui/src/viz/charts.tsx";
import {
  SliceSmallMultiples,
  buildSliceSmallMultiples,
  isActionableHoldOutlier,
} from "../packages/ui/src/viz/SliceSmallMultiples.tsx";
import {
  SharpnessDecomposition,
  buildSharpnessDecomposition,
} from "../packages/ui/src/viz/SharpnessDecomposition.tsx";
import { SliceMetricsViews } from "../packages/ui/src/SliceMetricsViews.tsx";
import { ShadowElasticityChart } from "../packages/ui/src/shadow_pricing/ShadowElasticityChart.tsx";
import { SAMPLE_PROFILE_DATA } from "../packages/ui/src/showcase_data.ts";
import { runShadowPricingDashboard } from "../lib/shadow_pricing_engine.ts";

function seededUniform(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function labOf(hex: string): Lab {
  const formatted = Bun.color(hex, "lab");
  const parts = formatted?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!parts || parts.length !== 3)
    throw new Error(`Bun.color(${hex}, "lab") returned ${formatted}`);
  return [parts[0]!, parts[1]!, parts[2]!];
}

const nflSpread = await runShadowPricingDashboard({
  forceFixture: true,
  sport: "Football",
  subSport: "NFL",
  period: "game",
  market: "spread",
});

describe("staging: parse to integer cents without mutating the source", () => {
  test("REGEXEXTRACT + VALUE analog parses currency text exactly", () => {
    expect(parseUsdCents("a", "$1,234.56")).toBe(123_456);
    expect(parseUsdCents("a", "-$5")).toBe(-500);
    expect(parseUsdCents("a", "$-0.5")).toBe(-50);
    expect(parseUsdCents("a", "  42 ")).toBe(4_200);
    expect(parseUsdCents("a", 0.1 + 0.2)).toBe(30);
    expect(parseUsdCents("a", -0)).toBe(0);
    expect(Object.is(parseUsdCents("a", "-$0"), 0)).toBe(true);
  });

  test("fails loudly with a reason instead of coercing", () => {
    const reasons = (raw: number | string) => {
      try {
        parseUsdCents("k", raw);
        return "accepted";
      } catch (error) {
        expect(error).toBeInstanceOf(StagingValueError);
        return (error as StagingValueError).reason;
      }
    };
    expect(reasons(Number.NaN)).toBe("non-finite");
    expect(reasons(Number.POSITIVE_INFINITY)).toBe("non-finite");
    expect(reasons(1.234)).toBe("sub-unit-precision");
    expect(reasons("1.234")).toBe("unparseable-usd");
    expect(reasons("12,34")).toBe("unparseable-usd");
    expect(reasons("")).toBe("unparseable-usd");
    expect(reasons("--5")).toBe("double-sign");
    expect(reasons(2 ** 60)).toBe("unsafe-integer");
  });

  test("excludes footer/total rows so they are never double counted", () => {
    const rows = [
      { key: "nfl", usd: "$100.00" },
      { key: "nba", usd: 50.25 },
      { key: "Total", usd: "$150.25" },
      { key: "Grand Total", usd: 150.25 },
    ];
    const snapshot = structuredClone(rows);
    const series = stageCentsSeries(rows, {
      key: (row) => row.key,
      value: (row) => row.usd,
    });
    expect(series.stagedTotalCents).toBe(15_025);
    expect(series.excludedFooterKeys).toEqual(["Total", "Grand Total"]);
    expect(rows).toEqual(snapshot);
    expect(Object.isFrozen(series.points)).toBe(true);
    expect(verifyConservation(series, "$150.25")).toEqual({
      ok: true,
      stagedTotalCents: 15_025,
      controlTotalCents: 15_025,
      deltaCents: 0,
    });
    expect(isFooterKey("subtotal")).toBe(true);
    expect(isFooterKey("Σ")).toBe(true);
    expect(isFooterKey("totalizer-slice")).toBe(false);
  });

  test("a footer row the pattern cannot see shows up as a conservation break, not a silent chart", () => {
    const rows = [
      { key: "nfl", usd: 100 },
      { key: "nba", usd: 50 },
      { key: "(all slices)", usd: 150 },
    ];
    const series = stageCentsSeries(rows, {
      key: (row) => row.key,
      value: (row) => row.usd,
    });
    const result = verifyConservation(series, 150);
    expect(result.ok).toBe(false);
    expect(result.deltaCents).toBe(15_000);
    expect(() => assertConservation(series, 150)).toThrow(ConservationError);
  });

  test("duplicate keys are rejected", () => {
    expect(() =>
      stageCentsSeries([{ key: "a" }, { key: "a" }], {
        key: (row) => row.key,
        value: () => 1,
      }),
    ).toThrow(StagingValueError);
  });

  test("fixture slice handle conserves to the blended-hold SLO control total", () => {
    const { rows, blendedHoldSlo } = nflSpread.sliceMetrics;
    const series = stageCentsSeries(rows, {
      key: (row) => row.slice_id,
      value: (row) => row.handle_usd,
    });
    expect(series.points.length).toBe(rows.length);
    expect(verifyConservation(series, blendedHoldSlo.total_handle_usd).ok).toBe(
      true,
    );
  });

  test("seeded property: staged total equals the integer-cent sum for random books", () => {
    const next = seededUniform(0x5d0_2026);
    for (let book = 0; book < 200; book += 1) {
      const size = 1 + Math.floor(next() * 40);
      const cents = Array.from({ length: size }, () =>
        Math.floor((next() - 0.3) * 1e9),
      );
      const rows = cents.map((value, position) => ({
        key: `slice-${position}`,
        usd: value / 100,
      }));
      const series = stageCentsSeries(rows, {
        key: (row) => row.key,
        value: (row) => row.usd,
      });
      expect(series.stagedTotalCents).toBe(
        cents.reduce((acc, value) => acc + value, 0),
      );
    }
  });

  test("scaled conservation for score components in hundredths of a point", () => {
    expect(
      assertScaledConservation(
        [
          { key: "a", value: 0.1 },
          { key: "b", value: 0.2 },
        ],
        0.3,
        100,
        " pts/100",
      ),
    ).toBe(30);
    expect(() =>
      assertScaledConservation(
        [{ key: "a", value: 0.5 }],
        0.9,
        100,
        " pts/100",
      ),
    ).toThrow(ConservationError);
  });
});

describe("zero-baseline integrity", () => {
  test("bar domains always include 0", () => {
    expect(zeroAnchoredDomain([5, 10])).toEqual([0, 10]);
    expect(zeroAnchoredDomain([-3, -1])).toEqual([-3, 0]);
    expect(zeroAnchoredDomain([-3, 7])).toEqual([-3, 7]);
    expect(zeroAnchoredDomain([])).toEqual([0, 1]);
    expect(zeroAnchoredDomain([0, 0])).toEqual([0, 1]);
  });

  test("a domain that excludes 0 or is non-finite fails", () => {
    expect(() => assertZeroBaseline([5, 10])).toThrow(ZeroBaselineError);
    expect(() => assertZeroBaseline([-10, -5])).toThrow(ZeroBaselineError);
    expect(() => assertZeroBaseline([0, 0])).toThrow(ZeroBaselineError);
    expect(() => zeroAnchoredDomain([1, Number.NaN])).toThrow(
      ZeroBaselineError,
    );
    expect(() => assertZeroBaseline([0, 10])).not.toThrow();
  });

  test("seeded property: every bar starts at the zero line and length is proportional to value", () => {
    const next = seededUniform(42);
    for (let trial = 0; trial < 200; trial += 1) {
      const values = Array.from(
        { length: 1 + Math.floor(next() * 12) },
        () => (next() - 0.4) * 1e6,
      );
      const scale = barScale(values, [100, 500]);
      const zeroX = scale.map(0);
      expect(zeroX).toBeGreaterThanOrEqual(100);
      expect(zeroX).toBeLessThanOrEqual(500);
      const perUnit = 400 / (scale.domain[1] - scale.domain[0]);
      for (const value of values) {
        expect(
          Math.abs(
            Math.abs(scale.map(value) - zeroX) - Math.abs(value) * perUnit,
          ),
        ).toBeLessThan(1e-6);
      }
    }
  });

  test("rendered bar rects all touch the zero baseline", () => {
    const data: ChartDatum[] = [
      { key: "a", label: "a", value: 30, valueLabel: "30", accent: false },
      { key: "b", label: "b", value: -10, valueLabel: "-10", accent: true },
      { key: "c", label: "c", value: 5, valueLabel: "5", accent: false },
    ];
    const html = renderToStaticMarkup(
      <HorizontalBarChart title="t" unitNote="u" data={data} />,
    );
    const baseline = /<line x1="([\d.]+)" y1="2" x2="\1"/.exec(html);
    expect(baseline).not.toBeNull();
    const zeroX = Number(baseline![1]);
    const rects = [
      ...html.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g),
    ].map((match) => [Number(match[1]), Number(match[2])] as const);
    expect(rects.length).toBe(3);
    for (const [x, width] of rects) {
      expect(
        Math.abs(x - zeroX) < 1e-9 || Math.abs(x + width - zeroX) < 1e-9,
      ).toBe(true);
    }
    expect(html).not.toContain("legend");
  });
});

describe("regimes: settlement waves and partial days never feed the steady-state trend", () => {
  const today = "2026-11-14";

  test("classification rule", () => {
    expect(classifyDayRegime("2026-11-10", { today })).toBe("settlement");
    expect(classifyDayRegime("2026-11-11", { today })).toBe("steady");
    expect(classifyDayRegime(today, { today })).toBe("partial");
    expect(classifyDayRegime("2026-11-15", { today })).toBe("partial");
    expect(
      classifyDayRegime("2026-11-09", { today, settlementWeekdays: [1] }),
    ).toBe("settlement");
    expect(() => classifyDayRegime("2026-02-30", { today })).toThrow(
      DayKeyError,
    );
    expect(() => classifyDayRegime("11/10/2026", { today })).toThrow(
      DayKeyError,
    );
  });

  test("today is resolved in the desk time zone, not UTC", () => {
    const lateEveningChicago = new Date("2026-11-15T03:30:00Z");
    expect(dayKeyInZone(lateEveningChicago, "America/Chicago")).toBe(
      "2026-11-14",
    );
    expect(dayKeyInZone(lateEveningChicago, "UTC")).toBe("2026-11-15");
  });

  test("trend fit excludes Tuesday spikes and the partial current day", () => {
    const series = [
      { day: "2026-11-05", value: 100 },
      { day: "2026-11-06", value: 102 },
      { day: "2026-11-07", value: 104 },
      { day: "2026-11-08", value: 106 },
      { day: "2026-11-09", value: 108 },
      { day: "2026-11-10", value: 900 },
      { day: "2026-11-11", value: 112 },
      { day: "2026-11-12", value: 114 },
      { day: "2026-11-13", value: 116 },
      { day: "2026-11-14", value: 20 },
    ];
    const trend = steadyStateTrend(series, { today });
    expect(trend.fittedCount).toBe(8);
    expect(trend.slopePerDay).toBeCloseTo(2, 10);
    expect(trend.intercept).toBeCloseTo(100, 10);
    expect(
      trend.points.find((point) => point.day === "2026-11-10")?.regime,
    ).toBe("settlement");
    expect(trend.points.find((point) => point.day === today)?.regime).toBe(
      "partial",
    );
    expect(trend.points.every((point) => !point.outOfControl)).toBe(true);
  });

  test("XmR on detrended residuals flags a steady-day spike but not the excluded regimes", () => {
    const days = [
      "2026-11-02",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
    ];
    const series = days.map((day, position) => ({
      day,
      value: 50 + (position % 2 === 0 ? 1 : -1),
    }));
    series[5] = { day: "2026-11-08", value: 90 };
    const trend = steadyStateTrend(
      [...series, { day: "2026-11-10", value: 400 }, { day: today, value: 1 }],
      { today },
    );
    expect(
      trend.points
        .filter((point) => point.outOfControl)
        .map((point) => point.day),
    ).toEqual(["2026-11-08"]);
    expect(trend.residualLimits.rule).toBe("xmr-2.66");
  });

  test("fewer than two steady points is an error, not a flat line", () => {
    expect(() =>
      steadyStateTrend(
        [
          { day: "2026-11-10", value: 1 },
          { day: "2026-11-14", value: 2 },
        ],
        { today },
      ),
    ).toThrow(InsufficientSeriesError);
  });
});

describe("outlier rules", () => {
  test("XmR natural process limits: mean ± 2.66 × mean moving range", () => {
    const limits = xmrLimits([10, 12, 11, 13, 12]);
    expect(limits.center).toBeCloseTo(11.6, 10);
    expect(limits.movingRangeMean).toBeCloseTo(1.5, 10);
    expect(limits.upper).toBeCloseTo(11.6 + 2.66 * 1.5, 10);
    expect(() => xmrLimits([1])).toThrow(InsufficientSeriesError);
  });

  test("modified z (Iglewicz–Hoaglin) flags |M| > 3.5 only", () => {
    const scores = modifiedZScores([5, 5.1, 4.9, 5.2, 4.8, 30]);
    expect(scores.map(isModifiedZOutlier)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(modifiedZScores([2, 2, 2]).every((score) => score === 0)).toBe(true);
  });

  test("actionable slice = hold below floor, or cross-slice modified-z outlier", () => {
    expect(isActionableHoldOutlier({ floor_delta_pct: -0.01 }, 0)).toBe(true);
    expect(isActionableHoldOutlier({ floor_delta_pct: 1 }, 3.6)).toBe(true);
    expect(isActionableHoldOutlier({ floor_delta_pct: 1 }, 3.5)).toBe(false);
  });

  test("fixture small multiples accent exactly the actionable slices", () => {
    const { rows, blendedHoldSlo } = nflSpread.sliceMetrics;
    const model = buildSliceSmallMultiples(
      rows,
      blendedHoldSlo.total_handle_usd,
    );
    const belowFloor = new Set(
      rows.filter((row) => row.floor_delta_pct < 0).map((row) => row.slice_id),
    );
    for (const datum of model.hold) {
      if (belowFloor.has(datum.key)) expect(datum.accent).toBe(true);
    }
    const handles = model.handle.map((datum) => datum.value);
    expect(handles).toEqual([...handles].sort((left, right) => right - left));
    expect(model.order).toEqual(model.hold.map((datum) => datum.key));
  });
});

describe("direct-label legibility", () => {
  test("spreadLabels keeps a minimum gap and stays in bounds", () => {
    const next = seededUniform(7);
    for (let trial = 0; trial < 300; trial += 1) {
      const desired = Array.from(
        { length: 1 + Math.floor(next() * 6) },
        () => 20 + next() * 160,
      );
      const placed = spreadLabels(desired, VIZ_LABEL_MIN_GAP_PX, [10, 200]);
      expect(labelsHonourMinGap(placed, VIZ_LABEL_MIN_GAP_PX)).toBe(true);
      expect(Math.max(...placed)).toBeLessThanOrEqual(200 + 1e-9);
    }
  });

  test("label order is preserved", () => {
    expect(spreadLabels([50, 51, 52], 13, [0, 500])).toEqual([50, 63, 76]);
    expect(spreadLabels([52, 50], 13, [0, 500])).toEqual([63, 50]);
  });
});

const tokenCss = await Bun.file("src/dashboard/tokens.generated.css").text();

function tokenHex(name: string): string {
  const hex = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`)
    .exec(tokenCss)?.[1]
    ?.toLowerCase();
  if (hex === undefined)
    throw new Error(`${name} missing from tokens.generated.css`);
  return hex;
}

describe('contrast: WCAG ratios and CIEDE2000 via Bun.color(hex, "lab")', () => {
  const background = tokenHex("--sd-surface-card");
  const label = tokenHex("--sd-text-secondary");
  const accent = tokenHex("--sd-tier-steam");

  for (const [variant, border] of [
    ["tokens.generated.css", tokenHex("--sd-border-strong")],
    ["PR #195 border_strong", "#7b8aa1"],
  ] as const) {
    const context = mixSrgb(border, background, VIZ_CONTEXT_SHARE);

    test(`${variant}: graphical objects >= 3:1, text labels >= 4.5:1`, () => {
      expect(contrastRatio(accent, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, context)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(label, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(label, context)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(context, background)).toBeGreaterThanOrEqual(2.5);
    });

    test(`${variant}: CIEDE2000 separation of accent, grey context and background`, () => {
      expect(deltaE2000(labOf(accent), labOf(context))).toBeGreaterThanOrEqual(
        40,
      );
      expect(
        deltaE2000(labOf(accent), labOf(background)),
      ).toBeGreaterThanOrEqual(40);
      expect(
        deltaE2000(labOf(context), labOf(background)),
      ).toBeGreaterThanOrEqual(15);
    });
  }

  test("deltaE2000 matches the Sharma et al. reference pairs", () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(
      2.0425,
      4,
    );
    expect(deltaE2000([50, -1.3802, -84.2814], [50, 0, -82.7485])).toBeCloseTo(
      1.0,
      4,
    );
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
    expect(
      deltaE2000([2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514]),
    ).toBeCloseTo(0.9082, 4);
  });
});

describe("panels fail closed", () => {
  test("SliceMetricsViews renders aligned small multiples when conservation holds", () => {
    const html = renderToStaticMarkup(
      <SliceMetricsViews
        bundle={nflSpread.sliceMetrics}
        routerAuditMode={nflSpread.sliceMetrics.routerAuditMode}
        onChangeRouterAuditMode={() => {}}
      />,
    );
    expect(html).toContain('data-viz="slice-small-multiples"');
    expect(html).toContain("Handle by slice");
    expect(html).toContain("Hold % by slice");
    expect(html).not.toContain('data-fail-closed="true"');
  });

  test("a tampered control total renders a visible error with the delta, never a chart", () => {
    const { rows, blendedHoldSlo } = nflSpread.sliceMetrics;
    const html = renderToStaticMarkup(
      <SliceSmallMultiples
        rows={rows}
        controlTotalHandleUsd={blendedHoldSlo.total_handle_usd + 12.34}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("ConservationError");
    expect(html).toContain("delta -1234¢");
    expect(html).not.toContain("<svg");
  });

  test("sharpness decomposition withholds bars when components do not sum to the score", () => {
    const mismatched = SAMPLE_PROFILE_DATA.find(
      (customer) => customer.id === "RF2003",
    )!;
    const components = [
      { key: "clv", label: "CLV", value: mismatched.clvScore, cap: 3 },
      { key: "skill", label: "Skill", value: mismatched.skillScore, cap: 2.5 },
      {
        key: "sizing",
        label: "Sizing",
        value: mismatched.sizingScore,
        cap: 1.5,
      },
      { key: "sig", label: "Sig", value: mismatched.sigScore, cap: 2 },
      { key: "timing", label: "Timing", value: mismatched.timingScore, cap: 1 },
    ];
    const html = renderToStaticMarkup(
      <SharpnessDecomposition
        components={components}
        score={mismatched.score}
      />,
    );
    expect(html).toContain('data-fail-closed="true"');
    expect(html).toContain("Δ -0.40 pts");
    expect(html).not.toContain("<rect");

    const model = buildSharpnessDecomposition(components, 3.4);
    expect(model.totalPoints).toBe(3.4);
    expect(model.data.map((datum) => datum.value)).toEqual(
      sortDescendingBy(components, (component) => component.value).map(
        (component) => component.value,
      ),
    );
  });

  test("elasticity frontier: direct labels, no legend, one accent, $0 baseline", () => {
    const html = renderToStaticMarkup(
      <ShadowElasticityChart
        points={nflSpread.elasticityFrontier}
        selectedElasticity={0.15}
        breakevenPct={20}
      />,
    );
    expect(html).toContain("Net desk savings");
    expect(html).toContain("Sharp savings");
    expect(html).toContain("Retail net impact");
    expect(html).toContain("$0");
    expect(html.match(/data-accent="true"/g)?.length).toBe(1);
    expect(html).not.toContain("legend");
    expect(html).not.toContain("--sd-route-sharp");
  });
});
