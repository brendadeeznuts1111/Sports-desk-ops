/**
 * The API surface the dashboard calls: named routes → one `URL`-built string, and the headers
 * that go with each verb. The daemon path for `/health` is pinned because the config previously
 * advertised `/api/health`, which the server answers with 404.
 */
import { describe, expect, test } from "bun:test";

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfTokenFromCookie,
  deskRequestHeaders,
} from "../packages/ui/src/api_request.ts";
import {
  DESK_API_EXTRA_ROUTES,
  DESK_API_ROUTES,
  deskApiPath,
  deskApiUrl,
} from "../packages/ui/src/api_routes.ts";
import {
  CSRF_COOKIE_NAME as SERVER_COOKIE,
  CSRF_HEADER_NAME as SERVER_HEADER,
} from "../lib/csrf.ts";

describe("deskApiPath", () => {
  test("resolves a declared name and passes an explicit path through", () => {
    expect(deskApiPath("wagers")).toBe("/api/wagers");
    expect(deskApiPath("betTicker")).toBe("/api/bet-ticker");
    expect(deskApiPath("/api/v2/live-bets")).toBe("/api/v2/live-bets");
  });

  test("health is the daemon's /health, not /api/health", () => {
    expect(DESK_API_ROUTES.health).toBe("/health");
  });
});

describe("deskApiUrl", () => {
  test("stays same-origin relative when no base is configured", () => {
    expect(deskApiUrl("wagers")).toBe("/api/wagers");
  });

  test("resolves against an explicit origin", () => {
    expect(deskApiUrl("wagers", { base: "http://127.0.0.1:4021" })).toBe(
      "http://127.0.0.1:4021/api/wagers",
    );
  });

  test("encodes params exactly once", () => {
    const url = deskApiUrl(DESK_API_EXTRA_ROUTES.customerProfile, {
      params: { id: "a b&c" },
    });
    expect(url).toBe("/api/customer/profile?id=a+b%26c");
    const roundTrip = new URLSearchParams(url.split("?")[1] ?? "").get("id");
    expect(roundTrip).toBe("a b&c");
  });

  test("drops null, undefined and empty params instead of writing them", () => {
    const url = deskApiUrl(DESK_API_EXTRA_ROUTES.liveBetsV2, {
      params: { source: "file", fallback: null, unused: undefined, blank: "" },
    });
    expect(url).toBe("/api/v2/live-bets?source=file");
  });

  test("keeps a query already present on the route", () => {
    const url = deskApiUrl("/api/r2/pipeline?window=7d", {
      params: { window: "30d" },
    });
    expect(url).toBe("/api/r2/pipeline?window=30d");
  });
});

describe("deskRequestHeaders", () => {
  test("reads send no headers, so trackedFetch can still coalesce them", () => {
    expect(deskRequestHeaders("GET", "sd_csrf=tok")).toEqual({});
    expect(deskRequestHeaders(undefined, "sd_csrf=tok")).toEqual({});
    expect(deskRequestHeaders("HEAD", "sd_csrf=tok")).toEqual({});
  });

  test("mutating verbs declare JSON and carry the CSRF token", () => {
    expect(deskRequestHeaders("POST", "sd_csrf=tok")).toEqual({
      "Content-Type": "application/json",
      [CSRF_HEADER_NAME]: "tok",
    });
  });

  test("a missing cookie still declares JSON, just without a token", () => {
    expect(deskRequestHeaders("POST", "")).toEqual({
      "Content-Type": "application/json",
    });
  });

  test("finds the token among other cookies and decodes it", () => {
    const cookie = "sd_session=abc; sd_csrf=a%2Bb%2Fc; theme=dark";
    expect(csrfTokenFromCookie(cookie)).toBe("a+b/c");
    expect(csrfTokenFromCookie("theme=dark")).toBe("");
  });
});

describe("the UI copy of the CSRF contract", () => {
  test("matches lib/csrf.ts, which cannot be bundled for the browser", () => {
    expect(CSRF_COOKIE_NAME).toBe(SERVER_COOKIE);
    expect(CSRF_HEADER_NAME).toBe(SERVER_HEADER);
  });
});
