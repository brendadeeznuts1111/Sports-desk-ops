/**
 * @file tests/alerts.test.ts
 * @description Unit tests for surveillance alert queue, dispatch engine, dead-letter queue (DLQ),
 * crash recovery, rate limiting, and Telegram HTML formatting.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import {
  AlertDispatcher,
  acknowledgeAlert,
  enqueueAlert,
  getAlertHealthMetrics,
  getShiftSummary,
  isDuplicatePayload,
  listAlerts,
  processWagerSurveillance,
  recoverAlertState,
  retryAlert,
  type AlertDeliveryResult,
  type QueuedAlert,
  type WagerCandidate,
} from "../lib/alerts.ts";
import { readAuditEntries } from "../lib/audit_log.ts";
import { formatWagerAlertHtml, sendTelegramAlert } from "../lib/telegram.ts";

const TEST_AUDIT_DIR = "scratch/test_alerts_audit";

describe("Surveillance Alert Queue & DLQ Substrate (lib/alerts.ts)", () => {
  const originalEnvDir = process.env.SPORTSDESK_AUDIT_DIR;

  beforeEach(() => {
    (process.env as Record<string, string | undefined>).SPORTSDESK_AUDIT_DIR =
      TEST_AUDIT_DIR;
    if (existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (originalEnvDir !== undefined) {
      (process.env as Record<string, string | undefined>).SPORTSDESK_AUDIT_DIR =
        originalEnvDir;
    } else {
      delete (process.env as Record<string, string | undefined>)
        .SPORTSDESK_AUDIT_DIR;
    }
    if (existsSync(TEST_AUDIT_DIR)) {
      rmSync(TEST_AUDIT_DIR, { recursive: true, force: true });
    }
  });

  it("1. enqueues an alert and persists alert_queued to durable audit log", async () => {
    const deliveryId = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-109281",
      payload: {
        customerId: "GP301",
        event: "Kansas City Chiefs @ Buffalo Bills",
        selection: "Under 47.5",
        amountUsd: 5500,
        clvCents: 14.2,
        directive: "Clamp Max $250",
      },
    });

    expect(typeof deliveryId).toBe("string");
    expect(deliveryId.length).toBeGreaterThan(20);

    const queuedEntries = readAuditEntries({ category: "alert_queued" });
    expect(queuedEntries.length).toBe(1);

    const entry = queuedEntries[0]!;
    expect(entry.target).toBe("W-109281");
    expect(entry.details?.deliveryId).toBe(deliveryId);
    expect(entry.details?.tier).toBe("CRITICAL");

    // Also asserts primary auditWager hook was fired
    const wagerEntries = readAuditEntries({ category: "wager" });
    expect(wagerEntries.length).toBe(1);
    expect(wagerEntries[0]!.target).toBe("GP301");
  });

  it("2. dispatches queued alert and records alert_delivered on success", async () => {
    const deliveryId = await enqueueAlert({
      tier: "STEAM",
      wagerId: "W-109282",
      payload: {
        customerId: "CCC88412",
        event: "Georgia @ Texas",
        amountUsd: 5250,
      },
    });

    let sentAlert: QueuedAlert | null = null;
    const mockSender = async (
      alert: QueuedAlert,
    ): Promise<AlertDeliveryResult> => {
      sentAlert = alert;
      return { ok: true, messageId: 99401 };
    };

    const dispatcher = new AlertDispatcher({
      sender: mockSender,
      rateLimitMs: 0,
    });

    const result = await dispatcher.sweepOnce();
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dead).toBe(0);
    expect(sentAlert).not.toBeNull();
    const finalSent = sentAlert as unknown as QueuedAlert;
    expect(finalSent.deliveryId).toBe(deliveryId);

    const deliveredEntries = readAuditEntries({ category: "alert_delivered" });
    expect(deliveredEntries.length).toBe(1);
    expect(deliveredEntries[0]!.details?.deliveryId).toBe(deliveryId);
    expect(deliveredEntries[0]!.details?.messageId).toBe(99401);
  });

  it("3. handles 429 rate limiting with retry backoff and skips alert during backoff window across 12 sweeps", async () => {
    const deliveryId = await enqueueAlert({
      tier: "LATENCY",
      wagerId: "W-109287",
      payload: { customerId: "KENT99", amountUsd: 2200 },
    });

    let sendCalls = 0;
    const mockSender = async (): Promise<AlertDeliveryResult> => {
      sendCalls++;
      return {
        ok: false,
        error: "rate_limited",
        retryAfterSec: 60, // 60s cooldown requested by Telegram
      };
    };

    const dispatcher = new AlertDispatcher({
      sender: mockSender,
      rateLimitMs: 0,
    });

    // Sweep 1: encounters 429 and records failed attempt 1
    const result = await dispatcher.sweepOnce();
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.dead).toBe(0);
    expect(sendCalls).toBe(1);

    // Sweeps 2 through 12: simulated 5-second ticks within the 60s backoff window
    for (let i = 2; i <= 12; i++) {
      const r = await dispatcher.sweepOnce();
      expect(r.failed).toBe(0);
      expect(r.sent).toBe(0);
      expect(r.dead).toBe(0);
    }

    // Proves that exactly 1 call reached sender during the 60s window (no alert storm, attemptN is strictly 1)
    expect(sendCalls).toBe(1);

    const failedEntries = readAuditEntries({
      category: "alert_delivery_failed",
    });
    expect(failedEntries.length).toBe(1);
    const entry = failedEntries[0]!;
    expect(entry.details?.deliveryId).toBe(deliveryId);
    expect(entry.details?.reason).toBe("rate_limited");
    expect(entry.details?.attemptN).toBe(1);
    expect(entry.details?.nextRetryInSec).toBe(60);
  });

  it("4. dead-letters alert after exceeding maxAttempts (e.g. 3 when configured, or default MAX_ALERT_ATTEMPTS = 5)", async () => {
    // 1. Explicit maxAttempts = 3
    const deliveryId = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEAD-01",
      payload: { customerId: "CHRONIC_FAIL", amountUsd: 10_000 },
    });

    const mockFailingSender = async (): Promise<AlertDeliveryResult> => {
      return { ok: false, error: "telegram_api_unreachable" };
    };

    const dispatcher = new AlertDispatcher({
      sender: mockFailingSender,
      maxAttempts: 3,
      rateLimitMs: 0,
      calculateBackoff: () => 0,
    });

    // Attempt 1 -> Fail
    const r1 = await dispatcher.sweepOnce();
    expect(r1.failed).toBe(1);

    // Attempt 2 -> Fail
    const r2 = await dispatcher.sweepOnce();
    expect(r2.failed).toBe(1);

    // Attempt 3 -> Dead-letter
    const r3 = await dispatcher.sweepOnce();
    expect(r3.dead).toBe(1);

    const deadEntries = readAuditEntries({ category: "alert_dead" });
    expect(deadEntries.length).toBe(1);
    expect(deadEntries[0]!.details?.deliveryId).toBe(deliveryId);
    expect(deadEntries[0]!.details?.afterAttempts).toBe(3);

    // Subsequent sweep ignores dead alert
    const r4 = await dispatcher.sweepOnce();
    expect(r4.sent).toBe(0);
    expect(r4.failed).toBe(0);
    expect(r4.dead).toBe(0);

    // 2. Default MAX_ALERT_ATTEMPTS = 5 (when maxAttempts option is omitted)
    const idDefault = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEAD-DEFAULT-5",
      payload: { customerId: "FAIL_DEFAULT" },
    });

    const defaultDispatcher = new AlertDispatcher({
      sender: mockFailingSender,
      rateLimitMs: 0,
      calculateBackoff: () => 0,
    });

    for (let i = 1; i <= 4; i++) {
      const r = await defaultDispatcher.sweepOnce();
      expect(r.failed).toBe(1);
      expect(r.dead).toBe(0);
    }
    const r5 = await defaultDispatcher.sweepOnce();
    expect(r5.dead).toBe(1);

    const deadEntries2 = readAuditEntries({ category: "alert_dead" });
    const defaultDead = deadEntries2.find(
      (e) =>
        (e.details as Record<string, unknown> | undefined)?.deliveryId ===
        idDefault,
    );
    expect(defaultDead).toBeDefined();
    expect(defaultDead!.details?.afterAttempts).toBe(5);
  });

  it("5. recovers in-flight state across process restarts without dropping or duplicate-sending", async () => {
    // 1. Alert that was queued and delivered before restart
    const d1 = await enqueueAlert({
      tier: "STEAM",
      wagerId: "W-OLD-01",
      payload: { customerId: "USER1" },
    });
    const d1Disp = new AlertDispatcher({
      sender: async () => ({ ok: true, messageId: 101 }),
      rateLimitMs: 0,
    });
    await d1Disp.sweepOnce();

    // 2. Alert that was queued and dead-lettered before restart
    const d2 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEAD-02",
      payload: { customerId: "USER2" },
    });
    const d2Disp = new AlertDispatcher({
      sender: async () => ({ ok: false, error: "permanent_failure" }),
      maxAttempts: 1,
      rateLimitMs: 0,
    });
    await d2Disp.sweepOnce();

    // 3. In-flight alert that was queued but NOT delivered before restart
    const d3 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-PENDING-03",
      payload: { customerId: "USER3", amountUsd: 7500 },
    });

    // Simulate complete process restart: instantiate new dispatcher and recover state
    const recovered = recoverAlertState();
    expect(recovered.delivered.has(d1)).toBe(true);
    expect(recovered.dead.has(d2)).toBe(true);
    expect(recovered.queued.has(d3)).toBe(true);
    expect(recovered.queued.size).toBe(1);

    // Newly spawned dispatcher drains only the pending alert
    let sentId = "";
    const freshDispatcher = new AlertDispatcher({
      sender: async (alert) => {
        sentId = alert.deliveryId;
        return { ok: true, messageId: 202 };
      },
      rateLimitMs: 0,
    });

    const res = await freshDispatcher.sweepOnce();
    expect(res.sent).toBe(1);
    expect(sentId).toBe(d3);

    // After drain, backlog is 0
    const finalState = recoverAlertState();
    expect(finalState.queued.size).toBe(0);
  });

  it("6. enforces chat rate limit (1 msg/sec) and preserves idempotency", async () => {
    const a1 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-RATE-01",
      payload: { customerId: "P1" },
    });
    const _a2 = await enqueueAlert({
      tier: "STEAM",
      wagerId: "W-RATE-02",
      payload: { customerId: "P2" },
    });

    const sentAlerts: string[] = [];
    const mockSender = async (
      alert: QueuedAlert,
    ): Promise<AlertDeliveryResult> => {
      sentAlerts.push(alert.deliveryId);
      return { ok: true, messageId: 1000 + sentAlerts.length };
    };

    // Configure 5000ms rate limit
    const dispatcher = new AlertDispatcher({
      sender: mockSender,
      rateLimitMs: 5000,
    });

    // First sweep sends only the first alert due to 5s rate-limit
    const r1 = await dispatcher.sweepOnce();
    expect(r1.sent).toBe(1);
    expect(sentAlerts).toEqual([a1]);

    // Immediate second sweep respects rate-limit window and sends 0
    const r2 = await dispatcher.sweepOnce();
    expect(r2.sent).toBe(0);
    expect(sentAlerts.length).toBe(1);
  });

  it("formats HTML alert safely without markdown escape fragility", () => {
    const alert: QueuedAlert = {
      deliveryId: "test-uuid-12345",
      tier: "CRITICAL",
      wagerId: "W-9910",
      createdAt: new Date().toISOString(),
      payload: {
        customerId: "GP301 <VIP & Sharp>",
        event: "Chiefs @ Bills",
        selection: "Under 47.5",
        oddsAmerican: "-110",
        amountUsd: 5500,
        clvCents: 14.2,
        directive: "Clamp Max $250",
      },
    };

    const html = formatWagerAlertHtml(alert);
    expect(html).toContain("<b>🚨 SPORTSDESK ALERT: CRITICAL</b>");
    expect(html).toContain("&lt;VIP &amp; Sharp&gt;");
    expect(html).toContain("$5,500.00");
    expect(html).toContain("+14.2¢");
  });

  it("surfaces alert health metrics with correct status degradation", async () => {
    // 1. Initial empty state
    const m1 = getAlertHealthMetrics();
    expect(m1.status).toBe("ok");
    expect(m1.backlog).toBe(0);

    // 2. Queue an alert
    await enqueueAlert({
      tier: "STEAM",
      wagerId: "W-H1",
      payload: { customerId: "C1" },
    });
    const m2 = getAlertHealthMetrics();
    expect(m2.backlog).toBe(1);
    expect(m2.status).toBe("ok");

    // 3. When an alert enters dead-letter state, health degrades to degraded
    const _dId = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEAD-H2",
      payload: { customerId: "C2" },
    });
    const dispatcher = new AlertDispatcher({
      sender: async () => ({ ok: false, error: "fail" }),
      maxAttempts: 1,
      rateLimitMs: 0,
    });
    await dispatcher.sweepOnce();

    const m3 = getAlertHealthMetrics();
    expect(m3.dead).toBeGreaterThanOrEqual(1);
    expect(m3.status).toBe("degraded");
  });

  it("evaluates wagers against TOML policies and enqueues alerts on high risk", async () => {
    // 1. High risk wager -> CRITICAL tier -> enqueues alert & auditWager
    const criticalRes = await processWagerSurveillance({
      ticketId: "W-PROD-01",
      customerId: "GP301",
      riskUsd: 6000,
      clvCents: 15.0,
      selection: "Chiefs -3",
    });

    expect(criticalRes.tier).toBe("CRITICAL");
    expect(criticalRes.enqueued).toBe(true);
    expect(typeof criticalRes.deliveryId).toBe("string");

    const queued = readAuditEntries({ category: "alert_queued" });
    expect(queued.some((e) => e.target === "W-PROD-01")).toBe(true);

    const wAudit = readAuditEntries({ category: "wager" });
    expect(wAudit.some((e) => e.target === "GP301")).toBe(true);

    // 2. Normal recreational wager -> RECREATIONAL tier -> no alert enqueued
    const recRes = await processWagerSurveillance({
      ticketId: "W-PROD-02",
      customerId: "REC_USER",
      riskUsd: 50,
      clvCents: -2.5,
      sharpScore: 2.0,
    });

    expect(recRes.tier).toBe("RECREATIONAL");
    expect(recRes.enqueued).toBe(false);
    expect(recRes.deliveryId).toBeUndefined();

    // 3. High-stake recreational whale wager (e.g. RF2003 with $25k stake, -4.2¢ CLV)
    // Must NOT be falsely escalated to CRITICAL originator alert
    const whaleRes = await processWagerSurveillance({
      ticketId: "W-PROD-03",
      customerId: "RF2003",
      riskUsd: 25000,
      clvCents: -4.2,
      sharpScore: 3.0,
    });

    expect(whaleRes.tier).toBe("RECREATIONAL");
    expect(whaleRes.enqueued).toBe(false);
    expect(whaleRes.deliveryId).toBeUndefined();
  });

  it("sendTelegramAlert posts HTML card to Bot API and parses 200/429 responses", async () => {
    const alert: QueuedAlert = {
      deliveryId: "dlv-mock-99",
      tier: "CRITICAL",
      wagerId: "W-9999",
      createdAt: new Date().toISOString(),
      payload: {
        customerId: "GP301",
        amountUsd: 5000,
        directive: "Clamp $250",
      },
    };

    let postedUrl = "";
    let postedBody: {
      chat_id?: string;
      parse_mode?: string;
      text?: string;
    } | null = null;

    const mockFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      postedUrl = String(url);
      postedBody = JSON.parse(String(init?.body)) as {
        chat_id?: string;
        parse_mode?: string;
        text?: string;
      };
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 88812 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const res = await sendTelegramAlert(alert, {
      botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
      chatId: "-100123456789",
      fetchFn: mockFetch,
    });

    expect(res.ok).toBe(true);
    expect(res.messageId).toBe(88812);
    expect(postedUrl).toContain(
      "/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage",
    );
    expect(postedBody).not.toBeNull();
    const finalBody = postedBody as unknown as {
      chat_id: string;
      parse_mode: string;
      text: string;
    };
    expect(finalBody.chat_id).toBe("-100123456789");
    expect(finalBody.parse_mode).toBe("HTML");
    expect(finalBody.text).toContain("SPORTSDESK ALERT: CRITICAL");

    // 429 Rate limiting handling
    const mockRateLimitFetch = (async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 42",
          parameters: { retry_after: 42 },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const rlRes = await sendTelegramAlert(alert, {
      botToken: "fake_token",
      chatId: "fake_chat",
      fetchFn: mockRateLimitFetch,
    });

    expect(rlRes.ok).toBe(false);
    expect(rlRes.error).toBe("rate_limited");
    expect(rlRes.retryAfterSec).toBe(42);
  });

  it("deduplicates in-flight alert payloads using Bun.deepEquals", async () => {
    // 1. Structural equality verification via isDuplicatePayload
    const p1 = { customerId: "GP301", amountUsd: 5000, clvCents: 12.5 };
    const p2 = { customerId: "GP301", amountUsd: 5000, clvCents: 12.5 };
    const pDiffAmount = {
      customerId: "GP301",
      amountUsd: 6500,
      clvCents: 12.5,
    };
    const pWithUndefined = {
      customerId: "GP301",
      amountUsd: 5000,
      clvCents: 12.5,
      sport: undefined,
    };

    expect(isDuplicatePayload(p1, p2)).toBe(true);
    expect(isDuplicatePayload(p1, pDiffAmount)).toBe(false);
    expect(isDuplicatePayload(p1, pWithUndefined, false)).toBe(true);
    expect(isDuplicatePayload(p1, pWithUndefined, true)).toBe(false); // strict mode

    // 2. Enqueue in-flight alert
    const id1 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEDUPE-01",
      payload: p1,
    });
    expect(typeof id1).toBe("string");

    let queuedEntries = readAuditEntries({ category: "alert_queued" });
    expect(queuedEntries.filter((e) => e.target === "W-DEDUPE-01").length).toBe(
      1,
    );

    // 3. Re-enqueue identical alert -> deduplicated, returns existing deliveryId without writing new audit entry
    const id2 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEDUPE-01",
      payload: p2,
    });
    expect(id2).toBe(id1);

    queuedEntries = readAuditEntries({ category: "alert_queued" });
    expect(queuedEntries.filter((e) => e.target === "W-DEDUPE-01").length).toBe(
      1,
    );

    // 4. Re-enqueue with modified payload -> not deduplicated, creates new alert
    const id3 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-DEDUPE-01",
      payload: pDiffAmount,
    });
    expect(id3).not.toBe(id1);

    queuedEntries = readAuditEntries({ category: "alert_queued" });
    expect(queuedEntries.filter((e) => e.target === "W-DEDUPE-01").length).toBe(
      2,
    );

    // 5. Re-enqueue identical payload with deduplicate: false -> forces new alert
    const id4 = await enqueueAlert(
      {
        tier: "CRITICAL",
        wagerId: "W-DEDUPE-01",
        payload: p2,
      },
      { deduplicate: false },
    );
    expect(id4).not.toBe(id1);
    expect(id4).not.toBe(id3);

    queuedEntries = readAuditEntries({ category: "alert_queued" });
    expect(queuedEntries.filter((e) => e.target === "W-DEDUPE-01").length).toBe(
      3,
    );

    // 6. Surveillance re-evaluation deduplication
    const s1 = await processWagerSurveillance({
      ticketId: "W-DEDUPE-SURV-01",
      customerId: "GP301",
      riskUsd: 7500,
      clvCents: 15.0,
    });
    expect(s1.enqueued).toBe(true);
    expect(s1.deduplicated).toBe(false);

    const s2 = await processWagerSurveillance({
      ticketId: "W-DEDUPE-SURV-01",
      customerId: "GP301",
      riskUsd: 7500,
      clvCents: 15.0,
    });
    expect(s2.enqueued).toBe(false);
    expect(s2.deduplicated).toBe(true);
  });

  it("producer invariant: prevents alert storm when polling already-surveilled wagers", async () => {
    const wager: WagerCandidate = {
      ticketId: "W-STORM-01",
      customerId: "GP301",
      riskUsd: 10_000,
      clvCents: 25.0,
    };
    // First ingest: born and classified -> enqueues alert
    const res1 = await processWagerSurveillance(wager);
    expect(res1.enqueued).toBe(true);
    expect(wager.surveilledAt).toBeDefined();

    // Second poll: already surveilled -> does NOT enqueue or alert
    const res2 = await processWagerSurveillance(wager);
    expect(res2.enqueued).toBe(false);
    expect(res2.deduplicated).toBe(true);

    // Reconnect simulation: brand new object reference without surveilledAt property
    const reconnectWager: WagerCandidate = {
      ticketId: "W-STORM-01",
      customerId: "GP301",
      riskUsd: 10_000,
      clvCents: 25.0,
    };
    const res3 = await processWagerSurveillance(reconnectWager);
    expect(res3.enqueued).toBe(false);
    expect(res3.deduplicated).toBe(true);
  });

  it("acknowledges dead-letter alert and supports DLQ replay with linkage", async () => {
    // 1. Create and dead-letter an alert
    const id = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-OPERATOR-01",
      payload: { customerId: "GP301", amountUsd: 5000 },
    });
    const dispatcher = new AlertDispatcher({
      sender: async () => ({ ok: false, error: "dead" }),
      maxAttempts: 1,
      rateLimitMs: 0,
      calculateBackoff: () => 0,
    });
    await dispatcher.sweepOnce();
    expect(getAlertHealthMetrics().dead).toBe(1);

    // 2. Operator acknowledges alert -> dead status clears
    const ackOk = await acknowledgeAlert({
      deliveryId: id,
      operatorId: "operator_mike",
      notes: "Reviewed risk exposure, investigating conduit",
    });
    expect(ackOk).toBe(true);
    expect(getAlertHealthMetrics().dead).toBe(0);

    // 3. Operator replays from DLQ -> re-enqueued as fresh delivery UUID
    const retryId = await retryAlert({
      deliveryId: id,
      operatorId: "operator_mike",
    });
    expect(typeof retryId).toBe("string");
    expect(retryId).not.toBe(id);

    // Verify retry entry, acknowledgment entry, and retriedFrom linkage in audit log
    const ackEntries = readAuditEntries({ category: "alert_acknowledged" });
    expect(ackEntries.length).toBeGreaterThanOrEqual(1);
    const retryEntries = readAuditEntries({ category: "alert_retried" });
    expect(retryEntries.length).toBe(1);
    expect(retryEntries[0]!.actor?.username).toBe("operator_mike");

    const retriedQueuedEntries = readAuditEntries({ category: "alert_queued" });
    const retriedEntry = retriedQueuedEntries.find(
      (e) =>
        (e.details as Record<string, unknown> | undefined)?.deliveryId ===
        retryId,
    );
    expect(retriedEntry).toBeDefined();
    expect(retriedEntry!.details?.retriedFrom).toBe(id);
  });

  it("generates operator shift summary aggregating alerts, queries and auth across windows", async () => {
    await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-SHIFT-01",
      payload: { customerId: "GP301", amountUsd: 15_000 },
    });

    const summary = getShiftSummary("operator_mike");
    expect(summary.operatorId).toBe("operator_mike");
    expect(typeof summary.totalAlerts).toBe("number");
    expect(summary.totalAlerts).toBeGreaterThanOrEqual(1);
    expect(typeof summary.deliveredAlerts).toBe("number");
    expect(typeof summary.deadLetterAlerts).toBe("number");

    // Supports explicit shift time window (e.g. overnight shift 22:00 -> 06:00)
    const windowSummary = getShiftSummary("operator_mike", {
      from: new Date(Date.now() - 60 * 60 * 1000),
      to: new Date(Date.now() + 60 * 1000),
    });
    expect(windowSummary.operatorId).toBe("operator_mike");
    expect(windowSummary.totalAlerts).toBeGreaterThanOrEqual(1);
  });

  it("lists alerts with full lifecycle status filter (dead, queued, delivered, acknowledged, all)", async () => {
    // 1. Enqueue and deliver id1
    const id1 = await enqueueAlert({
      tier: "CRITICAL",
      wagerId: "W-QUERY-01",
      payload: { customerId: "GP301", amountUsd: 10_000 },
    });
    const dispatcherDeliver = new AlertDispatcher({
      sender: async () => ({ ok: true, messageId: 9901 }),
      rateLimitMs: 0,
    });
    const deliverOutcome = await dispatcherDeliver.sweepOnce();
    expect(deliverOutcome.sent).toBe(1);

    // 2. Enqueue and dead-letter id2
    const id2 = await enqueueAlert({
      tier: "STEAM",
      wagerId: "W-QUERY-02",
      payload: { customerId: "CCC88412", amountUsd: 5_000 },
    });
    const dispatcherDead = new AlertDispatcher({
      sender: async () => ({
        ok: false,
        error: "Telegram API 400: chat not found",
      }),
      maxAttempts: 1,
      rateLimitMs: 0,
      calculateBackoff: () => 0,
    });
    const deadOutcome = await dispatcherDead.sweepOnce();
    expect(deadOutcome.dead).toBe(1);

    // 3. Acknowledge id2
    const ackOk = await acknowledgeAlert({
      deliveryId: id2,
      operatorId: "operator_jane",
      notes: "Investigated chat ID error",
    });
    expect(ackOk).toBe(true);

    // 4. Enqueue id3 (remains queued)
    const id3 = await enqueueAlert({
      tier: "LATENCY",
      wagerId: "W-QUERY-03",
      payload: { customerId: "KENT99", amountUsd: 2_000 },
    });

    // Query 'all'
    const all = listAlerts("all");
    expect(all.length).toBeGreaterThanOrEqual(3);

    // Query 'delivered'
    const delivered = listAlerts("delivered");
    const d1 = delivered.find((a) => a.deliveryId === id1);
    expect(d1).toBeDefined();
    expect(d1!.status).toBe("delivered");
    expect(d1!.messageId).toBe(9901);

    // Query 'acknowledged'
    const acked = listAlerts("acknowledged");
    const a2 = acked.find((a) => a.deliveryId === id2);
    expect(a2).toBeDefined();
    expect(a2!.status).toBe("acknowledged");
    expect(a2!.acknowledgedBy).toBe("operator_jane");
    expect(a2!.acknowledgedNotes).toBe("Investigated chat ID error");

    // Query 'queued'
    const queued = listAlerts("queued");
    const q3 = queued.find((a) => a.deliveryId === id3);
    expect(q3).toBeDefined();
    expect(q3!.status).toBe("queued");
  });
});
