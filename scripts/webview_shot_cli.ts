#!/usr/bin/env bun
/**
 * @file scripts/webview_shot_cli.ts
 * @description Bun.WebView screenshot tool with an optional F402 login flow and Blob/Base64/Shmem modes.
 *
 * Usage:
 *   ./bin/dx shot <url> [--out scratch/shots/page.png] [--backend webkit|chrome]
 *   ./bin/dx shot <url> --encoding base64 --format webp
 *   ./bin/dx shot <url> --encoding raw-buffer > scratch/shots/page.png
 *   ./bin/dx shot <url> --encoding shmem --kitty
 *   F402_LIVE_LOGIN=1 ./bin/dx shot --f402-login --f402-page /manager.html --out scratch/shots/f402.png
 *   ./bin/dx shot --profile scratch/webview-profile --f402-page /manager.html
 *
 * The login path never prints credentials; it reuses the evidence-capture WebView wrapper and the
 * same selectors as the capture tool.
 */

import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { toLocalPath } from "../lib/local_path.ts";
import { UsageError } from "../lib/usage_error.ts";
import {
  blobKeyFromPath,
  resolveBlobGatewayUrl,
  uploadScreenshotToGateway,
} from "../lib/blob_upload.ts";
import {
  formatKittyDirectEscape,
  kittyTransmission,
  parseResize,
} from "../lib/screenshot_encode.ts";
import { ManagedWebView, WebViewError } from "./capture/webview.ts";
import {
  captureShotFile,
  checkProfile,
  defaultShotPath,
  describeShotError,
  openShotView,
  screenshotOptions,
  withView,
  VIEWPORT_MAX,
  VIEWPORT_MIN,
  type ShotBackend,
  type ShotFileResult,
  type ShotFormat,
} from "./capture/shot.ts";

const RAW_HELP = `Bun.WebView screenshot tool

Usage:
  bun run scripts/webview_shot_cli.ts <url> [options]
  F402_LIVE_LOGIN=1 bun run scripts/webview_shot_cli.ts --f402-login [--f402-page /manager.html]
  bun run scripts/webview_shot_cli.ts --profile <dir> [--f402-page /manager.html]

Options:
  --out <path>            Output file or file:// URL (default scratch/shots/webview-<uuidv7>.<ext>)
  --width <px>            Viewport width in CSS px, 1..16384 (default 1440)
  --height <px>           Viewport height in CSS px, 1..16384 (default 900)
  --backend <name>        webkit (macOS default/zero deps) or chrome; anything else is rejected
  --format <name>         png | jpeg (alias jpg) | webp (webp is re-encoded via Bun.Image on webkit)
  --encoding <name>       blob (default, mmap-backed on webkit) | base64 | buffer | raw-buffer | shmem
                          buffer prints a JSON object with base64 + bytes (a JSON base64 payload,
                          not a Node Buffer); raw-buffer writes the encoded bytes to stdout
  --kitty                 Show the screenshot inline in a Kitty-protocol terminal (PNG only). Uses
                          shared memory (t=s) locally, and direct transmission (t=d) on Windows or
                          over SSH, where the terminal cannot read this machine's shared memory
  --kitty-direct          --kitty, always with direct transmission
  --resize <WxH|W>        Resize with Bun.Image after capture, in output pixels (W keeps aspect ratio)
  --quality <1-100>       jpeg/webp quality (default 82)
  --wait-selector <css>   Wait for this selector before the screenshot
  --wait-ms <ms>          Extra settle delay (default 250)
  --timeout-ms <ms>       Navigation/selector timeout (default 20000)
  --f402-login            Log in with F402_AGENT_ID / F402_PASSWORD before capturing
  --f402-page <path>      Navigate to this path after login (default /)
  --profile <dir>         Reuse an existing WebView dataStore (path or file:// URL). With no URL it
                          opens --f402-page on the portal; output adds signedOutMarkers
                          (login-form, session-expired; empty = neither seen)
  --thumb <px>            Also write a WebP thumbnail (fits in px x px) next to the screenshot
  --placeholder           Include the ThumbHash data: URL of the screenshot
  --console               Include the page console (redacted, at most 200 lines)
  --cookies               Chrome only: the portal's cookies as name, domain, path, expiry and
                          flags. Values are never printed
  --upload-blob           Upload the captured image to PUT /api/v1/blobs/<key> (needs BLOB_API_TOKEN
                          and the default --encoding blob)
  --blob-gateway <url>    Blob gateway base URL (default BLOB_GATEWAY_URL/BLOB_PORT)
  --blob-key <key>        Blob key (default derived from the output filename)
  --retries <0-5>         Retry a failed navigation, waiting 500ms x attempt (default 0)
  --json                  JSON even on a terminal (pipes always get JSON)
  -h, --help

Pixels:
  Screenshots are device-pixel: WebKit renders at 2x on a Retina display, Chrome at 1x, so a
  1440x900 CSS viewport yields a 2880x1800 WebKit PNG. --width/--height are CSS px; chrome is
  resized to exactly that viewport after the first navigation. --resize applies after capture,
  in output pixels.

Errors: an unknown --backend/--format/--encoding or an out-of-range --width/--height/--quality/
--resize prints a message to stderr and exits 2 without launching a browser.

On a terminal the file result prints as a Bun.inspect.table; --json, a pipe, or --encoding
base64/buffer/shmem prints JSON; raw-buffer writes the image bytes.

Login is opt-in: it requires F402_LIVE_LOGIN=1 plus the credential env vars. A screenshot of a public
page does not require login. --profile only reads a profile's cookies; it never signs in by itself.
Chrome and WebKit keep separate cookie stores in the same directory, so --backend must match the
backend that signed in.`;

