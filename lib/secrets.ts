/**
 * Secret contract: one place for keychain services, entry names, reads, writes and deletes.
 *
 * The repo migrated to `com.bookdeskops.sportsdesk` and kept older services as read fallbacks.
 * Some entries never moved (F402 is still under `sportsdesk-ops`), so every reader must try the
 * canonical service first and then the legacy services that entry has lived under. Keeping that
 * list here — rather than in each caller — is what stops a reader and the writer disagreeing about
 * where a credential lives.
 *
 * Everything reads through an injectable provider so tests never touch the real keychain.
 * The default provider is `guardedSecrets` from `lib/keychain_access.ts` — the single boundary
 * that denies the OS store in a test process. Do not call `Bun.secrets` directly; a static gate
 * (`tests/keychain_boundary.test.ts`) fails if a new call site bypasses the guard.
 */

import type { BunSecretSetOptions } from "../types/bun-api";
import { guardedSecrets } from "./keychain_access.ts";

/** Where new entries are written. */
export const CANONICAL_SECRETS_SERVICE = "com.bookdeskops.sportsdesk";

/** The pre-migration service; read-only fallback for entries that were never moved. */
export const LEGACY_SECRETS_SERVICE = "sportsdesk-ops";

/** GSID's older legacy home, read by `fetch-bet-tally` before the canonical migration. */
export const GSLIVE_LEGACY_SECRETS_SERVICE = "sportsdesk-gslive";

/** Read order for the GSID: canonical, then both legacy homes. */
export const GSID_SERVICES = [
  CANONICAL_SECRETS_SERVICE,
  GSLIVE_LEGACY_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
] as const;

/** Legacy-only services checked for the Telegram tokens (no canonical entry). */
export const TELEGRAM_SECRET_SERVICES = [
  "bookdeskops.desk",
  LEGACY_SECRETS_SERVICE,
  "4c-odds-integration",
] as const;

/** Names that were previously inlined in scripts; kept here so lib never imports `scripts/`. */
export const F402_KEYCHAIN_NAMES = {
  agentId: "f402-agent-id",
  password: "f402-password",
} as const;

/**
 * Optional player-tier pair (used by `capture:f402 --login-as-player` / getTicketDetailPrint).
 * Written by `secrets:f402 set-player`; readers are canonical-first with the legacy fallback.
 */
export const F402_PLAYER_KEYCHAIN_NAMES = {
  playerId: "f402-player-id",
  password: "f402-player-password",
} as const;

export const GSID_KEYCHAIN_NAME = "GSID" as const;

export interface SecretEntry {
  readonly name: string;
  readonly services: readonly string[];
}

/**
 * Every entry the contract knows. `services[0]` is the write target, so writes always land on
 * canonical while reads walk the full fallback list.
 */
export const SECRET_ENTRIES = {
  f402AgentId: {
    name: F402_KEYCHAIN_NAMES.agentId,
    services: [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE],
  },
  f402Password: {
    name: F402_KEYCHAIN_NAMES.password,
    services: [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE],
  },
  f402PlayerId: {
    name: F402_PLAYER_KEYCHAIN_NAMES.playerId,
    services: [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE],
  },
  f402PlayerPassword: {
    name: F402_PLAYER_KEYCHAIN_NAMES.password,
    services: [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE],
  },
  gsid: { name: GSID_KEYCHAIN_NAME, services: GSID_SERVICES },
  gsliveUsername: {
    name: "GSLIVE_USERNAME",
    services: [CANONICAL_SECRETS_SERVICE],
  },
  gslivePassword: {
    name: "GSLIVE_PASSWORD",
    services: [CANONICAL_SECRETS_SERVICE],
  },
} as const satisfies Record<string, SecretEntry>;

export type SecretEntryId = keyof typeof SECRET_ENTRIES;

/** GSID entries in read order (status/delete walk these). */
export const GSID_SECRET = {
  service: CANONICAL_SECRETS_SERVICE,
  name: GSID_KEYCHAIN_NAME,
} as const;
export const GSID_SECRET_LEGACY = {
  service: GSLIVE_LEGACY_SECRETS_SERVICE,
  name: GSID_KEYCHAIN_NAME,
} as const;
export const GSID_SECRET_LEGACY_BRIDGE = {
  service: LEGACY_SECRETS_SERVICE,
  name: GSID_KEYCHAIN_NAME,
} as const;
export const GSID_SECRET_ENTRIES = [
  GSID_SECRET,
  GSID_SECRET_LEGACY,
  GSID_SECRET_LEGACY_BRIDGE,
] as const;

/* ------------------------------------------------------------------------- */
/* Types shared by the F402 scripts and lib                                    */
/* ------------------------------------------------------------------------- */

export interface F402Credentials {
  readonly agentId: string;
  readonly password: string;
}

export class MissingF402CredentialsError extends Error {
  constructor() {
    super(
      "F402 login requires keychain (secrets:f402), TTY prompt, or a bootstrapped WebView profile (values are not printed)",
    );
    this.name = "MissingF402CredentialsError";
  }
}

/** Minimal injectable read surface so tests never touch the real keychain. */
export interface SecretsReader {
  get(options: { service: string; name: string }): Promise<string | null>;
}

