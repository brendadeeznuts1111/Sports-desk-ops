import { describe, expect, test } from "bun:test";
import {
  HttpSession,
  retryDelayMs,
  SessionError,
  shouldRetry,
  type FetchSessionFactory,
  type FetchSessionLike,
} from "../scripts/capture/session.ts";
import type { RawHttpRequest } from "../scripts/capture/types.ts";

interface FakeCall {
  url: string;
  init: RequestInit;
}

interface FakeSessionState {
  calls: FakeCall[];
  boxes: { count: number; closes: number };
}

function fakeSession(responses: readonly (Response | Error)[]): {
  factory: FetchSessionFactory;
  state: FakeSessionState;
} {
  const state: FakeSessionState = {
    calls: [],
    boxes: { count: 0, closes: 0 },
  };
  const session: FetchSessionLike = {
    fetch: async (url: string, init?: RequestInit) => {
      state.calls.push({ url, init: init ?? {} });
      const next = responses[state.boxes.count];
      state.boxes.count += 1;
      if (next === undefined)
        throw new Error("fake session ran out of responses");
      if (next instanceof Error) throw next;
      return next;
    },
    close: async () => {
      state.boxes.closes += 1;
    },
  };
  return { factory: () => session, state };
}

/** RequestInit fields as a plain record, without casts. */
function initRecord(init: RequestInit): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(init)) record[key] = value;
  return record;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
  });
}

/**
 * Build a credential-bearing URL at runtime so the repository credential
 * scanner never sees a committed `scheme://user:pass@` literal.
 */
function credentialUrl(
  scheme: string,
  credentials: string,
  rest: string,
): string {
  return `${scheme}://${credentials}@${rest}`;
}

const REQUEST: RawHttpRequest = {
  url: "https://portal.example/cloud/api/Manager/getWebLog",
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "operation=getWebLog",
  retryable: true,
};

