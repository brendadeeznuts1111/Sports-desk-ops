import { afterEach, describe, expect, test } from "bun:test";
// ast-grep-ignore: node-fs-read-write-file -- sync git-fixture writes; Bun.write is async.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBridges,
  censusBridgeValue,
  deriveCitationsSummary,
  deriveFeedSummary,
  deriveRouteSummary,
  deriveTestsCheck,
  graphFingerprint,
  loadDashboardSummary,
  parseJunitSummary,
  readGitRef,
  unmeasuredFeedSummary,
  weblogBridgeValue,
} from "../lib/dashboard_metrics.ts";
import {
  DAEMON_PREFIX_ROUTES,
  DAEMON_ROUTES,
  defineRoute,
} from "../lib/daemon_routes.ts";
import type { DashboardAutomation } from "../lib/dashboard_metrics.ts";

/**
 * The derivation rules behind `/api/graph/summary`, tested without the artifacts.
 *
 * The dashboard's whole point is that a number is either measured or explicitly absent, so the
 * cases that matter are the edges: no junit file (not "0 tests"), a census without the 3c stream,
 * a feed without a `pollEpochMs`, and a weblog rollup whose window is empty. Each expects
 * `not_measured`/`null`, never a plausible-looking zero or a `NaN`.
 */

const NOW = new Date("2026-11-04T12:00:00.000Z");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-metrics-"));
  dirs.push(dir);
  return dir;
}

/** No NaN/Infinity anywhere in a body: `JSON.stringify` would turn them into `null` silently. */
function assertFiniteTree(value: unknown, path = "body"): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} is ${String(value)}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteTree(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertFiniteTree(child, `${path}.${key}`);
    }
  }
}

describe("junit parsing", () => {
  test("reads the root <testsuites> counters", () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="2128" assertions="49691" failures="3" skipped="27" time="11.9">\n  <testsuite tests="9" failures="0" skipped="0" />\n</testsuites>\n';
    expect(parseJunitSummary(xml)).toEqual({
      tests: 2128,
      assertions: 49691,
      failures: 3,
      skipped: 27,
    });
  });

  test("the root tag wins over a later <testsuite>", () => {
    const xml =
      '<testsuites tests="2" failures="0" skipped="0"><testsuite tests="999" failures="1" /></testsuites>';
    expect(parseJunitSummary(xml)?.tests).toBe(2);
  });

  test("a root without a tests counter is not a measurement", () => {
    expect(parseJunitSummary('<testsuites name="bun test" />')).toBeNull();
    expect(parseJunitSummary('<testsuites tests="many" />')).toBeNull();
    expect(parseJunitSummary("<html>nope</html>")).toBeNull();
  });

  test("zero failures/skipped default to 0 when the reporter omits them", () => {
    expect(parseJunitSummary('<testsuites tests="12" />')).toEqual({
      tests: 12,
      assertions: null,
      failures: 0,
      skipped: 0,
    });
  });
});

describe("tests check absence vs zero", () => {
  test("a missing report is not_measured, never 0 tests", () => {
    const check = deriveTestsCheck(null, null, NOW);
    expect(check.status).toBe("not_measured");
    if (check.status === "not_measured") {
      expect(check.reason).toContain("no junit-report.xml");
      expect(check.command).toContain("--reporter junit");
    }
  });

  test("a measured report carries measuredAt and age", () => {
    const measuredAt = new Date("2026-11-04T11:00:00.000Z");
    const check = deriveTestsCheck(
      '<testsuites tests="10" assertions="20" failures="0" skipped="1" />',
      measuredAt,
      NOW,
    );
    expect(check.status).toBe("measured");
    if (check.status === "measured") {
      expect(check.tests).toBe(10);
      expect(check.failures).toBe(0);
      expect(check.skipped).toBe(1);
      expect(check.measuredAt).toBe(measuredAt.toISOString());
      expect(check.ageSeconds).toBe(3600);
      expect(check.stale).toBe(false);
    }
  });
});

