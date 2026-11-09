import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  ALLOWED_MODULES,
  buildRenderCheckScript,
  EXTERNAL_VIEW_GUARD_ANCHORS,
  buildSeamProbeScript,
  canaryExitCode,
  evaluateSeamProbe,
  isAllowedModule,
  managerModuleIds,
  missingExternalViewGuardAnchors,
  missingModuleSinkAnchors,
  managerModuleLeaves,
  parseRenderCheck,
  parseSeamProbe,
  preloadAllowedLeaves,
  SEAM_OWN_PROPERTIES,
  seamProbeExitCode,
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
  s?: {
    contexts: { _: { defined: Record<string, unknown> } };
  };
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
  flags: { unifiedPost: boolean; externalViewGuard: boolean };
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
  readonly guard?: boolean;
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
  if (options.guard === true) window["__F402_EXTERNAL_VIEW_GUARD__"] = true;
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
  const consoleStub = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  new Function(
    "window",
    "document",
    "location",
    "sessionStorage",
    "setInterval",
    "clearInterval",
    "URL",
    "Date",
    "console",
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
    consoleStub,
  );
  return { window, requirejs, sessionStorage, document, location };
}

function decorateNamed(
  context: PreloadContext,
  name: string,
  api: Record<string, unknown>,
): void {
  const hook = context.requirejs.onResourceLoad;
  if (hook === null) throw new Error("preload did not install onResourceLoad");
  hook({}, { name }, api);
}

function decorate(context: PreloadContext, api: Record<string, unknown>): void {
  decorateNamed(context, "system/security", api);
}

