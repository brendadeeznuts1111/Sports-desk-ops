/**
 * Replay transport: primary = FetchSession + session-file cookie; secondary = localhost proxy.
 * `profileDir` is not read: Bun.FetchSession has no dataStore, so WebView profile cookies never reach it.
 * @deprecated F402_COOKIE — use profile or session file from WebView login.
 */

import { join } from "node:path";

import { readF402Session } from "./f402_session.ts";

export const DEPRECATED_F402_COOKIE_ENV = "F402_COOKIE";

export function resolveF402WebViewProfileDir(
  env: NodeJS.ProcessEnv = Bun.env,
): string {
  const explicit = env.F402_WEBVIEW_PROFILE?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(import.meta.dir, "../scratch/f402-manager-webview-profile");
}

export function warnIfDeprecatedCookieEnv(
  env: NodeJS.ProcessEnv = Bun.env,
): void {
  const raw = env[DEPRECATED_F402_COOKIE_ENV]?.trim();
  if (raw === undefined || raw === "") return;
  console.warn(
    `[deprecated] ${DEPRECATED_F402_COOKIE_ENV} is deprecated; use F402_WEBVIEW_PROFILE + WebView login, F402_SESSION_FILE, or F402_REPLAY_PROXY_URL`,
  );
}

export interface F402ReplayTransport {
  readonly label:
    "datastore-fetch-session" | "session-file" | "proxy" | "deprecated-cookie";
  fetch(url: string, init: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export async function createF402ReplayTransport(options?: {
  readonly profileDir?: string | undefined;
  readonly proxyUrl?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<F402ReplayTransport> {
  const env = options?.env ?? Bun.env;
  warnIfDeprecatedCookieEnv(env);

  const proxy = (
    options?.proxyUrl ??
    env.F402_REPLAY_PROXY_URL?.trim() ??
    ""
  ).replace(/\/$/, "");
  if (proxy !== "") {
    return {
      label: "proxy",
      async fetch(url: string, init: RequestInit): Promise<Response> {
        const target = new URL(url);
        const proxyUrl = `${proxy}${target.pathname}${target.search}`;
        return fetch(proxyUrl, {
          ...init,
          headers: {
            ...init.headers,
            "x-f402-upstream": url,
          },
        });
      },
      async close(): Promise<void> {},
    };
  }

  const session = new Bun.FetchSession({
    tls: { rejectUnauthorized: true },
  });

  const cached = readF402Session();
  const deprecatedCookie = env[DEPRECATED_F402_COOKIE_ENV]?.trim() ?? "";

  return {
    label:
      cached !== null
        ? "session-file"
        : deprecatedCookie !== ""
          ? "deprecated-cookie"
          : "datastore-fetch-session",
    async fetch(url: string, init: RequestInit): Promise<Response> {
      const headers = new Headers(init.headers);
      if (!headers.has("cookie")) {
        if (cached !== null) {
          headers.set("cookie", cached.cookieHeader);
        } else if (deprecatedCookie !== "") {
          headers.set("cookie", deprecatedCookie);
        }
      }
      return session.fetch(url, { ...init, headers });
    },
    async close(): Promise<void> {
      await session.close();
    },
  };
}

/** @deprecated Prefer {@link createF402ReplayTransport}. */
export function cookieHeaderFromEnv(env: NodeJS.ProcessEnv = Bun.env): string {
  warnIfDeprecatedCookieEnv(env);
  const session = readF402Session();
  if (session !== null) return session.cookieHeader;
  return env[DEPRECATED_F402_COOKIE_ENV]?.trim() ?? "";
}
