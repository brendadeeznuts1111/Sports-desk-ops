/**
 * @file lib/f402_secret_store.ts
 * @description Bun.secrets-backed storage for the F402 credential and session, with named errors.
 *
 * - Writes go to the canonical service `com.bookdeskops.sportsdesk` only.
 * - Reads are canonical-first with a read-only fallback to the legacy `sportsdesk-ops` service.
 *   `migrateLegacyF402Secrets` is the explicit, opt-in copy and cannot write the legacy service.
 * - Every Bun.secrets failure is mapped by its `code` through {@link F402_SECRET_ERROR_MAP}.
 *   A code that is not in the map becomes an {@link F402SecretBackendError} carrying that code.
 *   Messages carry the service, entry name, operation and code, never a secret value.
 * - The adapter is injectable so unit tests never touch the host keychain.
 *
 * Bun.secrets behaviour this module relies on (Bun ed436333, verified against the 1.4.4 and
 * 1.4.5-canary binaries; see docs/runbooks/f402_session_refresh.md "Bun.secrets contract"):
 * - `get` resolves null and `delete` resolves false for a missing entry (JSSecrets.cpp:303-311).
 * - Argument errors (ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE) are thrown synchronously,
 *   not returned as a rejected promise (JSSecrets.cpp:118-265).
 * - `set` with `value: ""` deletes the entry on every platform (SecretsLinux.cpp:283-292,
 *   SecretsDarwin.cpp:315-324, SecretsWindows.cpp:168-177), so blank writes are refused here.
 */

import {
  CANONICAL_SECRETS_SERVICE,
  DEFAULT_KEYCHAIN_TIMEOUT_MS,
  getSecretBounded,
  KeychainTimeoutError,
  LEGACY_SECRETS_SERVICE,
  setSecretBounded,
} from "./secrets.ts";

/**
 * The Bun.secrets surface this module uses; tests pass an in-memory fake.
 *
 * `allowUnrestrictedAccess` is deliberately absent: F402 entries are never stored with it (see
 * {@link F402_SECRET_SET_POLICY}).
 */
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

/**
 * Options every F402 write passes to Bun.secrets.set.
 *
 * - `persist: "local"`: Windows only (CRED_PERSIST_LOCAL_MACHINE). Bun's default is
 *   "enterprise" (JSSecrets.cpp:127), which roams with a domain profile; the agent password and a
 *   portal session belong to one desk machine. Matches `secretSetOptions` in lib/r2_s3_client.ts.
 * - `allowUnrestrictedAccess` is never sent, so Bun keeps its default `false`. On macOS `true`
 *   attaches a SecAccess with a nil trusted-application list, letting any process read the item
 *   without a prompt (SecretsDarwin.cpp:341-363); Linux and Windows ignore it. The desk runs in a
 *   logged-in user session (LaunchAgent, not a headless CI box), so the prompt-free path is not
 *   needed; a refresher that hits ERR_SECRETS_INTERACTION_NOT_ALLOWED is fixed by granting the
 *   bun binary access once in Keychain Access, not by opening the item to every process.
 */
export const F402_SECRET_SET_POLICY = {
  persist: "local",
  allowUnrestrictedAccess: false,
} as const;

export type SecretOp = "get" | "set" | "delete";

interface SecretErrorContext {
  readonly service: string;
  readonly name: string;
  readonly op: SecretOp;
}

/** What went wrong, independent of the platform's wording. Stable; used in `--json` output. */
export type F402SecretErrorKind =
  | "not-found"
  | "unavailable"
  | "timeout"
  | "access-denied"
  | "interaction-required"
  | "user-canceled"
  | "invalid-argument"
  | "platform"
  | "legacy-write-refused"
  | "verify-failed"
  | "empty-value"
  | "unknown-code"
  | "uncoded";