function withRegistry(context: PreloadContext): Record<string, unknown> {
  const defined: Record<string, unknown> = {};
  context.requirejs.s = { contexts: { _: { defined } } };
  return defined;
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

  test("no-seam wins over external-view-guard (dependency, not policy)", async () => {
    const source = await preloadSource();

    const both = runPreload(
      source,
      "https://x/manager.html?no-seam=1&external-view-guard=1",
    );
    // With no-seam the seam is absent, so there is no flags object to read: the latch itself must
    // be false, which is the property the call-site guard consumes.
    expect(both.window["__F402_EXTERNAL_VIEW_GUARD__"]).toBe(false);

    const guardOnly = runPreload(
      source,
      "https://x/manager.html?external-view-guard=1",
    );
    const guardApi: Record<string, unknown> = {};
    decorate(guardOnly, guardApi);
    expect(asApi(guardApi).flags.externalViewGuard).toBe(true);
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

    const own = Object.getOwnPropertyDescriptor(instance, "escHtml");
    expect(own?.enumerable).toBe(false);
    expect(own?.configurable).toBe(false);

    const protoDescriptor = Object.getOwnPropertyDescriptor(
      Security.prototype,
      "escHtml",
    );
    expect(protoDescriptor?.enumerable).toBe(false);
    expect(typeof protoDescriptor?.get).toBe("function");
    // Reading the seam on the prototype must throw and must not replace the accessor with a value.
    expect(
      () =>
        (Security.prototype as unknown as Record<string, unknown>)["escHtml"],
    ).toThrow(/access on prototype/);
    expect(
      typeof Object.getOwnPropertyDescriptor(Security.prototype, "escHtml")
        ?.get,
    ).toBe("function");
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

  test("flags expose the dormant transport and the latched phase-1 canary gate", async () => {
    const source = await preloadSource();

    const byDefault = runPreload(source, "https://x/");
    const defaultApi: Record<string, unknown> = {};
    decorate(byDefault, defaultApi);
    expect(asApi(defaultApi).flags).toEqual({
      unifiedPost: false,
      externalViewGuard: false,
    });

    const byUrl = runPreload(
      source,
      "https://x/manager.html?external-view-guard=1",
    );
    const urlApi: Record<string, unknown> = {};
    decorate(byUrl, urlApi);
    expect(asApi(urlApi).flags.externalViewGuard).toBe(true);

    const byInjection = runPreload(source, "https://x/", { guard: true });
    const injectedApi: Record<string, unknown> = {};
    decorate(byInjection, injectedApi);
    expect(asApi(injectedApi).flags.externalViewGuard).toBe(true);

    // Latched at preload: a later URL rewrite cannot flip the canary on.
    const latched = runPreload(source, "https://x/manager.html");
    latched.location.href = "https://x/manager.html?external-view-guard=1";
    const latchedApi: Record<string, unknown> = {};
    decorate(latched, latchedApi);
    expect(asApi(latchedApi).flags.externalViewGuard).toBe(false);
  });

  test("registry degradation is an audit signal, not a page break", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const seams = context.window["__F402_SEAMS__"] as {
      sweep: () => boolean;
      diag: () => { registryDegraded: boolean };
    };
    // The fake requirejs has no private `.s.contexts` registry.
    expect(() => seams.sweep()).not.toThrow();
    expect(seams.sweep()).toBe(false);
    expect(seams.diag().registryDegraded).toBe(true);
  });

  test("manager overlay anchors exist in the pinned controller and fail on a move", async () => {
    const managerJs = await Bun.file(PINNED_MANAGER).text();
    expect(missingExternalViewGuardAnchors(managerJs)).toEqual([]);
    expect(EXTERNAL_VIEW_GUARD_ANCHORS.length).toBe(10);

    const moved = managerJs.replace('"external-view"', '"external"');
    expect(missingExternalViewGuardAnchors(moved)).toContain('"external-view"');
    const searchMoved = managerJs.replace(
      "searchComponent:function",
      "searchComponent: fn",
    );
    expect(missingExternalViewGuardAnchors(searchMoved)).toContain(
      "searchComponent:function",
    );
  });

  test("searchComponent escapes rows once and every later keyup render stays escaped", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://www.fantasy402.com/manager.html",
    );
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );

    const renders: Array<Record<string, unknown>> = [];
    class Manager {
      agents = [{ Login: "agent<one", AgentID: 'a"1' }];
      players = [
        {
          Login: "a&b",
          NameFirst: '<img src=x onerror="boom">',
          Password: 'p"w<d',
          customerID: 'c"1',
        },
      ];
      searchComponent(): void {
        // The real method only binds this handler; the render runs later, per keystroke.
        (this as unknown as { render: () => void }).render = () => {
          renders.push({ ...(this.players[0] as Record<string, unknown>) });
        };
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const instance = new Manager();
    instance.searchComponent();
    (instance as unknown as { render: () => void }).render();
    (instance as unknown as { render: () => void }).render();

    expect(renders).toHaveLength(2);
    for (const seen of renders) {
      expect(seen["NameFirst"]).toContain("&lt;img");
      expect(seen["Login"]).toContain("a&amp;b");
      expect(seen["Password"]).toContain("p&quot;w&lt;d");
      expect(seen["customerID"]).toContain("&quot;");
    }
    expect(instance.agents[0]!.AgentID).toContain("&quot;");
    // Permanent escaping: no restore window for a deferred render to slip through.
    expect(instance.players[0]!.NameFirst).toContain("&lt;img");
  });

  test("searchComponent escaping is idempotent across repeated setup calls", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    class Manager {
      agents: unknown[] = [];
      players = [{ Login: "a&b", NameFirst: "A&B", Password: "" }];
      searchComponent(): void {}
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const instance = new Manager();
    instance.searchComponent();
    const once = instance.players[0]!.NameFirst;
    instance.searchComponent();
    expect(instance.players[0]!.NameFirst).toBe(once);
    expect(once).toBe("A&amp;B");
    // Same object reused with a new raw value must be escaped again, not skipped by identity.
    instance.players[0]!.NameFirst = "<b>y</b>";
    instance.searchComponent();
    expect(instance.players[0]!.NameFirst).toContain("&lt;b&gt;");
  });

  test("module sink anchors exist and fail on a move", async () => {
    expect(
      missingModuleSinkAnchors(
        "https://www.fantasy402.com/app/manager/module/player-info.js",
        "x password-h y",
      ),
    ).toEqual([]);
    expect(
      missingModuleSinkAnchors(
        "https://www.fantasy402.com/app/manager/module/player-info.js",
        "x password z",
      ),
    ).toEqual(["password-h"]);
    expect(
      missingModuleSinkAnchors(
        "https://www.fantasy402.com/app/manager/module/pending-thin.js",
        "gameReport but no modal field",
      ),
    ).toEqual(["bet-desc"]);
    expect(
      missingModuleSinkAnchors(
        "https://www.fantasy402.com/app/manager/module/agent-management-thin.js",
        'x [data-action="setPassword"] y [data-action="setName"] z data-col="password" w',
      ),
    ).toEqual([]);
    expect(
      missingModuleSinkAnchors(
        "https://www.fantasy402.com/app/manager/module/agent-management-thin.js",
        'only [data-action="setPassword"] present',
      ),
    ).toEqual(['[data-action="setName"]', 'data-col="password"']);
    expect(
      missingModuleSinkAnchors("https://example.test/other.js", ""),
    ).toEqual([]);
  });

  test("player-info.password-h is escaped while other .html calls stay raw", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    const htmlCalls: string[] = [];
    const passwordTarget = {
      is: (sel: string) => sel === '[data-field="password-h"]',
    };
    const otherTarget = { is: () => false };
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
      fn: {
        html(this: unknown, value: string): void {
          htmlCalls.push(value);
        },
      },
    };
    class PlayerInfo {
      data(): void {
        const jq = context.window["jQuery"] as {
          ajax: (o: unknown) => void;
          fn: { html: (this: unknown, v: string) => void };
        };
        jq.ajax({
          data: { operation: "getInfoPlayer" },
          success: () => {
            jq.fn.html.call(passwordTarget, 'p"w<d');
            jq.fn.html.call(otherTarget, "<b>raw</b>");
          },
        });
      }
    }
    defined["manager/module/player-info"] = PlayerInfo;
    decorateNamed(
      context,
      "manager/module/player-info",
      PlayerInfo as unknown as Record<string, unknown>,
    );
    new PlayerInfo().data();
    expect(captured).not.toBeNull();
    (captured as unknown as { success: () => void }).success();
    expect(htmlCalls[0]).toBe("p&quot;w&lt;d");
    expect(htmlCalls[1]).toBe("<b>raw</b>");
  });

  test("player-info restores the html hook when the success handler throws", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    const htmlCalls: string[] = [];
    const passwordTarget = {
      is: (sel: string) => sel === '[data-field="password-h"]',
    };
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
      fn: {
        html(this: unknown, value: string): void {
          htmlCalls.push(value);
        },
      },
    };
    const jq = context.window["jQuery"] as {
      fn: { html: (this: unknown, v: string) => void };
    };
    const baseHtml = jq.fn.html;
    class PlayerInfo {
      data(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "getInfoPlayer" },
          success: () => {
            jq.fn.html.call(passwordTarget, "first");
            throw new Error("render failed");
          },
        });
      }
    }
    defined["manager/module/player-info"] = PlayerInfo;
    decorateNamed(
      context,
      "manager/module/player-info",
      PlayerInfo as unknown as Record<string, unknown>,
    );
    new PlayerInfo().data();
    expect(() =>
      (captured as unknown as { success: () => void }).success(),
    ).toThrow("render failed");
    expect(htmlCalls[0]).toBe("first");
    // finally restored the hook, so a later render is not escaped by a stale wrapper.
    expect(jq.fn.html).toBe(baseHtml);
    jq.fn.html.call(passwordTarget, "second");
    expect(htmlCalls[1]).toBe("second");
  });

  test("agent-management-thin setPassword and setName escape markup while leaving other .html calls raw", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    const htmlCalls: string[] = [];
    const passwordTarget = {
      is: (sel: string) => sel === '[data-action="setPassword"]',
    };
    const nameTarget = {
      is: (sel: string) => sel === '[data-action="setName"]',
    };
    const otherTarget = { is: () => false };
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
      fn: {
        html(this: unknown, value: string): void {
          htmlCalls.push(value);
        },
      },
    };
    class AgentManagementThin {
      setPassword(a: { agentID: string; value: string }): void {
        const jq = context.window["jQuery"] as {
          ajax: (o: unknown) => void;
          fn: { html: (this: unknown, v: string) => void };
        };
        jq.ajax({
          data: {
            operation: "updateCustomerField",
            field: "Password",
            value: a.value,
          },
          success: () => {
            jq.fn.html.call(passwordTarget, a.value);
            jq.fn.html.call(otherTarget, "<b>raw</b>");
          },
        });
      }
      setName(a: { agentID: string; value: string }): void {
        const jq = context.window["jQuery"] as {
          ajax: (o: unknown) => void;
          fn: { html: (this: unknown, v: string) => void };
        };
        jq.ajax({
          data: {
            operation: "updateCustomerField",
            field: "NameFirst",
            value: a.value,
          },
          success: () => {
            jq.fn.html.call(nameTarget, a.value);
            jq.fn.html.call(otherTarget, "<i>raw</i>");
          },
        });
      }
    }
    defined["manager/module/agent-management-thin"] = AgentManagementThin;
    decorateNamed(
      context,
      "manager/module/agent-management-thin",
      AgentManagementThin as unknown as Record<string, unknown>,
    );

    const instance = new AgentManagementThin();
    instance.setPassword({ agentID: "AG1", value: 'pass"<script>' });
    expect(captured).not.toBeNull();
    (captured as unknown as { success: () => void }).success();
    expect(htmlCalls[0]).toBe("pass&quot;&lt;script&gt;");
    expect(htmlCalls[1]).toBe("<b>raw</b>");

    captured = null;
    instance.setName({ agentID: "AG1", value: "name'<tag>" });
    expect(captured).not.toBeNull();
    (captured as unknown as { success: () => void }).success();
    expect(htmlCalls[2]).toBe("name&#39;&lt;tag&gt;");
    expect(htmlCalls[3]).toBe("<i>raw</i>");
  });

  test("agent-management-thin setColsAgentManagement escapes password column while balance stays raw", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    const htmlCalls: string[] = [];
    const passwordLi = {
      is: (sel: string) => sel === '[data-col="password"] li',
      closest: (sel: string) => (sel === '[data-col="password"]' ? [1] : []),
    };
    const balanceLi = {
      is: (sel: string) => sel === '[data-col="balance"] li',
      closest: () => [],
    };
    context.window["jQuery"] = {
      fn: {
        html(this: unknown, value: string): void {
          htmlCalls.push(value);
        },
      },
    };
    class AgentManagementThin {
      setColsAgentManagement(): void {
        const jq = context.window["jQuery"] as {
          fn: { html: (this: unknown, v: string) => void };
        };
        jq.fn.html.call(passwordLi, 'server"pass<word>');
        jq.fn.html.call(balanceLi, '<span class="green">$500.00</span>');
      }
    }
    defined["manager/module/agent-management-thin"] = AgentManagementThin;
    decorateNamed(
      context,
      "manager/module/agent-management-thin",
      AgentManagementThin as unknown as Record<string, unknown>,
    );

    new AgentManagementThin().setColsAgentManagement();
    expect(htmlCalls[0]).toBe("server&quot;pass&lt;word&gt;");
    expect(htmlCalls[1]).toBe('<span class="green">$500.00</span>');
  });

  test("agent-management-thin restores html hook when success handler or setCols throws", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
      fn: {
        html(): void {},
      },
    };
    const jq = context.window["jQuery"] as {
      fn: { html: (this: unknown, v: string) => void };
    };
    const baseHtml = jq.fn.html;
    class AgentManagementThin {
      setPassword(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "updateCustomerField", field: "Password" },
          success: () => {
            throw new Error("ajax render failed");
          },
        });
      }
      setColsAgentManagement(): void {
        throw new Error("setCols failed");
      }
    }
    defined["manager/module/agent-management-thin"] = AgentManagementThin;
    decorateNamed(
      context,
      "manager/module/agent-management-thin",
      AgentManagementThin as unknown as Record<string, unknown>,
    );

    const instance = new AgentManagementThin();
    instance.setPassword();
    expect(() =>
      (captured as unknown as { success: () => void }).success(),
    ).toThrow("ajax render failed");
    expect(jq.fn.html).toBe(baseHtml);

    expect(() => instance.setColsAgentManagement()).toThrow("setCols failed");
    expect(jq.fn.html).toBe(baseHtml);
  });

  test("a manager class without searchComponent installs loudly, not silently", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    class ManagerWithoutSearch {
      setAccountInfo(): void {}
    }
    decorateNamed(
      context,
      "manager/manager",
      ManagerWithoutSearch as unknown as Record<string, unknown>,
    );
    const seams = context.window["__F402_SEAMS__"] as {
      diag: () => {
        searchEscaperInstalled: boolean;
        searchEscaperFailure: string | null;
      };
    };
    expect(seams.diag().searchEscaperInstalled).toBe(false);
    expect(seams.diag().searchEscaperFailure).toBe("searchComponent-missing");
  });

  test("getMessageInit escapes FromE/Subject for the render and restores emailCount raw", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
    };
    const rendered: Array<Record<string, unknown>> = [];
    let emailCount: Array<Record<string, unknown>> | null = null;
    class Manager {
      getMessageInit(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "getNewEmailsCount" },
          success: (response: {
            INFO: { LIST: Array<Record<string, unknown>> };
          }) => {
            emailCount = response.INFO.LIST;
            rendered.push({ ...response.INFO.LIST[0] });
          },
        });
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const instance = new Manager();
    instance.getMessageInit();
    expect(captured).not.toBeNull();
    (captured as unknown as { success: (r: unknown) => void }).success({
      INFO: {
        LIST: [{ FromE: "eve<one>", Subject: "sub&ject", DateMail: "d" }],
        COUNT: { total: 1 },
      },
    });
    expect(rendered[0]!["FromE"]).toContain("&lt;one&gt;");
    expect(rendered[0]!["Subject"]).toContain("sub&amp;ject");
    expect(emailCount).not.toBeNull();
    expect(emailCount![0]!["FromE"]).toBe("eve<one>");
    expect(emailCount![0]!["Subject"]).toBe("sub&ject");
  });

  test("getPopUpMessages escapes before the newline-to-<br> replacement", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
    };
    const rendered: Array<{ comment: string; item: string }> = [];
    class Manager {
      getPopUpMessages(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "getMessage" },
          success: (response: {
            COMMENT: Array<{ CommentsForAgent: string }>;
            LIST: Array<{ Subject: string; Message: string; Id: string }>;
          }) => {
            const br = (v: string): string =>
              v.replace(/(?:\r\n|\r|\n)/g, "<br>");
            const comment =
              "<p>" + br(response.COMMENT[0]!.CommentsForAgent) + "</p>";
            const template =
              '<h4>{SUBJECT}</h4><p>{MESSAGE}</p><div data-index="{INDEX}"></div>';
            const item = template
              .replace("{SUBJECT}", response.LIST[0]!.Subject)
              .replace("{MESSAGE}", br(response.LIST[0]!.Message))
              .replace("{INDEX}", response.LIST[0]!.Id);
            rendered.push({ comment, item });
          },
        });
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    new Manager().getPopUpMessages();
    expect(captured).not.toBeNull();
    (captured as unknown as { success: (r: unknown) => void }).success({
      COMMENT: [{ CommentsForAgent: "line1\nline2<b>" }],
      LIST: [{ Subject: "<subject>", Message: "line1\nline2<b>", Id: '1"2' }],
    });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.comment).toContain("<br>");
    expect(rendered[0]!.comment).toContain("&lt;b&gt;");
    expect(rendered[0]!.comment).not.toContain("&lt;br&gt;");
    expect(rendered[0]!.item).toContain("&lt;subject&gt;");
    expect(rendered[0]!.item).toContain("<br>");
    expect(rendered[0]!.item).toContain("&lt;b&gt;");
    expect(rendered[0]!.item).not.toContain("&lt;br&gt;");
  });

  test("getPopUpMessages does not dereference an empty COMMENT or null fields", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
    };
    class Manager {
      getPopUpMessages(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "getMessage" },
          success: () => undefined,
        });
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    new Manager().getPopUpMessages();
    expect(captured).not.toBeNull();
    const success = (captured as unknown as { success: (r: unknown) => void })
      .success;
    // The original guards these; the wrapper must not fire first on absent data.
    expect(() => success({ COMMENT: [], LIST: [] })).not.toThrow();
    expect(() =>
      success({
        COMMENT: [],
        LIST: [{ Subject: null, Message: null, Id: null }],
      }),
    ).not.toThrow();
    expect(() => success({})).not.toThrow();
  });

  test("setCommunicationMessages escapes Message but leaves Id raw for .attr()", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let seen: Record<string, unknown> | null = null;
    class Manager {
      setCommunicationMessages(event: {
        info: { data: Record<string, unknown> };
      }): void {
        seen = { ...event.info.data };
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const event = {
      info: { data: { Message: "</div><script>", Id: "A&B", Subject: "<s>" } },
    };
    new Manager().setCommunicationMessages(event);
    expect(seen).not.toBeNull();
    expect(seen!["Message"]).toContain("&lt;/div&gt;");
    expect(seen!["Message"]).toContain("&lt;script&gt;");
    // .attr("data-id", value) is an attribute setter, not an HTML sink; escaping would break
    // mail.delete({id}) and the value is returned raw by attr().
    expect(seen!["Id"]).toBe("A&B");
    // The caller's data object is restored after the synchronous call.
    expect(event.info.data.Message).toBe("</div><script>");
  });

  test("searchCustomer escapes Login/Password/NameFirst and leaves CustomerID raw", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
    };
    const rendered: Array<Record<string, unknown>> = [];
    class Manager {
      searchCustomer(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "searchCustomerAdmin" },
          success: (response: { LIST: Array<Record<string, unknown>> }) => {
            const row = response.LIST[0] as {
              Login: string;
              CustomerID: string;
              info: { Password: string; NameFirst: string };
            };
            rendered.push({
              Login: row.Login,
              CustomerID: row.CustomerID,
              Password: row.info.Password,
              NameFirst: row.info.NameFirst,
            });
          },
        });
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    new Manager().searchCustomer();
    expect(captured).not.toBeNull();
    (captured as unknown as { success: (r: unknown) => void }).success({
      LIST: [
        {
          CustomerID: "c1",
          Login: 'a"b',
          info: { Password: "</span><script>", NameFirst: "<b>n</b>" },
        },
      ],
    });
    expect(rendered[0]!["Login"]).toContain("&quot;");
    expect(rendered[0]!["Password"]).toContain("&lt;script&gt;");
    expect(rendered[0]!["NameFirst"]).toContain("&lt;b&gt;");
    expect(rendered[0]!["CustomerID"]).toBe("c1");
  });

  test("getCommunicationMessages preserves the first <BR> strip then escapes both paths", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    let captured: Record<string, unknown> | null = null;
    context.window["jQuery"] = {
      ajax(options: Record<string, unknown>): void {
        captured = options;
      },
    };
    let seen: Record<string, unknown> | null = null;
    class Manager {
      accountInfo: Record<string, unknown> = {
        CommentsForCustomer: "<BR>Hello<BR><script>",
      };
      getCommunicationMessages(): void {
        (context.window["jQuery"] as { ajax: (o: unknown) => void }).ajax({
          data: { operation: "getCommunicationMessages" },
          success: () => {
            const i = String(this.accountInfo["CommentsForCustomer"])
              .trim()
              .replace("<BR>", "");
            seen = {
              stamp: '<div class="stamp-message">' + i + "</div>",
              popup: i,
            };
          },
        });
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const instance = new Manager();
    instance.getCommunicationMessages();
    expect(captured).not.toBeNull();
    (captured as unknown as { success: () => void }).success();
    expect(seen).not.toBeNull();
    expect(seen!["stamp"]).toContain("Hello");
    expect(seen!["stamp"]).toContain("&lt;BR&gt;");
    expect(seen!["stamp"]).toContain("&lt;script&gt;");
    expect(seen!["stamp"]).not.toContain("<BR>Hello");
    expect(seen!["popup"]).toBe("Hello&lt;BR&gt;&lt;script&gt;");
    expect(instance.accountInfo["CommentsForCustomer"]).toBe(
      "<BR>Hello<BR><script>",
    );
  });

  test("setHistory escapes only the title and leaves the getHistory argument raw", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    const defined = withRegistry(context);
    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
    const titleCalls: string[] = [];
    context.window["jQuery"] = {
      fn: {
        html(value: string): void {
          titleCalls.push(value);
        },
      },
    };
    let historyAgent: unknown;
    class Manager {
      setHistory(event: { info: { agent: unknown } }): void {
        // Mirrors the pinned controller: title is built from info.agent, the same value goes
        // to getHistory().
        (
          context.window["jQuery"] as { fn: { html: (v: string) => void } }
        ).fn.html(
          "History for " +
            (event.info.agent as { toString(): string })
              .toString()
              .split(".")
              .join(""),
        );
        this.getHistory(event.info.agent);
      }
      getHistory(agent: unknown): void {
        historyAgent = agent;
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    new Manager().setHistory({ info: { agent: '<img src=x onerror="boom">' } });
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]).toContain("&lt;img");
    expect(historyAgent).toBe('<img src=x onerror="boom">');
  });

  test("a manager class without setAccountInfo installs loudly, not silently", async () => {
    const source = await preloadSource();
    const context = runPreload(source, "https://x/");
    class ManagerWithoutTarget {
      // no setAccountInfo
    }
    decorateNamed(
      context,
      "manager/manager",
      ManagerWithoutTarget as unknown as Record<string, unknown>,
    );
    const seams = context.window["__F402_SEAMS__"] as {
      diag: () => {
        managerGuardInstalled: boolean;
        managerGuardFailure: string | null;
      };
    };
    const diag = seams.diag();
    expect(diag.managerGuardInstalled).toBe(false);
    expect(diag.managerGuardFailure).toBe("setAccountInfo-missing");
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

describe("external-view call-site guard (flag-gated, dead by default)", () => {
  interface GuardFixture {
    readonly context: PreloadContext;
    readonly manager: { calls: number; instance: Record<string, unknown> };
    readonly logOuts: () => number;
  }

  async function fixture(
    href: string,
    options: RunOptions = {},
  ): Promise<GuardFixture> {
    const source = await preloadSource();
    const context = runPreload(source, href, options);
    const defined = withRegistry(context);

    let logOutCalls = 0;
    class Security {
      logOut(): void {
        logOutCalls += 1;
      }
    }
    defineSecurity(context, defined, Security);

    let calls = 0;
    class Manager {
      setAccountInfo(): string {
        calls += 1;
        return "original";
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );

    const instance = new Manager() as unknown as Record<string, unknown>;
    return {
      context,
      manager: {
        get calls() {
          return calls;
        },
        instance,
      },
      logOuts: () => logOutCalls,
    };
  }

  function defineSecurity(
    context: PreloadContext,
    defined: Record<string, unknown>,
    Security: new () => unknown,
  ): void {
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );
  }

  test("flag false: the wrapper delegates (zero behavior change on merge)", async () => {
    const f = await fixture("https://x/manager.html?external-view=active");
    (f.manager.instance["setAccountInfo"] as (...a: unknown[]) => unknown)();
    expect(f.manager.calls).toBe(1);
  });

  test("flag true + no session: ends the session and never calls the original", async () => {
    const f = await fixture(
      "https://x/manager.html?external-view=active&module=player-info&external-view-guard=1",
    );
    (f.manager.instance["setAccountInfo"] as (...a: unknown[]) => unknown)();
    expect(f.manager.calls).toBe(0);
    expect(f.logOuts()).toBe(1);
  });

  test("flag true + authenticated: allowed module loads through the original", async () => {
    const f = await fixture(
      "https://x/manager.html?external-view=active&module=player-info&external-view-guard=1",
      { session: { customerID: "C1" } },
    );
    (f.manager.instance["setAccountInfo"] as (...a: unknown[]) => unknown)();
    expect(f.manager.calls).toBe(1);
  });

  test("flag true + traversal module: rejected before the original runs", async () => {
    const f = await fixture(
      "https://x/manager.html?external-view=active&module=../../evil&external-view-guard=1",
      { session: { customerID: "C1" } },
    );
    (f.manager.instance["setAccountInfo"] as (...a: unknown[]) => unknown)();
    expect(f.manager.calls).toBe(0);
  });

  test("rejected module ids are buffered and flushed to system/log.write", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://x/manager.html?external-view=active&module=../../evil&external-view-guard=1",
      { session: { customerID: "C1" } },
    );
    const defined = withRegistry(context);

    const writes: Record<string, unknown>[] = [];
    class Log {
      write(payload: Record<string, unknown>): void {
        writes.push(payload);
      }
    }
    defined["system/log"] = Log;

    class Security {
      logOut(): void {
        // not reached: the session is valid
      }
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );

    let calls = 0;
    class Manager {
      setAccountInfo(): void {
        calls += 1;
      }
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const instance = new Manager() as unknown as Record<string, unknown>;
    (instance["setAccountInfo"] as (...a: unknown[]) => unknown)();

    expect(calls).toBe(0);
    const rejections = context.window["__F402_REJECTS__"] as Array<
      Record<string, unknown>
    >;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.["reason"]).toBe("module-not-allowed");
    expect(rejections[0]?.["module"]).toBe("../../evil");
    expect(rejections[0]?.["flushed"]).toBe(true);
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.["description"])).toContain("../../evil");
  });

  test("a reject is buffered until the log module resolves, then swept", async () => {
    const source = await preloadSource();
    const context = runPreload(
      source,
      "https://x/manager.html?external-view=active&module=../../evil&external-view-guard=1",
      { session: { customerID: "C1" } },
    );
    const defined = withRegistry(context);

    class Security {
      logOut(): void {}
    }
    defined["system/security"] = Security;
    decorateNamed(
      context,
      "system/security",
      Security as unknown as Record<string, unknown>,
    );

    class Manager {
      setAccountInfo(): void {}
    }
    defined["manager/manager"] = Manager;
    decorateNamed(
      context,
      "manager/manager",
      Manager as unknown as Record<string, unknown>,
    );
    const managerInstance = new Manager() as unknown as Record<string, unknown>;
    (managerInstance["setAccountInfo"] as (...a: unknown[]) => unknown)();

    const rejections = context.window["__F402_REJECTS__"] as Array<
      Record<string, unknown>
    >;
    expect(rejections[0]?.["flushed"]).toBe(false);

    const writes: Record<string, unknown>[] = [];
    class Log {
      write(payload: Record<string, unknown>): void {
        writes.push(payload);
      }
    }
    defined["system/log"] = Log;
    const seams = context.window["__F402_SEAMS__"] as { sweep: () => boolean };
    seams.sweep();
    expect(rejections[0]?.["flushed"]).toBe(true);
    expect(writes).toHaveLength(1);
  });

  test("guard is inert outside the active external-view branch and installs once", async () => {
    const f = await fixture(
      "https://x/manager.html?module=player-info&external-view-guard=1",
      { session: { customerID: "C1" } },
    );
    decorateNamed(
      f.context,
      "manager/manager",
      (f.context.requirejs.s?.contexts._.defined["manager/manager"] ??
        {}) as unknown as Record<string, unknown>,
    );
    (f.manager.instance["setAccountInfo"] as (...a: unknown[]) => unknown)();
    expect(f.manager.calls).toBe(1);
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

  test("structural failures are issues; an unverified session is a note and exit 2", () => {
    const broken = goodProbe();
    broken.ownProperties["csrf"] = false;
    broken.allowed["bet-ticker"] = false;
    broken.authenticated = false;
    const outcome = evaluateSeamProbe(broken, leaves);
    expect(outcome.structural).toBe("fail");
    expect(outcome.issues.join(" ")).toContain("not an own property: csrf");
    expect(outcome.issues.join(" ")).toContain("isAllowedModule(bet-ticker)");
    expect(outcome.issues.join(" ")).not.toContain("isAuthenticated()");
    expect(outcome.notes.join(" ")).toContain("authenticated path unverified");
    expect(seamProbeExitCode(outcome)).toBe(1);

    const unauthenticated = goodProbe();
    unauthenticated.authenticated = false;
    const pass = evaluateSeamProbe(unauthenticated, leaves);
    expect(pass.structural).toBe("pass");
    expect(pass.issues).toEqual([]);
    expect(seamProbeExitCode(pass)).toBe(2);

    const clean = evaluateSeamProbe(goodProbe(), leaves);
    expect(seamProbeExitCode(clean)).toBe(0);
  });

  test("registry degradation is surfaced as a probe note", () => {
    const probe = goodProbe();
    probe.diag = { seam: { registryDegraded: true } };
    const notes = evaluateSeamProbe(probe, leaves).notes.join(" ");
    expect(notes).toContain("requirejs registry degraded");
  });

  test("render expectation parses and gates canary exit 0", () => {
    const script = buildRenderCheckScript("[data-wager-number]");
    expect(script).toContain("[data-wager-number]");
    expect(script).toContain("querySelectorAll");

    const matched = parseRenderCheck(
      JSON.stringify({
        selector: "[data-wager-number]",
        matched: true,
        count: 3,
        error: null,
      }),
    );
    expect(matched.count).toBe(3);

    const clean = evaluateSeamProbe(goodProbe(), leaves);
    expect(canaryExitCode(clean, matched)).toBe(0);

    const missing = parseRenderCheck(
      JSON.stringify({
        selector: "[data-wager-number]",
        matched: false,
        count: 0,
        error: null,
      }),
    );
    expect(canaryExitCode(clean, missing)).toBe(1);

    const unauthenticated = goodProbe();
    unauthenticated.authenticated = false;
    expect(
      canaryExitCode(evaluateSeamProbe(unauthenticated, leaves), missing),
    ).toBe(2);

    expect(canaryExitCode(clean, null)).toBe(0);
  });

  test("flag on without the manager wrapper is a structural failure; install failure is noted", () => {
    const probe = goodProbe();
    probe.diag = {
      seam: { externalViewGuard: true, managerGuardInstalled: false },
    };
    const outcome = evaluateSeamProbe(probe, leaves);
    expect(outcome.structural).toBe("fail");
    expect(outcome.issues.join(" ")).toContain("wrapper is not installed");
    expect(seamProbeExitCode(outcome)).toBe(1);

    const withFailure = goodProbe();
    withFailure.diag = {
      seam: {
        externalViewGuard: true,
        managerGuardInstalled: true,
        managerGuardFailure: "setAccountInfo-missing",
      },
    };
    expect(evaluateSeamProbe(withFailure, leaves).issues).toEqual([]);
    expect(evaluateSeamProbe(withFailure, leaves).notes.join(" ")).toContain(
      "wrapper install failure",
    );
  });

  test("exit-code contract distinguishes covered/uncovered and completed/could-not-run", () => {
    const uncovered = {
      covered: false,
      structural: "not-covered" as const,
      issues: [],
      notes: [],
      csrf: null,
      authenticated: null,
      diag: null,
    };
    expect(seamProbeExitCode(uncovered)).toBe(3);
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
    expect(outcome.structural).toBe("not-covered");
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
