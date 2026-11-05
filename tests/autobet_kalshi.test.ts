import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import {
  kalshiArming,
  type KalshiArmingOptions,
} from "../lib/autobet_kalshi.ts";

/**
 * The Kalshi arming report is the gate between "the pipeline noticed something" and "a live
 * order is allowed". These tests inject the credential resolver so they never touch the
 * keychain, env, network or key material; they pin the three independent gates and the fact
 * that an unarmed report is the normal answer.
 */

// A real (locally generated) RSA key so the adapter's PEM validation accepts the material;
// no key material is printed, stored or used for a network request.
const TEST_PRIVATE_KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const READY = {
  ready: true as const,
  reason: "ready",
  credentials: {
    apiKeyId: "test-key-id",
    privateKeyPem: TEST_PRIVATE_KEY_PEM,
  },
};
const MISSING = { ready: false as const, reason: "api_key_id_missing" };

function options(
  env: Readonly<Record<string, string | undefined>>,
  resolved: typeof READY | typeof MISSING,
): KalshiArmingOptions {
  return {
    env,
    resolveCredentials: async () => resolved,
  };
}

describe("kalshiArming", () => {
  test("credentials alone never arm a live order", async () => {
    const arming = await kalshiArming(options({}, READY));
    expect(arming.credentialsReady).toBe(true);
    expect(arming.armed).toBe(false);
    expect(arming.mode).toBe("paper");
    expect(arming.liveEnabled).toBe(false);
    expect(arming.blockingReasons).toEqual([
      "EXECUTION_LIVE is not 1",
      "EXECUTION_MODE is paper",
    ]);
  });

  test("all three gates must be satisfied to arm", async () => {
    const env = { EXECUTION_LIVE: "1", EXECUTION_MODE: "live" };
    const armed = await kalshiArming(options(env, READY));
    expect(armed.armed).toBe(true);
    expect(armed.blockingReasons).toEqual([]);

    const stillPaper = await kalshiArming(
      options({ EXECUTION_LIVE: "1" }, READY),
    );
    expect(stillPaper.armed).toBe(false);
    expect(stillPaper.blockingReasons).toContain("EXECUTION_MODE is paper");

    const notLiveEnabled = await kalshiArming(
      options({ EXECUTION_MODE: "live" }, READY),
    );
    expect(notLiveEnabled.armed).toBe(false);
    expect(notLiveEnabled.blockingReasons).toContain("EXECUTION_LIVE is not 1");
  });

  test("missing credentials are reported with the exact names to configure", async () => {
    const arming = await kalshiArming(
      options({ EXECUTION_LIVE: "1", EXECUTION_MODE: "live" }, MISSING),
    );
    expect(arming.credentialsReady).toBe(false);
    expect(arming.armed).toBe(false);
    expect(arming.readiness).toBe("api_key_id_missing");
    expect(arming.blockingReasons).toContain("credentials: api_key_id_missing");
    expect(arming.credentials).toMatchObject({
      apiKeyIdEnv: "KALSHI_API_KEY_ID",
      privateKeyPathEnv: "KALSHI_PRIVATE_KEY_PATH",
      keychainService: "com.bookdeskops.sportsdesk",
      keychainApiKeyId: "kalshi-api-key-id",
      keychainPrivateKeyPem: "kalshi-private-key-pem",
    });
    // The phrase is required per order; reporting it is not consent.
    expect(arming.confirmPhrase).toBe("PLACE LIVE ORDERS");
  });

  test("the report never serializes key material", async () => {
    const arming = await kalshiArming(
      options({ EXECUTION_LIVE: "1", EXECUTION_MODE: "live" }, READY),
    );
    const serialized = JSON.stringify(arming);
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("test-key-id");
  });

  test("paused execution is not armed even with live-enabled and credentials", async () => {
    const arming = await kalshiArming(
      options({ EXECUTION_LIVE: "1", EXECUTION_MODE: "paused" }, READY),
    );
    expect(arming.armed).toBe(false);
    expect(arming.mode).toBe("paused");
    expect(arming.blockingReasons).toContain("EXECUTION_MODE is paused");
  });
});
