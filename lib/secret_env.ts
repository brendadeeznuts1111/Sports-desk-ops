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
import { UsageError } from "./usage_error.ts";

/**
 * Credentials a child process may be handed. The keychain entry is named after the variable, under
 * the canonical service (legacy service read as a fallback), the same layout `secrets:r2` seeds.
 *
 * Deliberately absent: `F402_PASSWORD` / `F402_AGENT_ID`. Those are policy-gated (env credentials
 * only with `F402_ALLOW_ENV_CREDENTIALS=1`, see types/env.d.ts) and the F402 scripts read the
 * keychain themselves, so injecting them into arbitrary children would undo that rule.
 */
export const SECRET_ENV_GROUPS = {
  r2: [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_BUCKET_NAME",
  ],
  pages: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  blob: ["BLOB_API_TOKEN", "BLOB_TICKET_SECRET"],
  gslive: ["GSID"],
  daemon: ["SPORTSDESK_ADMIN_TOKEN"],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type SecretEnvGroup = keyof typeof SECRET_ENV_GROUPS;

/** Every name the registry knows, de-duplicated and sorted. */
export const SECRET_ENV_NAMES: readonly string[] = [
  ...new Set(Object.values(SECRET_ENV_GROUPS).flat()),
].sort();

function isGroup(token: string): token is SecretEnvGroup {
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
      for (const name of SECRET_ENV_GROUPS[token]) names.add(name);
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
  | { readonly kind: "env" }
  | { readonly kind: "keychain"; readonly service: string }
  | { readonly kind: "missing" };

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
    const fromEnv = (env[name] ?? "").trim();
    if (fromEnv !== "") {
      resolved[name] = fromEnv;
      report.push({ name, source: { kind: "env" } });
      continue;
    }
    const stored = await read(name);
    if (stored === null) {
      report.push({ name, source: { kind: "missing" } });
      continue;
    }
    resolved[name] = stored.value;
    report.push({
      name,
      source: { kind: "keychain", service: stored.service },
    });
  }
  return { env: resolved, report };
}

/** `env`, `keychain (com.bookdeskops.sportsdesk)`, or `missing`: safe to print. */
export function describeSource(source: SecretSource): string {
  switch (source.kind) {
    case "env":
      return "env";
    case "keychain":
      return source.service === CANONICAL_SECRETS_SERVICE
        ? "keychain"
        : source.service === LEGACY_SECRETS_SERVICE
          ? "keychain (legacy service)"
          : `keychain (${source.service})`;
    case "missing":
      return "missing";
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
