/**
 * @file lib/f402_secret_store.ts
 * @description Bun.secrets-backed storage for the F402 credential and session, with named errors.
 *
 * - Writes go to the canonical service `com.bookdeskops.sportsdesk` only.
 * - Reads are canonical-first with a read-only fallback to the legacy `sportsdesk-ops` service.
 *   Reading legacy never writes to it; `migrateLegacyF402Secrets` is the explicit, opt-in copy.
 * - Every Bun.secrets failure is mapped to one of three named errors. Messages carry the service,
 *   entry name, operation and Bun's error code, never a secret value.
 * - The adapter is injectable so unit tests never touch the host keychain.
 *
 * Bun.secrets backends (Bun source, src/jsc/bindings/): macOS Keychain via Security.framework
 * (SecretsDarwin.cpp), Linux libsecret over the D-Bus Secret Service (SecretsLinux.cpp, dlopen of
 * libsecret-1.so.0), Windows Credential Manager (SecretsWindows.cpp). Error codes are mapped in
 * JSSecrets.cpp: NOT_FOUND resolves `get` to null and `delete` to false; access errors become
 * ERR_SECRETS_ACCESS_DENIED / _INTERACTION_NOT_ALLOWED / _AUTH_FAILED / _INTERACTION_REQUIRED /
 * _USER_CANCELED; anything else (no libsecret, no D-Bus session, no Secret Service) is
 * ERR_SECRETS_PLATFORM_ERROR.
 */

import {
  CANONICAL_SECRETS_SERVICE,
  DEFAULT_KEYCHAIN_TIMEOUT_MS,
  getSecretBounded,
  KeychainTimeoutError,
  LEGACY_SECRETS_SERVICE,
  setSecretBounded,
} from "./secrets.ts";

/** The Bun.secrets surface this module uses; tests pass an in-memory fake. */
export interface SecretsAdapter {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: {
    service: string;
    name: string;
    value: string;
    persist?: "local" | "enterprise";
  }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export type SecretOp = "get" | "set" | "delete";

interface SecretErrorContext {
  readonly service: string;
  readonly name: string;
  readonly op: SecretOp;
}

/** Base class: every F402 secret error carries only non-secret context. */
export class F402SecretError extends Error {
  readonly service: string;
  readonly secretName: string;
  readonly op: SecretOp;
  /** Bun's error code (e.g. ERR_SECRETS_PLATFORM_ERROR), when there was one. */
  readonly bunCode: string | undefined;
  constructor(
    message: string,
    context: SecretErrorContext,
    bunCode: string | undefined,
  ) {
    super(message);
    this.name = "F402SecretError";
    this.service = context.service;
    this.secretName = context.name;
    this.op = context.op;
    this.bunCode = bunCode;
  }
}

/** The entry does not exist in the canonical or the legacy service. */
export class F402SecretNotFound extends F402SecretError {
  constructor(context: {
    readonly name: string;
    readonly services: readonly string[];
  }) {
    super(
      `F402 secret "${context.name}" not found in ${context.services.join(", ")}; store it with: <password-source> | bun run secrets:f402 set --agent-id <id>`,
      {
        service: context.services[0] ?? CANONICAL_SECRETS_SERVICE,
        name: context.name,
        op: "get",
      },
      undefined,
    );
    this.name = "F402SecretNotFound";
  }
}

/** No usable OS credential store: no libsecret, no D-Bus session, no Secret Service, or it hung. */
export class F402KeychainUnavailable extends F402SecretError {
  constructor(
    context: SecretErrorContext,
    bunCode: string | undefined,
    detail: string,
  ) {
    super(
      `OS keychain unavailable for ${context.op} ${context.service}/${context.name}` +
        `${bunCode ? ` (${bunCode})` : ""}: ${detail}`,
      context,
      bunCode,
    );
    this.name = "F402KeychainUnavailable";
  }
}

/** The store answered but refused or failed (access denied, user cancelled, auth failed, other). */
export class F402SecretBackendError extends F402SecretError {
  constructor(
    context: SecretErrorContext,
    bunCode: string | undefined,
    detail: string,
  ) {
    super(
      `OS keychain ${context.op} failed for ${context.service}/${context.name}` +
        `${bunCode ? ` (${bunCode})` : ""}: ${detail}`,
      context,
      bunCode,
    );
    this.name = "F402SecretBackendError";
  }
}

/**
 * Platform messages that mean "there is no credential store to talk to" rather than "the store
 * said no". Linux: libsecret missing (SecretsLinux.cpp "libsecret not available"), no D-Bus session
 * ("Could not connect"), no Secret Service on the bus ("org.freedesktop.secrets was not provided").
 */
const UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /libsecret not available/i,
  /could not connect/i,
  /org\.freedesktop\.secrets/i,
  /cannot autolaunch d-bus/i,
  /DBUS_SESSION_BUS_ADDRESS/i,
  /Security framework not available/i,
];

function redact(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

/**
 * Map any throw from Bun.secrets (or the timeout wrapper) to a named error. `secretValues` are
 * scrubbed from the platform message as a belt-and-braces guard; Bun's messages come from the OS
 * store and do not include the value, but this keeps that a tested property instead of a hope.
 */
export function classifySecretsError(
  error: unknown,
  context: SecretErrorContext,
  secretValues: readonly string[] = [],
): F402KeychainUnavailable | F402SecretBackendError {
  if (
    error instanceof F402KeychainUnavailable ||
    error instanceof F402SecretBackendError
  ) {
    return error;
  }
  if (error instanceof KeychainTimeoutError) {
    return new F402KeychainUnavailable(
      context,
      "KEYCHAIN_TIMEOUT",
      "timed out",
    );
  }
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === "string" ? raw.code : undefined;
  const detail = redact(
    typeof raw?.message === "string" ? raw.message : String(error),
    secretValues,
  );
  if (
    code === "ERR_SECRETS_PLATFORM_ERROR" &&
    UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))
  ) {
    return new F402KeychainUnavailable(context, code, detail);
  }
  return new F402SecretBackendError(context, code, detail);
}

