/**
 * @file src/lib/terminal_avatar.ts
 * @description Terminal avatar frames and Markdown rendering. Uses Blob.image()
 * for the decode/resize/encode pipeline and writes display frames to stdout.
 */
export type TerminalImageProtocol = "kitty" | "iterm2" | "none";

export interface AvatarFrameOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly name?: string;
  readonly maxPixels?: number;
  readonly cellWidth?: number;
  readonly cellHeight?: number;
}

export interface MarkdownAvatarOptions extends AvatarFrameOptions {
  readonly markdown?: string;
  readonly colors?: boolean;
  readonly hyperlinks?: boolean;
  readonly columns?: number;
  readonly light?: boolean;
  readonly avatarPath?: string;
}

export type AvatarSource = string | Blob | Uint8Array | ArrayBuffer;

const DEFAULT_COLS = 2;
const DEFAULT_ROWS = 1;
const DEFAULT_CELL_WIDTH = 8;
const DEFAULT_CELL_HEIGHT = 16;
const KITTY_CHUNK_BYTES = 4096;

/** Detect the inline-image protocol advertised by the current terminal. */
export function detectImageProtocol(
  env: Record<string, string | undefined> = process.env,
): TerminalImageProtocol {
  const term = (env.TERM ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (program.includes("iterm") || env.ITERM_SESSION_ID !== undefined) {
    return "iterm2";
  }
  if (
    env.KITTY_WINDOW_ID !== undefined ||
    env.WEZTERM_PANE !== undefined ||
    env.GHOSTTY_RESOURCES_DIR !== undefined ||
    term.includes("kitty") ||
    term.includes("wezterm") ||
    term.includes("ghostty")
  ) {
    return "kitty";
  }
  return "none";
}

function openImage(
  source: AvatarSource,
  options: { maxPixels?: number } = {},
): Bun.Image {
  if (typeof source === "string") {
    // Filesystem path; callers must not pass untrusted strings here.
    return Bun.file(source).image(options);
  }
  if (source instanceof Blob) {
    return source.image(options);
  }
  return new Bun.Image(source, options);
}

function pixelDimensions(opts: AvatarFrameOptions): {
  cols: number;
  rows: number;
  width: number;
  height: number;
} {
  const cols = Math.max(1, Math.floor(opts.cols ?? DEFAULT_COLS));
  const rows = Math.max(1, Math.floor(opts.rows ?? DEFAULT_ROWS));
  const width = cols * (opts.cellWidth ?? DEFAULT_CELL_WIDTH);
  const height = rows * (opts.cellHeight ?? DEFAULT_CELL_HEIGHT);
  return { cols, rows, width, height };
}

/**
 * `Bun.Image` failures that mean "this file is not a usable avatar": an unsniffable or
 * unsupported format, a decode/encode error, or a header that exceeds `maxPixels`.
 * `ERR_INVALID_STATE` is deliberately absent — that one is a programming error (a transferred
 * buffer), not bad input, so it must keep propagating.
 * @see https://bun.com/reference/bun/Image#errorcode
 */
export const AVATAR_IMAGE_FAILURE_CODES = [
  "ERR_IMAGE_FORMAT_UNSUPPORTED",
  "ERR_IMAGE_TOO_MANY_PIXELS",
  "ERR_IMAGE_DECODE_FAILED",
  "ERR_IMAGE_ENCODE_FAILED",
  "ERR_IMAGE_UNKNOWN_FORMAT",
] as const;

export type AvatarImageFailureCode =
  (typeof AVATAR_IMAGE_FAILURE_CODES)[number];

/** A rejected avatar, classified by the `Bun.Image` code that produced it. */
export class AvatarImageError extends Error {
  readonly code: AvatarImageFailureCode;

  constructor(code: AvatarImageFailureCode, cause: unknown) {
    super(`avatar image rejected: ${code}`, { cause });
    this.name = "AvatarImageError";
    this.code = code;
  }
}

function isAvatarImageFailureCode(
  code: unknown,
): code is AvatarImageFailureCode {
  return (AVATAR_IMAGE_FAILURE_CODES as readonly unknown[]).includes(code);
}

/**
 * Decode, fit and encode one avatar, mapping `Bun.Image` rejections to {@link AvatarImageError}.
 *
 * `Bun.file(...).image()` is lazy: nothing is decoded until the terminal call, so the failure
 * lands on `toBase64()` — and a caller that only catches decode errors sees a raw rejection whose
 * `code` is `ERR_IMAGE_UNKNOWN_FORMAT` for an HTML/error-page body saved as `.png`. One typed
 * error lets the banner skip a bad file without swallowing a real bug.
 */
async function encodeAvatarPng(
  source: AvatarSource,
  opts: AvatarFrameOptions,
): Promise<{ readonly b64: string; readonly image: Bun.Image }> {
  const { width, height } = pixelDimensions(opts);
  try {
    const image = openImage(source, {
      maxPixels: opts.maxPixels ?? 8_000_000,
    })
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .png();
    return { b64: await image.toBase64(), image };
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (isAvatarImageFailureCode(code)) throw new AvatarImageError(code, error);
    throw error;
  }
}

/** Build a Kitty Graphics Protocol frame with 4096-byte payload chunks. */
export async function renderKittyImageFrameAsync(
  source: AvatarSource,
  opts: AvatarFrameOptions = {},
): Promise<string> {
  const { cols, rows } = pixelDimensions(opts);
  const { b64 } = await encodeAvatarPng(source, opts);

  const chunks: string[] = [];
  for (let index = 0; index < b64.length; index += KITTY_CHUNK_BYTES) {
    chunks.push(b64.slice(index, index + KITTY_CHUNK_BYTES));
  }
  return chunks
    .map((chunk, index) => {
      const more = index === chunks.length - 1 ? 0 : 1;
      return (
        "\x1b_Ga=T,f=100,c=" +
        cols +
        ",r=" +
        rows +
        ",m=" +
        more +
        ";" +
        chunk +
        "\x1b\\"
      );
    })
    .join("");
}

/** Build an iTerm2 OSC-1337 inline image frame. */
export async function renderIterm2ImageFrameAsync(
  source: AvatarSource,
  opts: AvatarFrameOptions = {},
): Promise<string> {
  const { cols, rows } = pixelDimensions(opts);
  const { b64, image } = await encodeAvatarPng(source, opts);
  const bytes = await image.bytes();
  const params = [
    "inline=1",
    "size=" + bytes.byteLength,
    "width=" + cols,
    "height=" + rows,
    "preserveAspectRatio=1",
  ];
  if (opts.name) {
    params.push("name=" + Buffer.from(opts.name).toString("base64"));
  }
  return "\x1b]1337;File=" + params.join(";") + ":" + b64 + "\x07";
}

/** Render the frame for the detected protocol; "none" produces no bytes. */
export async function renderTerminalAvatarFrameAsync(
  source: AvatarSource | undefined,
  protocol: TerminalImageProtocol,
  opts: AvatarFrameOptions = {},
): Promise<string> {
  if (!source || protocol === "none") return "";
  return protocol === "kitty"
    ? renderKittyImageFrameAsync(source, opts)
    : renderIterm2ImageFrameAsync(source, opts);
}

/** Write a display frame to the real terminal, not a PTY master. */
export async function writeAvatarFrameToStdout(
  source: AvatarSource | undefined,
  protocol: TerminalImageProtocol,
  opts: AvatarFrameOptions = {},
): Promise<void> {
  const frame = await renderTerminalAvatarFrameAsync(source, protocol, opts);
  if (frame !== "") await Bun.write(Bun.stdout, frame);
}

/** Build a tuned Bun.markdown.AnsiTheme from the current terminal environment. */
export function buildAnsiTheme(
  opts: MarkdownAvatarOptions = {},
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): Bun.markdown.AnsiTheme {
  const colors = opts.colors ?? (isTTY && env.NO_COLOR === undefined);
  const columns =
    opts.columns ??
    (typeof process.stdout.columns === "number" ? process.stdout.columns : 80);
  const background = env.COLORFGBG?.split(";").pop();
  const light = opts.light ?? (background === "15" ? false : undefined);
  return {
    colors,
    columns: Math.max(0, columns),
    hyperlinks: opts.hyperlinks ?? false,
    ...(light !== undefined ? { light } : {}),
    kittyGraphics: false,
  };
}

/** Render themed Markdown, optionally with a native local-file Kitty image. */
export function renderMarkdownWithAvatar(
  markdown: string,
  opts: MarkdownAvatarOptions = {},
): string {
  const theme = buildAnsiTheme(opts);
  if (opts.avatarPath) {
    const reference = "![avatar](" + opts.avatarPath + ")";
    const body = markdown.includes("](" + opts.avatarPath + ")")
      ? markdown
      : markdown + "\n\n" + reference;
    return Bun.markdown.ansi(body, {
      ...theme,
      kittyGraphics: true,
    });
  }
  return Bun.markdown.ansi(markdown, theme);
}
