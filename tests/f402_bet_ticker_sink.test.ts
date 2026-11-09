import { afterEach, describe, expect, test } from "bun:test";

import {
  buildF402TickerSnapshot,
  F402_BET_TICKER_LIVE_CHANNEL,
  F402_BET_TICKER_R2_KEY,
  projectF402TickerDelta,
} from "../lib/f402_bet_ticker_delta.ts";
import { createF402BetTickerSink } from "../lib/f402_bet_ticker_sink.ts";
import type { F402TickerRow } from "../lib/f402_ingest.ts";
import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";

function row(partial: Partial<F402TickerRow> = {}): F402TickerRow {
  return {
    login: "TESTLOGIN",
    customerId: "TESTCUST",
    agentId: "TESTAGENT",
    agentLogin: "TESTAGENTLOGIN",
    ticketWriter: "GSLIVE",
    wagerNumber: "100",
    ticketNumber: "",
    wagerType: "S",
    shortDesc:
      "Basketball - Team C vs Team D / Game / Spread / Team C -2.5 -110",
    insertedAt: "2026-11-03T18:00:00.000Z",
    vip: "0",
    amountWagered: 100,
    toWinAmount: 90,
    volumeAmount: 100,
    ...partial,
  };
}

const EVENT = projectF402TickerDelta([], [row()], "2026-11-03T18:00:00.000Z");
const SNAPSHOT = buildF402TickerSnapshot(EVENT, 1);
const SNAPSHOT_SHA = SNAPSHOT.sourceSha256;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

class FakeR2Backend implements R2S3ClientBackend {
  readonly presigns: string[] = [];
  file(): Bun.S3File {
    return undefined as unknown as Bun.S3File;
  }
  async write(): Promise<number> {
    return 1;
  }
  presign(path: string): string {
    this.presigns.push(path);
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

describe("f402 bet ticker sink", () => {
  test("posts exactly one f402-bet-ticker event with bearer auth", async () => {
    let captured: { url: string; body: unknown; headers: Headers } | undefined;
    const sink = createF402BetTickerSink({
      liveBets: true,
      r2: false,
      gatewayUrl: "http://gateway.test",
      apiToken: "token",
      fetchImpl: async (input, init) => {
        captured = {
          url: String(input),
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        };
        return Response.json({ published: 2 });
      },
    });
    const result = await sink.publishLiveBets(EVENT);
    expect(result).toEqual({ ok: true, published: 2 });
    expect(captured?.url).toBe("http://gateway.test/api/v1/live-bets");
    expect(captured?.headers.get("authorization")).toBe("Bearer token");
    expect(captured?.body).toMatchObject({
      channel: F402_BET_TICKER_LIVE_CHANNEL,
      event: { kind: "f402-bet-ticker", schemaVersion: 1 },
    });
  });

  test("a missing gateway token fails without a request", async () => {
    let called = false;
    const sink = createF402BetTickerSink({
      liveBets: true,
      r2: false,
      gatewayUrl: "http://gateway.test",
      apiToken: "",
      // The real fallback resolves the keychain token; this seam forces a genuinely empty result.
      apiTokenResolver: async () => "",
      fetchImpl: async () => {
        called = true;
        return Response.json({ published: 0 });
      },
    });
    expect(await sink.publishLiveBets(EVENT)).toEqual({
      ok: false,
      error: "BLOB_API_TOKEN is not set",
    });
    expect(called).toBe(false);
  });

  test("reports a gateway failure without throwing", async () => {
    const sink = createF402BetTickerSink({
      liveBets: true,
      r2: false,
      gatewayUrl: "http://gateway.test",
      apiToken: "token",
      fetchImpl: (async () =>
        new Response("no", { status: 503 })) as unknown as typeof fetch,
    });
    expect(await sink.publishLiveBets(EVENT)).toEqual({
      ok: false,
      error: "live-bets gateway returned HTTP 503",
    });
  });

  test("resolves BLOB_API_TOKEN from the secret fallback when env is unset", async () => {
    let authorization = "";
    const sink = createF402BetTickerSink({
      liveBets: true,
      r2: false,
      gatewayUrl: "http://gateway.test",
      apiToken: "",
      apiTokenResolver: async () => "secret-token",
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ published: 1 });
      },
    });
    expect((await sink.publishLiveBets(EVENT)).ok).toBe(true);
    expect(authorization).toBe("Bearer secret-token");
  });

  test("a missing resolved token still fails closed", async () => {
    let called = false;
    const sink = createF402BetTickerSink({
      liveBets: true,
      r2: false,
      gatewayUrl: "http://gateway.test",
      apiToken: "",
      apiTokenResolver: async () => "",
      fetchImpl: async () => {
        called = true;
        return Response.json({ published: 0 });
      },
    });
    expect(await sink.publishLiveBets(EVENT)).toEqual({
      ok: false,
      error: "BLOB_API_TOKEN is not set",
    });
    expect(called).toBe(false);
  });

