import { describe, expect, test } from "bun:test";
import { WAGERS_DEFAULTS } from "../packages/ui/src/config/wagers.ts";
import {
  buildDashboardSearch,
  dashboardUrl,
  DEFAULT_DASHBOARD_URL_STATE,
  readDashboardUrlState,
  writeDashboardUrl,
  type DashboardUrlState,
} from "../packages/ui/src/url_state.ts";

const state = (over: Partial<DashboardUrlState> = {}): DashboardUrlState => ({
  ...DEFAULT_DASHBOARD_URL_STATE,
  ...over,
});

describe("url_state · read", () => {
  test("empty search and root path resolve to defaults", () => {
    expect(readDashboardUrlState("", "/")).toStrictEqual(
      DEFAULT_DASHBOARD_URL_STATE,
    );
  });

  test("reads every owned parameter and validates sort/direction", () => {
    const read = readDashboardUrlState(
      "?tab=wagers&matrix=1&agent=GP301&wSport=NFL&wAlert=HIGH_STAKE&wType=S&wChannel=Internet&wSort=riskUsd&wDir=asc&customer=GP301&ticket=769",
      "/",
    );
    expect(read).toStrictEqual({
      tab: "wagers",
      matrix: true,
      agent: "GP301",
      wSport: "NFL",
      wAlert: "HIGH_STAKE",
      wType: "S",
      wChannel: "Internet",
      wSort: "riskUsd",
      wDir: "asc",
    });

    const fallback = readDashboardUrlState("?wSort=bogus&wDir=sideways", "/");
    expect(fallback.wSort).toBe(WAGERS_DEFAULTS.sort_field);
    expect(fallback.wDir).toBe(WAGERS_DEFAULTS.sort_dir);
  });

  test("path routes still choose the tab, and slice params open shadow", () => {
    expect(readDashboardUrlState("", "/live-bets").tab).toBe("wagers");
    expect(readDashboardUrlState("", "/bet-ticker").tab).toBe("bet-ticker");
    expect(readDashboardUrlState("?sport=NFL", "/").tab).toBe("shadow");
    expect(readDashboardUrlState("", "/", "#wagers").tab).toBe("wagers");
  });
});

describe("url_state · build", () => {
  test("round-trips owned state and preserves unknown parameters", () => {
    const next = state({
      tab: "wagers",
      matrix: true,
      agent: "GP301",
      wSport: "NFL",
      wAlert: "HIGH_STAKE",
      wType: "S",
      wChannel: "Internet",
      wSort: "riskUsd",
      wDir: "desc",
    });
    const search = buildDashboardSearch(
      next,
      "customer=GP301&ticket=769&apiBase=https%3A%2F%2Fexample.test&sport=Football",
      "/",
    );
    const params = new URLSearchParams(search);
    expect(params.get("customer")).toBe("GP301");
    expect(params.get("ticket")).toBe("769");
    expect(params.get("apiBase")).toBe("https://example.test");
    expect(params.get("sport")).toBe("Football");
    expect(readDashboardUrlState(search, "/")).toStrictEqual(next);
  });

  test("removes defaults rather than shipping empty parameters", () => {
    const search = buildDashboardSearch(
      state(),
      "?matrix=1&wSport=NFL&wAlert=HIGH_STAKE&wType=S&wChannel=Internet&wSort=riskUsd&wDir=asc&agent=GP301",
      "/",
    );
    expect(search).toBe("");
  });

  test("omits tab when the path already resolves to it", () => {
    expect(dashboardUrl(state({ tab: "wagers" }), "/live-bets")).toBe(
      "/live-bets",
    );
    expect(dashboardUrl(state({ tab: "customers" }), "/live-bets")).toBe(
      "/live-bets?tab=customers",
    );
    expect(dashboardUrl(state({ tab: "wagers" }), "/")).toBe("/?tab=wagers");
    expect(dashboardUrl(state(), "/")).toBe("/");
  });

  test("wager filters only ship with the wagers tab", () => {
    const search = buildDashboardSearch(
      state({ tab: "bet-ticker", wSport: "NFL", wSort: "riskUsd" }),
      "?wSport=NFL&wSort=riskUsd&wAlert=HIGH_STAKE",
      "/",
    );
    expect(search).toBe("tab=bet-ticker");
    expect(readDashboardUrlState(search, "/").wSport).toBe("ALL");

    const wagers = buildDashboardSearch(
      state({ tab: "wagers", wSport: "NFL", wSort: "riskUsd" }),
      "",
      "/",
    );
    expect(new URLSearchParams(wagers).get("wSport")).toBe("NFL");
    expect(new URLSearchParams(wagers).get("wSort")).toBe("riskUsd");
  });

  test("keeps the hash untouched", () => {
    expect(dashboardUrl(state({ tab: "wagers" }), "/#wagers")).toBe(
      "/?tab=wagers#wagers",
    );
  });
});

describe("url_state · write", () => {
  test("replaces history only when the URL changes", () => {
    const writes: string[] = [];
    const windowLike = {
      location: {
        href: "http://localhost/live-bets",
        pathname: "/live-bets",
        search: "",
        hash: "",
      },
      history: {
        replaceState: (_data: unknown, _unused: string, url: string) => {
          writes.push(url);
        },
      },
    };

    expect(writeDashboardUrl(state({ tab: "wagers" }), windowLike)).toBe(false);
    expect(writes).toStrictEqual([]);

    expect(
      writeDashboardUrl(state({ tab: "wagers", wSport: "NFL" }), windowLike),
    ).toBe(true);
    expect(writes).toStrictEqual(["/live-bets?wSport=NFL"]);
  });

  test("pushes a history entry for tab navigation when asked", () => {
    const pushes: string[] = [];
    const replaces: string[] = [];
    const windowLike = {
      location: {
        href: "http://localhost/live-bets",
        pathname: "/live-bets",
        search: "",
        hash: "",
      },
      history: {
        replaceState: (_data: unknown, _unused: string, url: string) => {
          replaces.push(url);
        },
        pushState: (_data: unknown, _unused: string, url: string) => {
          pushes.push(url);
        },
      },
    };

    expect(
      writeDashboardUrl(state({ tab: "wagers" }), windowLike, { push: true }),
    ).toBe(false);
    expect(pushes).toStrictEqual([]);

    expect(
      writeDashboardUrl(state({ tab: "bet-ticker" }), windowLike, {
        push: true,
      }),
    ).toBe(true);
    expect(pushes).toStrictEqual(["/live-bets?tab=bet-ticker"]);
    expect(replaces).toStrictEqual([]);
  });

  test("is a no-op during SSR", () => {
    expect(writeDashboardUrl(state(), null)).toBe(false);
  });
});
