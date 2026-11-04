#!/usr/bin/env bun
/**
 * Echo the fields of a multipart or urlencoded body.
 *
 * Bun 1.4.4's `new Blob([bytes], { type }).formData()` rejects Bun's own
 * multipart encoding ("missing final boundary"), which is why the daemon uses
 * `req.formData()` (services/sportsdesk_webview_server.ts). The CLI follows the
 * same path: wrap the bytes in a Request and let the request body parser decode
 * them.
 */
const file = process.argv[2];
const contentType = process.argv[3] || "application/x-www-form-urlencoded";
if (!file) {
  console.error("Usage: blob-formdata <file|- for stdin> [content-type]");
  process.exit(1);
}

const bytes =
  file === "-" ? await Bun.stdin.bytes() : await Bun.file(file).bytes();

/** Bun's Request parser decodes multipart where Blob.formData() does not. */
async function parseForm(bytes: Uint8Array, contentType: string) {
  return await new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes,
  }).formData();
}

let form: Awaited<ReturnType<typeof parseForm>>;
try {
  form = await parseForm(bytes, contentType);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`blob-formdata: ${message}`);
  process.exit(1);
}

const out: Record<string, unknown> = {};
form.forEach((value, name) => {
  const entry =
    typeof value === "string"
      ? value
      : { filename: value.name, size: value.size, type: value.type };
  if (out[name] === undefined) out[name] = entry;
  else if (Array.isArray(out[name])) (out[name] as unknown[]).push(entry);
  else out[name] = [out[name], entry];
});
console.log(JSON.stringify(out, null, 2));
