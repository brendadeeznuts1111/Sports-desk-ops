/**
 * @file sealed_r2_manifest_client.ts
 * @description Credential-bearing R2 client whose secrets stay in private fields,
 * and a one-way seal of the ambient `Bun.s3` singleton.
 *
 * Bun 1.4.4 `Bun.inspect(..., { showHidden: true })` does not print `#private`
 * fields. The singleton is replaced with a frozen credential-free object before
 * a client is constructed, so a later inspect of `Bun.s3` cannot echo env keys.
 */

import type { R2ManifestClient } from "./r2_manifest_loader.ts";

const SEAL_MARK = Symbol.for("sportsdesk.sealedBunS3");

const SEALED_BUN_S3 = Object.freeze({
  [SEAL_MARK]: true as const,
});

function isSealedS3(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { [key: symbol]: unknown })[SEAL_MARK] === true;
}

/**
 * Replace ambient `Bun.s3` so it cannot retain process-env credentials.
 * Idempotent. Returns false only when the property cannot be replaced.
 */
export function sealGlobalBunS3(): boolean {
  if (isSealedS3(Bun.s3)) return true;
  try {
    Object.defineProperty(Bun, "s3", {
      value: SEALED_BUN_S3,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  } catch {
    return isSealedS3(Bun.s3);
  }
  return isSealedS3(Bun.s3);
}

/**
 * Host as configured, not the lowercased WHATWG hostname.
 * `new URL(endpoint).hostname` folds `AKIA_...` to `akia_...`, and a
 * case-sensitive leak scan would then miss the credential in the host.
 */
function configuredEndpointHost(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (parsed.hostname === "") {
    throw new TypeError("R2 endpoint is missing a hostname");
  }
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(endpoint.trim());
  const authority = match?.[1] ?? "";
  const at = authority.lastIndexOf("@");
  const hostport = at === -1 ? authority : authority.slice(at + 1);
  if (hostport.startsWith("[")) {
    const end = hostport.indexOf("]");
    if (end > 1) return hostport.slice(1, end);
  }
  const colon = hostport.indexOf(":");
  const host = colon === -1 ? hostport : hostport.slice(0, colon);
  return host === "" ? parsed.hostname : host;
}

export interface SealedR2ClientOptions {
  readonly bucket: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** When false, the caller already sealed `Bun.s3`. Default: seal. */
  readonly sealGlobalS3?: boolean | undefined;
  /** Injected transport for tests. No socket is opened by this constructor. */
  readonly transport?: R2ManifestClient | undefined;
}

export class SealedR2ManifestClient {
  readonly bucket: string;
  readonly endpointHost: string;
  readonly #endpoint: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #transport: R2ManifestClient | null;

  constructor(options: SealedR2ClientOptions) {
    if (options.sealGlobalS3 !== false) sealGlobalBunS3();
    this.bucket = options.bucket;
    this.endpointHost = configuredEndpointHost(options.endpoint);
    this.#endpoint = options.endpoint;
    this.#accessKeyId = options.accessKeyId;
    this.#secretAccessKey = options.secretAccessKey;
    this.#transport = options.transport ?? null;
    Object.freeze(this);
  }

  /**
   * A new S3 client for one call. It is not stored on this instance, so
   * `Bun.inspect(this)` cannot walk the credentialed client. Bun redacts
   * `accessKeyId` and `secretAccessKey` on the object this returns.
   */
  s3Client(): Bun.S3Client {
    if (this.#transport !== null) {
      throw new Error(
        "SealedR2ManifestClient is bound to an injected transport",
      );
    }
    return new Bun.S3Client({
      bucket: this.bucket,
      endpoint: this.#endpoint,
      accessKeyId: this.#accessKeyId,
      secretAccessKey: this.#secretAccessKey,
    });
  }
}
