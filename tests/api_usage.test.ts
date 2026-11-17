import { beforeEach, describe, expect, test } from "bun:test";
import {
  apiUsageKey,
  beginApiCall,
  endApiCall,
  getApiUsageSnapshot,
  resetApiUsage,
  subscribeApiUsage,
  trackedFetch,
} from "../packages/ui/src/api_usage.ts";

describe("api_usage · key normalization", () => {
  test("drops query strings and collapses ids/logins", () => {
    expect(apiUsageKey("/api/kpis?window=24", "GET")).toBe("GET /api/kpis");
    expect(apiUsageKey("http://127.0.0.1:4022/api/agent/GP301")).toBe(
      "GET /api/agent/:id",
    );
    expect(
      apiUsageKey(
        "/api/alerts/3f2b8c1e-9d4a-4e6b-8f7a-0c1d2e3f4a5b/ack",
        "post",
      ),
    ).toBe("POST /api/alerts/:id/ack");
    expect(apiUsageKey("/api/live-wagers/769158444", "GET")).toBe(
      "GET /api/live-wagers/:id",
    );
    expect(apiUsageKey("/", "GET")).toBe("GET /");
  });

  test("reads the method from a Request when init is absent", () => {
    const request = new Request("http://localhost/api/kpis", {
      method: "POST",
    });
    expect(apiUsageKey(request)).toBe("POST /api/kpis");
  });
});

describe("api_usage · session meter", () => {
  beforeEach(() => resetApiUsage());

  test("records outcomes, pending calls and average latency", () => {
    const a = beginApiCall("GET /api/kpis");
    const b = beginApiCall("GET /api/kpis");
    expect(getApiUsageSnapshot().pending).toBe(2);
    endApiCall(a, 200);
    endApiCall(b, 503);
    const snapshot = getApiUsageSnapshot();
    expect(snapshot.calls).toBe(2);
    expect(snapshot.ok).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.pending).toBe(0);
    expect(snapshot.rows[0]?.key).toBe("GET /api/kpis");
    expect(snapshot.rows[0]?.avgMs).not.toBeNull();
  });

  test("returns a stable snapshot between records", () => {
    endApiCall(beginApiCall("GET /api/kpis"), 200);
    const first = getApiUsageSnapshot();
    expect(getApiUsageSnapshot()).toBe(first);
    endApiCall(beginApiCall("GET /api/kpis"), 200);
    expect(getApiUsageSnapshot()).not.toBe(first);
  });

  test("notifies subscribers and reset clears rows", () => {
    let notifications = 0;
    const unsubscribe = subscribeApiUsage(() => {
      notifications += 1;
    });
    endApiCall(beginApiCall("GET /api/kpis"), 200);
    expect(notifications).toBe(2); // begin + end
    expect(getApiUsageSnapshot().rows).toHaveLength(1);
    resetApiUsage();
    expect(getApiUsageSnapshot().rows).toHaveLength(0);
    expect(notifications).toBe(3);
    unsubscribe();
  });
});

describe("api_usage · trackedFetch", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => resetApiUsage());

  test("records a successful response without altering it", async () => {
    globalThis.fetch = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch;
    try {
      const response = await trackedFetch("/api/kpis?window=24");
      expect(response.status).toBe(200);
      const snapshot = getApiUsageSnapshot();
      expect(snapshot.rows[0]?.key).toBe("GET /api/kpis");
      expect(snapshot.rows[0]?.ok).toBe(1);
      expect(snapshot.rows[0]?.lastStatus).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("coalesces concurrent identical plain GETs into one network call", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await Bun.sleep(25);
      return new Response("shared-body", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const [a, b] = await Promise.all([
        trackedFetch("/api/kpis?window=24"),
        trackedFetch("/api/kpis?window=24"),
      ]);
      expect(fetchCalls).toBe(1);
      expect(await a.text()).toBe("shared-body");
      expect(await b.text()).toBe("shared-body");
      const snapshot = getApiUsageSnapshot();
      expect(snapshot.calls).toBe(2);
      expect(snapshot.coalesced).toBe(1);
      expect(snapshot.rows[0]?.key).toBe("GET /api/kpis");
      expect(snapshot.rows[0]?.coalesced).toBe(1);
      expect(snapshot.rows[0]?.pending).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not coalesce different queries or a non-GET", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await Bun.sleep(10);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await Promise.all([
        trackedFetch("/api/kpis?window=1"),
        trackedFetch("/api/kpis?window=2"),
        trackedFetch("/api/kpis", { method: "POST" }),
      ]);
      expect(fetchCalls).toBe(3);
      expect(getApiUsageSnapshot().coalesced).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not coalesce a GET that carries caller options", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      await Bun.sleep(10);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await Promise.all([
        trackedFetch("/api/kpis", { headers: { "x-test": "1" } }),
        trackedFetch("/api/kpis", { headers: { "x-test": "1" } }),
      ]);
      expect(fetchCalls).toBe(2);
      expect(getApiUsageSnapshot().coalesced).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a sequential GET after settle is a new network call", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await trackedFetch("/api/kpis");
      await trackedFetch("/api/kpis");
      expect(fetchCalls).toBe(2);
      expect(getApiUsageSnapshot().coalesced).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("records a transport failure and rethrows", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      await expect(trackedFetch("/api/live-wagers")).rejects.toThrow(
        "network down",
      );
      const snapshot = getApiUsageSnapshot();
      expect(snapshot.rows[0]?.key).toBe("GET /api/live-wagers");
      expect(snapshot.rows[0]?.failed).toBe(1);
      expect(snapshot.rows[0]?.lastStatus).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
