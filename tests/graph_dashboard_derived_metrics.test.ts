import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The surveillance dashboard's derived-metric contract.
 *
 * docs/graph.html used to state its own measurements as literals: a commit hash in the
 * banner, "2,706 Tests", "773 files typechecked", "56 daemon routes", "427 citations",
 * "39-Wallet", "9,435 Customers", "$1.17M", bridge row counts, and operator-run dates.
 * Nothing recomputed them, so the page kept claiming yesterday's number as today's.
 *
 * The API side (`/api/graph/summary`, `/api/graph/stream`) and `docs/graph.js` now derive
 * them. This test pins the markup half: the regions that render measurements may not carry
 * a measured value, only an empty hydration target, and the hydration targets named by the
 * contract must exist. Fixture tables (wallet registry, pending tape, backtest sample) are
 * deliberately excluded: they are labelled samples, not measurements.
 */

const ROOT = resolve(import.meta.dir, "..");
const HTML = readFileSync(resolve(ROOT, "docs", "graph.html"), "utf8");
const JS = readFileSync(resolve(ROOT, "docs", "graph.js"), "utf8");

function region(pattern: RegExp, label: string): string {
  const match = HTML.match(pattern);
  expect(match, `${label} region not found in docs/graph.html`).not.toBeNull();
  return match?.[0] ?? "";
}

const KPI = region(
  /<section[^>]*\bid="kpi-strip"[\s\S]*?<\/section>/,
  "KPI strip",
);
const TABS = region(/<nav[^>]*\bid="tab-bar"[\s\S]*?<\/nav>/, "tab bar");
const GATES = region(
  /<table[^>]*\bid="repo-gates-table"[\s\S]*?<\/table>/,
  "repo gates table",
);

/** A count with thousands separators, a date, or a percentage: none belongs in static markup. */
const MEASURED_NUMBER_PATTERNS: readonly [RegExp, string][] = [
  [/\b\d{1,3}(?:,\d{3})+\b/, "thousands-separated count"],
  [/\b\d+(?:\.\d+)?\s?%/, "percentage"],
  [/\b2026-\d{2}-\d{2}\b/, "dated measurement"],
  [/\b[0-9a-f]{7,40}\b(?![^<]*>)/, "commit hash"],
];

describe("docs/graph.html carries no hardcoded measurement in derived regions", () => {
  for (const [pattern, label] of MEASURED_NUMBER_PATTERNS) {
    test(`KPI strip has no ${label}`, () => {
      expect(KPI.match(pattern)?.[0] ?? null).toBeNull();
    });
    test(`tab bar has no ${label}`, () => {
      expect(TABS.match(pattern)?.[0] ?? null).toBeNull();
    });
    test(`repo gates table has no ${label}`, () => {
      expect(GATES.match(pattern)?.[0] ?? null).toBeNull();
    });
  }

  test("the stale literals this contract removed are gone from the page", () => {
    const stale = [
      "ac5824d",
      "8522a04",
      "Phase 6C",
      "773 files",
      "56 daemon routes",
      "427 citations",
      "9/9 verify:docs",
      "9,435",
      "+$1.17M",
      "39-Wallet",
      "14 Cluster",
      "13 Clusters",
      "24,778",
      "22,611",
      "836,848",
      "115,660",
      "523,632",
      "52,116",
      "62,409",
      "2,026",
      "3,462",
      "1,069",
      "deskDate 2026-11-03",
      "reported 2026-11-04",
    ];
    for (const literal of stale) {
      expect(
        HTML.includes(literal),
        `stale literal still in docs/graph.html: ${literal}`,
      ).toBe(false);
    }
  });
});

