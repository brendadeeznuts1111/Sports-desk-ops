/**
 * Pins the captured `authenticateCustomer` contract (2026-11-04): JSON body, uppercased
 * credentials, `operation` + `response_type`, and the `code` JWT. No network: fetch is injected.
 */
import { describe, expect, test } from "bun:test";

import {
  F402AuthenticateCustomerError,
  authenticateCustomer,
  authenticateCustomerBody,
  domainFromBaseUrl,
} from "./f402_authenticate_customer.ts";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Runtime-assembled: the source never contains a contiguous three-segment token. */
function jwt(payload: Record<string, unknown>): string {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url(payload),
    "c".repeat(43),
  ].join(".");
}

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>): {
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  seen: Captured[];
} {
  const seen: Captured[] = [];
  return {
    seen,
    fetchImpl: async (input, init) => {
      seen.push({ url: input, init });
      return response();
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const CREDS = { agentId: "billy666", password: "pässword" };

describe("request shape", () => {
  test("posts the manager-bundle JSON to /cloud/api/System/authenticateCustomer", async () => {
    const { fetchImpl, seen } = fakeFetch(() =>
      jsonResponse({
        code: jwt({ exp: 2_000_000_000 }),
        accountInfo: { customerID: "ABC123" },
      }),
    );
    await authenticateCustomer({ ...CREDS, fetchImpl });

    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toBe(
      "https://www.fantasy402.com/cloud/api/System/authenticateCustomer",
    );
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      customerID: "BILLY666",
      state: true,
      password: "PÄSSWORD",
      sufix: "",
      prefix: "",
      multiaccount: 0,
      response_type: "code",
      client_id: "BILLY666",
      domain: "fantasy402.com",
      redirect_uri: "fantasy402.com",
      token: "",
      operation: "authenticateCustomer",
      RRO: 1,
    });
  });

  test("domain strips www. and honours a custom base URL", async () => {
    expect(domainFromBaseUrl("https://www.fantasy402.com")).toBe(
      "fantasy402.com",
    );
    expect(domainFromBaseUrl("https://fantasy402.com/")).toBe("fantasy402.com");
    expect(
      authenticateCustomerBody(
        "a",
        "b",
        domainFromBaseUrl("https://x.test:8443"),
      ).domain,
    ).toBe("x.test");
  });
});

describe("token result", () => {
  test("returns the code JWT and its exp-derived lifetime", async () => {
    const exp = Math.floor(Date.now() / 1000) + 1200;
    const token = jwt({ exp, sub: "billy666" });
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({
        code: token,
        accountInfo: { customerID: "ABC123", AgentType: "A" },
      }),
    );
    const result = await authenticateCustomer({ ...CREDS, fetchImpl });
    expect(result.token).toBe(token);
    expect(result.tokenChars).toBe(token.length);
    expect(result.expiresInSec).toBeGreaterThan(1100);
    expect(result.expiresInSec).toBeLessThanOrEqual(1200);
    expect(result.expiresAtIso).toBe(new Date(exp * 1000).toISOString());
    expect(result.customerIdChars).toBe(6);
    expect(result.agentTypeChars).toBe(1);
  });

  test("a token without exp yields null expiry", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ code: jwt({ sub: "x" }) }),
    );
    const result = await authenticateCustomer({ ...CREDS, fetchImpl });
    expect(result.expiresAtIso).toBeNull();
    expect(result.expiresInSec).toBeNull();
  });
});

describe("failures are typed and never echo secrets", () => {
  test("non-200 JSON carries status and short server msg", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ status: "Failed", msg: "Invalid CustomerID" }, 400),
    );
    const error = await authenticateCustomer({ ...CREDS, fetchImpl }).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(F402AuthenticateCustomerError);
    const typed = error as F402AuthenticateCustomerError;
    expect(typed.status).toBe(400);
    expect(typed.message).toContain("HTTP 400");
    expect(typed.message).toContain("Invalid CustomerID");
    expect(typed.message).not.toContain("PÄSSWORD");
  });

  test("401 HTML is a status failure", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("<html>401</html>", { status: 401 }),
    );
    await expect(authenticateCustomer({ ...CREDS, fetchImpl })).rejects.toThrow(
      /HTTP 401/,
    );
  });

  test("missing or invalid code fails closed", async () => {
    const noCode = fakeFetch(() => jsonResponse({ accountInfo: {} }));
    await expect(
      authenticateCustomer({ ...CREDS, fetchImpl: noCode.fetchImpl }),
    ).rejects.toThrow(/no `code`/);

    const short = fakeFetch(() => jsonResponse({ code: "short" }));
    await expect(
      authenticateCustomer({ ...CREDS, fetchImpl: short.fetchImpl }),
    ).rejects.toThrow(/not a valid bearer token/);
  });

  test("network error is wrapped without the password", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as (input: string, init: RequestInit) => Promise<Response>;
    const error = await authenticateCustomer({ ...CREDS, fetchImpl }).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(F402AuthenticateCustomerError);
    expect((error as Error).message).toContain("fetch failed");
    expect((error as Error).message).not.toContain("PÄSSWORD");
  });
});
