import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BRIDGE_WS_TOPICS,
  getBridgeRelayStatus,
  startServer,
} from "../services/sportsdesk_webview_server.ts";

/**
 * The graph dashboard's data plane, as the page consumes it.
 *
 * `/api/graph/summary` is the only source of the dashboard's numbers; `/api/graph/stream` is the
 * same body over SSE. The assertions here are the contract-level ones: the envelope shape, the
 * no-store/`Vary: Authorization` cache policy, a parseable first `event: summary` frame, and —
 * the one a leaked interval would break — the server still answering `/health` after the client
 * aborts the stream.
 */

interface SummaryBody {
  success?: unknown;
  schemaVersion?: unknown;
  generatedAt?: unknown;
  feed?: { status?: unknown; counts?: unknown };
  repo?: {
    head?: unknown;
    branch?: unknown;
    routes?: { served?: unknown; catalog?: unknown };
    citations?: { status?: unknown };
    checks?: Record<string, { status?: unknown }>;
  };
  bridges?: Array<{ id?: unknown; state?: unknown }>;
  status?: { ok?: boolean; runtime?: string };
  automation?: {
    wsRelay?: {
      status?: unknown;
      started?: unknown;
      lastFrameAtIso?: unknown;
      lastFrameAgeSeconds?: unknown;
      topics?: unknown;
      gatewayHost?: unknown;
    };
    cron?: {
      engine?: unknown;
      total?: unknown;
      enabled?: unknown;
      schedules?: unknown;
    };
    telegram?: {
      mode?: unknown;
      modeReason?: unknown;
      tokenConfigured?: unknown;
      defaultChatConfigured?: unknown;
      authorizedChatCount?: unknown;
      inbound?: unknown;
      bot?: unknown;
      webhook?: unknown;
      error?: unknown;
    };
  };
}

/** Key names anywhere in a JSON tree; used to prove no token/secret field survived. */
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keysOf(child, out);
    }
  }
  return out;
}

