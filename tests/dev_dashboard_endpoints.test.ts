import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";

describe("Dev Dashboard Endpoints (scripts/dev_dashboard.ts)", () => {
  let proc: Subprocess;
  const PORT = 4055;
  const baseUrl = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    proc = Bun.spawn(["bun", "run", "scripts/dev_dashboard.ts"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        SPORTSDESK_AUTH_DISABLED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 6000) {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!ready) {
      proc.kill();
      throw new Error("Dev dashboard failed to start within timeout");
    }
  });

  afterAll(() => {
    proc.kill();
  });

  describe("DNS Telemetry Endpoints", () => {
    it("answers GET /api/dns with telemetry and core hosts", async () => {
      const res = await fetch(`${baseUrl}/api/dns`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(data.telemetry).toBeDefined();
      expect(Array.isArray(data.hosts)).toBe(true);
      expect(Array.isArray(data.coreHosts)).toBe(true);
    });

    it("answers canonical GET /api/dns/telemetry with identical payload", async () => {
      const res = await fetch(`${baseUrl}/api/dns/telemetry`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(data.telemetry).toBeDefined();
      expect(Array.isArray(data.coreHosts)).toBe(true);
    });
  });

  describe("Customer Profiling & Rating Endpoints", () => {
    it("derives dynamic cohort counts on GET /api/customers without static hardcoding", async () => {
      const res = await fetch(`${baseUrl}/api/customers`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        cohorts: {
          backtestCount: number;
          keyNumberSharpsCount: number;
          hookSyndicateCount: number;
          fixtureCount: number;
          fullBookSpecCount: number;
          uniqueSurveillanceCount: number;
        };
      };
      expect(data.cohorts.keyNumberSharpsCount).toBeGreaterThan(0);
      expect(data.cohorts.hookSyndicateCount).toBeGreaterThan(0);
      expect(data.cohorts.fixtureCount).toBeGreaterThan(0);
      expect(data.cohorts.uniqueSurveillanceCount).toBeGreaterThan(0);
    });

    it("serves comprehensive customer profile on GET /api/customer/profile?id=SYNTH_SYN_01", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/profile?id=SYNTH_SYN_01`,
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        profile: { customerId: string };
      };
      expect(data.success).toBe(true);
      expect(data.profile.customerId).toBe("SYNTH_SYN_01");
    });

    it("serves Bayesian customer rating on GET /api/customer/rating?id=SYNTH_SYN_01", async () => {
      const res = await fetch(`${baseUrl}/api/customer/rating?id=SYNTH_SYN_01`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        rating: { customerId: string };
      };
      expect(data.success).toBe(true);
      expect(data.rating.customerId).toBe("SYNTH_SYN");
    });
  });

  describe("Live Wagers Ingestion Feed", () => {
    it("dynamically loads and projects wagers on GET /api/wagers", async () => {
      const res = await fetch(`${baseUrl}/api/wagers`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        wagers: Array<{ ticketId: string; alertTier: string; riskUsd: number }>;
        totalRiskUsd: number;
        autoExecute: boolean;
      };
      expect(Array.isArray(data.wagers)).toBe(true);
      expect(data.wagers.length).toBeGreaterThan(0);
      expect(data.totalRiskUsd).toBeGreaterThan(0);
      expect(data.autoExecute).toBe(false);
    });

    it("serves live wagers on alias route GET /api/live-wagers", async () => {
      const res = await fetch(`${baseUrl}/api/live-wagers`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        wagers: Array<{ ticketId: string }>;
      };
      expect(Array.isArray(data.wagers)).toBe(true);
      expect(data.wagers.length).toBeGreaterThan(0);
    });
  });
});
