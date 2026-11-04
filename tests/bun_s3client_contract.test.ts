import { describe, expect, test } from "bun:test";

import type { BunS3Client } from "../types/bun-api.ts";

const METHODS = [
  "delete",
  "exists",
  "file",
  "list",
  "presign",
  "size",
  "stat",
  "unlink",
  "write",
] as const;

function methodsOf(value: object): Set<string> {
  return new Set(Object.getOwnPropertyNames(value));
}

describe("Bun.S3Client contract", () => {
  test("exposes the nine instance methods", () => {
    const methods = methodsOf(Bun.S3Client.prototype);
    for (const name of METHODS) expect(methods.has(name)).toBe(true);
  });

  test("exposes the nine matching static methods", () => {
    const statics = methodsOf(Bun.S3Client);
    for (const name of METHODS) expect(statics.has(name)).toBe(true);
  });

  test("Bun.s3 is an S3Client value and matches the type alias", () => {
    const s3: BunS3Client = Bun.s3;
    expect(s3).toBeInstanceOf(Bun.S3Client);
    for (const name of METHODS) {
      expect(typeof (s3 as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
  });
});
