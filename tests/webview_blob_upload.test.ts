import { afterEach, describe, expect, test } from "bun:test";

import {
  blobKeyFromPath,
  resolveBlobGatewayUrl,
  uploadScreenshotToGateway,
} from "../lib/blob_upload.ts";
import {
  createBlobLiveBetsServer,
  MemoryBlobStore,
} from "../services/blob_and_live_bets_server.ts";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TOKEN = "blob-upload-test-token";
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function pngBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64"));
}

function startGateway(): { url: string; store: MemoryBlobStore } {
  const store = new MemoryBlobStore();
  const { server, close } = createBlobLiveBetsServer({
    blobs: store,
    apiToken: TOKEN,
    ticketSecret: "blob-upload-ticket-secret",
    port: 0,
    hostname: "127.0.0.1",
  });
  stops.push(() => close(true));
  return { url: `http://127.0.0.1:${server.port}`, store };
}

describe("screenshot blob upload", () => {
  test("derives a gateway-valid key from a screenshot path", () => {
    expect(blobKeyFromPath("/tmp/manager-ui shot 01.png")).toBe(
      "manager-ui-shot-01",
    );
    expect(blobKeyFromPath("/tmp/!!.png", "fallback")).toBe("fallback");
  });

  test("resolves BLOB_GATEWAY_URL then BLOB_PORT", () => {
    expect(
      resolveBlobGatewayUrl({ BLOB_GATEWAY_URL: "http://gateway:9000/" }),
    ).toBe("http://gateway:9000");
    expect(resolveBlobGatewayUrl({ BLOB_PORT: "4041" })).toBe(
      "http://127.0.0.1:4041",
    );
  });

  test("uploads a small PNG without upscaling and verifies WebP", async () => {
    const gateway = startGateway();
    const result = await uploadScreenshotToGateway(pngBytes(), "image/png", {
      gatewayUrl: gateway.url,
      apiToken: TOKEN,
      key: "small-shot",
    });
    expect(result.key).toBe("small-shot");
    expect(result.objectKey).toBe("blobs/small-shot.webp");
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    const stored = gateway.store.blobs.get("small-shot");
    expect(stored?.contentType).toBe("image/webp");
    expect(new TextDecoder().decode(stored?.bytes.slice(0, 4))).toBe("RIFF");
  });

  test("downscales a large capture to 1280px through the real gateway", async () => {
    const gateway = startGateway();
    const large = await new Bun.Image(pngBytes())
      .resize(2000, 1000, { fit: "fill" })
      .png()
      .bytes();
    const result = await uploadScreenshotToGateway(large, "image/png", {
      gatewayUrl: gateway.url,
      apiToken: TOKEN,
      key: "large-shot",
    });
    expect(result.width).toBe(1280);
    expect(result.height).toBe(640);
    expect(result.bytesWritten).toBeGreaterThan(0);
  });

  test("fails closed without a token or on gateway rejection", async () => {
    await expect(
      uploadScreenshotToGateway(pngBytes(), "image/png", {
        gatewayUrl: "http://127.0.0.1:1",
        apiToken: "",
      }),
    ).rejects.toThrow(/BLOB_API_TOKEN/);

    const gateway = startGateway();
    await expect(
      uploadScreenshotToGateway(pngBytes(), "image/png", {
        gatewayUrl: gateway.url,
        apiToken: "wrong",
        key: "wrong-token",
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
