import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { buildAuthenticateCustomerBody } from "../../lib/f402_browser_token_manager.ts";
import {
  CONFIG,
  apiCall,
  bootstrapSession,
  login,
  resetAuthState,
  routeAfterLogin,
  stopTimers,
  withQuery,
} from "../../client/auth/auth.js";

// ---------- environment stubs ----------

type FetchInit = {
  method?: string;
  credentials?: string;
  signal?: unknown;
  headers: Record<string, string>;
  body?: string;
};
type Call = { url: string; init: FetchInit };

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: unknown) => map.set(k, String(v)),
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
    keys: () => Array.from(map.keys()),
    map,
  };
}

const store = memoryStorage();
const locationStub = { host: "www.example.test", search: "", href: "/start" };

Object.defineProperty(globalThis, "sessionStorage", {
  value: store,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "location", {
  value: locationStub,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Macintosh)" },
  configurable: true,
  writable: true,
});

let calls: Call[] = [];
function mockFetch(
  handler: (url: string, init: FetchInit) => Response | Promise<Response>,
) {
  calls = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init: FetchInit = { headers: {} },
  ) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const bodyOf = (call: Call) => JSON.parse(call.init.body ?? "{}");
const lastCall = (): Call => calls[calls.length - 1]!;

const account = (over: Record<string, unknown> = {}) => ({
  customerID: "CCC107",
  AgentType: null,
  AgentID: 0,
  Office: "SHOP",
  Language: "EN US",
  DefaultSiteSkin: "Gotham",
  EncryptPassword: "N",
  ...over,
});

function authResponse(over = {}, accountOver = {}) {
  return json({ code: "tok_1", accountInfo: account(accountOver), ...over });
}

beforeEach(() => {
  store.clear();
  locationStub.href = "/start";
  locationStub.search = "";
  calls = [];
  resetAuthState();
  CONFIG.IDLE_MS = 30 * 60 * 1000;
  CONFIG.IDLE_CHECK_MS = 60 * 1000;
  CONFIG.onUnknownAgentSkin = null;
  CONFIG.UPPERCASE_PASSWORD = true;
  delete (globalThis as unknown as Record<string, unknown>).window;
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Macintosh)" },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  stopTimers();
});

// These tests own three globals; restore them so a serial `bun test` run is not poisoned
// for every file that runs after this one.
const ORIGINAL_GLOBALS: Array<[string, PropertyDescriptor | undefined]> = [
  "sessionStorage",
  "location",
  "navigator",
  "window",
].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
afterAll(() => {
  for (const [key, descriptor] of ORIGINAL_GLOBALS) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
});

// ---------- login ----------

describe("login", () => {
  test("writes credentials and the full vendor session for a player", async () => {
    mockFetch(() => authResponse());
    const out = await login({ customerID: "ccc107", password: "PW" });

    expect(out.step).toBe("done");
    expect(store.getItem("token")).toBe("tok_1");
    expect(store.getItem("skin")).toBe("Gotham");
    expect(store.getItem("forceMobile")).toBe("true");
    expect(store.getItem("playerID")).toBe("CCC107");
    expect(store.getItem("MASTER_ID")).toBe("");
    expect(JSON.parse(store.getItem("credentials") ?? "null")).toEqual({
      code: "tok_1",
      redirect_uri: "example.test",
      password: "PW",
      customerID: "CCC107",
    });
  });

  test("body is the shared builder's output, with only the live values overridden", async () => {
    mockFetch(() => authResponse());
    await login({ customerID: "ccc107", password: "PW" });

    expect(bodyOf(calls[0]!)).toEqual(
      buildAuthenticateCustomerBody("CCC107", "PW", {
        domain: "example.test",
        multiaccount: 0,
        operation: "authenticateCustomer",
        token: "",
        RRO: 1,
      }),
    );
  });

  test("agent login calls authenticateCustomerforAgent and writes only the agent keys", async () => {
    mockFetch(() =>
      authResponse(
        {},
        { AgentType: "M", AgentID: 99, AgentSkinOverride: "NewClassic" },
      ),
    );
    const out = await login({
      customerID: "agent1",
      password: "PW",
      agentToken: "AGTOK",
    });

    expect(lastCall().url).toEndWith("/authenticateCustomerforAgent");
    expect(bodyOf(lastCall()).token).toBe("AGTOK");

    const keys = store.keys().sort();
    expect(keys).toEqual(
      [
        "AgentSkinOverride",
        "MASTER_ID",
        "agentType",
        "credentials",
        "customerID",
        "token",
      ].sort(),
    );
    for (const absent of ["skin", "office", "language", "site", "playerID"]) {
      expect(store.getItem(absent)).toBeNull();
    }
    expect(out.route).toEqual({
      kind: "url",
      url: expect.stringContaining("skin/agent/classic/index.html"),
    });
  });

  test("password case follows UPPERCASE_PASSWORD; the stored credential matches what was sent", async () => {
    mockFetch(() => authResponse());
    await login({ customerID: "ccc107", password: "pw!" });
    expect(bodyOf(calls[0]!).password).toBe("PW!");
    expect(JSON.parse(store.getItem("credentials") ?? "null").password).toBe(
      "PW!",
    );

    CONFIG.UPPERCASE_PASSWORD = false;
    store.clear();
    mockFetch(() => authResponse());
    await login({ customerID: "ccc107", password: "pw!" });
    expect(bodyOf(calls[0]!).password).toBe("pw!");
  });

  test("a response without a code throws and leaves no session", async () => {
    mockFetch(() => json({}));
    await expect(
      login({ customerID: "CCC107", password: "bad" }),
    ).rejects.toThrow("missing_token");
    expect(store.getItem("token")).toBeNull();
    expect(store.getItem("credentials")).toBeNull();
    expect(locationStub.href).toBe("/start");
  });

  test("captcha is evaluated before otp, matching the vendor order", async () => {
    mockFetch(() =>
      json({ accountInfo: account({ UseCaptcha: "Y" }), tokenauth: 1 }),
    );
    const out = await login({ customerID: "CCC107", password: "PW" });
    expect(out.step).toBe("captcha");
  });
});