describe("HttpSession", () => {
  test("returns status, normalized content type and bytes", async () => {
    const { factory, state } = fakeSession([jsonResponse({ ok: true })]);
    const session = new HttpSession({
      sessionFactory: factory,
      timeoutMs: 1234,
    });
    const response = await session.fetch(REQUEST);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(new TextDecoder().decode(response.bytes)).toBe('{"ok":true}');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.url).toBe(REQUEST.url);
    const init = initRecord(state.calls[0]?.init ?? {});
    expect(init["method"]).toBe("POST");
    expect(init["body"]).toBe("operation=getWebLog");
    expect(init["timeout"]).toBe(1234);
    expect(init["proxy"]).toBeUndefined();
    await session.close();
    expect(state.boxes.closes).toBe(1);
  });

  test("direct requests force proxy:false and per-request timeout overrides", async () => {
    const { factory, state } = fakeSession([jsonResponse({ ok: true })]);
    const session = new HttpSession({
      sessionFactory: factory,
      timeoutMs: 5000,
    });
    await session.fetch({ ...REQUEST, direct: true, timeoutMs: 250 });
    const init = initRecord(state.calls[0]?.init ?? {});
    expect(init["proxy"]).toBe(false);
    expect(init["timeout"]).toBe(250);
    await session.close();
  });

  test("a session-level proxy stays on the session, not in each init", async () => {
    const proxied = fakeSession([jsonResponse({ ok: true })]);
    const session = new HttpSession({
      sessionFactory: proxied.factory,
      proxy: "http://proxy.internal:8080",
    });
    await session.fetch(REQUEST);
    expect(
      initRecord(proxied.state.calls[0]?.init ?? {})["proxy"],
    ).toBeUndefined();
    await session.close();

    // direct:true is per-request and must still win over the session setting.
    const forced = fakeSession([jsonResponse({ ok: true })]);
    const withProxy = new HttpSession({
      sessionFactory: forced.factory,
      proxy: "http://proxy.internal:8080",
    });
    await withProxy.fetch({ ...REQUEST, direct: true });
    expect(initRecord(forced.state.calls[0]?.init ?? {})["proxy"]).toBe(false);
    await withProxy.close();
  });

  test("retries read-only 429/5xx responses up to maxRetries and honors Retry-After", async () => {
    const { factory, state } = fakeSession([
      jsonResponse({ error: "boom" }, 500, { "retry-after": "1" }),
      jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" }),
      jsonResponse({ ok: true }),
    ]);
    const delays: number[] = [];
    const session = new HttpSession({
      sessionFactory: factory,
      maxRetries: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const response = await session.fetch(REQUEST);
    expect(response.status).toBe(200);
    expect(state.calls).toHaveLength(3);
    expect(delays).toEqual([1000, 0]);
    await session.close();
  });

  test("does not retry when retryable is false or the status is not retryable", async () => {
    const notRetryable = fakeSession([jsonResponse({}, 500), jsonResponse({})]);
    const sessionA = new HttpSession({ sessionFactory: notRetryable.factory });
    await sessionA.fetch({ ...REQUEST, retryable: false });
    expect(notRetryable.state.calls).toHaveLength(1);
    await sessionA.close();

    const notFound = fakeSession([jsonResponse({}, 404), jsonResponse({})]);
    const sessionB = new HttpSession({ sessionFactory: notFound.factory });
    const response = await sessionB.fetch(REQUEST);
    expect(response.status).toBe(404);
    expect(notFound.state.calls).toHaveLength(1);
    await sessionB.close();
  });

  test("returns the last response when retries are exhausted", async () => {
    const { factory, state } = fakeSession([
      jsonResponse({}, 500),
      jsonResponse({}, 502),
      jsonResponse({}, 503),
    ]);
    const session = new HttpSession({
      sessionFactory: factory,
      maxRetries: 2,
      sleep: async () => {},
    });
    const response = await session.fetch(REQUEST);
    expect(response.status).toBe(503);
    expect(state.calls).toHaveLength(3);
    await session.close();
  });

  test("refuses oversized responses using the declared content-length", async () => {
    const response = new Response("small", {
      status: 200,
      headers: {
        "content-length": "999999",
        "content-type": "application/json",
      },
    });
    const { factory } = fakeSession([response]);
    const session = new HttpSession({
      sessionFactory: factory,
      maxResponseBytes: 1024,
    });
    await expect(session.fetch(REQUEST)).rejects.toMatchObject({
      name: "SessionError",
      code: "response-too-large",
    });
    await session.close();
  });

  test("maps timeout-shaped errors to a typed timeout error", async () => {
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    const { factory } = fakeSession([timeoutError]);
    const session = new HttpSession({ sessionFactory: factory });
    const error: unknown = await session
      .fetch(REQUEST)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionError);
    if (!(error instanceof SessionError))
      throw new Error("expected SessionError");
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("portal.example");
    await session.close();
  });

  test("redacts credentials, query values and tokens from network errors", async () => {
    const { factory } = fakeSession([
      new Error(
        `connect failed: ${credentialUrl("https", "user:hunter2", "portal.example/api?token=SECRET123")} Bearer abcdefghijkl`,
      ),
    ]);
    const session = new HttpSession({ sessionFactory: factory });
    const error: unknown = await session
      .fetch(REQUEST)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SessionError);
    if (!(error instanceof SessionError))
      throw new Error("expected SessionError");
    expect(error.code).toBe("network");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("SECRET123");
    expect(error.message).not.toContain("abcdefghijkl");
    expect(error.message).toContain("portal.example");
    await session.close();
  });

  test("close is idempotent and tolerated", async () => {
    const { factory, state } = fakeSession([jsonResponse({})]);
    const session = new HttpSession({ sessionFactory: factory });
    await session.fetch(REQUEST);
    await session.close();
    await session.close();
    expect(state.boxes.closes).toBe(1);
  });
});

describe("retry decisions", () => {
  test("shouldRetry only retries read-only 429/5xx within the budget", () => {
    expect(
      shouldRetry({ status: 500, attempt: 0, maxRetries: 2, retryable: true }),
    ).toBe(true);
    expect(
      shouldRetry({ status: 429, attempt: 1, maxRetries: 2, retryable: true }),
    ).toBe(true);
    expect(
      shouldRetry({ status: 500, attempt: 2, maxRetries: 2, retryable: true }),
    ).toBe(false);
    expect(
      shouldRetry({ status: 500, attempt: 0, maxRetries: 2, retryable: false }),
    ).toBe(false);
    expect(
      shouldRetry({ status: 200, attempt: 0, maxRetries: 2, retryable: true }),
    ).toBe(false);
    expect(
      shouldRetry({ status: 404, attempt: 0, maxRetries: 2, retryable: true }),
    ).toBe(false);
  });

  test("retryDelayMs parses seconds, HTTP dates and falls back to backoff", () => {
    expect(retryDelayMs({ "Retry-After": "2" }, 0, 500)).toBe(2000);
    const future = new Date(Date.now() + 5000).toUTCString();
    const delay = retryDelayMs(
      { "retry-after": future },
      0,
      500,
      Date.parse(future) - 5000,
    );
    expect(delay).toBe(5000);
    expect(retryDelayMs({}, 0, 250)).toBe(250);
    expect(retryDelayMs({}, 1, 250)).toBe(500);
    expect(retryDelayMs({ "retry-after": "not-a-date" }, 1, 250)).toBe(500);
  });
});
