/**
 * @file tests/session.test.ts
 * @description Unit tests for session lifecycle, SHA-256 token storage, idle timeout, and throttled last_seen_at touches.
 */

import { describe, expect, it } from "bun:test";
import {
  SESSION_IDLE_MS,
  SESSION_LAST_SEEN_THROTTLE_MS,
  sessionCleanup,
  sessionCreate,
  sessionRevoke,
  sessionRevokeAllForOperator,
  sessionRotate,
  sessionVerify,
} from "../lib/session.ts";
import { sha256Hex } from "../lib/auth.ts";
import type { SQL } from "bun";

interface MockOperator {
  id: number;
  username: string;
  role: "admin" | "operator" | "viewer";
  disabled: boolean;
  created_at: string;
}

interface MockSession {
  token_hash: string;
  operator_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

interface MockSqlWithBegin {
  begin?: <T>(cb: (tx: SQL) => Promise<T>) => Promise<T>;
}

function createMockDb() {
  const operators = new Map<number, MockOperator>();
  const sessions = new Map<string, MockSession>();
  let updateCount = 0;

  const mockSql = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const query = strings.join("?");

    // INSERT INTO sessions
    if (query.includes("INSERT INTO sessions")) {
      const token_hash = values[0] as string;
      const operator_id = values[1] as number;
      const expires_at = values[2] as string;
      const ip = (values[3] ?? null) as string | null;
      const user_agent = (values[4] ?? null) as string | null;
      const now = new Date().toISOString();
      sessions.set(token_hash, {
        token_hash,
        operator_id,
        created_at: now,
        expires_at,
        last_seen_at: now,
        ip,
        user_agent,
      });
      return [];
    }

    // SELECT FROM sessions JOIN operators
    if (
      query.includes("FROM sessions s") &&
      query.includes("JOIN operators o")
    ) {
      const hash = values[0] as string;
      const nowStr = values[1] as string;
      const idleCutoffStr = values[2] as string;

      const s = sessions.get(hash);
      if (!s) return [];

      const o = operators.get(s.operator_id);
      if (!o || o.disabled) return [];

      if (new Date(s.expires_at).getTime() <= new Date(nowStr).getTime())
        return [];
      if (
        new Date(s.last_seen_at).getTime() <= new Date(idleCutoffStr).getTime()
      )
        return [];

      return [
        {
          id: o.id,
          username: o.username,
          role: o.role,
          disabled: o.disabled,
          created_at: o.created_at,
          expires_at: s.expires_at,
          last_seen_at: s.last_seen_at,
        },
      ];
    }

    // UPDATE sessions SET last_seen_at
    if (
      query.includes("UPDATE sessions") &&
      query.includes("SET last_seen_at")
    ) {
      const nowStr = values[0] as string;
      const hash = values[1] as string;
      const throttleCutoffStr = values[2] as string;

      const s = sessions.get(hash);
      if (s) {
        if (
          new Date(s.last_seen_at).getTime() <
          new Date(throttleCutoffStr).getTime()
        ) {
          s.last_seen_at = nowStr;
          updateCount++;
        }
      }
      return [];
    }

    // DELETE FROM sessions WHERE token_hash = ${oldHash}
    if (
      query.includes("DELETE FROM sessions WHERE token_hash =") &&
      !query.includes("RETURNING")
    ) {
      const hash = values[0] as string;
      sessions.delete(hash);
      return [];
    }

    // DELETE FROM sessions WHERE operator_id = ${operatorId} RETURNING token_hash
    if (
      query.includes("DELETE FROM sessions WHERE operator_id =") &&
      query.includes("RETURNING token_hash")
    ) {
      const operatorId = values[0] as number;
      const deleted: { token_hash: string }[] = [];
      for (const [hash, s] of sessions) {
        if (s.operator_id === operatorId) {
          deleted.push({ token_hash: hash });
          sessions.delete(hash);
        }
      }
      return deleted;
    }

    // DELETE FROM sessions (cleanup)
    if (
      query.includes("DELETE FROM sessions s") &&
      query.includes("RETURNING s.token_hash")
    ) {
      const nowStr = values[0] as string;
      const idleCutoffStr = values[1] as string;
      const deleted: { token_hash: string }[] = [];

      for (const [hash, s] of sessions) {
        const o = operators.get(s.operator_id);
        const expired =
          new Date(s.expires_at).getTime() <= new Date(nowStr).getTime();
        const idle =
          new Date(s.last_seen_at).getTime() <=
          new Date(idleCutoffStr).getTime();
        const disabled = o?.disabled === true;

        if (expired || idle || disabled) {
          deleted.push({ token_hash: hash });
          sessions.delete(hash);
        }
      }
      return deleted;
    }

    return [];
  }) as unknown as SQL;

  (mockSql as unknown as MockSqlWithBegin).begin = async <T>(
    cb: (tx: SQL) => Promise<T>,
  ): Promise<T> => {
    // Snapshot state for transaction rollback
    const snapshotSessions = new Map(sessions);
    const snapshotOperators = new Map(operators);
    try {
      return await cb(mockSql);
    } catch (err) {
      sessions.clear();
      for (const [k, v] of snapshotSessions) sessions.set(k, { ...v });
      operators.clear();
      for (const [k, v] of snapshotOperators) operators.set(k, { ...v });
      throw err;
    }
  };

  return { operators, sessions, mockSql, getUpdateCount: () => updateCount };
}