  test("skips disabled sinks", async () => {
    const sink = createF402BetTickerSink({ liveBets: false, r2: false });
    expect(await sink.publishLiveBets(EVENT)).toEqual({
      ok: true,
      skipped: true,
    });
    expect(await sink.publishR2(SNAPSHOT)).toEqual({
      ok: true,
      skipped: true,
    });
  });

  test("writes the R2 snapshot with the PII-none metadata contract", async () => {
    const backend = new FakeR2Backend();
    const r2 = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    let captured: { url: string; headers: Headers; body: string } | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const rawBody = init?.body;
      const body =
        rawBody instanceof Uint8Array
          ? new TextDecoder().decode(rawBody)
          : String(rawBody ?? "");
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body,
      };
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createF402BetTickerSink({
      liveBets: false,
      r2: true,
      r2Client: r2,
    });
    const result = await sink.publishR2(SNAPSHOT);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`https://pub.test/${F402_BET_TICKER_R2_KEY}`);
    expect(backend.presigns).toEqual([]);
    expect(captured?.url).toBe(
      `https://r2.test/bucket/${F402_BET_TICKER_R2_KEY}`,
    );
    expect(captured?.headers.get("x-amz-meta-pii")).toBe("none");
    expect(captured?.headers.get("x-amz-meta-schema-version")).toBe("1");
    expect(captured?.headers.get("x-amz-meta-desk-date")).toBe(
      SNAPSHOT.deskDate,
    );
    expect(captured?.headers.get("x-amz-meta-generated-at")).toBe(
      SNAPSHOT.generatedAt,
    );
    expect(captured?.headers.get("x-amz-meta-sha256")).toBe(SNAPSHOT_SHA);
    expect(captured?.headers.get("x-amz-meta-source")).toBe("f402-bet-ticker");
    const written = JSON.parse(captured?.body ?? "{}") as { kind?: string };
    expect(written.kind).toBe("f402-bet-ticker");
  });

  test("the sanitizer rejects a doctored artifact before write", async () => {
    const backend = new FakeR2Backend();
    const r2 = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    let wrote = false;
    globalThis.fetch = (async () => {
      wrote = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const sink = createF402BetTickerSink({
      liveBets: false,
      r2: true,
      r2Client: r2,
    });
    const doctored = {
      ...SNAPSHOT,
      login: "TESTLOGIN",
    } as unknown as typeof SNAPSHOT;
    const result = await sink.publishR2(doctored);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("sanitized snapshot rejected");
    expect(wrote).toBe(false);
  });

  test("dual-writes both latest.json and latest.bin when wireFormat is 'both'", async () => {
    const backend = new FakeR2Backend();
    const r2 = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    const writes: Array<{ url: string; contentType: string; bytes: number }> =
      [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const rawBody = init?.body;
      const bytes =
        rawBody instanceof Uint8Array
          ? rawBody.byteLength
          : typeof rawBody === "string"
            ? new TextEncoder().encode(rawBody).byteLength
            : 0;
      writes.push({
        url: String(input),
        contentType: new Headers(init?.headers).get("content-type") ?? "",
        bytes,
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createF402BetTickerSink({
      liveBets: false,
      r2: true,
      r2Client: r2,
      wireFormat: "both",
    });
    const result = await sink.publishR2(SNAPSHOT);
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.url).toBe(
      "https://r2.test/bucket/f402-bet-ticker/latest.json",
    );
    expect(writes[0]!.contentType).toBe("application/json");
    expect(writes[1]!.url).toBe(
      "https://r2.test/bucket/f402-bet-ticker/latest.bin",
    );
    expect(writes[1]!.contentType).toBe("application/octet-stream");
    expect(writes[1]!.bytes).toBe(304);
  });

  test("writes only latest.bin when wireFormat is 'binary'", async () => {
    const backend = new FakeR2Backend();
    const r2 = R2S3Client.fromOptions(
      {
        bucket: "bucket",
        endpoint: "https://r2.test",
        accessKeyId: "a",
        secretAccessKey: "s",
        publicBase: "https://pub.test",
      },
      backend,
    );
    const writes: Array<{ url: string; contentType: string; bytes: number }> =
      [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const rawBody = init?.body;
      const bytes =
        rawBody instanceof Uint8Array
          ? rawBody.byteLength
          : typeof rawBody === "string"
            ? new TextEncoder().encode(rawBody).byteLength
            : 0;
      writes.push({
        url: String(input),
        contentType: new Headers(init?.headers).get("content-type") ?? "",
        bytes,
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const sink = createF402BetTickerSink({
      liveBets: false,
      r2: true,
      r2Client: r2,
      wireFormat: "binary",
    });
    const result = await sink.publishR2(SNAPSHOT);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://pub.test/f402-bet-ticker/latest.bin");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe(
      "https://r2.test/bucket/f402-bet-ticker/latest.bin",
    );
    expect(writes[0]!.contentType).toBe("application/octet-stream");
    expect(writes[0]!.bytes).toBe(304);
  });
});
