/**
 * Fetch pinned portal artifacts under Bun; classify TLS-trust vs bundle-byte drift.
 */

import { F402TlsVerificationError, f402Fetch } from "./f402_fetch_sessions.ts";

export type PortalFetchOutcome =
  | {
      readonly kind: "ok";
      readonly sha256: string;
      readonly bytes: number;
      readonly body: Uint8Array;
    }
  | { readonly kind: "tls_trust"; readonly error: string }
  | { readonly kind: "http_error"; readonly status: number }
  | { readonly kind: "network"; readonly error: string };

export async function fetchPortalArtifactBytes(
  url: string,
): Promise<PortalFetchOutcome> {
  try {
    const res = await f402Fetch(url, { redirect: "follow" });
    if (!res.ok) {
      return { kind: "http_error", status: res.status };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Buffer.from(digest).toString("hex");
    return { kind: "ok", sha256, bytes: bytes.length, body: bytes };
  } catch (e) {
    const msg = String(e);
    if (e instanceof F402TlsVerificationError) {
      return { kind: "tls_trust", error: msg };
    }
    const tlsLike =
      /certificate|cert|TLS|SSL|UNABLE_TO_VERIFY|unknown ca|self signed/i.test(
        msg,
      );
    if (tlsLike) {
      return { kind: "tls_trust", error: msg };
    }
    return { kind: "network", error: msg };
  }
}

export interface PortalBundleDriftRow {
  readonly artifact: string;
  readonly url: string;
  readonly pinnedSha256: string;
  readonly outcome: PortalFetchOutcome;
  readonly driftKind: "none" | "bundle_byte" | "tls_trust" | "unreachable";
}

export function classifyBundleDrift(
  pinnedSha256: string,
  outcome: PortalFetchOutcome,
): PortalBundleDriftRow["driftKind"] {
  if (outcome.kind === "ok") {
    return outcome.sha256 === pinnedSha256 ? "none" : "bundle_byte";
  }
  if (outcome.kind === "tls_trust") return "tls_trust";
  return "unreachable";
}
