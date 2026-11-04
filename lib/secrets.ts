/**
 * Canonical-first OS keychain reads for the operator credentials.
 *
 * The repo migrated its keychain service to `com.bookdeskops.sportsdesk` and kept the older
 * services as read fallbacks (see `resolveSecretBackedEnv` in lib/r2_s3_client.ts). The F402
 * entries were never migrated, so a bare `Bun.secrets.get({ service: SECRETS_SERVICE, ... })`
 * with the legacy constant is the bug that makes a missing credential look like a wrong one.
 *
 * Everything here reads through an injectable provider so tests never touch the real keychain.
 */

/** Where new entries are written. */
export const CANONICAL_SECRETS_SERVICE = "com.bookdeskops.sportsdesk";

/** The pre-migration service; read-only fallback for entries that were never moved. */
export const LEGACY_SECRETS_SERVICE = "sportsdesk-ops";

/** The minimal keychain read surface; `Bun.secrets` satisfies it structurally. */
export interface SecretsProvider {
  get(options: {
    readonly service: string;
    readonly name: string;
  }): Promise<string | null>;
}

let provider: SecretsProvider = Bun.secrets as SecretsProvider;

/** Swap the provider (tests) or restore the real keychain (`null`). */
export function setSecretsProviderForTests(next: SecretsProvider | null): void {
  provider = next ?? (Bun.secrets as SecretsProvider);
}

/** One service/name read; a locked or unavailable keychain is `null`, never a throw. */
export async function readSecretOrNull(
  service: string,
  name: string,
): Promise<string | null> {
  try {
    const value = await provider.get({ service, name });
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Read one entry canonical-first, then legacy. Returns the service it came from so a status
 * command can say where the credential lives without printing it.
 */
export async function readSecretWithSource(
  name: string,
): Promise<{ readonly value: string; readonly service: string } | null> {
  for (const service of [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE]) {
    const value = await readSecretOrNull(service, name);
    if (value !== null) return { value, service };
  }
  return null;
}

/** Value-only canonical-then-legacy read. */
export async function readSecretCanonicalThenLegacy(
  name: string,
): Promise<string | null> {
  return (await readSecretWithSource(name))?.value ?? null;
}

/**
 * Keychain names for the F402/GSID entries. Kept here (not imported from `scripts/`) so the cron
 * probe does not pull the WebView/login modules at daemon startup; a test asserts they match
 * `SECRET_NAMES` in scripts/capture/f402_login.ts and `GSID_SECRET` in scripts/fetch-bet-tally.ts.
 */
export const F402_KEYCHAIN_NAMES = {
  agentId: "f402-agent-id",
  password: "f402-password",
} as const;

export const GSID_KEYCHAIN_NAME = "GSID" as const;