/** Base class: every F402 secret error carries only non-secret context. */
export class F402SecretError extends Error {
  readonly service: string;
  readonly secretName: string;
  readonly op: SecretOp;
  /** The error's `code` (Bun's, or KEYCHAIN_TIMEOUT / F402_*), when there was one. */
  readonly bunCode: string | undefined;
  /** The OS status from Bun's "(code: N)" suffix (OSStatus, GError code, Win32 error). */
  readonly platformCode: number | undefined;
  readonly kind: F402SecretErrorKind;
  constructor(
    message: string,
    context: SecretErrorContext,
    bunCode: string | undefined,
    kind: F402SecretErrorKind,
    platformCode?: number,
  ) {
    super(message);
    this.name = "F402SecretError";
    this.service = context.service;
    this.secretName = context.name;
    this.op = context.op;
    this.bunCode = bunCode;
    this.kind = kind;
    this.platformCode = platformCode;
  }
}

function describeFailure(
  context: SecretErrorContext,
  bunCode: string | undefined,
  detail: string,
): string {
  return `${context.op} ${context.service}/${context.name}${bunCode ? ` (${bunCode})` : ""}: ${detail}`;
}

/**
 * The entry does not exist. Raised by {@link requireF402Secret} when neither service has it, and
 * for ERR_SECRETS_NOT_FOUND, which Bun only rejects with on `set` (`get`/`delete` resolve
 * null/false instead).
 */
export class F402SecretNotFound extends F402SecretError {
  constructor(context: {
    readonly name: string;
    readonly services: readonly string[];
    readonly op?: SecretOp;
    readonly bunCode?: string;
    readonly detail?: string;
    readonly platformCode?: number;
  }) {
    const service = context.services[0] ?? CANONICAL_SECRETS_SERVICE;
    const op = context.op ?? "get";
    super(
      context.bunCode === undefined
        ? `F402 secret "${context.name}" not found in ${context.services.join(", ")}; store it with: <password-source> | bun run secrets:f402 set --agent-id <id>`
        : `OS keychain reported not found for ${describeFailure({ service, name: context.name, op }, context.bunCode, context.detail ?? "")}`,
      { service, name: context.name, op },
      context.bunCode,
      "not-found",
      context.platformCode,
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
    platformCode?: number,
  ) {
    super(
      `OS keychain unavailable for ${describeFailure(context, bunCode, detail)}`,
      context,
      bunCode,
      bunCode === KEYCHAIN_TIMEOUT_CODE ? "timeout" : "unavailable",
      platformCode,
    );
    this.name = "F402KeychainUnavailable";
  }
}

/** The store answered but refused or failed. Subclasses name the specific refusal. */
export class F402SecretBackendError extends F402SecretError {
  constructor(
    context: SecretErrorContext,
    bunCode: string | undefined,
    detail: string,
    kind: F402SecretErrorKind = bunCode === undefined
      ? "uncoded"
      : "unknown-code",
    platformCode?: number,
  ) {
    super(
      `OS keychain ${describeFailure(context, bunCode, detail)}`,
      context,
      bunCode,
      kind,
      platformCode,
    );
    this.name = "F402SecretBackendError";
  }
}

/** ERR_SECRETS_ACCESS_DENIED / ERR_SECRETS_AUTH_FAILED: the store refused this process. */
export class F402SecretAccessDenied extends F402SecretBackendError {
  constructor(
    context: SecretErrorContext,
    bunCode: string,
    detail: string,
    platformCode?: number,
  ) {
    super(context, bunCode, detail, "access-denied", platformCode);
    this.name = "F402SecretAccessDenied";
  }
}

/** ERR_SECRETS_INTERACTION_NOT_ALLOWED / _REQUIRED: a prompt is needed but cannot be shown. */
export class F402SecretInteractionRequired extends F402SecretBackendError {
  constructor(
    context: SecretErrorContext,
    bunCode: string,
    detail: string,
    platformCode?: number,
  ) {
    super(context, bunCode, detail, "interaction-required", platformCode);
    this.name = "F402SecretInteractionRequired";
  }
}

/** ERR_SECRETS_USER_CANCELED: the operator dismissed the keychain prompt. */
export class F402SecretUserCanceled extends F402SecretBackendError {
  constructor(
    context: SecretErrorContext,
    bunCode: string,
    detail: string,
    platformCode?: number,
  ) {
    super(context, bunCode, detail, "user-canceled", platformCode);
    this.name = "F402SecretUserCanceled";
  }
}

/** ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE thrown by Bun.secrets argument validation. */
export class F402SecretInvalidArgument extends F402SecretBackendError {
  constructor(
    context: SecretErrorContext,
    bunCode: string,
    detail: string,
    platformCode?: number,
  ) {
    super(context, bunCode, detail, "invalid-argument", platformCode);
    this.name = "F402SecretInvalidArgument";
  }
}

/** A write or delete aimed at the read-only legacy service. Never reaches Bun.secrets. */
export class F402LegacyWriteRefused extends F402SecretBackendError {
  constructor(context: SecretErrorContext) {
    super(
      context,
      "F402_LEGACY_WRITE_REFUSED",
      `${LEGACY_SECRETS_SERVICE} is read-only for this operation`,
      "legacy-write-refused",
    );
    this.name = "F402LegacyWriteRefused";
  }
}

export const KEYCHAIN_TIMEOUT_CODE = "KEYCHAIN_TIMEOUT";

/** macOS errSecNotAvailable: "No keychain is available." Bun reports it as ACCESS_DENIED. */
const DARWIN_ERR_SEC_NOT_AVAILABLE = -25291;

/**
 * ERR_SECRETS_PLATFORM_ERROR messages that mean "there is no credential store to talk to" rather
 * than "the store failed". Bun's own: "libsecret not available" (SecretsLinux.cpp:279/329/373),
 * "Security framework not available" (SecretsDarwin.cpp:311/402/439), "Credential Manager not
 * available" (SecretsWindows.cpp:164/211/248). GLib/D-Bus, observed on this box: "Could not
 * connect" (bus socket missing), "Cannot autolaunch D-Bus without X11 $DISPLAY" (no
 * DBUS_SESSION_BUS_ADDRESS), "org.freedesktop.secrets was not provided" (bus has no Secret Service).
 */
const UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /libsecret not available/i,
  /Security framework not available/i,
  /Credential Manager not available/i,
  /could not connect/i,
  /cannot autolaunch d-bus/i,
  /DBUS_SESSION_BUS_ADDRESS/i,
  /org\.freedesktop\.secrets/i,
];

