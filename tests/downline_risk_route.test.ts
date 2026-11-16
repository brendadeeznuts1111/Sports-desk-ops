/**
 * @file tests/downline_risk_route.test.ts
 * @description Typed downline-risk route + cold-ingest scaffold contract:
 * binary-search lookup, cookie verifier, customer/agent structure checks,
 * binary match output and spine-contention errors.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { BunRequest, Server } from "bun";
import {
  buildHierarchyColumnStore,
  canonicalizeAndEncodeLoginIntoRow,
  findStandbyRowByLoginKeyBinarySearch,
  MAX_DOWNLINE_MATCHES_15,
  NODE_STRUCT_FLAGS_SHIFT,
  STRUCT_NODE_AGENT,
  STRUCT_NODE_CUSTOMER,
} from "../lib/fantasy402_hierarchy_cold_ingest.ts";
import {
  type DownlineRiskFilter,
  downlineRiskMethodNotAllowed,
  handleDownlineRiskRoute,
} from "../services/downline_risk_route.ts";

const { store, sortedRowOrderU16 } = buildHierarchyColumnStore([
  { login: "AGENTROOT", kind: "agent" },
  { login: "PLAYERONE", kind: "customer" },
  { login: "AGENTERR", kind: "agent" },
]);

const filter: DownlineRiskFilter = (_arena, _root, tier, _ord, out) => {
  if (tier === 6) return -1;
  out[0] = 0;
  out[1] = 1;
  return 2;
};

const server = Bun.serve<undefined>({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/api/v1/hierarchy/:agentLogin/risk/:tier": {
      GET: (
        req: BunRequest<"/api/v1/hierarchy/:agentLogin/risk/:tier">,
        srv: Server<undefined>,
      ) =>
        handleDownlineRiskRoute(
          req,
          srv,
          store,
          sortedRowOrderU16,
          filter,
          (token) => token === "valid-session",
        ),
      POST: downlineRiskMethodNotAllowed,
      PUT: downlineRiskMethodNotAllowed,
      PATCH: downlineRiskMethodNotAllowed,
      DELETE: downlineRiskMethodNotAllowed,
      OPTIONS: downlineRiskMethodNotAllowed,
      HEAD: downlineRiskMethodNotAllowed,
    },
  },
  fetch: () => Response.json({ error: "ERR_ROUTE_NOT_FOUND" }, { status: 404 }),
});

const base = server.url.origin;

function rowOf(login: string): number {
  const key = new Uint32Array(2);
  const ascii = new Uint8Array(64);
  const len = new Uint8Array(1);
  const limbs = new Uint16Array(8);
  canonicalizeAndEncodeLoginIntoRow(login, false, 0, key, ascii, len, limbs);
  const row = findStandbyRowByLoginKeyBinarySearch(
    store.loginKeyWords32Col,
    sortedRowOrderU16,
    store.nodeCount,
    key[0]!,
    key[1]!,
  );
  if (row < 0) throw new Error(`missing fixture row for ${login}`);
  return row;
}

// Second server: each response echoes its own root row, with a deliberately
// delayed verifier so two requests are in flight at the same time.
const rootEchoFilter: DownlineRiskFilter = (_arena, root, _tier, _ord, out) => {
  out[0] = root;
  return 1;
};
const concurrentServer = Bun.serve<undefined>({
  port: 0,
  hostname: "127.0.0.1",
  routes: {
    "/api/v1/hierarchy/:agentLogin/risk/:tier": {
      GET: (
        req: BunRequest<"/api/v1/hierarchy/:agentLogin/risk/:tier">,
        srv: Server<undefined>,
      ) =>
        handleDownlineRiskRoute(
          req,
          srv,
          store,
          sortedRowOrderU16,
          rootEchoFilter,
          async (token) => {
            await Bun.sleep(20);
            return token === "valid-session";
          },
        ),
    },
  },
  fetch: () => Response.json({ error: "ERR_ROUTE_NOT_FOUND" }, { status: 404 }),
});

afterAll(() => {
  concurrentServer.stop(true);
  server.stop(true);
});

function request(
  agentLogin: string,
  tier: string,
  cookie = "__Host-bdo_ops_sid=valid-session",
): Promise<Response> {
  return fetch(`${base}/api/v1/hierarchy/${agentLogin}/risk/${tier}`, {
    headers: cookie === "" ? {} : { cookie },
  });
}

describe("hierarchy cold-ingest scaffold", () => {
  test("binary search finds every canonical login and misses unknown keys", () => {
    const key = new Uint32Array(2);
    const ascii = new Uint8Array(64);
    const len = new Uint8Array(1);
    const limbs = new Uint16Array(8);
    for (const login of ["AGENTROOT", "PLAYERONE", "AGENTERR"]) {
      canonicalizeAndEncodeLoginIntoRow(
        login,
        false,
        0,
        key,
        ascii,
        len,
        limbs,
      );
      expect(len[0]).toBe(login.length);
      const row = findStandbyRowByLoginKeyBinarySearch(
        store.loginKeyWords32Col,
        sortedRowOrderU16,
        store.nodeCount,
        key[0]!,
        key[1]!,
      );
      expect(row).toBeGreaterThanOrEqual(0);
    }

    canonicalizeAndEncodeLoginIntoRow(
      "NOSUCHAGENT",
      false,
      0,
      key,
      ascii,
      len,
      limbs,
    );
    expect(
      findStandbyRowByLoginKeyBinarySearch(
        store.loginKeyWords32Col,
        sortedRowOrderU16,
        store.nodeCount,
        key[0]!,
        key[1]!,
      ),
    ).toBe(-1);
  });

  test("packs structure flags above the 15-bit row ordinal", () => {
    const customerRow = sortedRowOrderU16.find(
      (row) =>
        (store.packedNodeWord32Col[row] ?? 0) >> NODE_STRUCT_FLAGS_SHIFT ===
        (STRUCT_NODE_CUSTOMER as number),
    );
    const agentRow = sortedRowOrderU16.find(
      (row) =>
        (store.packedNodeWord32Col[row] ?? 0) >> NODE_STRUCT_FLAGS_SHIFT ===
        STRUCT_NODE_AGENT,
    );
    expect(customerRow).toBeDefined();
    expect(agentRow).toBeDefined();
    expect(MAX_DOWNLINE_MATCHES_15).toBe(32767);
  });
});

describe("downline risk route", () => {
  test("returns the binary match buffer and count for an agent root", async () => {
    const response = await request("AGENTROOT", "2");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("x-match-count")).toBe("2");
    const bytes = new Uint16Array(await response.arrayBuffer());
    expect([...bytes]).toEqual([0, 1]);

    // The session cookie is refreshed with the __Host- invariants.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__Host-bdo_ops_sid=valid-session");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");
  });

  test("rejects a customer login as a non-agent root", async () => {
    const response = await request("PLAYERONE", "2");
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "ERR_CUSTOMER_NOT_AGENT_ROOT",
    });
  });

  test("rejects unknown agents, bad tiers and replacement characters", async () => {
    expect((await request("NOSUCHAGENT", "2")).status).toBe(404);
    expect((await request("AGENTROOT", "7")).status).toBe(400);
    expect((await request("%EF%BF%BD", "2")).status).toBe(400);
  });

  test("requires a present and verified host cookie", async () => {
    const missing = await request("AGENTROOT", "2", "");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: "ERR_AUTH_MISSING_HOST_COOKIE",
    });

    const invalid = await request("AGENTROOT", "2", "__Host-bdo_ops_sid=wrong");
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "ERR_AUTH_REJECTED" });
    const clearCookie = invalid.headers.get("set-cookie") ?? "";
    expect(clearCookie).toContain("__Host-bdo_ops_sid=;");
    expect(clearCookie).not.toContain("=wrong");
  });

  test("method matrix returns 405 with Allow: GET", async () => {
    for (const method of [
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ]) {
      const response = await fetch(
        `${base}/api/v1/hierarchy/AGENTROOT/risk/2`,
        {
          method,
          headers: { cookie: "__Host-bdo_ops_sid=valid-session" },
        },
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      if (method !== "HEAD") {
        expect(await response.json()).toEqual({
          error: "ERR_METHOD_NOT_ALLOWED",
        });
      }
    }
  });

  test("rejects empty, whitespace and oversized logins at the boundary", async () => {
    expect((await request("%20", "2")).status).toBe(400);
    expect((await request("A".repeat(200), "2")).status).toBe(400);
  });

  test("accepts tier 0 and rejects tier 7 and non-numeric tiers", async () => {
    expect((await request("AGENTROOT", "0")).status).toBe(200);
    expect((await request("AGENTROOT", "7")).status).toBe(400);
    expect((await request("AGENTROOT", "abc")).status).toBe(400);
  });

  test("does not emit a refreshed cookie on a failed verifier", async () => {
    const response = await request(
      "AGENTROOT",
      "2",
      "__Host-bdo_ops_sid=wrong",
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("valid-session");
    expect(setCookie).toContain("__Host-bdo_ops_sid=;");
  });

  test("concurrent delayed verifiers do not cross-contaminate scratch", async () => {
    const fetchRow = async (login: string): Promise<number> => {
      const response = await fetch(
        `${concurrentServer.url.origin}/api/v1/hierarchy/${login}/risk/2`,
        { headers: { cookie: "__Host-bdo_ops_sid=valid-session" } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-match-count")).toBe("1");
      const bytes = new Uint16Array(await response.arrayBuffer());
      expect(bytes.length).toBe(1);
      return bytes[0]!;
    };
    const [left, right] = await Promise.all([
      fetchRow("AGENTROOT"),
      fetchRow("AGENTERR"),
    ]);
    expect(left).toBe(rowOf("AGENTROOT"));
    expect(right).toBe(rowOf("AGENTERR"));
    expect(left).not.toBe(right);
  });

  test("propagates spine contention as 503", async () => {
    const response = await request("AGENTERR", "6");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "ERR_SPINE_CONTENDED",
      code: -1,
    });
  });
});

test.skip("canonical cold-ingest parity is blocked on the canonical module", () => {
  // When the canonical module lands, assert identical key words, lookup hits,
  // packed (kind << 15) | rowOrdinal words, agentCount, and strict/limb behavior
  // for the same fixture nodes before deleting scaffold-only expectations.
});
