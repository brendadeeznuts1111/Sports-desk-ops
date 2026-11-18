/**
 * Child process for tests/runtime_preflight_tls_ciphers.test.ts. Optionally applies the preflight
 * cipher pin, then calls `fetch` and `Bun.S3Client` once per loopback port and prints one JSON
 * line. The S3 credentials are placeholders; the listener never checks a signature.
 */
import { pinAeadTls12Ciphers } from "../../src/telemetry/runtime-preflight.ts";

type Outcome =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly code: string };

async function attempt(run: () => Promise<string>): Promise<Outcome> {
  try {
    return { ok: true, body: await run() };
  } catch (error) {
    return {
      ok: false,
      code: String((error as { code?: unknown }).code ?? "unknown"),
    };
  }
}

const [mode, ...ports] = Bun.argv.slice(2);
if (mode === "pin") pinAeadTls12Ciphers();

const results: Record<string, { fetch: Outcome; s3: Outcome }> = {};
for (const port of ports) {
  const endpoint = `https://localhost:${port}`;
  const s3 = new Bun.S3Client({
    endpoint,
    bucket: "probe-bucket",
    accessKeyId: "probe-access-key",
    secretAccessKey: "probe-secret-key",
  });
  results[port] = {
    fetch: await attempt(async () => (await fetch(`${endpoint}/`)).text()),
    s3: await attempt(() => s3.file("probe.txt").text()),
  };
}
console.log(JSON.stringify(results));