// ---------- transport ----------

describe("apiCall", () => {
  test("never sends Bearer undefined/null/0", async () => {
    mockFetch(() => json({ ok: true }));
    for (const bad of ["undefined", "null", "0", ""]) {
      store.setItem("token", bad);
      await apiCall("getX", {});
      expect(lastCall().init.headers.Authorization).toBeUndefined();
    }
  });

  test("sends X-Requested-With and includes credentials", async () => {
    mockFetch(() => json({ ok: true }));
    store.setItem("token", "tok_1");
    await apiCall("getX", {});
    expect(lastCall().init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(lastCall().init.credentials).toBe("include");
  });

  test("401 logs out and throws session_expired", async () => {
    mockFetch(() => new Response("no", { status: 401 }));
    store.setItem("token", "tok_1");
    await expect(apiCall("getX", {})).rejects.toThrow("session_expired");
    expect(locationStub.href).toBe("/");
    expect(store.getItem("token")).toBeNull();
  });

  test("204 returns null instead of a JSON error", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    store.setItem("token", "tok_1");
    expect(await apiCall("getX", {})).toBeNull();
  });

  test("scopes agentID to MASTER_ID for agents only", async () => {
    mockFetch(() => json({ ok: true }));
    store.setItem("token", "tok_1");
    store.setItem("agentType", "M");
    store.setItem("MASTER_ID", "42");
    await apiCall("getX", {});
    expect(bodyOf(lastCall()).agentID).toBe(42);

    store.removeItem("agentType"); // player: no scoping
    await apiCall("getX", {});
    expect(bodyOf(lastCall()).agentID).toBeUndefined();
  });
});

// ---------- refresh / reload ----------

