import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  buildReportUrl,
  buildWalletStats,
  buildSidecarUrl,
  deskDayBounds,
  dropUrlParam,
  indexWallets,
  parseHashQuery,
  planGsLiveLinks,
  setUrlParam,
  withWindow,
} from "../docs/assets/gslive-links.js";

const WALLET = {
  f402CustomerId: "MJ102",
  gsLivePlayerReportUrl:
    "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_MJ102&to=2026-11-01T04%3A59%3A59.000Z",
  gsLivePlayerReport7DayUrl:
    "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-25T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_MJ102&to=2026-11-01T04%3A59%3A59.000Z",
  gsLiveBetHistoryUrl:
    "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=1&partnerUserId=MJ102",
};

const DESCRIPTOR = {
  gsLivePlayerId: "player_CHURN_003",
  usersReportDeepLink7Day:
    "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-25T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-11-01T04%3A59%3A59.000Z",
  usersReportDeepLink14Day:
    "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-11-01T04%3A59%3A59.000Z",
  usersReportChurnWindowDeepLink:
    "https://plive.sportswidgets.pro/manager-tools/#/reports/users?bot=true&eventId=&from=2026-10-18T05%3A00%3A00.000Z&partnerId=118&searchBy=player&text=player_CHURN_003&to=2026-10-26T04%3A59%3A59.000Z",
  liveBetHistorySidecarCalcTimeUrl:
    "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=calcTime&t=2",
  liveBetHistorySidecarBetTimeUrl:
    "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?minVolume=0&maxTimeUntilScore=0&from=1793422800&to=1793422800&toTime=86399&dateFilterBy=betTime&t=2",
};

