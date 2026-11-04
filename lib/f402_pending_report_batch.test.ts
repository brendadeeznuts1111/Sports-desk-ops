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
