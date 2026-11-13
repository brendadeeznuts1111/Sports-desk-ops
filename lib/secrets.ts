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

/**
 * The read surface taken from Bun's own declaration (`Secrets.get(options: Bun.SecretsOptions)`)
 * instead of re-declared: a hand-written interface is how a cast sneaks in. `set`/`delete` are
 * omitted because this module only reads; writers pass the full `BunSecretSetOptions`
 * (`{service, name, value, persist}`) straight to `Bun.secrets.set`.
 */
export type SecretsProvider = Pick<typeof Bun.secrets, "get">;

export const DEFAULT_KEYCHAIN_TIMEOUT_MS = 500;
export const KEYCHAIN_HANG_COOLDOWN_MS = 30_000;

/** Thrown when an OS keychain operation blocks past the configured deadline. */
export class KeychainTimeoutError extends Error {
  constructor(
    options: { readonly service: string; readonly name: string },
    timeoutMs: number,
    op: "get" | "set" = "get",
  ) {
    super(
      `Bun.secrets.${op}(${options.service}/${options.name}) timed out after ${timeoutMs}ms`,
    );
    this.name = "KeychainTimeoutError";
  }
}

let realKeychainBlockedUntilMs = 0;

/** Reset the real-keychain hang cooldown (tests). */
export function resetKeychainTimeoutCooldownForTests(): void {
  realKeychainBlockedUntilMs = 0;
}

function runBoundedKeychainCall<TResult>(
  target: object,
  options: { readonly service: string; readonly name: string },
  timeoutMs: number,
  invoke: () => Promise<TResult>,
  op: "get" | "set",
): Promise<TResult> {
  const isRealKeychain = target === Bun.secrets;
  if (isRealKeychain && Date.now() < realKeychainBlockedUntilMs) {
    return Promise.reject(new KeychainTimeoutError(options, timeoutMs, op));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (isRealKeychain) {
        realKeychainBlockedUntilMs = Date.now() + KEYCHAIN_HANG_COOLDOWN_MS;
      }
      reject(new KeychainTimeoutError(options, timeoutMs, op));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(invoke), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Bound an OS keychain lookup with a strict deadline and cache real-keychain hangs for
 * {@link KEYCHAIN_HANG_COOLDOWN_MS} so locked/ACL-prompting entries fail fast.
 */
export function getSecretBounded(
  reader: {
    get(options: {
      readonly service: string;
      readonly name: string;
    }): Promise<string | null>;
  },
  options: { readonly service: string; readonly name: string },
  timeoutMs: number = DEFAULT_KEYCHAIN_TIMEOUT_MS,
): Promise<string | null> {
  return runBoundedKeychainCall(
    reader,
    options,
    timeoutMs,
    () => reader.get(options),
    "get",
  );
}

/**
 * Bound an OS keychain write along the same cooldown as {@link getSecretBounded} so
 * background/test runs never stall indefinitely on a blocked SecurityAgent daemon.
 */
export function setSecretBounded<
  TOptions extends { readonly service: string; readonly name: string },
>(
  writer: { set(options: TOptions): Promise<void> },
  options: TOptions,
  timeoutMs: number = DEFAULT_KEYCHAIN_TIMEOUT_MS,
): Promise<void> {
  return runBoundedKeychainCall(
    writer,
    options,
    timeoutMs,
    () => writer.set(options),
    "set",
  );
}

let provider: SecretsProvider = Bun.secrets;

/** Swap the provider (tests) or restore the real keychain (`null`). */
export function setSecretsProviderForTests(next: SecretsProvider | null): void {
  provider = next ?? Bun.secrets;
}

/** One service/name read; a locked or unavailable keychain is `null`, never a throw. */
export async function readSecretOrNull(
  service: string,
  name: string,
): Promise<string | null> {
  try {
    const value = await getSecretBounded(provider, { service, name });
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  } catch {
    // Locked, missing, or timed-out keychain entry is treated as unset.
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

/**
 * The GSLive manager session id. `GSID` is the name of the portal's session *cookie* (set by
 * Manager Tools, so it never changes); the variable and keychain entry that carry its value are
 * `GSLIVE_SESSION_ID` (`<SYSTEM>_<NOUN>_<KIND>`). The pre-rename name stays readable everywhere
 * and is never written, so existing `.env` files, cron environments and keychain entries work.
 */
export const GSLIVE_SESSION_ID_NAME = "GSLIVE_SESSION_ID" as const;
/** `x-gs-session` / `ganchrowSessionId` paired with the GSID cookie on ajax.php. */
export const GSLIVE_GANCHROW_SESSION_NAME = "GSLIVE_GANCHROW_SESSION" as const;
export const GSID_LEGACY_NAME = "GSID" as const;
export const GSID_KEYCHAIN_NAME = GSLIVE_SESSION_ID_NAME;

/** New name first, then the pre-rename one; blank values do not count. */
export function gsliveSessionIdFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const current = (env[GSLIVE_SESSION_ID_NAME] ?? "").trim();
  return current !== "" ? current : (env[GSID_LEGACY_NAME] ?? "").trim();
}
