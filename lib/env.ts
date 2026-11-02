import { asDatabaseURL, type DatabaseURL } from "./urls.ts";

export type EnvName =
  "SPORTSDESK_SCHEMA_DB" | "SPORTSDESK_DB" | "SPORTSDESK_STRICT";

export interface EnvVar<N extends EnvName> {
  readonly name: N;
  readonly value: string;
}

export function env<const N extends EnvName>(name: N): EnvVar<N> {
  const value = Bun.env[name];
  if (value === undefined) {
    throw new Error(`missing env: ${name}`);
  }
  return { name, value };
}

export function envOptional<const N extends EnvName>(
  name: N,
): EnvVar<N> | undefined {
  const value = Bun.env[name];
  if (value === undefined) return undefined;
  return { name, value };
}

export function schemaDatabaseUrlFromEnv(): DatabaseURL | undefined {
  const v = envOptional("SPORTSDESK_SCHEMA_DB") ?? envOptional("SPORTSDESK_DB");
  return v === undefined ? undefined : asDatabaseURL(v.value);
}

/* -------------------------------------------------------------------------- */
/* Numeric boundaries                                                         */
/* -------------------------------------------------------------------------- */

export type ParsedPositiveInt = {
  readonly value: number;
  /** Why the raw value was rejected, or null when it was absent or usable. */
  readonly problem: string | null;
};

/**
 * Pure: turn one optional environment string into a positive integer.
 *
 * Absent or blank means "use the default" and is not a problem. Present but unusable is a
 * problem the caller must surface — `Number("abc")` is NaN, and a NaN deadline never expires:
 * `Date.now() > NaN` is false forever, so a capture waits on a promise that can never reject.
 */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  label = "value",
): ParsedPositiveInt {
  const text = raw?.trim() ?? "";
  if (text === "") return { value: fallback, problem: null };
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      value: fallback,
      problem: `${label}="${text}" is not a positive number; using ${fallback}`,
    };
  }
  return { value: Math.floor(parsed), problem: null };
}

/**
 * Boundary: read a positive integer from the environment once, warning when it is malformed.
 *
 * `read` is injectable so tests exercise the parser without mutating `Bun.env`.
 */
export function envPositiveInt(
  name: string,
  fallback: number,
  read: (name: string) => string | undefined = (key) => Bun.env[key],
): number {
  const parsed = parsePositiveInt(read(name), fallback, name);
  if (parsed.problem !== null) console.warn(`[env] ${parsed.problem}`);
  return parsed.value;
}