describe("route table derivation", () => {
  test("served/exact/prefix and both distributions come from the rows", () => {
    const routes = [
      defineRoute({
        path: "/a",
        method: "GET",
        guard: "none",
        dataClass: "static",
        surface: null,
      }),
      defineRoute({
        path: "/b",
        method: "GET",
        guard: "pii",
        dataClass: "customer-identifying",
        surface: "surface.x",
      }),
    ];
    const prefix = [
      defineRoute({
        path: "/p/*",
        method: "ANY",
        guard: "none",
        dataClass: "static",
        surface: null,
      }),
    ];
    const summary = deriveRouteSummary(routes, prefix);
    expect(summary.served).toBe(3);
    expect(summary.exact).toBe(2);
    expect(summary.prefix).toBe(1);
    expect(summary.guards.none).toBe(2);
    expect(summary.guards.pii).toBe(1);
    expect(summary.guards.admin).toBe(0);
    expect(summary.guards["telegram-secret"]).toBe(0);
    expect(summary.dataClasses["customer-identifying"]).toBe(1);
    expect(summary.catalog).toHaveLength(3);
    expect(summary.catalog[2]?.path).toBe("/p/*");
  });

  test("the committed table derives the served count, not a literal", () => {
    const summary = deriveRouteSummary();
    expect(summary.served).toBe(
      DAEMON_ROUTES.length + DAEMON_PREFIX_ROUTES.length,
    );
    expect(summary.catalog).toHaveLength(summary.served);
  });
});

describe("feed projection", () => {
  test("maps the feed's flat counters to the contract's counts block", () => {
    const feed = {
      schemaVersion: 3,
      lastUpdatedIso: "2026-11-04T11:58:00.000Z",
      lastUpdatedCdt: "11/04/2026, 05:58:00 CST",
      pollEpochMs: Date.parse("2026-11-04T11:58:00.000Z"),
      pollSequence: 7,
      dataMode: "PARTIAL",
      wssIngestion: "not_ingested",
      wsStreamSlaMsFixture: 345,
      activeSyndicateWalletsCount: 23,
      configuredWalletsCount: 39,
      totalOpenLegsCount: 94,
      totalOpenExposureUsd: 64139,
      pendingBets: [1, 2, 3],
      walletProfiles: Array.from({ length: 39 }, () => null),
      perOfficeIpTrackerClusters: Array.from({ length: 13 }, () => null),
      liveTicks: [],
    };
    const summary = deriveFeedSummary(feed, { now: NOW });
    expect(summary.status).toBe("measured");
    expect(summary.ageSeconds).toBe(120);
    expect(summary.stale).toBe(false);
    expect(summary.counts).toEqual({
      activeWallets: 23,
      configuredWallets: 39,
      openLegs: 94,
      openExposureUsd: 64139,
      pendingBets: 3,
      walletProfiles: 39,
      ipClusters: 13,
      liveTicks: 0,
    });
    assertFiniteTree(summary);
  });

  test("an old feed is stale and a missing field is null, not zero", () => {
    const summary = deriveFeedSummary(
      { pollEpochMs: Date.parse("2026-11-04T11:50:00.000Z") },
      { now: NOW },
    );
    expect(summary.ageSeconds).toBe(600);
    expect(summary.stale).toBe(true);
    expect(summary.counts.activeWallets).toBeNull();
    expect(summary.counts.liveTicks).toBeNull();
  });

  test("no publish time leaves age unmeasured and the body finite", () => {
    const summary = deriveFeedSummary({ schemaVersion: 3 }, { now: NOW });
    expect(summary.status).toBe("measured");
    expect(summary.ageSeconds).toBeNull();
    expect(summary.stale).toBe(false);
    assertFiniteTree(summary);
  });

  test("an unreadable feed is an explicit gap", () => {
    const summary = unmeasuredFeedSummary("missing");
    expect(summary.status).toBe("not_measured");
    expect(summary.counts.activeWallets).toBeNull();
    expect(summary.command).toContain("graph_feed_poller_daemon");
  });
});

