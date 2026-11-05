import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";
import {
  executionFixtureFetch,
  type ExecutionFixtureFetch,
} from "./fixtures/execution/fixture_fetch.ts";
import { appendExecutionApproval } from "../lib/execution_approvals.ts";

/**
 * The execution API, fully offline: Kalshi + Polymarket fixtures through the server seams, a temp
 * ledger root, and an injectable clock. The assertions that matter are the safety ones — the plan
 * never writes or calls an order endpoint, live mode/run answer 409 without credentials, and a
 * paper run appends to the temp ledger and nowhere else.
 */

const START = new Date("2026-11-04T12:00:00.000Z");

describe("execution API", () => {
  let server: ReturnType<typeof startServer>;
  let fixture: ExecutionFixtureFetch;
  let ledgerRoot: string;
  let clockMs: number;
  const clock = (): Date => new Date(clockMs);

  beforeAll(() => {
    fixture = executionFixtureFetch({ forceOpenGammaMarket: true });
    ledgerRoot = mkdtempSync(join(tmpdir(), "execution-api-"));
    clockMs = START.getTime();
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      kalshiFetch: fixture.fetch,
      kalshiNow: () => clockMs,
      polymarketFetch: fixture.fetch,
      executionNow: clock,
      executionLedgerRoot: ledgerRoot,
      executionEnv: {},
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(ledgerRoot, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`${server.url}${path}`);
  const post = (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("GET /api/execution/plan is a no-store, read-only plan", async () => {
    const res = await get("api/execution/plan?limit=10");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Authorization");
    const body = (await res.json()) as {
      success?: unknown;
      schemaVersion?: unknown;
      mode?: unknown;
      killSwitch?: unknown;
      policy?: Record<string, unknown>;
      venues?: {
        kalshi?: { liveReady?: unknown; reason?: unknown };
        polymarket?: { liveReady?: unknown; reason?: unknown };
      };
      risk?: Record<string, unknown>;
      decisions?: Array<Record<string, unknown>>;
      paper?: { quotes?: unknown; fills?: unknown; ledgerTail?: unknown };
      blockedReasons?: unknown;
    };
    expect(body.success).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.mode).toBe("paper");
    expect(body.killSwitch).toBe(false);
    expect(body.policy?.hedgeRatio).toBe(0.5);
    expect(body.venues?.kalshi?.liveReady).toBe(false);
    expect(body.venues?.kalshi?.reason).toBeString();
    expect(body.venues?.polymarket?.liveReady).toBe(false);
    expect(body.venues?.polymarket?.reason).toContain("no EIP-712 signer");
    expect(body.risk).toBeDefined();
    expect(Array.isArray(body.decisions)).toBe(true);
    expect(body.paper?.quotes).toBeDefined();
    expect(body.paper?.fills).toBeDefined();

    // Internal book evidence is stripped from the API decision objects.
    for (const decision of body.decisions ?? []) {
      expect(decision["bookLevels"]).toBeUndefined();
    }
    // Planning never writes the ledger and never calls an order endpoint.
    expect(existsSync(join(ledgerRoot, "Scratch/execution/ledger.jsonl"))).toBe(
      false,
    );
    expect(fixture.orderCalls).toEqual([]);
  });

  test("POST /api/execution/mode switches paper↔paused and audits it", async () => {
    const paused = await post("api/execution/mode", { mode: "paused" });
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as {
      success?: unknown;
      mode?: unknown;
      killSwitch?: unknown;
    };
    expect(pausedBody.success).toBe(true);
    expect(pausedBody.mode).toBe("paused");
    expect(pausedBody.killSwitch).toBe(true);

    const plan = (await (await get("api/execution/plan")).json()) as {
      mode?: unknown;
      killSwitch?: unknown;
      decisions?: Array<{ blocked?: unknown; blockReason?: unknown }>;
    };
    expect(plan.mode).toBe("paused");
    expect(plan.killSwitch).toBe(true);
    expect(
      (plan.decisions ?? []).every((decision) => decision.blocked === true),
    ).toBe(true);

    const paper = await post("api/execution/mode", { mode: "paper" });
    expect(((await paper.json()) as { mode?: unknown }).mode).toBe("paper");
    expect(fixture.orderCalls).toEqual([]);
  });

  test("POST mode live is 409 without env/credentials/confirm", async () => {
    const res = await post("api/execution/mode", {
      mode: "live",
      confirm: "LIVE",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      success?: unknown;
      error?: unknown;
      reasons?: unknown;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("live_not_armed");
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons).toContain("EXECUTION_LIVE is not 1");
    expect(fixture.orderCalls).toEqual([]);
  });

  test("POST /run paper appends to the temp ledger; live run is refused", async () => {
    await post("api/execution/mode", { mode: "paper" });
    clockMs += 2_500;
    const run = await post("api/execution/run", {});
    expect(run.status).toBe(200);
    const body = (await run.json()) as {
      success?: unknown;
      live?: unknown;
      decisions?: unknown;
      paper?: { fills?: unknown; quotes?: unknown };
    };
    expect(body.success).toBe(true);
    expect(body.live).toBe(false);
    expect(Array.isArray(body.decisions)).toBe(true);
    expect(Array.isArray(body.paper?.fills)).toBe(true);
    expect(Array.isArray(body.paper?.quotes)).toBe(true);

    const ledgerPath = join(ledgerRoot, "Scratch/execution/ledger.jsonl");
    expect(existsSync(ledgerPath)).toBe(true);

    // The 2s rate limit applies to the next immediate run.
    const throttled = await post("api/execution/run", {});
    expect(throttled.status).toBe(429);
    expect(((await throttled.json()) as { error?: unknown }).error).toBe(
      "rate_limited",
    );

    clockMs += 2_500;
    const live = await post("api/execution/run", {
      live: true,
      confirm: "PLACE LIVE ORDERS",
    });
    expect(live.status).toBe(409);
    const liveBody = (await live.json()) as {
      error?: unknown;
      reasons?: unknown;
    };
    expect(liveBody.error).toBe("live_not_armed");
    expect(liveBody.reasons).toContain("EXECUTION_LIVE is not 1");
    expect(fixture.orderCalls).toEqual([]);
  });

  test("style preference is validated and applied to the plan", async () => {
    const makerPlan = await get("api/execution/plan?style=maker");
    expect(makerPlan.status).toBe(200);
    const makerBody = (await makerPlan.json()) as {
      style?: unknown;
      decisions?: Array<{ style?: unknown }>;
    };
    expect(makerBody.style).toBe("maker");
    expect(
      (makerBody.decisions ?? []).every(
        (decision) => decision.style !== "taker",
      ),
    ).toBe(true);

    const invalid = await get("api/execution/plan?style=limit");
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error?: unknown }).error).toBe(
      "invalid_style",
    );
  });

  test("human approval gates a run and the latest decision wins", async () => {
    const plan = (await (await get("api/execution/plan")).json()) as {
      decisions?: Array<{ signalId?: string }>;
    };
    const signalId = plan.decisions?.[0]?.signalId;
    expect(typeof signalId).toBe("string");

    await appendExecutionApproval(ledgerRoot, {
      signalId: signalId as string,
      action: "approve",
      actor: "operator-a",
      style: "maker",
    });

    clockMs += 2_500;
    const run = await post("api/execution/run", {
      requireApproval: true,
      style: "taker",
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as {
      style?: unknown;
      approvals?: unknown[];
      decisions?: Array<{ signalId?: string }>;
    };
    expect(runBody.style).toBe("taker");
    expect(runBody.approvals).toHaveLength(1);
    expect(
      (runBody.decisions ?? []).every(
        (decision) => decision.signalId === signalId,
      ),
    ).toBe(true);

    await appendExecutionApproval(ledgerRoot, {
      signalId: signalId as string,
      action: "reject",
      actor: "operator-b",
      reason: "price moved",
    });
    clockMs += 2_500;
    const rejected = await post("api/execution/run", { requireApproval: true });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error?: unknown }).error).toBe(
      "no_approved_signals",
    );
    expect(fixture.orderCalls).toEqual([]);
  });
});
