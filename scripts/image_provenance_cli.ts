#!/usr/bin/env bun
/**
 * Read header-only `sportsdesk:*` provenance from an R2 PNG/WebP artifact.
 *
 *   bun run image:provenance <path|https-url> [--json]
 *     [--expect-stream <id>] [--expect-gen <u32>] [--expect-merkle <hex>]
 *
 * Exits 0 only when the image header reads, all three keys are present, and every
 * supplied expectation matches. Missing metadata is a failure, never a silent pass.
 */

import {
  IMAGE_PROVENANCE_KEYS,
  readImageProvenance,
  verifyImageProvenance,
  type ImageProvenanceExpectation,
} from "../lib/image_provenance.ts";

const MAX_BYTES = 8 * 1024 * 1024;

function usage(): string {
  return `Usage: bun run image:provenance <path|https-url> [options]

Reads WebP/PNG header metadata only (no pixel decode) and reports
${IMAGE_PROVENANCE_KEYS.streamId}, ${IMAGE_PROVENANCE_KEYS.genU32},
${IMAGE_PROVENANCE_KEYS.merkleRoot}.

Options:
  --json                 Print the full report as JSON
  --expect-stream <id>   Fail unless sportsdesk:stream_id equals <id>
  --expect-gen <u32>     Fail unless sportsdesk:gen_u32 equals <u32>
  --expect-merkle <hex>  Fail unless sportsdesk:merkle_root equals <hex>
  -h, --help             Show this help

Examples:
  bun run image:provenance docs/assets/pipeline-6-layer-data-cleaning.webp
  bun run image:provenance https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/assets/ARCH-Guide.webp --json
  bun run image:provenance ./card.png --expect-stream gslive-tally --expect-gen 1042`;
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

async function readSource(source: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${source}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new Error(`refusing ${declared} bytes (limit ${MAX_BYTES})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      throw new Error(`refusing ${bytes.length} bytes (limit ${MAX_BYTES})`);
    }
    return bytes;
  }
  const file = Bun.file(source);
  if (!(await file.exists())) throw new Error(`no such file: ${source}`);
  if (file.size > MAX_BYTES) {
    throw new Error(`refusing ${file.size} bytes (limit ${MAX_BYTES})`);
  }
  return new Uint8Array(await file.bytes());
}

const args = Bun.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(args.length === 0 ? 2 : 0);
}

const VALUE_FLAGS = new Set([
  "--expect-stream",
  "--expect-gen",
  "--expect-merkle",
]);
let source: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (VALUE_FLAGS.has(arg)) {
    i += 1;
    continue;
  }
  if (arg.startsWith("--")) continue;
  source = arg;
  break;
}
if (source === undefined) {
  console.error("image:provenance: missing <path|https-url>\n");
  console.error(usage());
  process.exit(2);
}

const rawGen = argValue(args, "--expect-gen");
const expectStream = argValue(args, "--expect-stream");
const expectMerkle = argValue(args, "--expect-merkle");
const expected: ImageProvenanceExpectation = {
  ...(expectStream === undefined ? {} : { streamId: expectStream }),
  ...(rawGen === undefined ? {} : { genU32: Number(rawGen) }),
  ...(expectMerkle === undefined ? {} : { merkleRoot: expectMerkle }),
};
if (rawGen !== undefined && !/^\d+$/.test(rawGen)) {
  console.error(
    `image:provenance: --expect-gen must be a uint32 (got ${rawGen})`,
  );
  process.exit(2);
}

try {
  const bytes = await readSource(source);
  const report = await readImageProvenance(bytes);
  const hasExpectation = Object.keys(expected).length > 0;
  const verification = hasExpectation
    ? verifyImageProvenance(report, expected)
    : null;

  if (args.includes("--json")) {
    console.log(JSON.stringify({ source, report, verification }, null, 2));
  } else {
    console.log(`source:   ${source}`);
    console.log(
      `header:   ${report.available ? "ok" : "unavailable"} · ${report.format ?? "?"} ${report.width ?? "?"}×${report.height ?? "?"} · ${report.byteLength} bytes`,
    );
    console.log(
      `channels: ${report.channels.length > 0 ? report.channels.join(",") : "—"}`,
    );
    for (const key of Object.values(IMAGE_PROVENANCE_KEYS)) {
      console.log(`${key}: ${report.raw[key] ?? "—"}`);
    }
    console.log(
      `issues:   ${report.issues.length > 0 ? report.issues.join(", ") : "none"}`,
    );
    if (verification !== null) {
      console.log(
        `verify:   ${verification.ok ? "ok" : `mismatch (${verification.mismatches.join(", ")})`}`,
      );
    }
  }

  const complete =
    report.fields.streamId !== null &&
    report.fields.genU32 !== null &&
    report.fields.merkleRoot !== null;
  const verified = verification === null || verification.ok;
  process.exit(report.available && complete && verified ? 0 : 1);
} catch (error) {
  console.error(
    `image:provenance: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
