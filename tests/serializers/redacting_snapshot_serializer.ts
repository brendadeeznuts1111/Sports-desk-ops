/**
 * @file tests/serializers/redacting_snapshot_serializer.ts
 * @description Snapshot serializers that redact secrets and normalize versions,
 * timestamps, and Date values before a snapshot is stored.
 *
 * Bun 1.4.4 exposes `expect.addSnapshotSerializer` and throws "Not implemented".
 * `installRedactingSnapshotSerializers` still calls it. When that throws, callers
 * snapshot `prepareSnapshot(value)` instead, which runs the same plugins.
 */

import { expect } from "bun:test";

export interface SnapshotSerializerConfig {
  readonly [key: string]: unknown;
}

export type SnapshotPrinter = (
  val: unknown,
  config: SnapshotSerializerConfig,
  indentation: string,
  depth: number,
  refs: unknown[],
) => string;

export interface SnapshotSerializer {
  test(val: unknown): boolean;
  serialize(
    val: unknown,
    config: SnapshotSerializerConfig,
    indentation: string,
    depth: number,
    refs: unknown[],
    printer: SnapshotPrinter,
  ): string;
}

export interface SnapshotRedactionOptions {
  /** Additional raw secret literals to scrub from all string values. */
  readonly extraSecrets?: readonly string[] | undefined;
  /** Replace Bun.version tokens with "[BUN_VERSION]". Default: true. */
  readonly normalizeBunVersion?: boolean | undefined;
  /** Replace ISO-8601 timestamps in strings with "[ISO_TIMESTAMP]". Default: true. */
  readonly normalizeIsoTimestamps?: boolean | undefined;
  /** Replace Date instances with "[ISO_TIMESTAMP]". Default: true. */
  readonly normalizeDates?: boolean | undefined;
}

const REDACTED = "[REDACTED_SECRET]";
const BUN_VERSION_PLACEHOLDER = "[BUN_VERSION]";
const ISO_TIMESTAMP_PLACEHOLDER = "[ISO_TIMESTAMP]";

const SECRET_ENV_KEYS = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
  "F402_AUTH_JWT",
  "F402_BEARER_TOKEN",
  "GSLIVE_SESSION_ID",
  "DATABASE_URL",
] as const;

const SECRET_PROP_KEY_RE =
  /(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|session[_-]?id|jwt)/i;

const BEARER_RE = /\bBearer\s+(?!\[REDACTED_SECRET\])[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_TOKEN_RE =
  /\b(GSLIVE_SESSION_ID|session_id|access_token|refresh_token)=(?!\[REDACTED_SECRET\])[^\s;"'&]+/gi;
const URL_USERINFO_RE = /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const ISO_TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\b/g;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function collectActiveSecrets(extra?: readonly string[]): readonly string[] {
  const found = new Set<string>();
  for (let i = 0; i < SECRET_ENV_KEYS.length; i++) {
    const key = SECRET_ENV_KEYS[i];
    if (key === undefined) continue;
    const val = Bun.env[key];
    // Skip short placeholders (< 8 chars) to avoid corrupting unrelated snapshot text.
    if (typeof val === "string" && val.length >= 8) {
      found.add(val);
    }
  }
  if (extra) {
    for (let i = 0; i < extra.length; i++) {
      const val = extra[i];
      if (val !== undefined && val.length >= 8) {
        found.add(val);
      }
    }
  }
  return [...found];
}

const runtimeExtraSecrets: string[] = [];
let installed = false;
let hooked = false;
let activeSerializers: readonly SnapshotSerializer[] = [];

export function snapshotSerializersHooked(): boolean {
  return hooked;
}

export function createRedactingSnapshotSerializers(
  options: SnapshotRedactionOptions = {},
): readonly SnapshotSerializer[] {
  const normalizeVersion = options.normalizeBunVersion ?? true;
  const normalizeIso = options.normalizeIsoTimestamps ?? true;
  const normalizeDates = options.normalizeDates ?? true;

  const bunVersionRe = new RegExp(
    `(?<![0-9.])${escapeRegExp(Bun.version)}(?![0-9.])`,
    "g",
  );

  const transformString = (input: string): string => {
    let out = input;
    BEARER_RE.lastIndex = 0;
    COOKIE_TOKEN_RE.lastIndex = 0;
    URL_USERINFO_RE.lastIndex = 0;
    ISO_TIMESTAMP_RE.lastIndex = 0;
    bunVersionRe.lastIndex = 0;

    const secrets = collectActiveSecrets(options.extraSecrets);
    for (let i = 0; i < secrets.length; i++) {
      const secret = secrets[i];
      if (secret !== undefined && out.includes(secret)) {
        out = out.replaceAll(secret, REDACTED);
      }
    }

    out = out
      .replace(BEARER_RE, `Bearer ${REDACTED}`)
      .replace(COOKIE_TOKEN_RE, `$1=${REDACTED}`)
      .replace(URL_USERINFO_RE, `$1[REDACTED_USER]:${REDACTED}@`);

    if (normalizeIso) {
      out = out.replace(ISO_TIMESTAMP_RE, ISO_TIMESTAMP_PLACEHOLDER);
    }

    if (normalizeVersion) {
      out = out.replace(bunVersionRe, BUN_VERSION_PLACEHOLDER);
    }

    return out;
  };

  const sanitizedObjects = new WeakSet<object>();

  const objectSecretKeySerializer: SnapshotSerializer = {
    test(val: unknown): boolean {
      if (!isPlainRecord(val) || sanitizedObjects.has(val)) {
        return false;
      }
      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (
          key !== undefined &&
          SECRET_PROP_KEY_RE.test(key) &&
          val[key] !== REDACTED
        ) {
          return true;
        }
      }
      return false;
    },
    serialize(
      val: unknown,
      config: SnapshotSerializerConfig,
      indentation: string,
      depth: number,
      refs: unknown[],
      printer: SnapshotPrinter,
    ): string {
      if (!isPlainRecord(val)) {
        return printer(val, config, indentation, depth, refs);
      }
      const clone: Record<string, unknown> = {};
      const keys = Object.keys(val);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === undefined) continue;
        clone[key] = SECRET_PROP_KEY_RE.test(key) ? REDACTED : val[key];
      }
      sanitizedObjects.add(clone);
      return printer(clone, config, indentation, depth, refs);
    },
  };

  const stringNormalizerSerializer: SnapshotSerializer = {
    test(val: unknown): boolean {
      return typeof val === "string" && transformString(val) !== val;
    },
    serialize(val: unknown): string {
      return JSON.stringify(
        transformString(typeof val === "string" ? val : ""),
      );
    },
  };

  const serializers: SnapshotSerializer[] = [
    objectSecretKeySerializer,
    stringNormalizerSerializer,
  ];

  if (normalizeDates) {
    serializers.push({
      test(val: unknown): boolean {
        return val instanceof Date;
      },
      serialize(): string {
        return JSON.stringify(ISO_TIMESTAMP_PLACEHOLDER);
      },
    });
  }

  return serializers;
}

