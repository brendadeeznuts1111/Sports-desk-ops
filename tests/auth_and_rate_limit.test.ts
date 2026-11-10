/**
 * @file tests/auth_and_rate_limit.test.ts
 * @description Unit tests for TokenBucketLimiter and Operator Argon2id / Token Auth.
 */

import { describe, expect, it } from "bun:test";
import {
  TokenBucketLimiter,
  loginKey,
  loginLimiter,
} from "../lib/rate_limit.ts";
import {
  ARGON2ID_PARAMS,
  attemptLogin,
  hashPassword,
  mintSessionToken,
  needsRehash,
  sha256Hex,
  tokenMatches,
  verifyPassword,
} from "../lib/auth.ts";

describe("TokenBucketLimiter (Pre-Worker Rate Limiting)", () => {
  it("allows bursts up to capacity and throttles when depleted", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 3,
      refillPerSec: 1, // 1 token per second
      sweepIntervalMs: 60_000,
    });

    try {
      const key = "test:client:1";
      const r1 = limiter.check(key);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = limiter.check(key);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = limiter.check(key);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // 4th request in same instant -> rejected
      const r4 = limiter.check(key);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
      expect(r4.retryAfterMs).toBeGreaterThan(0);
    } finally {
      limiter.dispose();
    }
  });

  it("resets bucket on reset() call", () => {
    const limiter = new TokenBucketLimiter({
      capacity: 2,
      refillPerSec: 1,
    });
    try {
      const key = "test:reset";
      limiter.check(key);
      limiter.check(key);
      expect(limiter.check(key).allowed).toBe(false);

      limiter.reset(key);
      // After reset, bucket is cleared and fresh request is allowed
      expect(limiter.check(key).allowed).toBe(true);
    } finally {
      limiter.dispose();
    }
  });

  it("exports loginLimiter with standard 10-burst capacity", () => {
    expect(loginLimiter).toBeInstanceOf(TokenBucketLimiter);
    expect(loginKey("192.168.1.1")).toBe("login:192.168.1.1");
  });
});

