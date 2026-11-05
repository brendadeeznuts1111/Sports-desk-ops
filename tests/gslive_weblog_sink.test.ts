/**
 * @file gslive_weblog_sink.test.ts
 * @description Validates the daily-then-pointer invariant: a size-verified daily write must land
 * before the pointer is touched; a stat mismatch throws and the pointer is never written. Metadata
 * carries distinct source labels for the two writes.
 */

import { describe, expect, test } from "bun:test";

import {
  assertSanitizedGsliveWeblog,
  GSLIVE_WEBLOGS_KIND,
  GSLIVE_WEBLOGS_MAX_ARTIFACT_BYTES,
  GSLIVE_WEBLOGS_POINTER_KEY,
  GSLIVE_WEBLOGS_POINTER_SOURCE,
  GSLIVE_WEBLOGS_PREFIX,
  GSLIVE_WEBLOGS_SCHEMA_VERSION,
  publishGsliveWeblog,
  type GsliveWeblogsPointer,
} from "../lib/gslive_weblog_sink.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";

class FakeBackend implements R2S3ClientBackend {
  /** Set by the fake fetch so backend.stat() mirrors the signed-PUT body length. */
  statSizes: Map<string, number> = new Map();
  /** When set, forces backend.stat() to return this override regardless of recorded sizes. */
  statSizeOverride: number | undefined;
  file(): Bun.S3File {
    return undefined as unknown as Bun.S3File;
  }
  async write(): Promise<number> {
    return 1;
  }
  presign(path: string): string {
    return `https://r2.test/${path}`;
  }
  async stat(path: string): Promise<Bun.S3Stats> {
    const size = this.statSizeOverride ?? this.statSizes.get(path) ?? 0;
    return {
      size,
      lastModified: new Date(0),
      etag: "e",
      type: "application/json",
    };
  }
  async exists(): Promise<boolean> {
    return true;
  }
  async size(): Promise<number> {
    return 1;
  }
  async list(): Promise<Bun.S3ListObjectsResponse> {
    return { contents: [], isTruncated: false };
  }
  async delete(): Promise<void> {}
  async unlink(): Promise<void> {}
}

type RecordedFetchWrite = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyBytes: number;
};

/**
 * Build a fetch recorder that captures every signed PUT (writeWithMetadata goes through fetch, not
 * the backend) AND teaches the FakeBackend what size to return from stat(). The sink's
 * daily-stat-verify step therefore sees the real body length unless a test opts into a short size.
 */
