import { describe, expect, test } from "bun:test";

import { webpBytesFromScreenshotBlob } from "./f402_agent_graph_capture.ts";
import { looksLike } from "./screenshot_encode.ts";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("f402_agent_graph_webp", () => {
  test("webpBytesFromScreenshotBlob encodes PNG blob via Bun.Image", async () => {
    const pngBlob = new Blob([PNG], { type: "image/png" });
    const webpBlob = await webpBytesFromScreenshotBlob(pngBlob, {
      maxWidth: 64,
      maxHeight: 64,
      quality: 80,
    });
    const bytes = new Uint8Array(await webpBlob.arrayBuffer());
    expect(looksLike("webp", bytes)).toBe(true);
    const meta = await new Bun.Image(bytes).metadata();
    expect(meta.format).toBe("webp");
  });
});
