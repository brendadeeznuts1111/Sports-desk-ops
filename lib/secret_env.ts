/**
 * @file lib/secret_env.ts
 * @description One registry and one precedence for the credentials this repo keeps in the OS
 * keychain (`Bun.secrets`) and hands to tools as environment variables.
 *
 * Bun's own guidance (https://bun.com/docs/runtime/secrets): the keychain is for local
 * development, plain environment variables are for CI and production, and the documented pattern
 * is `await secrets.get(...) || process.env.X`. This module fixes the precedence to
 * **environment first, keychain fills the gaps**, so CI, `bun --env-file=...` and the 1Password
 * pipe can always override a stored value.
 *
 * Nothing here returns a value to be logged: reports carry names and sources only.
 */

import {
  CANONICAL_SECRETS_SERVICE,
  LEGACY_SECRETS_SERVICE,
  readSecretWithSource,
} from "./secrets.ts";
import {
  getSecretsForGroup,
  SECRET_GROUPS,
  SECRET_MANIFEST,
} from "./secret_manifest.ts";
import type { SecretDefinition } from "./secret_manifest.ts";
import { UsageError } from "./usage_error.ts";

/**
 * Credentials a child process may be handed, derived from `lib/secret_manifest.ts`: the entries
 * marked `inject`, grouped by `--with` group. The keychain entry is `keychainName` under the
 * canonical service (legacy service read as a fallback), the layout `secrets:r2` seeds.
 *
 * Absent by design: F402 (`inject: false`). Env credentials are policy-gated there (only with
 * `F402_ALLOW_ENV_CREDENTIALS=1`, see types/env.d.ts) and the F402 scripts read the keychain
 * themselves, so injecting them into arbitrary children would undo that rule.
 */
function injectableGroups(): Record<string, readonly string[]> {
  const groups: Record<string, readonly string[]> = {};
  for (const group of SECRET_GROUPS) {
    const names = getSecretsForGroup(group)
      .filter((secret) => secret.inject)
      .map((secret) => String(secret.envName));
    if (names.length > 0) groups[group] = names;
  }
  return groups;
}

export const SECRET_ENV_GROUPS: Readonly<Record<string, readonly string[]>> =
  injectableGroups();

export type SecretEnvGroup = string;

/** Pre-rename names, read as a fallback and injected under the registry name. */
export const SECRET_ENV_ALIASES: Readonly<
  Record<string, readonly string[] | undefined>
> = Object.fromEntries(
  SECRET_MANIFEST.filter((secret) => secret.aliases !== undefined).map(
    (secret) => [secret.envName, secret.aliases],
  ),
);

/** Every name the registry can inject, de-duplicated and sorted. */
export const SECRET_ENV_NAMES: readonly string[] = [
  ...new Set(Object.values(SECRET_ENV_GROUPS).flat()),
].sort();

function definitionFor(name: string): SecretDefinition | undefined {
  return SECRET_MANIFEST.find((secret) => secret.envName === name);
}

function isGroup(token: string): boolean {
  return Object.hasOwn(SECRET_ENV_GROUPS, token);
}

/**
 * Expand `--with` tokens (group names or variable names) to a sorted, unique list of names.
 * An unknown token is a usage error: a typo must not silently inject nothing.
 */
export function expandSecretSelection(tokens: readonly string[]): string[] {
  const names = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "") continue;
    if (isGroup(token)) {
      for (const name of SECRET_ENV_GROUPS[token] ?? []) names.add(name);
    } else if (SECRET_ENV_NAMES.includes(token)) {
      names.add(token);
    } else {
      throw new UsageError(
        `unknown secret or group "${token}" (groups: ${Object.keys(SECRET_ENV_GROUPS).join(", ")}; names: ${SECRET_ENV_NAMES.join(", ")})`,
      );
    }
  }
  return [...names].sort();
}

export type SecretSource =
  | { readonly kind: "env"; readonly via?: string }
  | {
      readonly kind: "keychain";
      readonly service: string;
      readonly via?: string;
    }
  | { readonly kind: "missing" }
  /** Environment-only secret that is not set: there is no keychain entry to look in. */
  | { readonly kind: "unset" };

export interface SecretReportRow {
  readonly name: string;
  readonly source: SecretSource;
}

export interface ResolvedSecretEnv {
  /** Only the names that resolved. Treat as secret: never log. */
  readonly env: Readonly<Record<string, string>>;
  /** Names and sources for every requested name, including the missing ones. */
  readonly report: readonly SecretReportRow[];
}

