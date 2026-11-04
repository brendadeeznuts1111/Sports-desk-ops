import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManagedWebView, WebViewError } from "../scripts/capture/webview.ts";
import { hasCdp } from "./support/capabilities.ts";

/**
 * Chrome backend coverage for `ManagedWebView`.
 *
 * The other WebView test (`bun_webview_screenshot.test.ts`) is WebKit-only and
 * skipped on darwin, so nothing exercised the Chrome/CDP path that CI (ubuntu)
 * actually runs. Chrome sizes the *outer* window in the constructor
 * (inner = max(500, width) x height-87) and only accepts
 * `Emulation.setDeviceMetricsOverride` after the first navigation creates a
 * CDP session; these tests pin the post-navigation viewport fix, deferred
 * pre-navigation resize, resize, and the CDP session requirement.
 *
 * The page is served by a local `Bun.serve` on 127.0.0.1; no outbound network.
 */

/** Executables Chrome-for-testing installs expose through `Bun.which`. */
const PATH_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
  "microsoft-edge",
] as const;

/** GUI installs on macOS are app bundles, not PATH entries. */
const MAC_APP_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
] as const;

/** Find a Chrome-family executable without launching it. `null` = unavailable. */
function detectChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  which: (name: string) => string | null = (name) => Bun.which(name),
  exists: (path: string) => boolean = existsSync,
): string | null {
  // Bun.WebView honors BUN_CHROME_PATH; only report what the caller already set.
  const configured = process.env.BUN_CHROME_PATH;
  if (configured !== undefined && configured.length > 0) {
    return exists(configured) ? configured : null;
  }
  for (const name of PATH_CANDIDATES) {
    const found = which(name);
    if (found !== null && found.length > 0) return found;
  }
  if (platform === "darwin") {
    for (const path of MAC_APP_CANDIDATES) {
      if (exists(path)) return path;
    }
  }
  return null;
}

const chromePath = detectChromeExecutable();
const SKIP_REASON =
  "no Chrome/Chromium/Edge executable found (looked up " +
  `${PATH_CANDIDATES.join(", ")} on PATH, plus the macOS app bundles)`;

// `bun test` does not print skipped test names, so surface the reason once.
if (chromePath === null) {
  console.warn(`[bun_webview_chrome] skipped: ${SKIP_REASON}`);
}

const PAGE_HTML = `<!doctype html><html><head><title>chrome-test</title></head><body style="margin:0"></body></html>`;
const FORM_HTML = `<!doctype html><html><head><title>chrome-form</title></head><body style="margin:0"><input id="i" style="display:block;width:120px;height:24px"></body></html>`;

let server: ReturnType<typeof Bun.serve> | undefined;
let baseUrl = "";

/**
 * Start the local page server. Called from the suite's `beforeAll`, so a
 * skipped run (no Chrome) never binds a port.
 */
function startPageServer(): void {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);
      const html = pathname === "/form" ? FORM_HTML : PAGE_HTML;
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
}

/** Inner viewport as the page sees it (CSS pixels). */
async function innerSize(
  view: ManagedWebView,
): Promise<{ w: number; h: number }> {
  const size = await view.evaluate("({w: innerWidth, h: innerHeight})");
  expect(size).toBeTypeOf("object");
  const { w, h } = size as { w: number; h: number };
  expect(typeof w).toBe("number");
  expect(typeof h).toBe("number");
  return { w, h };
}

/**
 * Decode a PNG blob's pixel dimensions via `Bun.Image`. Decoding is lazy:
 * `width`/`height` stay -1 until `metadata()` has been awaited.
 */
async function pngSize(blob: Blob): Promise<{ width: number; height: number }> {
  expect(blob.type).toBe("image/png");
  const image = new Bun.Image(blob);
  await image.metadata();
  return { width: image.width, height: image.height };
}

// Runs with or without Chrome: pins the gate that decides the suite below.
describe("chrome detection gate", () => {
  test("PATH first, then macOS bundles, otherwise null", () => {
    const saved = process.env.BUN_CHROME_PATH;
    delete process.env.BUN_CHROME_PATH;
    try {
      expect(
        detectChromeExecutable(
          "linux",
          () => null,
          () => false,
        ),
      ).toBeNull();
      expect(
        detectChromeExecutable(
          "linux",
          (name) => (name === "chromium" ? "/usr/bin/chromium" : null),
          () => false,
        ),
      ).toBe("/usr/bin/chromium");
      expect(
        detectChromeExecutable(
          "darwin",
          () => null,
          (path) => path === MAC_APP_CANDIDATES[0],
        ),
      ).toBe(MAC_APP_CANDIDATES[0]);
      // App bundles are a macOS-only fallback.
      expect(
        detectChromeExecutable(
          "linux",
          () => null,
          () => true,
        ),
      ).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.BUN_CHROME_PATH;
      else process.env.BUN_CHROME_PATH = saved;
    }
  });
});

