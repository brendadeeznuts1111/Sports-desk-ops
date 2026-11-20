import { describe, expect, test } from "bun:test";
import { createDashboardApi, type DashboardApiDeps } from "@sportsdesk-ops/api";
import {
  CURSOR_VERSION,
  decodeSignedCursor,
  encodeSignedCursor,
  paginateArrayWithSignedCursor,
  parseCursorPageLimit,
  resolveCursorSecrets,
} from "../lib/signed_cursor.ts";

const TEST_SECRET = "test-hmac-secret-key-32-bytes-min";
const ROTATED_SECRET = "rotated-hmac-secret-key-32-bytes-min";

function buildCursorApiDeps(
  overrides: Partial<DashboardApiDeps> = {},
): DashboardApiDeps {
  const alertRows = [
    { deliveryId: "del-1", status: "dead" },
    { deliveryId: "del-2", status: "dead" },
    { deliveryId: "del-3", status: "dead" },
    { deliveryId: "del-4", status: "queued" },
  ];
  const wagerRows = [
    { ticketId: "W-101", riskUsd: 500 },
    { ticketId: "W-102", riskUsd: 1000 },
    { ticketId: "W-103", riskUsd: 2500 },
    { ticketId: "W-104", riskUsd: 5000 },
    { ticketId: "W-105", riskUsd: 7500 },
  ];
  const rankingPlayers = [
    { customerId: "P1", score: 9.8 },
    { customerId: "P2", score: 9.5 },
    { customerId: "P3", score: 9.1 },
    { customerId: "P4", score: 8.7 },
    { customerId: "P5", score: 8.2 },
  ];

  return {
    auth: {
      login: async () => Response.json({ ok: true }),
      logout: async () => Response.json({ ok: true }),
      me: async () => Response.json({ authenticated: true }),
    },
    getHealthPayload: () => ({ status: "ok", schemaVersion: 1 }),
    cursorSecret: TEST_SECRET,
    loadDashboardMarkdown: async () => ({
      stamp: "1:1",
      markdown: "# Desk",
      html: "<h1>Desk</h1>",
    }),
    dns: {
      getTelemetryPayload: () => ({ success: true }),
      benchmark: async () => ({}),
      classifyIp: async () => ({}),
    },
    customers: {
      getCohortReport: async () => ({ versionStamp: "v1", payload: {} }),
      getProfile: async () => null,
      getRating: async () => null,
    },
    execTerminal: async (command) => ({ command, stdout: "", exitCode: 0 }),
    rankings: {
      getAll: async (limit) => ({
        generatedAtIso: "2026-11-20T18:00:00.000Z",
        payload: {
          generatedAtIso: "2026-11-20T18:00:00.000Z",
          topRankedPlayers: rankingPlayers.slice(0, limit),
        },
      }),
      getConduits: async () => [],
    },
    getLiveWagersPayload: async () => ({
      wagers: wagerRows,
      autoExecute: false,
    }),
    getWagersTabPolicy: async () => ({
      policy_version: "wagers-policy/v1",
      policy_schema: "sportsdesk-wagers-tab/v1",
    }),
    getTiersConfig: async () => ({ tiers: {} }),
    alerts: {
      sweepOnce: async () => ({ checked: 0 }),
      list: (status) =>
        status === "all"
          ? alertRows
          : alertRows.filter((row) => row.status === status),
      ack: async () => true,
      retry: async () => "del-1",
      getShiftSummary: () => ({ ok: true }),
    },
    getTaxonomyCatalog: () => ({}),
    runShadowPricing: async () => ({}),
    getBuildMatrix: async () => ({ targets: [], generatedAt: "2026-11-20Z" }),
    ...overrides,
  };
}

