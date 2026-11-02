#!/usr/bin/env bun
const file = process.argv[2];
if (!file) {
  console.error("Usage: image-meta <file|- for stdin>");
  process.exit(1);
}

let image: Bun.Image;
if (file === "-") {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  image = new Bun.Image(buf);
} else {
  image = Bun.file(file).image();
}

const meta = await image.metadata();
console.log(JSON.stringify(meta, null, 2));