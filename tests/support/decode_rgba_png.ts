/** Test-only 8-bit RGBA PNG reader, independent of Bun.Image's color conversion.
 * Adapted from the MIT-licensed upstream regression helper:
 * https://github.com/oven-sh/bun/blob/7b0b70ece52704561a8f9ee36a2b6f10cd588acf/test/js/bun/image/image.test.ts
 */
import { inflateSync } from "node:zlib";

export function decodeRgbaPng(bytes: Uint8Array) {
  const png = Buffer.from(bytes);
  if (
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Expected PNG signature");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    png.readUInt8(24) !== 8 ||
    png.readUInt8(25) !== 6 ||
    png.readUInt8(28) !== 0
  )
    throw new Error("Expected non-interlaced 8-bit RGBA PNG");
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT")
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    if (kind === "IEND") break;
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height)
    throw new Error("Unexpected PNG scanline length");
  const pixels = Buffer.alloc(width * height * 4);
  let position = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw.readUInt8(position++);
    if (filter > 4) throw new Error("Unsupported PNG filter");
    for (let column = 0; column < stride; column++) {
      const index = row * stride + column;
      const left = column >= 4 ? pixels.readUInt8(index - 4) : 0;
      const above = row > 0 ? pixels.readUInt8(index - stride) : 0;
      const upperLeft =
        row > 0 && column >= 4 ? pixels.readUInt8(index - stride - 4) : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      if (filter === 2) prediction = above;
      if (filter === 3) prediction = Math.floor((left + above) / 2);
      if (filter === 4) {
        const estimate = left + above - upperLeft;
        const a = Math.abs(estimate - left),
          b = Math.abs(estimate - above),
          c = Math.abs(estimate - upperLeft);
        prediction = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      }
      pixels[index] = (raw.readUInt8(position++) + prediction) & 255;
    }
  }
  return { width, height, pixels };
}