type ErrorMapper = (
  context: SecretErrorContext,
  code: string,
  detail: string,
  platformCode: number | undefined,
) => F402SecretError;

/**
 * Every error code Bun.secrets can produce (ErrorCode.ts:312-318 plus the argument codes from
 * JSSecrets.cpp:118-265) and the timeout from lib/secrets.ts, each mapped to one named error.
 */
export const F402_SECRET_ERROR_MAP: Readonly<Record<string, ErrorMapper>> = {
  ERR_SECRETS_NOT_FOUND: (context, code, detail, platformCode) =>
    new F402SecretNotFound({
      name: context.name,
      services: [context.service],
      op: context.op,
      bunCode: code,
      detail,
      ...(platformCode === undefined ? {} : { platformCode }),
    }),
  ERR_SECRETS_ACCESS_DENIED: (context, code, detail, platformCode) =>
    platformCode === DARWIN_ERR_SEC_NOT_AVAILABLE
      ? new F402KeychainUnavailable(context, code, detail, platformCode)
      : new F402SecretAccessDenied(context, code, detail, platformCode),
  ERR_SECRETS_AUTH_FAILED: (context, code, detail, platformCode) =>
    new F402SecretAccessDenied(context, code, detail, platformCode),
  ERR_SECRETS_INTERACTION_NOT_ALLOWED: (context, code, detail, platformCode) =>
    new F402SecretInteractionRequired(context, code, detail, platformCode),
  ERR_SECRETS_INTERACTION_REQUIRED: (context, code, detail, platformCode) =>
    new F402SecretInteractionRequired(context, code, detail, platformCode),
  ERR_SECRETS_USER_CANCELED: (context, code, detail, platformCode) =>
    new F402SecretUserCanceled(context, code, detail, platformCode),
  ERR_SECRETS_PLATFORM_ERROR: (context, code, detail, platformCode) =>
    UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))
      ? new F402KeychainUnavailable(context, code, detail, platformCode)
      : new F402SecretBackendError(
          context,
          code,
          detail,
          "platform",
          platformCode,
        ),
  ERR_INVALID_ARG_TYPE: (context, code, detail, platformCode) =>
    new F402SecretInvalidArgument(context, code, detail, platformCode),
  ERR_INVALID_ARG_VALUE: (context, code, detail, platformCode) =>
    new F402SecretInvalidArgument(context, code, detail, platformCode),
  [KEYCHAIN_TIMEOUT_CODE]: (context, code, detail, platformCode) =>
    new F402KeychainUnavailable(context, code, detail, platformCode),
};

