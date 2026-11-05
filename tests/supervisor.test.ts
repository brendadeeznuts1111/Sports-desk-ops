import { describe, expect, test } from "bun:test";

import {
  checkHealth,
  restartDelayMs,
  supervise,
  supervisedServices,
  supervisedServicesAsync,
} from "../services/supervisor.ts";
import { resolveBunServePort } from "../lib/bun_serve_port.ts";

describe("service supervisor", () => {
  test("supervises the blob gateway only when its credentials exist", () => {
    const without = supervisedServices({ PORT: "4100" });
    expect(without.map((service) => service.name)).toEqual(["webview"]);
    expect(without[0]?.healthUrl).toBe("http://127.0.0.1:4100/health");

    const withBlob = supervisedServices({
      PORT: "4100",
      BLOB_PORT: "4101",
      BLOB_API_TOKEN: "token",
      BLOB_TICKET_SECRET: "secret",
    });
    expect(withBlob.map((service) => service.name)).toEqual([
      "webview",
      "blob-live-bets",
    ]);
    expect(withBlob[1]?.healthUrl).toBe("http://127.0.0.1:4101/health");
    expect(withBlob[1]?.command).toEqual([
      "bun",
      "run",
      "services/blob_and_live_bets_server.ts",
    ]);
  });

  test("mirrors Bun.serve's port cascade for the webview health URL", () => {
    // Bun reads BUN_PORT before PORT and NODE_PORT; the supervisor must probe the same port
    // the child will actually bind.
    expect(
      supervisedServices({ BUN_PORT: "4100", PORT: "4200" })[0]?.healthUrl,
    ).toBe("http://127.0.0.1:4100/health");
    expect(
      supervisedServices({ PORT: "4200", NODE_PORT: "4300" })[0]?.healthUrl,
    ).toBe("http://127.0.0.1:4200/health");
    expect(supervisedServices({ NODE_PORT: "4300" })[0]?.healthUrl).toBe(
      "http://127.0.0.1:4300/health",
    );
    expect(supervisedServices({})[0]?.healthUrl).toBe(
      "http://127.0.0.1:3000/health",
    );
  });

  test("skips empty or invalid port variables", () => {
    expect(resolveBunServePort({ BUN_PORT: "nope", PORT: "4200" })).toBe(4200);
    expect(resolveBunServePort({ BUN_PORT: "0", PORT: "4200" })).toBe(4200);
    expect(
      resolveBunServePort({ BUN_PORT: "", PORT: "  ", NODE_PORT: "4300" }),
    ).toBe(4300);
    expect(resolveBunServePort({})).toBe(3000);
  });

  test("resolves BLOB tokens from Bun.secrets without env leakage", async () => {
    const environment = { PORT: "4100" };
    const secrets = {
      async get({ service, name }: { service: string; name: string }) {
        if (service !== "com.bookdeskops.sportsdesk") return null;
        if (name === "BLOB_API_TOKEN") return "secret-token";
        if (name === "BLOB_TICKET_SECRET") return "secret-ticket";
        return null;
      },
    };
    const services = await supervisedServicesAsync(environment, secrets);
    expect(services.map((service) => service.name)).toEqual([
      "webview",
      "blob-live-bets",
    ]);
    expect(environment).toEqual({ PORT: "4100" });
    expect("BLOB_API_TOKEN" in environment).toBe(false);
  });

  test("health URL overrides win", () => {
    const services = supervisedServices({
      BLOB_API_TOKEN: "token",
      BLOB_TICKET_SECRET: "secret",
      BLOB_HEALTH_URL: "http://127.0.0.1:9999/healthz",
      WEBVIEW_HEALTH_URL: "http://127.0.0.1:9998/healthz",
    });
    expect(services[0]?.healthUrl).toBe("http://127.0.0.1:9998/healthz");
    expect(services[1]?.healthUrl).toBe("http://127.0.0.1:9999/healthz");
  });

  test("restart backoff is capped exponential", () => {
    expect(restartDelayMs(0)).toBe(1_000);
    expect(restartDelayMs(1)).toBe(2_000);
    expect(restartDelayMs(3)).toBe(8_000);
    expect(restartDelayMs(10)).toBe(30_000);
    expect(restartDelayMs(-1)).toBe(1_000);
  });

  test("checkHealth maps ok, non-2xx and thrown fetches to a boolean", async () => {
    const ok = await checkHealth("http://example.test/health", {
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    expect(ok).toBe(true);
    const notOk = await checkHealth("http://example.test/health", {
      fetchImpl: async () => new Response("no", { status: 503 }),
    });
    expect(notOk).toBe(false);
    const thrown = await checkHealth("http://example.test/health", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(thrown).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for supervisor event");
}

describe("supervisor child restarts", () => {
  test("three health failures kill and restart a real child, then abort stops it", async () => {
    const events: Record<string, unknown>[] = [];
    const controller = new AbortController();
    const running = supervise({
      services: [
        {
          name: "mock",
          command: ["bun", "run", "tests/fixtures/supervisor_mock_child.ts"],
          healthUrl: "http://mock.invalid/health",
        },
      ],
      healthIntervalMs: 15,
      unhealthyThreshold: 3,
      fetchImpl: async () => new Response("down", { status: 503 }),
      sleep: async () => {},
      log: (event) => events.push(event),
      signal: controller.signal,
    });

    await waitFor(() => events.some((event) => event.event === "restart"));
    const starts = events.filter(
      (event) => event.event === "start" || event.event === "restart",
    );
    const pids = starts.map((event) => Number(event.pid));
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(pids).size).toBeGreaterThanOrEqual(2);
    expect(
      events.filter((event) => event.event === "restart-unhealthy").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      events.filter((event) => event.event === "unhealthy").length,
    ).toBeGreaterThanOrEqual(3);
    expect(isAlive(pids[0] ?? 0)).toBe(false);

    controller.abort();
    await running;
    await waitFor(() => !isAlive(pids[pids.length - 1] ?? 0), 2000);
    expect(events.some((event) => event.event === "shutdown")).toBe(true);
  });
});
