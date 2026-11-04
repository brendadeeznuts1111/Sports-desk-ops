/**
 * Shared fetch/guard/write helpers for Manager Tools endpoints.
 *
 * Every script that talks to plive.sportswidgets.pro follows the same
 * contract: GSID cookie from `Bun.env.GSID`, `redirect: "manual"` so a
 * 302-to-login surfaces instead of silently becoming 200-HTML, a
 * content-type guard before `JSON.parse` (the expired-GSID HTML trap),
 * zod parsing once at the boundary in the caller, and atomic `Bun.write`.
 */

import type { BunRequestInit, BunResponse } from "../types/bun-api";
import type { RetryPolicy } from "../types/wagers";

export const MANAGER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

export const MANAGER_REFERER = "https://plive.sportswidgets.pro/manager-tools/";

/** Minimum runtime our scripts rely on (`wrapAnsi`, `stripANSI`, `inspect.table`, …). */
export const BUN_FLOOR = ">=1.4.4-0";

/** Fail fast on a stale runtime instead of hitting cryptic API errors later. */
export function assertBunFloor(tool: string): void {
  if (!Bun.semver.satisfies(Bun.version, BUN_FLOOR)) {
    throw new Error(
      `${tool}: requires Bun ${BUN_FLOOR} (have ${Bun.version}) — see AGENTS.md floor`,
    );
  }
}

/** Read the GSID session id (`GSLIVE_SESSION_ID`, legacy `GSID`) as a cookie header or throw a fail-closed error. Never logs it.
 * `read` is injectable so tests exercise both paths without mutating `Bun.env`
 * (whose typed entries are readonly). */
export function requireGsid(
  tool: string,
  read: (name: string) => string | undefined = (name) => Bun.env[name],
): string {
  const gsid = read("GSLIVE_SESSION_ID") || read("GSID");
  if (!gsid) {
    throw new Error(
      `${tool}: GSLIVE_SESSION_ID is empty — set it (legacy name GSID also works) in .env (gitignored) or Bun.env`,
    );
  }
  return `GSID=${gsid}`;
}

/**
 * Fail-closed response guard. Throws before any body is parsed so an
 * expired GSID (302 to /login, or 200 with an HTML login page) never
 * reaches `JSON.parse` as "Unexpected token '<'".
 */
export function assertJsonResponse(response: BunResponse, tool: string): void {
  if (response.status === 302) {
    throw new Error(
      `${tool}: redirected to ${response.headers.get("location") ?? "(unknown)"} — GSID likely expired`,
    );
  }
  if (!response.ok) {
    throw new Error(`${tool}: HTTP ${response.status}`);
  }
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new Error(
      `${tool}: not JSON (content-type: ${ct || "<none>"}) — likely a login HTML page; GSID may be expired`,
    );
  }
}

/** GET JSON with the standard Manager Tools headers. Caller zod-parses. */
export async function fetchManagerJson(
  url: string,
  cookie: string,
  init?: BunRequestInit,
): Promise<BunResponse> {
  return await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      cookie,
      referer: MANAGER_REFERER,
      "user-agent": MANAGER_USER_AGENT,
      ...init?.headers,
    },
    redirect: "manual",
  });
}

/** POST JSON with the standard Manager Tools headers. Caller zod-parses. */
export async function postManagerJson(
  url: string,
  cookie: string,
  body: unknown,
  init?: BunRequestInit,
): Promise<BunResponse> {
  return await fetch(url, {
    ...init,
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      origin: "https://plive.sportswidgets.pro",
      referer: MANAGER_REFERER,
      "user-agent": MANAGER_USER_AGENT,
      ...init?.headers,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/** Atomically write pretty JSON; returns the pretty string for stdout. */
export async function writeJsonFile(
  path: string,
  data: unknown,
): Promise<string> {
  const pretty = JSON.stringify(data, null, 2);
  await Bun.write(path, pretty);
  return pretty;
}

/** Atomically write text only when the content changed (Wyhash compare). */
export async function writeTextFileIfChanged(
  path: string,
  text: string,
): Promise<boolean> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const current = await file.text();
    if (Bun.hash(text) === Bun.hash(current)) return false;
  }
  await Bun.write(path, text);
  return true;
}

/**
 * Write pretty JSON only when the content changed (Wyhash compare), so
 * repeated runs keep stable mtimes. Returns whether the file was written.
 */
export async function writeJsonFileIfChanged(
  path: string,
  data: unknown,
): Promise<{ pretty: string; wrote: boolean }> {
  const pretty = JSON.stringify(data, null, 2);
  const file = Bun.file(path);
  if (await file.exists()) {
    const current = await file.text();
    if (Bun.hash(pretty) === Bun.hash(current)) return { pretty, wrote: false };
  }
  await Bun.write(path, pretty);
  return { pretty, wrote: true };
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseMs: 500 };

function retriable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Run one fetch attempt with exponential backoff on 429/5xx.
 * Auth failures (302-to-login), other 4xx, and non-JSON bodies fail
 * immediately — retrying those would only burn the session.
 */
export async function fetchWithRetry(
  doFetch: () => Promise<BunResponse>,
  tool: string,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<BunResponse> {
  const attempts = Math.max(1, Math.floor(retry.attempts));
  let last: BunResponse | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await doFetch();
    if (!retriable(res.status)) {
      assertJsonResponse(res, tool);
      return res;
    }
    last = res;
    if (i < attempts - 1) await Bun.sleep(retry.baseMs * 2 ** i);
  }
  throw new Error(
    `${tool}: HTTP ${last?.status} after ${attempts} attempts — giving up`,
  );
}

/** GET JSON with retry; caller zod-parses. */
export async function getJsonWithRetry(
  url: string,
  cookie: string,
  tool: string,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<Response> {
  return await fetchWithRetry(() => fetchManagerJson(url, cookie), tool, retry);
}

/** POST JSON with retry; caller zod-parses. */
export async function postJsonWithRetry(
  url: string,
  cookie: string,
  body: unknown,
  tool: string,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<Response> {
  return await fetchWithRetry(
    () => postManagerJson(url, cookie, body),
    tool,
    retry,
  );
}