/**
 * The read surface taken from Bun's own declaration (`Secrets.get(options: Bun.SecretsOptions)`)
 * instead of re-declared: a hand-written interface is how a cast sneaks in.
 */
export type SecretsProvider = Pick<typeof Bun.secrets, "get">;
export type SecretsWriter = Pick<typeof Bun.secrets, "set">;
export type SecretsDeleter = Pick<typeof Bun.secrets, "delete">;

/* ------------------------------------------------------------------------- */
/* Validation and write options (moved here from lib/r2_s3_client.ts)          */
/* ------------------------------------------------------------------------- */

export const MAX_SECRET_FIELD_CHARS = 255;
export const MAX_SECRET_VALUE_BYTES = 2048;

/** Bun.secrets service/name guard: non-empty printable ASCII, shorter than 256 chars. */
export function assertSecretField(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_SECRET_FIELD_CHARS ||
    !/^[\x20-\x7E]+$/.test(value)
  ) {
    throw new Error(
      `${label} must be 1..${MAX_SECRET_FIELD_CHARS} printable ASCII characters`,
    );
  }
}

export function assertSecretValue(value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes === 0 || bytes > MAX_SECRET_VALUE_BYTES) {
    throw new Error(
      `secret value must be 1..${MAX_SECRET_VALUE_BYTES} UTF-8 bytes`,
    );
  }
}

/** Options for Bun.secrets.set: validates bounds and always persists locally. */
export function secretSetOptions(
  service: string,
  name: string,
  value: string,
): BunSecretSetOptions {
  assertSecretField(service, "service");
  assertSecretField(name, "name");
  assertSecretValue(value);
  return { service, name, value, persist: "local" };
}

/* ------------------------------------------------------------------------- */
/* Reads                                                                      */
/* ------------------------------------------------------------------------- */

let provider: SecretsProvider = guardedSecrets;

/** Swap the provider (tests) or restore the guarded default (`null`). */
export function setSecretsProviderForTests(next: SecretsProvider | null): void {
  provider = next ?? guardedSecrets;
}

/** One service/name read; a locked or unavailable keychain is `null`, never a throw. */
export async function readSecretOrNull(
  service: string,
  name: string,
  reader: SecretsReader = provider,
): Promise<string | null> {
  try {
    const value = await reader.get({ service, name });
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** Walk `services` in order and return the first non-empty value with its service. */
export async function readSecretFrom(
  reader: SecretsReader,
  services: readonly string[],
  name: string,
): Promise<{ readonly value: string; readonly service: string } | null> {
  for (const service of services) {
    const value = await readSecretOrNull(service, name, reader);
    if (value !== null) return { value, service };
  }
  return null;
}

/** Read one known entry through its full service fallback list. */
export async function readSecretEntryWithSource(
  entry: SecretEntry,
  reader: SecretsReader = provider,
): Promise<{ readonly value: string; readonly service: string } | null> {
  return readSecretFrom(reader, entry.services, entry.name);
}

/** Value-only read for one known entry. */
export async function readSecretEntry(
  entry: SecretEntry,
  reader: SecretsReader = provider,
): Promise<string | null> {
  return (await readSecretEntryWithSource(entry, reader))?.value ?? null;
}

/** Canonical-then-legacy read for the generic F402/R2 entries. */
export async function readSecretWithSource(
  name: string,
  reader: SecretsReader = provider,
): Promise<{ readonly value: string; readonly service: string } | null> {
  return readSecretFrom(
    reader,
    [CANONICAL_SECRETS_SERVICE, LEGACY_SECRETS_SERVICE],
    name,
  );
}

/** Value-only canonical-then-legacy read. */
export async function readSecretCanonicalThenLegacy(
  name: string,
  reader: SecretsReader = provider,
): Promise<string | null> {
  return (await readSecretWithSource(name, reader))?.value ?? null;
}

/** Read the GSID across all three services it has lived under. */
export async function readGsidSecret(
  reader: SecretsReader = provider,
): Promise<string | null> {
  return readSecretEntry(SECRET_ENTRIES.gsid, reader);
}

/* ------------------------------------------------------------------------- */
/* Writes and deletes                                                         */
/* ------------------------------------------------------------------------- */

/** Write one entry to its canonical service with bounds validation and `persist: "local"`. */
export async function writeSecret(
  entry: SecretEntry,
  value: string,
  writer: SecretsWriter = guardedSecrets,
): Promise<void> {
  const service = entry.services[0];
  if (service === undefined) {
    throw new Error(`secret entry "${entry.name}" has no service to write to`);
  }
  await writer.set(secretSetOptions(service, entry.name, value));
}

/** Delete one entry from every service it has lived under; returns the removed count. */
export async function deleteSecret(
  entry: SecretEntry,
  deleter: SecretsDeleter = guardedSecrets,
): Promise<number> {
  let removed = 0;
  for (const service of entry.services) {
    try {
      if (await deleter.delete({ service, name: entry.name })) removed += 1;
    } catch {
      // A locked or unavailable keychain is not a deletion failure by itself.
    }
  }
  return removed;
}
