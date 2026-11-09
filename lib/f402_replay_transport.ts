/**
 * Replay transport: primary = FetchSession + session-file cookie; secondary = localhost proxy.
 * A WebView profile is never read (Bun.FetchSession has no dataStore): export it once with
 * `bun run session:login --from-profile <dir>`, then point F402_SESSION_FILE at the result.
 * @deprecated F402_COOKIE — use the session file from a WebView login.
 */

import { join } from "node:path";

import {
  readF402Session,
  refreshF402Session,
  writeF402Session,
} from "./f402_session.ts";

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
    `[deprecated] ${DEPRECATED_F402_COOKIE_ENV} is deprecated; use F402_SESSION_FILE (bun run session:login) or F402_REPLAY_PROXY_URL`,
  );
}

export interface F402ReplayTransport {
  readonly label:
    "datastore-fetch-session" | "session-file" | "proxy" | "deprecated-cookie";
  fetch(url: string, init: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export interface F402ReplayTransportOptions {
  readonly proxyUrl?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: replace the Bun FetchSession wire call. */
  readonly fetchImpl?: (
    url: string,
    init: RequestInit,
  ) => Promise<Response>;
  /** Test seam: replace 401 re-mint (default: `refreshF402Session` + `writeF402Session`). */
  readonly refreshSession?: () => Promise<void>;
  readonly readSession?: () => ReturnType<typeof readF402Session>;
}

export async function createF402ReplayTransport(
  options?: F402ReplayTransportOptions,
): Promise<F402ReplayTransport> {
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

  const bunSession = new Bun.FetchSession({
    tls: { rejectUnauthorized: true },
  });

  const readSession = options?.readSession ?? (() => readF402Session());
  const initial = readSession();
  const deprecatedCookie = env[DEPRECATED_F402_COOKIE_ENV]?.trim() ?? "";

  const wireFetch =
    options?.fetchImpl ??
    ((url: string, init: RequestInit) => bunSession.fetch(url, init));

  async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("cookie")) {
      const session = readSession();
      if (session !== null) {
        headers.set("cookie", session.cookieHeader);
      } else if (deprecatedCookie !== "") {
        headers.set("cookie", deprecatedCookie);
      }
    }
    return wireFetch(url, { ...init, headers });
  }

  async function remintAfterUnauthorized(): Promise<void> {
    if (options?.refreshSession !== undefined) {
      await options.refreshSession();
      return;
    }
    const fresh = await refreshF402Session({ env });
    writeF402Session(fresh);
  }

  return {
    label:
      initial !== null
        ? "session-file"
        : deprecatedCookie !== ""
          ? "deprecated-cookie"
          : "datastore-fetch-session",
    async fetch(url: string, init: RequestInit): Promise<Response> {
      let response = await fetchOnce(url, init);
      if (response.status !== 401) return response;
      try {
        await remintAfterUnauthorized();
      } catch {
        return response;
      }
      response = await fetchOnce(url, init);
      return response;
    },
    async close(): Promise<void> {
      await bunSession.close();
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
