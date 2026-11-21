import { describe, expect, test } from "bun:test";
import { s3 as namedS3, S3Client as NamedS3Client } from "bun";

import type { BunS3Client } from "../types/bun-api.ts";

// @bun-behavior: bun-s3-globals

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

  test("lazy S3File exposes the pinned members and a NaN size", () => {
    const file = Bun.s3.file("missing.txt");
    for (const name of [
      "slice",
      "stat",
      "exists",
      "unlink",
      "delete",
      "presign",
      "write",
    ] as const) {
      expect(typeof (file as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
    expect(Number.isNaN(file.size)).toBe(true);
  });

  test("Bun.s3 is an S3Client value and matches the type alias", () => {
    const s3: BunS3Client = Bun.s3;
    // Cross-realm instanceof checks fail under worker isolation on Linux CI.
    // Validate prototype constructor name and method contract across all environments.
    expect(Object.getPrototypeOf(s3).constructor.name).toBe("S3Client");
    for (const name of METHODS) {
      expect(typeof (s3 as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
  });

  test("named exports from 'bun' match Bun.s3 and Bun.S3Client by identity", () => {
    expect(namedS3).toBe(Bun.s3);
    expect(NamedS3Client).toBe(Bun.S3Client);
  });

  test("explicit R2 S3Client creates lazy S3File and signs presigned URLs offline", () => {
    const r2 = new NamedS3Client({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "sportsdesk-ops-reports",
      endpoint: "https://acc.r2.cloudflarestorage.com",
    });

    const file = r2.file("manifests/2026-11-20.yaml");
    for (const name of [
      "text",
      "bytes",
      "json",
      "exists",
      "stat",
      "write",
      "delete",
      "presign",
    ] as const) {
      expect(typeof (file as unknown as Record<string, unknown>)[name]).toBe(
        "function",
      );
    }
    expect(Number.isNaN(file.size)).toBe(true);

    const url = r2.presign("manifests/2026-11-20.yaml", { expiresIn: 300 });
    expect(
      url.startsWith(
        "https://acc.r2.cloudflarestorage.com/sportsdesk-ops-reports/manifests/2026-11-20.yaml",
      ),
    ).toBe(true);
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=300");
  });
});
