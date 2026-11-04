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
 *   F402_LIVE_LOGIN=1 ./bin/dx shot --f402-login --f402-page /manager --out scratch/shots/f402.png
 *
 * The login path never prints credentials; it reuses the evidence-capture WebView wrapper and the
 * same selectors as the capture tool.
 *
 * Invalid flag values are usage errors: they print to stderr and exit 2 before a view is launched,
 * so a typo cannot silently change the engine, viewport, format, or output encoding.
 */

import { join } from "node:path";
import { ManagedWebView } from "./capture/webview.ts";
import { parseResize } from "../lib/screenshot_encode.ts";
import { loginF402 } from "./capture/f402_login.ts";
import { redactUrlForLog } from "./capture/redact.ts";

const HELP = `Bun.WebView screenshot tool

Usage:
  bun run scripts/webview_shot_cli.ts <url> [options]
  F402_LIVE_LOGIN=1 bun run scripts/webview_shot_cli.ts --f402-login [--f402-page /manager]

Options:
  --out <path>            Output file (default scratch/shots/webview-<epoch>.<ext>)
  --width <px>            Viewport width in CSS px, 1..16384 (default 1440)
  --height <px>           Viewport height in CSS px, 1..16384 (default 900)
  --backend <name>        webkit (macOS default/zero deps) or chrome; anything else is rejected
  --format <name>         png | jpeg (alias jpg) | webp (webp is re-encoded via Bun.Image on webkit)
  --encoding <name>       blob (default, mmap-backed on webkit) | base64 | buffer | raw-buffer | shmem
                          buffer prints a JSON object with base64 + bytes (a JSON base64 payload,
                          not a Node Buffer); raw-buffer writes the encoded bytes to stdout
  --kitty                 Write Kitty graphics protocol t=s escape sequence (implies --encoding shmem)
  --resize <WxH|W>        Resize with Bun.Image after capture, in output pixels (W keeps aspect ratio)
  --quality <1-100>       jpeg/webp quality (default 82)
  --wait-selector <css>   Wait for this selector before the screenshot
  --wait-ms <ms>          Extra settle delay (default 250)
  --timeout-ms <ms>       Navigation/selector timeout (default 20000)
  --f402-login            Log in with F402_AGENT_ID / F402_PASSWORD before capturing
  --f402-page <path>      Navigate to this path after login (default /)
  -h, --help

Pixels:
  Screenshots are device-pixel: WebKit renders at 2x on a Retina display, Chrome at 1x, so a
  1440x900 CSS viewport yields a 2880x1800 WebKit PNG. --width/--height are CSS px, and chrome is
  resized to exactly that viewport before capture (Bun's Chrome resize needs the CDP session, so the
  CLI re-applies it after the first navigation). --resize applies after capture, in output pixels.

Errors: an unknown --backend/--format/--encoding or an out-of-range --width/--height/--quality/--resize
prints a message to stderr and exits 2 without launching a browser.

Login is opt-in: it requires F402_LIVE_LOGIN=1 plus the credential env vars. A screenshot of a public
page does not require login.`;

/** Invalid flag value: report on stderr and exit 2 without launching a view. */
class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VIEWPORT_MIN = 1;
const VIEWPORT_MAX = 16_384;

const ENCODINGS = ["blob", "base64", "buffer", "raw-buffer", "shmem"] as const;
type CliEncoding = (typeof ENCODINGS)[number];

interface Options {
  url: string | null;
  out: string | null;
  width: number;
  height: number;
  backend: "webkit" | "chrome";
  format: "png" | "jpeg" | "webp";
  encoding: CliEncoding;
  kitty: boolean;
  quality: number;
  resize: { width: number; height?: number } | null;
  waitSelector: string | null;
  waitMs: number;
  timeoutMs: number;
  f402Login: boolean;
  f402Page: string;
}

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

/** Read an enumerated flag; an absent flag uses `fallback`, a bad value is a usage error. */
function choice<T extends string>(
  args: readonly string[],
  name: string,
  choices: readonly T[],
  fallback: T,
  aliases: Readonly<Record<string, T>> = {},
): T {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const expected = [...choices, ...Object.keys(aliases)].join(", ");
  const raw = args[index + 1];
  if (raw === undefined) {
    throw new UsageError(`${name} expects one of: ${expected}`);
  }
  const key = raw.trim().toLowerCase();
  const alias = aliases[key];
  if (alias !== undefined) return alias;
  const match = choices.find((candidate) => candidate === key);
  if (match !== undefined) return match;
  throw new UsageError(`unknown ${name} "${raw}" (expected ${expected})`);
}