function fakeFetchFor(
  backend: FakeBackend,
  records: RecordedFetchWrite[],
  captureBody?: (bytes: Uint8Array) => void,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const body =
      init?.body instanceof Uint8Array
        ? init.body
        : new TextEncoder().encode(String(init?.body ?? ""));
    if (method === "PUT") {
      records.push({
        url,
        method,
        headers: Object.fromEntries(headers.entries()),
        bodyBytes: body.byteLength,
      });
      // Teach the backend what stat() should report for this key.
      const keyPath = new URL(url).pathname.replace(/^\/[^/]+\//, "");
      backend.statSizes.set(keyPath, body.byteLength);
      captureBody?.(body);
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

function makeClient(): { client: R2S3Client; backend: FakeBackend } {
  const backend = new FakeBackend();
  const client = new R2S3Client(
    backend,
    "sportsdesk-ops-reports",
    "https://pub.r2.dev",
    {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secrettestsecrettestsecrettestsecret",
    },
  );
  return { client, backend };
}

const ROLLUP = {
  schemaVersion: GSLIVE_WEBLOGS_SCHEMA_VERSION,
  deskDate: "2026-11-04",
  generatedAtIso: "2026-11-04T19:10:00.000Z",
  sourceSha256: "a".repeat(64),
  rowCount: 1234,
  body: { bets: [], sportTallies: { NFL: 3 } },
} as const;

describe("assertSanitizedGsliveWeblog", () => {
  test("rejects body carrying a forbidden identifier-shaped key", () => {
    expect(() =>
      assertSanitizedGsliveWeblog({
        ...ROLLUP,
        body: { bets: [{ login: "BBN17" }] },
      }),
    ).toThrow(/forbidden key "login"/);
  });

  test("rejects malformed deskDate", () => {
    expect(() =>
      assertSanitizedGsliveWeblog({ ...ROLLUP, deskDate: "2026/11/04" }),
    ).toThrow(/deskDate must be YYYY-MM-DD/);
  });

  test("passes for a clean aggregate body", () => {
    expect(() => assertSanitizedGsliveWeblog(ROLLUP)).not.toThrow();
  });
});

describe("publishGsliveWeblog", () => {
  test("writes the daily first, size-verifies, then advances the pointer", async () => {
    const records: RecordedFetchWrite[] = [];
    const { client, backend } = makeClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records);
    try {
      const result = await publishGsliveWeblog(ROLLUP, { r2Client: client });

      const puts = records.filter((record) => record.method === "PUT");
      expect(puts).toHaveLength(2);
      expect(puts[0]?.url).toContain(
        `/${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`,
      );
      expect(puts[1]?.url).toContain(`/${GSLIVE_WEBLOGS_POINTER_KEY}`);

      expect(result.dailyKey).toBe(
        `${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`,
      );
      expect(result.pointerKey).toBe(GSLIVE_WEBLOGS_POINTER_KEY);
      expect(result.sha256).toBe(ROLLUP.sourceSha256);
      expect(result.publicUrl).toBe(
        `https://pub.r2.dev/${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the daily write carries source=gslive-weblogs and the pointer carries gslive-weblogs-pointer", async () => {
    const records: RecordedFetchWrite[] = [];
    const { client, backend } = makeClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records);
    try {
      await publishGsliveWeblog(ROLLUP, { r2Client: client });
      const puts = records.filter((record) => record.method === "PUT");
      expect(puts[0]?.headers["x-amz-meta-source"]).toBe(GSLIVE_WEBLOGS_KIND);
      expect(puts[1]?.headers["x-amz-meta-source"]).toBe(
        GSLIVE_WEBLOGS_POINTER_SOURCE,
      );
      expect(puts[0]?.headers["x-amz-meta-pii"]).toBe("none");
      expect(puts[1]?.headers["x-amz-meta-pii"]).toBe("none");
      expect(puts[1]?.headers["x-amz-meta-points-to"]).toBe(
        `${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the pointer body names the daily key with matching sha256 and row count", async () => {
    const records: RecordedFetchWrite[] = [];
    const bodies: Uint8Array[] = [];
    const { client, backend } = makeClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records, (bytes) => {
      bodies.push(bytes);
    });
    try {
      await publishGsliveWeblog(ROLLUP, { r2Client: client });
      const pointerBody = bodies.at(-1);
      const parsed = JSON.parse(
        new TextDecoder().decode(pointerBody),
      ) as GsliveWeblogsPointer;
      expect(parsed).toEqual({
        schemaVersion: 1,
        deskDate: "2026-11-04",
        key: `${GSLIVE_WEBLOGS_PREFIX}2026-11-04/activity.json`,
        sha256: ROLLUP.sourceSha256,
        generatedAtIso: ROLLUP.generatedAtIso,
        rowCount: ROLLUP.rowCount,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws without touching the pointer when the daily stat size mismatches", async () => {
    const records: RecordedFetchWrite[] = [];
    const { client, backend } = makeClient();
    backend.statSizeOverride = 1; // Every stat() reports a short size
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records);
    try {
      await expect(
        publishGsliveWeblog(ROLLUP, { r2Client: client }),
      ).rejects.toThrow(/daily write size mismatch/);
      const puts = records.filter((record) => record.method === "PUT");
      expect(puts).toHaveLength(1);
      expect(puts[0]?.url).not.toContain(GSLIVE_WEBLOGS_POINTER_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws before any R2 call when the body exceeds the max size", async () => {
    const huge = "x".repeat(GSLIVE_WEBLOGS_MAX_ARTIFACT_BYTES + 1);
    const { client } = makeClient();
    await expect(
      publishGsliveWeblog(
        { ...ROLLUP, body: { fill: huge } },
        { r2Client: client },
      ),
    ).rejects.toThrow(/exceeds/);
  });

  test("throws when R2 credentials are unavailable", async () => {
    await expect(
      publishGsliveWeblog(ROLLUP, { r2Client: null }),
    ).rejects.toThrow(/R2 credentials are unavailable/);
  });
});
