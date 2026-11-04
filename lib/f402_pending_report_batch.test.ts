/**
 * Report/Pending is the verified bearer path, but it is strictly customer-scoped (no wildcard or
 * agent scope was accepted live on 2026-11-04). These tests pin the batch contract: explicit
 * customer list, Authorization bearer, merged rows, and fail-closed behaviour.
 */
import { describe, expect, test } from "bun:test";

import {
  F402PendingFetchError,
  REPORT_PENDING_PATH,
  fetchF402ReportPendingBatch,
} from "./f402_pending_fetch.ts";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function jwt(): string {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url({ exp: 2_000_000_000 }),
    "c".repeat(43),
  ].join(".");
}

const TOKEN = jwt();
const BASE = "https://www.fantasy402.com";

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function fakeFetch(
  respond: (customerID: string) => Response | Promise<Response>,
): {
  fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (input, init) => {
      const body = String(init.body);
      const customerID = new URLSearchParams(body).get("customerID") ?? "";
      seen.push({
        url: input,
        headers: init.headers as Record<string, string>,
        body,
      });
      return respond(customerID);
    },
  };
}

function pendingResponse(rows: unknown[]): Response {
  return new Response(JSON.stringify({ Pending: rows }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("fetchF402ReportPendingBatch", () => {
  test("posts the form body + bearer per customer and merges rows", async () => {
    const { fetchImpl, seen } = fakeFetch((customerID) =>
      pendingResponse([{ TicketNumber: `T-${customerID}` }]),
    );
    const result = await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["C1", "C2", "C1", " "],
      fetchImpl,
    });

    expect(seen).toHaveLength(2); // de-duplicated, blanks dropped
    for (const call of seen) {
      expect(call.url).toBe(`${BASE}${REPORT_PENDING_PATH}`);
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.headers["content-type"]).toContain(
        "application/x-www-form-urlencoded",
      );
      const body = new URLSearchParams(call.body);
      expect(body.get("token")).toBe("");
      expect(body.get("operation")).toBe("Pending");
    }
    expect(result.rows).toHaveLength(2);
    expect(result.okCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.url).toBe(`${BASE}${REPORT_PENDING_PATH}`);
    expect(
      result.perCustomer.every((entry) => entry.customerIdChars === 2),
    ).toBe(true);
  });

  test("a 400 with Invalid CustomerID fails the batch by default", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ status: "Failed", msg: "Invalid CustomerID" }),
          {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        ),
    );
    const error = await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["C1"],
      fetchImpl,
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(F402PendingFetchError);
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).toContain("Invalid CustomerID");
    expect((error as Error).message).not.toContain(TOKEN);
  });

  test("onCustomerFailure=skip returns the successful rows and counts failures", async () => {
    const { fetchImpl } = fakeFetch((customerID) =>
      customerID === "BAD"
        ? new Response(
            JSON.stringify({ status: "Failed", msg: "Invalid CustomerID" }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          )
        : pendingResponse([{ TicketNumber: "T1" }]),
    );
    const result = await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["OK", "BAD"],
      fetchImpl,
      onCustomerFailure: "skip",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.okCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.perCustomer.find((entry) => !entry.ok)?.status).toBe(400);
  });

  test("no customers is a fail-closed error", async () => {
    const { fetchImpl } = fakeFetch(() => pendingResponse([]));
    await expect(
      fetchF402ReportPendingBatch({ token: TOKEN, customerIds: [], fetchImpl }),
    ).rejects.toThrow(/explicit customer list/);
  });

  test("HTML/non-JSON is rejected", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("<html>401</html>", { status: 200 }),
    );
    await expect(
      fetchF402ReportPendingBatch({
        token: TOKEN,
        customerIds: ["C1"],
        fetchImpl,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  test("an invalid token fails before network I/O", async () => {
    const { fetchImpl, seen } = fakeFetch(() => pendingResponse([]));
    await expect(
      fetchF402ReportPendingBatch({
        token: "short",
        customerIds: ["C1"],
        fetchImpl,
      }),
    ).rejects.toThrow(F402PendingFetchError);
    expect(seen).toHaveLength(0);
  });
});

describe("resilience: retries, refresh, concurrency", () => {
  const TOKEN = jwt();
  const freshJwt = (tag: number): string =>
    [
      b64url({ alg: "HS256", typ: "JWT" }),
      b64url({ exp: 2_000_000_000, tag }),
      "d".repeat(43),
    ].join(".");

  test("retries 429 (honouring Retry-After) and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": "0" } })
        : pendingResponse([{ TicketNumber: "T1" }]);
    };
    const result = await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["C1"],
      fetchImpl,
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.perCustomer[0]?.ok).toBe(true);
  });

  test("retry exhaustion is a customer failure (fail closed by default)", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("", { status: 500 });
    };
    await expect(
      fetchF402ReportPendingBatch({
        token: TOKEN,
        customerIds: ["C1"],
        fetchImpl,
        maxRetries: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/HTTP 500/);
    expect(calls).toBe(2); // initial + 1 retry
  });

  test("refreshes proactively before expiry and uses the new bearer", async () => {
    const chains: string[] = [];
    const fresh = freshJwt(1);
    const fetchImpl = async (_input: string, init: RequestInit) => {
      chains.push(
        String((init.headers as Record<string, string>).authorization),
      );
      return pendingResponse([{ TicketNumber: "T1" }]);
    };
    let refreshed = 0;
    const result = await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["C1"],
      fetchImpl,
      expiresAtMs: Date.now() - 1,
      refreshToken: async () => {
        refreshed += 1;
        return { token: fresh, expiresAtMs: Date.now() + 1_200_000 };
      },
      onRefresh: () => {},
    });
    expect(refreshed).toBe(1);
    expect(chains).toEqual([`Bearer ${fresh}`]);
    expect(result.okCount).toBe(1);
  });

  test("refreshes once on 401 and retries the same customer", async () => {
    let calls = 0;
    const chains: string[] = [];
    const fresh = freshJwt(2);
    const fetchImpl = async (_input: string, init: RequestInit) => {
      calls += 1;
      chains.push(
        String((init.headers as Record<string, string>).authorization),
      );
      return calls === 1
        ? new Response("", { status: 401 })
        : pendingResponse([{ TicketNumber: "T1" }]);
    };
    const result = await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["C1"],
      fetchImpl,
      refreshToken: async () => ({ token: fresh, expiresAtMs: null }),
    });
    expect(calls).toBe(2);
    expect(chains[1]).toBe(`Bearer ${fresh}`);
    expect(result.okCount).toBe(1);
  });

  test("a refresh failure aborts even with onCustomerFailure=skip", async () => {
    const fetchImpl = async () => new Response("", { status: 401 });
    await expect(
      fetchF402ReportPendingBatch({
        token: TOKEN,
        customerIds: ["C1"],
        fetchImpl,
        onCustomerFailure: "skip",
        refreshToken: async () => {
          throw new Error("renewToken returned HTTP 500");
        },
      }),
    ).rejects.toThrow(/token refresh failed/);
  });

  test("maxConcurrency bounds the in-flight requests", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active -= 1;
      return pendingResponse([]);
    };
    await fetchF402ReportPendingBatch({
      token: TOKEN,
      customerIds: ["C1", "C2", "C3", "C4", "C5", "C6"],
      fetchImpl,
      concurrency: 6,
      maxConcurrency: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