describe("census bridges", () => {
  const census = {
    censusDate: "2026-11-04",
    streams: {
      "3c-gslive-tally": { rows: 24778, CmaxTickets: 22611 },
    },
  };

  test("reads rows and ticket cardinality from stream 3c", () => {
    expect(censusBridgeValue(census)).toEqual({ legs: 24778, tickets: 22611 });
  });

  test("a missing or malformed stream is null, not zero", () => {
    expect(censusBridgeValue({ streams: {} })).toBeNull();
    expect(
      censusBridgeValue({ streams: { "3c-gslive-tally": { rows: 1 } } }),
    ).toBeNull();
    expect(
      censusBridgeValue({
        streams: { "3c-gslive-tally": { rows: 1, CmaxTickets: "x" } },
      }),
    ).toBeNull();
  });

  test("bridge 1 and 3c share the capture; 3a is an explicit gap", () => {
    const bridges = buildBridges({
      census: {
        source: "docs/design/census/2026-11-04.json",
        asOf: "2026-11-04",
        value: { legs: 24778, tickets: 22611 },
      },
      liveBets: { pendingCount: 2, asOf: "2026-11-01T02:22:35.774Z" },
      weblog: null,
      now: NOW,
    });
    expect(bridges.map((bridge) => bridge.id)).toEqual([
      "bridge-1",
      "bridge-3a",
      "bridge-3b",
      "bridge-3c",
      "weblog",
    ]);
    const bridge1 = bridges.find((bridge) => bridge.id === "bridge-1");
    expect(bridge1?.state).toBe("measured");
    expect(bridge1?.value).toEqual({ legs: 24778, tickets: 22611 });
    expect(bridge1?.basis).toBe("census");
    expect(bridge1?.source).toBe("docs/design/census/2026-11-04.json");

    const bridge3a = bridges.find((bridge) => bridge.id === "bridge-3a");
    expect(bridge3a?.state).toBe("not_measured");
    expect(bridge3a?.value).toBeNull();
    expect(bridge3a?.command).toBe("./bin/dx poll --live-f402");

    const bridge3b = bridges.find((bridge) => bridge.id === "bridge-3b");
    expect(bridge3b?.value).toEqual({ pendingCount: 2 });
    expect(bridge3b?.stale).toBe(true);

    const bridge3c = bridges.find((bridge) => bridge.id === "bridge-3c");
    expect(bridge3c?.value).toEqual(bridge1?.value);
    assertFiniteTree(bridges);
  });

  test("with no artifacts every card is not_measured", () => {
    const bridges = buildBridges({
      census: null,
      liveBets: null,
      weblog: null,
    });
    for (const bridge of bridges) {
      expect(bridge.state).toBe("not_measured");
      expect(bridge.value).toBeNull();
      expect(bridge.reason).toBeString();
      expect(bridge.command).toBeString();
    }
  });
});

