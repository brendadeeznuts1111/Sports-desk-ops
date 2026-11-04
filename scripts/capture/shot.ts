/**
 * @file scripts/capture/shot.ts
 * @description The capture path shared by `dx shot` and the `shot` MCP tool: open a WebView, reach
 * the page, and write a screenshot file with its thumb, placeholder and console.
 */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ManagedWebView,
  WebViewError,
  type ConsoleLine,
  type WebViewErrorCode,
} from "./webview.ts";
import { describeCookiesForHost, type CookieMetadata } from "./cookies.ts";
import { loginF402 } from "./f402_login.ts";
import { hostOf } from "./ops.ts";
import { redactUrlForLog } from "./redact.ts";
import type { ScreenshotBlobUploadResult } from "../../lib/blob_upload.ts";
import type { ScreenshotEncoding } from "../../lib/screenshot_encode.ts";

export const DEFAULT_SHOT_DIR = "scratch/shots";

/** CSS-pixel bounds for a viewport (and `resize` output pixels); Bun accepts up to 16384. */
export const VIEWPORT_MIN = 1;
export const VIEWPORT_MAX = 16_384;

export type ShotBackend = "webkit" | "chrome";
export type ShotFormat = "png" | "jpeg" | "webp";

export interface ShotRequest {
  readonly url: string | null;
  readonly width: number;
  readonly height: number;
  readonly backend: ShotBackend;
  readonly format: ShotFormat;
  readonly quality: number;
  readonly resize: { width: number; height?: number } | null;
  readonly waitSelector: string | null;
  readonly waitMs: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly f402Login: boolean;
  readonly f402Page: string;
  readonly profile: string | null;
}

export interface ShotFileRequest extends ShotRequest {
  readonly out: string;
  readonly encoding: ScreenshotEncoding;
  readonly thumb: number | null;
  readonly placeholder: boolean;
  readonly console: boolean;
  readonly cookies: boolean;
}

/**
 * What a signed-out portal shows: the login form at `/`, and a "Your session has expired" dialog on
 * `/manager.html` (both seen 2026-11-02 with an empty WebKit profile).
 */
export type SignedOutMarker = "login-form" | "session-expired";

/** Present only with a profile: what the page showed, not a claim that the session is valid. */
export interface ProfileCheck {
  readonly profile: string;
  readonly signedOutMarkers: readonly SignedOutMarker[];
}

export interface ShotFileResult extends Partial<ProfileCheck> {
  readonly screenshot: string;
  readonly screenshotUrl: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType: string;
  readonly backend: ShotBackend;
  readonly format: ShotFormat;
  readonly encoding: ScreenshotEncoding;
  readonly title: string;
  readonly url: string;
  readonly thumb?: string;
  readonly placeholder?: string;
  readonly console?: readonly ConsoleLine[];
  readonly cookies?: readonly CookieMetadata[];
  /** Present only after `--upload-blob`. */
  readonly blob?: ScreenshotBlobUploadResult;
}

const SIGNED_OUT_MARKERS = `(() => {
  const markers = [];
  if (document.querySelector("input[type=password]") !== null) markers.push("login-form");
  if (/session has expired/i.test(document.body?.innerText ?? "")) markers.push("session-expired");
  return markers;
})()`;

export function parseSignedOutMarkers(value: unknown): SignedOutMarker[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (marker): marker is SignedOutMarker =>
      marker === "login-form" || marker === "session-expired",
  );
}

const SHOT_ERROR_HINTS: Readonly<Record<WebViewErrorCode, string>> = {
  "launch-failed":
    "check that the backend is installed (chrome needs a Chrome/Chromium binary)",
  "unsupported-backend": "use backend webkit (macOS) or chrome",
  "invalid-url": "pass an absolute http(s) URL",
  "invalid-selector": "pass a CSS selector such as #app, not a pixel count",
  "navigate-failed": "check the host is reachable, or retry with retries 1-5",
  "load-timeout":
    "retry with a higher timeout or retries 1-5, or check the host",
  "selector-timeout":
    "the selector never matched: check it against the page, or raise the timeout",
  "evaluate-failed": "the page script failed; capture without the page check",
  "fill-failed": "the field was not fillable; check the selector",
  "click-failed": "the element was not clickable; check the selector",
  "press-failed": "pass a key name such as Enter",
  "scroll-failed": "the page could not scroll; capture without scrolling",
  "screenshot-failed": "retry once; if it repeats, try the other backend",
  "cdp-failed": "the command needs backend chrome",
  "cookies-failed": "cookies need backend chrome",
  "invalid-size":
    "pass a viewport of 1..16384 CSS px; chrome must also have a live page",
  closed: "the view closed before the capture finished; retry",
};

/** `code: message. hint` — the one failure line both `dx shot` and the MCP tool print. */
export function describeShotError(error: WebViewError): string {
  return `${error.code}: ${error.message}. Next: ${SHOT_ERROR_HINTS[error.code]}`;
}

const RETRY_BACKOFF_MS = 500;

function isRetryable(error: unknown): boolean {
  return (
    error instanceof WebViewError &&
    (error.code === "navigate-failed" || error.code === "load-timeout")
  );
}

