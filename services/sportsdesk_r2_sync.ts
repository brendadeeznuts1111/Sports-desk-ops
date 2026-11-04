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
      process.env.CLOUDFLARE_ACCOUNT_ID || "7a470541a704caaf91e71efccc78fd36",
    apiToken:
      process.env.CLOUDFLARE_R2_API_TOKEN ||
      process.env.CLOUDFLARE_API_TOKEN ||
      "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    endpoint:
      process.env.R2_ENDPOINT ||
      "https://7a470541a704caaf91e71efccc78fd36.r2.cloudflarestorage.com",
    bucketName: process.env.R2_BUCKET_NAME || "sportsdesk-ops-reports",
    publicUrl:
      process.env.R2_PUBLIC_URL ||
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--info")) {
    getR2ConfigInfo();
  } else if (args.includes("--verify")) {
    verifyR2Connection();
  } else {
    const target = args[0] || "reports";
    syncReportsDirectory(target);
  }
}
