#!/usr/bin/env bun
/**
 * @file cli/sportsdesk_screenshot_cli.ts
 * @description Capture the clipboard screenshot, optimize it, upload it to Cloudflare R2, and record
 * one manifest entry.
 *
 *   ./bin/dx shot-clip                          # capture, optimize, upload, append manifest
 *   ./bin/dx shot-clip --dry-run --json         # plan only: no upload, no manifest write
 *   ./bin/dx shot-clip --file shot.png          # bypass the clipboard (CI, tests, a saved file)
 *   ./bin/dx shot-clip --watch                  # capture again whenever the clipboard changes
 *
 * Exit codes: 0 ok · 1 failure · 2 usage · 3 clipboard empty · 4 R2 credentials missing ·
 * 5 upload rejected.
 *
 * Fails closed: without credentials the command refuses to pretend the capture was published, and
 * `--dry-run` writes nothing at all.
 */
import path from "node:path";
import { parseArgs } from "node:util";

import {
  appendScreenshotManifestEntry,
  ERR_SCREENSHOT_CLIPBOARD_EMPTY,
  optimizeScreenshot,
  publicUrlFor,
  readClipboardImage,
  readScreenshotManifest,
  SCREENSHOT_FORMATS,
  SCREENSHOT_MANIFEST_FILENAME,
  ScreenshotError,
  screenshotObjectKey,
  sha256Hex,
  type ScreenshotFormat,
  type ScreenshotManifestEntry,
  writeScreenshotManifest,
} from "../lib/screenshot_clipboard.ts";
import { R2S3Client } from "../lib/r2_s3_client.ts";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_CLIPBOARD_EMPTY = 3;
const EXIT_CREDENTIALS = 4;
const EXIT_UPLOAD = 5;

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_QUALITY = 78;
const DEFAULT_PREFIX = "screenies";
const DEFAULT_MANIFEST = path.join("scratch", SCREENSHOT_MANIFEST_FILENAME);
const DEFAULT_INTERVAL_MS = 1500;

export interface ScreenshotCliOptions {
  readonly file: string | null;
  readonly output: string | null;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly maxEdge: number;
  readonly quality: number;
  readonly format: ScreenshotFormat;
  readonly prefix: string;
  readonly manifest: string;
  readonly force: boolean;
  readonly watch: boolean;
  readonly intervalMs: number;
  readonly help: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly options: ScreenshotCliOptions }
  | { readonly ok: false; readonly message: string };

function positiveInt(
  name: string,
  raw: string | undefined,
): ParseResult | number {
  if (raw === undefined) {
    return { ok: false, message: `--${name} needs a value` };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      ok: false,
      message: `--${name} expects a positive integer, got '${raw}'`,
    };
  }
  return parsed;
}

function parseFormat(raw: string | undefined): ScreenshotFormat | null {
  if (raw === undefined) return null;
  const match = SCREENSHOT_FORMATS.find((format) => format === raw);
  return match ?? null;
}

/** Parse and validate argv. Pure, so the contract is testable without spawning. */
export function parseScreenshotArgs(argv: readonly string[]): ParseResult {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        file: { type: "string" },
        output: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "max-edge": { type: "string" },
        quality: { type: "string" },
        format: { type: "string" },
        prefix: { type: "string" },
        manifest: { type: "string" },
        force: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        interval: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const maxEdgeRaw = values["max-edge"];
  const maxEdge =
    maxEdgeRaw === undefined
      ? DEFAULT_MAX_EDGE
      : positiveInt("max-edge", String(maxEdgeRaw));
  if (typeof maxEdge !== "number") return maxEdge;
  const qualityRaw = values["quality"];
  const quality =
    qualityRaw === undefined
      ? DEFAULT_QUALITY
      : positiveInt("quality", String(qualityRaw));
  if (typeof quality !== "number") return quality;
  if (quality > 100) {
    return { ok: false, message: `--quality is 1-100, got ${quality}` };
  }
  const intervalRaw = values["interval"];
  const intervalMs =
    intervalRaw === undefined
      ? DEFAULT_INTERVAL_MS
      : positiveInt("interval", String(intervalRaw));
  if (typeof intervalMs !== "number") return intervalMs;

  const formatRaw = values["format"];
  const format =
    formatRaw === undefined ? "webp" : parseFormat(String(formatRaw));
  if (format === null) {
    return {
      ok: false,
      message: `--format expects one of ${SCREENSHOT_FORMATS.join(", ")}, got '${String(formatRaw)}'`,
    };
  }

  const fileRaw = values["file"];
  const file = fileRaw === undefined ? null : String(fileRaw);
  if (file !== null && file.trim().length === 0) {
    return { ok: false, message: "--file needs a path" };
  }
  const outputRaw = values["output"];
  const output = outputRaw === undefined ? null : String(outputRaw);
  const prefixRaw = values["prefix"];
  const prefix =
    prefixRaw === undefined ? DEFAULT_PREFIX : String(prefixRaw).trim();
  if (prefix.length === 0) {
    return { ok: false, message: "--prefix needs a non-empty object prefix" };
  }
  const manifestRaw = values["manifest"];
  const manifest =
    manifestRaw === undefined ? DEFAULT_MANIFEST : String(manifestRaw);

  return {
    ok: true,
    options: {
      file,
      output,
      dryRun: values["dry-run"] === true,
      json: values["json"] === true,
      maxEdge,
      quality,
      format,
      prefix,
      manifest,
      force: values["force"] === true,
      watch: values["watch"] === true,
      intervalMs,
      help: values["help"] === true,
    },
  };
}