export interface ResolveSecretEnvOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable for tests; defaults to the canonical-then-legacy keychain read. */
  readonly read?: (
    name: string,
  ) => Promise<{ readonly value: string; readonly service: string } | null>;
}

type Found =
  | { readonly kind: "env"; readonly value: string; readonly via?: string }
  | {
      readonly kind: "keychain";
      readonly value: string;
      readonly service: string;
      readonly via?: string;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "unset" };

type KeychainRead = NonNullable<ResolveSecretEnvOptions["read"]>;

/**
 * Where one variable's value would come from: the environment (the name, then any pre-rename
 * alias), then the keychain entry the manifest names (then the alias as a keychain name).
 */
async function lookup(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  read: KeychainRead,
): Promise<Found> {
  const definition = definitionFor(name);
  const aliases = definition?.aliases ?? [];
  const viaOf = (candidate: string) =>
    candidate === name ? {} : { via: candidate };
  for (const candidate of [name, ...aliases]) {
    const value = (env[candidate] ?? "").trim();
    if (value !== "") return { kind: "env", value, ...viaOf(candidate) };
  }
  const keychainName =
    definition === undefined ? name : definition.keychainName;
  if (keychainName === null) return { kind: "unset" };
  const entries = [keychainName, ...aliases];
  for (const entry of entries) {
    const stored = await read(entry);
    if (stored !== null) {
      return {
        kind: "keychain",
        value: stored.value,
        service: stored.service,
        ...(entry === keychainName ? {} : { via: entry }),
      };
    }
  }
  return { kind: "missing" };
}

/** One row per manifest entry, injectable or not: the answer to "did we track every key?". */
export interface ManifestStatusRow {
  readonly name: string;
  readonly groups: readonly string[];
  readonly injectable: boolean;
  readonly source: SecretSource;
}

export async function manifestStatus(
  options: ResolveSecretEnvOptions = {},
): Promise<ManifestStatusRow[]> {
  const env = options.env ?? Bun.env;
  const read = options.read ?? readSecretWithSource;
  const rows: ManifestStatusRow[] = [];
  for (const secret of SECRET_MANIFEST) {
    const found = await lookup(secret.envName, env, read);
    const source: SecretSource =
      found.kind === "env"
        ? {
            kind: "env",
            ...(found.via === undefined ? {} : { via: found.via }),
          }
        : found.kind === "keychain"
          ? {
              kind: "keychain",
              service: found.service,
              ...(found.via === undefined ? {} : { via: found.via }),
            }
          : { kind: found.kind };
    rows.push({
      name: secret.envName,
      groups: secret.groups,
      injectable: secret.inject,
      source,
    });
  }
  return rows;
}

/** Environment first (non-blank), then the keychain. */
export async function resolveSecretEnv(
  names: readonly string[],
  options: ResolveSecretEnvOptions = {},
): Promise<ResolvedSecretEnv> {
  const env = options.env ?? Bun.env;
  const read = options.read ?? readSecretWithSource;
  const resolved: Record<string, string> = {};
  const report: SecretReportRow[] = [];
  for (const name of names) {
    const source = await lookup(name, env, read);
    if (source.kind === "env" || source.kind === "keychain") {
      resolved[name] = source.value;
      report.push({
        name,
        source:
          source.kind === "env"
            ? {
                kind: "env",
                ...(source.via === undefined ? {} : { via: source.via }),
              }
            : {
                kind: "keychain",
                service: source.service,
                ...(source.via === undefined ? {} : { via: source.via }),
              },
      });
    } else {
      report.push({ name, source });
    }
  }
  return { env: resolved, report };
}

/** `env`, `keychain (com.bookdeskops.sportsdesk)`, or `missing`: safe to print. */
export function describeSource(source: SecretSource): string {
  switch (source.kind) {
    case "env":
      return source.via === undefined ? "env" : `env (as ${source.via})`;
    case "keychain": {
      const where =
        source.service === CANONICAL_SECRETS_SERVICE
          ? "keychain"
          : source.service === LEGACY_SECRETS_SERVICE
            ? "keychain (legacy service)"
            : `keychain (${source.service})`;
      return source.via === undefined ? where : `${where} (as ${source.via})`;
    }
    case "missing":
      return "missing";
    case "unset":
      return "unset (environment only)";
  }
}

/** The child's environment: the parent's, with the resolved secrets layered on top. */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  resolved: ResolvedSecretEnv,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...resolved.env };
}
