#!/usr/bin/env bun
/**
 * @file bin/image-meta.ts
 * @description Native `Bun.file().image()` & `Bun.Image` metadata, SHA-256, and LQIP inspector.
 *
 * Default bare invocation (`image-meta <file>`) prints `{ width, height, format }` for strict
 * CLI compatibility. Pass `--full` (or `--lqip`) for byte size, SHA-256, MIME type, and inline
 * blur placeholder, and `--yaml` to emit `Bun.YAML.stringify` output.
 */

import { YAML } from "bun";
import { contentTypeFor } from "../lib/logo_image.ts";

Bun.Image.backend = "bun";

const rawArgs = process.argv.slice(2);
let full = false;
let lqipOnly = false;
let asYaml = false;
let file: string | undefined;

for (const arg of rawArgs) {
  if (arg === "--help" || arg === "-h") {
    console.log(
      "Usage: image-meta [--full] [--lqip] [--yaml] <file|- for stdin>",
    );
    process.exit(0);
  } else if (arg === "--full") {
    full = true;
  } else if (arg === "--lqip") {
    lqipOnly = true;
  } else if (arg === "--yaml") {
    asYaml = true;
  } else if (!arg.startsWith("-") || arg === "-") {
    file = arg;
  }
}

if (!file) {
  console.error(
    "Usage: image-meta [--full] [--lqip] [--yaml] <file|- for stdin>",
  );
  process.exit(1);
}

try {
  if (!full && !lqipOnly) {
    const image = file === "-" ? Bun.stdin.image() : Bun.file(file).image();
    const meta = await image.metadata();
    console.log(
      asYaml
        ? YAML.stringify(meta, null, 2).trimEnd()
        : JSON.stringify(meta, null, 2),
    );
  } else {
    const bytes =
      file === "-"
        ? new Uint8Array(
            await Bun.readableStreamToArrayBuffer(Bun.stdin.stream()),
          )
        : new Uint8Array(await Bun.file(file).arrayBuffer());
    const image = new Bun.Image(bytes);
    const meta = await image.metadata();
    const placeholder = await image.placeholder();
    if (lqipOnly && !full) {
      console.log(placeholder);
    } else {
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const payload = {
        file: file === "-" ? "<stdin>" : file,
        width: meta.width,
        height: meta.height,
        format: meta.format,
        contentType: contentTypeFor(meta.format),
        bytes: bytes.byteLength,
        sha256,
        placeholder,
      };
      console.log(
        asYaml
          ? YAML.stringify(payload, null, 2).trimEnd()
          : JSON.stringify(payload, null, 2),
      );
    }
  }
} catch (error) {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  const prefix = code === "" || message.startsWith(code) ? "" : `${code}: `;
  console.error(`image-meta: ${prefix}${message}`);
  process.exit(1);
}