describe("weblog bridge", () => {
  const rollup = {
    kind: "f402-weblog",
    window: { fromMs: 1, toMs: Date.parse("2026-11-02T23:59:59.661Z") },
    rows: { total: 523632, parsed: 523632 },
    join: { matched: 52116, totalWindowWagers: 62409 },
    negativeControls: { checked: 7, falsePositiveFlags: 0 },
  };

  test("computes the match percentage the gate arithmetic implies", () => {
    const value = weblogBridgeValue(rollup);
    expect(value).toEqual({
      rows: 523632,
      parsed: 523632,
      matched: 52116,
      windowWagers: 62409,
      matchedPct: 83.5,
      negativeControls: 7,
      falsePositiveFlags: 0,
      executionSnipers: null,
      sniperTwins: null,
      crossOfficeBeards: null,
      botRingAccounts: null,
      lineShoppers: null,
    });
  });

  test("flag populations come from the rollup, absent flags stay null", () => {
    const value = weblogBridgeValue({
      ...rollup,
      flags: {
        executionSnipers: 3462,
        sniperTwins: 98,
        crossOfficeBeards: 1069,
        botRingAccounts: 144,
        lineShoppers: 56407,
      },
    });
    expect(value?.executionSnipers).toBe(3462);
    expect(value?.sniperTwins).toBe(98);
    expect(value?.crossOfficeBeards).toBe(1069);
    expect(value?.botRingAccounts).toBe(144);
    expect(value?.lineShoppers).toBe(56407);
    expect(JSON.stringify(value)).not.toContain("NaN");
  });

  test("an empty window has a null percentage, not NaN", () => {
    const value = weblogBridgeValue({
      rows: { total: 1, parsed: 1 },
      join: { matched: 0, totalWindowWagers: 0 },
    });
    expect(value?.matchedPct).toBeNull();
    expect(JSON.stringify(value)).not.toContain("NaN");
  });

  test("missing counters make the rollup unusable", () => {
    expect(weblogBridgeValue({ rows: { total: 1 } })).toBeNull();
    expect(weblogBridgeValue(null)).toBeNull();
  });

  test("the weblog card reports its source and age", () => {
    const value = weblogBridgeValue(rollup);
    if (value === null) throw new Error("fixture did not parse");
    const bridges = buildBridges({
      census: null,
      liveBets: null,
      weblog: {
        source: "Scratch/weblog/rollup-2026-11-02.json",
        asOf: "2026-11-02T23:59:59.661Z",
        value,
      },
      now: NOW,
    });
    const card = bridges.find((bridge) => bridge.id === "weblog");
    expect(card?.state).toBe("measured");
    expect(card?.source).toBe("Scratch/weblog/rollup-2026-11-02.json");
    expect(card?.ageSeconds).toBe(129600);
    expect(card?.stale).toBe(false);
  });
});

describe("citations", () => {
  const citation = (external: boolean) => ({
    file: "lib/x.ts",
    start: 1,
    end: 1,
    context: "doc",
    external,
  });

  test("checked excludes external citations and anchors is the registry size", () => {
    const summary = deriveCitationsSummary(
      {
        citations: [citation(false), citation(false), citation(true)],
        anchors: new Map([
          ["lib/x.ts:1", "export"],
          ["lib/y.ts:2", "const"],
        ]),
        asOf: NOW,
      },
      NOW,
    );
    expect(summary.status).toBe("measured");
    expect(summary.checked).toBe(2);
    expect(summary.external).toBe(1);
    expect(summary.anchors).toBe(2);
    expect(summary.ageSeconds).toBe(0);
    assertFiniteTree(summary);
  });
});

describe("git head without a subprocess", () => {
  test("reads .git/HEAD and the branch ref", async () => {
    const root = tempRoot();
    const sha = "8e918ae70a201e5c3069a83c438b38d9a0fc8cdb";
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
    await expect(readGitRef(root)).resolves.toEqual({
      head: sha.slice(0, 7),
      branch: "main",
    });
  });

  test("a detached HEAD has a sha and no branch", async () => {
    const root = tempRoot();
    const sha = "8e918ae70a201e5c3069a83c438b38d9a0fc8cdb";
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), `${sha}\n`);
    await expect(readGitRef(root)).resolves.toEqual({
      head: sha.slice(0, 7),
      branch: null,
    });
  });

  test("no .git means null, not a guessed hash", async () => {
    await expect(readGitRef(tempRoot())).resolves.toEqual({
      head: null,
      branch: null,
    });
  });
});

