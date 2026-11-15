/**
 * @file lib/slab_config.ts
 * @description Validated adapter for `config/slab.toml` — the server slab policy.
 *
 * TOML is the SSOT for fixed-capacity read windows, wire sentinels and the
 * relative paths the server may read.
 *
 * Load it by text. `Bun.TOML.parse(Bun.file(...))` throws ("File blob cannot be
 * used here"); `new Blob([text])` is accepted but the adapters read text.
 * Parse-level facts measured on 1.4.4 (https://bun.com/reference/bun/TOML):
 * unquoted dates become Temporal.* and integers outside ±(2^53 − 1) throw. So a
 * BigInt64 column sentinel must be a string parsed outside TOML, and
 * `assertSafeInt` remains a backstop for programmatic input that never went
 * through `parse`.
 *
 * The adapter is the chokepoint for user-supplied paths: `assertRelativePath`
 * rejects absolute paths and `..` traversal before a value can reach the
 * filesystem or the wire-contract payload.
 */

import { isAbsolute, posix } from "node:path";
import { capacity, meta, paths, sentinels, unsafe } from "../config/slab.toml";

export const SLAB_SCHEMA = "sportsdesk-slab/v1" as const;
/** 64 MiB: a window larger than this is a configuration error, not a budget. */
const MAX_WINDOW_BYTES = 64 * 1024 * 1024;

export interface ServerSlab {
  readonly meta: {
    readonly schema: string;
    readonly version: string;
    readonly generated_at: string;
  };
  readonly unsafe: { readonly allowed: boolean };
  readonly paths: { readonly wire_contract: string };
  readonly capacity: { readonly ticker_window_bytes: number };
  readonly sentinels: {
    readonly null_clv: number;
    readonly null_customer_handle32: number;
    readonly null_bridge_channel_word32: number;
  };
}

export class SlabConfigError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SlabConfigError";
  }
}

/** Reject any integer TOML cannot represent exactly. */
export function assertSafeInt(
  value: unknown,
  label: string,
  bounds: { readonly min: number; readonly max: number } = {
    min: Number.MIN_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER,
  },
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SlabConfigError(
      `${label} must be a safe integer (got ${String(value)})`,
    );
  }
  if (value < bounds.min || value > bounds.max) {
    throw new SlabConfigError(
      `${label} must be in [${bounds.min}, ${bounds.max}] (got ${value})`,
    );
  }
  return value;
}

/** Reject absolute paths and `..` traversal; return the normalized path. */
export function assertRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SlabConfigError(`${label} must be a non-empty string`);
  }
  const candidate = value.trim();
  if (isAbsolute(candidate) || posix.isAbsolute(candidate)) {
    throw new SlabConfigError(`${label} must be relative, got absolute path`);
  }
  const segments = candidate.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new SlabConfigError(`${label} must not contain ".."`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one parsed slab table; returns a frozen snapshot. */
export function createServerSlab(source: unknown): ServerSlab {
  if (!isRecord(source)) {
    throw new SlabConfigError("slab config must be a table");
  }
  const metaTable = source["meta"];
  if (!isRecord(metaTable)) {
    throw new SlabConfigError("meta must be a table");
  }
  if (metaTable["schema"] !== SLAB_SCHEMA) {
    throw new SlabConfigError(`meta.schema must be "${SLAB_SCHEMA}"`);
  }
  if (
    typeof metaTable["generated_at"] !== "string" ||
    Number.isNaN(Date.parse(metaTable["generated_at"]))
  ) {
    throw new SlabConfigError("meta.generated_at must be an ISO-8601 string");
  }

  const unsafeTable = source["unsafe"];
  if (!isRecord(unsafeTable) || typeof unsafeTable["allowed"] !== "boolean") {
    throw new SlabConfigError("unsafe.allowed must be a boolean");
  }

  const pathsTable = source["paths"];
  if (!isRecord(pathsTable)) {
    throw new SlabConfigError("paths must be a table");
  }
  const wireContract = assertRelativePath(
    pathsTable["wire_contract"],
    "paths.wire_contract",
  );

  const capacityTable = source["capacity"];
  if (!isRecord(capacityTable)) {
    throw new SlabConfigError("capacity must be a table");
  }
  const tickerWindow = assertSafeInt(
    capacityTable["ticker_window_bytes"],
    "capacity.ticker_window_bytes",
    { min: 1, max: MAX_WINDOW_BYTES },
  );

  const sentinelsTable = source["sentinels"];
  if (!isRecord(sentinelsTable)) {
    throw new SlabConfigError("sentinels must be a table");
  }
  const int32 = { min: -2147483648, max: 2147483647 };
  const uint32 = { min: 0, max: 4294967295 };

  return Object.freeze({
    meta: Object.freeze({
      schema: SLAB_SCHEMA,
      version: String(metaTable["version"] ?? ""),
      generated_at: metaTable["generated_at"],
    }),
    unsafe: Object.freeze({ allowed: unsafeTable["allowed"] }),
    paths: Object.freeze({ wire_contract: wireContract }),
    capacity: Object.freeze({ ticker_window_bytes: tickerWindow }),
    sentinels: Object.freeze({
      null_clv: assertSafeInt(
        sentinelsTable["null_clv"],
        "sentinels.null_clv",
        int32,
      ),
      null_customer_handle32: assertSafeInt(
        sentinelsTable["null_customer_handle32"],
        "sentinels.null_customer_handle32",
        uint32,
      ),
      null_bridge_channel_word32: assertSafeInt(
        sentinelsTable["null_bridge_channel_word32"],
        "sentinels.null_bridge_channel_word32",
        uint32,
      ),
    }),
  });
}

/** Parse TOML text and validate it. A fresh object per call — see tests. */
export function parseServerSlab(text: string): ServerSlab {
  return createServerSlab(Bun.TOML.parse(text));
}

/** The committed server slab, validated at module load. */
export const SLAB_SERVER: ServerSlab = createServerSlab({
  meta,
  unsafe,
  paths,
  capacity,
  sentinels,
});
