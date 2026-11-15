import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AllowlistError,
  MUTATION_OPS,
  PULL_READ_ONLY_OPS,
  READ_ONLY_OPS,
  assertAllowedRead,
  assertPullReadOnly,
  assertReadOnly,
  isAllowedReadOp,
  parseOpsArgument,
} from "../scripts/capture/allowlist.ts";
import {
  F402PullClient,
  F402PullerError,
  RequestPacer,
  backoffDelayMs,
  buildManagerUrl,
  containsRawIp,
  createPaceClock,
  defaultTransactionStartDate,
  eachUtcDateInclusive,
  emptyCheckpoint,
  loadCheckpoint,
  parseCheckpoint,
  parseHierarchyList,
  redactSecrets,
  redactSecretsAndIps,
  resolvePullSession,
  runCensus,
  runContract,
  formatGradedDate,
  runTransactions,
  runWagers,
  runWeblog,
  saveCheckpoint,
  summarizeHierarchy,
  type F402Session,
  type SessionProvider,
} from "../lib/f402_readonly_puller.ts";

const FIX = join(import.meta.dir, "fixtures/f402-readonly-pull");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf8")) as unknown;
}

function tempOut(): string {
  return mkdtempSync(join(tmpdir(), "f402-pull-"));
}

const session: F402Session = {
  cookieHeader: "session=fake",
  cookieNames: ["session"],
  authorizationHeader: "Bearer " + "a".repeat(32),
  obtainedAtIso: "2026-11-14T18:00:00.000Z",
  expiresAtIso: "2026-11-15T18:00:00.000Z",
};

