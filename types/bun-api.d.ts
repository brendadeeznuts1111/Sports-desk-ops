/**
 * @file types/bun-api.d.ts
 * @description Explicit type aliases for Bun runtime APIs used across the codebase.
 *
 * Declares aliases for Bun globals (`Response`, `RequestInit`, `File`,
 * `ReadableStream`, `Uint8Array<ArrayBufferLike>`, etc.) so our code references
 * `BunResponse`, `BunRequestInit`, etc. explicitly instead of relying on
 * implicit global lookup via `tsconfig.json`'s `types: ["bun"]`. If Bun's
 * global type surface changes, update the aliases here in one place.
 *
 * These are type-only aliases — they erase at compile time and add no runtime
 * cost. Import with `import type { BunResponse } from "@/types/bun-api"`.
 */

export type BunResponse = Response;
export type BunRequestInit = RequestInit;
export type BunFile = File;
export type BunReadableStream = ReadableStream<Uint8Array>;
export type BunUint8Array = Uint8Array<ArrayBufferLike>;
export type BunReadableStreamDefaultReader =
  ReadableStreamDefaultReader<Uint8Array>;
export type BunS3Client = Bun.S3Client;
export type BunS3File = Bun.S3File;
export type BunS3Options = Bun.S3Options;
export type BunS3Stats = Bun.S3Stats;

/** Bun's documented S3 error codes (bun.com/docs/runtime/s3#error-codes). */
export type BunS3ErrorCode =
  | "ERR_S3_MISSING_CREDENTIALS"
  | "ERR_S3_INVALID_METHOD"
  | "ERR_S3_INVALID_PATH"
  | "ERR_S3_INVALID_ENDPOINT"
  | "ERR_S3_INVALID_SIGNATURE"
  | "ERR_S3_INVALID_SESSION_TOKEN";

/** An S3Error from the service (name === "S3Error") or a Bun ERR_S3_* failure. */
export interface BunS3Error extends Error {
  readonly name: "S3Error" | string;
  readonly code?: BunS3ErrorCode;
}

/** Windows Credential Manager persistence for Bun.secrets.set. */
export type BunSecretPersist = "local" | "enterprise";

export interface BunSecretSetOptions {
  readonly service: string;
  readonly name: string;
  readonly value: string;
  readonly persist?: BunSecretPersist;
}

/**
 * Bun 1.4 post-quantum Web Crypto extensions (ML-KEM / ML-DSA), not yet in @types/bun.
 * Keeping these declarations here removes `as unknown as` casts at call sites.
 */
declare global {
  interface SubtleCrypto {
    generateKey(
      algorithm:
        "ML-KEM-768" | "ML-KEM-1024" | "ML-DSA-44" | "ML-DSA-65" | "ML-DSA-87",
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<CryptoKeyPair>;
    encapsulateBits(
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
    ): Promise<{ sharedKey: ArrayBuffer; ciphertext: ArrayBuffer }>;
    decapsulateBits(
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      ciphertext: BufferSource,
    ): Promise<ArrayBuffer>;
    encapsulateKey(
      algorithm: AlgorithmIdentifier,
      publicKey: CryptoKey,
      sharedKeyAlgorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<{ sharedKey: CryptoKey; ciphertext: ArrayBuffer }>;
    decapsulateKey(
      algorithm: AlgorithmIdentifier,
      privateKey: CryptoKey,
      ciphertext: BufferSource,
      sharedKeyAlgorithm: AlgorithmIdentifier,
      extractable: boolean,
      keyUsages: readonly string[],
    ): Promise<CryptoKey>;
  }
}

/**
 * Bun 1.4 CSRF token API (not yet in @types/bun).
 *
 * bun-types declares no CSRF surface, so Bun.CSRF is undeclared at the type
 * level even though the binary exposes it (probed by bin/bun_surface.ts; see
 * `RUNTIME_ONLY_SHAPES` in lib/bun_shapes.ts). Token payload is a nonce, an
 * issue timestamp, the `expiresIn` duration and an HMAC signature.
 */
export type CSRFAlgorithm =
  "blake2b256" | "blake2b512" | "sha256" | "sha384" | "sha512" | "sha512-256";

export interface CSRFGenerateOptions {
  expiresIn?: number;
  encoding?: "base64" | "base64url" | "hex";
  algorithm?: CSRFAlgorithm;
  sessionId?: string;
}

export interface CSRFVerifyOptions {
  secret?: string;
  encoding?: "base64" | "base64url" | "hex";
  algorithm?: CSRFAlgorithm;
  maxAge?: number;
  sessionId?: string;
}

declare module "bun" {
  export namespace CSRF {
    function generate(secret?: string, options?: CSRFGenerateOptions): string;
    function verify(token: string, options?: CSRFVerifyOptions): boolean;
  }
}

/** Bun 1.4 process memory-pressure event (not yet in @types/node). */
declare global {
  namespace NodeJS {
    interface Process {
      on(
        event: "memoryPressure",
        listener: (level: "warning" | "critical") => void,
      ): this;
      off(
        event: "memoryPressure",
        listener: (level: "warning" | "critical") => void,
      ): this;
      removeListener(
        event: "memoryPressure",
        listener: (level: "warning" | "critical") => void,
      ): this;
    }
  }
}
