import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { R2S3Client, type R2S3ClientBackend } from "../lib/r2_s3_client.ts";
import {
  buildWagersLiveEvent,
  createWagersLiveSink,
  isWagersLiveEvent,
  resolveWagersGatewayUrl,
  WAGERS_LIVE_CHANNEL,
} from "../lib/wagers_live_sink.ts";
import type { WagersHistoryLine } from "../scripts/gslive_wagers_by_state.ts";

const LINE: WagersHistoryLine = {
  schemaVersion: 1,
  capturedAt: "2026-11-03T18:00:00.000Z",
  sourceKind: "live-ajax.php",
  totals: {
    legs: 4,
    wagers: 2,
    spanning: 0,
    legRisk: 40,
    wagerRisk: 40,
    legToWin: 32,
    legResult: 0,
  },
  states: [
    {
      state: "pending",
      legs: 4,
      wagers: 2,
      wagerRiskAttributed: 40,
    },
  ],
  delta: null,
  qualityFlags: [],
  alerts: [],
};

const OUTCOME = { historyLine: LINE, artifactSha256: "a".repeat(64) };

const originalFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
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

describe("wagers live sink", () => {
  test("builds an aggregate-only PII-free event", () => {
    const event = buildWagersLiveEvent(OUTCOME);
    expect(event).toMatchObject({
      schemaVersion: 1,
      kind: "gslive-wagers",
      capturedAt: LINE.capturedAt,
      artifactSha256: OUTCOME.artifactSha256,
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain("Ticket");
    expect(json).not.toContain("customer");
    expect(json).not.toContain("login");
    expect(isWagersLiveEvent(event)).toBe(true);
  });

  test("resolves the gateway URL from env then port/default", () => {
    expect(
      resolveWagersGatewayUrl({ BLOB_GATEWAY_URL: "http://gateway:9999/" }),
    ).toBe("http://gateway:9999");
    expect(resolveWagersGatewayUrl({ BLOB_PORT: "4040" })).toBe(
      "http://127.0.0.1:4040",
    );
    expect(resolveWagersGatewayUrl({})).toBe("http://127.0.0.1:4021");
  });

  test("posts exactly one gslive-wagers event with bearer auth", async () => {
    let captured: { url: string; body: unknown; headers: Headers } | undefined;
    const sink = createWagersLiveSink({
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
        return Response.json({ published: 3 });
      },
    });
    const result = await sink.publishLiveBets(OUTCOME);
    expect(result).toEqual({ ok: true, published: 3 });
    expect(captured?.url).toBe("http://gateway.test/api/v1/live-bets");
    expect(captured?.headers.get("authorization")).toBe("Bearer token");
    expect(captured?.body).toMatchObject({
      channel: WAGERS_LIVE_CHANNEL,
      event: { kind: "gslive-wagers" },
    });
  });

  test("reports gateway failures without throwing", async () => {
    const sink = createWagersLiveSink({
      liveBets: true,
      r2: false,
      gatewayUrl: "http://gateway.test",
      apiToken: "token",
      fetchImpl: (async () =>
        new Response("no", { status: 503 })) as unknown as typeof fetch,
    });
    const result = await sink.publishLiveBets(OUTCOME);
    expect(result).toEqual({
      ok: false,
      error: "live-bets gateway returned HTTP 503",
    });
  });

  test("writes the R2 summary and local sidecar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wagers-sink-"));
    dirs.push(dir);
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
    globalThis.fetch = (async () =>
      new Response("", { status: 200 })) as unknown as typeof fetch;
    const sink = createWagersLiveSink({
      liveBets: false,
      r2: true,
      localSidecarPath: join(dir, "latest.json"),
      r2Client: r2,
    });
    const result = await sink.publishR2(OUTCOME);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://pub.test/wagers-by-state/latest.json");
    expect(backend.presigns).toEqual(["wagers-by-state/latest.json"]);
    const sidecar = (await Bun.file(join(dir, "latest.json")).json()) as {
      kind: string;
    };
    expect(sidecar.kind).toBe("gslive-wagers");
  });
});
