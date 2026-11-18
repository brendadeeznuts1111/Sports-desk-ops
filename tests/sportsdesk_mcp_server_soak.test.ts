import { afterEach, expect, test } from "bun:test";

import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * Deliberately slow keepalive soak, kept in its own file so it does not pin the wall time of
 * `tests/sportsdesk_mcp_server.test.ts` (and therefore of every full-suite run):
 * it must outlive Bun's 10s default socket idleTimeout while the production 8s SSE keepalive
 * keeps a mounted GET /mcp stream open, so it cannot complete in under ~12.6s.
 *
 * Same file, same worker model: Bun parallelises per file, so this soak overlaps the rest of
 * the suite instead of extending it. The assertions are unchanged from the original test.
 */

const TEST_ADMIN_TOKEN = "mcp-unit-test-bearer-secret-4020";

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const fn = cleanupTasks.pop();
    if (fn) {
      await fn();
    }
  }
});

test("mounted :4020 GET /mcp SSE keepalive survives >12.5s past Bun.serve default socket idleTimeout", async () => {
  const server = startServer({
    port: 0,
    mcpAuthToken: TEST_ADMIN_TOKEN,
  });
  cleanupTasks.push(() => {
    server.stop(true);
  });

  const mcpUrl = new URL("/mcp", `http://127.0.0.1:${server.port}`);
  const initRes = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "idle-soak-client", version: "1.0.0" },
      },
    }),
  });
  expect(initRes.status).toBe(200);
  await initRes.text();
  const sessionId = initRes.headers.get("mcp-session-id")!;

  const abortCtrl = new AbortController();
  const sseRes = await fetch(mcpUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TEST_ADMIN_TOKEN}`,
      Accept: "text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    signal: abortCtrl.signal,
  });
  expect(sseRes.status).toBe(200);

  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  let keepAliveCount = 0;
  const soakDeadline = Date.now() + 12_600;
  while (Date.now() < soakDeadline) {
    const remainingMs = Math.max(100, soakDeadline - Date.now());
    const readResult = await Promise.race([
      reader.read(),
      Bun.sleep(remainingMs).then(() => "timeout" as const),
    ]);
    if (readResult === "timeout") break;
    expect(readResult.done).toBe(false);
    if (decoder.decode(readResult.value).includes(": keepalive")) {
      keepAliveCount += 1;
    }
  }
  // Initial flush (: keepalive) at ~0s + first 8s interval tick (: keepalive) >= 2 frames, zero ECONNRESET
  expect(keepAliveCount).toBeGreaterThanOrEqual(2);
  reader.releaseLock();
  abortCtrl.abort();
}, 20_000);
