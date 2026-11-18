/**
 * CLV is either measured or unknown — never derived from ticket size.
 *
 * Also pins the provenance badge: a capture is LOCAL (a snapshot is not live), and an old payload
 * gets the STALE suffix from the configured budget.
 */
import { describe, expect, test } from "bun:test";
import {
  projectLiveWagerRow,
  summarizeWagersClv,
} from "../packages/backend/src/wagers.ts";
import {
  formatProvenanceBadge,
  normalizeHydratedWagerRow,
} from "../packages/ui/src/hydration.ts";

const deps = {
  parseShortDesc: () => ({
    legs: [{ game: "A @ B", pick: "Over 1" }],
    isLive: false,
  }),
  sharpCustomerIds: new Set<string>(),
};

describe("projectLiveWagerRow CLV", () => {
  test("a row without an explicit comparison reports null", () => {
    const row = projectLiveWagerRow(
      { WagerNumber: "9", AmountWagered: 5000 },
      0,
      deps as never,
    );
    expect(row.clvCents).toBeNull();
    expect(row.alertTier).not.toBe("STEAM");
  });

  test("an explicit clvCents still drives the tier", () => {
    const row = projectLiveWagerRow(
      { WagerNumber: "10", AmountWagered: 1000, clvCents: 8 },
      1,
      deps as never,
    );
    expect(row.clvCents).toBe(8);
    expect(row.alertTier).toBe("STEAM");
  });
});

describe("normalizeHydratedWagerRow CLV", () => {
  test("keeps unknown as null instead of zero", () => {
    expect(normalizeHydratedWagerRow({ ticketId: "1" }, 0).clvCents).toBeNull();
  });

  test("keeps a measured value", () => {
    expect(
      normalizeHydratedWagerRow({ ticketId: "1", clvCents: 8 }, 0).clvCents,
    ).toBe(8);
  });
});

describe("formatProvenanceBadge", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const provenance = (
    kind: "capture" | "live" | "fixture",
    minutesAgo: number,
  ) => ({
    kind,
    label: kind === "fixture" ? "Synthetic" : "Local Capture",
    sourcePath: "data/live-wagers.json",
    observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  test("a capture is LOCAL, not LIVE", () => {
    expect(formatProvenanceBadge(provenance("capture", 5)).badgeText).toBe(
      "● LOCAL CAPTURE",
    );
    expect(formatProvenanceBadge(provenance("live", 5)).badgeText).toBe(
      "● LIVE CAPTURE",
    );
  });

  test("stale past the budget, opt-in only", () => {
    expect(
      formatProvenanceBadge(provenance("capture", 90), {
        staleAfterMinutes: 30,
        nowMs: now,
      }).badgeText,
    ).toBe("● LOCAL CAPTURE · STALE");
    expect(
      formatProvenanceBadge(provenance("fixture", 90), {
        staleAfterMinutes: 30,
        nowMs: now,
      }).badgeText,
    ).toBe("◐ FIXTURE [not live] · STALE");
    expect(formatProvenanceBadge(provenance("capture", 900)).badgeText).toBe(
      "● LOCAL CAPTURE",
    );
  });
});

describe("customer book CLV separation & summarizeWagersClv", () => {
  test("customerBookLookup attaches customerClvBps without fabricating ticket clvCents", () => {
    const projected = projectLiveWagerRow(
      { WagerNumber: "19", CustomerID: "BGD101", AmountWagered: 5000 },
      0,
      {
        ...deps,
        customerBookLookup: (cid: string) =>
          cid === "BGD101" ? { clvBps: 295, sharpScore: 91.4 } : null,
      } as never,
    );
    expect(projected.clvCents).toBeNull();
    expect(projected.customerClvBps).toBe(295);
    expect(projected.customerSharpScore).toBe(91.4);

    const noTicketRow = projectLiveWagerRow(
      { WagerNumber: "20", CustomerID: "SQ200", AmountWagered: 2000 },
      1,
      {
        ...deps,
        customerBookLookup: (cid: string) =>
          cid === "SQ200" ? { clvBps: -110, sharpScore: 22 } : null,
      } as never,
    );
    const summary = summarizeWagersClv([projected, noTicketRow]);
    expect(summary.ticketClvCount).toBe(0);
    expect(summary.meanTicketClvCents).toBeNull();
    expect(summary.bookMatchedCount).toBe(2);
    expect(summary.positiveCustomerClvCount).toBe(1);
    expect(summary.negativeCustomerClvCount).toBe(1);
    expect(summary.meanCustomerClvBps).toBe(92.5);
    expect(summary.totalPositiveClvRiskUsd).toBe(5000);
    expect(summary.totalNegativeClvRiskUsd).toBe(2000);
  });
});