export interface CaptureSummary {
  readonly status: "uploaded" | "already-present" | "dry-run";
  readonly sha256: string;
  readonly key: string;
  readonly publicUrl: string | null;
  readonly bytes: number;
  readonly sourceBytes: number;
  readonly savedPercent: number | null;
  readonly width: number;
  readonly height: number;
  readonly format: ScreenshotFormat;
  readonly manifestPath: string;
  readonly clipboardChangeCount: number | null;
  readonly localPath: string | null;
}

/** The upload surface this command needs; the default wraps R2S3Client, tests inject a fake. */
export interface ScreenshotUploader {
  readonly publicBase: string;
  readonly put: (
    key: string,
    bytes: Uint8Array,
    mime: string,
    metadata: Readonly<Record<string, string>>,
  ) => Promise<number>;
}

export interface CaptureDeps {
  /** Resolves the uploader, or null when no credentials are available. */
  readonly resolveUploader?: () => Promise<ScreenshotUploader | null>;
}

/** Default uploader: the repo's scoped R2 client, or null when credentials are missing. */
async function defaultUploader(): Promise<ScreenshotUploader | null> {
  const client = await R2S3Client.fromEnvOrSecrets();
  if (client === null) return null;
  return {
    publicBase: client.publicBase,
    put: (key, bytes, mime, metadata) =>
      client.putWithMetadata(key, bytes, { type: mime, metadata }),
  };
}

async function loadSource(options: ScreenshotCliOptions): Promise<Blob> {
  if (options.file !== null) {
    const file = Bun.file(options.file);
    if (!(await file.exists())) {
      throw new ScreenshotError(
        "ERR_SCREENSHOT_SOURCE_MISSING",
        `--file '${options.file}' does not exist`,
      );
    }
    // BunFile has no blob() in the 1.4.4 types; wrap the bytes so the encoder sees one Blob shape.
    return new Blob([await file.bytes()]);
  }
  return await readClipboardImage().blob();
}

/** One capture → optimize → upload → manifest cycle. */
export async function captureOnce(
  options: ScreenshotCliOptions,
  clipboardChangeCount: number | null = null,
  deps: CaptureDeps = {},
): Promise<CaptureSummary> {
  const source = await loadSource(options);
  const optimized = await optimizeScreenshot(source, {
    maxEdge: options.maxEdge,
    quality: options.quality,
    format: options.format,
  });
  const digest = sha256Hex(optimized.bytes);
  const capturedAt = new Date();
  const key = screenshotObjectKey(
    digest,
    options.format,
    capturedAt,
    options.prefix,
  );

  if (options.output !== null) {
    await Bun.write(options.output, optimized.bytes);
  }

  const uploader = options.dryRun
    ? null
    : await (deps.resolveUploader ?? defaultUploader)();
  if (!options.dryRun && uploader === null) {
    throw new ScreenshotError(
      "ERR_SCREENSHOT_CREDENTIALS",
      "no R2 credentials: set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY (or the S3_/AWS_ pair), or run with --dry-run",
    );
  }

  const manifest = await readScreenshotManifest(options.manifest);
  const prior = manifest.entries.find((row) => row.sha256 === digest);
  const willUpload =
    uploader !== null && (prior === undefined || options.force);

  let status: CaptureSummary["status"] = "dry-run";
  let publicUrl =
    uploader === null ? null : publicUrlFor(uploader.publicBase, key);
  if (uploader !== null) {
    if (!willUpload) {
      status = "already-present";
      publicUrl = prior?.publicUrl ?? publicUrl;
    } else {
      const written = await uploader.put(key, optimized.bytes, optimized.mime, {
        sha256: digest,
        capturedAt: capturedAt.toISOString(),
        sourceFormat: optimized.source.format,
      });
      if (written !== optimized.bytes.length) {
        throw new ScreenshotError(
          "ERR_SCREENSHOT_UPLOAD",
          `R2 accepted ${written} of ${optimized.bytes.length} bytes for ${key}`,
        );
      }
      status = "uploaded";
    }

    const entry: ScreenshotManifestEntry = {
      sha256: digest,
      key,
      publicUrl,
      bytes: optimized.bytes.length,
      width: optimized.width,
      height: optimized.height,
      format: optimized.format,
      quality: options.quality,
      maxEdge: options.maxEdge,
      sourceBytes: optimized.source.bytes,
      sourceFormat: optimized.source.format,
      sourceWidth: optimized.source.width,
      sourceHeight: optimized.source.height,
      capturedAt: capturedAt.toISOString(),
      clipboardChangeCount,
    };
    const appended = appendScreenshotManifestEntry(manifest, entry, capturedAt);
    await writeScreenshotManifest(options.manifest, appended.manifest);
  }

  const savedPercent =
    optimized.source.bytes > 0
      ? Number(
          (
            100 -
            (optimized.bytes.length / optimized.source.bytes) * 100
          ).toFixed(1),
        )
      : null;

  return {
    status,
    sha256: digest,
    key,
    publicUrl,
    bytes: optimized.bytes.length,
    sourceBytes: optimized.source.bytes,
    savedPercent,
    width: optimized.width,
    height: optimized.height,
    format: optimized.format,
    manifestPath: options.manifest,
    clipboardChangeCount,
    localPath: options.output,
  };
}
function printSummary(summary: CaptureSummary, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(`status      ${summary.status}`);
  console.log(`object      ${summary.key}`);
  if (summary.publicUrl !== null)
    console.log(`url         ${summary.publicUrl}`);
  console.log(
    `size        ${summary.bytes} bytes (source ${summary.sourceBytes}${
      summary.savedPercent === null ? "" : `, ${summary.savedPercent}% smaller`
    })`,
  );
  console.log(
    `dimensions  ${summary.width}x${summary.height} ${summary.format}`,
  );
  console.log(`sha256      ${summary.sha256}`);
  if (summary.localPath !== null)
    console.log(`copy        ${summary.localPath}`);
  if (summary.status !== "dry-run") {
    console.log(`manifest    ${summary.manifestPath}`);
  }
}

