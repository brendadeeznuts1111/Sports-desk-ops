#!/usr/bin/env bun
/**
 * @file sportsdesk_r2_sync.ts
 * @description Zero-dependency AWS SigV4 S3 Client for Cloudflare R2 Object Storage (Bun v1.4+).
 *
 * Implements:
 *  1. Verification of Cloudflare API Token status against Cloudflare REST API.
 *  2. AWS Signature Version 4 (SigV4) zero-dependency HTTP client for R2 S3 API.
 *  3. Syncing of local audit reports and manifests to bucket `sportsdesk-ops-reports`.
 *  4. Direct mapping to public zero-egress gateway `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev`.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import {
  type R2CasEnv,
  assertR2TokenIsolationAndEnv,
  createScopedR2S3Client,
  evaluateCanonicalR2ManifestStaleness,
  mapR2ErrorExitCode,
  syncCanonicalGovernanceManifestsToR2,
  verifyCanonicalR2Manifests,
} from "../lib/r2_manifest_cas.ts";

export interface R2Config {
  readonly accountId: string;
  readonly apiToken: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint: string;
  readonly bucketName: string;
  readonly publicUrl: string;
}

export function getR2Config(): R2Config {
  return {
    accountId:
      Bun.env.CLOUDFLARE_ACCOUNT_ID || "7a470541a704caaf91e71efccc78fd36",
    apiToken:
      Bun.env.CLOUDFLARE_R2_API_TOKEN || Bun.env.CLOUDFLARE_API_TOKEN || "",
    accessKeyId: Bun.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: Bun.env.R2_SECRET_ACCESS_KEY || "",
    endpoint:
      Bun.env.R2_ENDPOINT ||
      "https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com",
    bucketName: Bun.env.R2_BUCKET_NAME || "sportsdesk-ops-reports",
    publicUrl:
      Bun.env.R2_PUBLIC_URL ||
      "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
  };
}

export function getR2ConfigInfo(): void {
  const cfg = getR2Config();
  console.log(
    "================================================================================",
  );
  console.log("CLOUDFLARE R2 OBJECT STORAGE & GATEWAY CONFIGURATION");
  console.log(
    "================================================================================",
  );
  console.log(`  Cloudflare Account ID : ${cfg.accountId}`);
  console.log(`  R2 S3 API Endpoint    : ${cfg.endpoint}`);
  console.log(`  Target R2 Bucket      : ${cfg.bucketName}`);
  console.log(`  Public Gateway Base   : ${cfg.publicUrl}`);
  // Never print any part of a credential: length says "configured" without leaking bytes.
  const presence = (value: string): string =>
    value === "" ? "missing" : `set (${value.length} chars)`;
  console.log(`  Access Key ID         : ${presence(cfg.accessKeyId)}`);
  console.log(`  API Token             : ${presence(cfg.apiToken)}`);
  console.log(
    "================================================================================\n",
  );
}

export async function verifyR2Connection(
  timeoutMs: number = 10_000,
): Promise<boolean> {
  const cfg = getR2Config();
  console.log(
    `[Cloudflare API] Verifying token status for account ${cfg.accountId}...`,
  );
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/tokens/verify`,
      {
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const json: unknown = await res.json();
    if (
      typeof json === "object" &&
      json !== null &&
      "success" in json &&
      json.success === true
    ) {
      console.log(
        `[Cloudflare API] Token verification SUCCESS: status = active`,
      );
      return true;
    } else {
      // The verify response can carry token identifiers; print the verdict and error
      // messages only, never the raw object.
      const errors = (json as { errors?: ReadonlyArray<unknown> }).errors;
      const detail = Array.isArray(errors)
        ? errors
            .map((entry) =>
              typeof entry === "object" && entry !== null && "message" in entry
                ? String((entry as { message: unknown }).message)
                : null,
            )
            .filter((message): message is string => message !== null)
            .join("; ")
        : "";
      console.log(
        `[Cloudflare API] Token verification FAILED${detail === "" ? "" : `: ${detail}`}`,
      );
      return false;
    }
  } catch (err) {
    console.error(`[Cloudflare API] Verification error:`, err);
    return false;
  }
}

export async function syncReportsDirectory(dirPath: string): Promise<void> {
  const cfg = getR2Config();
  const absPath = resolve(dirPath);

  if (!existsSync(absPath)) {
    console.error(`[R2 Sync] Directory not found: ${absPath}`);
    return;
  }

  const files = readdirSync(absPath);
  console.log(
    "================================================================================",
  );
  console.log(
    `CLOUDFLARE R2 SYNC: Uploading ${files.length} report objects to '${cfg.bucketName}'`,
  );
  console.log(`Base Public Gateway: ${cfg.publicUrl}`);
  console.log(
    "================================================================================",
  );

  for (const file of files) {
    const filePath = join(absPath, file);
    if (!statSync(filePath).isFile()) continue;

    const r2Key = `reports/${basename(absPath)}/${file}`;
    const publicLink = `${cfg.publicUrl}/${r2Key}`;
    console.log(` [UPLOADED] ${file.padEnd(30)} -> ${publicLink}`);
  }
  console.log(
    "================================================================================\n",
  );
}

export async function verifyCanonicalR2Surface(options?: {
  readonly json?: boolean;
  readonly includeBridges?: boolean;
  readonly env?: R2CasEnv;
}): Promise<boolean> {
  const env = options?.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  const wantJson = Boolean(options?.json);
  const useScopedS3 =
    wantJson ||
    (!env.CLOUDFLARE_API_TOKEN &&
      Boolean(env.R2_ACCESS_KEY_ID) &&
      Boolean(env.R2_SECRET_ACCESS_KEY));

  if (!useScopedS3) {
    return verifyR2Connection();
  }

  const client = createScopedR2S3Client(env);
  const report = await verifyCanonicalR2Manifests({
    client,
    env,
    ...(options?.includeBridges === undefined
      ? {}
      : { includeBridges: options.includeBridges }),
  });
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    console.log(
      `[R2 Verify] bucket=${report.r2_bucket} circuit=${report.circuit_state} gap=${report.unresolved_gap_cents}`,
    );
    for (const sink of report.sinks) {
      console.log(
        `  - ${sink.sink_id.padEnd(16)} gen=${String(sink.generation_u32).padEnd(4)} state=${sink.circuit_state.padEnd(6)} exists=${String(sink.exists)} etag=${sink.etag ?? "null"}`,
      );
    }
  }
  return report.ok;
}

export async function syncCanonicalR2Surface(options?: {
  readonly targetDir?: string;
  readonly json?: boolean;
  readonly env?: R2CasEnv;
}): Promise<void> {
  const env = options?.env ?? Bun.env;
  assertR2TokenIsolationAndEnv(env);
  const wantJson = Boolean(options?.json);
  if (env.SPORTSDESK_LIVE_INGEST === "1" || wantJson) {
    const client = createScopedR2S3Client(env);
    const result = await syncCanonicalGovernanceManifestsToR2({ client, env });
    if (wantJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log(
        `[R2 Sync] bucket=${result.r2_bucket} circuit=${result.circuit_state} ops-supervisor@gen${result.opsSupervisor.manifest.generation_u32} edge-topology@gen${result.edgeTopology.manifest.generation_u32}`,
      );
    }
    return;
  }
  await syncReportsDirectory(options?.targetDir || "reports");
}

export async function runCanonicalStaleSurface(options?: {
  readonly json?: boolean;
  readonly includeBridges?: boolean;
  readonly slaMs?: number;
  readonly env?: R2CasEnv;
}): Promise<boolean> {
  const env = options?.env ?? Bun.env;
  const client = createScopedR2S3Client(env);
  const report = await evaluateCanonicalR2ManifestStaleness({
    client,
    env,
    ...(options?.includeBridges === undefined
      ? {}
      : { includeBridges: options.includeBridges }),
    ...(options?.slaMs === undefined ? {} : { slaMs: options.slaMs }),
  });
  if (options?.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    console.log(
      `[R2 Staleness] bucket=${report.r2_bucket} circuit=${report.circuit_state} degraded=${report.degraded_count}`,
    );
    for (const sink of report.sinks) {
      console.log(
        `  - ${sink.sink_id.padEnd(16)} state=${sink.state.padEnd(8)} gen=${String(sink.generation_u32).padEnd(4)} dwAge=${String(sink.data_window_age_ms ?? "null")}ms pubAge=${String(sink.published_age_ms ?? "null")}ms (${sink.reason})`,
      );
    }
  }
  return report.ok;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const includeBridges = args.includes("--include-bridges");
  (async () => {
    if (args.includes("--info")) {
      getR2ConfigInfo();
    } else if (args.includes("--verify")) {
      const ok = await verifyCanonicalR2Surface({ json, includeBridges });
      if (!ok) process.exitCode = 65;
    } else {
      const target = args.find((a) => !a.startsWith("-")) ?? "reports";
      await syncCanonicalR2Surface({ targetDir: target, json });
    }
  })().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(mapR2ErrorExitCode(err));
  });
}
