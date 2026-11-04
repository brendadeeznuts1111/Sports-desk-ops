/**
 * Mid-cycle token refresh: 3b batches over 20-minute JWTs, so renewal must be a first-class,
 * measured contract (`renewToken` returned 200 with `{code}` on 2026-11-04).
 */
import { describe, expect, test } from "bun:test";

import {
  F402TokenRefreshError,
  f402TokenExpiresAtMs,
  renewF402BearerToken,
} from "../lib/f402_pending_fetch.ts";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function jwt(payload: Record<string, unknown>): string {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url(payload),
    "c".repeat(43),
  ].join(".");
}

describe("f402TokenExpiresAtMs", () => {
  test("reads exp from a JWT", () => {
    expect(f402TokenExpiresAtMs(jwt({ exp: 2_000_000_000 }))).toBe(
      2_000_000_000_000,
    );
  });
  test("returns null for an opaque token or missing exp", () => {
    expect(f402TokenExpiresAtMs("opaque-token-" + "x".repeat(30))).toBeNull();
    expect(f402TokenExpiresAtMs(jwt({ sub: "x" }))).toBeNull();
  });
});

describe("renewF402BearerToken", () => {
  test("posts renewToken with the current bearer and returns the new JWT", async () => {
    const fresh = jwt({ exp: 2_000_000_600 });
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: fresh }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const old = jwt({ exp: 2_000_000_000 });
    const result = await renewF402BearerToken({ token: old, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://www.fantasy402.com/cloud/api/System/renewToken",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${old}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      operation: "renewToken",
      RRO: 1,
    });
    expect(result.token).toBe(fresh);
    expect(result.expiresAtMs).toBe(2_000_000_600_000);
  });

  test("non-200 / malformed responses are typed refresh failures", async () => {
    const old = jwt({ exp: 2_000_000_000 });
    await expect(
      renewF402BearerToken({
        token: old,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ status: "Failed", msg: "Invalid Token" }),
            {
              status: 401,
              headers: { "content-type": "application/json" },
            },
          ),
      }),
    ).rejects.toBeInstanceOf(F402TokenRefreshError);

    await expect(
      renewF402BearerToken({
        token: old,
        fetchImpl: async () =>
          new Response(JSON.stringify({ code: "short" }), { status: 200 }),
      }),
    ).rejects.toThrow(/no valid `code`/);
  });

  test("errors never echo the token", async () => {
    const old = jwt({ exp: 2_000_000_000 });
    const error = await renewF402BearerToken({
      token: old,
      fetchImpl: async () => new Response("", { status: 500 }),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(F402TokenRefreshError);
    expect((error as Error).message).not.toContain(old);
  });
});