const HELP =
  process.stdout.columns === undefined
    ? RAW_HELP
    : Bun.wrapAnsi(RAW_HELP, process.stdout.columns, { wordWrap: true });

interface Options {
  url: string | null;
  out: string | null;
  width: number;
  height: number;
  backend: ShotBackend;
  format: ShotFormat;
  encoding: CliEncoding;
  kitty: boolean;
  kittyDirect: boolean;
  quality: number;
  resize: { width: number; height?: number } | null;
  waitSelector: string | null;
  waitMs: number;
  timeoutMs: number;
  f402Login: boolean;
  f402Page: string;
  profile: string | null;
  /** `undefined` = the flag's value was out of range. */
  thumb: number | null | undefined;
  placeholder: boolean;
  console: boolean;
  cookies: boolean;
  retries: number | undefined;
  json: boolean;
  uploadBlob: boolean;
  blobGateway: string | null;
  blobKey: string | null;
}

const ENCODINGS = ["blob", "base64", "buffer", "raw-buffer", "shmem"] as const;
type CliEncoding = (typeof ENCODINGS)[number];

/** An integer in [min, max]; `undefined` when the flag was given out of range or not a number. */
export function boundedInt(
  raw: string,
  min: number,
  max: number,
): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

const SHOT_ARG_OPTIONS = {
  out: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  backend: { type: "string" },
  format: { type: "string" },
  encoding: { type: "string" },
  kitty: { type: "boolean" },
  "kitty-direct": { type: "boolean" },
  resize: { type: "string" },
  quality: { type: "string" },
  "wait-selector": { type: "string" },
  "wait-ms": { type: "string" },
  "timeout-ms": { type: "string" },
  "f402-login": { type: "boolean" },
  "f402-page": { type: "string" },
  profile: { type: "string" },
  thumb: { type: "string" },
  placeholder: { type: "boolean" },
  console: { type: "boolean" },
  cookies: { type: "boolean" },
  retries: { type: "string" },
  json: { type: "boolean" },
  "upload-blob": { type: "boolean" },
  "blob-gateway": { type: "string" },
  "blob-key": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** An argv the parser rejected: an unknown flag, a flag without its value, or a second URL. */
export class ShotUsageError extends UsageError {
  override readonly name = "ShotUsageError";
}

/** An enumerated flag: absent uses `fallback`, an unknown value is a usage error. */
function choice<T extends string>(
  name: string,
  raw: string | undefined,
  choices: readonly T[],
  fallback: T,
  aliases: Readonly<Record<string, T>> = {},
): T {
  if (raw === undefined) return fallback;
  const key = raw.trim().toLowerCase();
  const alias = aliases[key];
  if (alias !== undefined) return alias;
  const match = choices.find((candidate) => candidate === key);
  if (match !== undefined) return match;
  const expected = [...choices, ...Object.keys(aliases)].join(", ");
  throw new ShotUsageError(`unknown ${name} "${raw}" (expected ${expected})`);
}

/** An integer in [min, max] or a usage error: a typo must not silently change the capture. */
function strictInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  unit: string,
): number {
  if (raw === undefined) return fallback;
  const value = boundedInt(raw, min, max);
  if (value === undefined) {
    throw new ShotUsageError(
      `${name} must be an integer in ${min}..${max}${unit} (got "${raw}")`,
    );
  }
  return value;
}