function printUsage(): void {
  console.log(`dx shot-clip — capture the clipboard screenshot, optimize it, publish it to R2

Usage:
  ./bin/dx shot-clip [flags]

Flags:
  --file <path>       Read this image instead of the clipboard (CI, tests, a saved file)
  --output <path>     Also write the optimized bytes to this path
  --max-edge <px>     Longest edge; smaller images are never upscaled (default ${DEFAULT_MAX_EDGE})
  --quality <1-100>   Encoder quality (default ${DEFAULT_QUALITY}); PNG ignores it
  --format <fmt>      ${SCREENSHOT_FORMATS.join(" | ")} (default webp)
  --prefix <key>      Object prefix in the bucket (default ${DEFAULT_PREFIX})
  --manifest <path>   Manifest to append to (default ${DEFAULT_MANIFEST})
  --force             Re-upload even when the digest is already in the manifest
  --watch             Capture again whenever Bun.Image.clipboardChangeCount() moves
  --interval <ms>     Watch poll interval (default ${DEFAULT_INTERVAL_MS})
  --dry-run           Encode and plan only: no upload, no manifest write
  --json              One machine-readable summary line
  -h, --help          This help

Examples:
  ./bin/dx shot-clip                                 # capture and publish
  ./bin/dx shot-clip --dry-run --json                # what would be published, nothing written
  ./bin/dx shot-clip --file shot.png --format png    # a saved file, lossless
  ./bin/dx shot-clip --watch --interval 800          # follow the clipboard

Exit codes: 0 ok · 1 failure · 2 usage · 3 clipboard empty · 4 credentials missing · 5 upload rejected`);
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseScreenshotArgs(argv);
  if (!parsed.ok) {
    console.error(`Error: ${parsed.message}`);
    console.error("  ./bin/dx shot-clip --help");
    return EXIT_USAGE;
  }
  const options = parsed.options;
  if (options.help) {
    printUsage();
    return EXIT_OK;
  }

  if (!options.watch) {
    try {
      const summary = await captureOnce(
        options,
        options.file === null ? Bun.Image.clipboardChangeCount() : null,
      );
      printSummary(summary, options.json);
      return EXIT_OK;
    } catch (error) {
      return reportFailure(error);
    }
  }

  let last = -1;
  console.log(
    `watching the clipboard every ${options.intervalMs}ms (ctrl-c to stop)`,
  );
  for (;;) {
    const count = Bun.Image.clipboardChangeCount();
    if (count !== last) {
      last = count;
      try {
        const summary = await captureOnce(options, count);
        printSummary(summary, options.json);
      } catch (error) {
        if (
          error instanceof ScreenshotError &&
          error.code === ERR_SCREENSHOT_CLIPBOARD_EMPTY
        ) {
          // A text copy is not a failure in watch mode: wait for the next image.
          if (!options.json) console.log("(clipboard has no image; waiting)");
        } else {
          return reportFailure(error);
        }
      }
    }
    // The clipboard count only moves when the OS clipboard content changes.
    await Bun.sleep(options.intervalMs);
  }
}

function reportFailure(error: unknown): number {
  if (error instanceof ScreenshotError) {
    console.error(`Error [${error.code}]: ${error.message}`);
    switch (error.code) {
      case ERR_SCREENSHOT_CLIPBOARD_EMPTY:
        return EXIT_CLIPBOARD_EMPTY;
      case "ERR_SCREENSHOT_CREDENTIALS":
        return EXIT_CREDENTIALS;
      case "ERR_SCREENSHOT_UPLOAD":
        return EXIT_UPLOAD;
      default:
        return EXIT_FAILURE;
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  return EXIT_FAILURE;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}

export { main, printUsage };
