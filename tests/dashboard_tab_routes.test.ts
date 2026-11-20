import { describe, expect, test } from "bun:test";
import {
  isDashboardTab,
  resolveInitialTab,
  tabHref,
} from "../packages/ui/src/tab_routes.ts";

describe("resolveInitialTab", () => {
  test("an explicit tab wins over the path", () => {
    expect(resolveInitialTab("?tab=alerts", "/live-bets")).toBe("alerts");
  });

  test("maps the legacy path names to their React tabs", () => {
    expect(resolveInitialTab("", "/live-bets")).toBe("wagers");
    expect(resolveInitialTab("", "/bet-ticker")).toBe("bet-ticker");
    expect(resolveInitialTab("", "/surveillance")).toBe("surveillance");
    expect(resolveInitialTab("", "/risk-overview")).toBe("surveillance");
    expect(resolveInitialTab("", "/telemetry")).toBe("surveillance");
  });

  test("works under the /app mount", () => {
    expect(resolveInitialTab("", "/app/live-bets")).toBe("wagers");
    // The configured landing view is Risk Overview (surveillance).
    expect(resolveInitialTab("", "/app/")).toBe("surveillance");
  });

  test("an unknown path or invalid tab falls back to the configured default", () => {
    expect(resolveInitialTab("", "/nope")).toBe("surveillance");
    expect(resolveInitialTab("?tab=bogus", "/nope")).toBe("surveillance");
    expect(resolveInitialTab("?tab=bogus", "/live-bets")).toBe("wagers");
  });

  test("only the last segment matters", () => {
    expect(resolveInitialTab("", "/deep/nested/rankings")).toBe("rankings");
  });
});

describe("tabHref", () => {
  test("is relative so it resolves under / and /app/", () => {
    expect(tabHref("wagers")).toBe("?tab=wagers");
    expect(tabHref("bet-ticker")).toBe("?tab=bet-ticker");
  });
});

describe("isDashboardTab", () => {
  test("accepts the union and rejects everything else", () => {
    expect(isDashboardTab("r2")).toBe(true);
    expect(isDashboardTab("customers")).toBe(true);
    expect(isDashboardTab("live-bets")).toBe(false);
    expect(isDashboardTab(null)).toBe(false);
  });
});
