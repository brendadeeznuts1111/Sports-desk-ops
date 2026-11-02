/**
 * @file lib/f402_profile_session.ts
 * @description Export the cookies of a manually bootstrapped WebView profile.
 *
 * `F402_WEBVIEW_PROFILE` names a Bun.WebView `dataStore` directory (Chrome's
 * `--user-data-dir` format). `Bun.FetchSession` has no dataStore, so the replay
 * transport cannot read that directory; this module bridges it by launching the
 * profile in a WebView, reading the cookies over CDP, and building an
 * `F402Session` the transport does read.
 *
 * Cookie values never leave the returned session: nothing here logs them, and
 * errors name only the profile path and the host.
 */

import { statSync } from "node:fs";

import {
  cookieHandoffForHost,
  type CdpCookie,
  type CookieHandoff,
} from "../scripts/capture/cookies.ts";
import { hostOf } from "../scripts/capture/ops.ts";
import { acquireProfileLock } from "./f402_profile_lock.ts";
import { sessionFromAuth, type F402Session } from "./f402_session.ts";

/**
 * The slice of a WebView this module needs. `ManagedWebView` satisfies it, and
 * tests inject a fake through `viewFactory` so no browser is launched.
 */
export interface ProfileSessionView {
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  getAllCookies(): Promise<CdpCookie[]>;
  close(): Promise<void>;
}

/**
 * Probe run after navigation: a profile that still shows a password field is
 * signed out, and its Cloudflare/analytics cookies would only mint a session of
 * 401s.
 */
export const LOGIN_FORM_PROBE_EXPRESSION =
  'document.querySelector("input[type=password]") !== null';

export interface ProfileSessionOptions {
  /** WebView `dataStore` directory (Chrome `--user-data-dir`). */
  profileDir: string;
  /** Portal root the profile is navigated to before cookies are read. */
  baseUrl: string;
  ttlMinutes?: number;
  now?: number;
  /** Injection seam for tests; defaults to a headless Chrome WebView profile. */
  viewFactory?: (profileDir: string) => Promise<ProfileSessionView>;
}

/** Raised when a profile cannot yield a session; messages never contain values. */
export class ProfileSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileSessionError";
  }
}

async function launchChromeProfileView(
  profileDir: string,
): Promise<ProfileSessionView> {
  const { ManagedWebView } = await import("../scripts/capture/webview.ts");
  const view = ManagedWebView.launch({
    backend: "chrome",
    // Chrome's own profile layout: a manual MFA bootstrap produces one, and a
    // dataStore round-trips it.
    dataStoreDir: profileDir,
  });
  return {
    async navigate(url: string): Promise<void> {
      await view.navigate(url);
    },
    async evaluate(expression: string): Promise<unknown> {
      return await view.evaluate(expression);
    },
    async getAllCookies(): Promise<CdpCookie[]> {
      return await view.getAllCookies();
    },
    async close(): Promise<void> {
      await view.close();
    },
  };
}

function requireProfileDir(profileDir: string): string {
  const trimmed = profileDir.trim();
  if (trimmed === "") {
    throw new ProfileSessionError(
      "a WebView profile directory is required (--from-profile <dir> or F402_WEBVIEW_PROFILE)",
    );
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(trimmed);
  } catch {
    throw new ProfileSessionError(
      `WebView profile ${trimmed} does not exist — sign in once with that profile, or pass the right --from-profile`,
    );
  }
  if (!stats.isDirectory()) {
    throw new ProfileSessionError(
      `WebView profile ${trimmed} is not a directory — it must be the WebView dataStore dir (Chrome --user-data-dir)`,
    );
  }
  return trimmed;
}

function requirePortalUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProfileSessionError(
      `portal base URL is not absolute (${trimmed === "" ? "<empty>" : trimmed})`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProfileSessionError(
      `portal base URL must be http(s) (got ${url.protocol})`,
    );
  }
  return url;
}

/**
 * Reads the cookies in `profileDir` and returns a TTL-bounded session.
 *
 * The view is always closed, including when navigation, the sign-in probe or
 * the cookie handoff throws. A profile that still shows a login form, or that
 * has no scoped cookies, throws: capturing 401s is worse than failing here.
 */
export async function sessionFromWebViewProfile(
  options: ProfileSessionOptions,
): Promise<F402Session> {
  const profileDir = requireProfileDir(options.profileDir);
  const portalUrl = requirePortalUrl(options.baseUrl);
  const host = hostOf(portalUrl.origin);

  // The capture scripts take the same lock; exporting while a capture holds
  // the profile would fail later inside Chrome with an opaque pipe error.
  using _lock = acquireProfileLock(profileDir);

  const view = await (options.viewFactory ?? launchChromeProfileView)(
    profileDir,
  );
  try {
    await view.navigate(portalUrl.href);
    // A signed-out profile keeps Cloudflare/analytics cookies, so an empty
    // scoped jar is not the only signed-out shape: probe the rendered page.
    const loginFormPresent =
      (await view.evaluate(LOGIN_FORM_PROBE_EXPRESSION)) === true;
    if (loginFormPresent) {
      throw new ProfileSessionError(
        `WebView profile ${profileDir} still presents a login form for ${host} — sign in with that profile, then retry`,
      );
    }
    const cookies = await view.getAllCookies();
    let handoff: CookieHandoff;
    try {
      handoff = cookieHandoffForHost(cookies, host, undefined, undefined, {
        requestSecure: portalUrl.protocol === "https:",
      });
    } catch {
      throw new ProfileSessionError(
        `WebView profile ${profileDir} has no scoped session cookies for ${host} — sign in with that profile, then retry (profile holds ${cookies.length} cookies, none usable for ${host})`,
      );
    }
    return sessionFromAuth(
      {
        cookieHeader: handoff.header,
        cookieNames: handoff.summary.names,
      },
      {
        ...(options.ttlMinutes === undefined
          ? {}
          : { ttlMinutes: options.ttlMinutes }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
  } finally {
    await view.close();
  }
}
