import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("Customer API Endpoints (/api/customer/profile & /api/customer/rating)", () => {
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeAll(() => {
    server = startServer({ port: 0, hostname: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  describe("GET /api/customer/profile", () => {
    test("rejects missing id query parameter with 400", async () => {
      const res = await fetch(`${baseUrl}/api/customer/profile`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.error).toContain("Missing required parameter 'id'");
    });

    test("rejects non-existent customer id with 404", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/profile?id=NON_EXISTENT_ID_9999`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.error).toContain("not found");
    });

    test("returns full unified customer profile for valid customer", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/profile?id=SYNTH_SYN_01`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");

      const body = (await res.json()) as {
        success: boolean;
        profile: {
          customerId: string;
          status: string;
          stakeProfile: {
            giniCoefficient: number;
            strategy: string;
            meanStakeUsd: number;
          };
          syndicateProfile: {
            clusterId: string;
            riskScore: number;
          };
          riskForensics: {
            lifetimeVolumeUsd: number;
            lifetimeNetUsd: number;
          };
          compositeSharpness: {
            overallScore: number;
            tier: string;
          };
          deskDirectives: {
            action: string;
            recommendedStakeLimitUsd: number;
          };
        };
        generatedAt: string;
      };

      expect(body.success).toBe(true);
      expect(body.profile).toBeDefined();
      expect(body.profile.customerId).toBe("SYNTH_SYN_01");
      expect(body.profile.stakeProfile.giniCoefficient).toBeGreaterThanOrEqual(
        0,
      );
      expect(body.profile.syndicateProfile).toBeDefined();
      expect(body.profile.riskForensics).toBeDefined();
      expect(
        body.profile.compositeSharpness.overallScore,
      ).toBeGreaterThanOrEqual(0);
      expect(body.profile.deskDirectives.action).toBeDefined();
      expect(body.generatedAt).toBeDefined();
    });

    test("rejects unsupported HTTP methods with 404 or 405", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/profile?id=SYNTH_SYN_01`,
        {
          method: "POST",
        },
      );
      expect([404, 405]).toContain(res.status);
    });
  });

  describe("GET /api/customer/rating", () => {
    test("rejects missing id query parameter with 400", async () => {
      const res = await fetch(`${baseUrl}/api/customer/rating`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.error).toContain("Missing required parameter 'id'");
    });

    test("rejects non-existent customer id with 404", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/rating?id=UNKNOWN_BETTOR_1234`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.error).toContain("not found");
    });

    test("returns Bayesian skill and Kelly sizing rating for valid customer", async () => {
      const res = await fetch(`${baseUrl}/api/customer/rating?id=SYNTH_SYN_01`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");

      const body = (await res.json()) as {
        success: boolean;
        rating: {
          customerId: string;
          score: number;
          tier: string;
          riskLevel: string;
          primaryArchetype: string;
          componentScores: {
            keyNumberScore: number;
            clvEdgeScore: number;
            steamLatencyScore: number;
          };
          bayesianSkill: {
            priorWinRate: number;
            posteriorMeanWinRate: number;
            tier: string;
          };
          kellyMetrics: {
            fractionalKellyFraction: number;
            impliedKellyFraction: number;
          };
        };
        generatedAt: string;
      };

      expect(body.success).toBe(true);
      expect(body.rating).toBeDefined();
      expect(body.rating.score).toBeGreaterThanOrEqual(0);
      expect(body.rating.tier).toBeDefined();
      expect(
        body.rating.bayesianSkill.posteriorMeanWinRate,
      ).toBeGreaterThanOrEqual(0);
      expect(body.rating.kellyMetrics.impliedKellyFraction).toBeDefined();
      expect(body.generatedAt).toBeDefined();
    });

    test("rejects unsupported HTTP methods with 404 or 405", async () => {
      const res = await fetch(
        `${baseUrl}/api/customer/rating?id=SYNTH_SYN_01`,
        {
          method: "POST",
        },
      );
      expect([404, 405]).toContain(res.status);
    });
  });
});
