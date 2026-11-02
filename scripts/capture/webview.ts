/**
 * Bun.WebView wrapper — the live-auth half of evidence capture.
 *
 * Built on the probed Bun 1.4.4 API: `title`/`url`/`loading` are properties,
 * `onNavigated` is an assignable callback, `evaluate` needs a single expression
 * or IIFE, `screenshot` supports `encoding: "blob" | "buffer" | "base64" | "shmem"`,
 * `cdp` is a command-only sender (+ `EventTarget` listeners for CDP events), and
 * teardown uses `view.close()` / `[Symbol.dispose]` (+ `Bun.WebView.closeAll()`
 * as a process-exit net).
 *
 * The wrapper exists so the CLI can be tested without a browser: load-wait and
 * fill-expression logic are pure exported helpers, and the CLI takes an
 * injectable browser runner.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  computeImagePlaceholder,
  encodeScreenshotBlob,
  encodeScreenshotDataUrl,
  formatKittyShmemEscape,
  mimeTypeForFormat,
  toScreenshotDataUri,
  type ResizeSpec,
  type ScreenshotFormat,
  type ScreenshotMimeType,
  type ShmemGraphicSegment,
} from "../../lib/screenshot_encode.ts";
import { parseCdpCookies, type CdpCookie } from "./cookies.ts";
import { sha256Hex } from "./json.ts";
import { imageErrorCode } from "../../lib/image_errors.ts";
import { redactError, redactString, redactUrlForLog } from "./redact.ts";

export type WebViewErrorCode =
  | "launch-failed"
  | "unsupported-backend"
  | "invalid-url"
  | "invalid-selector"
  | "invalid-size"
  | "navigate-failed"
  | "load-timeout"
  | "selector-timeout"
  | "evaluate-failed"
  | "fill-failed"
  | "click-failed"
  | "press-failed"
  | "scroll-failed"
  | "screenshot-failed"
  | "cdp-failed"
  | "cookies-failed"
  | "closed";

export class WebViewError extends Error {
  readonly code: WebViewErrorCode;

  constructor(code: WebViewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebViewError";
    this.code = code;
  }
}

/** Keeps the `Bun.Image` code in the message and the original error as `cause`. */
function screenshotFailed(what: string, error: unknown): WebViewError {
  const image = imageErrorCode(error);
  return new WebViewError(
    "screenshot-failed",
    `${what} failed${image === undefined ? "" : ` (${image})`}: ${redactError(error)}`,
    { cause: error },
  );
}

export interface WebViewLaunchOptions {
  width?: number;
  height?: number;
  /** CDP requires the Chrome backend; webkit has no `cdp()`. */
  backend?: "chrome" | "webkit";
  /**
   * Persist cookies/storage across runs. WebKit needs macOS 15.2+.
   *
   * Chrome routes this through `--user-data-dir`, which is process-wide: the
   * first view's directory wins and later views reuse it (Bun logs a one-time
   * warning when a later launch asks for a different directory). WebKit keeps
   * storage per view, so a second view really does get its own directory.
   */
  dataStoreDir?: string;
  /** Route the browser subprocess's stdout to Bun's (Chrome: `"ignore"` by default). */
  stdout?: "inherit" | "ignore";
  /** Route the browser subprocess's stderr to Bun's (Chrome is chatty; useful when it dies silently). */
  stderr?: "inherit" | "ignore";
  navigateTimeoutMs?: number;
  pollMs?: number;
  consoleLimit?: number;
}

export interface ConsoleLine {
  level: "log" | "error" | "warn";
  /** Redacted, single-line text. Page console output is untrusted input. */
  text: string;
}

export interface PageState {
  url: string;
  title: string;
  loading: boolean;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
  sha256: string;
  mimeType: ScreenshotMimeType;
  /** ThumbHash blur-up data URL (`data:image/png;base64,...`) from `Bun.Image.prototype.placeholder()`. */
  placeholder?: string;
}

export interface Base64ScreenshotResult {
  base64: string;
  mimeType: ScreenshotMimeType;
  dataUri: string;
}

export type ScreenshotOptions =
  | {
      format: "png";
      palette?: boolean;
      resize?: ResizeSpec;
      /** Clockwise rotation in degrees (applied after resize, before encode). */
      rotate?: number;
    }
  | {
      format: "jpeg";
      quality?: number;
      progressive?: boolean;
      resize?: ResizeSpec;
      /** Clockwise rotation in degrees (applied after resize, before encode). */
      rotate?: number;
    }
  | {
      format: "webp";
      quality?: number;
      lossless?: boolean;
      resize?: ResizeSpec;
      /** Clockwise rotation in degrees (applied after resize, before encode). */
      rotate?: number;
    };

