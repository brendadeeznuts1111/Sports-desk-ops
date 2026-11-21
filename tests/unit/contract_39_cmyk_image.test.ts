import { expect, test } from "bun:test";
import { decodeRgbaPng } from "../support/decode_rgba_png.ts";

// MIT-licensed Bun quadrant fixtures, pinned to the original regression fix:
// https://github.com/oven-sh/bun/blob/7b0b70ece52704561a8f9ee36a2b6f10cd588acf/test/js/bun/image/image.test.ts
for (const encoding of ["cmyk", "ycck"] as const) {
  test(`Contract #39: ${encoding} JPEG decodes, resizes and encodes as WebP`, async () => {
    const input = new URL(
      `../fixtures/image/${encoding}-quadrants.jpg`,
      import.meta.url,
    );
    const bytes = await Bun.file(input).bytes();
    // APP14 Adobe transform identifies CMYK (0) versus YCCK (2).
    expect(bytes[3]).toBe(0xee);
    expect(bytes[17]).toBe(encoding === "cmyk" ? 0 : 2);
    expect(await new Bun.Image(bytes).metadata()).toEqual({
      width: 64,
      height: 64,
      format: "jpeg",
    });
    const output = await new Bun.Image(input.pathname)
      .resize(400, 400)
      .webp()
      .bytes();
    expect(Buffer.from(output.subarray(0, 4)).toString()).toBe("RIFF");
    expect(Buffer.from(output.subarray(8, 12)).toString()).toBe("WEBP");
    expect(await new Bun.Image(output).metadata()).toEqual({
      width: 400,
      height: 400,
      format: "webp",
    });
    // Force another full decode of the encoded output, beyond header inspection.
    expect((await new Bun.Image(output).png().bytes()).length).toBeGreaterThan(
      0,
    );
  });
}

// Upstream's CMYK/YCCK fixture quadrants include mixed ink and black to detect
// omitted K-channel multiplication, as well as swapped/inverted color channels.
for (const encoding of ["cmyk", "ycck"] as const) {
  for (const webpRoundTrip of [false, true]) {
    test(`${encoding} preserves quadrant colors (WebP round trip=${webpRoundTrip})`, async () => {
      const input = new URL(
        `../fixtures/image/${encoding}-quadrants.jpg`,
        import.meta.url,
      );
      const image = new Bun.Image(input.pathname);
      const pipeline = webpRoundTrip
        ? new Bun.Image(
            await image.resize(400, 400).webp({ quality: 95 }).bytes(),
          )
        : image;
      const decoded = decodeRgbaPng(await pipeline.png().bytes());
      const size = webpRoundTrip ? 400 : 64;
      expect([decoded.width, decoded.height]).toEqual([size, size]);
      const quadrants = [
        { x: 0.25, y: 0.25, rgb: [0, 255, 255] },
        { x: 0.75, y: 0.25, rgb: [255, 0, 255] },
        { x: 0.25, y: 0.75, rgb: [95, 143, 191] },
        { x: 0.75, y: 0.75, rgb: [0, 0, 0] },
      ];
      for (const { x, y, rgb } of quadrants) {
        const offset = (Math.floor(y * size) * size + Math.floor(x * size)) * 4;
        const actual = Array.from(decoded.pixels.subarray(offset, offset + 3));
        expect(
          Math.max(
            ...actual.map((value, channel) => Math.abs(value - rgb[channel]!)),
          ),
        ).toBeLessThanOrEqual(8);
        expect(decoded.pixels.readUInt8(offset + 3)).toBe(255);
      }
    });
  }
}
