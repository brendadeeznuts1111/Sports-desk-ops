/**
 * @file live_positions_r2_publisher.test.ts
 * @description Unit coverage for `lib/live_positions_r2_publisher.ts`: three keys written in order,
 * metadata headers present with the right values, one failure does not skip the other two, and the
 * summary string never leaks body bytes.
 */

import { describe, expect, test } from "bun:test";

import {
  LIVE_POSITIONS_R2_CONTENT_TYPE,
  LIVE_POSITIONS_R2_KEYS,
  LIVE_POSITIONS_R2_SOURCE,
  publishLivePositionsToR2,
} from "../lib/live_positions_r2_publisher.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";

class FakeBackend implements R2S3ClientBackend {
  file(): Bun.S3File {
    return undefined as unknown as Bun.S3File;
  }
  async write(): Promise<number> {
    return 1;
  }
  presign(path: string): string {
    return `https://r2.test/${path}`;
  }
  async stat(): Promise<Bun.S3Stats> {
    return {
      size: 1,
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
  readonly bodyBytes: Uint8Array;
};

function fakeFetchFor(records: RecordedFetchWrite[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers ?? {});
    const bodyBytes =
      init?.body instanceof Uint8Array
        ? init.body
        : new TextEncoder().encode(String(init?.body ?? ""));
    records.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      bodyBytes,
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

const PAYLOAD = {
  liveWagersText: '{"LIST":[1,2,3],"observedAt":"2026-11-04T19:10:00.000Z"}',
  liveBetsText: '{"pendingCount":42,"capturedAt":"2026-11-04T19:10:00.000Z"}',
  captureHealthText: '{"records":[],"lastUpdated":"2026-11-04T19:10:00.000Z"}',
  observedAtIso: "2026-11-04T19:10:00.000Z",
  schemaVersions: { liveWagers: 1, liveBets: 1, captureHealth: 1 },
} as const;

function makeClient(): R2S3Client {
  const backend = new FakeBackend();
  return new R2S3Client(
    backend,
    "sportsdesk-ops-reports",
    "https://pub.r2.dev",
    {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "AKIATEST",
      secretAccessKey: "secrettestsecrettestsecrettestsecret",
    },
  );
}

describe("publishLivePositionsToR2", () => {
  test("writes three keys in the stable live-wagers → live-bets → capture-health order", async () => {
    const records: RecordedFetchWrite[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(records);
    try {
      const result = await publishLivePositionsToR2(makeClient(), PAYLOAD);

      expect(result.ok).toBe(true);
      expect(result.writes).toHaveLength(3);
      expect(result.writes.map((write) => write.key)).toEqual([
        LIVE_POSITIONS_R2_KEYS.liveWagers,
        LIVE_POSITIONS_R2_KEYS.liveBets,
        LIVE_POSITIONS_R2_KEYS.captureHealth,
      ]);
      expect(result.summary).toBe(
        `R2 publish: 3/3 ok (${PAYLOAD.liveWagersText.length + PAYLOAD.liveBetsText.length + PAYLOAD.captureHealthText.length} bytes to sportsdesk-ops-reports)`,
      );

      expect(records).toHaveLength(3);
      const [wagerRec, betsRec, healthRec] = records;
      expect(wagerRec?.url).toContain(
        "/sportsdesk-ops-reports/live-wagers/latest.json",
      );
      expect(betsRec?.url).toContain(
        "/sportsdesk-ops-reports/live-bets/latest.json",
      );
      expect(healthRec?.url).toContain(
        "/sportsdesk-ops-reports/capture-health/latest.json",
      );
      for (const record of records) {
        expect(record.method).toBe("PUT");
        expect(record.headers["content-type"]).toBe(
          LIVE_POSITIONS_R2_CONTENT_TYPE,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("every PUT carries observed-at, schema-version and source metadata headers", async () => {
    const records: RecordedFetchWrite[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(records);
    try {
      await publishLivePositionsToR2(makeClient(), PAYLOAD);
      for (const record of records) {
        expect(record.headers["x-amz-meta-observed-at"]).toBe(
          PAYLOAD.observedAtIso,
        );
        expect(record.headers["x-amz-meta-schema-version"]).toBe("1");
        expect(record.headers["x-amz-meta-source"]).toBe(
          LIVE_POSITIONS_R2_SOURCE,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failing PUT does not skip the remaining two and the summary names the failures", async () => {
    let call = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 2) return new Response("boom", { status: 500 });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const result = await publishLivePositionsToR2(makeClient(), PAYLOAD);

      expect(result.ok).toBe(false);
      expect(result.writes).toHaveLength(3);
      const [first, second, third] = result.writes;
      expect(first?.ok).toBe(true);
      expect(second?.ok).toBe(false);
      expect(third?.ok).toBe(true);
      expect(second?.error).toContain("500");
      expect(result.summary).toBe(
        "R2 publish: 2/3 ok, failed=live-bets/latest.json",
      );
      // The summary string must not leak the payload text; test against a known body substring.
      expect(result.summary).not.toContain("pendingCount");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the published bytes match the exact text that was handed in", async () => {
    const puts: Uint8Array[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      puts.push(
        init?.body instanceof Uint8Array
          ? init.body
          : new TextEncoder().encode(String(init?.body ?? "")),
      );
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await publishLivePositionsToR2(makeClient(), PAYLOAD);
      const [a, b, c] = puts;
      expect(a && new TextDecoder().decode(a)).toBe(PAYLOAD.liveWagersText);
      expect(b && new TextDecoder().decode(b)).toBe(PAYLOAD.liveBetsText);
      expect(c && new TextDecoder().decode(c)).toBe(PAYLOAD.captureHealthText);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
