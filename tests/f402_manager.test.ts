import { describe, expect, test } from "bun:test";
import {
  Fantasy402ManagerWorker,
  HALF_POINT_HOOK_SYNDICATE_ROSTER,
  HOOK_REPRICING_SPORT_TYPES,
  InvalidFantasy402IdentifierError,
  MutationTargetPartitionError,
  TokenBucketLimiter,
  resolveCustomerMutationTarget,
  validateMutationTargetUrl,
} from "../lib/f402_manager.ts";

describe("Fantasy402 Manager Mutation Dispatch Worker & Boundary Guards", () => {
  test("validateMutationTargetUrl permits fantasy402 and rejects GSLive endpoints", () => {
    const validUrl =
      "https://" + "cloud.fantasy402.com" + "/cloud/api/Manager/updateByColumn";
    expect(validateMutationTargetUrl(validUrl)).toBe(validUrl);

    const gsliveUrl =
      "https://" + "plive.sportswidgets.pro" + "/manager-tools/ajax.php";
    expect(() => validateMutationTargetUrl(gsliveUrl)).toThrow(
      MutationTargetPartitionError,
    );
  });

  test("resolveCustomerMutationTarget rejects GSLive BetGroup tokens and master BILLY666", () => {
    expect(() =>
      resolveCustomerMutationTarget("M.G319775995", "CUB22HR"),
    ).toThrow(InvalidFantasy402IdentifierError);
    expect(() => resolveCustomerMutationTarget("CB112", "BILLY666")).toThrow(
      InvalidFantasy402IdentifierError,
    );
    const resolved = resolveCustomerMutationTarget("CB112", "CUB22HR");
    expect(resolved.customerId).toBe("CB112");
    expect(String(resolved.paddedCustomerId)).toBe("CB112      ");
    expect(String(resolved.leafAgentId)).toBe("CUB22HR");
  });

  test("TokenBucketLimiter meters requests at 20 req/s with burst capacity", async () => {
    const limiter = new TokenBucketLimiter(20, 20);
    expect(limiter.availableTokens).toBeGreaterThanOrEqual(19);
    await limiter.acquire(5);
    expect(limiter.availableTokens).toBeLessThanOrEqual(15.5);

    const inspected = Bun.inspect(limiter);
    expect(inspected).toContain("TokenBucketLimiter");
    expect(inspected).toContain("rate=20req/s");
  });

  test("Fantasy402ManagerWorker custom inspect formats target and limiter", () => {
    const worker = new Fantasy402ManagerWorker();
    const inspected = Bun.inspect(worker);
    expect(inspected).toContain("Fantasy402ManagerWorker");
    expect(inspected).toContain("cloud.fantasy402.com");
    expect(inspected).toContain("TokenBucketLimiter");
  });

  test("dispatchHookSyndicateVigSetup applies +25c vig shading across College and NFL for all 5 syndicate accounts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ Result: { Result: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const worker = new Fantasy402ManagerWorker({
      ratePerSec: 1000,
      burstCapacity: 20,
    });
    const results = await worker.dispatchHookSyndicateVigSetup({
      fetchImpl: mockFetch,
    });

    expect(HALF_POINT_HOOK_SYNDICATE_ROSTER).toHaveLength(5);
    expect(HOOK_REPRICING_SPORT_TYPES).toEqual(["College", "NFL"]);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.success)).toBe(true);
    expect(calls[0]?.body).toMatchObject({
      operation: "vigSetupInsert",
      sportType: "College             ",
      player: "GP301      ",
      flagVig: "Y",
      VigSpread: "25",
      VigDerivative: "25",
      RRO: "1",
    });
    expect(calls[1]?.body).toMatchObject({
      operation: "vigSetupInsert",
      sportType: "NFL                 ",
      player: "GP301      ",
      VigSpread: "25",
    });
  });
});
