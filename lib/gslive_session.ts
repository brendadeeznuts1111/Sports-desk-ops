/**
 * GSLive manager session from a logged-in WebView profile (`Bun.WebView` + CDP cookies).
 *
 * This retires the manual-cookie default for operators: sign in once in a dedicated Chrome
 * profile, then point the capture at that profile directory. Cookies are read over CDP, used to
 * build one request header, and never printed, persisted or summarized with values.
 *
 * Reuses the repo's existing cookie handoff (`cookieHandoffForHost`) so host/path/secure selection
 * has one implementation; nothing here re-implements cookie rules.
 */

import { stat } from "node:fs/promises";

import { acquireProfileLock } from "./f402_profile_lock.ts";
import {
  LOGIN_FORM_PROBE_EXPRESSION,
  ProfileSessionError,
  type ProfileSessionView,
} from "./f402_profile_session.ts";
import { cookieHandoffForHost } from "../scripts/capture/cookies.ts";
import { hostOf } from "../scripts/capture/ops.ts";
import { CookieMap } from "bun";

/** The Manager Tools console root the profile is navigated to before cookies are read. */
export const GSLIVE_MANAGER_URL =
  "https://plive.sportswidgets.pro/manager-tools/";

/** Default WebView factory: headless Chrome backed by the profile's `--user-data-dir`. */
export async function launchGsliveProfileView(
  profileDir: string,
): Promise<ProfileSessionView> {
  const { ManagedWebView } = await import("../scripts/capture/webview.ts");
  const view = ManagedWebView.launch({
    backend: "chrome",
    dataStoreDir: profileDir,
  });
  return {
    async navigate(url) {
      await view.navigate(url);
    },
    evaluate: (expression) => view.evaluate(expression),
    getAllCookies: () => view.getAllCookies(),
    close: () => view.close(),
  };
}

/** Attach to an already-running Chrome (new tab) instead of spawning a headless one. */
export async function launchRunningChromeView(): Promise<ProfileSessionView> {
  const { ManagedWebView } = await import("../scripts/capture/webview.ts");
  const view = ManagedWebView.launch({
    backend: "chrome",
    attachToExistingChrome: true,
  });
  return {
    async navigate(url) {
      await view.navigate(url);
    },
    evaluate: (expression) => view.evaluate(expression),
    getAllCookies: () => view.getAllCookies(),
    close: () => view.close(),
  };
}

export interface GsliveProfileSessionOptions {
  /** Chrome `--user-data-dir` that is signed in to Manager Tools. */
  readonly profileDir: string;
  /** Injection seam for tests; defaults to a headless Chrome WebView profile. */
  readonly viewFactory?: (profileDir: string) => Promise<ProfileSessionView>;
  /** Console URL to navigate before reading cookies. Defaults to the Manager Tools root. */
  readonly managerUrl?: string;
}

export interface GsliveProfileSession {
  /** Sensitive: one `Cookie` header. Never log or journal it. */
  readonly cookieHeader: string;
  readonly source: "webview-profile" | "running-chrome";
  readonly host: string;
  /** Cookie names only (no values), for a provenance line an operator can read. */
  readonly cookieNames: readonly string[];
  readonly redactedHeader: string;
}

/** Raised when a profile cannot yield a GSLive session; messages never contain cookie values. */
export class GsliveSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GsliveSessionError";
  }
}

async function requireProfileDir(profileDir: string): Promise<string> {
  const trimmed = profileDir.trim();
  if (trimmed === "") {
    throw new GsliveSessionError(
      "a WebView profile directory is required (--webview-profile <dir> or GSLIVE_WEBVIEW_PROFILE)",
    );
  }
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(trimmed);
  } catch {
    throw new GsliveSessionError(
      `WebView profile ${trimmed} does not exist — sign in to Manager Tools once with that profile, then retry`,
    );
  }
  if (!stats.isDirectory()) {
    throw new GsliveSessionError(
      `WebView profile ${trimmed} is a file, not a Chrome --user-data-dir`,
    );
  }
  return trimmed;
}

