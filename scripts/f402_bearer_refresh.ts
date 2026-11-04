#!/usr/bin/env bun
/**
 * @file f402_bearer_refresh.ts
 * @description Self-healing F402 bearer for long/scheduled 3b runs.
 *
 * A minted JWT lasts 1200 s (20 minutes). The 3b cron fires every 15 minutes, so a token file will
 * eventually start a run already expired. `renewToken` is tried first; if it fails (expired/rotated
 * token, or the endpoint rejects a stale bearer), the helper re-mints through the captured
 * `authenticateCustomer` contract using the F402 agent credentials in the OS keychain. The new token
 * is persisted so the next tick starts fresh.
 *
 * Fails closed: if neither renewal nor re-minting succeeds, a `F402TokenRefreshError` aborts the
 * run — it never degrades into an unauthenticated/partial batch. Secrets are never logged.
 */

import { authenticateCustomer } from "../lib/f402_authenticate_customer.ts";
import {
  F402TokenRefreshError,
  f402TokenExpiresAtMs,
  renewF402BearerToken,
  writeF402BearerToken,
} from "../lib/f402_pending_fetch.ts";
import {
  F402_KEYCHAIN_NAMES,
  readSecretCanonicalThenLegacy,
} from "../lib/secrets.ts";

export interface BearerCredentials {
  readonly agentId: string;
  readonly password: string;
}

export interface RefreshF402BearerOptions {
  /** Current bearer (possibly expired). Never logged. */
  readonly token: string;
  readonly baseUrl?: string;
  /** Injectable for tests. */
  readonly renewImpl?: (token: string) => Promise<{
    readonly token: string;
    readonly expiresAtMs: number | null;
  }>;
  readonly mintImpl?: (
    agentId: string,
    password: string,
  ) => Promise<{ readonly token: string }>;
  /** Injectable for tests; default reads the F402 pair from the keychain. */
  readonly readCredentials?: () => Promise<BearerCredentials>;
  /** Default persists the replacement token to `F402_TOKEN_FILE`. */
  readonly persist?: (token: string) => void;
}

export interface RefreshedF402Bearer {
  /** Replacement bearer. Never log this field. */
  readonly token: string;
  readonly expiresAtMs: number | null;
  readonly method: "renewed" | "minted";
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 120 ? message : `${message.slice(0, 117)}...`;
}

async function keychainCredentials(): Promise<BearerCredentials> {
  const agentId =
    (
      await readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.agentId)
    )?.trim() ?? "";
  const password =
    (
      await readSecretCanonicalThenLegacy(F402_KEYCHAIN_NAMES.password)
    )?.trim() ?? "";
  if (agentId === "" || password === "") {
    throw new F402TokenRefreshError(
      "re-mint needs the F402 agent id/password in the OS keychain (run secrets:f402 set)",
    );
  }
  return { agentId, password };
}

/**
 * Renew the current bearer; on failure, mint a fresh one from keychain credentials. Throws
 * `F402TokenRefreshError` when both paths fail. The replacement is persisted by default.
 */
export async function refreshF402BearerWithFallback(
  options: RefreshF402BearerOptions,
): Promise<RefreshedF402Bearer> {
  const persist =
    options.persist ?? ((token: string) => void writeF402BearerToken(token));
  const base =
    options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl };
  const renew =
    options.renewImpl ??
    ((token: string) => renewF402BearerToken({ token, ...base }));

  try {
    const renewed = await renew(options.token);
    persist(renewed.token);
    return {
      token: renewed.token,
      expiresAtMs: renewed.expiresAtMs,
      method: "renewed",
    };
  } catch (renewError) {
    const readCredentials = options.readCredentials ?? keychainCredentials;
    let credentials: BearerCredentials;
    try {
      credentials = await readCredentials();
    } catch (credentialError) {
      throw new F402TokenRefreshError(
        `bearer renew failed (${short(renewError)}); re-mint unavailable (${short(credentialError)})`,
      );
    }
    const mint =
      options.mintImpl ??
      ((agentId: string, password: string) =>
        authenticateCustomer({ agentId, password, ...base }));
    let minted: { readonly token: string };
    try {
      minted = await mint(credentials.agentId, credentials.password);
    } catch (mintError) {
      throw new F402TokenRefreshError(
        `bearer renew and re-mint both failed (renew: ${short(renewError)}; mint: ${short(mintError)})`,
      );
    }
    persist(minted.token);
    return {
      token: minted.token,
      expiresAtMs: f402TokenExpiresAtMs(minted.token),
      method: "minted",
    };
  }
}
