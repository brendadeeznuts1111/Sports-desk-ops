import { describe, expect, mock, test } from "bun:test";

import {
  signInitDataForTest,
  verifyTelegramInitData,
} from "../lib/telegram_initdata.ts";

/**
 * Golden fields a real Mini App would send: `auth_date`, `query_id`, `user` (JSON), `chat` and a
 * `start_param`. The test signs them with the test token, then every case varies exactly one input
 * so a failure names the field.
 */
const TOKEN = "1234567890:TEST_TELEGRAM_TOKEN_abcdefghijklmnopqrstuv";
const ALT_TOKEN = "9999999999:OTHER_TELEGRAM_TOKEN_zyxwvutsrqponmlkjihg";
const AUTH_DATE = 1_730_000_000; // 2024-10-27T03:33:20Z, inside any sane `now()` the test picks

const FIELDS = {
  auth_date: String(AUTH_DATE),
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: JSON.stringify({
    id: 12345678,
    first_name: "Alice",
    last_name: "Operator",
    username: "alice_ops",
    language_code: "en",
    is_premium: true,
  }),
  chat: JSON.stringify({
    id: -1001122334455,
    type: "supergroup",
    title: "Desk",
  }),
  start_param: "miniapp-home",
} as const;

const now = () => AUTH_DATE + 10; // 10s after auth: well inside 300s

describe("verifyTelegramInitData", () => {
  test("a Telegram-signed payload verifies and the parsed fields match the inputs", () => {
    const initData = signInitDataForTest(FIELDS, TOKEN);
    const result = verifyTelegramInitData(initData, TOKEN, { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.authDate).toBe(AUTH_DATE);
    expect(result.data.user).toEqual({
      id: 12345678,
      firstName: "Alice",
      lastName: "Operator",
      username: "alice_ops",
      languageCode: "en",
      isPremium: true,
    });
    expect(result.data.chatId).toBe("-1001122334455");
    expect(result.data.startParam).toBe("miniapp-home");
    expect(result.data.raw["query_id"]).toBe(FIELDS.query_id);
    // `hash` is never echoed back; the caller cannot be tricked into re-using it as a bearer.
    expect(result.data.raw).not.toHaveProperty("hash");
  });

  test("a tampered hash is rejected with reason=hash", () => {
    const initData = signInitDataForTest(FIELDS, TOKEN);
    const broken = initData.replace(/hash=[0-9a-f]+$/, (m) =>
      m.replace(/.$/, (c) => (c === "0" ? "1" : "0")),
    );
    const result = verifyTelegramInitData(broken, TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: "hash" });
  });

  test("a tampered payload field (hash unchanged) is rejected with reason=hash", () => {
    const initData = signInitDataForTest(FIELDS, TOKEN);
    // Replace the chat id in `chat=...` without touching `hash=...`.
    const broken = initData.replace(
      encodeURIComponent(FIELDS.chat),
      encodeURIComponent(
        JSON.stringify({
          id: -1009999999999,
          type: "supergroup",
          title: "Desk",
        }),
      ),
    );
    expect(broken).not.toBe(initData);
    const result = verifyTelegramInitData(broken, TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: "hash" });
  });

  test("an auth_date older than maxAgeSeconds is rejected with reason=stale", () => {
    const initData = signInitDataForTest(FIELDS, TOKEN);
    // 10 minutes after auth, 300s default window is 5 minutes.
    const result = verifyTelegramInitData(initData, TOKEN, {
      now: () => AUTH_DATE + 600,
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
    // With a wider window the same payload passes: the signature was fine, only the clock failed.
    const widened = verifyTelegramInitData(initData, TOKEN, {
      now: () => AUTH_DATE + 600,
      maxAgeSeconds: 900,
    });
    expect(widened.ok).toBe(true);
  });

  test("a missing or mis-shaped hash is rejected with reason=malformed", () => {
    expect(
      verifyTelegramInitData("auth_date=1&user=%7B%7D", TOKEN, { now }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyTelegramInitData("auth_date=1&user=%7B%7D&hash=not-hex", TOKEN, {
        now,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(verifyTelegramInitData("", TOKEN, { now })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("the wrong bot token is rejected with reason=hash", () => {
    const initData = signInitDataForTest(FIELDS, TOKEN);
    const result = verifyTelegramInitData(initData, ALT_TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: "hash" });
  });

  test("a duplicate key in the raw body is treated as malformed", () => {
    // Build a payload with two `user=` entries. The attacker signs the one the verifier might read
    // second; our implementation refuses before even checking the hash.
    const base = new URLSearchParams(signInitDataForTest(FIELDS, TOKEN));
    base.append("user", "{}");
    const result = verifyTelegramInitData(base.toString(), TOKEN, { now });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  test("auth_date must be a positive integer", () => {
    const initData = signInitDataForTest({ ...FIELDS, auth_date: "-1" }, TOKEN);
    expect(verifyTelegramInitData(initData, TOKEN, { now })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("the module never writes the bot token or the raw payload to console", () => {
    const logSpy = mock(() => {});
    const errorSpy = mock(() => {});
    const warnSpy = mock(() => {});
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = logSpy;
    console.error = errorSpy;
    console.warn = warnSpy;
    try {
      const initData = signInitDataForTest(FIELDS, TOKEN);
      verifyTelegramInitData(initData, TOKEN, { now });
      verifyTelegramInitData(initData + "x", TOKEN, { now });
      verifyTelegramInitData(initData, ALT_TOKEN, { now });
      verifyTelegramInitData("", TOKEN, { now });
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    }
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
