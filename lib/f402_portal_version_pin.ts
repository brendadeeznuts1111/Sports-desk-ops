/**
 * Hash-pin portal `version.js` / manager bundle (not string bust compare).
 */

import { join } from "node:path";

export interface PinnedManifest {
  readonly schemaVersion: number;
  readonly host: string;
  readonly artifacts: Readonly<
    Record<
      string,
      {
        readonly sha256: string;
        readonly bustQuery?: string;
        readonly bytes?: number;
      }
    >
  >;
}

const MANIFEST_PATH = join(
  import.meta.dir,
  "../verification/manager-boot-oracle/pinned/manifest.json",
);

export async function loadPinnedManifest(): Promise<PinnedManifest> {
  return (await Bun.file(MANIFEST_PATH).json()) as PinnedManifest;
}

export async function sha256HexFile(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

export async function sha256HexText(text: string): Promise<string> {
  return sha256HexFileBytes(new TextEncoder().encode(text));
}

async function sha256HexFileBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

export async function fetchLiveVersionJs(
  baseUrl: string,
  bust = "1.0.280",
): Promise<{ text: string; sha256: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/app/setting/version.js?bust=${bust}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`version.js fetch ${res.status}`);
  const text = await res.text();
  const sha256 = await sha256HexText(text);
  return { text, sha256 };
}

export async function checkPinnedVersionDrift(
  baseUrl: string,
): Promise<{ ok: boolean; pinned: string; live: string; artifact: string }> {
  const manifest = await loadPinnedManifest();
  const artifact = "app/setting/version.js";
  const pinned = manifest.artifacts[artifact]?.sha256;
  if (pinned === undefined) {
    throw new Error(`manifest missing ${artifact}`);
  }
  const live = await fetchLiveVersionJs(baseUrl);
  return {
    ok: live.sha256 === pinned,
    pinned,
    live: live.sha256,
    artifact,
  };
}

export async function checkPinnedManagerDrift(
  baseUrl: string,
  bust = "1.0.280",
): Promise<{ ok: boolean; pinned: string; live: string }> {
  const manifest = await loadPinnedManifest();
  const pinned = manifest.artifacts["app/manager/manager.js"]?.sha256;
  if (pinned === undefined) throw new Error("manifest missing manager.js");
  const url = `${baseUrl.replace(/\/$/, "")}/app/manager/manager.js?bust=${bust}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manager.js fetch ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const live = await sha256HexFileBytes(bytes);
  return { ok: live === pinned, pinned, live };
}

export async function recordPinnedArtifactDrift(
  auditDbPath: string,
  baseUrl: string,
  recordDrift: (path: string, kind: string, detail: string) => void,
  bust = "1.0.280",
): Promise<readonly string[]> {
  const { collectLivePortalArtifactDrift, emitPortalArtifactDriftSignal } =
    await import("./f402_portal_drift_signal.ts");
  const details = await collectLivePortalArtifactDrift(baseUrl, bust);
  for (const detail of details) {
    const kind = detail.startsWith("version.js")
      ? "version_js_hash"
      : "manager_js_hash";
    recordDrift(auditDbPath, kind, detail);
  }
  if (details.length > 0) {
    emitPortalArtifactDriftSignal(details);
  }
  return details;
}
