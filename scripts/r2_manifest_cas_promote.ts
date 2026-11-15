#!/usr/bin/env bun
import { resolve } from "node:path";
import { resolveR2CredentialsAsync } from "../lib/r2_s3_client.ts";

export const MANIFEST_BUCKET = "sportsdesk-ops-reports";
export const MANIFEST_KEYS = [
  "manifests/a11y-gate/latest",
  "manifests/spec-governance/latest",
] as const;
export type ManifestKey = (typeof MANIFEST_KEYS)[number];
/** On HTTP 412 the promotion fails; it never re-reads, rebases, or retries. */
export const MAX_MANIFEST_REBASES = 0;
export const CAS_CONFLICT_EXIT_CODE = 3;
export const CAS_TRANSPORT_EXIT_CODE = 4;

export class ManifestCasError extends Error {
  override readonly name = "ManifestCasError";
  constructor(
    readonly code:
      | "ERR_MANIFEST_CAS_CONFLICT_412"
      | "ERR_MANIFEST_CAS_TRANSPORT"
      | "ERR_MANIFEST_CAS_USAGE"
      | "ERR_MANIFEST_CAS_NO_CREDENTIALS"
      | "ERR_MANIFEST_CAS_VERIFY",
    message: string,
    readonly key?: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** The Bun.S3Client surface used here. `fetch("s3://")` and S3Client writes drop If-Match on Bun 1.4.4, so writes go through presigned URLs. */
export type ManifestStore = {
  file(key: string): {
    exists(): Promise<boolean>;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  stat(key: string): Promise<{ etag: string }>;
  presign(key: string, options: { method: "PUT"; expiresIn: number }): string;
};

export type PromotionResult = {
  readonly key: string;
  readonly outcome: "promoted" | "created" | "unchanged" | "dry-run";
  readonly previousEtag: string | null;
  readonly newEtag: string | null;
  readonly rebases: 0;
};

export type PromoteOptions = {
  readonly store: ManifestStore;
  readonly key: string;
  readonly body: Uint8Array;
  readonly dryRun?: boolean;
  readonly fetchImpl?: typeof fetch;
};

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Bun.deepEquals(left, right);
}

export async function promoteManifest(
  options: PromoteOptions,
): Promise<PromotionResult> {
  const { store, key, body } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const exists = await store.file(key).exists();
  const previousEtag = exists ? (await store.stat(key)).etag : null;
  if (exists) {
    const current = new Uint8Array(await store.file(key).arrayBuffer());
    if (sameBytes(current, body)) {
      return {
        key,
        outcome: "unchanged",
        previousEtag,
        newEtag: previousEtag,
        rebases: 0,
      };
    }
  }
  if (options.dryRun === true)
    return { key, outcome: "dry-run", previousEtag, newEtag: null, rebases: 0 };

  const url = store.presign(key, { method: "PUT", expiresIn: 60 });
  const precondition: Record<string, string> =
    previousEtag === null
      ? { "If-None-Match": "*" }
      : { "If-Match": previousEtag };
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "PUT",
      headers: precondition,
      body,
    });
  } catch (cause) {
    throw new ManifestCasError(
      "ERR_MANIFEST_CAS_TRANSPORT",
      `PUT ${key} failed: ${String(cause)}`,
      key,
    );
  }
  if (response.status === 412) {
    throw new ManifestCasError(
      "ERR_MANIFEST_CAS_CONFLICT_412",
      `${key} changed since ${previousEtag ?? "(absent)"}; not rebasing (max rebases ${MAX_MANIFEST_REBASES})`,
      key,
    );
  }
  if (!response.ok) {
    throw new ManifestCasError(
      "ERR_MANIFEST_CAS_TRANSPORT",
      `PUT ${key} returned HTTP ${response.status}`,
      key,
    );
  }
  const newEtag = response.headers.get("etag");
  const stored = await store.stat(key);
  if (newEtag !== null && stored.etag !== newEtag) {
    throw new ManifestCasError(
      "ERR_MANIFEST_CAS_VERIFY",
      `${key} PUT returned ${newEtag} but stat() reads ${stored.etag}`,
      key,
    );
  }
  return {
    key,
    outcome: previousEtag === null ? "created" : "promoted",
    previousEtag,
    newEtag: newEtag ?? stored.etag,
    rebases: 0,
  };
}

type CliOptions = {
  manifests: Map<ManifestKey, string>;
  dryRun: boolean;
  bucket: string;
};

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    manifests: new Map(),
    dryRun: false,
    bucket: MANIFEST_BUCKET,
  };
  for (let argIndex = 0; argIndex < argv.length; argIndex += 1) {
    const arg = argv[argIndex] ?? "";
    const value = argv[argIndex + 1];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (value === undefined)
      throw new ManifestCasError(
        "ERR_MANIFEST_CAS_USAGE",
        `${arg} needs a value`,
      );
    argIndex += 1;
    if (arg === "--a11y-gate")
      options.manifests.set("manifests/a11y-gate/latest", resolve(value));
    else if (arg === "--spec-governance")
      options.manifests.set("manifests/spec-governance/latest", resolve(value));
    else if (arg === "--bucket") options.bucket = value;
    else
      throw new ManifestCasError(
        "ERR_MANIFEST_CAS_USAGE",
        `unknown argument ${arg}`,
      );
  }
  if (options.manifests.size === 0) {
    throw new ManifestCasError(
      "ERR_MANIFEST_CAS_USAGE",
      "pass --a11y-gate <file> and/or --spec-governance <file>",
    );
  }
  return options;
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const credentials = await resolveR2CredentialsAsync();
  if (credentials === null) {
    throw new ManifestCasError(
      "ERR_MANIFEST_CAS_NO_CREDENTIALS",
      "no R2/S3 credentials resolved (see lib/r2_s3_client.ts)",
    );
  }
  const store = new Bun.S3Client({ ...credentials, bucket: options.bucket });
  const results: PromotionResult[] = [];
  for (const [key, path] of options.manifests) {
    const body = new Uint8Array(await Bun.file(path).arrayBuffer());
    try {
      results.push(
        await promoteManifest({ store, key, body, dryRun: options.dryRun }),
      );
    } catch (caught) {
      console.log(
        JSON.stringify(
          { bucket: options.bucket, results, failed: key },
          null,
          2,
        ),
      );
      if (caught instanceof ManifestCasError) {
        console.error(caught.message);
        return caught.code === "ERR_MANIFEST_CAS_CONFLICT_412"
          ? CAS_CONFLICT_EXIT_CODE
          : CAS_TRANSPORT_EXIT_CODE;
      }
      throw caught;
    }
  }
  console.log(JSON.stringify({ bucket: options.bucket, results }, null, 2));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (caught) {
    if (!(caught instanceof ManifestCasError)) throw caught;
    console.error(caught.message);
    process.exitCode = 2;
  }
}
