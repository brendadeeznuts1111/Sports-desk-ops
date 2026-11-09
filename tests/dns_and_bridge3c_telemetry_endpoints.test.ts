import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("Operational Telemetry Endpoints (/api/dns/telemetry & /api/bridge3c/status)", () => {
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeAll(() => {
    server = startServer({ port: 0, hostname: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  describe("GET /api/dns/telemetry", () => {
    test("returns Bun native DNS cache telemetry and core hosts", async () => {
      const res = await fetch(`${baseUrl}/api/dns/telemetry`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");

      const body = (await res.json()) as {
        success: boolean;
        telemetry: {
          cacheHitsCompleted: number;
          cacheHitsInflight: number;
          cacheMisses: number;
          size: number;
          errors: number;
          totalCount: number;
          hitRatePercent: number;
          defaultTtlSeconds: number;
        };
        coreHosts: Array<{
          hostname: string;
          port: number;
          serviceName: string;
        }>;
        generatedAt: string;
      };

      expect(body.success).toBe(true);
      expect(body.telemetry).toBeDefined();
      expect(body.telemetry.size).toBeGreaterThanOrEqual(0);
      expect(body.telemetry.totalCount).toBeGreaterThanOrEqual(0);
      expect(body.telemetry.hitRatePercent).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(body.coreHosts)).toBe(true);
      expect(body.coreHosts.length).toBeGreaterThan(0);
      expect(body.generatedAt).toBeDefined();
    });

    test("rejects unsupported HTTP methods with 404 or 405", async () => {
      const res = await fetch(`${baseUrl}/api/dns/telemetry`, {
        method: "POST",
      });
      expect([404, 405]).toContain(res.status);
    });
  });

  describe("GET /api/bridge3c/status", () => {
    test("returns GSLive Bridge 3c gap-halt boundary and telemetry status", async () => {
      const res = await fetch(`${baseUrl}/api/bridge3c/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");

      const body = (await res.json()) as {
        success: boolean;
        boundary: string;
        readOnly: boolean;
        endpoint: string;
        userAgent: string;
        rollup: unknown;
        generatedAt: string;
      };

      expect(body.success).toBe(true);
      expect(body.boundary).toBe("CLASS_D_GSLIVE_GAP_HALT");
      expect(body.readOnly).toBe(true);
      expect(body.endpoint).toContain("https://");
      expect(body.userAgent).toContain("Mozilla/5.0");
      expect(body.rollup).toBeDefined();
      expect(body.generatedAt).toBeDefined();
    });

    test("rejects unsupported HTTP methods with 404 or 405", async () => {
      const res = await fetch(`${baseUrl}/api/bridge3c/status`, {
        method: "POST",
      });
      expect([404, 405]).toContain(res.status);
    });
  });
});