describe("Portal GSLive link hydration", () => {
  test("parses and rewrites hash-fragment query params with encoding", () => {
    const url = WALLET.gsLivePlayerReportUrl;
    expect(parseHashQuery(url).get("text")).toBe("player_MJ102");

    const shifted = setUrlParam(url, "from", "2026-10-20T05:00:00.000Z");
    expect(shifted).toContain("from=2026-10-20T05%3A00%3A00.000Z");
    expect(shifted).not.toContain("from=2026-10-18T05%3A00%3A00.000Z");
    // Key order is preserved: only the value changes.
    expect(shifted).toBe(
      url.replace(
        "2026-10-18T05%3A00%3A00.000Z",
        "2026-10-20T05%3A00%3A00.000Z",
      ),
    );

    expect(
      dropUrlParam(WALLET.gsLiveBetHistoryUrl, "partnerUserId"),
    ).not.toContain("partnerUserId");
    expect(
      withWindow(url, "2026-10-18T05:00:00.000Z", "2026-10-26T04:59:59.000Z"),
    ).toContain("to=2026-10-26T04%3A59%3A59.000Z");
  });

  test("derives today's desk-day bounds from the feed's DST-aware sidecar URL", () => {
    expect(deskDayBounds(DESCRIPTOR)).toEqual({
      fromIso: "2026-10-31T05:00:00.000Z",
      toIso: "2026-11-01T04:59:59.000Z",
    });
    expect(
      deskDayBounds({
        liveBetHistorySidecarCalcTimeUrl:
          "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?from=1793509200&toTime=89999",
      }),
    ).toEqual({
      fromIso: "2026-11-01T05:00:00.000Z",
      toIso: "2026-11-02T05:59:59.000Z",
    });
    expect(deskDayBounds({})).toBeNull();
    expect(
      deskDayBounds({
        liveBetHistorySidecarCalcTimeUrl:
          "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?toTime=86399",
      }),
    ).toBeNull();
    expect(
      deskDayBounds({
        liveBetHistorySidecarCalcTimeUrl:
          "https://plive.sportswidgets.pro/manager-tools/#/events/bet-history?from=1793422800",
      }),
    ).toBeNull();
  });

  test("resolves all four report windows for a tracked wallet", () => {
    const asWallet = { wallet: WALLET, descriptor: DESCRIPTOR, login: "MJ102" };
    expect(buildReportUrl({ ...asWallet, windowKey: "14" })).toBe(
      WALLET.gsLivePlayerReportUrl,
    );
    expect(buildReportUrl({ ...asWallet, windowKey: "7" })).toBe(
      WALLET.gsLivePlayerReport7DayUrl,
    );

    const today = buildReportUrl({ ...asWallet, windowKey: "1" });
    expect(today).toContain("from=2026-10-31T05%3A00%3A00.000Z");
    expect(today).toContain("to=2026-11-01T04%3A59%3A59.000Z");
    expect(today).toContain("text=player_MJ102");

    const churn = buildReportUrl({ ...asWallet, windowKey: "churn" });
    expect(churn).toContain("from=2026-10-18T05%3A00%3A00.000Z");
    expect(churn).toContain("to=2026-10-26T04%3A59%3A59.000Z");
    expect(churn).toContain("text=player_MJ102");
  });

  test("synthesizes an untracked account's links instead of borrowing CHURN_003's", () => {
    const report14 = buildReportUrl({
      descriptor: DESCRIPTOR,
      login: "MJ102",
      windowKey: "14",
    });
    expect(report14).toContain("text=player_MJ102");
    expect(report14).not.toContain("player_CHURN_003");
    expect(report14).toContain("from=2026-10-18T05%3A00%3A00.000Z");

    const report7 = buildReportUrl({
      descriptor: DESCRIPTOR,
      login: "MJ102",
      windowKey: "7",
    });
    expect(report7).toContain("text=player_MJ102");
    expect(report7).toContain("from=2026-10-25T05%3A00%3A00.000Z");

    const churn = buildReportUrl({
      descriptor: DESCRIPTOR,
      login: "MJ102",
      windowKey: "churn",
    });
    expect(churn).toContain("text=player_MJ102");
    expect(churn).toContain("to=2026-10-26T04%3A59%3A59.000Z");

    expect(
      buildReportUrl({
        descriptor: DESCRIPTOR,
        login: "CHURN_003",
        windowKey: "churn",
      }),
    ).toBe(DESCRIPTOR.usersReportChurnWindowDeepLink);
    expect(
      buildReportUrl({
        descriptor: DESCRIPTOR,
        login: "CHURN_003",
        windowKey: "7",
      }),
    ).toBe(DESCRIPTOR.usersReportDeepLink7Day);
    expect(
      buildReportUrl({
        descriptor: DESCRIPTOR,
        login: "CHURN_003",
        windowKey: "1",
      }),
    ).toContain("from=2026-10-31T05%3A00%3A00.000Z");
  });

  test("builds sidecar URLs with a fresh tick and the right player filter", () => {
    const calc = buildSidecarUrl({
      wallet: WALLET,
      descriptor: DESCRIPTOR,
      login: "MJ102",
      dateFilterBy: "calcTime",
      tickEpochMs: 1793470000000,
    });
    expect(calc).toContain("dateFilterBy=calcTime");
    expect(calc).toContain("partnerUserId=MJ102");
    expect(calc).toContain("t=1793470000000");

    const bet = buildSidecarUrl({
      wallet: WALLET,
      descriptor: DESCRIPTOR,
      login: "MJ102",
      dateFilterBy: "betTime",
      tickEpochMs: 1793470000000,
    });
    expect(bet).toContain("dateFilterBy=betTime");
    expect(bet).not.toContain("dateFilterBy=calcTime");

    const global = buildSidecarUrl({
      wallet: WALLET,
      descriptor: DESCRIPTOR,
      login: "",
      dateFilterBy: "betTime",
      tickEpochMs: 1793470000000,
    });
    expect(global).not.toContain("partnerUserId");
    expect(global).toContain("t=1793470000000");

    const descriptorOnly = buildSidecarUrl({
      descriptor: DESCRIPTOR,
      login: "CHURN_003",
      dateFilterBy: "betTime",
      tickEpochMs: 1,
    });
    expect(descriptorOnly).toContain("dateFilterBy=betTime");
    expect(descriptorOnly).toContain("t=1");
    const synthesized = buildSidecarUrl({
      descriptor: DESCRIPTOR,
      login: "MJ102",
      dateFilterBy: "calcTime",
      tickEpochMs: 1,
    });
    expect(synthesized).toContain("partnerUserId=MJ102");
    expect(synthesized).not.toContain("partnerUserId=CHURN_003");
  });

  test("default cache-buster is never the old frozen constant", () => {
    const before = Date.now();
    const url = buildSidecarUrl({
      wallet: WALLET,
      login: "MJ102",
      dateFilterBy: "calcTime",
    });
    const tick = Number(parseHashQuery(url).get("t"));
    expect(tick).toBeGreaterThanOrEqual(before);
    expect(tick).toBeLessThanOrEqual(Date.now() + 1000);
    expect(tick).not.toBe(1793469958152);
  });

  test("plans DOM updates for a mixed page from one feed payload", () => {
    const feed = { walletProfiles: [WALLET], gsLiveSidecar: DESCRIPTOR };
    expect([...indexWallets(feed).keys()]).toEqual(["MJ102"]);

    function anchor(attrs: Record<string, string>) {
      return {
        attrs: { ...attrs },
        getAttribute(key: string) {
          return this.attrs[key] ?? null;
        },
        setAttribute(key: string, value: string) {
          this.attrs[key] = value;
        },
      };
    }

    const report14 = anchor({
      "data-gslive": "report",
      "data-gslive-login": "MJ102",
      "data-gslive-window": "auto",
    });
    const report7 = anchor({
      "data-gslive": "report",
      "data-gslive-login": "MJ102",
      "data-gslive-window": "auto",
    });
    const churnWallet = anchor({
      "data-gslive": "report",
      "data-gslive-login": "MJ102",
      "data-gslive-window": "churn",
    });
    const churnDescriptor = anchor({
      "data-gslive": "report",
      "data-gslive-login": "CHURN_003",
      "data-gslive-window": "churn",
    });
    const today = anchor({
      "data-gslive": "report",
      "data-gslive-login": "MJ102",
      "data-gslive-window": "auto",
    });
    const sidecar = anchor({
      "data-gslive": "sidecar",
      "data-gslive-filter": "betTime",
      "data-gslive-login": "MJ102",
    });
    const globalSidecar = anchor({
      "data-gslive": "sidecar",
      "data-gslive-filter": "betTime",
      "data-gslive-login": "",
    });
    const unknown = anchor({
      "data-gslive": "report",
      "data-gslive-login": "ZZ999",
      "data-gslive-window": "auto",
    });
    const ignored = anchor({ href: "https://example.com" });

    const sevenDayPlan = planGsLiveLinks([report7], {
      feed,
      activeReportWindow: "7",
      tickEpochMs: 1,
    });
    expect(sevenDayPlan[0]?.url).toBe(WALLET.gsLivePlayerReport7DayUrl);

    const todayPlan = planGsLiveLinks([today], {
      feed,
      activeReportWindow: "1",
      tickEpochMs: 1,
    });
    expect(todayPlan[0]?.url).toContain("from=2026-10-31T05%3A00%3A00.000Z");
    expect(todayPlan[0]?.url).toContain("to=2026-11-01T04%3A59%3A59.000Z");

    const plan = planGsLiveLinks(
      [
        report14,
        churnWallet,
        churnDescriptor,
        sidecar,
        globalSidecar,
        unknown,
        ignored,
      ],
      { feed, activeReportWindow: "14", tickEpochMs: 1793470000000 },
    );

    expect(plan.length).toBe(6);
    const byElement = new Map(plan.map((u) => [u.element, u.url]));
    expect(byElement.get(report14)).toBe(WALLET.gsLivePlayerReportUrl);
    expect(byElement.get(churnWallet)).toContain(
      "to=2026-10-26T04%3A59%3A59.000Z",
    );
    expect(byElement.get(churnDescriptor)).toBe(
      DESCRIPTOR.usersReportChurnWindowDeepLink,
    );
    expect(byElement.get(sidecar)).toContain("dateFilterBy=betTime");
    expect(byElement.get(sidecar)).toContain("t=1793470000000");
    expect(byElement.get(globalSidecar)).not.toContain("partnerUserId");
    expect(byElement.get(unknown)).toContain("text=player_ZZ999");
    expect(byElement.get(unknown)).not.toContain("player_CHURN_003");
  });

  test("every GSLive anchor in the shipped portal resolves from one feed", () => {
    const root = path.join(import.meta.dirname, "..");
    const html = fs.readFileSync(path.join(root, "docs", "graph.html"), "utf8");
    const feed = JSON.parse(
      fs.readFileSync(path.join(root, "docs", "graph-live-feed.json"), "utf8"),
    );

    const tags = html.match(/<a\b[^>]*data-gslive="[^"]*"[^>]*>/g) || [];
    const anchors = tags.map((tag) => {
      const attrs: Record<string, string> = {};
      for (const key of [
        "data-gslive",
        "data-gslive-login",
        "data-gslive-filter",
        "data-gslive-window",
      ]) {
        const match = tag.match(new RegExp(`${key}="([^"]*)"`));
        if (match) attrs[key] = match[1]!;
      }
      return {
        attrs,
        getAttribute(key: string) {
          return this.attrs[key] ?? null;
        },
      };
    });

    expect(anchors.length).toBeGreaterThan(200);
    const plan = planGsLiveLinks(anchors, {
      feed,
      activeReportWindow: "14",
      tickEpochMs: 1,
    });
    expect(plan.length).toBe(anchors.length);

    for (const update of plan) {
      if (update.element.attrs["data-gslive"] !== "report") continue;
      const login = (
        update.element.attrs["data-gslive-login"] || ""
      ).toUpperCase();
      expect(update.url).toContain(`text=player_${login}`);
    }
  });

  test("portal HTML marks every GSLive anchor for feed hydration", () => {
    const html = fs.readFileSync(
      path.join(import.meta.dirname, "..", "docs", "graph.html"),
      "utf8",
    );

    const reportHrefs = (
      html.match(/manager-tools\/#\/reports\/users\?/g) || []
    ).length;
    const sidecarHrefs = (
      html.match(/manager-tools\/#\/events\/bet-history\?/g) || []
    ).length;
    expect(reportHrefs).toBeGreaterThan(0);
    expect(sidecarHrefs).toBeGreaterThan(0);
    expect((html.match(/data-gslive="report"/g) || []).length).toBe(
      reportHrefs,
    );
    expect((html.match(/data-gslive="sidecar"/g) || []).length).toBe(
      sidecarHrefs,
    );

    // Static fallbacks must stay on the canonical 7-param contract until hydration rewrites them.
    for (const href of html.match(/manager-tools\/#\/reports\/users\?[^"]+/g) ||
      []) {
      expect(href).toContain("bot=true");
      expect(href).toContain("searchBy=player");
    }

    // The frozen cache-buster must not survive in the shipped HTML.
    expect(html).not.toContain("t=1793469958152");
    expect(html).toContain('type="module" src="./graph.js"');
    expect(html).toContain('data-gslive-window-choice="14"');
    expect(html).toContain("awaiting live feed");

    const graphJs = fs.readFileSync(
      path.join(import.meta.dirname, "..", "docs", "graph.js"),
      "utf8",
    );
    expect(graphJs).toContain("hydrateGsLiveLinks(data)");
    expect(graphJs).toContain('from "./assets/gslive-links.js"');
  });

  test("buildWalletStats maps feed wallets for registry-row hydration", () => {
    const stats = buildWalletStats({
      walletProfiles: [
        {
          f402CustomerId: "mj102",
          openVolumeUsd: 8629,
          openLegsCount: 71,
          openBetsSummary: "Top market (Yes) $625",
          dataSource: "LIVE",
        },
        {
          f402CustomerId: "BAD",
          openVolumeUsd: 1,
          dataSource: "FIXTURE",
          lastError: "invalid address",
        },
      ],
    });
    expect(stats.MJ102).toEqual({
      volumeUsd: 8629,
      legs: 71,
      summary: "Top market (Yes) $625",
      dataSource: "LIVE",
      lastError: null,
    });
    expect(stats.BAD?.dataSource).toBe("FIXTURE");
    expect(stats.BAD?.lastError).toBe("invalid address");
    expect(buildWalletStats(null)).toEqual({});
  });

  test("graph.js hydrates anchors end-to-end with a stubbed DOM", async () => {
    class FakeEl {
      attrs: Record<string, string>;
      classList = {
        add() {},
        remove() {},
        toggle() {},
        contains() {
          return false;
        },
      };
      constructor(attrs: Record<string, string> = {}) {
        this.attrs = { ...attrs };
      }
      getAttribute(key: string) {
        return this.attrs[key] ?? null;
      }
      setAttribute(key: string, value: string) {
        this.attrs[key] = value;
      }
      addEventListener() {}
    }

    const feed = {
      lastUpdatedCdt: "10/31/2026, 13:00:00 CDT",
      lastUpdatedIso: "2026-10-31T18:00:00.000Z",
      pollEpochMs: 1793470000000,
      pollSequence: 7,
      walletProfiles: [WALLET],
      gsLiveSidecar: DESCRIPTOR,
    };

    const report = new FakeEl({
      "data-gslive": "report",
      "data-gslive-login": "MJ102",
      "data-gslive-window": "auto",
    });
    const sidecar = new FakeEl({
      "data-gslive": "sidecar",
      "data-gslive-filter": "betTime",
      "data-gslive-login": "MJ102",
    });
    const globalSidecar = new FakeEl({
      "data-gslive": "sidecar",
      "data-gslive-filter": "calcTime",
      "data-gslive-login": "",
    });
    const chips = ["1", "7", "14", "churn"].map(
      (value) => new FakeEl({ "data-gslive-window-choice": value }),
    );

    const g = globalThis as unknown as Record<string, unknown>;
    const saved = {
      document: g.document,
      fetch: g.fetch,
      setInterval: g.setInterval,
    };
    g.document = {
      querySelectorAll(selector: string) {
        if (selector === "[data-gslive]")
          return [report, sidecar, globalSidecar];
        if (selector === "[data-gslive-window-choice]") return chips;
        return [];
      },
      getElementById() {
        return null;
      },
    };
    g.fetch = async () => ({ ok: true, json: async () => feed });
    g.setInterval = () => 0;

    try {
      await import("../docs/graph.js");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(report.attrs.href).toBe(WALLET.gsLivePlayerReportUrl);
      expect(report.attrs["data-gslive-hydrated"]).toBe("1");
      expect(sidecar.attrs.href).toContain("dateFilterBy=betTime");
      expect(sidecar.attrs.href).toContain("partnerUserId=MJ102");
      expect(sidecar.attrs.href).not.toContain("dateFilterBy=calcTime");
      expect(globalSidecar.attrs.href).not.toContain("partnerUserId");
      expect(globalSidecar.attrs.href).toContain("dateFilterBy=calcTime");
      expect(chips[2]?.attrs["aria-pressed"]).toBe("true");
      expect(chips[0]?.attrs["aria-pressed"]).toBe("false");
    } finally {
      g.document = saved.document;
      g.fetch = saved.fetch;
      g.setInterval = saved.setInterval;
    }
  });
});