describe("the summary with no artifacts at all", () => {
  test("every unmeasurable section is not_measured and no number is NaN", async () => {
    const root = tempRoot();
    const summary = await loadDashboardSummary({ root, now: NOW });
    expect(summary.success).toBe(true);
    expect(summary.schemaVersion).toBe(1);
    expect(summary.feed.status).toBe("not_measured");
    expect(summary.repo.head).toBeNull();
    expect(summary.repo.branch).toBeNull();
    expect(summary.repo.citations.status).toBe("not_measured");
    expect(summary.repo.checks.tests.status).toBe("not_measured");
    expect(summary.repo.checks.typecheck.status).toBe("not_measured");
    expect(summary.repo.checks.docs.status).toBe("not_measured");
    expect(summary.repo.routes.status).toBe("derived");
    expect(
      summary.bridges.every((bridge) => bridge.state === "not_measured"),
    ).toBe(true);
    assertFiniteTree(summary);
    expect(JSON.stringify(summary)).not.toContain("NaN");
    expect(JSON.stringify(summary)).not.toContain("Infinity");
  });
});

/** A complete automation fixture; the loader must carry it through untouched (except the engine). */
function automationFixture(): DashboardAutomation {
  return {
    wsRelay: {
      status: "connected",
      started: true,
      lastFrameAtIso: "2026-11-04T11:59:30.000Z",
      lastFrameAgeSeconds: 30,
      topics: ["wagers-by-state", "f402-pending"],
      gatewayHost: "gateway.test:8443",
    },
    cron: {
      engine: "Bun.cron",
      total: 2,
      enabled: 1,
      schedules: [
        {
          id: "sched_10m_positions_pulse",
          name: "10-Minute Pulse",
          scheduleTime: "*/10 * * * *",
          enabled: true,
        },
        {
          id: "sched_daily_0800",
          name: "Daily Report",
          scheduleTime: "08:00",
          enabled: false,
        },
      ],
    },
    telegram: {
      mode: "simulation",
      modeReason: "TELEGRAM_BOT_TOKEN is not set",
      tokenConfigured: false,
      defaultChatConfigured: false,
      authorizedChatCount: 0,
      inbound: "none",
      bot: null,
      webhook: null,
      error: null,
    },
  };
}

function writeFeedFixture(root: string, schedulerEngine: string | null): void {
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "graph-live-feed.json"),
    JSON.stringify({
      schemaVersion: 3,
      pollEpochMs: NOW.getTime(),
      ...(schedulerEngine === null ? {} : { schedulerEngine }),
    }),
  );
}

describe("automation section", () => {
  test("the loader carries the service state through", async () => {
    const root = tempRoot();
    writeFeedFixture(root, "Bun.cron('* * * * *') + bun --watch");
    const automation = automationFixture();
    const summary = await loadDashboardSummary({
      root,
      now: NOW,
      automation,
    });
    expect(summary.feed.schedulerEngine).toBe(
      "Bun.cron('* * * * *') + bun --watch",
    );
    // Every field survives; the engine is taken from the feed, not the caller's guess.
    expect(summary.automation).toEqual({
      ...automation,
      cron: {
        ...automation.cron,
        engine: "Bun.cron('* * * * *') + bun --watch",
      },
    });
    assertFiniteTree(summary);
    expect(JSON.stringify(summary)).not.toContain("NaN");
  });

  test("without the option the section is omitted, not zero-filled", async () => {
    const summary = await loadDashboardSummary({ root: tempRoot(), now: NOW });
    expect(summary.automation).toBeUndefined();
    expect("automation" in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('"automation"');
  });

  test("the fingerprint includes caller-supplied automation signals", async () => {
    const root = tempRoot();
    const idle = await graphFingerprint({
      root,
      extra: ["relay:no_token"],
    });
    const connected = await graphFingerprint({
      root,
      extra: ["relay:connected"],
    });
    expect(idle).not.toBe(connected);
    // The file signals are stable for an unchanged tree, so only the extra differs.
    expect(await graphFingerprint({ root, extra: ["relay:connected"] })).toBe(
      connected,
    );
  });

  test("a feed without schedulerEngine falls back to the caller's engine", async () => {
    const root = tempRoot();
    writeFeedFixture(root, null);
    const automation = automationFixture();
    const summary = await loadDashboardSummary({
      root,
      now: NOW,
      automation,
    });
    expect(summary.feed.schedulerEngine).toBeNull();
    expect(summary.automation?.cron.engine).toBe("Bun.cron");
  });
});