function strictResize(raw: string | undefined): Options["resize"] {
  if (raw === undefined || raw === "") return null;
  let spec: { width: number; height?: number };
  try {
    spec = parseResize(raw);
  } catch (error) {
    throw new ShotUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const sizes =
    spec.height === undefined ? [spec.width] : [spec.width, spec.height];
  for (const value of sizes) {
    if (
      !Number.isInteger(value) ||
      value < VIEWPORT_MIN ||
      value > VIEWPORT_MAX
    ) {
      throw new ShotUsageError(
        `--resize dimensions must be integers in ${VIEWPORT_MIN}..${VIEWPORT_MAX} output pixels (got "${raw}")`,
      );
    }
  }
  return spec;
}

/** Throws {@link ShotUsageError}; `null` means --help. */
export function parseShotArgs(argv: readonly string[]): Options | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: SHOT_ARG_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new ShotUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const { values, positionals } = parsed;
  if (values.help === true) return null;
  if (positionals.length > 1) {
    throw new ShotUsageError(
      `expected at most one URL, got ${positionals.length}: ${positionals.join(" ")}`,
    );
  }
  const url = positionals[0] ?? null;

  const format = choice(
    "--format",
    values.format,
    ["png", "jpeg", "webp"] as const,
    "png",
    { jpg: "jpeg" },
  );
  const kittyDirect = values["kitty-direct"] === true;
  const kitty = kittyDirect || values.kitty === true;
  // --kitty implies shmem unless --encoding is given explicitly.
  const encoding = choice(
    "--encoding",
    values.encoding,
    ENCODINGS,
    kitty ? "shmem" : "blob",
  );
  // webp no longer forces Chrome: Bun.Image re-encodes the PNG on webkit.
  const backend = choice(
    "--backend",
    values.backend,
    ["webkit", "chrome"] as const,
    process.platform === "darwin" ? "webkit" : "chrome",
  );
  const thumbRaw = values.thumb ?? "";

  const waitMs = Number(values["wait-ms"] ?? "250");
  const timeoutMs = Number(values["timeout-ms"] ?? "20000");

  return {
    url,
    out: localPathOrNull(values.out ?? ""),
    width: strictInt(
      "--width",
      values.width,
      1440,
      VIEWPORT_MIN,
      VIEWPORT_MAX,
      " CSS px",
    ),
    height: strictInt(
      "--height",
      values.height,
      900,
      VIEWPORT_MIN,
      VIEWPORT_MAX,
      " CSS px",
    ),
    backend,
    format,
    encoding,
    kitty,
    kittyDirect,
    quality: strictInt("--quality", values.quality, 82, 1, 100, ""),
    resize: strictResize(values.resize),
    waitSelector: values["wait-selector"] || null,
    waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 250,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 20_000,
    f402Login: values["f402-login"] === true,
    f402Page: values["f402-page"] ?? "/",
    profile: localPathOrNull(values.profile ?? ""),
    thumb: thumbRaw === "" ? null : boundedInt(thumbRaw, 16, 2048),
    placeholder: values.placeholder === true,
    console: values.console === true,
    cookies: values.cookies === true,
    retries: boundedInt(values.retries ?? "0", 0, 5),
    json: values.json === true,
    uploadBlob: values["upload-blob"] === true,
    blobGateway: values["blob-gateway"] || null,
    blobKey: values["blob-key"] || null,
  };
}

