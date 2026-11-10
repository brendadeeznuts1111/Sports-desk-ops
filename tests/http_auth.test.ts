/**
 * @file tests/http_auth.test.ts
 * @description HTTP authentication layer tests: login, logout, cookie handling, requireSession middleware.
 */

import { describe, expect, it } from "bun:test";
import {
  clientIp,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  handleLogin,
  handleLogout,
  handleSessionMe,
  issueCsrf,
  parseCookies,
  requireCsrf,
  requireSession,
  SESSION_COOKIE_NAME,
  verifyCsrf,
  type AuthedContext,
} from "../lib/http_auth.ts";

describe("HTTP Auth Layer (lib/http_auth.ts)", () => {
  describe("Cookie & IP Utilities", () => {
    it("parses cookies from Cookie header accurately", () => {
      const header = "theme=dark; sd_session=test-token-123; tracking=0";
      const cookies = parseCookies(header);
      expect(cookies.theme).toBe("dark");
      expect(cookies[SESSION_COOKIE_NAME]).toBe("test-token-123");
      expect(cookies.tracking).toBe("0");

      expect(parseCookies(null)).toEqual({});
      expect(parseCookies("")).toEqual({});
    });

    it("extracts client IP with and without TRUST_PROXY", () => {
      const req = new Request("http://localhost:4022", {
        headers: {
          "x-forwarded-for": "203.0.113.195, 70.41.3.18",
          "x-real-ip": "203.0.113.195",
        },
      });

      // Without TRUST_PROXY
      delete (process.env as Record<string, string | undefined>).TRUST_PROXY;
      const ipDirect = clientIp(req);
      expect(ipDirect).toBe("203.0.113.195");

      // With TRUST_PROXY=1
      (process.env as Record<string, string | undefined>).TRUST_PROXY = "1";
      const ipTrusted = clientIp(req);
      expect(ipTrusted).toBe("203.0.113.195");
      delete (process.env as Record<string, string | undefined>).TRUST_PROXY;
    });
  });

  describe("handleLogin endpoint", () => {
    it("returns 400 on invalid JSON or missing credentials", async () => {
      // Invalid JSON
      const reqInvalidJson = new Request(
        "http://localhost:4022/api/auth/login",
        {
          method: "POST",
          body: "not json",
          headers: { "content-type": "application/json" },
        },
      );
      const res1 = await handleLogin(reqInvalidJson);
      expect(res1.status).toBe(400);
      const json1 = (await res1.json()) as { error: string };
      expect(json1.error).toBe("invalid_json");

      // Missing username or password
      const reqMissing = new Request("http://localhost:4022/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "only_user" }),
        headers: { "content-type": "application/json" },
      });
      const res2 = await handleLogin(reqMissing);
      expect(res2.status).toBe(400);
      const json2 = (await res2.json()) as { error: string };
      expect(json2.error).toBe("missing_credentials");
    });
  });

  describe("handleLogout endpoint", () => {
    it("returns 204 No Content and clears session cookie", async () => {
      let revokedToken: string | null = null;
      const req = new Request("http://localhost:4022/api/auth/logout", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=some-active-token`,
        },
      });

      const res = await handleLogout(req, async (token) => {
        revokedToken = token;
      });
      expect(res.status).toBe(204);
      expect(String(revokedToken)).toBe("some-active-token");
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(setCookie).toContain("Max-Age=0");
    });
  });

  describe("requireSession middleware", () => {
    it("returns 401 unauthenticated when no cookie is provided", async () => {
      const req = new Request("http://localhost:4022/api/dashboard");
      const res = await requireSession(req, async () => new Response("OK"));
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("unauthenticated");
    });

    it("returns 401 and clears cookie when token is invalid or expired", async () => {
      const req = new Request("http://localhost:4022/api/dashboard", {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=nonexistent_token_123`,
        },
      });

      // Pass mock verifySession returning null for nonexistent token
      const res = await requireSession(
        req,
        async () => new Response("OK"),
        async () => null,
      );
      expect(res.status).toBe(401);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(setCookie).toContain("Max-Age=0");
    });

    it("forwards authed context to next handler when session is valid", async () => {
      const mockVerified = {
        operator: {
          id: 42,
          username: "chief_trader",
          role: "admin" as const,
          disabled: false,
          created_at: new Date().toISOString(),
        },
        session: {
          expiresAt: new Date(Date.now() + 100_000).toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      };

      const req = new Request("http://localhost:4022/api/dashboard", {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=valid_active_token`,
        },
      });

      let capturedContext: AuthedContext | null = null;
      const res = await requireSession(
        req,
        async (ctx) => {
          capturedContext = ctx;
          return new Response("OK");
        },
        async () => mockVerified,
      );

      expect(res.status).toBe(200);
      const ctx = capturedContext as AuthedContext | null;
      expect(ctx?.operator.username).toBe("chief_trader");
      expect(ctx?.operator.role).toBe("admin");
    });
  });

  describe("handleSessionMe endpoint", () => {
    it("returns 401 when unauthenticated", async () => {
      const req = new Request("http://localhost:4022/api/auth/me");
      const res = await handleSessionMe(req, async () => null);
      expect(res.status).toBe(401);
    });

    it("returns operator profile when session is valid", async () => {
      const mockVerified = {
        operator: {
          id: 99,
          username: "senior_risk",
          role: "operator" as const,
          disabled: false,
          created_at: new Date().toISOString(),
        },
        session: {
          expiresAt: new Date(Date.now() + 50_000).toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      };

      const req = new Request("http://localhost:4022/api/auth/me", {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=valid_token_99`,
        },
      });

      const res = await handleSessionMe(req, async () => mockVerified);
      expect(res.status).toBe(200);
      const data = (await res.json()) as typeof mockVerified;
      expect(data.operator.username).toBe("senior_risk");
      expect(data.operator.role).toBe("operator");
    });
  });

  describe("requireCsrf middleware", () => {
    it("passes non-mutating requests (GET, HEAD) without CSRF tokens", async () => {
      const reqGet = new Request("http://localhost:4022/api/wagers", {
        method: "GET",
      });
      const resGet = await requireCsrf(reqGet, async () => new Response("OK"));
      expect(resGet.status).toBe(200);

      const reqHead = new Request("http://localhost:4022/api/wagers", {
        method: "HEAD",
      });
      const resHead = await requireCsrf(
        reqHead,
        async () => new Response("OK"),
      );
      expect(resHead.status).toBe(200);
    });

    it("returns 403 csrf_failed when mutating request lacks x-csrf-token header", async () => {
      const validToken = issueCsrf();
      const req = new Request("http://localhost:4022/api/terminal/exec", {
        method: "POST",
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${validToken}`,
        },
      });
      const res = await requireCsrf(req, async () => new Response("OK"));
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("csrf_failed");
    });

    it("returns 403 csrf_failed when mutating request lacks sd_csrf cookie", async () => {
      const validToken = issueCsrf();
      const req = new Request("http://localhost:4022/api/terminal/exec", {
        method: "POST",
        headers: {
          [CSRF_HEADER_NAME]: validToken,
        },
      });
      const res = await requireCsrf(req, async () => new Response("OK"));
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("csrf_failed");
    });

    it("returns 403 csrf_failed when cookie and header tokens do not match", async () => {
      const token1 = issueCsrf();
      const token2 = issueCsrf();
      const req = new Request("http://localhost:4022/api/terminal/exec", {
        method: "POST",
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${token1}`,
          [CSRF_HEADER_NAME]: token2,
        },
      });
      const res = await requireCsrf(req, async () => new Response("OK"));
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("csrf_failed");
    });

    it("passes mutating request when cookie and header match with valid token", async () => {
      const token = issueCsrf();
      const req = new Request("http://localhost:4022/api/terminal/exec", {
        method: "POST",
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${token}`,
          [CSRF_HEADER_NAME]: token,
        },
      });
      const res = await requireCsrf(req, async () => new Response("ALLOWED"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ALLOWED");
    });

    it("rejects token issued with a foreign secret (multi-process isolation check)", async () => {
      const foreignToken = issueCsrf({
        secret: "foreign_unshared_secret_123",
      });
      const req = new Request("http://localhost:4022/api/terminal/exec", {
        method: "POST",
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${foreignToken}`,
          [CSRF_HEADER_NAME]: foreignToken,
        },
      });
      // The validator configured with primary daemon secret rejects foreign-issued token
      const res = await requireCsrf(
        req,
        async () => new Response("ALLOWED"),
        (t) => verifyCsrf(t, { secret: "primary_daemon_secret_456" }),
      );
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("csrf_failed");
    });
  });

  describe("Surveillance Alert Endpoints Auth & CSRF Protection", () => {
    const mockContext: AuthedContext = {
      operator: {
        id: 1,
        username: "senior_risk",
        role: "operator" as const,
        disabled: false,
        created_at: new Date().toISOString(),
      },
      session: {
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    };

    it("rejects POST /api/alerts/:id/ack when unauthenticated (401)", async () => {
      const req = new Request(
        "http://localhost:4022/api/alerts/deliv-12345/ack",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notes: "Unauthenticated test" }),
        },
      );

      const authRes = await requireSession(req, async () => new Response("OK"));
      expect(authRes.status).toBe(401);
      const json = (await authRes.json()) as { error: string };
      expect(json.error).toBe("unauthenticated");
    });

    it("rejects POST /api/alerts/:id/ack when authenticated but missing CSRF header (403)", async () => {
      const csrfToken = issueCsrf();
      const req = new Request(
        "http://localhost:4022/api/alerts/deliv-12345/ack",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${SESSION_COOKIE_NAME}=valid-sess; ${CSRF_COOKIE_NAME}=${csrfToken}`,
          },
          body: JSON.stringify({ notes: "Missing header test" }),
        },
      );

      // Session succeeds
      const authRes = await requireSession(
        req,
        async () => new Response("OK"),
        async () => mockContext,
      );
      expect(authRes.status).toBe(200);

      // CSRF fails due to missing x-csrf-token header
      const csrfRes = await requireCsrf(req, async () => new Response("OK"));
      expect(csrfRes.status).toBe(403);
      const json = (await csrfRes.json()) as { error: string };
      expect(json.error).toBe("csrf_failed");
    });

    it("allows POST /api/alerts/:id/ack when authenticated and valid CSRF supplied", async () => {
      const csrfToken = issueCsrf();
      const req = new Request(
        "http://localhost:4022/api/alerts/deliv-12345/ack",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${SESSION_COOKIE_NAME}=valid-sess; ${CSRF_COOKIE_NAME}=${csrfToken}`,
            [CSRF_HEADER_NAME]: csrfToken,
          },
          body: JSON.stringify({ notes: "Valid test" }),
        },
      );

      const authRes = await requireSession(
        req,
        async () => new Response("OK"),
        async () => mockContext,
      );
      expect(authRes.status).toBe(200);

      const csrfRes = await requireCsrf(
        req,
        async () => new Response("ACKNOWLEDGED"),
      );
      expect(csrfRes.status).toBe(200);
      expect(await csrfRes.text()).toBe("ACKNOWLEDGED");
    });

    it("rejects POST /api/alerts/:id/retry when unauthenticated or lacking CSRF", async () => {
      // 1. Unauthenticated -> 401
      const reqUnauth = new Request(
        "http://localhost:4022/api/alerts/deliv-12345/retry",
        {
          method: "POST",
        },
      );
      const authRes = await requireSession(
        reqUnauth,
        async () => new Response("OK"),
      );
      expect(authRes.status).toBe(401);

      // 2. Missing CSRF -> 403
      const csrfToken = issueCsrf();
      const reqNoCsrf = new Request(
        "http://localhost:4022/api/alerts/deliv-12345/retry",
        {
          method: "POST",
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=valid-sess; ${CSRF_COOKIE_NAME}=${csrfToken}`,
          },
        },
      );
      const csrfRes = await requireCsrf(
        reqNoCsrf,
        async () => new Response("OK"),
      );
      expect(csrfRes.status).toBe(403);
    });
  });
});