/** Read-side contract used by the pure load-wait helper (fake in tests). */
export interface LoadState {
  url: string;
  title: string;
  loading: boolean;
  lastNavigatedUrl: string | null;
}

export interface LoadWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Require the URL to differ from this value (post-submit navigation). */
  requireUrlChangeFrom?: string;
  /** Allow `data:` URLs to count as settled (some portals bootstrap that way). */
  allowDataUrl?: boolean;
  /**
   * Allow an opaque bootstrap URL (`about:blank` / empty) to count as settled
   * once it has loaded. The native title is not required: WebKit reports
   * `view.title === ""` on every navigation. Some portals (fantasy402) serve
   * their SPA while the native view still reports `about:blank`.
   */
  allowOpaqueUrl?: boolean;
}

export const DEFAULT_NAVIGATE_TIMEOUT_MS = 15_000;
export const DEFAULT_POLL_MS = 100;
const DEFAULT_CONSOLE_LIMIT = 200;
const MAX_CONSOLE_TEXT = 500;
const MAX_VIEWPORT_DIMENSION = 16_384;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSettledUrl(
  url: string,
  allowDataUrl: boolean,
  allowOpaqueUrl: boolean = false,
): boolean {
  if (url.length === 0) return allowOpaqueUrl;
  if (url === "about:blank") return allowOpaqueUrl;
  if (url.startsWith("chrome-error://") || url.startsWith("chrome://")) {
    return false;
  }
  if (url.startsWith("data:")) return allowDataUrl;
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Poll `read()` until the page has loaded and its URL is a real http(s) page.
 * Pure over injected `sleep`/`now` so tests can make it deterministic.
 */
export async function waitForLoadState(
  read: () => LoadState,
  options: LoadWaitOptions = {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
  now: () => number = Date.now,
): Promise<{ url: string; title: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = read();
    const changed =
      options.requireUrlChangeFrom === undefined ||
      state.url !== options.requireUrlChangeFrom;
    if (
      !state.loading &&
      changed &&
      isSettledUrl(
        state.url,
        options.allowDataUrl === true,
        // WebKit reports view.title === "" on every navigation, so an opaque
        // bootstrap page must not require a title to count as settled.
        options.allowOpaqueUrl === true,
      )
    ) {
      return { url: state.url, title: state.title };
    }
    if (now() >= deadline) {
      const reason = state.loading
        ? "still loading"
        : "not a settled http(s) page";
      throw new WebViewError(
        "load-timeout",
        `page did not settle within ${timeoutMs}ms (${reason}; url=${redactUrlForLog(state.url)})`,
      );
    }
    await sleep(pollMs);
  }
}

/** JSON/JS-escape a value for safe interpolation into an evaluate expression. */
export function escapeForExpression(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the IIFE used to clear and focus an input before `type()`.
 * The selector is JSON-encoded, so a hostile selector cannot break out.
 */
export function buildFillExpression(selector: string): string {
  const encoded = escapeForExpression(selector);
  return `(() => { const el = document.querySelector(${encoded}); if (el === null || typeof el.focus !== "function") return false; el.value = ""; el.focus(); return true; })()`;
}

/** Build the IIFE used to read a page identity snapshot without touching DOM secrets. */
export function buildPageProbeExpression(): string {
  return `(() => ({ url: location.href, title: document.title, bodyLength: document.body === null ? 0 : (document.body.innerText || "").length, hasPasswordField: document.querySelector("input[type=password]") !== null }))()`;
}

let exitCleanupRegistered = false;

/** Register the process-exit safety net once; never called in unit tests. */
export function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    try {
      void Bun.WebView.closeAll();
    } catch {
      // Process exit: nothing actionable left to do.
    }
  });
}

type BunWebViewInstance = InstanceType<typeof Bun.WebView>;

/**
 * Chrome's `--user-data-dir` is process-wide: the first view's
 * `dataStore.directory` wins and every later view reuses it. Remember the
 * directory that actually won so a conflicting request is reported once
 * instead of pretending it applied. Only a *successful* launch pins the
 * directory: a launch that throws never created a view, so it must not consume
 * the warning. WebKit storage is per view and never consults this.
 */
let chromeDataStoreDir: string | undefined;
let chromeDataStoreDirWarned = false;

function noteChromeDataStoreDir(requested: string): void {
  if (chromeDataStoreDir === undefined) {
    chromeDataStoreDir = requested;
    return;
  }
  if (chromeDataStoreDir === requested || chromeDataStoreDirWarned) return;
  chromeDataStoreDirWarned = true;
  // A profile path is operator input; redactString keeps it from echoing a
  // cookie/token-shaped value. Directory names only, never cookie contents.
  console.warn(
    `[webview] chrome dataStore: ignoring ${redactString(requested)} — the first view already pinned --user-data-dir to ${redactString(chromeDataStoreDir)} (Chrome's profile directory is process-wide, first view wins)`,
  );
}

