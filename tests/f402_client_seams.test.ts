import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  ALLOWED_MODULES,
  buildSeamProbeScript,
  evaluateSeamProbe,
  isAllowedModule,
  managerModuleIds,
  managerModuleLeaves,
  parseSeamProbe,
  preloadAllowedLeaves,
  SEAM_OWN_PROPERTIES,
} from "../lib/f402_client_seams.ts";
import type { SeamProbe } from "../lib/f402_client_seams.ts";
import {
  installSecuritySeamsPreload,
  probeSecuritySeams,
  SECURITY_SEAMS_PRELOAD_PATH,
} from "../lib/f402_client_overlay.ts";

const ROOT = join(import.meta.dir, "..");
const PINNED_MANAGER = join(
  ROOT,
  "verification/manager-boot-oracle/pinned/manager.js",
);

interface RequireJsLike {
  onResourceLoad:
    | ((context: unknown, map: { name?: string }, defined: unknown) => unknown)
    | null;
}

interface SecurityApi {
  escHtml: (value: unknown) => string;
  escUrl: (value: unknown) => string;
  csrf: () => string;
  sessionExpired: () => boolean;
  isAuthenticated: () => boolean;
  requireAuth: (
    fn: (...args: unknown[]) => unknown,
  ) => (...args: unknown[]) => unknown;
  allowedModules: Set<string>;
  isAllowedModule: (moduleId: unknown) => boolean;
  endSession: () => unknown;
  flags: { unifiedPost: boolean };
  logOut?: () => void;
  [key: string]: unknown;
}

interface PreloadContext {
  readonly window: Record<string, unknown>;
  readonly requirejs: RequireJsLike;
  readonly sessionStorage: Record<string, string | number>;
  readonly document: { cookie: string };
  readonly location: { href: string };
}

interface RunOptions {
  readonly meta?: string | null;
  readonly cookie?: string;
  readonly session?: Record<string, string | number>;
}

async function preloadSource(): Promise<string> {
  return Bun.file(SECURITY_SEAMS_PRELOAD_PATH).text();
}

function runPreload(
  source: string,
  href: string,
  options: RunOptions = {},
): PreloadContext {
  const window: Record<string, unknown> = {};
  const requirejs: RequireJsLike = { onResourceLoad: null };
  window["requirejs"] = requirejs;
  const meta = options.meta === undefined ? null : options.meta;
  const document = {
    querySelector: (selector: string) =>
      selector.includes("csrf-token") && meta !== null
        ? { content: meta }
        : null,
    cookie: options.cookie ?? "",
    addEventListener: (_event: string, _listener: () => void) => undefined,
  };
  const sessionStorage: Record<string, string | number> = {};
  Object.assign(sessionStorage, options.session ?? {});
  const location = { href };
  new Function(
    "window",
    "document",
    "location",
    "sessionStorage",
    "setInterval",
    "clearInterval",
    "URL",
    "Date",
    source,
  )(
    window,
    document,
    location,
    sessionStorage,
    () => 1,
    () => undefined,
    URL,
    Date,
  );
  return { window, requirejs, sessionStorage, document, location };
}

function decorate(context: PreloadContext, api: Record<string, unknown>): void {
  const hook = context.requirejs.onResourceLoad;
  if (hook === null) throw new Error("preload did not install onResourceLoad");
  hook({}, { name: "system/security" }, api);
}

function asApi(api: Record<string, unknown>): SecurityApi {
  return api as unknown as SecurityApi;
}

