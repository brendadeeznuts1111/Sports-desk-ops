/**
 * @file autobet_kalshi.ts
 * @description Read-only arming report for the Kalshi live adapter.
 *
 * The watchlist/flag pipeline may only hand an order to Kalshi when three independent gates are
 * satisfied: (1) `EXECUTION_MODE=live`, (2) `EXECUTION_LIVE=1`, and (3) every requested order
 * carries the operator's `confirm: "PLACE LIVE ORDERS"` phrase. Credentials are separate:
 * `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY_PATH` (PEM file), or the keychain pair
 * `kalshi-api-key-id` / `kalshi-private-key-pem` under the canonical service.
 *
 * This module answers "would a live order be armed right now, and if not, why?" without placing
 * anything, without reading key material into a string that callers can print, and without
 * requiring the caller to understand the adapter. It reports names and reasons only.
 */

import { LIVE_CONFIRM_PHRASE, policyFromEnv } from "./execution_decision.ts";
import {
  KALSHI_API_KEY_ID_ENV,
  KALSHI_API_KEY_ID_SECRET,
  KALSHI_PRIVATE_KEY_PATH_ENV,
  KALSHI_PRIVATE_KEY_PEM_SECRET,
  kalshiLiveReady,
  resolveKalshiCredentials,
  type KalshiCredentialsResolution,
  type KalshiLiveReady,
} from "./kalshi_live_execution.ts";
import { CANONICAL_SECRETS_SERVICE } from "./secrets.ts";

export interface KalshiCredentialHints {
  readonly apiKeyIdEnv: string;
  readonly privateKeyPathEnv: string;
  readonly keychainService: string;
  readonly keychainApiKeyId: string;
  readonly keychainPrivateKeyPem: string;
}

export interface KalshiArming {
  /** Credentials resolved and usable. */
  readonly credentialsReady: boolean;
  /** `credentialsReady && EXECUTION_LIVE=1 && EXECUTION_MODE=live`. */
  readonly armed: boolean;
  readonly mode: "paper" | "paused" | "live";
  readonly liveEnabled: boolean;
  /** Every reason a live order would be refused right now (empty when armed). */
  readonly blockingReasons: readonly string[];
  /** The phrase every live order body must carry; knowing it is not consent by itself. */
  readonly confirmPhrase: string;
  /** Where credentials may come from — names only, never values. */
  readonly credentials: KalshiCredentialHints;
  /** The adapter's own readiness reason (`"ready"` when usable). */
  readonly readiness: string;
}

export interface KalshiArmingOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam; defaults to the real credential resolver (env then keychain). */
  readonly resolveCredentials?: () => Promise<KalshiCredentialsResolution>;
}

/**
 * Resolve arming without side effects. Never throws for missing credentials: an unarmed state is
 * the normal answer in this checkout and is reported with the exact names to configure.
 */
export async function kalshiArming(
  options: KalshiArmingOptions = {},
): Promise<KalshiArming> {
  const env = options.env ?? Bun.env;
  const policy = policyFromEnv(env);
  const resolve =
    options.resolveCredentials ?? (() => resolveKalshiCredentials({ env }));
  const ready: KalshiLiveReady = await kalshiLiveReady({
    resolveCredentials: resolve,
  });

  const blockingReasons: string[] = [];
  if (!ready.ready) {
    blockingReasons.push(`credentials: ${ready.reason}`);
  }
  if (!policy.liveEnabled) {
    blockingReasons.push("EXECUTION_LIVE is not 1");
  }
  if (policy.mode !== "live") {
    blockingReasons.push(`EXECUTION_MODE is ${policy.mode}`);
  }

  return {
    credentialsReady: ready.ready,
    armed: blockingReasons.length === 0,
    mode: policy.mode,
    liveEnabled: policy.liveEnabled,
    blockingReasons,
    confirmPhrase: LIVE_CONFIRM_PHRASE,
    credentials: {
      apiKeyIdEnv: KALSHI_API_KEY_ID_ENV,
      privateKeyPathEnv: KALSHI_PRIVATE_KEY_PATH_ENV,
      keychainService: CANONICAL_SECRETS_SERVICE,
      keychainApiKeyId: KALSHI_API_KEY_ID_SECRET,
      keychainPrivateKeyPem: KALSHI_PRIVATE_KEY_PEM_SECRET,
    },
    readiness: ready.reason ?? "unknown",
  };
}
