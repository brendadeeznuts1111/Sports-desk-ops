/**
 * @file tests/db_integration.test.ts
 * @description End-to-end integration tests with PostgreSQL (sportsdesk_test):
 *  - Real round-trip: login -> sd_session + sd_csrf -> /api/auth/me -> logout -> unauthenticated
 *  - Single-pass rehash verification: weak PHC upgraded in-place to m=47104 on login
 *  - Account lockout verification: 10 bad attempts trigger 15-minute locked_until
 *  - Real session TTL and idle timeout verification via DB timestamp manipulation
 *  - Session revocation, cascade, and sweep cleanup
 *  - Double-submit CSRF enforcement on real sessions
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  handleLogin,
  handleLogout,
  handleSessionMe,
  parseCookies,
  requireCsrf,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "../lib/http_auth.ts";
import { getOperatorByUsername, listOperators, sql } from "../lib/db.ts";
import {
  sessionCreate,
  sessionVerify,
  sessionRevokeAllForOperator,
  sessionCleanup,
} from "../lib/session.ts";
import { hashPassword, needsRehash, sha256Hex } from "../lib/auth.ts";
import { loginLimiter, loginKey } from "../lib/rate_limit.ts";

// Set environment defaults for sportsdesk_test
const envObj = process.env as Record<string, string | undefined>;
envObj.PGDATABASE = envObj.PGDATABASE ?? "sportsdesk_test";
envObj.PGUSER = envObj.PGUSER ?? "nolarose";
envObj.PGPASSWORD = envObj.PGPASSWORD ?? "";
envObj.SPORTSDESK_CSRF_SECRET =
  envObj.SPORTSDESK_CSRF_SECRET ??
  "sportsdesk_csrf_secret_integration_test_key_32c";

let dbAvailable = false;
try {
  await sql`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe("PostgreSQL Integration Suite (sportsdesk_test)", () => {
  if (!dbAvailable) {
    if (process.env.REQUIRE_DB_TESTS === "1") {
      throw new Error(
        `REQUIRE_DB_TESTS=1 set but PostgreSQL is not reachable at ${process.env.PGHOST ?? "localhost"}:${process.env.PGPORT ?? "5432"}`,
      );
    }
    it.skip("PostgreSQL (sportsdesk_test) not reachable — skipping live DB suite", () => {});
    return;
  }

  beforeAll(async () => {
    // Ensure tables exist
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Apply migrations if tables don't exist
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
    `;
    const names = new Set(tables.map((t) => t.tablename));

    if (!names.has("operators")) {
      const opMigration = await Bun.file("migrations/001_operators.sql").text();
      await sql.begin(async (tx) => {
        await tx.unsafe(opMigration);
        await tx`INSERT INTO schema_migrations (filename) VALUES ('001_operators.sql') ON CONFLICT DO NOTHING`;
      });
    }

    if (!names.has("sessions")) {
      const sessMigration = await Bun.file(
        "migrations/002_sessions.sql",
      ).text();
      await sql.begin(async (tx) => {
        await tx.unsafe(sessMigration);
        await tx`INSERT INTO schema_migrations (filename) VALUES ('002_sessions.sql') ON CONFLICT DO NOTHING`;
      });
    }

    // Clean tables before tests
    await sql`TRUNCATE operators, sessions CASCADE`;
  });

  afterAll(async () => {
    try {
      await sql.close();
    } catch {
      // ignore
    }
  });

  it("completes full auth lifecycle: login -> authenticated me -> logout -> 401", async () => {
    // 1. Seed operator
    const initialHash = await hashPassword("super-secret-operator-pass-123");
    await sql`
      INSERT INTO operators (username, role, password_hash)
      VALUES ('trader_bob', 'operator', ${initialHash})
    `;

    // 2. Perform login
    const loginReq = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "trader_bob",
        password: "super-secret-operator-pass-123",
      }),
    });

    const loginRes = await handleLogin(loginReq);
    expect(loginRes.status).toBe(200);

    const loginData = (await loginRes.json()) as {
      expiresAt: string;
      rehash: boolean;
      csrfToken: string;
    };
    expect(loginData.rehash).toBe(false);
    expect(typeof loginData.csrfToken).toBe("string");

    // Check Set-Cookie headers
    const rawCookies = loginRes.headers.get("set-cookie") ?? "";
    expect(rawCookies).toContain(SESSION_COOKIE_NAME);
    expect(rawCookies).toContain("HttpOnly");
    expect(rawCookies).toContain(CSRF_COOKIE_NAME);

    const cookieHeader = [
      `${SESSION_COOKIE_NAME}=${
        loginRes.headers
          .getSetCookie?.()
          .find((c) => c.startsWith(SESSION_COOKIE_NAME))
          ?.split(";")[0]
          ?.split("=")[1] ?? ""
      }`,
      `${CSRF_COOKIE_NAME}=${loginData.csrfToken}`,
    ].join("; ");

    // 3. Query /api/auth/me with session cookie
    const meReq = new Request("http://localhost:4022/api/auth/me", {
      method: "GET",
      headers: { cookie: cookieHeader },
    });
    const meRes = await handleSessionMe(meReq);
    expect(meRes.status).toBe(200);
    const meData = (await meRes.json()) as {
      operator: { username: string; role: string };
    };
    expect(meData.operator.username).toBe("trader_bob");
    expect(meData.operator.role).toBe("operator");

    // 4. Perform logout
    const logoutReq = new Request("http://localhost:4022/api/auth/logout", {
      method: "POST",
      headers: { cookie: cookieHeader },
    });
    const logoutRes = await handleLogout(logoutReq);
    expect(logoutRes.status).toBe(204);

    // 5. Subsequent /api/auth/me returns 401
    const meAfterLogoutRes = await handleSessionMe(meReq);
    expect(meAfterLogoutRes.status).toBe(401);
  });

  it("verifies single-pass rehash: upgrades weak m=19456 hash to m=47104 on login", async () => {
    // Seed with lower Argon2id params (m=19456, t=2)
    const weakHash = await Bun.password.hash("rehash-password-test-99", {
      algorithm: "argon2id",
      memoryCost: 19456,
      timeCost: 2,
    });
    expect(weakHash).toContain("m=19456");
    expect(needsRehash(weakHash)).toBe(true);

    await sql`
      INSERT INTO operators (username, role, password_hash)
      VALUES ('legacy_trader', 'admin', ${weakHash})
    `;

    // First login should detect needsRehash, hash once, and persist upgraded hash
    const req1 = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "legacy_trader",
        password: "rehash-password-test-99",
      }),
    });
    const res1 = await handleLogin(req1);
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as { rehash: boolean };
    expect(data1.rehash).toBe(true);

    // Verify row in database has upgraded params (m=47104)
    const op = await getOperatorByUsername("legacy_trader");
    expect(op).not.toBeNull();
    expect(op?.password_hash).toContain("m=47104");
    expect(needsRehash(op!.password_hash)).toBe(false);

    // Second login should not trigger rehash
    const req2 = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "legacy_trader",
        password: "rehash-password-test-99",
      }),
    });
    const res2 = await handleLogin(req2);
    expect(res2.status).toBe(200);
    const data2 = (await res2.json()) as { rehash: boolean };
    expect(data2.rehash).toBe(false);
  });

  it("enforces account lockout after 10 failed attempts", async () => {
    const pw = "lockout-test-pass-456";
    const pwHash = await hashPassword(pw);
    await sql`
      INSERT INTO operators (username, role, password_hash)
      VALUES ('lockout_target', 'viewer', ${pwHash})
    `;

    // Reset IP rate limiter to test DB-level username lockout in isolation
    const ip = "192.0.2.1";

    // 9 failed attempts: operator is NOT yet locked
    for (let i = 1; i <= 9; i++) {
      loginLimiter.reset(loginKey(ip));
      const req = new Request("http://localhost:4022/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: JSON.stringify({
          username: "lockout_target",
          password: "wrong-password",
        }),
      });
      const res = await handleLogin(req);
      expect(res.status).toBe(401);
    }

    const opAfter9 = await getOperatorByUsername("lockout_target");
    expect(opAfter9?.failed_attempts).toBe(9);
    expect(opAfter9?.locked_until).toBeNull();

    // 10th failed attempt triggers locked_until
    loginLimiter.reset(loginKey(ip));
    const req10 = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({
        username: "lockout_target",
        password: "wrong-password",
      }),
    });
    const res10 = await handleLogin(req10);
    expect(res10.status).toBe(401);

    const opAfter10 = await getOperatorByUsername("lockout_target");
    expect(opAfter10?.failed_attempts).toBe(10);
    expect(opAfter10?.locked_until).not.toBeNull();
    const lockTime = new Date(opAfter10!.locked_until!).getTime();
    expect(lockTime).toBeGreaterThan(Date.now() + 10 * 60_000); // ~15 minutes

    // 11th attempt with the CORRECT password fails because account is locked
    loginLimiter.reset(loginKey(ip));
    const req11 = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({
        username: "lockout_target",
        password: pw, // Correct password!
      }),
    });
    const res11 = await handleLogin(req11);
    expect(res11.status).toBe(401);

    // Fast-forward unlock via DB timestamp modification
    await sql`
      UPDATE operators
      SET locked_until = NOW() - INTERVAL '1 second'
      WHERE username = 'lockout_target'
    `;

    // Login with correct password now succeeds and resets failed_attempts
    loginLimiter.reset(loginKey(ip));
    const reqUnlock = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: JSON.stringify({
        username: "lockout_target",
        password: pw,
      }),
    });
    const resUnlock = await handleLogin(reqUnlock);
    expect(resUnlock.status).toBe(200);

    const opRestored = await getOperatorByUsername("lockout_target");
    expect(opRestored?.failed_attempts).toBe(0);
    expect(opRestored?.locked_until).toBeNull();
  });

  it("handles session idle timeout and absolute TTL expiration via DB timestamps", async () => {
    const op = (await listOperators())[0];
    if (!op) throw new Error("Expected at least one operator in database");

    // 1. Idle timeout expiration
    const { token: idleToken } = await sessionCreate(
      op.id,
      "127.0.0.1",
      "Test-Agent",
    );
    const active1 = await sessionVerify(idleToken);
    expect(active1).not.toBeNull();

    // Push last_seen_at past the 8-hour idle threshold (e.g. 9 hours ago)
    const idleHash = await sha256Hex(idleToken);
    await sql`
      UPDATE sessions
      SET last_seen_at = NOW() - INTERVAL '9 hours'
      WHERE token_hash = ${idleHash}
    `;
    const expiredIdle = await sessionVerify(idleToken);
    expect(expiredIdle).toBeNull();

    // 2. Absolute TTL expiration
    const { token: ttlToken } = await sessionCreate(
      op.id,
      "127.0.0.1",
      "Test-Agent",
    );
    const active2 = await sessionVerify(ttlToken);
    expect(active2).not.toBeNull();

    // Push expires_at into the past (e.g. 1 hour ago)
    const ttlHash = await sha256Hex(ttlToken);
    await sql`
      UPDATE sessions
      SET expires_at = NOW() - INTERVAL '1 hour'
      WHERE token_hash = ${ttlHash}
    `;
    const expiredTtl = await sessionVerify(ttlToken);
    expect(expiredTtl).toBeNull();
  });

  it("supports operator session revoke-all and cascade sweep cleanup", async () => {
    const pwHash = await hashPassword("pass-revoke-test");
    const [op] = await sql<{ id: number }[]>`
      INSERT INTO operators (username, role, password_hash)
      VALUES ('revoke_target', 'operator', ${pwHash})
      RETURNING id
    `;
    if (!op) throw new Error("Expected inserted operator");
    const s1 = await sessionCreate(op.id, "127.0.0.1", "Agent-1");
    const s2 = await sessionCreate(op.id, "127.0.0.1", "Agent-2");
    const s3 = await sessionCreate(op.id, "127.0.0.1", "Agent-3");

    expect(await sessionVerify(s1.token)).not.toBeNull();
    expect(await sessionVerify(s2.token)).not.toBeNull();
    expect(await sessionVerify(s3.token)).not.toBeNull();

    // Revoke all sessions for operator
    const revokedCount = await sessionRevokeAllForOperator(op.id);
    expect(revokedCount).toBe(3);

    expect(await sessionVerify(s1.token)).toBeNull();
    expect(await sessionVerify(s2.token)).toBeNull();
    expect(await sessionVerify(s3.token)).toBeNull();

    // Running sessionCleanup removes expired/idle/disabled rows
    await sessionCreate(op.id, "127.0.0.1", "Sweep-Agent-1");
    await sessionCreate(op.id, "127.0.0.1", "Sweep-Agent-2");
    await sql`
      UPDATE sessions
      SET expires_at = NOW() - INTERVAL '1 hour'
      WHERE operator_id = ${op.id}
    `;
    const cleaned = await sessionCleanup();
    expect(cleaned).toBeGreaterThanOrEqual(2);
  });

  it("validates double-submit CSRF with session cookies on mutating requests", async () => {
    // 1. Log in to get genuine session & CSRF tokens
    const loginReq = new Request("http://localhost:4022/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "legacy_trader",
        password: "rehash-password-test-99",
      }),
    });
    const loginRes = await handleLogin(loginReq);
    expect(loginRes.status).toBe(200);
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };

    const cookies = parseCookies(loginRes.headers.get("set-cookie"));
    const sessionToken = cookies[SESSION_COOKIE_NAME];
    expect(sessionToken).toBeDefined();

    // 2. Mutating request with valid CSRF cookie and matching header -> passes (200)
    const validReq = new Request("http://localhost:4022/api/terminal/exec", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
        [CSRF_HEADER_NAME]: csrfToken,
      },
    });
    const validRes = await requireCsrf(
      validReq,
      async () => new Response("EXEC_OK"),
    );
    expect(validRes.status).toBe(200);
    expect(await validRes.text()).toBe("EXEC_OK");

    // 3. Mutating request with mismatched CSRF header -> fails (403)
    const forgedReq = new Request("http://localhost:4022/api/terminal/exec", {
      method: "POST",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
        [CSRF_HEADER_NAME]: "forged_cross_site_token",
      },
    });
    const forgedRes = await requireCsrf(
      forgedReq,
      async () => new Response("EXEC_OK"),
    );
    expect(forgedRes.status).toBe(403);
    const forgedJson = (await forgedRes.json()) as { error: string };
    expect(forgedJson.error).toBe("csrf_failed");
  });
});