describe("security seam preload: installation", () => {
  test("adds every seam as an own property without touching the prototype", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://www.fantasy402.com/manager.html",
    );
    const api: Record<string, unknown> = {};
    decorate(context, api);

    for (const key of SEAM_OWN_PROPERTIES) {
      expect(Object.prototype.hasOwnProperty.call(api, key)).toBe(true);
    }
    expect(Object.getPrototypeOf(api)).toBe(Object.prototype);
    expect(Object.keys(api)).not.toContain("__proto__");
    expect(source).not.toMatch(/__proto__\s*=/);
  });

  test("is idempotent and preserves a pre-existing endSession", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://www.fantasy402.com/manager.html",
    );
    let endCalls = 0;
    const api: Record<string, unknown> = {
      endSession: () => {
        endCalls += 1;
      },
    };
    decorate(context, api);
    const escHtml = asApi(api).escHtml;
    decorate(context, api);
    expect(asApi(api).escHtml).toBe(escHtml);

    asApi(api).requireAuth(() => "ok")();
    // No sessionStorage.customerID, so requireAuth ends the session via the preserved hook.
    expect(endCalls).toBe(1);
  });

  test("decorates a class export by materializing own props on the instance", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://www.fantasy402.com/manager.html",
    );
    class Security {
      vendorMethod(): string {
        return "vendor";
      }
    }
    decorate(context, Security as unknown as Record<string, unknown>);

    const instance = new Security() as unknown as Record<string, unknown>;
    for (const key of SEAM_OWN_PROPERTIES) {
      expect(Object.prototype.hasOwnProperty.call(instance, key)).toBe(false);
    }
    for (const key of SEAM_OWN_PROPERTIES) void instance[key];
    for (const key of SEAM_OWN_PROPERTIES) {
      expect(Object.prototype.hasOwnProperty.call(instance, key)).toBe(true);
    }
    expect(instance["vendorMethod"]).toBeInstanceOf(Function);
    expect(Object.getPrototypeOf(instance)).toBe(Security.prototype);
    expect(
      Object.prototype.hasOwnProperty.call(Security.prototype, "escHtml"),
    ).toBe(true);
  });

  test("kill switch is latched at preload and cannot be cleared by a later URL rewrite", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://www.fantasy402.com/manager.html?no-seam=1",
    );
    expect(context.window["__F402_SEAM_DISABLED__"]).toBe(true);

    context.location.href = "https://www.fantasy402.com/manager.html";
    const api: Record<string, unknown> = {};
    decorate(context, api);
    expect(Object.prototype.hasOwnProperty.call(api, "escHtml")).toBe(false);

    const enabled = runPreload(
      source,
      "https://www.fantasy402.com/manager.html",
    );
    expect(enabled.window["__F402_SEAM_DISABLED__"]).toBe(false);
    const patched: Record<string, unknown> = {};
    decorate(enabled, patched);
    expect(Object.prototype.hasOwnProperty.call(patched, "escHtml")).toBe(true);
  });
});

describe("security seam preload: escape seams", () => {
  test("escHtml encodes the five HTML-significant characters", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const api: Record<string, unknown> = {};
    decorate(context, api);
    const seam = asApi(api);

    expect(seam.escHtml(`<img src=x onerror="a&b">'`)).toBe(
      "&lt;img src=x onerror=&quot;a&amp;b&quot;&gt;&#39;",
    );
    // Each of the five HTML-significant characters on its own.
    expect(seam.escHtml("&")).toBe("&amp;");
    expect(seam.escHtml("<")).toBe("&lt;");
    expect(seam.escHtml(">")).toBe("&gt;");
    expect(seam.escHtml('"')).toBe("&quot;");
    expect(seam.escHtml("'")).toBe("&#39;");
    // Non-ASCII and a BMP-plus code point (surrogate pair) are passed through unchanged.
    expect(seam.escHtml("é")).toBe("é");
    expect(seam.escHtml("😀")).toBe("😀");
    expect(seam.escHtml("\uD83D\uDE00")).toBe("\uD83D\uDE00");
    expect(seam.escHtml("a\u0000b")).toBe("a\u0000b");
    expect(seam.escHtml(null)).toBe("");
    expect(seam.escHtml(undefined)).toBe("");
  });

  test("escUrl accepts only http(s), root-relative, fragment and query forms", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const api: Record<string, unknown> = {};
    decorate(context, api);
    const seam = asApi(api);

    expect(seam.escUrl("https://example.com/a b")).toBe(
      "https://example.com/a%20b",
    );
    expect(seam.escUrl("/manager.html?x=1")).toBe("/manager.html?x=1");
    expect(seam.escUrl("#section")).toBe("#section");
    expect(seam.escUrl("?q=1")).toBe("?q=1");
    expect(seam.escUrl("javascript:alert(1)")).toBe("");
    expect(seam.escUrl("data:text/html,x")).toBe("");
    expect(seam.escUrl(null)).toBe("");
  });
});