function localPathOrNull(raw: string): string | null {
  return raw === "" ? null : toLocalPath(raw);
}

export async function runWebviewShot(argv: readonly string[]): Promise<void> {
  let options: Options | null;
  try {
    options = parseShotArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`webview-shot: ${error.message}\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (options === null) {
    console.log(HELP);
    return;
  }
  if (options.url !== null && !/^https?:\/\//.test(options.url)) {
    console.error("webview-shot: the URL must be http(s)\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (options.url === null && !options.f402Login && options.profile === null) {
    console.error(
      "webview-shot: provide an http(s) URL, --f402-login or --profile\n",
    );
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (options.profile !== null && !isDirectory(options.profile)) {
    console.error(
      `webview-shot: --profile ${options.profile} is not a directory; a WebView would start an empty, signed-out profile there`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.thumb === undefined) {
    console.error("webview-shot: --thumb must be an integer from 16 to 2048");
    process.exitCode = 2;
    return;
  }
  if (options.retries === undefined) {
    console.error("webview-shot: --retries must be an integer from 0 to 5");
    process.exitCode = 2;
    return;
  }
  if (options.cookies && options.backend !== "chrome") {
    console.error(
      "webview-shot: --cookies reads cookies over CDP, which only --backend chrome has",
    );
    process.exitCode = 2;
    return;
  }
  if (options.encoding === "shmem" && options.format !== "png") {
    console.error(
      `webview-shot: --encoding shmem captures a PNG shared-memory segment, so --format ${options.format} has no effect.`,
    );
    console.error(
      "  Pass --format png (the default) or use --encoding blob/base64 for another format.",
    );
    process.exitCode = 2;
    return;
  }
  if (options.uploadBlob && options.encoding !== "blob") {
    console.error(
      "webview-shot: --upload-blob requires --encoding blob (the file-output path)",
    );
    process.exitCode = 2;
    return;
  }
  if (options.uploadBlob && !(Bun.env.BLOB_API_TOKEN ?? "").trim()) {
    console.error("webview-shot: --upload-blob requires BLOB_API_TOKEN");
    process.exitCode = 2;
    return;
  }
  const request: ValidOptions = {
    ...options,
    thumb: options.thumb,
    retries: options.retries,
  };
  await withView(
    () => openShotView(request),
    (view) => emitShot(view, request),
  );
}

type ValidOptions = Omit<Options, "thumb" | "retries"> & {
  readonly thumb: number | null;
  readonly retries: number;
};

async function emitShot(
  view: ManagedWebView,
  options: ValidOptions,
): Promise<void> {
  if (options.encoding === "shmem") {
    if (
      options.kitty &&
      (options.kittyDirect ||
        kittyTransmission(process.platform, process.env) === "direct")
    ) {
      const png = await view.screenshotBase64({ format: "png" });
      process.stdout.write(formatKittyDirectEscape(png.base64));
      return;
    }
    const shmem = await view.screenshotShmem();
    if (options.kitty) {
      process.stdout.write(shmem.kittyEscape);
    } else {
      console.log(JSON.stringify(shmem, null, 2));
    }
    return;
  }

  if (options.encoding === "base64") {
    const profileCheck = await checkProfile(view, options.profile);
    const b64 = await view.screenshotBase64(screenshotOptions(options));
    console.log(
      JSON.stringify(
        {
          encoding: "base64",
          mimeType: b64.mimeType,
          dataUri: b64.dataUri,
          backend: options.backend,
          format: options.format,
          ...profileCheck,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.encoding === "raw-buffer") {
    // Binary on stdout, metadata on stderr, so `dx shot ... --encoding raw-buffer > page.png` works.
    const blob = await view.screenshotBlob(screenshotOptions(options));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    process.stdout.write(bytes);
    console.error(
      `webview-shot: wrote ${bytes.byteLength} ${blob.type} bytes to stdout`,
    );
    return;
  }

  if (options.encoding === "buffer") {
    // Legacy output shape: a JSON {base64, bytes} payload, not a Node Buffer; use raw-buffer for
    // the bytes themselves.
    const profileCheck = await checkProfile(view, options.profile);
    const blob = await view.screenshotBlob(screenshotOptions(options));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    console.log(
      JSON.stringify(
        {
          encoding: "buffer",
          mimeType: blob.type,
          bytes: bytes.byteLength,
          base64: Buffer.from(bytes).toString("base64"),
          ...profileCheck,
        },
        null,
        2,
      ),
    );
    return;
  }

  const captured = await captureShotFile(view, {
    ...options,
    encoding: "blob",
    out: options.out ?? defaultShotPath(options.format),
  });
  const blob = options.uploadBlob
    ? await uploadScreenshotToGateway(
        new Uint8Array(await Bun.file(captured.screenshot).arrayBuffer()),
        captured.mimeType,
        {
          gatewayUrl: options.blobGateway ?? resolveBlobGatewayUrl(),
          key: options.blobKey ?? blobKeyFromPath(captured.screenshot),
        },
      )
    : null;
  const result = blob === null ? captured : { ...captured, blob };
  console.log(
    options.json || process.stdout.isTTY !== true
      ? JSON.stringify(result, null, 2)
      : renderShotTable(result, process.stdout.isTTY === true),
  );
}

/** One row per field: a screenshot result is one record, and a wide single row wraps badly. */
export function renderShotTable(
  result: ShotFileResult,
  colors: boolean,
): string {
  const rows: { field: string; value: string }[] = [
    { field: "screenshot", value: result.screenshot },
    { field: "screenshotUrl", value: result.screenshotUrl },
    { field: "bytes", value: String(result.bytes) },
    { field: "sha256", value: result.sha256 },
    { field: "backend", value: `${result.backend} (${result.format})` },
    { field: "title", value: result.title },
    { field: "url", value: result.url },
  ];
  if (result.signedOutMarkers !== undefined) {
    rows.push({
      field: "signedOutMarkers",
      value:
        result.signedOutMarkers.length === 0
          ? "none seen"
          : result.signedOutMarkers.join(", "),
    });
  }
  if (result.thumb !== undefined)
    rows.push({ field: "thumb", value: result.thumb });
  if (result.blob !== undefined) {
    rows.push({ field: "blob", value: JSON.stringify(result.blob) });
  }
  if (result.placeholder !== undefined) {
    rows.push({
      field: "placeholder",
      value: `data: URL, ${result.placeholder.length} chars (--json prints it)`,
    });
  }
  if (result.console !== undefined) {
    rows.push({
      field: "console",
      value: `${result.console.length} line(s) (--json prints them)`,
    });
  }
  if (result.cookies !== undefined) {
    const expired = result.cookies.filter((cookie) => cookie.expired).length;
    rows.push({
      field: "cookies",
      value:
        result.cookies.length === 0
          ? "no portal cookies"
          : `${result.cookies.length} portal (${expired} expired): ${result.cookies.map((cookie) => cookie.name).join(", ")}`,
    });
  }
  return Bun.inspect.table(
    Object.fromEntries(rows.map(({ field, value }) => [field, { value }])),
    ["value"],
    { colors },
  );
}

if (import.meta.main) {
  runWebviewShot(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `webview-shot: ${
        error instanceof WebViewError
          ? describeShotError(error)
          : error instanceof Error
            ? error.message
            : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