/**
 * Read a CSS-pixel viewport dimension. The CLI accepts the full Bun range and does not clamp:
 * a typo must not silently change the capture size, and ManagedWebView re-validates on launch.
 */
function dimension(
  args: readonly string[],
  name: "--width" | "--height",
  fallback: number,
): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const raw = args[index + 1];
  if (raw === undefined) {
    throw new UsageError(
      `${name} expects an integer in ${VIEWPORT_MIN}..${VIEWPORT_MAX} CSS px`,
    );
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < VIEWPORT_MIN ||
    value > VIEWPORT_MAX
  ) {
    throw new UsageError(
      `${name} must be an integer in ${VIEWPORT_MIN}..${VIEWPORT_MAX} CSS px (got "${raw}")`,
    );
  }
  return value;
}

function qualityOf(args: readonly string[]): number {
  const index = args.indexOf("--quality");
  if (index === -1) return 82;
  const raw = args[index + 1];
  if (raw === undefined) {
    throw new UsageError("--quality expects an integer in 1..100");
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new UsageError(
      `--quality must be an integer in 1..100 (got "${raw}")`,
    );
  }
  return value;
}

function resizeOf(args: readonly string[]): Options["resize"] {
  const index = args.indexOf("--resize");
  if (index === -1) return null;
  const raw = args[index + 1];
  if (raw === undefined) {
    throw new UsageError(
      `--resize expects WxH or W in output pixels (${VIEWPORT_MIN}..${VIEWPORT_MAX})`,
    );
  }
  let spec: { width: number; height?: number };
  try {
    spec = parseResize(raw);
  } catch (error) {
    throw new UsageError(
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
      throw new UsageError(
        `--resize dimensions must be integers in ${VIEWPORT_MIN}..${VIEWPORT_MAX} output pixels (got "${raw}")`,
      );
    }
  }
  return spec;
}

function backendOf(args: readonly string[]): Options["backend"] {
  // webp no longer forces Chrome: Bun.Image re-encodes the PNG on webkit.
  return choice(
    args,
    "--backend",
    ["webkit", "chrome"] as const,
    process.platform === "darwin" ? "webkit" : "chrome",
  );
}

function parseArgs(args: readonly string[]): Options {
  const flagValues = new Set([
    "--out",
    "--width",
    "--height",
    "--backend",
    "--format",
    "--encoding",
    "--resize",
    "--quality",
    "--wait-selector",
    "--wait-ms",
    "--timeout-ms",
    "--f402-page",
  ]);
  let url: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flagValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    url = arg;
    break;
  }

  const format = choice(
    args,
    "--format",
    ["png", "jpeg", "webp"] as const,
    "png",
    { jpg: "jpeg" },
  );
  const kitty = args.includes("--kitty");
  // --kitty implies shmem unless --encoding is given explicitly.
  const encoding = choice(
    args,
    "--encoding",
    ENCODINGS,
    kitty ? "shmem" : "blob",
  );
  const backend = backendOf(args);

  const waitMs = Number(flag(args, ["--wait-ms"], "250"));
  const timeoutMs = Number(flag(args, ["--timeout-ms"], "20000"));

  return {
    url,
    out: flag(args, ["--out"], "") || null,
    width: dimension(args, "--width", 1440),
    height: dimension(args, "--height", 900),
    backend,
    format,
    encoding,
    kitty,
    quality: qualityOf(args),
    resize: resizeOf(args),
    waitSelector: flag(args, ["--wait-selector"], "") || null,
    waitMs: Number.isFinite(waitMs) ? Math.max(0, waitMs) : 250,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, timeoutMs) : 20_000,
    f402Login: args.includes("--f402-login"),
    f402Page: flag(args, ["--f402-page"], "/"),
  };
}

export const DEFAULT_SHOT_DIR = "scratch/shots";

