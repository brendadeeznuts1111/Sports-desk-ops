/**
 * @file lib/telegram_initdata.ts
 * @description Server-side verifier for Telegram Mini App `initData`.
 *
 * Telegram signs the Web App launch payload with HMAC-SHA256 keyed by SHA-256 of the bot token
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). This module
 * is the one allowed place that verifier lives, so a mini-app request carrying a signed `initData`
 * can be trusted without the admin bearer.
 *
 * Contract:
 *  - inputs: the raw `initData` string (URL-encoded, from `window.Telegram.WebApp.initData` or the
 *    `tgWebAppData` fragment), the bot token, an optional `maxAgeSeconds` (default 300, Telegram's
 *    guidance; tune for your load path).
 *  - output: a discriminated union; the `ok: false` branch names what failed with a short enum
 *    (`"malformed"`, `"hash"`, `"stale"`) so callers can log the reason without ever logging the
 *    token or the raw payload.
 *
 * Non-goals:
 *  - No I/O, no logging. Never prints the token or the raw body.
 *  - No business logic: pairing a verified user with a session is the caller's job.
 */

import crypto from "node:crypto";

export type InitDataFailure = "malformed" | "hash" | "stale";

export interface InitDataUser {
  readonly id: number;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly languageCode?: string;
  readonly isPremium?: boolean;
  readonly isBot?: boolean;
}

export interface VerifiedInitData {
  /** `auth_date` field, seconds since epoch. */
  readonly authDate: number;
  /** Parsed `user` JSON, when Telegram supplied it (a Mini App launched from a group chat omits it). */
  readonly user: InitDataUser | null;
  /** `chat.id` as a string, when Telegram supplied a `chat` field. */
  readonly chatId: string | null;
  /** `start_param` passed to `t.me/<bot>?startapp=<...>` or `?start=<...>`, when present. */
  readonly startParam: string | null;
  /** Every verified key→value pair, excluding `hash`. The caller may read extras like `query_id`. */
  readonly raw: Readonly<Record<string, string>>;
}

export type VerifyInitDataResult =
  | { readonly ok: true; readonly data: VerifiedInitData }
  | { readonly ok: false; readonly reason: InitDataFailure };

export interface VerifyInitDataOptions {
  /** Reject when `now() - auth_date > maxAgeSeconds`. Default 300 (Telegram's recommendation). */
  readonly maxAgeSeconds?: number;
  /** Injected clock for tests, seconds since epoch. */
  readonly now?: () => number;
}

/**
 * Verify a Mini App `initData` payload. Returns the parsed fields on success, or the first failure
 * reason on rejection. Does not throw, does not log.
 */
export function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  options: VerifyInitDataOptions = {},
): VerifyInitDataResult {
  if (typeof initDataRaw !== "string" || initDataRaw.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof botToken !== "string" || botToken.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  // `URLSearchParams` percent-decodes values the same way the Mini App encoded them. Telegram's
  // data-check-string is built from the DECODED key=value pairs, not the raw ones.
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initDataRaw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const providedHash = params.get("hash");
  if (providedHash === null || !/^[0-9a-f]{64}$/i.test(providedHash)) {
    return { ok: false, reason: "malformed" };
  }

  const pairs: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    // `URLSearchParams` does not de-duplicate, but Telegram's spec is one value per key. A duplicate
    // is a fabricated payload; refuse before computing the HMAC.
    if (pairs.some(([existing]) => existing === key)) {
      return { ok: false, reason: "malformed" };
    }
    pairs.push([key, value]);
  }

  // Alphabetical sort by key.
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  // secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  // hash = HMAC_SHA256(key=secret_key, message=data_check_string), lower-hex.
  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();

  const providedBuf = Buffer.from(providedHash.toLowerCase(), "hex");
  if (providedBuf.length !== expected.length) {
    return { ok: false, reason: "hash" };
  }
  if (!crypto.timingSafeEqual(expected, providedBuf)) {
    return { ok: false, reason: "hash" };
  }

  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw === null ? Number.NaN : Number(authDateRaw);
  if (
    !Number.isFinite(authDate) ||
    !Number.isInteger(authDate) ||
    authDate <= 0
  ) {
    return { ok: false, reason: "malformed" };
  }
  const maxAge = options.maxAgeSeconds ?? 300;
  const nowSec = options.now ? options.now() : Math.floor(Date.now() / 1000);
  if (nowSec - authDate > maxAge) {
    return { ok: false, reason: "stale" };
  }

  const raw: Record<string, string> = {};
  for (const [key, value] of pairs) raw[key] = value;

  return {
    ok: true,
    data: {
      authDate,
      user: parseUser(params.get("user")),
      chatId: parseChatId(params.get("chat")),
      startParam: params.get("start_param"),
      raw,
    },
  };
}

function parseUser(raw: string | null): InitDataUser | null {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  const user: {
    id: number;
    firstName?: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
    isPremium?: boolean;
    isBot?: boolean;
  } = { id };
  if (typeof record["first_name"] === "string")
    user.firstName = record["first_name"];
  if (typeof record["last_name"] === "string")
    user.lastName = record["last_name"];
  if (typeof record["username"] === "string")
    user.username = record["username"];
  if (typeof record["language_code"] === "string")
    user.languageCode = record["language_code"];
  if (typeof record["is_premium"] === "boolean")
    user.isPremium = record["is_premium"];
  if (typeof record["is_bot"] === "boolean") user.isBot = record["is_bot"];
  return user;
}

function parseChatId(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const id = record["id"];
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

/**
 * Build an `initData` string (encoded, sorted, signed) for a payload. Exported so tests and
 * fixtures can produce the same bytes Telegram would send; production code must never need this.
 */
export function signInitDataForTest(
  fields: Readonly<Record<string, string>>,
  botToken: string,
): string {
  const pairs = Object.entries(fields)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");
  const params = new URLSearchParams();
  for (const [k, v] of pairs) params.append(k, v);
  params.append("hash", hash);
  return params.toString();
}