function redact(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

/** Bun appends " (code: N)" when the platform gave a status (JSSecrets.cpp:56-62). */
function platformCodeOf(message: string): number | undefined {
  const match = /\(code: (-?\d+)\)\s*$/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Map any throw from Bun.secrets (or the timeout wrapper) to a named error through
 * {@link F402_SECRET_ERROR_MAP}. A code outside the map is kept verbatim on an
 * F402SecretBackendError (`kind: "unknown-code"`); an error with no code at all is
 * `kind: "uncoded"`. `secretValues` are scrubbed from the platform message.
 */
export function classifySecretsError(
  error: unknown,
  context: SecretErrorContext,
  secretValues: readonly string[] = [],
): F402SecretError {
  if (error instanceof F402SecretError) return error;
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code =
    error instanceof KeychainTimeoutError
      ? KEYCHAIN_TIMEOUT_CODE
      : typeof raw?.code === "string"
        ? raw.code
        : undefined;
  const detail = redact(
    typeof raw?.message === "string" ? raw.message : String(error),
    secretValues,
  );
  const platformCode = platformCodeOf(detail);
  if (code === undefined) {
    return new F402SecretBackendError(
      context,
      undefined,
      detail,
      "uncoded",
      platformCode,
    );
  }
  const mapper = Object.hasOwn(F402_SECRET_ERROR_MAP, code)
    ? F402_SECRET_ERROR_MAP[code]
    : undefined;
  if (mapper === undefined) {
    return new F402SecretBackendError(
      context,
      code,
      detail,
      "unknown-code",
      platformCode,
    );
  }
  return mapper(context, code, detail, platformCode);
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
    readonly adapter?: Pick<SecretsAdapter, "get">;
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

/**
 * Write one entry to the canonical service only, with {@link F402_SECRET_SET_POLICY}. A blank
 * value is refused: Bun.secrets treats "" as delete, and reads here treat blank as absent.
 */
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
  if (value.trim() === "") {
    throw new F402SecretBackendError(
      { service, name, op: "set" },
      "F402_EMPTY_VALUE",
      "refusing to store a blank value (Bun.secrets treats an empty value as delete)",
      "empty-value",
    );
  }
  const store = options.adapter ?? adapter;
  const setOptions = {
    service,
    name,
    value,
    persist: F402_SECRET_SET_POLICY.persist,
  };
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

/**
 * Wrap an adapter so `set` and `delete` on the legacy service throw
 * {@link F402LegacyWriteRefused} before reaching the store.
 */
export function legacyReadOnly(store: SecretsAdapter): SecretsAdapter {
  return {
    get: (options) => store.get(options),
    set: async (options) => {
      if (options.service === LEGACY_SECRETS_SERVICE) {
        throw new F402LegacyWriteRefused({ ...options, op: "set" });
      }
      return store.set(options);
    },
    delete: async (options) => {
      if (options.service === LEGACY_SECRETS_SERVICE) {
        throw new F402LegacyWriteRefused({ ...options, op: "delete" });
      }
      return store.delete(options);
    },
  };
}

/**
 * Per-name result of {@link migrateLegacyF402Secrets}:
 * - `copied`: canonical was empty, the legacy value was written there and read back equal.
 * - `already-migrated`: canonical and legacy hold the same value; nothing written.
 * - `canonical-only`: canonical has a value, legacy has none; nothing written.
 * - `canonical-kept`: both have values and they differ; canonical wins and is not overwritten.
 * - `absent`: neither service has a value.
 */
export type MigrationOutcome =
  | "copied"
  | "already-migrated"
  | "canonical-only"
  | "canonical-kept"
  | "absent";

export interface MigrationResult {
  readonly name: string;
  readonly outcome: MigrationOutcome;
}

/**
 * Explicit, opt-in copy of legacy entries into the canonical service. Idempotent: a second run
 * writes nothing and reports `already-migrated`. The legacy service is only read; the adapter is
 * wrapped with {@link legacyReadOnly}. Reports names and outcomes only.
 */
export async function migrateLegacyF402Secrets(
  names: readonly string[],
  options: { readonly adapter?: SecretsAdapter } = {},
): Promise<readonly MigrationResult[]> {
  const store = legacyReadOnly(options.adapter ?? adapter);
  const results: MigrationResult[] = [];
  for (const name of names) {
    const canonical = await readF402SecretStrict(name, {
      adapter: store,
      services: [CANONICAL_SECRETS_SERVICE],
    });
    const legacy = await readF402SecretStrict(name, {
      adapter: store,
      services: [LEGACY_SECRETS_SERVICE],
    });
    if (canonical !== null) {
      results.push({
        name,
        outcome:
          legacy === null
            ? "canonical-only"
            : legacy.value === canonical.value
              ? "already-migrated"
              : "canonical-kept",
      });
      continue;
    }
    if (legacy === null) {
      results.push({ name, outcome: "absent" });
      continue;
    }
    await writeF402Secret(name, legacy.value, { adapter: store });
    const written = await readF402SecretStrict(name, {
      adapter: store,
      services: [CANONICAL_SECRETS_SERVICE],
    });
    if (written?.value !== legacy.value) {
      throw new F402SecretBackendError(
        { service: CANONICAL_SECRETS_SERVICE, name, op: "set" },
        "F402_MIGRATE_VERIFY_FAILED",
        "the canonical entry did not read back equal to the legacy value after the copy",
        "verify-failed",
      );
    }
    results.push({ name, outcome: "copied" });
  }
  return results;
}

export type ProbeCleanup =
  | { readonly status: "deleted" }
  | { readonly status: "absent" }
  | { readonly status: "failed"; readonly error: F402SecretError };

export type BackendProbe =
  | {
      readonly available: true;
      readonly service: string;
      readonly cleanup: ProbeCleanup;
    }
  | {
      readonly available: false;
      readonly service: string;
      readonly error: F402SecretError;
    };

/**
 * Round-trip a random throwaway entry under `<canonical>.probe-<random>` to see whether this
 * machine has a working store. Never touches the real F402 entries. A failed cleanup is reported,
 * not swallowed.
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
  if (
    service === CANONICAL_SECRETS_SERVICE ||
    service === LEGACY_SECRETS_SERVICE
  ) {
    throw new F402SecretInvalidArgument(
      { service, name: "probe", op: "set" },
      "F402_PROBE_REAL_SERVICE",
      "the probe only writes a throwaway service",
    );
  }
  const name = "probe";
  const value = crypto.randomUUID();
  try {
    await store.set({ service, name, value });
  } catch (error) {
    return {
      available: false,
      service,
      error: classifySecretsError(error, { service, name, op: "set" }, [value]),
    };
  }
  let cleanup: ProbeCleanup;
  try {
    cleanup = (await store.delete({ service, name }))
      ? { status: "deleted" }
      : { status: "absent" };
  } catch (error) {
    cleanup = {
      status: "failed",
      error: classifySecretsError(error, { service, name, op: "delete" }),
    };
  }
  return { available: true, service, cleanup };
}
