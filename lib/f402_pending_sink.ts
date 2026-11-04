/** Bridge 3b sinks: /ws/live-bets channel f402-pending and R2 f402-pending/latest.json. */
import { R2S3Client, resolveSecretBackedEnv } from "./r2_s3_client.ts";
import {
  assertSanitizedPendingArtifact,
  type F402PendingRollup,
} from "./f402_pending_rollup.ts";

export const F402_PENDING_R2_KEY = "f402-pending/latest.json";
export const F402_PENDING_CHANNEL = "f402-pending";
export interface PendingSinkResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  published?: number;
  url?: string;
}
export interface PendingSinkOptions {
  readonly liveBets: boolean;
  readonly r2: boolean;
  readonly gatewayUrl?: string;
  readonly apiToken?: string;
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly r2Client?: R2S3Client | null;
}
export interface PendingSink {
  publishLiveBets(rollup: F402PendingRollup): Promise<PendingSinkResult>;
  publishR2(rollup: F402PendingRollup): Promise<PendingSinkResult>;
}
export function createF402PendingSink(
  options: PendingSinkOptions,
): PendingSink {
  const fetchImpl = options.fetchImpl ?? fetch;
  const gateway = (
    options.gatewayUrl ??
    `http://127.0.0.1:${Bun.env.BLOB_PORT?.trim() || "4021"}`
  ).replace(/\/+$/, "");
  let tokenPromise: Promise<string> | null = null;
  const token = async (): Promise<string> =>
    options.apiToken?.trim() ||
    (tokenPromise ??= resolveSecretBackedEnv().then(
      (e) => e.BLOB_API_TOKEN ?? "",
    ));
  return {
    async publishLiveBets(rollup) {
      if (!options.liveBets) return { ok: true, skipped: true };
      if (rollup.provenance.live !== true) return { ok: true, skipped: true }; // fixtures never enter the live channel
      try {
        assertSanitizedPendingArtifact(rollup);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      const apiToken = await token();
      if (apiToken === "")
        return { ok: false, error: "BLOB_API_TOKEN is not set" };
      try {
        const res = await fetchImpl(`${gateway}/api/v1/live-bets`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: F402_PENDING_CHANNEL,
            event: rollup,
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok)
          return {
            ok: false,
            error: `live-bets gateway returned HTTP ${res.status}`,
          };
        const body = (await res.json()) as { published?: unknown };
        return typeof body.published === "number"
          ? { ok: true, published: body.published }
          : { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async publishR2(rollup) {
      if (!options.r2) return { ok: true, skipped: true };
      try {
        assertSanitizedPendingArtifact(rollup);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
      const client =
        options.r2Client === undefined
          ? await R2S3Client.fromEnvOrSecrets()
          : options.r2Client;
      if (client === null)
        return { ok: false, error: "R2 credentials are unavailable" };
      const body = new TextEncoder().encode(
        `${JSON.stringify(rollup, null, 2)}\n`,
      );
      try {
        await client.writeWithMetadata(F402_PENDING_R2_KEY, body, {
          type: "application/json",
          metadata: {
            pii: "none",
            "schema-version": "1",
            "desk-date": rollup.deskDate,
            "generated-at": rollup.generatedAt,
            sha256: rollup.sourceSha256,
            source: "f402-pending",
          },
        });
        const stat = await client.stat(F402_PENDING_R2_KEY);
        if (stat.size !== body.byteLength)
          return {
            ok: false,
            error: `size mismatch wrote ${body.byteLength} stat ${stat.size}`,
          };
        return { ok: true, url: `${client.publicBase}/${F402_PENDING_R2_KEY}` };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
