#!/usr/bin/env bun
const file = process.argv[2];
if (!file) {
  console.error("Usage: image-meta <file|- for stdin>");
  process.exit(1);
}

const image = file === "-" ? Bun.stdin.image() : Bun.file(file).image();

try {
  const meta = await image.metadata();
  console.log(JSON.stringify(meta, null, 2));
} catch (error) {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  const prefix = code === "" || message.startsWith(code) ? "" : `${code}: `;
  console.error(`image-meta: ${prefix}${message}`);
  process.exit(1);
}
