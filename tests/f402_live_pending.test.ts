import { describe, expect, test } from "bun:test";

import type { F402ProbeFetch } from "../lib/f402_ingest.ts";
import {
  fetchLivePending,
  pendingCustomersFromTickerRows,
  REPORT_PENDING_URL,
  type LivePendingDiagnostic,
  type LivePendingFetchResult,
} from "../lib/f402_live_pending.ts";
import type { F402Session } from "../lib/f402_session.ts";
import {
  buildArtifact,
  livePendingArtifact,
  type PendingRow,
} from "../lib/live_bets.ts";

const FIXED_NOW = new Date("2026-11-08T18:00:00.000Z");
const OBSERVED_AT = FIXED_NOW.toISOString();
const OPERATION = "/cloud/api/Report/Pending";

const SECRET_COOKIE = "F402SESSION=SECRET_COOKIE_VALUE";
const SECRET_TOKEN = "Bearer SECRET_TOKEN_VALUE";

const SESSION: F402Session = {
  cookieHeader: SECRET_COOKIE,
  cookieNames: ["F402SESSION"],
  authorizationHeader: SECRET_TOKEN,
  obtainedAtIso: "2026-11-07T20:00:00.000Z",
  expiresAtIso: "2026-11-08T20:00:00.000Z",
};

/** No ambient env may leak into a unit test: every call passes this seam explicitly. */
const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {};

/**
 * Module-private configuration of `lib/f402_live_pending.ts` that these tests pin: the documented
 * clamp floors and the default ticker-scope cap. Named so a changed floor fails in one place.
 */
const MIN_CUSTOMERS_CLAMP = 1;
const MIN_TIMEOUT_MS = 250;
const TICKER_CUSTOMER_CAP = 10;

/** The single-customer scope shared by the refusal and timeout tests. */
const ONE_CUSTOMER_SCOPE = ["H1716"];

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly customerID: string;
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Injected fetch seam: records the call, dispatches on the posted `customerID`. */
function wiredFetch(
  respond: (customerID: string) => Response,
  calls: FetchCall[],
): F402ProbeFetch {
  return async (url, init) => {
    const body = new URLSearchParams(String(init.body));
    const customerID = body.get("customerID") ?? "";
    calls.push({ url, init, customerID });
    return respond(customerID);
  };
}

/** A real `Report/Pending` row: `TicketNumber` is what `readPendingRows` filters on. */
function pendingRow(
  ticketNumber: number,
  customerID: string,
): Record<string, unknown> & { readonly TicketNumber: number } {
  return {
    TicketNumber: ticketNumber,
    WagerNumber: 1,
    customerID,
    AmountWagered: 6500,
    ToWinAmount: 1200,
    SportType: "Soccer              ",
  };
}

function failureDiagnostic(
  result: LivePendingFetchResult,
): Exclude<LivePendingDiagnostic, { code: "ok" }> {
  if (result.diagnostic.code === "ok") {
    throw new Error("expected a failure diagnostic, got ok");
  }
  return result.diagnostic;
}

