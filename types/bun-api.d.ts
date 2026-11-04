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
