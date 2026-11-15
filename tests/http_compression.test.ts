import { describe, expect, test } from "bun:test";
import {
  negotiateEncoding,
  encodedResponse,
  forwardProxiedResponse,
  prepareProxyRequestHeaders,
  resetEncodedBodies,
} from "../lib/http_compression.ts";

/**
 * The daemon served every page identity-encoded: /graph is 657 KB, / is 146 KB, the graph feed is
 * 217 KB, and the agent tree 94 KB (measured 2026-11-02). Bun does not compress a Response on its
 * own, so the header has to be honoured here.
 */

describe("negotiateEncoding", () => {
  test("no header means identity", () => {
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
  });

  test("picks a supported encoding", () => {
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("zstd")).toBe("zstd");
    expect(negotiateEncoding("deflate, br")).toBeNull();
  });

  test("q-values order the choice, and q=0 is a refusal", () => {
    expect(negotiateEncoding("gzip;q=0.9, zstd;q=0.4")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0")).toBeNull();
    expect(negotiateEncoding("gzip;q=0, zstd;q=1")).toBe("zstd");
  });

  test("a wildcard covers encodings that are not named", () => {
    expect(negotiateEncoding("*")).toBe("zstd");
    expect(negotiateEncoding("*;q=0.1, gzip;q=0.9")).toBe("gzip");
    expect(negotiateEncoding("*;q=0")).toBeNull();
  });

  test("identity is not something to encode", () => {
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("identity;q=1")).toBeNull();
  });
});

describe("encodedResponse", () => {
  const req = (accept?: string): Request =>
    new Request("http://localhost/x", {
      headers: accept === undefined ? {} : { "accept-encoding": accept },
    });

  test("compresses when the client asked, and says so", async () => {
    resetEncodedBodies();
    const body = new TextEncoder().encode("a".repeat(4000));
    const response = encodedResponse(req("gzip"), {
      version: "v1",
      contentType: "text/plain",
      produce: () => body,
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    const wire = new Uint8Array(await response.arrayBuffer());
    expect(wire.byteLength).toBeLessThan(body.byteLength);
    expect(
      Buffer.compare(Buffer.from(Bun.gunzipSync(wire)), Buffer.from(body)),
    ).toBe(0);
    expect(response.headers.get("content-length")).toBe(
      String(wire.byteLength),
    );
  });

  test("serves identity when nothing is accepted, with a length", async () => {
    resetEncodedBodies();
    const body = new TextEncoder().encode("a".repeat(4000));
    const response = encodedResponse(req(), {
      version: "v1",
      contentType: "text/plain",
      produce: () => body,
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(response.headers.get("content-length")).toBe(
      String(body.byteLength),
    );
  });

  test("a body too small to be worth framing is left alone", async () => {
    resetEncodedBodies();
    const response = encodedResponse(req("zstd"), {
      version: "small",
      contentType: "text/plain",
      produce: () => new TextEncoder().encode("ok"),
    });
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("produce() runs once per version, not once per request", () => {
    resetEncodedBodies();
    let produced = 0;
    const once = (version: string) =>
      encodedResponse(req("gzip"), {
        version,
        contentType: "text/plain",
        produce: () => {
          produced += 1;
          return new TextEncoder().encode("c".repeat(4000));
        },
      });
    once("a");
    once("a");
    expect(produced).toBe(1);
    once("b");
    expect(produced).toBe(2);
  });

  test("Vary keeps a header the caller already set", async () => {
    resetEncodedBodies();
    const response = encodedResponse(req("gzip"), {
      version: "vary",
      contentType: "text/plain",
      produce: () => new TextEncoder().encode("d".repeat(4000)),
      headers: { Vary: "Origin" },
    });
    expect(response.headers.get("vary")).toBe("Origin, Accept-Encoding");
  });

  test("Vary deduplicates Accept-Encoding regardless of case", async () => {
    resetEncodedBodies();
    const response = encodedResponse(req("gzip"), {
      version: "vary-dup",
      contentType: "text/plain",
      produce: () => new TextEncoder().encode("e".repeat(4000)),
      headers: { vary: "Origin, Accept-Encoding" },
    });
    expect(response.headers.get("vary")).toBe("Origin, Accept-Encoding");
  });

  test("skips compression when caller already set Content-Encoding", async () => {
    resetEncodedBodies();
    const precompressed = new Uint8Array(
      Bun.gzipSync(Buffer.from("hello".repeat(500))),
    );
    const response = encodedResponse(req("zstd"), {
      version: "preencoded",
      contentType: "application/json",
      produce: () => precompressed,
      headers: { "Content-Encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-length")).toBe(
      String(precompressed.byteLength),
    );
    const wire = new Uint8Array(await response.arrayBuffer());
    expect(wire[0]).toBe(0x1f);
    expect(wire[1]).toBe(0x8b);
  });

  test("proxy chain strips decoded headers so Bun.serve never emits ERR_CONTENT_DECODING_FAILED", async () => {
    resetEncodedBodies();
    const expectedJson = JSON.stringify({
      ok: true,
      payload: "x".repeat(3000),
    });

    const apiServer = Bun.serve({
      port: 0,
      routes: {
        "/api/dashboard": (r) =>
          encodedResponse(r, {
            version: "proxy-test-v1",
            contentType: "application/json; charset=utf-8",
            produce: () => new TextEncoder().encode(expectedJson),
          }),
      },
    });

    const proxyServer = Bun.serve({
      port: 0,
      async fetch(r) {
        const u = new URL(r.url);
        // Simulate a proxy that forwards even if client sent zstd/gzip, verifying both paths
        const upstreamWithForcedEncoding = await fetch(
          `${apiServer.url.origin}${u.pathname}`,
          {
            headers: u.searchParams.has("identity")
              ? prepareProxyRequestHeaders(r.headers)
              : r.headers,
          },
        );
        return forwardProxiedResponse(upstreamWithForcedEncoding);
      },
    });

    try {
      for (const query of ["", "?identity=1"]) {
        for (const accept of ["gzip", "zstd", "gzip, deflate, br, zstd"]) {
          const res = await fetch(
            `${proxyServer.url.origin}/api/dashboard${query}`,
            {
              headers: { "Accept-Encoding": accept },
            },
          );
          expect(res.status).toBe(200);
          expect(res.headers.get("content-encoding")).toBeNull();
          expect(await res.text()).toBe(expectedJson);
        }
      }
    } finally {
      proxyServer.stop(true);
      apiServer.stop(true);
    }
  });
});
