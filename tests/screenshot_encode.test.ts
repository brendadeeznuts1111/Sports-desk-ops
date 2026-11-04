import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildConfiguredImage,
  computeImagePlaceholder,
  encodeScreenshot,
  encodeScreenshotBlob,
  encodeScreenshotDataUrl,
  formatKittyDirectEscape,
  formatKittyShmemEscape,
  KITTY_DIRECT_CHUNK,
  kittyTransmission,
  looksLike,
  mimeTypeForFormat,
  parseResize,
  parseRotate,
  readImageMetadata,
  toScreenshotDataUri,
} from "../lib/screenshot_encode.ts";

// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

describe("screenshot encoding", () => {
  test("parses resize specs", () => {
    expect(parseResize("320")).toEqual({ width: 320 });
    expect(parseResize("320x200")).toEqual({ width: 320, height: 200 });
    expect(() => parseResize("320px")).toThrow("WxH");
    expect(() => parseResize("x200")).toThrow("WxH");
  });

  test("parses rotate specs", () => {
    expect(parseRotate("90")).toBe(90);
    expect(parseRotate("90deg")).toBe(90);
    expect(parseRotate("-180")).toBe(-180);
    expect(() => parseRotate("ninety")).toThrow("degrees");
    expect(() => parseRotate("deg")).toThrow("degrees");
    expect(() => parseRotate("45")).toThrow("multiple of 90");
    // Bun.Image.rotate(90.5) rotates by 90 without throwing.
    expect(() => parseRotate("90.5")).toThrow("multiple of 90");
  });

  test("detects each format by magic bytes (including RIFF..WEBP signature)", () => {
    expect(looksLike("png", PNG)).toBe(true);
    expect(looksLike("jpeg", PNG)).toBe(false);
    expect(looksLike("webp", PNG)).toBe(false);
    // RIFF header with WAVE instead of WEBP at offset 8 must not pass as WebP.
    const fakeRiff = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(looksLike("webp", fakeRiff)).toBe(false);
  });

  test("reads image header metadata from Uint8Array or Blob without full pixel decode", async () => {
    const meta = await readImageMetadata(PNG);
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.format).toBe("png");

    const blobMeta = await readImageMetadata(
      new Blob([PNG], { type: "image/png" }),
    );
    expect(blobMeta).toEqual(meta);
  });

  test("encodes webp via native .blob(), .toBase64(), .dataurl(), .placeholder(), and Response body integration", async () => {
    const webp = await encodeScreenshot(PNG, { format: "webp", quality: 70 });
    expect(looksLike("webp", webp)).toBe(true);
    expect(new TextDecoder().decode(webp.slice(8, 12))).toBe("WEBP");

    const inputBlob = new Blob([PNG], { type: "image/png" });
    const webpBlob = await encodeScreenshotBlob(inputBlob, {
      format: "webp",
      quality: 75,
    });
    expect(webpBlob.type).toBe("image/webp");
    expect(webpBlob.size).toBeGreaterThan(0);
    expect(
      looksLike("webp", new Uint8Array(await webpBlob.arrayBuffer())),
    ).toBe(true);

    const dataOut = await encodeScreenshotDataUrl(inputBlob, {
      format: "webp",
      quality: 75,
    });
    expect(dataOut.mimeType).toBe("image/webp");
    expect(dataOut.dataUri).toBe(`data:image/webp;base64,${dataOut.base64}`);

    const placeholder = await computeImagePlaceholder(inputBlob);
    expect(placeholder.startsWith("data:image/png;base64,")).toBe(true);

    // Bun.Image instance works directly as a Response body with automatic Content-Type.
    const response = new Response(
      buildConfiguredImage(inputBlob, { format: "webp", quality: 80 }),
    );
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(looksLike("webp", await response.bytes())).toBe(true);
  });

  test("builds data URIs and Kitty t=s shared-memory escape sequences", () => {
    expect(mimeTypeForFormat("png")).toBe("image/png");
    expect(mimeTypeForFormat("jpeg")).toBe("image/jpeg");
    expect(mimeTypeForFormat("webp")).toBe("image/webp");
    expect(mimeTypeForFormat("avif")).toBe("image/avif");
    expect(mimeTypeForFormat("heic")).toBe("image/heic");
    expect(toScreenshotDataUri("AAAA", "webp")).toBe(
      "data:image/webp;base64,AAAA",
    );

    const seg = formatKittyShmemEscape({
      name: "/bun-webview-1234-0",
      size: 4096,
    });
    expect(seg.name).toBe("/bun-webview-1234-0");
    expect(seg.size).toBe(4096);
    expect(seg.kittyEscape).toBe(
      `\x1b_Gf=100,t=s,a=T,S=4096;${btoa("/bun-webview-1234-0")}\x1b\\`,
    );
    expect(() => formatKittyShmemEscape({ name: "", size: 10 })).toThrow(
      "invalid",
    );
  });

  test("Kitty direct transmission fits in one escape when the PNG is small", () => {
    const b64 = PNG.toBase64();
    expect(formatKittyDirectEscape(b64)).toBe(
      `\x1b_Gf=100,t=d,a=T,m=0;${b64}\x1b\\`,
    );
    expect(() => formatKittyDirectEscape("")).toThrow("empty");
  });

  test("Kitty direct transmission splits a large PNG into 4096-byte chunks", () => {
    const b64 = "A".repeat(KITTY_DIRECT_CHUNK * 2 + 100);
    const escapes = formatKittyDirectEscape(b64)
      .split("\x1b\\")
      .filter((escape) => escape !== "")
      .map((escape) => {
        expect(escape.startsWith("\x1b_G")).toBe(true);
        const [keys, chunk] = escape.slice(3).split(";");
        return ["", keys, chunk] as const;
      });
    expect(escapes.map(([, keys]) => keys)).toEqual([
      "f=100,t=d,a=T,m=1",
      "m=1",
      "m=0",
    ]);
    expect(escapes.map(([, , chunk]) => chunk!.length)).toEqual([
      KITTY_DIRECT_CHUNK,
      KITTY_DIRECT_CHUNK,
      100,
    ]);
    expect(escapes.map(([, , chunk]) => chunk).join("")).toBe(b64);
  });

  test("Kitty uses shared memory only on a local POSIX terminal", () => {
    expect(kittyTransmission("darwin", {})).toBe("shmem");
    expect(kittyTransmission("linux", {})).toBe("shmem");
    expect(kittyTransmission("win32", {})).toBe("direct");
    expect(
      kittyTransmission("linux", {
        SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 51000",
      }),
    ).toBe("direct");
    expect(kittyTransmission("darwin", { SSH_TTY: "/dev/ttys003" })).toBe(
      "direct",
    );
    expect(kittyTransmission("darwin", { SSH_TTY: "" })).toBe("shmem");
  });

  test("encodes jpeg, palette png, and resizes with fit/withoutEnlargement", async () => {
    const jpeg = await encodeScreenshot(PNG, {
      format: "jpeg",
      quality: 50,
      progressive: true,
    });
    expect(looksLike("jpeg", jpeg)).toBe(true);

    const resized = await encodeScreenshot(PNG, {
      format: "png",
      palette: true,
      resize: {
        width: 4,
        height: 3,
        fit: "inside",
        withoutEnlargement: false,
        filter: "mitchell",
      },
    });
    const meta = await readImageMetadata(resized);
    expect(meta.format).toBe("png");
    expect(looksLike("png", resized)).toBe(true);
  });

  test("rotate changes encoded output after resize", async () => {
    const asset = join(
      import.meta.dir,
      "../docs/assets/pipeline-6-layer-data-cleaning.png",
    );
    expect(existsSync(asset)).toBe(true);
    const input = await Bun.file(asset).bytes();
    const base = await encodeScreenshot(input, {
      format: "png",
      resize: { width: 400, height: 100 },
    });
    const rotated = await encodeScreenshot(input, {
      format: "png",
      resize: { width: 400, height: 100 },
      rotate: 90,
    });
    expect(base.byteLength).toBeGreaterThan(0);
    expect(rotated.byteLength).toBeGreaterThan(0);
    const same =
      base.byteLength === rotated.byteLength &&
      base.every((byte, index) => byte === rotated[index]);
    expect(same).toBe(false);
  });

  test("rejects empty input and out-of-range sizes", async () => {
    await expect(
      encodeScreenshot(new Uint8Array(), { format: "png" }),
    ).rejects.toThrow("empty");
    await expect(
      encodeScreenshot(new Blob([]), { format: "png" }),
    ).rejects.toThrow("empty");
    await expect(
      encodeScreenshot(PNG, { format: "png", resize: { width: 0 } }),
    ).rejects.toThrow("out of range");
    await expect(
      encodeScreenshot(PNG, {
        format: "png",
        resize: { width: 2, height: 20000 },
      }),
    ).rejects.toThrow("out of range");
  });
});