/**
 * Navigate a view to Manager Tools, prove it is signed in, and hand off the host's cookies.
 * A view that still renders a login form fails closed: its analytics/Cloudflare cookies would
 * only produce 401s. The view is always closed.
 */
async function managerSessionFromView(
  view: ProfileSessionView,
  managerUrl: string,
  label: string,
  source: "webview-profile" | "running-chrome",
): Promise<GsliveProfileSession> {
  const host = hostOf(managerUrl);
  try {
    await view.navigate(managerUrl);
    const loginFormPresent =
      (await view.evaluate(LOGIN_FORM_PROBE_EXPRESSION)) === true;
    if (loginFormPresent) {
      throw new GsliveSessionError(
        `${label} still presents a login form for ${host} — sign in, then retry`,
      );
    }
    const cookies = await view.getAllCookies();
    let handoff: ReturnType<typeof cookieHandoffForHost>;
    try {
      handoff = cookieHandoffForHost(cookies, host);
    } catch (error) {
      throw new GsliveSessionError(
        `${label} has no session cookies scoped to ${host} — sign in, then retry`,
        { cause: error },
      );
    }
    // Validate the handoff through Bun's cookie parser instead of trusting the CDP summary:
    // a header that does not parse, or one without GSID, is not a usable session.
    let jar: CookieMap;
    try {
      jar = new CookieMap(handoff.header);
    } catch (error) {
      throw new GsliveSessionError(
        `${label} produced a Cookie header CookieMap cannot parse`,
        { cause: error },
      );
    }
    const names = [...jar.keys()];
    if (!jar.has("GSID")) {
      throw new GsliveSessionError(
        `${label} is signed in to ${host} but no GSID session cookie was scoped to it (cookies: ${
          names.join(", ") || "none"
        })`,
      );
    }
    return {
      cookieHeader: handoff.header,
      source,
      host,
      cookieNames: names,
      redactedHeader: handoff.summary.redactedHeader,
    };
  } finally {
    await view.close();
  }
}

export async function sessionFromGsliveProfile(
  options: GsliveProfileSessionOptions,
): Promise<GsliveProfileSession> {
  const profileDir = await requireProfileDir(options.profileDir);
  using _lock = acquireProfileLock(profileDir);
  const view = await (options.viewFactory ?? launchGsliveProfileView)(
    profileDir,
  );
  // `await` keeps the profile lock held until the session is built; `using` releases it on return.
  return await managerSessionFromView(
    view,
    options.managerUrl ?? GSLIVE_MANAGER_URL,
    `WebView profile ${profileDir}`,
    "webview-profile",
  );
}

export interface RunningChromeSessionOptions {
  /** Injection seam for tests; defaults to attaching via Bun.WebView. */
  readonly viewFactory?: () => Promise<ProfileSessionView>;
  readonly managerUrl?: string;
}

/**
 * Session from the *already running* Chrome (Profile 16's live Manager Tools tab), via Bun's
 * DevToolsActivePort auto-connect. No profile lock: the running browser owns that directory.
 */
export async function sessionFromRunningChrome(
  options: RunningChromeSessionOptions = {},
): Promise<GsliveProfileSession> {
  const view = await (options.viewFactory ?? launchRunningChromeView)();
  return managerSessionFromView(
    view,
    options.managerUrl ?? GSLIVE_MANAGER_URL,
    "the running Chrome",
    "running-chrome",
  );
}

/** Re-export so callers can classify profile failures without importing the F402 module. */
export { ProfileSessionError as GsliveProfileViewError };

// Auto-minted manager session (keychain username/password -> verified GSID).
export {
  ensureGsid,
  fetchBetLog,
  fetchEventLog,
} from "./gslive_auto_session.ts";