/** Owns exactly one Bun.WebView; use `launch()` then `close()` in a finally. */
export class ManagedWebView {
  private readonly view: BunWebViewInstance;
  private readonly backend: "chrome" | "webkit";
  private readonly consoleLines: ConsoleLine[];
  private readonly consoleLimit: number;
  private readonly navigateTimeoutMs: number;
  private readonly pollMs: number;
  /**
   * Launch-ordering seam: every page operation awaits it before touching the
   * view. It resolves immediately — the viewport is NOT applied here, because
   * Chrome cannot `Emulation.setDeviceMetricsOverride` until a CDP session exists
   * (i.e. after the first navigation).
   */
  private readyPromise: Promise<void> = Promise.resolve();
  /** Viewport requested at launch (or by the last `resize()`), in CSS pixels. */
  private viewportWidth: number;
  private viewportHeight: number;
  /** True once `view.resize()` has succeeded against a live CDP session. */
  private viewportApplied = false;
  /**
   * True once a `view.navigate()` call has succeeded. Before that Chrome has no
   * CDP session, so a native resize fails with a wrapped `Emulation...` error
   * even though the requested dims are still valid for the next navigation.
   */
  private hasNavigated = false;
  private lastNavigatedUrl: string | null = null;
  private navigatedListener: ((url: string, title: string) => void) | null =
    null;
  private navigationFailedListener: ((error: Error) => void) | null = null;
  private closed = false;

  private constructor(
    view: BunWebViewInstance,
    backend: "chrome" | "webkit",
    consoleLines: ConsoleLine[],
    options: WebViewLaunchOptions,
  ) {
    this.view = view;
    this.backend = backend;
    this.consoleLines = consoleLines;
    this.consoleLimit = options.consoleLimit ?? DEFAULT_CONSOLE_LIMIT;
    this.navigateTimeoutMs =
      options.navigateTimeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.viewportWidth = options.width ?? 1440;
    this.viewportHeight = options.height ?? 900;
  }

  /** Launch a headless WebView and wire navigation/console capture. */
  static launch(options: WebViewLaunchOptions = {}): ManagedWebView {
    registerExitCleanup();
    const backend = options.backend ?? "chrome";
    const consoleLines: ConsoleLine[] = [];
    const consoleLimit = options.consoleLimit ?? DEFAULT_CONSOLE_LIMIT;
    // Both backends accept the object form, so stdout/stderr reach the Chrome
    // subprocess (and the WebKit host) instead of being dropped on the floor.
    const browserBackend: Bun.WebView.Backend =
      backend === "chrome"
        ? {
            type: "chrome",
            // For unattended Chrome automation, pass `url: false` so Bun always
            // spawns a fresh headless instance instead of auto-connecting via
            // DevToolsActivePort.
            url: false,
            ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
            ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
          }
        : {
            type: "webkit",
            ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
            ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
          };
    let view: BunWebViewInstance;
    try {
      view = new Bun.WebView({
        width: options.width ?? 1440,
        height: options.height ?? 900,
        backend: browserBackend,
        ...(options.dataStoreDir === undefined
          ? {}
          : { dataStore: { directory: options.dataStoreDir } }),
        console: (type: string, ...args: unknown[]) => {
          if (consoleLines.length >= consoleLimit) return;
          consoleLines.push(formatConsoleEntry(type, args));
        },
      });
    } catch (error) {
      throw new WebViewError(
        "launch-failed",
        `failed to launch ${backend} WebView: ${redactError(error)}`,
      );
    }
    // Pin the directory only after the view exists. A throwing constructor
    // never created a view, so it must not make a later successful launch's
    // different directory look like an ignored conflict.
    if (backend === "chrome" && options.dataStoreDir !== undefined) {
      noteChromeDataStoreDir(options.dataStoreDir);
    }
    const managed = new ManagedWebView(view, backend, consoleLines, options);
    // No eager resize here: on Chrome the constructor sizes the *outer* window
    // (inner height = height - 87, inner width = max(500, width)) and
    // `Emulation.setDeviceMetricsOverride` fails until the first navigation
    // creates a CDP session. `applyViewport()` runs after navigation instead.
    view.onNavigated = (url: string, title: string) => {
      // Chrome calls this with an undefined title in some cases; normalize so
      // the public callback keeps the documented string signature.
      const normalizedTitle = typeof title === "string" ? title : "";
      managed.lastNavigatedUrl = url;
      managed.pushConsole(
        "log",
        `navigated: ${redactUrlForLog(url)} (${normalizedTitle})`,
      );
      managed.navigatedListener?.(url, normalizedTitle);
    };
    view.onNavigationFailed = (error: unknown) => {
      managed.pushConsole("error", `navigation failed: ${redactError(error)}`);
      managed.navigationFailedListener?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    };
    return managed;
  }

