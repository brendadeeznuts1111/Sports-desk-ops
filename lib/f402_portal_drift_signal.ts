/**
 * Fail-loud portal bundle drift (signal + throw), not silent SQLite diary only.
 */

import { PROBE_HOST, PINNED_MANAGER_BUST } from "./f402_hierarchy_config.ts";
import {
  classifyBundleDrift,
  fetchPortalArtifactBytes,
} from "./f402_portal_bundle_fetch.ts";
import { collectLiveCdnAssetDrift } from "./f402_cdn_pin.ts";
import { loadPinnedManifest } from "./f402_portal_version_pin.ts";

export const F402_PORTAL_ARTIFACT_DRIFT_SIGNAL =
  "F402_PORTAL_ARTIFACT_DRIFT" as const;

export class PortalArtifactDriftError extends Error {
  readonly signal = F402_PORTAL_ARTIFACT_DRIFT_SIGNAL;
  readonly details: readonly string[];

  constructor(details: readonly string[]) {
    super(
      `${F402_PORTAL_ARTIFACT_DRIFT_SIGNAL}: ${details.join("; ")} (live portal != pinned manifest)`,
    );
    this.name = "PortalArtifactDriftError";
    this.details = details;
  }
}

export function emitPortalArtifactDriftSignal(
  details: readonly string[],
): void {
  const payload = {
    signal: F402_PORTAL_ARTIFACT_DRIFT_SIGNAL,
    ts: Date.now(),
    host: PROBE_HOST,
    details,
  };
  console.error(JSON.stringify(payload));
}

export async function collectLivePortalArtifactDrift(
  baseUrl: string = PROBE_HOST,
  bust: string = PINNED_MANAGER_BUST,
): Promise<string[]> {
  const manifest = await loadPinnedManifest();
  const host = baseUrl.replace(/\/$/, "");
  const keys = ["app/setting/version.js", "app/manager/manager.js"] as const;
  const details: string[] = [];
  for (const key of keys) {
    const pinned = manifest.artifacts[key]?.sha256;
    if (pinned === undefined) continue;
    const url = `${host}/${key}?bust=${bust}`;
    const outcome = await fetchPortalArtifactBytes(url);
    const kind = classifyBundleDrift(pinned, outcome);
    if (kind === "none") continue;
    if (kind === "tls_trust" && outcome.kind === "tls_trust") {
      details.push(`tls_trust ${key}: ${outcome.error}`);
      continue;
    }
    if (kind === "bundle_byte" && outcome.kind === "ok") {
      details.push(
        `bundle_byte ${key}: live ${outcome.sha256} != pinned ${pinned}`,
      );
      continue;
    }
    details.push(`${kind} ${key}: ${JSON.stringify(outcome)}`);
  }
  details.push(...(await collectLiveCdnAssetDrift()));
  return details;
}

/** Records optional; default is throw after stderr signal (not diary-only). */
export async function assertNoLivePortalArtifactDrift(options?: {
  readonly baseUrl?: string;
  readonly bust?: string;
  readonly recordOnly?: boolean;
}): Promise<readonly string[]> {
  const details = await collectLivePortalArtifactDrift(
    options?.baseUrl,
    options?.bust,
  );
  if (details.length === 0) return details;
  emitPortalArtifactDriftSignal(details);
  const recordOnly =
    options?.recordOnly === true ||
    Bun.env.F402_DRIFT_RECORD_ONLY?.trim() === "1";
  if (!recordOnly) {
    throw new PortalArtifactDriftError(details);
  }
  return details;
}