describe("Session Management (lib/session.ts)", () => {
  it("creates a fresh session and stores only SHA-256 token hash", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(1, {
      id: 1,
      username: "admin_ops",
      role: "admin",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const session = await sessionCreate(
      1,
      "192.168.1.50",
      "SportsDesk-Browser",
      mockSql,
    );
    expect(typeof session.token).toBe("string");
    expect(session.token.length).toBeGreaterThan(40);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Verify raw token is NOT in the database
    expect(sessions.has(session.token)).toBe(false);

    // Verify SHA-256 hash IS in the database
    const expectedHash = await sha256Hex(session.token);
    expect(sessions.has(expectedHash)).toBe(true);
    const row = sessions.get(expectedHash);
    expect(row?.operator_id).toBe(1);
    expect(row?.ip).toBe("192.168.1.50");
    expect(row?.user_agent).toBe("SportsDesk-Browser");
  });

  it("verifies valid session and returns operator list projection", async () => {
    const { operators, mockSql } = createMockDb();
    operators.set(10, {
      id: 10,
      username: "risk_officer",
      role: "operator",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const { token } = await sessionCreate(10, undefined, undefined, mockSql);
    const verified = await sessionVerify(token, mockSql);

    expect(verified).not.toBeNull();
    expect(verified?.operator.id).toBe(10);
    expect(verified?.operator.username).toBe("risk_officer");
    expect(verified?.operator.role).toBe("operator");
    expect(verified?.operator.disabled).toBe(false);
  });

  it("returns null for non-existent token", async () => {
    const { mockSql } = createMockDb();
    const verified = await sessionVerify("invalid-token-never-issued", mockSql);
    expect(verified).toBeNull();
  });

  it("returns null when session has exceeded absolute TTL", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(2, {
      id: 2,
      username: "desk_agent",
      role: "viewer",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const { token } = await sessionCreate(2, undefined, undefined, mockSql);
    const hash = await sha256Hex(token);

    // Artificially expire the session past SESSION_TTL_MS
    const row = sessions.get(hash);
    if (row) {
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    }

    const verified = await sessionVerify(token, mockSql);
    expect(verified).toBeNull();
  });

  it("returns null when session has exceeded sliding idle timeout", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(3, {
      id: 3,
      username: "idle_agent",
      role: "operator",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const { token } = await sessionCreate(3, undefined, undefined, mockSql);
    const hash = await sha256Hex(token);

    // Idle-expire: last_seen_at older than 8 hours
    const row = sessions.get(hash);
    if (row) {
      row.last_seen_at = new Date(
        Date.now() - (SESSION_IDLE_MS + 1000),
      ).toISOString();
    }

    const verified = await sessionVerify(token, mockSql);
    expect(verified).toBeNull();
  });

  it("returns null when operator is disabled", async () => {
    const { operators, mockSql } = createMockDb();
    operators.set(4, {
      id: 4,
      username: "suspended_user",
      role: "viewer",
      disabled: true,
      created_at: new Date().toISOString(),
    });

    const { token } = await sessionCreate(4, undefined, undefined, mockSql);
    const verified = await sessionVerify(token, mockSql);
    expect(verified).toBeNull();
  });

  it("throttles last_seen_at updates during rapid polling", async () => {
    const { operators, sessions, mockSql, getUpdateCount } = createMockDb();
    operators.set(5, {
      id: 5,
      username: "dashboard_stream",
      role: "operator",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const { token } = await sessionCreate(5, undefined, undefined, mockSql);
    const hash = await sha256Hex(token);

    // Initial verify right after create (< 1 minute gap): no UPDATE executed
    await sessionVerify(token, mockSql);
    expect(getUpdateCount()).toBe(0);

    // Simulate passage of 2 minutes on last_seen_at
    const row = sessions.get(hash);
    if (row) {
      row.last_seen_at = new Date(
        Date.now() - (SESSION_LAST_SEEN_THROTTLE_MS + 10_000),
      ).toISOString();
    }

    // Now verify triggers throttled touch
    await sessionVerify(token, mockSql);
    expect(getUpdateCount()).toBe(1);

    // Immediate subsequent verify: throttled again, no additional UPDATE
    await sessionVerify(token, mockSql);
    expect(getUpdateCount()).toBe(1);
  });

  it("rotates session atomically: issues new and revokes old", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(6, {
      id: 6,
      username: "rotation_user",
      role: "operator",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const first = await sessionCreate(6, undefined, undefined, mockSql);
    const firstHash = await sha256Hex(first.token);
    expect(sessions.has(firstHash)).toBe(true);

    const rotated = await sessionRotate(
      first.token,
      6,
      undefined,
      undefined,
      mockSql,
    );
    const rotatedHash = await sha256Hex(rotated.token);

    expect(rotated.token).not.toBe(first.token);
    expect(sessions.has(rotatedHash)).toBe(true);
    // Old session deleted
    expect(sessions.has(firstHash)).toBe(false);

    // Old token no longer verifies; new token verifies cleanly
    expect(await sessionVerify(first.token, mockSql)).toBeNull();
    const verified = await sessionVerify(rotated.token, mockSql);
    expect(verified?.operator.id).toBe(6);
  });

  it("rolls back session rotation atomically if an error occurs", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(6, {
      id: 6,
      username: "rollback_user",
      role: "operator",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const first = await sessionCreate(6, undefined, undefined, mockSql);
    const firstHash = await sha256Hex(first.token);
    expect(sessions.has(firstHash)).toBe(true);

    // Mock sql.begin throwing an error or simulated failure during delete
    const failingDb = (async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const query = strings.join("?");
      if (query.includes("DELETE FROM sessions")) {
        throw new Error("Simulated database failure during delete");
      }
      const rawRunner = mockSql as unknown as (
        s: TemplateStringsArray,
        ...v: unknown[]
      ) => Promise<unknown[]>;
      return rawRunner(strings, ...values);
    }) as unknown as SQL;

    (failingDb as unknown as MockSqlWithBegin).begin = async <T>(
      cb: (tx: SQL) => Promise<T>,
    ): Promise<T> => {
      const snapshotSessions = new Map(sessions);
      try {
        return await cb(failingDb);
      } catch (err) {
        sessions.clear();
        for (const [k, v] of snapshotSessions) sessions.set(k, { ...v });
        throw err;
      }
    };

    await expect(
      sessionRotate(first.token, 6, undefined, undefined, failingDb),
    ).rejects.toThrow("Simulated database failure during delete");

    // Invariant: rollback preserves old session, did not leave dangling new session
    expect(sessions.has(firstHash)).toBe(true);
    expect(sessions.size).toBe(1);
    const verified = await sessionVerify(first.token, mockSql);
    expect(verified?.operator.id).toBe(6);
  });

  it("revokes single session on logout", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(7, {
      id: 7,
      username: "logout_test",
      role: "viewer",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const { token } = await sessionCreate(7, undefined, undefined, mockSql);
    const hash = await sha256Hex(token);
    expect(sessions.has(hash)).toBe(true);

    await sessionRevoke(token, mockSql);
    expect(sessions.has(hash)).toBe(false);
    expect(await sessionVerify(token, mockSql)).toBeNull();
  });

  it("revokes all sessions for operator on admin action or privilege change", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(8, {
      id: 8,
      username: "multi_device_op",
      role: "admin",
      disabled: false,
      created_at: new Date().toISOString(),
    });

    const s1 = await sessionCreate(8, "1.1.1.1", undefined, mockSql);
    const s2 = await sessionCreate(8, "2.2.2.2", undefined, mockSql);
    const s3 = await sessionCreate(8, "3.3.3.3", undefined, mockSql);

    expect(sessions.size).toBe(3);

    const count = await sessionRevokeAllForOperator(8, mockSql);
    expect(count).toBe(3);
    expect(sessions.size).toBe(0);

    expect(await sessionVerify(s1.token, mockSql)).toBeNull();
    expect(await sessionVerify(s2.token, mockSql)).toBeNull();
    expect(await sessionVerify(s3.token, mockSql)).toBeNull();
  });

  it("sweeps expired, idle-expired, and disabled-operator sessions in cleanup", async () => {
    const { operators, sessions, mockSql } = createMockDb();
    operators.set(100, {
      id: 100,
      username: "valid_op",
      role: "operator",
      disabled: false,
      created_at: new Date().toISOString(),
    });
    operators.set(101, {
      id: 101,
      username: "disabled_op",
      role: "operator",
      disabled: true,
      created_at: new Date().toISOString(),
    });

    // 1. Valid session
    const valid = await sessionCreate(100, undefined, undefined, mockSql);

    // 2. Expired session
    const expired = await sessionCreate(100, undefined, undefined, mockSql);
    const expRow = sessions.get(await sha256Hex(expired.token))!;
    expRow.expires_at = new Date(Date.now() - 1000).toISOString();

    // 3. Idle session
    const idle = await sessionCreate(100, undefined, undefined, mockSql);
    const idleRow = sessions.get(await sha256Hex(idle.token))!;
    idleRow.last_seen_at = new Date(
      Date.now() - (SESSION_IDLE_MS + 5000),
    ).toISOString();

    // 4. Session for disabled operator
    await sessionCreate(101, undefined, undefined, mockSql);

    expect(sessions.size).toBe(4);

    const sweptCount = await sessionCleanup(mockSql);
    expect(sweptCount).toBe(3); // expired + idle + disabled
    expect(sessions.size).toBe(1);

    // Valid session survived
    expect(await sessionVerify(valid.token, mockSql)).not.toBeNull();
  });
});