export async function runWebviewShot(argv: readonly string[]): Promise<void> {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return;
  }
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`webview-shot: ${error.message}`);
    console.error("Run with --help for the supported values.");
    process.exitCode = error.exitCode;
    return;
  }

  if (
    !options.f402Login &&
    (options.url === null || !/^https?:\/\//.test(options.url))
  ) {
    console.error("webview-shot: provide an http(s) URL or --f402-login\n");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  const extension = options.format === "jpeg" ? "jpg" : options.format;
  const out =
    options.out ?? join(DEFAULT_SHOT_DIR, `webview-${Date.now()}.${extension}`);

  await using view = ManagedWebView.launch({
    backend: options.backend,
    width: options.width,
    height: options.height,
    navigateTimeoutMs: options.timeoutMs,
  });

  if (options.f402Login) {
    if (process.env.F402_LIVE_LOGIN?.trim() !== "1") {
      throw new Error("F402 login is opt-in: set F402_LIVE_LOGIN=1");
    }
    await loginF402(view, { timeoutMs: options.timeoutMs });
    const baseUrl = (
      process.env.F402_BASE_URL?.trim() || "https://www.fantasy402.com"
    ).replace(/\/$/, "");
    const suffix = options.f402Page.startsWith("/")
      ? options.f402Page
      : `/${options.f402Page}`;
    await view.navigate(`${baseUrl}${suffix}`, {
      timeoutMs: options.timeoutMs,
    });
  } else {
    await view.navigate(options.url!, { timeoutMs: options.timeoutMs });
  }

  // Bun's Chrome backend rejects Emulation.setDeviceMetricsOverride until the CDP session exists
  // (created by the first navigation), so ManagedWebView's launch-time resize is a silent no-op for
  // the first page. Without this, a 200x150 Chrome capture comes back as the constructor's outer
  // window size (500x63). WebKit sizes the inner viewport from the constructor and needs no retry.
  if (options.backend === "chrome") {
    await view.resize(options.width, options.height);
  }

  if (options.waitSelector !== null) {
    await view.waitForSelector(options.waitSelector, {
      timeoutMs: options.timeoutMs,
    });
  }
  if (options.waitMs > 0) await Bun.sleep(options.waitMs);

  const shotOptions =
    options.format === "png"
      ? {
          format: "png" as const,
          ...(options.resize === null ? {} : { resize: options.resize }),
        }
      : {
          format: options.format,
          quality: options.quality,
          ...(options.resize === null ? {} : { resize: options.resize }),
        };

  if (options.encoding === "shmem") {
    if (options.format !== "png") {
      console.error(
        `webview-shot: --encoding shmem captures a PNG shared-memory segment, so --format ${options.format} has no effect.`,
      );
      console.error(
        "  Pass --format png (the default) or use --encoding blob/base64/buffer for another format.",
      );
      process.exitCode = 2;
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
    const b64 = await view.screenshotBase64(shotOptions);
    console.log(
      JSON.stringify(
        {
          encoding: "base64",
          mimeType: b64.mimeType,
          dataUri: b64.dataUri,
          backend: options.backend,
          format: options.format,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (options.encoding === "raw-buffer") {
    // Binary on stdout, metadata on stderr, so `dx shot ... --encoding raw-buffer > page.png` works.
    const blob = await view.screenshotBlob(shotOptions);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    process.stdout.write(bytes);
    console.error(
      `webview-shot: wrote ${bytes.byteLength} ${blob.type} bytes to stdout`,
    );
    return;
  }

  if (options.encoding === "buffer") {
    // Legacy output shape: a JSON {base64, bytes} payload, not a Node Buffer. Kept for callers
    // that already parse it; use --encoding raw-buffer when you want the bytes themselves.
    const blob = await view.screenshotBlob(shotOptions);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    console.log(
      JSON.stringify(
        {
          encoding: "buffer",
          mimeType: blob.type,
          bytes: bytes.byteLength,
          base64: Buffer.from(bytes).toString("base64"),
        },
        null,
        2,
      ),
    );
    return;
  }

  const screenshot = await view.screenshotToFile(out, shotOptions);
  const title = String((await view.evaluate("document.title")) ?? "");
  const url = redactUrlForLog(
    String((await view.evaluate("location.href")) ?? ""),
  );
  console.log(
    JSON.stringify(
      {
        screenshot: screenshot.path,
        bytes: screenshot.bytes,
        sha256: screenshot.sha256,
        mimeType: screenshot.mimeType,
        backend: options.backend,
        format: options.format,
        encoding: options.encoding,
        title,
        url,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  runWebviewShot(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `webview-shot: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
