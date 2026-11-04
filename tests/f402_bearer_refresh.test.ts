/**
 * Self-healing bearer: renew first, re-mint from keychain credentials on failure, persist the
 * replacement. An expired token-file must not turn every 15-minute cron fire into a fatal run.
 */
import { describe, expect, test } from "bun:test";

import {
  F402TokenRefreshError,
  fetchF402ReportPendingBatch,
} from "../lib/f402_pending_fetch.ts";
import { refreshF402BearerWithFallback } from "../scripts/f402_bearer_refresh.ts";

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

const CURRENT = jwt({ exp: 2_000_000_000 });
const RENEWED = jwt({ exp: 2_000_000_600, kind: "renewed" });
const MINTED = jwt({ exp: 2_000_001_200, kind: "minted" });

describe("refreshF402BearerWithFallback", () => {
  test("renewal wins and is persisted; no keychain/mint is needed", async () => {
    const persisted: string[] = [];
    let minted = 0;
    const result = await refreshF402BearerWithFallback({
      token: CURRENT,
      renewImpl: async () => ({
        token: RENEWED,
        expiresAtMs: 2_000_000_600_000,
      }),
      mintImpl: async () => {
        minted += 1;
        return { token: MINTED };
      },
      persist: (token) => persisted.push(token),
    });
    expect(result).toEqual({
      token: RENEWED,
      expiresAtMs: 2_000_000_600_000,
      method: "renewed",
    });
    expect(persisted).toEqual([RENEWED]);
    expect(minted).toBe(0);
  });

  test("a failed renewal re-mints from keychain credentials and persists that", async () => {
    const persisted: string[] = [];
    const credentials: string[] = [];
    const result = await refreshF402BearerWithFallback({
      token: CURRENT,
      renewImpl: async () => {
        throw new Error("renewToken returned HTTP 401: Invalid Token");
      },
      readCredentials: async () => {
        credentials.push("read");
        return { agentId: "agent-118", password: "not-a-real-secret" };
      },
      mintImpl: async (agentId, password) => {
        expect(agentId).toBe("agent-118");
        expect(password).toBe("not-a-real-secret");
        return { token: MINTED };
      },
      persist: (token) => persisted.push(token),
    });
    expect(result.method).toBe("minted");
    expect(result.token).toBe(MINTED);
    expect(result.expiresAtMs).toBe(2_000_001_200_000);
    expect(persisted).toEqual([MINTED]);
    expect(credentials).toEqual(["read"]);
  });

  test("renew failure with no credentials fails closed", async () => {
    const error = await refreshF402BearerWithFallback({
      token: CURRENT,
      renewImpl: async () => {
        throw new Error("401");
      },
      readCredentials: async () => {
        throw new F402TokenRefreshError("credentials absent");
      },
      persist: () => {},
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(F402TokenRefreshError);
    expect((error as Error).message).toContain("renew failed");
    expect((error as Error).message).toContain("re-mint unavailable");
  });

  test("both paths failing does not echo either token", async () => {
    const error = await refreshF402BearerWithFallback({
      token: CURRENT,
      renewImpl: async () => {
        throw new Error(`401 for ${CURRENT.slice(0, 8)}…`);
      },
      readCredentials: async () => ({ agentId: "a", password: "p" }),
      mintImpl: async () => {
        throw new Error("authenticateCustomer returned HTTP 500");
      },
      persist: () => {},
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(F402TokenRefreshError);
    expect((error as Error).message).toContain("renew and re-mint both failed");
    expect((error as Error).message).not.toContain(CURRENT);
  });
});

describe("expired token across a cron fire", () => {
  test("batch starts expired, renew fails, mint succeeds, and fetch uses the minted bearer", async () => {
    const expired = jwt({ exp: 1 }); // long past
    const fresh = jwt({ exp: 2_000_002_000, kind: "fresh" });
    const auth: string[] = [];
    const fetchImpl = async (
      _input: string,
      init: RequestInit,
    ): Promise<Response> => {
      auth.push(String((init.headers as Record<string, string>).authorization));
      return new Response(
        JSON.stringify({ Pending: [{ TicketNumber: "T1" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const result = await fetchF402ReportPendingBatch({
      token: expired,
      customerIds: ["C1"],
      fetchImpl,
      expiresAtMs: Date.now() - 1, // already expired at start, as on the 3rd cron fire
      refreshToken: async (current) => {
        const refreshed = await refreshF402BearerWithFallback({
          token: current,
          renewImpl: async () => {
            throw new Error("renewToken returned HTTP 401 (expired)");
          },
          readCredentials: async () => ({ agentId: "agent", password: "pass" }),
          mintImpl: async () => ({ token: fresh }),
          persist: () => {},
        });
        return { token: refreshed.token, expiresAtMs: refreshed.expiresAtMs };
      },
    });
    expect(auth).toEqual([`Bearer ${fresh}`]);
    expect(result.okCount).toBe(1);
    expect(result.rows).toHaveLength(1);
  });
});
