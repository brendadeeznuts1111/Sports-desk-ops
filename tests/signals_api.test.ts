import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";
import { kalshiFixtureFetch } from "./fixtures/kalshi/fixture_fetch.ts";

/**
 * The two v3 routes, offline.
 *
 * `/api/signals/kalshi` gets a fixture-backed Kalshi transport through `ServerOptions`, so the
 * join exercises captured public responses without a network call. The assertions that matter:
 * the envelope and telemetry shape, one real matched market with liquidity, one honest
 * `no_market`, the guard/caching headers, and that no credential/order field can appear in a
 * response that carries watchlist logins.
 */

interface SignalBody {
  success?: unknown;
  schemaVersion?: unknown;
  generatedAt?: unknown;
  config?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  kalshi?: {
    ok?: unknown;
    degraded?: unknown;
    requests?: unknown;
    cacheHits?: unknown;
    errors?: unknown;
  };
  signals?: Array<{
    id?: string;
    league?: string;
    distinctAccounts?: number;
    riskUsd?: number;
    kalshi?: {
      verdict?: string;
      reason?: string | null;
      marketTicker?: string | null;
      side?: string | null;
      executablePrice?: number | null;
      edgeBps?: number | null;
      liquidity?: {
        verdict?: string;
        topSize?: number;
        spreadCents?: number | null;
      } | null;
    };
  }>;
}

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

describe("v3 signal routes", () => {
  let server: ReturnType<typeof startServer>;
  const fixture = kalshiFixtureFetch();

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      kalshiFetch: fixture.fetch,
      kalshiNow: () => 1_790_000_000_000,
      kalshiEnv: {},
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test("GET /api/signals/kalshi is a no-store, guarded envelope", async () => {
    const res = await fetch(`${server.url}api/signals/kalshi`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Authorization");

    const raw = await res.text();
    const body = JSON.parse(raw) as SignalBody;
    expect(body.success).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.generatedAt).toBeString();
    expect(body.config).toMatchObject({
      minEdgeBps: 300,
      minContracts: 50,
      maxSpreadCents: 6,
      referenceNotionalUsd: 1_000,
    });
    expect(body.provenance).toBeDefined();
    expect(body.kalshi?.ok).toBe(true);
    expect(body.kalshi?.degraded).toBe(false);
    expect(body.kalshi?.requests).toBeNumber();
    expect(body.kalshi?.cacheHits).toBeNumber();
    expect(body.kalshi?.errors).toEqual([]);
    expect(Array.isArray(body.signals)).toBe(true);

    // A matched market with a real order book and a fixture-capped verdict.
    const matched = (body.signals ?? []).find(
      (signal) =>
        signal.kalshi?.marketTicker === "KXNBA4QSPREAD-26NOV04MILBOS-MIL2",
    );
    expect(matched).toBeDefined();
    expect(matched?.kalshi?.side).toBe("NO");
    expect(matched?.kalshi?.liquidity).toBeDefined();
    expect(matched?.kalshi?.liquidity?.topSize).toBeNumber();
    expect(["ok", "thin", "wide", "empty"]).toContain(
      String(matched?.kalshi?.liquidity?.verdict),
    );
    expect(matched?.kalshi?.verdict).toBe("fixture_only");
    expect(matched?.kalshi?.reason).toBe("source row is a fixture");

    // At least one signal honestly has no market, with a reason rather than a price.
    const noMarket = (body.signals ?? []).find(
      (signal) => signal.kalshi?.verdict === "no_market",
    );
    expect(noMarket).toBeDefined();
    expect(noMarket?.kalshi?.reason).toBeString();
    expect(noMarket?.kalshi?.executablePrice).toBeNull();

    // No credential field and no order/portfolio vocabulary: the response carries logins, so a
    // leaked token or an order endpoint would be the worst failure mode of this route.
    for (const key of keysOf(body)) {
      const lower = key.toLowerCase();
      expect(lower.includes("secret")).toBe(false);
      expect(
        lower === "token" || lower === "apikey" || lower === "api_key",
      ).toBe(false);
      expect(lower === "orderid" || lower === "orders").toBe(false);
    }
    expect(raw).not.toMatch(/\bBearer\s+/i);
    expect(raw).not.toContain("api_key");
    expect(raw).not.toContain("KALSHI_API_KEY");
    expect(raw).not.toContain("authorization");
    for (const name of [
      "KALSHI_API_KEY",
      "BLOB_API_TOKEN",
      "SPORTSDESK_ADMIN_TOKEN",
    ]) {
      const value = Bun.env[name]?.trim() ?? "";
      if (value.length > 0) expect(raw).not.toContain(value);
    }
  });

  test("GET /api/gslive/weblogs is measured-or-not_measured, never zero-filled", async () => {
    const res = await fetch(`${server.url}api/gslive/weblogs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toContain("Authorization");
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      success?: unknown;
      schemaVersion?: unknown;
      generatedAt?: unknown;
      status?: unknown;
      source?: unknown;
      asOf?: unknown;
      ageSeconds?: unknown;
      stale?: unknown;
      accounts?: unknown;
      summary?: unknown;
      reason?: unknown;
      command?: unknown;
    };
    expect(body.success).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.generatedAt).toBeString();
    expect(["measured", "not_measured"]).toContain(String(body.status));
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.summary).toBeDefined();
    expect(typeof body.stale).toBe("boolean");
    if (body.status === "not_measured") {
      // The local checkout currently has no audit artifact; that is a stated gap, not zeros.
      expect(body.reason).toBeString();
      expect(body.command).toBe("bun run gslive:weblogs:refresh");
      expect(body.ageSeconds).toBeNull();
    } else {
      expect(body.asOf).toBeString();
      expect(body.source).toBeString();
    }
    expect(raw).not.toMatch(/\bBearer\s+/i);
  });
});
