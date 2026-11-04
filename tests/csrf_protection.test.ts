import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * Mutating `/api/telegram/*` and `/api/watchlist` calls hold ambient authority through the
 * browser's cookie jar even though the dashboard authenticates with an explicit bearer.
 * `/api/csrf` mints a per-visitor HttpOnly session cookie and an HMAC token bound to it
 * (`SPORTSDESK_CSRF_SECRET`); the guard then accepts mutating calls only with that pair.
 *
 * These tests set their own env and bind 127.0.0.1:0; no live daemon, no Telegram, no network.
 * A wrong token never reaches the dispatchers, so no test here performs a real alert/report.
 */

const SECRET = "csrf-test-secret-0123456789";

/** `Bun.env` properties are typed readonly; mutate through Reflect. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(Bun.env, key);
  else Reflect.set(Bun.env, key, value);
}

const savedToken = Bun.env["SPORTSDESK_ADMIN_TOKEN"];
const savedSecret = Bun.env["SPORTSDESK_CSRF_SECRET"];
const ADMIN = "csrf-test-admin-token";
// The telegram/watchlist gate is deliberately unconditional (unlike the PII guard, loopback
// is not exempt), so mutations must carry both the bearer and the CSRF pair — the dashboard does.
setEnv("SPORTSDESK_ADMIN_TOKEN", ADMIN);
setEnv("SPORTSDESK_CSRF_SECRET", SECRET);

const BEARER = { authorization: `Bearer ${ADMIN}` };

const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  setEnv("SPORTSDESK_ADMIN_TOKEN", savedToken);
  setEnv("SPORTSDESK_CSRF_SECRET", savedSecret);
});

async function issueToken(): Promise<{
  session: string;
  token: string;
}> {
  const res = await fetch(`${base}/api/csrf`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const body = (await res.json()) as { success: boolean; token: string };
  const session = /session=([^;]+)/.exec(setCookie)?.[1] ?? "";
  return { session, token: body.token };
}

describe("CSRF token issuer", () => {
  test("mints a session cookie and a token bound to it", async () => {
    const res = await fetch(`${base}/api/csrf`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; token: string };
    expect(body.success).toBe(true);
    expect(typeof body.token).toBe("string");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^session=/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const session = /session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(
      Bun.CSRF.verify(body.token, { secret: SECRET, sessionId: session }),
    ).toBe(true);
    expect(
      Bun.CSRF.verify(body.token, { secret: SECRET, sessionId: "other" }),
    ).toBe(false);
  });

  test("re-issues a token for an existing session without a new cookie", async () => {
    const first = await fetch(`${base}/api/csrf`);
    const session =
      /session=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect(session).not.toBe("");

    const res = await fetch(`${base}/api/csrf`, {
      headers: { cookie: `session=${session}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { success: boolean; token: string };
    expect(
      Bun.CSRF.verify(body.token, { secret: SECRET, sessionId: session }),
    ).toBe(true);
  });

  test("creates a new session for a malformed non-UUID session cookie", async () => {
    const res = await fetch(`${base}/api/csrf`, {
      headers: { cookie: "session=not-a-uuid" },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^session=/);
    const session = /session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const body = (await res.json()) as { success: boolean; token: string };
    expect(
      Bun.CSRF.verify(body.token, { secret: SECRET, sessionId: session }),
    ).toBe(true);
  });

  test("creates a new session for duplicate session cookies", async () => {
    const issued = await issueToken();
    const res = await fetch(`${base}/api/csrf`, {
      headers: {
        cookie: `session=${issued.session}; session=${issued.session}`,
      },
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^session=/);
    const rebound = /session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(rebound).not.toBe(issued.session);
  });

  test("rejects an over-long non-UUID session cookie", async () => {
    const res = await fetch(`${base}/api/csrf`, {
      headers: { cookie: `session=${"x".repeat(257)}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^session=/);
  });

  test("the dashboard retries once with a fresh token after 403 CSRF rejection", async () => {
    const dashboard = await Bun.file(
      "static/customer-churn-simulation-dashboard.html",
    ).text();
    expect(dashboard).toContain('body?.error === "Invalid CSRF token"');
    expect(dashboard).toContain("loadCsrfToken");
  });

  test("503s when the secret is unset", async () => {
    setEnv("SPORTSDESK_CSRF_SECRET", undefined);
    try {
      const res = await fetch(`${base}/api/csrf`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("SPORTSDESK_CSRF_SECRET");
    } finally {
      setEnv("SPORTSDESK_CSRF_SECRET", SECRET);
    }
  });
});

describe("mutating routes require the session-bound token", () => {
  test("POST /api/watchlist without a token is 403 before the handler runs", async () => {
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: BEARER,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toBe("Invalid CSRF token");
  });

  test("POST with a token bound to a different session is 403", async () => {
    const first = await issueToken();
    const second = await issueToken();
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${second.session}`,
        "x-csrf-token": first.token,
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST with a matching token and session passes the guard", async () => {
    const { session, token } = await issueToken();
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${session}`,
        "x-csrf-token": token,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test("POST with a tampered token is 403", async () => {
    const { session, token } = await issueToken();
    // Flip a payload byte, not the final base64 character: the last character can carry only
    // padding bits, so changing it may decode to the same bytes and still verify.
    const at = 5;
    const flipped = token[at] === "A" ? "B" : "A";
    const tampered = `${token.slice(0, at)}${flipped}${token.slice(at + 1)}`;
    expect(tampered).not.toBe(token);
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${session}`,
        "x-csrf-token": tampered,
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST with a token signed by another secret is 403", async () => {
    const { session } = await issueToken();
    const foreign = Bun.CSRF.generate("another-secret", { sessionId: session });
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${session}`,
        "x-csrf-token": foreign,
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST with a token but no cookie is 403", async () => {
    const { token } = await issueToken();
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        "x-csrf-token": token,
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST with a cookie but no token is 403", async () => {
    const { session } = await issueToken();
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${session}`,
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST with an expired token is 403", async () => {
    const { session } = await issueToken();
    const expired = Bun.CSRF.generate(SECRET, {
      sessionId: session,
      expiresIn: 1,
    });
    await Bun.sleep(25);
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${session}`,
        "x-csrf-token": expired,
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST with a malformed non-UUID session cookie is 403", async () => {
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: "session=not-a-uuid",
        "x-csrf-token": "anything",
      },
    });
    expect(res.status).toBe(403);
  });

  test("POST /api/telegram/alert without a token is 403 (no dispatch attempted)", async () => {
    const res = await fetch(`${base}/api/telegram/alert`, {
      method: "POST",
      headers: {
        ...BEARER,
        "content-type": "application/json",
      },
      body: JSON.stringify({ customerId: "TEST" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  test("POST with an expired token for /api/telegram/alert is 403 (no dispatch attempted)", async () => {
    const { session } = await issueToken();
    const expired = Bun.CSRF.generate(SECRET, {
      sessionId: session,
      expiresIn: 1,
    });
    await Bun.sleep(25);
    const res = await fetch(`${base}/api/telegram/alert`, {
      method: "POST",
      headers: {
        ...BEARER,
        cookie: `session=${session}`,
        "content-type": "application/json",
        "x-csrf-token": expired,
      },
      body: JSON.stringify({ customerId: "TEST" }),
    });
    expect(res.status).toBe(403);
  });

  test("GET routes require the bearer but not a CSRF token (unchanged)", async () => {
    const res = await fetch(`${base}/api/watchlist`, { headers: BEARER });
    expect(res.status).toBe(200);
  });

  test("POST with a valid CSRF pair but no bearer is 401, not 403", async () => {
    const { session, token } = await issueToken();
    const res = await fetch(`${base}/api/watchlist`, {
      method: "POST",
      headers: {
        cookie: `session=${session}`,
        "x-csrf-token": token,
      },
    });
    expect(res.status).toBe(401);
  });

  test("POST /telegram/webhook still uses the Telegram secret, not CSRF", async () => {
    const res = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { text: "ping" } }),
    });
    // isWebhookSecretValid(null) is false, so the arm answers 401 — never 403.
    expect(res.status).toBe(401);
  });

  test("503s on mutations when the secret is unset", async () => {
    setEnv("SPORTSDESK_CSRF_SECRET", undefined);
    try {
      const res = await fetch(`${base}/api/watchlist`, {
        method: "POST",
        headers: BEARER,
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toContain("SPORTSDESK_CSRF_SECRET");
    } finally {
      setEnv("SPORTSDESK_CSRF_SECRET", SECRET);
    }
  });
});
