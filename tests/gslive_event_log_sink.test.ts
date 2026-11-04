/**
 * @file gslive_event_log_sink.test.ts
 * @description Validates the all-per-event-then-index invariant: every per-event write is
 * size-verified via stat before the index key is touched. Identifier validation rejects
 * path-traversal in betId/eventId before any R2 call. Metadata carries distinct source labels for
 * the per-event writes and the index write.
 */

import { describe, expect, test } from "bun:test";

import {
  assertSanitizedGsliveEventLogs,
  GSLIVE_EVENT_LOGS_INDEX_KEY,
  GSLIVE_EVENT_LOGS_INDEX_SOURCE,
  GSLIVE_EVENT_LOGS_KIND,
  GSLIVE_EVENT_LOGS_MAX_ENTRY_BYTES,
  GSLIVE_EVENT_LOGS_PREFIX,
  publishGsliveEventLogs,
  type GsliveEventLogsIndex,
} from "../lib/gslive_event_log_sink.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";

class FakeBackend implements R2S3ClientBackend {
  statSizes: Map<string, number> = new Map();
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

const INPUT = {
  deskDate: "2026-11-04",
  observedAtIso: "2026-11-04T19:10:00.000Z",
  entries: [
    {
      betId: "350826311",
      eventId: "207059641",
      logTime: "19:08:12",
      payload: { status: "open" },
    },
    {
      betId: "350826312",
      eventId: "207059642",
      logTime: "19:09:03",
      payload: { status: "settled" },
    },
  ],
} as const;

describe("assertSanitizedGsliveEventLogs", () => {
  test("rejects unsafe betId before any key is built", () => {
    expect(() =>
      assertSanitizedGsliveEventLogs({
        ...INPUT,
        entries: [
          {
            betId: "../../etc/passwd",
            eventId: "e",
            logTime: "0",
            payload: {},
          },
        ],
      }),
    ).toThrow(/betId must match/);
  });

  test("rejects unsafe eventId", () => {
    expect(() =>
      assertSanitizedGsliveEventLogs({
        ...INPUT,
        entries: [{ betId: "b", eventId: "e/f", logTime: "0", payload: {} }],
      }),
    ).toThrow(/eventId must match/);
  });

  test("rejects malformed deskDate", () => {
    expect(() =>
      assertSanitizedGsliveEventLogs({ ...INPUT, deskDate: "2026-11-4" }),
    ).toThrow(/deskDate must be YYYY-MM-DD/);
  });

  test("rejects an entry payload carrying a forbidden identifier-shaped key", () => {
    expect(() =>
      assertSanitizedGsliveEventLogs({
        ...INPUT,
        entries: [
          {
            betId: "b",
            eventId: "e",
            logTime: "0",
            payload: { nested: { login: "BBN17" } },
          },
        ],
      }),
    ).toThrow(/forbidden key "login"/);
  });

  test("passes for a clean batch", () => {
    expect(() => assertSanitizedGsliveEventLogs(INPUT)).not.toThrow();
  });
});

describe("publishGsliveEventLogs", () => {
  test("writes every per-event key then the index as the last write", async () => {
    const records: RecordedFetchWrite[] = [];
    const { client, backend } = makeClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records);
    try {
      const result = await publishGsliveEventLogs(INPUT, { r2Client: client });

      const puts = records.filter((record) => record.method === "PUT");
      expect(puts).toHaveLength(3);
      expect(puts[0]?.url).toContain(
        `/${GSLIVE_EVENT_LOGS_PREFIX}2026-11-04/350826311-207059641.json`,
      );
      expect(puts[1]?.url).toContain(
        `/${GSLIVE_EVENT_LOGS_PREFIX}2026-11-04/350826312-207059642.json`,
      );
      expect(puts[2]?.url).toContain(`/${GSLIVE_EVENT_LOGS_INDEX_KEY}`);

      expect(result.entryKeys).toHaveLength(2);
      expect(result.indexKey).toBe(GSLIVE_EVENT_LOGS_INDEX_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("per-event writes carry source=gslive-event-logs; the index carries gslive-event-logs-index", async () => {
    const records: RecordedFetchWrite[] = [];
    const { client, backend } = makeClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records);
    try {
      await publishGsliveEventLogs(INPUT, { r2Client: client });
      const puts = records.filter((record) => record.method === "PUT");
      expect(puts[0]?.headers["x-amz-meta-source"]).toBe(
        GSLIVE_EVENT_LOGS_KIND,
      );
      expect(puts[1]?.headers["x-amz-meta-source"]).toBe(
        GSLIVE_EVENT_LOGS_KIND,
      );
      expect(puts[2]?.headers["x-amz-meta-source"]).toBe(
        GSLIVE_EVENT_LOGS_INDEX_SOURCE,
      );
      expect(puts[0]?.headers["x-amz-meta-pii"]).toBe("caller-sanitized");
      expect(puts[2]?.headers["x-amz-meta-pii"]).toBe("none");
      expect(puts[2]?.headers["x-amz-meta-entry-count"]).toBe("2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the index body lists every entry once with its key", async () => {
    const records: RecordedFetchWrite[] = [];
    const bodies: Uint8Array[] = [];
    const { client, backend } = makeClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records, (bytes) => {
      bodies.push(bytes);
    });
    try {
      await publishGsliveEventLogs(INPUT, { r2Client: client });
      const indexBody = bodies.at(-1);
      const parsed = JSON.parse(
        new TextDecoder().decode(indexBody),
      ) as GsliveEventLogsIndex;
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.deskDate).toBe("2026-11-04");
      expect(parsed.entries).toHaveLength(2);
      expect(parsed.entries[0]).toEqual({
        key: `${GSLIVE_EVENT_LOGS_PREFIX}2026-11-04/350826311-207059641.json`,
        betId: "350826311",
        eventId: "207059641",
        logTime: "19:08:12",
        observedAtIso: "2026-11-04T19:10:00.000Z",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws without touching the index when a per-event stat size mismatches", async () => {
    const records: RecordedFetchWrite[] = [];
    const { client, backend } = makeClient();
    backend.statSizeOverride = 1;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetchFor(backend, records);
    try {
      await expect(
        publishGsliveEventLogs(INPUT, { r2Client: client }),
      ).rejects.toThrow(/size mismatch/);
      const puts = records.filter((record) => record.method === "PUT");
      expect(puts).toHaveLength(1);
      expect(puts[0]?.url).not.toContain(GSLIVE_EVENT_LOGS_INDEX_KEY);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws before any R2 call when an entry body exceeds the max size", async () => {
    const huge = "x".repeat(GSLIVE_EVENT_LOGS_MAX_ENTRY_BYTES + 1);
    const { client } = makeClient();
    await expect(
      publishGsliveEventLogs(
        {
          ...INPUT,
          entries: [
            { betId: "b", eventId: "e", logTime: "0", payload: { fill: huge } },
          ],
        },
        { r2Client: client },
      ),
    ).rejects.toThrow(/exceeds/);
  });

  test("throws when R2 credentials are unavailable", async () => {
    await expect(
      publishGsliveEventLogs(INPUT, { r2Client: null }),
    ).rejects.toThrow(/R2 credentials are unavailable/);
  });
});