describe("signed_cursor · unit & security invariants", () => {
  test("produces unpadded base64url wire format and hides raw numeric offsets", () => {
    const cursor = encodeSignedCursor(
      ["acme", "sportsdesk-ops"],
      2,
      TEST_SECRET,
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("=");
    expect(cursor).not.toBe("2");

    const decoded = decodeSignedCursor(
      cursor,
      ["acme", "sportsdesk-ops"],
      TEST_SECRET,
    );
    expect(decoded).toBe(2);
  });

  test("rejects tampering, padded base64url, wrong secret, raw numbers, and cross-tenant replay", () => {
    const cursor = encodeSignedCursor(
      ["acme", "sportsdesk-ops"],
      2,
      TEST_SECRET,
    );
    const [payload = "", sig = ""] = cursor.split(".");
    const tamperedSig = `${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    const wrongVersionPayload = Buffer.from(
      "v2|acme|sportsdesk-ops|2",
      "utf8",
    ).toString("base64url");
    const padded = `${payload}===.${sig}`;

    for (const bad of [
      "2",
      "",
      tamperedSig,
      `${wrongVersionPayload}.${sig}`,
      padded,
      `${payload}.`,
      `.${sig}`,
      `${payload}.${sig}.extra`,
      "not*base64.cursor!",
      encodeSignedCursor(["acme", "sportsdesk-ops"], 2, "wrong-secret"),
    ]) {
      expect(
        decodeSignedCursor(bad, ["acme", "sportsdesk-ops"], TEST_SECRET),
      ).toBeNull();
    }

    expect(
      decodeSignedCursor(cursor, ["acme", "other-repo"], TEST_SECRET),
    ).toBeNull();
    expect(
      decodeSignedCursor(cursor, ["other-org", "sportsdesk-ops"], TEST_SECRET),
    ).toBeNull();
  });

  test("rejects delimiter injection, non-positive positions, empty secrets, and invalid limits", () => {
    expect(() =>
      encodeSignedCursor(["acme|evil", "repo"], 1, TEST_SECRET),
    ).toThrow("SIGNED_CURSOR_INVALID_SCOPE");
    expect(() => encodeSignedCursor([], 1, TEST_SECRET)).toThrow(
      "SIGNED_CURSOR_INVALID_SCOPE",
    );
    expect(() => encodeSignedCursor(["acme", "repo"], 0, TEST_SECRET)).toThrow(
      "SIGNED_CURSOR_INVALID_POSITION",
    );
    expect(() =>
      encodeSignedCursor(["acme", "repo"], 1.5, TEST_SECRET),
    ).toThrow("SIGNED_CURSOR_INVALID_POSITION");
    expect(() =>
      encodeSignedCursor(
        ["acme", "repo"],
        Number.MAX_SAFE_INTEGER + 1,
        TEST_SECRET,
      ),
    ).toThrow("SIGNED_CURSOR_INVALID_POSITION");
    expect(() => encodeSignedCursor(["acme", "repo"], 1, "   ")).toThrow(
      "SIGNED_CURSOR_EMPTY_SECRET",
    );
    expect(() => resolveCursorSecrets(["", "  "])).toThrow(
      "SIGNED_CURSOR_EMPTY_SECRET",
    );

    const injectedSig = Buffer.from(
      new Bun.CryptoHasher("sha256", TEST_SECRET)
        .update(
          Buffer.from(`${CURSOR_VERSION}|acme|evil|repo|2`, "utf8").toString(
            "base64url",
          ),
        )
        .digest(),
    ).toString("base64url");
    const injectedPayload = Buffer.from(
      `${CURSOR_VERSION}|acme|evil|repo|2`,
      "utf8",
    ).toString("base64url");
    expect(
      decodeSignedCursor(
        `${injectedPayload}.${injectedSig}`,
        ["acme|evil", "repo"],
        TEST_SECRET,
      ),
    ).toBeNull();

    expect(parseCursorPageLimit("0", 20, 100)).toBeNull();
    expect(parseCursorPageLimit("-5", 20, 100)).toBeNull();
    expect(parseCursorPageLimit("abc", 20, 100)).toBeNull();
    expect(parseCursorPageLimit("250", 20, 100)).toBe(100);
  });

  test("supports dual-secret key rotation for verification while signing with primary key", () => {
    const oldCursor = encodeSignedCursor(["wagers", "wagers"], 2, TEST_SECRET);
    const items = ["a", "b", "c", "d", "e"];
    const res = paginateArrayWithSignedCursor(items, {
      rawLimit: "2",
      rawCursor: oldCursor,
      scope: ["wagers", "wagers"],
      secret: [ROTATED_SECRET, TEST_SECRET],
      defaultLimit: 20,
      maxLimit: 100,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toEqual(["c", "d"]);
    expect(res.pageInfo.hasMore).toBe(true);
    const nextCursor = res.pageInfo.nextCursor;
    expect(nextCursor).not.toBeNull();
    if (nextCursor === null) return;
    expect(
      decodeSignedCursor(nextCursor, ["wagers", "wagers"], ROTATED_SECRET),
    ).toBe(4);
    expect(
      decodeSignedCursor(nextCursor, ["wagers", "wagers"], TEST_SECRET),
    ).toBeNull();
  });
});

describe("signed_cursor · API endpoints", () => {
  test("GET /api/alerts paginates with ?limit=&cursor=, preserves unfiltered default, and rejects forged/cross-status cursors", async () => {
    let listCalls = 0;
    const baseDeps = buildCursorApiDeps();
    const api = createDashboardApi(
      buildCursorApiDeps({
        alerts: {
          ...baseDeps.alerts,
          list: (status) => {
            listCalls += 1;
            return baseDeps.alerts.list(status);
          },
        },
      }),
    );

    const unfiltered = await api.fetch(
      new Request("http://dashboard.local/api/alerts?status=dead"),
    );
    expect(unfiltered.status).toBe(200);
    const unfilteredBody = (await unfiltered.json()) as {
      alerts: Array<{ deliveryId: string }>;
      pageInfo?: unknown;
    };
    expect(unfilteredBody.alerts.map((a) => a.deliveryId)).toEqual([
      "del-1",
      "del-2",
      "del-3",
    ]);
    expect(unfilteredBody.pageInfo).toBeUndefined();

    const p1Res = await api.fetch(
      new Request("http://dashboard.local/api/alerts?status=dead&limit=2"),
    );
    expect(p1Res.status).toBe(200);
    expect(p1Res.headers.get("cache-control")).toBe("no-store");
    const p1 = (await p1Res.json()) as {
      alerts: Array<{ deliveryId: string }>;
      pageInfo: {
        limit: number;
        hasMore: boolean;
        nextCursor: string | null;
        total: number;
      };
    };
    expect(p1.alerts.map((a) => a.deliveryId)).toEqual(["del-1", "del-2"]);
    expect(p1.pageInfo.hasMore).toBe(true);
    expect(p1.pageInfo.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const p2Res = await api.fetch(
      new Request(
        `http://dashboard.local/api/alerts?status=dead&limit=2&cursor=${encodeURIComponent(p1.pageInfo.nextCursor ?? "")}`,
      ),
    );
    expect(p2Res.status).toBe(200);
    const p2 = (await p2Res.json()) as typeof p1;
    expect(p2.alerts.map((a) => a.deliveryId)).toEqual(["del-3"]);
    expect(p2.pageInfo).toEqual({
      limit: 2,
      hasMore: false,
      nextCursor: null,
      total: 3,
    });

    const callsBeforeBad = listCalls;
    const crossStatus = await api.fetch(
      new Request(
        `http://dashboard.local/api/alerts?status=all&limit=2&cursor=${encodeURIComponent(p1.pageInfo.nextCursor ?? "")}`,
      ),
    );
    expect(crossStatus.status).toBe(400);
    expect(crossStatus.headers.get("cache-control")).toBe("no-store");
    expect(await crossStatus.json()).toEqual({
      ok: false,
      error: "INVALID_CURSOR",
    });

    const rawNumeric = await api.fetch(
      new Request("http://dashboard.local/api/alerts?status=dead&cursor=2"),
    );
    expect(rawNumeric.status).toBe(400);
    expect(await rawNumeric.json()).toEqual({
      ok: false,
      error: "INVALID_CURSOR",
    });

    const badLimit = await api.fetch(
      new Request("http://dashboard.local/api/alerts?status=dead&limit=0"),
    );
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toEqual({
      ok: false,
      error: "INVALID_LIMIT",
    });

    const pipeStatus = await api.fetch(
      new Request("http://dashboard.local/api/alerts?status=dead|evil&limit=2"),
    );
    expect(pipeStatus.status).toBe(200);
    expect(listCalls).toBe(callsBeforeBad + 1);
  });

  test("GET /api/wagers and /api/live-wagers isolate cursors per route scope", async () => {
    const api = createDashboardApi(buildCursorApiDeps());

    const plain = await api.fetch(
      new Request("http://dashboard.local/api/wagers"),
    );
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as {
      wagers: unknown[];
      policy_version?: string;
      pageInfo?: unknown;
    };
    expect(plainBody.wagers).toHaveLength(5);
    expect(plainBody.policy_version).toBe("wagers-policy/v1");
    expect(plainBody.pageInfo).toBeUndefined();

    const p1 = (await (
      await api.fetch(new Request("http://dashboard.local/api/wagers?limit=2"))
    ).json()) as {
      wagers: Array<{ ticketId: string }>;
      policy_version: string;
      pageInfo: { nextCursor: string | null; hasMore: boolean; total: number };
    };
    expect(p1.wagers.map((w) => w.ticketId)).toEqual(["W-101", "W-102"]);
    expect(p1.policy_version).toBe("wagers-policy/v1");
    expect(p1.pageInfo.hasMore).toBe(true);

    const p2 = (await (
      await api.fetch(
        new Request(
          `http://dashboard.local/api/wagers?limit=2&cursor=${encodeURIComponent(p1.pageInfo.nextCursor ?? "")}`,
        ),
      )
    ).json()) as typeof p1;
    expect(p2.wagers.map((w) => w.ticketId)).toEqual(["W-103", "W-104"]);

    const replayOnLiveWagers = await api.fetch(
      new Request(
        `http://dashboard.local/api/live-wagers?limit=2&cursor=${encodeURIComponent(p1.pageInfo.nextCursor ?? "")}`,
      ),
    );
    expect(replayOnLiveWagers.status).toBe(400);
    expect(replayOnLiveWagers.headers.get("cache-control")).toBe("no-store");
    expect(await replayOnLiveWagers.json()).toEqual({
      ok: false,
      error: "INVALID_CURSOR",
    });
  });

  test("GET /api/rankings/all paginates with ?pageSize=&cursor= and fails fast on tampered cursors", async () => {
    let getAllCalls = 0;
    const baseDeps = buildCursorApiDeps();
    const api = createDashboardApi(
      buildCursorApiDeps({
        rankings: {
          ...baseDeps.rankings,
          getAll: async (limit) => {
            getAllCalls += 1;
            return baseDeps.rankings.getAll(limit);
          },
        },
      }),
    );

    const legacy = await api.fetch(
      new Request("http://dashboard.local/api/rankings/all?limit=3"),
    );
    expect(legacy.status).toBe(200);
    const legacyBody = (await legacy.json()) as {
      topRankedPlayers: Array<{ customerId: string }>;
      pageInfo?: unknown;
    };
    expect(legacyBody.topRankedPlayers).toHaveLength(3);
    expect(legacyBody.pageInfo).toBeUndefined();

    const p1 = (await (
      await api.fetch(
        new Request("http://dashboard.local/api/rankings/all?pageSize=2"),
      )
    ).json()) as {
      topRankedPlayers: Array<{ customerId: string }>;
      pageInfo: {
        limit: number;
        hasMore: boolean;
        nextCursor: string | null;
        total: number;
      };
    };
    expect(p1.topRankedPlayers.map((p) => p.customerId)).toEqual(["P1", "P2"]);
    expect(p1.pageInfo.hasMore).toBe(true);

    const p2 = (await (
      await api.fetch(
        new Request(
          `http://dashboard.local/api/rankings/all?pageSize=2&cursor=${encodeURIComponent(p1.pageInfo.nextCursor ?? "")}`,
        ),
      )
    ).json()) as typeof p1;
    expect(p2.topRankedPlayers.map((p) => p.customerId)).toEqual(["P3", "P4"]);
    expect(p2.pageInfo.hasMore).toBe(true);

    const p3 = (await (
      await api.fetch(
        new Request(
          `http://dashboard.local/api/rankings/all?pageSize=2&cursor=${encodeURIComponent(p2.pageInfo.nextCursor ?? "")}`,
        ),
      )
    ).json()) as typeof p1;
    expect(p3.topRankedPlayers.map((p) => p.customerId)).toEqual(["P5"]);
    expect(p3.pageInfo).toEqual({
      limit: 2,
      hasMore: false,
      nextCursor: null,
      total: 5,
    });

    const callsBeforeBad = getAllCalls;
    const tampered = await api.fetch(
      new Request(
        "http://dashboard.local/api/rankings/all?pageSize=2&cursor=2",
      ),
    );
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toEqual({
      ok: false,
      error: "INVALID_CURSOR",
    });
    expect(getAllCalls).toBe(callsBeforeBad);
  });
});
