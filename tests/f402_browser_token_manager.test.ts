import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import {
  decodeJwtExp,
  F402_REMINT_MARGIN_MS,
  f402AuthorizedFetch,
  F402TokenManager,
  fakeJwtExpiringAt,
  memoryStorage,
} from "../lib/f402_browser_token_manager.ts";

describe("f402_browser_token_manager", () => {
  test("decodeJwtExp handles unpadded base64url", () => {
    const expMs = Date.parse("2026-11-09T07:00:00.000Z");
    expect(decodeJwtExp(fakeJwtExpiringAt(expMs))).toBe(expMs);
  });

  describe("single-flight remint", () => {
    let remintPosts = 0;

    beforeEach(() => {
      remintPosts = 0;
    });

    test("concurrent get() after expiry performs exactly one authenticateCustomer POST", async () => {
      const now = Date.parse("2026-11-09T06:00:00.000Z");
      const expired = fakeJwtExpiringAt(now - 60_000);
      const fresh = fakeJwtExpiringAt(now + 20 * 60_000);
      const storage = memoryStorage({
        token: expired,
        customerID: "BILLY666 ",
        credentials: JSON.stringify({ password: "secret" }),
      });
      const fetchImpl = async (input: string | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("authenticateCustomer")) {
          remintPosts += 1;
          await Promise.resolve();
          return new Response(JSON.stringify({ code: fresh }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      };
      const manager = new F402TokenManager({
        storage,
        fetch: fetchImpl as typeof fetch,
        now: () => now,
      });
      const [a, b] = await Promise.all([manager.get(), manager.get()]);
      expect(a).toBe(fresh);
      expect(b).toBe(fresh);
      expect(remintPosts).toBe(1);
      expect(manager.metrics.mints).toBe(1);
    });
  });

  describe("scheduled refresh", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test("fires one remint at exp − margin", async () => {
      jest.useFakeTimers();
      const start = Date.parse("2026-11-09T06:00:00.000Z");
      const exp = start + 15 * 60_000;
      const token = fakeJwtExpiringAt(exp);
      const fresh = fakeJwtExpiringAt(exp + 15 * 60_000);
      const storage = memoryStorage({
        token,
        customerID: "OP",
        credentials: JSON.stringify({ password: "x" }),
      });
      let remints = 0;
      const manager = new F402TokenManager({
        storage,
        fetch: (async (input) => {
          if (String(input).includes("authenticateCustomer")) {
            remints += 1;
            return new Response(JSON.stringify({ code: fresh }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        now: () => start,
      });
      manager.schedule(token);
      const delay = Math.max(30_000, exp - start - F402_REMINT_MARGIN_MS);
      jest.advanceTimersByTime(delay - 1);
      expect(remints).toBe(0);
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(remints).toBe(1);
    });
  });

  test("401 triggers one forced remint and a single retry", async () => {
    const now = Date.parse("2026-11-09T06:00:00.000Z");
    const stale = fakeJwtExpiringAt(now - 1);
    const fresh = fakeJwtExpiringAt(now + 20 * 60_000);
    const storage = memoryStorage({
      token: stale,
      customerID: "OP",
      credentials: JSON.stringify({ password: "x" }),
    });
    let apiCalls = 0;
    let remints = 0;
    const fetchImpl = async (input: string | URL) => {
      const url = String(input);
      if (url.includes("authenticateCustomer")) {
        remints += 1;
        return new Response(JSON.stringify({ code: fresh }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      apiCalls += 1;
      if (apiCalls === 1) {
        return new Response("<html>401</html>", {
          status: 401,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("{}", { status: 200 });
    };
    const tokens = new F402TokenManager({
      storage,
      fetch: fetchImpl as typeof fetch,
      now: () => now,
    });
    const res = await f402AuthorizedFetch(
      tokens,
      "/cloud/api/Manager/getBetTicker",
      { method: "POST" },
      false,
      fetchImpl as typeof fetch,
    );
    expect(res.status).toBe(200);
    expect(remints).toBe(2);
    expect(apiCalls).toBe(2);
  });
});