describe("security seam preload: csrf seam", () => {
  test("reads a delivered meta token, then a cookie, then stays empty", async () => {
    const source = await preloadSource();

    const withMeta = runPreload(source, "https://x/", { meta: "meta-token" });
    const metaApi: Record<string, unknown> = {};
    decorate(withMeta, metaApi);
    expect(asApi(metaApi).csrf()).toBe("meta-token");

    const withCookie = runPreload(source, "https://x/", {
      cookie: "a=1; csrf=cookie-token; b=2",
    });
    const cookieApi: Record<string, unknown> = {};
    decorate(withCookie, cookieApi);
    expect(asApi(cookieApi).csrf()).toBe("cookie-token");

    const none = runPreload(source, "https://x/");
    const noneApi: Record<string, unknown> = {};
    decorate(none, noneApi);
    expect(asApi(noneApi).csrf()).toBe("");
  });
});

describe("security seam preload: session seams", () => {
  test("isAuthenticated follows customerID and the expiry pair", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/", {
      session: { customerID: "C123" },
    });
    const api: Record<string, unknown> = {};
    decorate(context, api);
    const seam = asApi(api);

    expect(seam.isAuthenticated()).toBe(true);
    expect(seam.sessionExpired()).toBe(false);

    context.sessionStorage["sessionIssuedAt"] = Date.now() - 10_000;
    context.sessionStorage["sessionTtlMs"] = 5_000;
    expect(seam.sessionExpired()).toBe(true);
    expect(seam.isAuthenticated()).toBe(false);
  });

  test("requireAuth denies an expired session and calls the session teardown", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/", {
      session: {
        customerID: "C123",
        sessionIssuedAt: Date.now() - 10_000,
        sessionTtlMs: 5_000,
      },
    });
    let endCalls = 0;
    const api: Record<string, unknown> = {
      logOut: () => {
        endCalls += 1;
      },
    };
    decorate(context, api);
    const seam = asApi(api);

    let ran = false;
    const guarded = seam.requireAuth(() => {
      ran = true;
      return "value";
    });
    expect(guarded()).toBe(false);
    expect(ran).toBe(false);
    expect(endCalls).toBe(1);

    context.sessionStorage["sessionIssuedAt"] = Date.now();
    context.sessionStorage["sessionTtlMs"] = 60_000;
    const thisArg = { marker: true };
    const args = [1, 2];
    const result = guarded.apply(thisArg, args);
    expect(result).toBe("value");
    expect(ran).toBe(true);
  });
});

describe("security seam preload: module allowlist", () => {
  test("accepts leaves and full ids, rejects traversal and false", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const api: Record<string, unknown> = {};
    decorate(context, api);
    const seam = asApi(api);

    expect(seam.isAllowedModule("player-info")).toBe(true);
    expect(seam.isAllowedModule("manager/module/player-info")).toBe(true);
    expect(seam.isAllowedModule("manager/module/customer-admin/crash")).toBe(
      true,
    );
    expect(seam.isAllowedModule("../../evil")).toBe(false);
    expect(seam.isAllowedModule("manager/module/../evil")).toBe(false);
    expect(seam.isAllowedModule("not-a-module")).toBe(false);
    expect(seam.isAllowedModule("")).toBe(false);
    expect(seam.isAllowedModule(false)).toBe(false);

    seam.allowedModules.add("future-module");
    expect(seam.isAllowedModule("future-module")).toBe(true);
  });

  test("the preload list, the gate list and the pinned controller agree", async () => {
    const source = await preloadSource();
    expect(preloadAllowedLeaves(source).sort()).toEqual(
      [...ALLOWED_MODULES].sort(),
    );

    const managerJs = await Bun.file(PINNED_MANAGER).text();
    const leaves = managerModuleLeaves(managerJs);
    const ids = managerModuleIds(managerJs);
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect(ids).toContain("manager/module/customer-admin/crash");
    for (const leaf of leaves) {
      expect(isAllowedModule(leaf)).toBe(true);
      expect(isAllowedModule(`manager/module/${leaf}`)).toBe(true);
    }
  });
});

