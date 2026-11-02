#!/usr/bin/env bun
const file = process.argv[2];
const contentType = process.argv[3] || "application/x-www-form-urlencoded";
if (!file) {
  console.error("Usage: blob-formdata <file|- for stdin> [content-type]");
  process.exit(1);
}

let buf: Uint8Array;
if (file === "-") {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  buf = Buffer.concat(chunks);
} else {
  buf = await Bun.file(file).bytes();
}

const blob = new Blob([buf], { type: contentType });
const fd = await blob.formData();
const out: Record<string, unknown> = {};
for (const [k, v] of fd.entries()) {
  const value =
    (v as unknown) instanceof File
      ? { filename: (v as any).name, size: (v as any).size, type: (v as any).type }
      : String(v);
  if (out[k] === undefined) out[k] = value;
  else if (Array.isArray(out[k])) (out[k] as unknown[]).push(value);
  else out[k] = [out[k], value];
}
console.log(JSON.stringify(out, null, 2));