function formOf(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

describe("allowlist expansion", () => {
  test("capture --ops all stays the original eight", () => {
    expect(READ_ONLY_OPS).toEqual([
      "getWebLog",
      "getInfoPlayer",
      "getBetTicker",
      "getBetTickerConfig",
      "getPending",
      "getSportsVigSetup",
      "getInfoManager",
      "getCustomerNotes",
    ]);
    expect(parseOpsArgument("all")).toEqual([...READ_ONLY_OPS]);
  });

  test("puller reads are allowed and only the verified set", () => {
    expect([...PULL_READ_ONLY_OPS]).toEqual([
      "getHeriarchy",
      "getListAgenstByAgent",
      "getPlayers",
      "getCustomerAdmin",
      "getTransactionList",
      "getDeletedTransactionHistory",
      "getWebLog",
      "getPending",
      "getBetTicker",
      "getGraded",
      "getWagersByFigureDate",
    ]);
    for (const op of PULL_READ_ONLY_OPS) {
      expect(assertPullReadOnly(op)).toBe(op);
      expect(assertAllowedRead(op)).toBe(op);
      expect(isAllowedReadOp(`/cloud/api/Manager/${op}`)).toBe(true);
    }
    expect(
      assertPullReadOnly("POST /cloud/api/Manager/getTransactionList"),
    ).toBe("getTransactionList");
  });

  test("capture-only reads are not puller ops (except shared reads)", () => {
    expect(() => assertPullReadOnly("getInfoPlayer")).toThrow(AllowlistError);
    expect(() => assertPullReadOnly("getBetTickerConfig")).toThrow(
      AllowlistError,
    );
    expect(assertAllowedRead("getInfoPlayer")).toBe("getInfoPlayer");
    expect(assertReadOnly("getInfoPlayer")).toBe("getInfoPlayer");
    expect(assertPullReadOnly("getPending")).toBe("getPending");
    expect(assertPullReadOnly("getBetTicker")).toBe("getBetTicker");
  });

  test("writes and unknown ops stay refused", () => {
    const writes = [
      ...MUTATION_OPS,
      "authenticateCustomer",
      "authenticateCustomerforAgent",
      "OTPLoginWithCode",
      "updateByColumn",
      "insertTransaction",
      "deleteTransaction",
      "changeCarry",
      "write",
      "writeDetail",
      "writeErr",
      "renewToken",
    ];
    for (const op of writes) {
      expect(() => assertPullReadOnly(op)).toThrow(AllowlistError);
      expect(() => assertAllowedRead(op)).toThrow(AllowlistError);
      expect(() => assertReadOnly(op)).toThrow(AllowlistError);
      expect(isAllowedReadOp(op)).toBe(false);
    }
    expect(() => assertAllowedRead("getSomethingUndocumented")).toThrow(
      AllowlistError,
    );
    try {
      assertAllowedRead("insertTransaction");
    } catch (error) {
      expect(error).toBeInstanceOf(AllowlistError);
      expect((error as AllowlistError).code).toBe("mutation");
    }
    try {
      assertAllowedRead("authenticateCustomer");
    } catch (error) {
      expect((error as AllowlistError).code).toBe("auth-exchange");
    }
  });
});

describe("redaction", () => {
  test("strips passwords and phones but can keep or drop IPs", () => {
    const raw = {
      Password: "secret",
      PhoneNumber: "555-0100",
      IPAddress: "203.0.113.50",
      nested: { pass: "x", Login: "CUST1" },
    };
    const secretsOnly = redactSecrets(raw) as Record<string, unknown>;
    expect(secretsOnly.Password).toBe("<redacted>");
    expect(secretsOnly.PhoneNumber).toBe("<redacted>");
    expect(secretsOnly.IPAddress).toBe("203.0.113.50");
    expect((secretsOnly.nested as { pass: string }).pass).toBe("<redacted>");
    const noIps = redactSecretsAndIps(raw) as Record<string, unknown>;
    expect(noIps.IPAddress).toBe("<redacted>");
    expect(containsRawIp(secretsOnly)).toBe(true);
    expect(containsRawIp(noIps)).toBe(false);
  });
});

describe("pacing and backoff", () => {
  test("waits out the interval between requests", async () => {
    const sleeps: number[] = [];
    let now = 1_000_000;
    const clock = createPaceClock({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const pacer = new RequestPacer(1000, clock);
    expect(await pacer.wait()).toBe(0);
    expect(await pacer.wait()).toBe(1000);
    expect(sleeps).toEqual([1000]);
  });

  test("backoff doubles and caps", () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(10, 30_000)).toBe(30_000);
  });
});

describe("checkpoint resume", () => {
  test("round-trips and rejects a bad version", () => {
    const parsed = parseCheckpoint({
      version: 1,
      phase: "transactions",
      agentId: "ROOT1",
      customerIds: ["CUST1"],
      completedCustomers: ["CUST1"],
      completedWeblogDates: [],
      updatedAtIso: "2026-11-14T00:00:00.000Z",
    });
    expect(parsed.completedCustomers).toEqual(["CUST1"]);
    expect(() =>
      parseCheckpoint({ version: 99, phase: "census", agentId: "X" }),
    ).toThrow(F402PullerError);
  });
});

describe("F402PullClient", () => {
  test("refuses a write before fetch and posts only allowlisted reads", async () => {
    const calls: string[] = [];
    const client = new F402PullClient({
      session,
      intervalMs: 0,
      fetchImpl: async (url, init) => {
        calls.push(`${url} ${formOf(init).get("operation")}`);
        return new Response(JSON.stringify({ LIST: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(
      client.post("insertTransaction" as never, { acc: "CUST1" }),
    ).rejects.toBeInstanceOf(AllowlistError);
    expect(calls).toEqual([]);
    await client.post("getTransactionList", { acc: "CUST1", start: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/cloud/api/Manager/getTransactionList");
    expect(buildManagerUrl("https://fantasy402.com", "getHeriarchy")).toBe(
      "https://fantasy402.com/cloud/api/Manager/getHeriarchy",
    );
    expect(() =>
      buildManagerUrl("https://fantasy402.com", "deleteTransaction" as never),
    ).toThrow(AllowlistError);
  });

  test("retries 429/5xx with backoff then succeeds", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const clock = createPaceClock({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    let hits = 0;
    const client = new F402PullClient({
      session,
      intervalMs: 0,
      clock,
      fetchImpl: async () => {
        hits += 1;
        if (hits === 1) return new Response("slow", { status: 429 });
        if (hits === 2) return new Response("down", { status: 503 });
        return new Response(JSON.stringify({ LIST: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const payload = await client.post("getPlayers", { agentID: "ROOT1" });
    expect(payload).toEqual({ LIST: [] });
    expect(hits).toBe(3);
    expect(sleeps.some((ms) => ms >= 1000)).toBe(true);
  });

  test("401 is an auth error and is not retried", async () => {
    let hits = 0;
    const client = new F402PullClient({
      session,
      intervalMs: 0,
      fetchImpl: async () => {
        hits += 1;
        return new Response("denied", { status: 401 });
      },
    });
    await expect(
      client.post("getPlayers", { agentID: "ROOT1" }),
    ).rejects.toMatchObject({
      code: "auth",
      status: 401,
    });
    expect(hits).toBe(1);
  });
});

describe("phases with synthetic fixtures", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function fixtureFetch(): (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> {
    return async (url, init) => {
      const op = formOf(init).get("operation");
      const body =
        op === "getHeriarchy"
          ? loadFixture("hierarchy.json")
          : op === "getListAgenstByAgent"
            ? loadFixture("list-agents.json")
            : op === "getTransactionList"
              ? loadFixture("transactions.json")
              : op === "getDeletedTransactionHistory"
                ? loadFixture("deleted.json")
                : op === "getWebLog"
                  ? loadFixture("weblog.json")
                  : null;
      if (body === null) {
        return new Response("unexpected op", { status: 500 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  function ctx(outDir: string) {
    dirs.push(outDir);
    return {
      client: new F402PullClient({
        session,
        intervalMs: 0,
        fetchImpl: fixtureFetch(),
      }),
      outDir,
      agentId: "ROOT1",
      agentOwner: "ROOT1",
      agentType: "M",
    };
  }

  test("census counts agents and players and redacts passwords", async () => {
    const outDir = tempOut();
    const result = await runCensus(ctx(outDir));
    expect(result.agentCount).toBe(3);
    expect(result.playerCount).toBe(2);
    expect(result.maxLevel).toBe(2);
    expect(result.roots).toBe(1);
    expect(result.orphans).toBe(1);
    expect(result.customerIds).toEqual(["CUST1", "CUST2"]);
    const rawAgents = readFileSync(
      join(outDir, "raw/census/getListAgenstByAgent.json"),
      "utf8",
    );
    expect(rawAgents).not.toContain("plaintext-password");
    expect(rawAgents).toContain("<redacted>");
    const rawHierarchy = readFileSync(
      join(outDir, "raw/census/getHeriarchy.json"),
      "utf8",
    );
    expect(rawHierarchy).not.toContain("should-not-survive");
    const summary = JSON.parse(
      readFileSync(join(outDir, "census-summary.json"), "utf8"),
    ) as { playerCount: number; customerIds?: unknown };
    expect(summary.playerCount).toBe(2);
    expect(summary.customerIds).toBeUndefined();
    const checkpoint = loadCheckpoint(outDir);
    expect(checkpoint?.customerIds).toEqual(["CUST1", "CUST2"]);
  });

  test("contract hits dated start, empty start, and deleted history", async () => {
    const outDir = tempOut();
    const seen: string[] = [];
    const client = new F402PullClient({
      session,
      intervalMs: 0,
      fetchImpl: async (_url, init) => {
        const form = formOf(init);
        seen.push(
          `${form.get("operation")}:${form.get("start") ?? form.get("customerID")}`,
        );
        const op = form.get("operation");
        const body =
          op === "getTransactionList"
            ? loadFixture("transactions.json")
            : loadFixture("deleted.json");
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    dirs.push(outDir);
    const result = await runContract(
      { client, outDir, agentId: "ROOT1", agentOwner: "ROOT1", agentType: "M" },
      { customerId: "CUST1", start: "2026-10-15" },
    );
    expect(seen).toEqual([
      "getTransactionList:2026-10-15",
      "getTransactionList:",
      "getDeletedTransactionHistory:CUST1",
    ]);
    expect(result.datedCount).toBe(1);
    expect(result.emptyStartCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(result.emptyStartAccepted).toBe(true);
    expect(result.datedKeys).toContain("TranType");
    const raw = readFileSync(
      join(outDir, "raw/contract/CUST1.dated.json"),
      "utf8",
    );
    expect(raw).not.toContain("nope");
  });

  test("transactions resume from the checkpoint", async () => {
    const outDir = tempOut();
    const context = ctx(outDir);
    await runCensus(context);
    const first = await runTransactions(context, { start: "" });
    expect(first).toEqual({ attempted: 2, completed: 2, skipped: 0 });
    const second = await runTransactions(context, { start: "" });
    expect(second).toEqual({ attempted: 2, completed: 0, skipped: 2 });
  });

  test("weblog is day-unit, keeps IPs only in raw, and resumes", async () => {
    const outDir = tempOut();
    const context = ctx(outDir);
    const first = await runWeblog(context, {
      from: "2026-11-01",
      to: "2026-11-02",
      mode: "I",
    });
    expect(first.completed).toBe(2);
    expect(first.rowCounts["2026-11-01"]).toBe(1);
    const raw = readFileSync(
      join(outDir, "raw/weblog/2026-11-01.json"),
      "utf8",
    );
    expect(raw).toContain("203.0.113.50");
    const summary = readFileSync(join(outDir, "weblog-summary.json"), "utf8");
    expect(summary).not.toContain("203.0.113.50");
    const second = await runWeblog(context, {
      from: "2026-11-01",
      to: "2026-11-02",
      mode: "I",
    });
    expect(second).toMatchObject({ completed: 0, skipped: 2 });
  });
});

describe("hierarchy parse", () => {
  test("summarizes levels and orphans", () => {
    const rows = parseHierarchyList(loadFixture("hierarchy.json"));
    const summary = summarizeHierarchy(rows);
    expect(summary).toMatchObject({
      agentCount: 3,
      maxLevel: 2,
      roots: 1,
      orphans: 1,
    });
  });
});

describe("session refresh window", () => {
  test("reuses a fresh session and refreshes an old one", async () => {
    const fresh: F402Session = {
      ...session,
      obtainedAtIso: "2026-11-14T19:50:00.000Z",
      expiresAtIso: "2026-11-15T00:00:00.000Z",
    };
    const refreshed: F402Session = {
      ...session,
      obtainedAtIso: "2026-11-14T20:00:00.000Z",
      authorizationHeader: "Bearer " + "b".repeat(32),
    };
    let refreshes = 0;
    const provider: SessionProvider = {
      read: () => fresh,
      ensure: async () => fresh,
      refresh: async () => {
        refreshes += 1;
        return refreshed;
      },
    };
    const kept = await resolvePullSession({
      provider,
      now: Date.parse("2026-11-14T19:55:00.000Z"),
      refreshAfterMs: 15 * 60_000,
    });
    expect(kept.authorizationHeader).toBe(fresh.authorizationHeader);
    expect(refreshes).toBe(0);

    const stale: F402Session = {
      ...fresh,
      obtainedAtIso: "2026-11-14T19:00:00.000Z",
    };
    const staleProvider: SessionProvider = {
      read: () => stale,
      ensure: async () => stale,
      refresh: async () => {
        refreshes += 1;
        return refreshed;
      },
    };
    const next = await resolvePullSession({
      provider: staleProvider,
      now: Date.parse("2026-11-14T19:20:00.000Z"),
      refreshAfterMs: 15 * 60_000,
    });
    expect(next.authorizationHeader).toBe(refreshed.authorizationHeader);
    expect(refreshes).toBe(1);
  });
});

describe("date helpers", () => {
  test("enumerates inclusive UTC days and default start is ISO", () => {
    expect(eachUtcDateInclusive("2026-11-01", "2026-11-03")).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(defaultTransactionStartDate(new Date("2026-11-14T00:00:00Z"))).toBe(
      "2026-10-15",
    );
    expect(() => eachUtcDateInclusive("2026-11-03", "2026-11-01")).toThrow(
      F402PullerError,
    );
  });
});

describe("checkpoint file helpers", () => {
  test("save and load", () => {
    const outDir = tempOut();
    try {
      const checkpoint = emptyCheckpoint("ROOT1", "2026-11-14T00:00:00.000Z");
      saveCheckpoint(outDir, {
        ...checkpoint,
        customerIds: ["CUST1"],
        completedCustomers: ["CUST1"],
      });
      expect(loadCheckpoint(outDir)?.completedCustomers).toEqual(["CUST1"]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("wagers phase", () => {
  test("getGraded dates are MM-DD-YYYY and figure-date posts to Report", async () => {
    expect(formatGradedDate("2026-11-01")).toBe("11-01-2026");
    const urls: string[] = [];
    const forms: string[] = [];
    const client = new F402PullClient({
      session,
      intervalMs: 0,
      fetchImpl: async (url, init) => {
        urls.push(url);
        forms.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ LIST: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const outDir = tempOut();
    saveCheckpoint(
      outDir,
      emptyCheckpoint("ROOT1", "2026-11-14T00:00:00.000Z"),
    );
    const prior = loadCheckpoint(outDir);
    saveCheckpoint(outDir, {
      ...prior!,
      customerIds: ["CUST1"],
    });
    const result = await runWagers(
      {
        client,
        outDir,
        agentId: "ROOT1",
        agentOwner: "ROOT1",
        agentType: "M",
      },
      { from: "2026-11-01", to: "2026-11-01", resume: false },
    );
    expect(result.gradedCompleted).toBe(1);
    expect(result.figureDateCompleted).toBe(1);
    expect(urls.some((u) => u.endsWith("/cloud/api/Manager/getPending"))).toBe(
      true,
    );
    expect(
      urls.some((u) => u.endsWith("/cloud/api/Manager/getBetTicker")),
    ).toBe(true);
    expect(urls.some((u) => u.endsWith("/cloud/api/Manager/getGraded"))).toBe(
      true,
    );
    expect(
      urls.some((u) => u.endsWith("/cloud/api/Report/getWagersByFigureDate")),
    ).toBe(true);
    expect(forms.some((body) => body.includes("startDate=11-01-2026"))).toBe(
      true,
    );
    expect(forms.some((body) => body.includes("endDate=11-01-2026"))).toBe(
      true,
    );
  });

  test("wagers resume skips completed pending, ticker, and graded days", async () => {
    const urls: string[] = [];
    const client = new F402PullClient({
      session,
      intervalMs: 0,
      fetchImpl: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ LIST: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const outDir = tempOut();
    const base = emptyCheckpoint("ROOT1", "2026-11-14T00:00:00.000Z");
    saveCheckpoint(outDir, {
      ...base,
      customerIds: ["CUST1"],
      wagersPendingDone: true,
      wagersTickerDone: true,
      completedGradedDates: ["2026-11-01"],
      completedFigureDateKeys: ["CUST1|2026-11-01"],
    });
    const result = await runWagers(
      {
        client,
        outDir,
        agentId: "ROOT1",
        agentOwner: "ROOT1",
        agentType: "M",
      },
      { from: "2026-11-01", to: "2026-11-01", resume: true },
    );
    expect(result.gradedSkipped).toBe(1);
    expect(result.figureDateSkipped).toBe(1);
    expect(urls).toEqual([]);
  });
});