describe("graph summary API", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("GET /api/graph/summary serves the contract envelope", async () => {
    const res = await fetch(`${server.url}api/graph/summary`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Authorization");

    const raw = await res.text();
    expect(raw).not.toContain("NaN");
    const body = JSON.parse(raw) as SummaryBody;
    expect(body.success).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.generatedAt).toBeString();
    expect(body.feed).toBeDefined();
    expect(body.repo).toBeDefined();
    expect(Array.isArray(body.bridges)).toBe(true);

    expect(body.repo?.checks).toBeDefined();
    for (const key of ["routeSurface", "tests", "typecheck", "docs"]) {
      expect(body.repo?.checks?.[key]?.status).toBeString();
    }
    // The routes section is derived from the compiled table, so it is always measurable and its
    // `served` count must match the catalog length it ships.
    const routes = body.repo?.routes;
    const served = routes?.served;
    if (typeof served !== "number") {
      throw new Error(`routes.served must be a number, got ${String(served)}`);
    }
    const catalog = Array.isArray(routes?.catalog) ? routes.catalog : [];
    expect(catalog.length).toBe(served);

    const ids = (body.bridges ?? []).map((bridge) => bridge.id);
    expect(ids).toEqual([
      "bridge-1",
      "bridge-3a",
      "bridge-3b",
      "bridge-3c",
      "weblog",
    ]);
    for (const bridge of body.bridges ?? []) {
      expect(typeof bridge.state).toBe("string");
      expect(["measured", "not_measured"]).toContain(String(bridge.state));
    }

    expect(body.status?.ok).toBeBoolean();
    expect(body.status?.runtime).toContain("Bun v");
  });

  test("summary carries the automation section with the contract shape", async () => {
    const res = await fetch(`${server.url}api/graph/summary`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as SummaryBody;

    const automation = body.automation;
    expect(automation).toBeDefined();
    if (automation === undefined) return;

    // WebSocket relay: host only, and the topic list is the server's own constant.
    const relay = automation.wsRelay;
    expect(relay).toBeDefined();
    expect(["connected", "disconnected", "no_token", "unavailable"]).toContain(
      String(relay?.status),
    );
    expect(typeof relay?.started).toBe("boolean");
    expect(
      relay?.lastFrameAtIso === null ||
        typeof relay?.lastFrameAtIso === "string",
    ).toBe(true);
    expect(
      relay?.lastFrameAgeSeconds === null ||
        Number.isFinite(relay?.lastFrameAgeSeconds),
    ).toBe(true);
    expect(relay?.topics).toEqual([...BRIDGE_WS_TOPICS]);
    expect(
      relay?.gatewayHost === null || typeof relay?.gatewayHost === "string",
    ).toBe(true);
    expect(JSON.stringify(relay)).not.toContain("ticket");

    // Cron: schedules are reduced to the safe fields only.
    const cron = automation.cron;
    expect(cron?.engine).toBeString();
    expect(cron?.total).toBeNumber();
    expect(cron?.enabled).toBeNumber();
    const schedules = Array.isArray(cron?.schedules) ? cron.schedules : [];
    const cronTotal = cron?.total;
    if (typeof cronTotal !== "number") {
      throw new Error(
        `automation.cron.total must be a number, got ${String(cronTotal)}`,
      );
    }
    expect(schedules.length).toBe(cronTotal);
    for (const schedule of schedules) {
      expect(schedule).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        scheduleTime: expect.any(String),
        enabled: expect.any(Boolean),
      });
    }

    // Telegram: a configured mode or null; never a fabricated "simulation".
    const telegram = automation.telegram;
    expect(
      telegram?.mode === null ||
        telegram?.mode === "simulation" ||
        telegram?.mode === "live",
    ).toBe(true);
    expect(typeof telegram?.tokenConfigured).toBe("boolean");
    expect(typeof telegram?.defaultChatConfigured).toBe("boolean");
    expect(telegram?.inbound).toBeString();
    expect(
      telegram?.authorizedChatCount === null ||
        Number.isFinite(telegram?.authorizedChatCount),
    ).toBe(true);
    // `bot`/`webhook` are never forwarded: the webhook URL embeds the bearer secret.
    expect(telegram?.bot).toBeNull();
    expect(telegram?.webhook).toBeNull();
    expect(
      telegram?.error === null || typeof telegram?.error === "string",
    ).toBe(true);

    // No token/secret field by construction, and no secret value in the bytes.
    for (const key of keysOf(automation)) {
      const lower = key.toLowerCase();
      if (lower === "tokenconfigured" || lower === "defaultchatconfigured") {
        continue;
      }
      expect(lower.includes("secret")).toBe(false);
      expect(lower === "token").toBe(false);
    }
    expect(raw).not.toMatch(/\bBearer\s+/i);
    expect(raw).not.toMatch(/\bticket=/);
    expect(raw).not.toMatch(/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/);
    for (const name of [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "BLOB_API_TOKEN",
      "SPORTSDESK_ADMIN_TOKEN",
    ]) {
      const value = Bun.env[name]?.trim() ?? "";
      if (value.length > 0) expect(raw).not.toContain(value);
    }
  });

  test("bridge relay helper reports host-only state", async () => {
    const relay = await getBridgeRelayStatus();
    expect(["connected", "disconnected", "no_token", "unavailable"]).toContain(
      relay.status,
    );
    expect(relay.topics).toEqual([...BRIDGE_WS_TOPICS]);
    expect(
      relay.gatewayHost === null || typeof relay.gatewayHost === "string",
    ).toBe(true);
    const serialized = JSON.stringify(relay);
    expect(serialized).not.toContain("ticket");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("?");
  });

  test("the summary is a snapshot, so a second call is not a cached 304", async () => {
    const res = await fetch(`${server.url}api/graph/summary`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });

  test("SSE: first frame is a summary, and abort leaves the server serving", async () => {
    const controller = new AbortController();
    const res = await fetch(`${server.url}api/graph/stream`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("vary")).toContain("Authorization");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return;

    const decoder = new TextDecoder();
    let buffer = "";
    let frame: string | null = null;
    try {
      while (frame === null) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const match = /event: summary\ndata: (.*)\n\n/.exec(buffer);
        if (match !== null) frame = match[0];
      }
    } finally {
      controller.abort();
    }

    expect(frame).not.toBeNull();
    const dataLine = /^event: summary\ndata: (.*)\n\n$/s.exec(frame ?? "")?.[1];
    expect(dataLine).toBeString();
    const payload = JSON.parse(dataLine ?? "{}") as SummaryBody;
    expect(payload.success).toBe(true);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.repo).toBeDefined();
    expect(payload.automation).toBeDefined();
    expect(payload.automation?.wsRelay?.topics).toEqual([...BRIDGE_WS_TOPICS]);
    expect(JSON.stringify(payload)).not.toContain("NaN");

    // The abort must clear the 5s interval. If it leaked, `stop(true)` / the runner would hang
    // and the process would keep a timer; the health check proves the socket is still usable.
    await Bun.sleep(100);
    const health = await fetch(`${server.url}health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { status?: unknown };
    expect(["healthy", "degraded"]).toContain(healthBody.status as string);
  });
});