describe("fetchLivePending (injected fetch, offline)", () => {
  test("POSTs once per customer and merges the parsed rows", async () => {
    const calls: FetchCall[] = [];
    const customers = [" H1716 ", "CC364"];
    const firstCustomerRows = [pendingRow(1, "H1716"), pendingRow(2, "H1716")];
    const secondCustomerRows = [pendingRow(3, "CC364")];
    const expectedRows = [...firstCustomerRows, ...secondCustomerRows];
    const result = await fetchLivePending({
      customers,
      now: FIXED_NOW,
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(
        (customerID) =>
          jsonResponse(
            customerID === "H1716"
              ? firstCustomerRows
              : { Pending: secondCustomerRows },
          ),
        calls,
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(result.customersAttempted).toBe(customers.length);
    expect(result.customersFailed).toBe(0);
    expect(result.transport).toBe("injected-fetch");
    expect(result.rows).toHaveLength(expectedRows.length);
    expect(result.rows.map((row) => row.TicketNumber)).toEqual(
      expectedRows.map((row) => row.TicketNumber),
    );
    expect(result.diagnostic).toEqual({
      code: "ok",
      transport: "injected-fetch",
      httpStatus: 200,
    });

    expect(calls).toHaveLength(customers.length);
    for (const call of calls) {
      expect(call.url).toBe(REPORT_PENDING_URL);
      expect(call.url).toBe("https://fantasy402.com/cloud/api/Report/Pending");
      expect(call.init.method).toBe("POST");
      const body = new URLSearchParams(String(call.init.body));
      expect(body.get("customerID")).toBe(call.customerID);
      expect(body.get("token")).toBe("");
      expect(body.get("operation")).toBe("Pending");
      const headers = call.init.headers as Record<string, string>;
      expect(headers["accept"]).toBe("application/json, text/plain, */*");
      expect(headers["content-type"]).toBe(
        "application/x-www-form-urlencoded; charset=UTF-8",
      );
      // The injected fetch has no replay transport behind it, so the caller's session supplies
      // the same cookie/authorization headers the real probe sends.
      expect(headers["cookie"]).toBe(SECRET_COOKIE);
      expect(headers["authorization"]).toBe(SECRET_TOKEN);
    }

    // No session value may appear anywhere in the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET_COOKIE_VALUE");
    expect(serialized).not.toContain("SECRET_TOKEN_VALUE");
  });

  test("a 200 with an empty book is ok, not a parse failure", async () => {
    const result = await fetchLivePending({
      customers: ["H1716"],
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(() => jsonResponse({ Pending: [] }), []),
    });

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.rows).toEqual([]);
  });

  test("one failed customer and one good one is ok + partial", async () => {
    const calls: FetchCall[] = [];
    const customers = ["H1716", "CC364"];
    const failingCustomers = ["H1716"];
    const goodRows = [pendingRow(9, "CC364")];
    const result = await fetchLivePending({
      customers,
      concurrency: 1,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(
        (customerID) =>
          failingCustomers.includes(customerID)
            ? new Response("boom", { status: 500 })
            : jsonResponse(goodRows),
        calls,
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.customersAttempted).toBe(customers.length);
    expect(result.customersFailed).toBe(failingCustomers.length);
    expect(result.rows).toHaveLength(goodRows.length);
    expect(result.transport).toBe("injected-fetch");
    expect(result.diagnostic.code).toBe("ok");
    expect(calls).toHaveLength(customers.length);
  });

  test("a 401 aborts the fan-out and keeps the session:login hint", async () => {
    for (const status of [401, 403]) {
      const calls: FetchCall[] = [];
      const result = await fetchLivePending({
        customers: ["H1716", "CC364", "AA111"],
        concurrency: 1,
        session: SESSION,
        env: EMPTY_ENV,
        fetchImpl: wiredFetch(() => new Response("denied", { status }), calls),
      });

      expect(result.ok).toBe(false);
      expect(result.partial).toBe(false);
      expect(result.rows).toEqual([]);
      // The first observed 401/403 stops the pool; the later customers are never read.
      expect(calls).toHaveLength(1);
      expect(result.customersAttempted).toBe(1);
      expect(result.customersFailed).toBe(1);
      const diagnostic = failureDiagnostic(result);
      expect(diagnostic).toMatchObject({
        code: "unauthorized",
        httpStatus: status,
      });
      expect(diagnostic.message).toContain("bun run session:login");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("SECRET_COOKIE_VALUE");
      expect(serialized).not.toContain("SECRET_TOKEN_VALUE");
    }
  });

  test("reports http_error when every customer fails on status", async () => {
    const customers = ["H1716", "CC364"];
    const result = await fetchLivePending({
      customers,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(() => new Response("boom", { status: 500 }), []),
    });

    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.transport).toBeNull();
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({
      code: "http_error",
      httpStatus: 500,
      customersAttempted: customers.length,
      customersFailed: customers.length,
    });
  });

  test("reports parse_error for an HTML login page", async () => {
    const customers = ONE_CUSTOMER_SCOPE;
    const result = await fetchLivePending({
      customers,
      session: SESSION,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(
        () => new Response("<html><form>login</form></html>", { status: 200 }),
        [],
      ),
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({
      code: "parse_error",
      customersAttempted: customers.length,
      customersFailed: customers.length,
    });
    expect(diagnostic.message).toContain("non-JSON body");
    expect(diagnostic.message).toContain("login page");
    // The response body is never echoed into the result.
    expect(JSON.stringify(result)).not.toContain("login</form>");
  });

  test("http_error is the dominant code when status and parse failures mix", async () => {
    const result = await fetchLivePending({
      customers: ["H1716", "CC364"],
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(
        (customerID) =>
          customerID === "H1716"
            ? new Response("boom", { status: 502 })
            : new Response("<html>login</html>", { status: 200 }),
        [],
      ),
    });

    expect(result.ok).toBe(false);
    expect(failureDiagnostic(result).code).toBe("http_error");
  });

  test("a thrown transport error becomes an http_error with status 0", async () => {
    const result = await fetchLivePending({
      customers: ONE_CUSTOMER_SCOPE,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "http_error", httpStatus: 0 });
    expect(diagnostic.message).toContain("request failed");
  });

  test("reports a timeout with the resolved timeout", async () => {
    const requestedTimeoutMs = 40;
    const result = await fetchLivePending({
      customers: ONE_CUSTOMER_SCOPE,
      timeoutMs: requestedTimeoutMs,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: async () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      },
    });

    expect(result.ok).toBe(false);
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic).toMatchObject({ code: "http_error", httpStatus: 0 });
    // Below the documented floor, so the request uses the clamped minimum.
    expect(diagnostic.message).toContain(
      `timed out after ${MIN_TIMEOUT_MS} ms`,
    );
  });

  test("refuses with transport_unavailable before any request", async () => {
    const result = await fetchLivePending({
      customers: ONE_CUSTOMER_SCOPE,
      // env {} + session null: readF402Session() is never consulted because the seam is explicit.
      session: null,
      env: EMPTY_ENV,
    });

    expect(result.ok).toBe(false);
    expect(result.transport).toBeNull();
    const diagnostic = failureDiagnostic(result);
    expect(diagnostic.code).toBe("transport_unavailable");
    if (diagnostic.code !== "transport_unavailable") {
      throw new Error(`expected transport_unavailable, got ${diagnostic.code}`);
    }
    expect(diagnostic.message).toContain("No F402 replay transport");
    expect(diagnostic.hint).toContain("bun run session:login");
    expect(diagnostic.hint).toContain("F402_SESSION_FILE");
    expect(diagnostic.hint).toContain("F402_REPLAY_PROXY_URL");
  });

  test("refuses with no_customer_scope and names the env scope", async () => {
    for (const customers of [[], [""], ["bad id!"], ["a".repeat(65)]]) {
      const calls: FetchCall[] = [];
      const result = await fetchLivePending({
        customers,
        session: SESSION,
        env: EMPTY_ENV,
        fetchImpl: wiredFetch(() => jsonResponse([]), calls),
      });

      expect(result.ok).toBe(false);
      expect(result.customersAttempted).toBe(0);
      expect(result.customersFailed).toBe(0);
      expect(calls).toHaveLength(0);
      const diagnostic = failureDiagnostic(result);
      expect(diagnostic.code).toBe("no_customer_scope");
      if (diagnostic.code !== "no_customer_scope") {
        throw new Error(`expected no_customer_scope, got ${diagnostic.code}`);
      }
      expect(diagnostic.message).toContain("SPORTSDESK_LIVE_PENDING_CUSTOMERS");
      expect(diagnostic.hint).toContain("SPORTSDESK_LIVE_PENDING_CUSTOMERS");
      // The scope can also come from live ticker rows; nothing is fetched without one.
      expect(diagnostic.hint).toContain("getBetTicker");
    }
  });

  test("sanitizes, dedupes (case-insensitively) and caps the customer scope", async () => {
    const calls: FetchCall[] = [];
    const expectedScope = ["H1716", "CC364"];
    const result = await fetchLivePending({
      customers: [" H1716 ", "H1716", "h1716", "bad id!", "CC364"],
      maxCustomers: expectedScope.length,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(() => jsonResponse([]), calls),
    });

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.customerID)).toEqual(expectedScope);
    expect(result.customersAttempted).toBe(expectedScope.length);
  });

  test("clamps an out-of-range maxCustomers instead of reading nothing", async () => {
    const rows = [pendingRow(1, "H1716")];
    const customers = ["H1716", "CC364", "AA111"];
    const clampOne = await fetchLivePending({
      customers,
      maxCustomers: 0,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(() => jsonResponse(rows), []),
    });
    expect(clampOne.customersAttempted).toBe(MIN_CUSTOMERS_CLAMP);

    const allThree = await fetchLivePending({
      customers,
      maxCustomers: 9999,
      session: null,
      env: EMPTY_ENV,
      fetchImpl: wiredFetch(() => jsonResponse(rows), []),
    });
    expect(allThree.customersAttempted).toBe(customers.length);
  });
});

describe("pendingCustomersFromTickerRows", () => {
  test("prefers CustomerID, falls back to Login, and rejects junk", () => {
    const scope = pendingCustomersFromTickerRows([
      { CustomerID: " H1716 ", Login: "h1716-login" },
      { Login: " CC364 " },
      { CustomerID: "bad id", Login: "H1716" },
      { CustomerID: 123, Login: "NEW1" },
      { CustomerID: "", Login: "" },
      {},
      { CustomerID: "x".repeat(65), Login: "TOO-LONG-TOO-LONG" },
    ]);

    expect(scope).toEqual(["H1716", "CC364", "NEW1", "TOO-LONG-TOO-LONG"]);
  });

  test("dedupes and caps (default 10)", () => {
    const many = Array.from(
      { length: TICKER_CUSTOMER_CAP + 2 },
      (_, index) => ({
        CustomerID: `CUSTOMER${index}`,
      }),
    );
    expect(pendingCustomersFromTickerRows(many)).toHaveLength(
      TICKER_CUSTOMER_CAP,
    );
    const cap = 3;
    expect(pendingCustomersFromTickerRows(many, cap)).toEqual(
      many.slice(0, cap).map((row) => row.CustomerID),
    );
    expect(
      pendingCustomersFromTickerRows(
        [{ CustomerID: "H1716" }, { Login: "h1716" }],
        5,
      ),
    ).toEqual(["H1716"]);
  });

  test("returns an empty scope for empty or unusable rows", () => {
    expect(pendingCustomersFromTickerRows([])).toEqual([]);
    expect(
      pendingCustomersFromTickerRows([{ CustomerID: "" }, { Login: "bad id" }]),
    ).toEqual([]);
  });
});

describe("live Pending artifact provenance", () => {
  /** The live feed sends the credential/name fields; they are not part of the typed row. */
  const rows: (PendingRow & { NameFirst: string; Password: string })[] = [
    {
      TicketNumber: 1072983884,
      WagerNumber: 1,
      WagerType: "S",
      AmountWagered: 6500,
      ToWinAmount: 1200,
      Password: "not-a-real-secret",
      NameFirst: "John Hoeft",
      Login: "h1716",
    },
  ];

  test("buildArtifact keeps the capture label byte-identical by default", () => {
    const capturedAt = "2026-11-01T02:22:35.774Z";
    const artifact = buildArtifact(rows, {
      operation: OPERATION,
      capturedAt,
    });
    expect(artifact.dataSource).toBe(`${"capture"}:${OPERATION}@${capturedAt}`);
    expect(artifact.dataSource).toBe(
      "capture:/cloud/api/Report/Pending@2026-11-01T02:22:35.774Z",
    );
    expect(artifact.capturedAt).toBe(capturedAt);
    expect(artifact.operation).toBe(OPERATION);
  });

  test("sourceKind live labels a live read without changing anything else", () => {
    const observedAt = "2026-11-08T18:00:00.000Z";
    const capture = buildArtifact(rows, {
      operation: OPERATION,
      capturedAt: observedAt,
    });
    const live = buildArtifact(rows, {
      operation: OPERATION,
      capturedAt: observedAt,
      sourceKind: "live",
    });

    expect(live.dataSource).toBe(`live:${OPERATION}@${observedAt}`);
    // The only difference is the provenance label; the derived numbers are identical.
    expect({ ...live, dataSource: "" }).toEqual({
      ...capture,
      dataSource: "",
    });
    // PII is stripped for a live artifact exactly as for a capture.
    const serialized = JSON.stringify(live);
    expect(serialized).not.toContain("not-a-real-secret");
    expect(serialized).not.toContain("John Hoeft");
    expect(serialized).not.toContain('"Password"');
  });

  test("livePendingArtifact is the live-labelled buildArtifact", () => {
    const observedAt = "2026-11-08T18:00:00.000Z";
    const artifact = livePendingArtifact(rows, {
      operation: OPERATION,
      capturedAt: observedAt,
    });
    expect(artifact.dataSource).toBe(`live:${OPERATION}@${observedAt}`);
    expect(artifact.pendingCount).toBe(rows.length);
    expect(artifact.games).toHaveLength(rows.length);
    expect(artifact.capturedAt).toBe(observedAt);

    // A live read with no clock value is still labelled live, never capture.
    expect(
      livePendingArtifact(rows, { operation: OPERATION, capturedAt: null })
        .dataSource,
    ).toBe(`live:${OPERATION}`);
  });
});