const emptyConfig: SnapshotSerializerConfig = {};

function materialize(
  val: unknown,
  serializers: readonly SnapshotSerializer[],
  seen: WeakSet<object>,
): unknown {
  if (val !== null && typeof val === "object") {
    if (seen.has(val)) return val;
    seen.add(val);
  }
  for (let i = 0; i < serializers.length; i++) {
    const serializer = serializers[i];
    if (serializer === undefined || !serializer.test(val)) continue;
    if (typeof val === "string" || val instanceof Date) {
      return JSON.parse(
        serializer.serialize(val, emptyConfig, "", 0, [], () => ""),
      ) as unknown;
    }
    let captured: unknown = val;
    serializer.serialize(val, emptyConfig, "", 0, [], (clone) => {
      captured = clone;
      return "";
    });
    return materializeChildren(captured, serializers, seen);
  }
  return materializeChildren(val, serializers, seen);
}

function materializeChildren(
  val: unknown,
  serializers: readonly SnapshotSerializer[],
  seen: WeakSet<object>,
): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => materialize(item, serializers, seen));
  }
  if (!isPlainRecord(val)) return val;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(val);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    out[key] = materialize(val[key], serializers, seen);
  }
  return out;
}

/** Plain value with the installed serializers applied. Bun prints this form. */
export function prepareSnapshot(value: unknown): unknown {
  if (activeSerializers.length === 0) return value;
  return materialize(value, activeSerializers, new WeakSet());
}

function notImplemented(err: unknown): boolean {
  return err instanceof Error && err.message === "Not implemented";
}

export function installRedactingSnapshotSerializers(
  options: SnapshotRedactionOptions = {},
): void {
  if (options.extraSecrets) {
    for (let i = 0; i < options.extraSecrets.length; i++) {
      const val = options.extraSecrets[i];
      if (
        val !== undefined &&
        val.length >= 8 &&
        !runtimeExtraSecrets.includes(val)
      ) {
        runtimeExtraSecrets.push(val);
      }
    }
  }
  if (installed) return;
  installed = true;

  activeSerializers = createRedactingSnapshotSerializers({
    extraSecrets: runtimeExtraSecrets,
    normalizeBunVersion: options.normalizeBunVersion,
    normalizeIsoTimestamps: options.normalizeIsoTimestamps,
    normalizeDates: options.normalizeDates,
  });

  const add = (
    expect as unknown as {
      addSnapshotSerializer?: (serializer: SnapshotSerializer) => void;
    }
  ).addSnapshotSerializer;
  if (typeof add !== "function") return;

  try {
    for (let i = 0; i < activeSerializers.length; i++) {
      const serializer = activeSerializers[i];
      if (serializer !== undefined) add(serializer);
    }
    hooked = true;
  } catch (err) {
    if (!notImplemented(err)) throw err;
    hooked = false;
  }
}