describe("seam probe and installer", () => {
  const leaves = ["player-info", "bet-ticker"];

  function goodProbe(): SeamProbe {
    const ownProperties: Record<string, boolean> = {};
    for (const key of SEAM_OWN_PROPERTIES) ownProperties[key] = true;
    const allowed: Record<string, boolean> = {};
    for (const leaf of leaves) allowed[leaf] = true;
    return {
      applied: true,
      ownProperties,
      allowed,
      authenticated: true,
      csrf: "",
      reason: null,
      diag: null,
    };
  }

  test("a healthy probe is clean and reports csrf as dormant with the reason", () => {
    const outcome = evaluateSeamProbe(goodProbe(), leaves);
    expect(outcome.covered).toBe(true);
    expect(outcome.issues).toEqual([]);
    expect(outcome.notes.join(" ")).toContain("csrf dormant");
    expect(outcome.notes.join(" ")).toContain(
      "sessionStorage.credentials.code",
    );
  });

  test("a missing own property, false allowlist entry or failed session check is an issue", () => {
    const broken = goodProbe();
    broken.ownProperties["csrf"] = false;
    broken.allowed["bet-ticker"] = false;
    broken.authenticated = false;
    const issues = evaluateSeamProbe(broken, leaves).issues.join(" ");
    expect(issues).toContain("not an own property: csrf");
    expect(issues).toContain("isAllowedModule(bet-ticker)");
    expect(issues).toContain("isAuthenticated()");
  });

  test("an unapplied seam fails with its reason", () => {
    const probe = goodProbe();
    probe.applied = false;
    probe.reason = "security-module-not-loaded";
    expect(evaluateSeamProbe(probe, leaves).issues).toContain(
      "security-module-not-loaded",
    );
  });

  test("probe script carries the expected own properties and leaves", () => {
    const script = buildSeamProbeScript(leaves);
    for (const key of SEAM_OWN_PROPERTIES) expect(script).toContain(`"${key}"`);
    expect(script).toContain('"player-info"');
    expect(parseSeamProbe(JSON.stringify(goodProbe())).applied).toBe(true);
  });

  test("installer uses CDP on chrome and refuses webkit", async () => {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    const chrome = {
      backend: "chrome" as const,
      cdp: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params: params ?? {} });
      },
    };
    const installed = await installSecuritySeamsPreload(chrome, {
      backend: "chrome",
    });
    expect(installed.installed).toBe(true);
    expect(calls[0]?.method).toBe("Page.addScriptToEvaluateOnNewDocument");

    const webkit = {
      backend: "webkit" as const,
      cdp: async () => {
        throw new Error("webkit has no cdp");
      },
    };
    const refused = await installSecuritySeamsPreload(webkit, {
      backend: "webkit",
    });
    expect(refused.installed).toBe(false);
    expect(refused.reason).toContain("webkit");
  });

  test("probe skips webkit with a not-covered note instead of passing", async () => {
    const webkit = {
      backend: "webkit" as const,
      evaluate: async () => {
        throw new Error("evaluate should not run on webkit");
      },
    };
    const outcome = await probeSecuritySeams(webkit, {
      moduleLeaves: leaves,
      backend: "webkit",
    });
    expect(outcome.covered).toBe(false);
    expect(outcome.notes.join(" ")).toContain("not covered");
  });

  test("probe evaluates on chrome and surfaces issues", async () => {
    const chrome = {
      backend: "chrome" as const,
      evaluate: async () => JSON.stringify(goodProbe()),
    };
    const outcome = await probeSecuritySeams(chrome, {
      moduleLeaves: leaves,
      backend: "chrome",
    });
    expect(outcome.covered).toBe(true);
    expect(outcome.issues).toEqual([]);
  });
});
