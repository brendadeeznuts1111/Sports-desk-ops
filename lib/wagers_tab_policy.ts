/**
 * @file lib/wagers_tab_policy.ts
 * @description Runtime reader for `packages/ui/src/config/wagers.toml`.
 *
 * The UI inlines that TOML at bundle time. The API reads the *same file* at
 * runtime so an operator can verify which panel policy the running server
 * carries without knowing the bundle's content hash:
 *
 *   curl -s http://127.0.0.1:4021/api/wagers | jq -r .policy_version
 *   → wagers-policy/v1
 *
 * `Bun.TOML.parse` is native, and the stat cache means editing the file is
 * picked up on the next request — no restart and no rebuild (the UI still needs
 * its dev watcher to re-bundle). Read the file as text: a file-backed Blob
 * (`Bun.file(path)`) throws in `TOML.parse` on 1.4.4; quoted dates only, since an
 * unquoted date parses to `Temporal.PlainDate`.
 */

import { TOML } from "bun";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_POLICY_PATH = resolve(
  import.meta.dir,
  "../packages/ui/src/config/wagers.toml",
);

export interface WagersTabPolicyStamp {
  /** `[table].policy_tag` — the stable string ops probes for. */
  readonly policy_version: string;
  /** `[meta].schema` — lets a probe tell a schema change from a version bump. */
  readonly policy_schema: string;
}

interface WagersTabPolicyFile {
  readonly meta?: { readonly schema?: unknown } | undefined;
  readonly table?: { readonly policy_tag?: unknown } | undefined;
}

let cached: {
  readonly path: string;
  readonly mtimeMs: number;
  readonly stamp: WagersTabPolicyStamp;
} | null = null;

/** `WAGERS_TAB_POLICY_PATH` overrides the default checkout-relative path. */
export function wagersTabPolicyPath(): string {
  const override = process.env.WAGERS_TAB_POLICY_PATH?.trim();
  return override && override.length > 0 ? override : DEFAULT_POLICY_PATH;
}

/**
 * Read the policy stamp, or `null` when the file is absent (a deployment that
 * ships without the UI package still serves the feed, just without the probe).
 *
 * A present-but-invalid file throws: a silently missing version would make the
 * probe lie, which is worse than an error.
 */
export async function loadWagersTabPolicyStamp(
  path: string = wagersTabPolicyPath(),
): Promise<WagersTabPolicyStamp | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
  if (cached && cached.path === path && cached.mtimeMs === mtimeMs) {
    return cached.stamp;
  }

  const parsed = TOML.parse(await Bun.file(path).text()) as WagersTabPolicyFile;
  const policyVersion = parsed.table?.policy_tag;
  const policySchema = parsed.meta?.schema;
  if (typeof policyVersion !== "string" || policyVersion.trim() === "") {
    throw new Error(
      `${path}: [table].policy_tag must be a non-empty string (the probe reads it)`,
    );
  }
  if (typeof policySchema !== "string" || policySchema.trim() === "") {
    throw new Error(`${path}: [meta].schema must be a non-empty string`);
  }

  const stamp: WagersTabPolicyStamp = {
    policy_version: policyVersion,
    policy_schema: policySchema,
  };
  cached = { path, mtimeMs, stamp };
  return stamp;
}

/** Test/dev helper: forget the stat cache so the next read re-parses. */
export function clearWagersTabPolicyCache(): void {
  cached = null;
}