describe("docs/graph.html exposes the hydration targets the summary API fills", () => {
  const ids = [
    "head-commit",
    "bridge-counts",
    "wss-state",
    "kpi-bridge-1",
    "kpi-bridge-3a",
    "kpi-bridge-3b",
    "kpi-bridge-3c",
    "kpi-weblog",
    "kpi-repo",
    "tab-cluster-count",
    "tab-wallet-count",
    "tab-customers",
    "tab-savings",
    "tab-ip-clusters",
    "gate-tests-value",
    "gate-typecheck-value",
    "gate-routes-value",
    "gate-citations-value",
    "gate-docs-value",
    "data-stream-state",
    // v2: automation, game state, event log, column definitions.
    "automation-panel",
    "auto-overall-state",
    "auto-feed-value",
    "auto-relay-value",
    "auto-cron-value",
    "auto-telegram-value",
    "eventlog-source",
    "game-state-tbody",
    "game-state-refresh",
    "tab-pending-updated",
    // v3: Kalshi signals + GSLive WebLog integration.
    "kalshi-signals-state",
    "kalshi-signals-age",
    "kalshi-config",
    "kalshi-signals-refresh",
    "kalshi-signals-tbody",
    "gslive-weblogs-state",
    "gslive-weblogs-age",
    "gslive-weblogs-tbody",
    // v4: execution (paper) tab.
    "exec-state",
    "exec-kalshi-live",
    "exec-polymarket-live",
    "exec-policy",
    "exec-risk",
    "exec-run",
    "exec-pause",
    "exec-resume",
    "exec-decisions-tbody",
    "exec-fills-tbody",
  ];
  for (const id of ids) {
    test(`#${id} exists`, () => {
      expect(HTML).toContain(`id="${id}"`);
    });
  }

  test("bridge evidence prose is hydrated through data-bridge-metric spans", () => {
    for (const key of [
      "census.rows",
      "census.tickets",
      "census.asOf",
      "weblog.rows",
      "weblog.matched",
      "weblog.executionSnipers",
      "weblog.sniperTwins",
      "weblog.crossOfficeBeards",
      "weblog.botRingAccounts",
      "weblog.falsePositiveFlags",
      "weblog.negativeControls",
    ]) {
      expect(HTML).toContain(`data-bridge-metric="${key}"`);
    }
  });
});

describe("docs/graph.js consumes the stream instead of shipping stale fallbacks", () => {
  test("talks to /api/graph/summary and /api/graph/stream", () => {
    expect(JS).toContain("/api/graph/summary");
    expect(JS).toContain("/api/graph/stream");
    expect(JS).toContain("text/event-stream");
  });

  test("hydrates metrics from the summary and keeps the feed poll as fallback", () => {
    expect(JS).toContain("hydrateDashboardSummary");
    expect(JS).toContain("connectDashboardStream");
    expect(JS).toContain("graph-live-feed.json");
  });

  test("no stale numeric fallbacks remain", () => {
    expect(JS).not.toContain("?? 39");
    expect(JS).not.toContain("?? 222");
  });

  test("every table column carries a definition and the game-state tab is wired", () => {
    expect(HTML).toContain('data-ops-target="OPS_GAMES"');
    expect(HTML).toContain('data-ops-panel="OPS_GAMES"');
    expect(JS).toContain("COLUMN_HELP");
    expect(JS).toContain("/api/live-bets");
    expect(JS).toContain("loadGameState");
    expect(HTML).toContain(".col-help");
    // The summary is the only source for automation; a missing block must not crash hydration.
    expect(JS).toContain("hydrateAutomation");
  });

  test("Kalshi signals are read through the daemon, never from the page", () => {
    expect(HTML).toContain('data-tab-target="TAB_KALSHI_SIGNALS"');
    expect(HTML).toContain('data-tab-panel="TAB_KALSHI_SIGNALS"');
    expect(HTML).toContain("Read-only signals");
    expect(JS).toContain("/api/signals/kalshi");
    expect(JS).toContain("loadKalshiSignals");
    // The page must not call Kalshi directly: that is the daemon's read-only proxy.
    expect(JS).not.toContain("elections.kalshi.com");
    expect(JS).not.toContain("api.kalshi");
  });

  test("GSLive WebLog activity is hydrated from its own guarded endpoint", () => {
    expect(JS).toContain("/api/gslive/weblogs");
    expect(JS).toContain("loadGsliveWeblogs");
    expect(HTML).toContain('id="gslive-weblogs-tbody"');
    expect(JS).toContain("gslive:weblogs:refresh");
  });

  test("execution planning is paper-first and reaches venues only through the daemon", () => {
    expect(HTML).toContain('data-tab-target="TAB_EXECUTION"');
    expect(HTML).toContain('data-tab-panel="TAB_EXECUTION"');
    expect(HTML).toContain("Paper execution by default");
    expect(JS).toContain("/api/execution/plan");
    expect(JS).toContain("/api/execution/run");
    expect(JS).toContain("/api/execution/mode");
    expect(JS).toContain("loadExecutionPlan");
    expect(JS).toContain("PLACE LIVE ORDERS");
    // Live orders are only ever sent by the daemon adapter, never from the page.
    expect(JS).not.toContain("gamma-api.polymarket.com");
    expect(JS).not.toContain("clob.polymarket.com");
  });
});