describe.skipIf(chromePath === null || !hasCdp)(
  chromePath === null
    ? `ManagedWebView chrome backend (skipped: ${SKIP_REASON})`
    : "ManagedWebView chrome backend (CDP viewport)",
  () => {
    beforeAll(startPageServer);

    afterAll(async () => {
      await server?.stop(true);
      server = undefined;
    });

    test("launch size applies after navigate, and the screenshot matches it", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
      });
      try {
        // The constructor alone gives 500x63 on Chrome; only the CDP
        // override after the first navigation makes it 200x150.
        await view.navigate(`${baseUrl}/`);
        expect(await innerSize(view)).toEqual({ w: 200, h: 150 });

        const blob = await view.screenshotBlob({ format: "png" });
        expect(await pngSize(blob)).toEqual({ width: 200, height: 150 });
      } finally {
        await view.close();
      }
    }, 30_000);

    test("resize after navigate changes the live viewport", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 800,
        height: 600,
      });
      try {
        await view.navigate(`${baseUrl}/`);
        expect(await innerSize(view)).toEqual({ w: 800, h: 600 });

        await view.resize(640, 400);
        expect(await innerSize(view)).toEqual({ w: 640, h: 400 });

        const blob = await view.screenshotBlob({ format: "png" });
        expect(await pngSize(blob)).toEqual({ width: 640, height: 400 });
      } finally {
        await view.close();
      }
    }, 30_000);

    test("resize before navigate resolves and is applied by the next navigate", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
      });
      try {
        // No CDP session yet: the native resize cannot run, but the stored
        // dimensions must not throw and must be applied on navigation.
        await view.resize(320, 240);
        await view.navigate(`${baseUrl}/`);
        expect(await innerSize(view)).toEqual({ w: 320, h: 240 });
      } finally {
        await view.close();
      }
    }, 30_000);

    test("screenshot rotate swaps the captured dimensions", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
      });
      try {
        await view.navigate(`${baseUrl}/`);

        // Baseline: no transform requested, Chrome's own encode path.
        const plain = await view.screenshotBlob({ format: "png" });
        expect(await pngSize(plain)).toEqual({ width: 200, height: 150 });

        // rotate must force the Bun.Image path and rotate the pixels.
        const rotated = await view.screenshotBlob({
          format: "png",
          rotate: 90,
        });
        expect(await pngSize(rotated)).toEqual({ width: 150, height: 200 });

        // The base64 path forwards rotate too, not just the blob path.
        const rotatedBase64 = await view.screenshotBase64({
          format: "png",
          rotate: 90,
        });
        const image = new Bun.Image(
          Buffer.from(rotatedBase64.base64, "base64"),
        );
        await image.metadata();
        expect({ width: image.width, height: image.height }).toEqual({
          width: 150,
          height: 200,
        });
      } finally {
        await view.close();
      }
    }, 30_000);

    test("a failed launch does not pin the chrome dataStore directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "webview-datastore-"));
      const dirA = join(dir, "a");
      const dirB = join(dir, "b");
      const dirC = join(dir, "c");
      const dirD = join(dir, "d");
      for (const path of [dirA, dirB, dirC, dirD]) {
        mkdirSync(path, { recursive: true });
      }

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "));
      };
      const datastoreWarnings = (): string[] =>
        warnings.filter((line) => line.includes("chrome dataStore"));
      const views: ManagedWebView[] = [];
      try {
        // Launch A never creates a view: the native constructor rejects the
        // width before spawning Chrome. It must not pin --user-data-dir.
        let failed: unknown;
        try {
          ManagedWebView.launch({
            backend: "chrome",
            width: 0,
            height: 150,
            dataStoreDir: dirA,
          });
        } catch (error) {
          failed = error;
        }
        expect(failed).toBeInstanceOf(WebViewError);
        expect((failed as WebViewError).code).toBe("launch-failed");
        expect(datastoreWarnings()).toEqual([]);

        // Launch B succeeds: dirB is the directory that actually won.
        views.push(
          ManagedWebView.launch({
            backend: "chrome",
            width: 200,
            height: 150,
            dataStoreDir: dirB,
          }),
        );
        expect(datastoreWarnings()).toEqual([]);

        // Launch C asks for a different dir: exactly one warning, once.
        views.push(
          ManagedWebView.launch({
            backend: "chrome",
            width: 200,
            height: 150,
            dataStoreDir: dirC,
          }),
        );
        const pinned = datastoreWarnings();
        expect(pinned.length).toBe(1);
        expect(pinned[0]).toContain(dirC);
        expect(pinned[0]).toContain(dirB);

        // Launch D asks for yet another dir: the warning is not repeated.
        views.push(
          ManagedWebView.launch({
            backend: "chrome",
            width: 200,
            height: 150,
            dataStoreDir: dirD,
          }),
        );
        expect(datastoreWarnings().length).toBe(1);
      } finally {
        console.warn = originalWarn;
        for (const view of views) await view.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test("cdp rejects before navigate and works after primeCdpSession", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
      });
      try {
        let rejected: unknown;
        try {
          await view.cdp("Browser.getVersion");
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(WebViewError);
        expect((rejected as WebViewError).code).toBe("cdp-failed");
        expect((rejected as WebViewError).message).toContain(
          "CDP Browser.getVersion failed",
        );

        await view.primeCdpSession();
        const version = await view.cdp("Browser.getVersion");
        expect(version).toBeTypeOf("object");
        const product = (version as { product?: unknown }).product;
        expect(typeof product).toBe("string");
        expect(product as string).toMatch(/^[A-Za-z][A-Za-z0-9]*\/[\d.]+/);
      } finally {
        await view.close();
      }
    }, 30_000);

    test("fill keeps focus by default", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 320,
        height: 240,
      });
      try {
        await view.navigate(`${baseUrl}/form`);
        await view.fill("#i", "hello");
        expect(await view.evaluate("document.activeElement.id")).toBe("i");
        expect(await view.evaluate('document.querySelector("#i").value')).toBe(
          "hello",
        );
      } finally {
        await view.close();
      }
    }, 30_000);

    test("onNavigated fires and data:/about:blank are opt-in", async () => {
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
      });
      const seen: { url: string; title: string }[] = [];
      view.onNavigated = (url, title) => seen.push({ url, title });
      try {
        await view.navigate(`${baseUrl}/`);
        expect(seen.length).toBeGreaterThan(0);
        expect(typeof seen[seen.length - 1]?.title).toBe("string");

        let rejected: unknown;
        try {
          await view.navigate("data:text/html,<title>D</title>x");
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(WebViewError);
        expect((rejected as WebViewError).code).toBe("invalid-url");

        const dataState = await view.navigate(
          "data:text/html,<title>D</title>x",
          { allowDataUrl: true },
        );
        expect(dataState.url.startsWith("data:")).toBe(true);
        expect(await view.evaluate("document.title")).toBe("D");

        await view.navigate("about:blank", { allowOpaqueUrl: true });
        expect(view.url).toBe("about:blank");
      } finally {
        await view.close();
      }
    }, 30_000);

    test("onNavigationFailed fires on a refused connection", async () => {
      const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
      const deadPort = probe.port;
      await probe.stop(true);
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
        navigateTimeoutMs: 2_000,
      });
      let failed: Error | undefined;
      view.onNavigationFailed = (error) => {
        failed = error;
      };
      try {
        let rejected: unknown;
        try {
          await view.navigate(`http://127.0.0.1:${deadPort}/`);
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(WebViewError);
        expect(failed).toBeInstanceOf(Error);
      } finally {
        await view.close();
      }
    }, 30_000);

    test("screenshotToFile placeholder is opt-in", async () => {
      const dir = mkdtempSync(join(tmpdir(), "webview-shot-"));
      const view = ManagedWebView.launch({
        backend: "chrome",
        width: 200,
        height: 150,
      });
      try {
        await view.navigate(`${baseUrl}/`);
        const plain = await view.screenshotToFile(join(dir, "plain.png"), {
          format: "png",
        });
        const rich = await view.screenshotToFile(
          join(dir, "rich.png"),
          { format: "png" },
          { placeholder: true },
        );
        expect(plain.placeholder).toBeUndefined();
        expect(typeof rich.placeholder).toBe("string");
        expect(rich.placeholder?.startsWith("data:image/png;base64,")).toBe(
          true,
        );
      } finally {
        await view.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