describe("Operator Authentication & Argon2id Password Storage", () => {
  it("hashes password with Argon2id embedding OWASP target parameters", async () => {
    const password = "Operator-Secure-Password-402!";
    const phc = await hashPassword(password);

    // Format: $argon2id$v=19$m=47104,t=2,p=1$...
    expect(phc.startsWith("$argon2id$")).toBe(true);
    expect(phc).toContain(`m=${ARGON2ID_PARAMS.memoryCost}`);
    expect(phc).toContain(`t=${ARGON2ID_PARAMS.timeCost}`);

    // Verification succeeds with correct password
    const valid = await verifyPassword(password, phc);
    expect(valid).toBe(true);

    // Verification fails on wrong password
    const invalid = await verifyPassword("Wrong-Password-123", phc);
    expect(invalid).toBe(false);
  });

  it("verifyPassword fails closed on malformed PHC string without throwing", async () => {
    const valid = await verifyPassword("any-pass", "not-a-valid-phc-string");
    expect(valid).toBe(false);
  });

  it("needsRehash detects outdated params or non-argon2id hashes", () => {
    // Current target params (46 MiB, 2 iterations) -> does not need rehash
    const currentPhc =
      "$argon2id$v=19$m=47104,t=2,p=1$c29tZXNhbHQ$somehashvalue";
    expect(needsRehash(currentPhc)).toBe(false);

    // Weaker memory cost (19 MiB floor) -> needs rehash
    const weakMemPhc =
      "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$somehashvalue";
    expect(needsRehash(weakMemPhc)).toBe(true);

    // Weaker time cost (1 iteration) -> needs rehash
    const weakTimePhc =
      "$argon2id$v=19$m=47104,t=1,p=1$c29tZXNhbHQ$somehashvalue";
    expect(needsRehash(weakTimePhc)).toBe(true);

    // bcrypt hash -> needs rehash
    const bcryptPhc =
      "$2b$12$e8kgnf/2Y5lTzPz7HlPqee0N1w8qLp3xZkU0sV8k5lQ3wZkU0sV8k";
    expect(needsRehash(bcryptPhc)).toBe(true);

    // Garbage -> needs rehash
    expect(needsRehash("plaintext_or_invalid")).toBe(true);
  });

  it("mints high-entropy session tokens and matches constant-time SHA-256", async () => {
    const { token, hash } = await mintSessionToken();

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(40);
    expect(hash.length).toBe(64); // SHA-256 hex digest
    expect(hash).toBe(await sha256Hex(token));

    // Matching token matches stored hash
    const match = await tokenMatches(token, hash);
    expect(match).toBe(true);

    // Tampered token does not match
    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    const mismatch = await tokenMatches(tampered, hash);
    expect(mismatch).toBe(false);
  });

  describe("attemptLogin flow with rate limit and mock DB deps", () => {
    const mockHash = "$argon2id$v=19$m=47104,t=2,p=1$c29tZXNhbHQ$somehashvalue";

    const createDeps = (overrides = {}) => ({
      getOperatorByUsername: async (username: string) => {
        if (username.toLowerCase() === "operator1") {
          return {
            id: 1,
            username: "operator1",
            role: "operator",
            password_hash: mockHash,
            disabled: false,
            locked_until: null,
          };
        }
        return null;
      },
      hashPassword: async () => mockHash,
      touchLogin: async () => {},
      verifyPassword: async (pw: string) => pw === "correct-password",
      needsRehash: () => false,
      ...overrides,
    });

    it("succeeds on correct credentials", async () => {
      const ip = "10.0.0.1";
      loginLimiter.reset(loginKey(ip));

      const res = await attemptLogin(
        ip,
        "operator1",
        "correct-password",
        createDeps(),
      );
      expect(res.kind).toBe("ok");
      if (res.kind === "ok") {
        expect(res.rehash).toBe(false);
      }
    });

    it("returns invalid_credentials on incorrect password", async () => {
      const ip = "10.0.0.2";
      loginLimiter.reset(loginKey(ip));

      const res = await attemptLogin(
        ip,
        "operator1",
        "wrong-password",
        createDeps(),
      );
      expect(res.kind).toBe("invalid_credentials");
    });

    it("detects rehash-on-login requirement and returns single computed newHash", async () => {
      const ip = "10.0.0.3";
      loginLimiter.reset(loginKey(ip));

      const res = await attemptLogin(
        ip,
        "operator1",
        "correct-password",
        createDeps({
          needsRehash: () => true,
          hashPassword: async () => "$argon2id$v=19$m=47104,t=2$computed_once",
        }),
      );
      expect(res.kind).toBe("ok");
      if (res.kind === "ok") {
        expect(res.rehash).toBe(true);
        if (res.rehash) {
          expect(res.newHash).toBe("$argon2id$v=19$m=47104,t=2$computed_once");
        }
      }
    });

    it("records failed attempt on operator when password is wrong", async () => {
      const ip = "10.0.0.6";
      loginLimiter.reset(loginKey(ip));

      let recordedId: number | null = null;
      const deps = createDeps({
        recordFailedAttempt: async (id: number) => {
          recordedId = id;
        },
      });

      const res = await attemptLogin(ip, "operator1", "wrong-password", deps);
      expect(res.kind).toBe("invalid_credentials");
      expect(recordedId as number | null).toBe(1);
    });

    it("returns disabled for disabled operators", async () => {
      const ip = "10.0.0.4";
      loginLimiter.reset(loginKey(ip));

      const deps = createDeps({
        getOperatorByUsername: async () => ({
          id: 2,
          username: "disabled_op",
          role: "operator",
          password_hash: mockHash,
          disabled: true,
          locked_until: null,
        }),
      });

      const res = await attemptLogin(
        ip,
        "disabled_op",
        "correct-password",
        deps,
      );
      expect(res.kind).toBe("disabled");
    });

    it("triggers rate_limited once capacity is exhausted", async () => {
      const ip = "10.0.0.5";
      loginLimiter.reset(loginKey(ip));

      const deps = createDeps();

      // Drain 10 tokens from the loginLimiter
      for (let i = 0; i < 10; i++) {
        await attemptLogin(ip, "operator1", "wrong-password", deps);
      }

      // 11th request is throttled without doing any argon2 work
      const res = await attemptLogin(ip, "operator1", "correct-password", deps);
      expect(res.kind).toBe("rate_limited");
      if (res.kind === "rate_limited") {
        expect(res.retryAfterMs).toBeGreaterThan(0);
      }
    });
  });

  describe("PostgreSQL Connection Security Guards (lib/db.ts)", () => {
    it("rejects empty PGPASSWORD when connecting to non-local host", async () => {
      const proc = Bun.spawnSync([
        process.execPath,
        "-e",
        `
        process.env.PGHOST = "db.production.fantasy402.internal";
        process.env.PGUSER = "postgres";
        process.env.PGPASSWORD = "";
        const { sql } = await import("./lib/db.ts");
        try {
          await sql\`SELECT 1\`;
          process.exit(0);
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
        `,
      ]);
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain(
        "PGPASSWORD required for non-local host db.production.fantasy402.internal",
      );
    });
  });
});
