import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SportsDeskTelegramService } from "../services/sportsdesk_telegram_bot.ts";

describe("Outbound Fetch Timeout Hardening (AbortSignal.timeout)", () => {
  let slowServer: ReturnType<typeof Bun.serve>;
  let fastServer: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    slowServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        // Artificially delay response to simulate slow upstream API
        await Bun.sleep(250);
        return Response.json({ status: "delayed" });
      },
    });

    fastServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return Response.json({ status: "immediate" });
      },
    });
  });

  afterAll(() => {
    slowServer.stop(true);
    fastServer.stop(true);
  });

  test("test_outbound_fetch_aborts_on_slow_upstream_timeout", async () => {
    const startedAt = performance.now();
    let hasTimedOut = false;

    try {
      await fetch(`http://127.0.0.1:${slowServer.port}/api`, {
        signal: AbortSignal.timeout(50),
      });
    } catch (caughtError) {
      hasTimedOut = true;
      expect(caughtError).toHaveProperty(
        "name",
        expect.stringMatching(/TimeoutError|AbortError/),
      );
    }

    const elapsedMs = performance.now() - startedAt;
    expect(hasTimedOut).toBe(true);
    expect(elapsedMs).toBeLessThan(200); // Must abort well before the 250ms sleep
  });

  test("test_outbound_fetch_succeeds_when_upstream_responds_within_timeout", async () => {
    const response = await fetch(`http://127.0.0.1:${fastServer.port}/api`, {
      signal: AbortSignal.timeout(1000),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("status", "immediate");
  });

  test("test_telegram_service_sendMessage_handles_offline_and_timeout_parameters", async () => {
    const service = new SportsDeskTelegramService({ botToken: "" });
    const result = await service.sendMessage("TEST_CHAT", "<b>Test alert</b>", {
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    expect(result.message_id).toBeDefined();
  });
});
