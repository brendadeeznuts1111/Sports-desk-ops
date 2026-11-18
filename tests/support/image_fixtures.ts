/**
 * @file tests/support/image_fixtures.ts
 * @description Shared raster fixtures for the Bun.Image tests: one 1×1 PNG and encoders that
 * produce arbitrary-size PNG/JPEG inputs without committing binary blobs to the repo.
 */

import { writeFileSync } from "node:fs";

export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function png1x1(): Uint8Array {
  return Uint8Array.from(Buffer.from(PNG_1X1_BASE64, "base64"));
}

async function writeImage(
  path: string,
  width: number,
  height: number,
  encode: (image: Bun.Image) => Bun.Image,
): Promise<void> {
  const pipeline = encode(new Bun.Image(png1x1()).resize(width, height));
  writeFileSync(path, await pipeline.bytes());
}

export async function makePng(
  path: string,
  width: number,
  height: number,
): Promise<void> {
  await writeImage(path, width, height, (image) => image.png());
}

export async function makeJpeg(
  path: string,
  width: number,
  height: number,
  quality = 80,
): Promise<void> {
  await writeImage(path, width, height, (image) => image.jpeg({ quality }));
}