let adapter: SecretsAdapter = Bun.secrets;

/** Swap the adapter (tests) or restore Bun.secrets (`null`). */
export function setSecretsAdapterForTests(next: SecretsAdapter | null): void {
  adapter = next ?? Bun.secrets;
}

export function currentSecretsAdapter(): SecretsAdapter {
  return adapter;
}

/** Read order: canonical first, then the legacy read-only fallback. */
export const F402_READ_SERVICES = [
  CANONICAL_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
] as const;

export interface StrictSecretRead {
  readonly value: string;
  readonly service: string;
}

/**
 * Canonical-then-legacy read that distinguishes "absent" (null) from "store unusable" (throws a
 * named error). A blank stored value counts as absent.
 */
export async function readF402SecretStrict(
  name: string,
  options: {
    readonly adapter?: SecretsAdapter;
    readonly services?: readonly string[];
    readonly timeoutMs?: number;
  } = {},
): Promise<StrictSecretRead | null> {
  const store = options.adapter ?? adapter;
  for (const service of options.services ?? F402_READ_SERVICES) {
    let value: string | null;
    try {
      value = await getSecretBounded(
        store,
        { service, name },
        options.timeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS,
      );
    } catch (error) {
      throw classifySecretsError(error, { service, name, op: "get" });
    }
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") return { value: trimmed, service };
  }
  return null;
}

/** Like {@link readF402SecretStrict} but a missing entry throws {@link F402SecretNotFound}. */
export async function requireF402Secret(
  name: string,
  options: Parameters<typeof readF402SecretStrict>[1] = {},
): Promise<StrictSecretRead> {
  const found = await readF402SecretStrict(name, options);
  if (found === null) {
    throw new F402SecretNotFound({
      name,
      services: options.services ?? F402_READ_SERVICES,
    });
  }
  return found;
}

/** Write one entry to the canonical service only. Empty values are refused (Bun treats "" as delete). */
export async function writeF402Secret(
  name: string,
  value: string,
  options: {
    readonly adapter?: SecretsAdapter;
    readonly timeoutMs?: number;
    /** Extra substrings to scrub from error text (e.g. the cookie inside a session JSON). */
    readonly redact?: readonly string[];
  } = {},
): Promise<void> {
  const service = CANONICAL_SECRETS_SERVICE;
  if (value === "") {
    throw new F402SecretBackendError(
      { service, name, op: "set" },
      undefined,
      "refusing to store an empty value (Bun.secrets treats it as delete)",
    );
  }
  const store = options.adapter ?? adapter;
  const setOptions = { service, name, value, persist: "local" as const };
  try {
    if (options.timeoutMs === undefined) await store.set(setOptions);
    else await setSecretBounded(store, setOptions, options.timeoutMs);
  } catch (error) {
    throw classifySecretsError(error, { service, name, op: "set" }, [
      value,
      ...(options.redact ?? []),
    ]);
  }
}

/** Delete one entry from one service; false when it was not there. */
export async function deleteF402Secret(
  service: string,
  name: string,
  options: { readonly adapter?: SecretsAdapter } = {},
): Promise<boolean> {
  const store = options.adapter ?? adapter;
  try {
    return await store.delete({ service, name });
  } catch (error) {
    throw classifySecretsError(error, { service, name, op: "delete" });
  }
}

export interface MigrationResult {
  readonly name: string;
  readonly outcome: "canonical-present" | "copied" | "absent";
}

/**
 * Explicit, opt-in copy of legacy entries into the canonical service. It never deletes or
 * rewrites the legacy entry, never overwrites a canonical value, and reports names only.
 */
export async function migrateLegacyF402Secrets(
  names: readonly string[],
  options: { readonly adapter?: SecretsAdapter } = {},
): Promise<readonly MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const name of names) {
    const canonical = await readF402SecretStrict(name, {
      ...options,
      services: [CANONICAL_SECRETS_SERVICE],
    });
    if (canonical !== null) {
      results.push({ name, outcome: "canonical-present" });
      continue;
    }
    const legacy = await readF402SecretStrict(name, {
      ...options,
      services: [LEGACY_SECRETS_SERVICE],
    });
    if (legacy === null) {
      results.push({ name, outcome: "absent" });
      continue;
    }
    await writeF402Secret(name, legacy.value, options);
    results.push({ name, outcome: "copied" });
  }
  return results;
}

export type BackendProbe =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly error: F402KeychainUnavailable | F402SecretBackendError;
    };

/**
 * Round-trip a random throwaway entry under `<service>.probe-<random>` to see whether this
 * machine has a working store. Never touches the real F402 entries.
 */
export async function probeSecretsBackend(
  options: {
    readonly adapter?: SecretsAdapter;
    readonly service?: string;
  } = {},
): Promise<BackendProbe> {
  const store = options.adapter ?? adapter;
  const service =
    options.service ??
    `${CANONICAL_SECRETS_SERVICE}.probe-${crypto.randomUUID().slice(0, 8)}`;
  const name = "probe";
  const value = crypto.randomUUID();
  try {
    await store.set({ service, name, value });
  } catch (error) {
    return {
      available: false,
      error: classifySecretsError(error, { service, name, op: "set" }, [value]),
    };
  }
  try {
    await store.delete({ service, name });
  } catch {
    // Cleanup best-effort; the set already proved the backend works.
  }
  return { available: true };
}
