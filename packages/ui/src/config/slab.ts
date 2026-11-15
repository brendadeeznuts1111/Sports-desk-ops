/**
 * @file packages/ui/src/config/slab.ts
 * @description Build-time guard for the frontend slab capability.
 *
 * `config/slab.toml` (server) may set `unsafe.allowed = true` because the server
 * can use `Bun.allocUnsafe`. The browser bundle must not inherit that: this
 * module validates the frontend TOML at load time and throws if the capability
 * ever flips. Bun inlines the table at bundle time, so the check costs nothing at
 * runtime and cannot be disabled by a caller.
 */

import { meta, unsafe } from "./slab.frontend.toml";

export const SLAB_FRONTEND_SCHEMA = "sportsdesk-slab-frontend/v1" as const;

export interface FrontendSlab {
  readonly meta: {
    readonly schema: string;
    readonly version: string;
    readonly generated_at: string;
  };
  readonly unsafe: { readonly allowed: false };
}

export function createFrontendSlab(source: unknown): FrontendSlab {
  if (typeof source !== "object" || source === null) {
    throw new TypeError("frontend slab config must be a table");
  }
  const { meta: metaTable, unsafe: unsafeTable } = source as {
    readonly meta?: unknown;
    readonly unsafe?: unknown;
  };
  if (typeof metaTable !== "object" || metaTable === null) {
    throw new TypeError("frontend slab meta must be a table");
  }
  const metaRec = metaTable as Record<string, unknown>;
  if (metaRec["schema"] !== SLAB_FRONTEND_SCHEMA) {
    throw new TypeError(
      `frontend slab meta.schema must be "${SLAB_FRONTEND_SCHEMA}"`,
    );
  }
  if (
    typeof metaRec["generated_at"] !== "string" ||
    Number.isNaN(Date.parse(metaRec["generated_at"]))
  ) {
    throw new TypeError("frontend slab meta.generated_at must be ISO-8601");
  }
  if (
    typeof unsafeTable !== "object" ||
    unsafeTable === null ||
    (unsafeTable as { allowed?: unknown }).allowed !== false
  ) {
    // A browser bundle has no Bun.allocUnsafe slabs.
    throw new TypeError(
      "frontend slab unsafe.allowed must be false; the browser bundle cannot use unsafe slabs",
    );
  }
  return Object.freeze({
    meta: Object.freeze({
      schema: SLAB_FRONTEND_SCHEMA,
      version: String(metaRec["version"] ?? ""),
      generated_at: metaRec["generated_at"],
    }),
    unsafe: Object.freeze({ allowed: false as const }),
  });
}

/** The committed frontend slab, validated at bundle time. */
export const SLAB_FRONTEND: FrontendSlab = createFrontendSlab({ meta, unsafe });