/** Retries only navigation failures and load timeouts; returns the number of attempts made. */
export async function navigateWithRetry(
  view: Pick<ManagedWebView, "navigate">,
  url: string,
  options: {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<number> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await view.navigate(url, { timeoutMs: options.timeoutMs });
      return attempt + 1;
    } catch (error) {
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
}

export function f402BaseUrl(): string {
  return (
    Bun.env.F402_BASE_URL?.trim() || "https://www.fantasy402.com"
  ).replace(/\/$/, "");
}

function f402Url(page: string): string {
  return `${f402BaseUrl()}${page.startsWith("/") ? page : `/${page}`}`;
}

export function defaultShotPath(
  format: ShotFormat,
  dir = DEFAULT_SHOT_DIR,
): string {
  const extension = format === "jpeg" ? "jpg" : format;
  return join(dir, `webview-${Bun.randomUUIDv7()}.${extension}`);
}

/** Launches, signs in when asked, navigates and settles. The caller owns disposal. */
export async function openShotView(
  request: ShotRequest,
): Promise<ManagedWebView> {
  const view = ManagedWebView.launch({
    backend: request.backend,
    width: request.width,
    height: request.height,
    navigateTimeoutMs: request.timeoutMs,
    ...(request.profile === null ? {} : { dataStoreDir: request.profile }),
  });
  try {
    if (request.f402Login) {
      if (Bun.env.F402_LIVE_LOGIN?.trim() !== "1") {
        throw new Error("F402 login is opt-in: set F402_LIVE_LOGIN=1");
      }
      await loginF402(view, { timeoutMs: request.timeoutMs });
    }
    const target =
      request.f402Login || request.url === null
        ? f402Url(request.f402Page)
        : request.url;
    await navigateWithRetry(view, target, {
      timeoutMs: request.timeoutMs,
      retries: request.retries,
    });
    // Bun's Chrome backend rejects Emulation.setDeviceMetricsOverride until the CDP session exists
    // (created by the first navigation), so the launch-time resize is a silent no-op for the first
    // page: a 200x150 capture comes back as the constructor's outer window size. WebKit sizes the
    // inner viewport from the constructor and needs no retry.
    if (request.backend === "chrome") {
      await view.resize(request.width, request.height);
    }
    if (request.waitSelector !== null) {
      await view.waitForSelector(request.waitSelector, {
        timeoutMs: request.timeoutMs,
      });
    }
    if (request.waitMs > 0) await Bun.sleep(request.waitMs);
    return view;
  } catch (error) {
    await view[Symbol.asyncDispose]();
    throw error;
  }
}

/** What {@link captureShotFile} needs from a view. */
export type ShotFileView = Pick<
  ManagedWebView,
  "evaluate" | "screenshotToFile" | "consoleLog" | "getAllCookies"
>;

let viewSlot: Promise<void> = Promise.resolve();

/**
 * Opens a view, runs `use`, and disposes the view only after `use` settles. One view at a time per
 * process: Bun.WebView is not safe to drive concurrently, and the MCP SDK dispatches tool calls
 * without waiting for the previous one. A failed call frees the slot for the next.
 */
export function withView<V extends AsyncDisposable, T>(
  open: () => Promise<V>,
  use: (view: V) => Promise<T>,
): Promise<T> {
  const run = viewSlot.then(async () => {
    await using view = await open();
    return await use(view);
  });
  viewSlot = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function checkProfile(
  view: Pick<ManagedWebView, "evaluate">,
  profile: string | null,
): Promise<ProfileCheck | null> {
  return profile === null
    ? null
    : {
        profile,
        signedOutMarkers: parseSignedOutMarkers(
          await view.evaluate(SIGNED_OUT_MARKERS),
        ),
      };
}

export function screenshotOptions(request: ShotRequest) {
  const resize = request.resize === null ? {} : { resize: request.resize };
  return request.format === "png"
    ? { format: "png" as const, ...resize }
    : { format: request.format, quality: request.quality, ...resize };
}

export async function captureShotFile(
  view: ShotFileView,
  request: ShotFileRequest,
): Promise<ShotFileResult> {
  const profileCheck = await checkProfile(view, request.profile);
  const screenshot = await view.screenshotToFile(
    request.out,
    screenshotOptions(request),
  );
  const thumbPath =
    request.thumb === null
      ? null
      : await writeThumb(screenshot.path, request.thumb);
  return {
    screenshot: screenshot.path,
    screenshotUrl: pathToFileURL(resolve(screenshot.path)).href,
    bytes: screenshot.bytes,
    sha256: screenshot.sha256,
    mimeType: screenshot.mimeType,
    backend: request.backend,
    format: request.format,
    encoding: request.encoding,
    title: String((await view.evaluate("document.title")) ?? ""),
    url: redactUrlForLog(String((await view.evaluate("location.href")) ?? "")),
    ...profileCheck,
    ...(thumbPath === null ? {} : { thumb: thumbPath }),
    ...(request.placeholder && screenshot.placeholder !== undefined
      ? { placeholder: screenshot.placeholder }
      : {}),
    ...(request.console ? { console: view.consoleLog } : {}),
    ...(request.cookies
      ? {
          cookies: describeCookiesForHost(
            await view.getAllCookies(),
            hostOf(f402BaseUrl()),
          ),
        }
      : {}),
  };
}

async function writeThumb(screenshotPath: string, px: number): Promise<string> {
  const thumbPath = `${screenshotPath.replace(/\.[^./]+$/, "")}.thumb.webp`;
  await new Bun.Image(Bun.file(screenshotPath))
    .resize(px, px, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .write(thumbPath);
  return thumbPath;
}