  get title(): string {
    return this.view.title;
  }

  get url(): string {
    return this.view.url;
  }

  get loading(): boolean {
    return this.view.loading;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Observe every successful navigation (including redirects). Fires before
   * the corresponding `navigate()` promise settles, matching `Bun.WebView`.
   * Chrome may pass an undefined title at callback time; it is normalized to "".
   */
  get onNavigated(): ((url: string, title: string) => void) | null {
    return this.navigatedListener;
  }

  set onNavigated(listener: ((url: string, title: string) => void) | null) {
    this.navigatedListener = listener;
  }

  /** Observe failed navigations before `navigate()` rejects. */
  get onNavigationFailed(): ((error: Error) => void) | null {
    return this.navigationFailedListener;
  }

  set onNavigationFailed(listener: ((error: Error) => void) | null) {
    this.navigationFailedListener = listener;
  }

  get pageState(): PageState {
    return {
      url: this.view.url,
      title: this.view.title,
      loading: this.view.loading,
    };
  }

  /** Redacted page console lines, bounded; never persisted by the capture store. */
  get consoleLog(): readonly ConsoleLine[] {
    return [...this.consoleLines];
  }

  private pushConsole(level: ConsoleLine["level"], text: string): void {
    if (this.consoleLines.length >= this.consoleLimit) return;
    this.consoleLines.push({
      level,
      text: redactString(text).slice(0, MAX_CONSOLE_TEXT),
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new WebViewError("closed", "WebView is closed");
  }

  /**
   * Await launch ordering before touching the view. The promise resolves
   * immediately; it is the seam that keeps page operations behind view creation
   * without deadlocking on a native resize that cannot run before navigation.
   */
  private async awaitReady(): Promise<void> {
    await this.readyPromise;
  }

  /**
   * Apply the requested viewport. Chrome rejects
   * `Emulation.setDeviceMetricsOverride` until a CDP session exists, so this runs
   * after the first successful navigation. A failure leaves the flag false so the
   * next navigation retries; it never fails the navigation itself.
   */
  private async applyViewport(): Promise<void> {
    if (this.viewportApplied) return;
    try {
      await this.view.resize(this.viewportWidth, this.viewportHeight);
      this.viewportApplied = true;
    } catch {
      // No CDP session yet (or the view is closing): retried after the next navigation.
    }
  }

  /**
   * Resize the viewport and remember it for later navigations.
   * `Bun.WebView.resize()` sets the exact inner viewport, unlike the
   * constructor's outer-window sizing on Chrome. Requires a live CDP session.
   *
   * Before the first navigation the native call cannot work yet, so a failure
   * there is silent: the dims are stored and `applyViewport()` applies them
   * right after the next navigation. After a navigation the same failure is a
   * real error.
   */
  async resize(width: number, height: number): Promise<void> {
    assertViewportDimension(width, "width");
    assertViewportDimension(height, "height");
    this.viewportWidth = width;
    this.viewportHeight = height;
    await this.awaitReady();
    this.assertOpen();
    try {
      await this.view.resize(width, height);
    } catch (error) {
      if (!this.hasNavigated) {
        // No CDP session yet: the next navigate() applies the stored dims.
        return;
      }
      // The stored dims no longer match the viewport; let the next navigation
      // retry them (applyViewport swallows its own failure).
      this.viewportApplied = false;
      throw new WebViewError(
        "invalid-size",
        `resize to ${width}x${height} failed: ${redactError(error)}`,
      );
    }
    this.viewportApplied = true;
  }

  /**
   * Establish the Chrome CDP session. The first navigation creates it, so
   * `cdp()` (and `screenshot()`) reject until then; `navigate()` is http(s)-only,
   * so the prime uses the one opaque URL Chrome accepts.
   */
  async primeCdpSession(): Promise<void> {
    if (this.backend !== "chrome") return;
    await this.awaitReady();
    this.assertOpen();
    await this.view.navigate("about:blank");
    this.hasNavigated = true;
    await this.applyViewport();
  }

  /** Navigate and resolve once the page has settled. */
  async navigate(
    url: string,
    options: LoadWaitOptions = {},
  ): Promise<PageState> {
    await this.awaitReady();
    this.assertOpen();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new WebViewError(
        "invalid-url",
        `navigate requires an absolute URL (got ${redactUrlForLog(url)})`,
      );
    }
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      !(options.allowDataUrl === true && parsed.protocol === "data:") &&
      !(options.allowOpaqueUrl === true && url === "about:blank")
    ) {
      throw new WebViewError(
        "invalid-url",
        `navigate only supports http(s) URLs (got ${parsed.protocol}) unless allowDataUrl/allowOpaqueUrl is set`,
      );
    }
    try {
      await this.view.navigate(url);
    } catch (error) {
      throw new WebViewError(
        "navigate-failed",
        `navigation to ${redactUrlForLog(url)} failed: ${redactError(error)}`,
      );
    }
    this.hasNavigated = true;
    // Chrome only accepts the viewport override once this navigation has created
    // the CDP session; applying it before `waitForLoad` means the settled page is
    // already laid out at the requested size.
    await this.applyViewport();
    await this.waitForLoad(options);
    return this.pageState;
  }

  /** Wait for a settled page (post-navigation, submit or reload). */
  async waitForLoad(options: LoadWaitOptions = {}): Promise<PageState> {
    await this.awaitReady();
    this.assertOpen();
    await waitForLoadState(
      () => ({
        url: this.view.url,
        title: this.view.title,
        loading: this.view.loading,
        lastNavigatedUrl: this.lastNavigatedUrl,
      }),
      {
        timeoutMs: options.timeoutMs ?? this.navigateTimeoutMs,
        pollMs: options.pollMs ?? this.pollMs,
        ...(options.requireUrlChangeFrom === undefined
          ? {}
          : { requireUrlChangeFrom: options.requireUrlChangeFrom }),
        ...(options.allowDataUrl === undefined
          ? {}
          : { allowDataUrl: options.allowDataUrl }),
        ...(options.allowOpaqueUrl === undefined
          ? {}
          : { allowOpaqueUrl: options.allowOpaqueUrl }),
      },
    );
    return this.pageState;
  }

  /**
   * Wait until `document.querySelector(selector)` exists and the document has
   * finished loading. Needed for SPAs whose shell "settles" before their
   * framework binds handlers (fantasy402): interacting earlier causes a native
   * form submit that discards the typed values.
   */
  async waitForSelector(
    selector: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<void> {
    await this.awaitReady();
    this.assertOpen();
    const timeoutMs = options.timeoutMs ?? this.navigateTimeoutMs;
    const pollMs = options.pollMs ?? this.pollMs;
    const encoded = escapeForExpression(selector);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let ready = false;
      try {
        ready =
          (await this.evaluate(
            `(() => document.readyState === "complete" && document.querySelector(${encoded}) !== null)()`,
          )) === true;
      } catch {
        ready = false;
      }
      if (ready) return;
      if (Date.now() >= deadline) {
        throw new WebViewError(
          "selector-timeout",
          `element not found within ${timeoutMs}ms: ${selector}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Evaluate one expression or IIFE (multi-statement strings are invalid). */
  async evaluate(expression: string): Promise<unknown> {
    await this.awaitReady();
    this.assertOpen();
    if (expression.trim().length === 0) {
      throw new WebViewError(
        "evaluate-failed",
        "evaluate requires an expression",
      );
    }
    try {
      return await this.view.evaluate(expression);
    } catch (error) {
      throw new WebViewError(
        "evaluate-failed",
        `evaluate failed: ${redactError(error)}`,
      );
    }
  }

  /** Wrap a multi-statement body in an IIFE before evaluating it. */
  async evaluateIife(body: string): Promise<unknown> {
    return this.evaluate(`(() => { ${body} })()`);
  }

  async click(
    selector: string,
    options?: Bun.WebView.ClickSelectorOptions,
  ): Promise<void> {
    await this.awaitReady();
    this.assertOpen();
    assertSelector(selector, "click");
    // Default to the wrapper's timeout: the native default is 30s, which hides
    // covered/occluded elements behind a much longer wait than `navigateTimeoutMs`.
    const clickOptions: Bun.WebView.ClickSelectorOptions = {
      ...options,
      timeout: options?.timeout ?? this.navigateTimeoutMs,
    };
    try {
      await this.view.click(selector, clickOptions);
    } catch (error) {
      throw new WebViewError(
        "click-failed",
        `click on ${selector} failed: ${redactError(error)}`,
      );
    }
  }

  async press(key: string, options?: Bun.WebView.PressOptions): Promise<void> {
    await this.awaitReady();
    this.assertOpen();
    if (key.trim().length === 0) {
      throw new WebViewError("press-failed", "press requires a key name");
    }
    try {
      await (options === undefined
        ? this.view.press(key as Bun.WebView.VirtualKey)
        : this.view.press(key as Bun.WebView.VirtualKey, options));
    } catch (error) {
      throw new WebViewError(
        "press-failed",
        `press ${key} failed: ${redactError(error)}`,
      );
    }
  }

  async scrollTo(
    selector: string,
    options?: Bun.WebView.ScrollToOptions,
  ): Promise<void> {
    await this.awaitReady();
    this.assertOpen();
    assertSelector(selector, "scrollTo");
    try {
      await (options === undefined
        ? this.view.scrollTo(selector)
        : this.view.scrollTo(selector, options));
    } catch (error) {
      throw new WebViewError(
        "scroll-failed",
        `scrollTo ${selector} failed: ${redactError(error)}`,
      );
    }
  }

  /**
   * Fill one input: click, clear+focus via IIFE, then type into the focused
   * element. Focus is kept by default so a following `press("Enter")` submits
   * the form the input belongs to; pass `{ blur: true }` to blur afterwards.
   * The typed value never appears in an evaluate expression or error.
   */
  async fill(
    selector: string,
    text: string,
    options?: { blur?: boolean },
  ): Promise<void> {
    await this.awaitReady();
    this.assertOpen();
    assertSelector(selector, "fill");
    await this.click(selector);
    const focused = await this.evaluate(buildFillExpression(selector));
    if (focused !== true) {
      throw new WebViewError(
        "fill-failed",
        `no fillable element matched selector ${selector}`,
      );
    }
    try {
      await this.view.type(text);
    } catch (error) {
      throw new WebViewError(
        "fill-failed",
        `typing into ${selector} failed: ${redactError(error)}`,
      );
    }
    if (options?.blur === true) {
      await this.evaluate(
        "(() => { if (document.activeElement) document.activeElement.blur(); return true; })()",
      );
    }
  }

  private needsBunImageTransform(options?: ScreenshotOptions): boolean {
    return (
      options !== undefined &&
      ((this.backend === "webkit" && options.format === "webp") ||
        options.resize !== undefined ||
        options.rotate !== undefined ||
        (options.format === "png" && options.palette === true) ||
        (options.format === "jpeg" && options.progressive === true) ||
        (options.format === "webp" && options.lossless === true))
    );
  }

  /**
   * Capture a screenshot as a `Blob` (`encoding: "blob"`, zero-copy mmap-backed on WebKit)
   * with its MIME type set (`image/png`, `image/jpeg`, `image/webp`), ready for `Bun.write()`,
   * `new Response(blob)`, or `new Bun.Image(blob)`.
   */
  async screenshotBlob(options?: ScreenshotOptions): Promise<Blob> {
    await this.awaitReady();
    this.assertOpen();
    const format = options?.format ?? "png";
    try {
      if (this.needsBunImageTransform(options) && options !== undefined) {
        const rawPng: unknown = await this.view.screenshot({
          encoding: "blob",
          format: "png",
        });
        const input =
          rawPng instanceof Blob || rawPng instanceof Uint8Array
            ? rawPng
            : new Uint8Array(rawPng as ArrayBuffer);
        const encodeOptions: {
          format: ScreenshotFormat;
          quality?: number;
          progressive?: boolean;
          lossless?: boolean;
          palette?: boolean;
          resize?: ResizeSpec;
          rotate?: number;
        } = { format: options.format };
        if (options.format === "png") {
          if (options.palette !== undefined)
            encodeOptions.palette = options.palette;
        } else if (options.format === "jpeg") {
          if (options.quality !== undefined)
            encodeOptions.quality = options.quality;
          if (options.progressive !== undefined) {
            encodeOptions.progressive = options.progressive;
          }
        } else {
          if (options.quality !== undefined)
            encodeOptions.quality = options.quality;
          if (options.lossless !== undefined)
            encodeOptions.lossless = options.lossless;
        }
        if (options.resize !== undefined) encodeOptions.resize = options.resize;
        if (options.rotate !== undefined) encodeOptions.rotate = options.rotate;
        return await encodeScreenshotBlob(input, encodeOptions);
      }

      const raw: unknown =
        options === undefined
          ? await this.view.screenshot({ encoding: "blob" })
          : options.format === "jpeg"
            ? await this.view.screenshot({
                encoding: "blob",
                format: "jpeg",
                quality: options.quality ?? 80,
              })
            : options.format === "webp"
              ? await this.view.screenshot({
                  encoding: "blob",
                  format: "webp",
                  quality: options.quality ?? 80,
                })
              : await this.view.screenshot({
                  encoding: "blob",
                  format: "png",
                });
      if (raw instanceof Blob) return raw;
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : new Uint8Array(raw as ArrayBufferLike);
      return new Blob([bytes], { type: mimeTypeForFormat(format) });
    } catch (error) {
      throw screenshotFailed("screenshot", error);
    }
  }

  /**
   * Capture a screenshot as a Base64 string + `data:` URI.
   * Uses `encoding: "base64"` directly when no `Bun.Image` transform is needed (zero-decode on Chrome).
   */
  async screenshotBase64(
    options?: ScreenshotOptions,
  ): Promise<Base64ScreenshotResult> {
    await this.awaitReady();
    this.assertOpen();
    const format = options?.format ?? "png";
    const mimeType = mimeTypeForFormat(format);
    try {
      if (!this.needsBunImageTransform(options)) {
        const raw: unknown =
          options === undefined
            ? await this.view.screenshot({ encoding: "base64" })
            : options.format === "jpeg"
              ? await this.view.screenshot({
                  encoding: "base64",
                  format: "jpeg",
                  quality: options.quality ?? 80,
                })
              : options.format === "webp"
                ? await this.view.screenshot({
                    encoding: "base64",
                    format: "webp",
                    quality: options.quality ?? 80,
                  })
                : await this.view.screenshot({
                    encoding: "base64",
                    format: "png",
                  });
        let base64: string;
        if (typeof raw === "string") {
          base64 = raw;
        } else if (raw instanceof Uint8Array) {
          base64 = Buffer.from(raw).toString("base64");
        } else {
          const bytes =
            raw instanceof ArrayBuffer
              ? new Uint8Array(raw)
              : new Uint8Array(await (raw as Blob).arrayBuffer());
          base64 = Buffer.from(bytes).toString("base64");
        }
        return {
          base64,
          mimeType,
          dataUri: toScreenshotDataUri(base64, format),
        };
      }
      const rawPng: unknown = await this.view.screenshot({
        encoding: "blob",
        format: "png",
      });
      const input =
        rawPng instanceof Blob || rawPng instanceof Uint8Array
          ? rawPng
          : new Uint8Array(rawPng as ArrayBuffer);
      const dataOptions: {
        format: ScreenshotFormat;
        quality?: number;
        progressive?: boolean;
        lossless?: boolean;
        palette?: boolean;
        resize?: ResizeSpec;
        rotate?: number;
      } = { format: options?.format ?? "png" };
      if (options?.format === "png") {
        if (options.palette !== undefined)
          dataOptions.palette = options.palette;
      } else if (options?.format === "jpeg") {
        if (options.quality !== undefined)
          dataOptions.quality = options.quality;
        if (options.progressive !== undefined) {
          dataOptions.progressive = options.progressive;
        }
      } else {
        if (options?.quality !== undefined)
          dataOptions.quality = options?.quality;
        if (options?.lossless !== undefined)
          dataOptions.lossless = options?.lossless;
      }
      if (options?.resize !== undefined) dataOptions.resize = options.resize;
      if (options?.rotate !== undefined) dataOptions.rotate = options.rotate;
      return await encodeScreenshotDataUrl(input, dataOptions);
    } catch (error) {
      if (error instanceof WebViewError) throw error;
      throw screenshotFailed("screenshot", error);
    }
  }

  /**
   * Compute a ThumbHash blur-up placeholder data URL (`data:image/png;base64,...`)
   * from the current viewport off the main thread via `Bun.Image.prototype.placeholder()`.
   */
  async screenshotPlaceholder(): Promise<string> {
    await this.awaitReady();
    this.assertOpen();
    try {
      const blob = await this.screenshotBlob({ format: "png" });
      return await computeImagePlaceholder(blob);
    } catch (error) {
      if (error instanceof WebViewError) throw error;
      throw screenshotFailed("placeholder screenshot", error);
    }
  }

  /**
   * Capture a screenshot into a POSIX shared-memory segment (`encoding: "shmem"`)
   * for Kitty terminal graphics protocol `t=s` transmission.
   * Note: the caller or Kitty terminal must `shm_unlink` the returned segment `name`.
   */
  async screenshotShmem(): Promise<ShmemGraphicSegment> {
    await this.awaitReady();
    this.assertOpen();
    if (process.platform === "win32") {
      // POSIX shared memory does not exist on Windows; fail before the native
      // call so the caller gets the reason instead of a spawn-level error.
      throw new WebViewError(
        "screenshot-failed",
        "shmem screenshots are not supported on Windows",
      );
    }
    try {
      const seg = await this.view.screenshot({ encoding: "shmem" });
      return formatKittyShmemEscape(seg);
    } catch (error) {
      throw new WebViewError(
        "screenshot-failed",
        `shmem screenshot failed: ${redactError(error)}`,
      );
    }
  }

  /**
   * Screenshot to a file using `screenshotBlob` (`encoding: "blob"` mmap-backed on WebKit
   * + `Bun.Image` when `webp`, `resize`, `rotate`, `palette`, `lossless`, or `progressive` is requested).
   *
   * The ThumbHash placeholder is opt-in (`{ placeholder: true }`): computing it
   * costs a decode and most callers ignore it.
   */
  async screenshotToFile(
    path: string,
    options?: ScreenshotOptions,
    behavior?: { placeholder?: boolean },
  ): Promise<ScreenshotResult> {
    await this.awaitReady();
    const format = options?.format ?? "png";
    const blob = await this.screenshotBlob(options);
    const [ab, placeholder] = await Promise.all([
      blob.arrayBuffer(),
      behavior?.placeholder === true
        ? computeImagePlaceholder(blob).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const bytes = new Uint8Array(ab);
    try {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, blob);
    } catch (error) {
      throw new WebViewError(
        "screenshot-failed",
        `writing screenshot to ${path} failed: ${redactError(error)}`,
      );
    }
    return {
      path,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mimeType: (blob.type as ScreenshotMimeType) || mimeTypeForFormat(format),
      ...(placeholder === undefined ? {} : { placeholder }),
    };
  }

  /** Send one CDP command (Chrome backend only). */
  async cdp(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    await this.awaitReady();
    this.assertOpen();
    if (this.backend !== "chrome") {
      throw new WebViewError(
        "unsupported-backend",
        `cdp() requires backend "chrome" (current: ${this.backend})`,
      );
    }
    if (method.trim().length === 0) {
      throw new WebViewError("cdp-failed", "cdp requires a command name");
    }
    try {
      return params === undefined
        ? await this.view.cdp(method)
        : await this.view.cdp(method, params);
    } catch (error) {
      throw new WebViewError(
        "cdp-failed",
        `CDP ${method} failed: ${redactError(error)}`,
      );
    }
  }

  /**
   * Subscribe to a CDP event via `EventTarget` (`Bun.WebView extends EventTarget`).
   * Call `await view.cdp("<Domain>.enable")` first so Chrome emits the domain's events.
   */
  onCdpEvent<T = unknown>(
    method: `${string}.${string}`,
    listener: (params: T) => void,
  ): () => void {
    this.assertOpen();
    if (this.backend !== "chrome") {
      throw new WebViewError(
        "unsupported-backend",
        `onCdpEvent() requires backend "chrome" (current: ${this.backend})`,
      );
    }
    const handler = (event: MessageEvent<T>): void => {
      listener(event.data);
    };
    this.view.addEventListener(method, handler);
    return () => {
      this.view.removeEventListener(
        method,
        handler as unknown as EventListener,
      );
    };
  }

  /** Read HttpOnly cookies via CDP (values are memory-only, never persisted). */
  async getAllCookies(): Promise<CdpCookie[]> {
    await this.awaitReady();
    this.assertOpen();
    const result = await this.cdp("Network.getAllCookies");
    try {
      return parseCdpCookies(result);
    } catch (error) {
      throw new WebViewError(
        "cookies-failed",
        `could not parse CDP cookies: ${redactError(error)}`,
      );
    }
  }

  /**
   * Close the WebView. `Bun.WebView.prototype.close()` is synchronous and idempotent;
   * `close()` stays async-compatible and aliases `[Symbol.dispose]` / `[Symbol.asyncDispose]`.
   */
  async close(): Promise<void> {
    this.disposeSync();
  }

  private disposeSync(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.view.close();
    } catch {
      // Per-view close is the teardown. Never escalate to Bun.WebView.closeAll()
      // here: it SIGKILLs every browser in the process, and a view launched
      // immediately afterwards fails with "Chrome process closed the pipe".
      // The process-exit net in registerExitCleanup() is the only escalation.
    }
  }

  [Symbol.dispose](): void {
    this.disposeSync();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposeSync();
  }
}

function assertSelector(selector: string, action: string): void {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    throw new WebViewError(
      "invalid-selector",
      `${action} requires a CSS selector`,
    );
  }
  if (/^\d+$/.test(trimmed)) {
    throw new WebViewError(
      "invalid-selector",
      `${action} expects a CSS selector, not a pixel count ("${trimmed}")`,
    );
  }
}

function assertViewportDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VIEWPORT_DIMENSION) {
    throw new WebViewError(
      "invalid-size",
      `${name} must be an integer in 1..${MAX_VIEWPORT_DIMENSION} (got ${value})`,
    );
  }
}

/**
 * Normalize a `Bun.WebView` `console: (type, ...args) => void` callback into a
 * redacted `ConsoleLine`. `type` is the first parameter (`"log" | "warn" | "error" | ...`);
 * Chrome reports warnings as `"warning"`, WebKit as `"warn"`, so both map to `"warn"`.
 */
export function formatConsoleEntry(
  type: string,
  args: readonly unknown[],
): ConsoleLine {
  const normalized = type.trim().toLowerCase();
  const level: ConsoleLine["level"] =
    normalized === "error"
      ? "error"
      : normalized === "warn" || normalized === "warning"
        ? "warn"
        : "log";
  return {
    level,
    text: formatConsoleArgs(args),
  };
}

function formatConsoleArgs(args: readonly unknown[]): string {
  const text = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  return redactString(text).replace(/\s+/g, " ").slice(0, MAX_CONSOLE_TEXT);
}