describe("session resumption", () => {
  test("a stored session with the token cleared re-mints and survives reload", async () => {
    mockFetch(() => authResponse());
    await login({ customerID: "CCC107", password: "PW" });

    store.removeItem("token");
    mockFetch(() => json({ code: "tok_2" }));
    expect(await bootstrapSession()).toBe(true);
    expect(store.getItem("token")).toBe("tok_2");
    expect(bodyOf(lastCall()).operation).toBe("renewToken");
  });

  test("no credentials means no resumption", async () => {
    expect(await bootstrapSession()).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("renewToken carries operation in the body", async () => {
    mockFetch(() => json({ code: "tok_3" }));
    store.setItem("token", "tok_1");
    const { refreshNow } = await import("../../client/auth/auth.js");
    expect(await refreshNow()).toBe("tok_3");
    expect(bodyOf(lastCall()).operation).toBe("renewToken");
  });
});

// ---------- idle ----------

describe("idle timeout", () => {
  test("idle logout fires and clears the session", async () => {
    CONFIG.IDLE_MS = 15;
    CONFIG.IDLE_CHECK_MS = 5;
    mockFetch(() => authResponse());
    await login({ customerID: "CCC107", password: "PW" });
    expect(store.getItem("token")).toBe("tok_1");

    await new Promise((r) => setTimeout(r, 60));
    expect(locationStub.href).toBe("/");
    expect(store.getItem("token")).toBeNull();
  });
});

// ---------- routing ----------

describe("routeAfterLogin", () => {
  const data = (over: Record<string, unknown>) => ({
    accountInfo: account(over),
  });

  test("Gotham, NoLimitBet and EZ Classic produce one '?' each", () => {
    for (const skin of ["Gotham", "NoLimitBet", "EZ Classic"]) {
      const route = routeAfterLogin(data({ DefaultSiteSkin: skin }));
      expect(route.kind).toBe("url");
      expect(route.url.split("?").length - 1).toBe(1);
    }
  });

  test("routes by server skin value, not constant name", () => {
    expect(routeAfterLogin(data({ DefaultSiteSkin: "IBET" })).url).toStartWith(
      "skin/ibet.html",
    );
    expect(routeAfterLogin(data({ DefaultSiteSkin: "DPU" })).url).toStartWith(
      "skin/dpu.html",
    );
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "VISOR_GOTHAM" })).url,
    ).toStartWith("sports.html");
  });

  test("SKIN query overrides, office override, plb", () => {
    locationStub.search = "?SKIN=EURO";
    expect(routeAfterLogin(data({})).url).toStartWith("skin/euro.html");
    locationStub.search = "";
    expect(routeAfterLogin(data({ Office: "BAS" })).url).toStartWith(
      "skin/dsi-project.html",
    );
    expect(
      routeAfterLogin(data({}), { plb: "true", manager: "m", agentToken: "t" })
        .url,
    ).toStartWith("pbl.html");
  });

  test("Classic agent accounts are reported, not silently redirected", () => {
    const route = routeAfterLogin(
      data({ AgentType: "M", AgentSkinOverride: "Classic" }),
    );
    expect(route).toEqual({ kind: "legacy", customerID: "CCC107" });
  });

  test("an unmapped agent skin value is reported, then falls back to manager.html", () => {
    let seen: string | null = null;
    CONFIG.onUnknownAgentSkin = (value) => {
      seen = value;
    };
    const route = routeAfterLogin(
      data({ AgentType: "M", AgentSkinOverride: "CLASSIC" }),
    );
    expect(String(seen)).toBe("CLASSIC");
    expect(route.url).toStartWith("manager.html");
  });

  test("forceMobile and narrow viewports pick the mobile route", () => {
    store.setItem("forceMobile", "true");
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "BEATLINES" })).url,
    ).toStartWith("skin/lines.html");
    store.removeItem("forceMobile");

    Object.defineProperty(globalThis, "window", {
      value: { innerWidth: 500 },
      configurable: true,
      writable: true,
    });
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "BEATLINES" })).url,
    ).toStartWith("skin/lines.html");
    // isOnlyMobile() needs a mobile UA as well as a narrow viewport.
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "EZ Classic" })).url,
    ).toStartWith("skin/ez-classic.html");
    Object.defineProperty(globalThis.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "EZ Classic" })).url,
    ).toStartWith("skin/m-ez-classic.html");
  });

  test("a wide viewport stays on the desktop routes", () => {
    Object.defineProperty(globalThis, "window", {
      value: { innerWidth: 1400 },
      configurable: true,
      writable: true,
    });
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "BEATLINES" })).url,
    ).toStartWith("sports.html");
    expect(
      routeAfterLogin(data({ DefaultSiteSkin: "EZ Classic" })).url,
    ).toStartWith("skin/ez-classic.html");
  });

  test("unknown skin falls back to sports.html like the vendor", () => {
    expect(routeAfterLogin(data({ DefaultSiteSkin: "Nope" })).url).toStartWith(
      "sports.html",
    );
  });
});

describe("withQuery", () => {
  test("joins onto an existing query without a second '?'", () => {
    expect(withQuery("/a?url=x", { v: "1" })).toBe("/a?url=x&v=1");
    expect(withQuery("/a", { v: "1" })).toBe("/a?v=1");
  });

  test("empty params leave the URL untouched", () => {
    expect(withQuery("/a?url=x", {})).toBe("/a?url=x");
  });
});
