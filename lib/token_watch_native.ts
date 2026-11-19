/**
 * @file lib/token_watch_native.ts
 * @description Bun 1.4.4 built-ins used by the token-watch pipeline, replacing npm serializers.
 *
 * Measured on the pin: Bun.TOML.stringify/parse, Bun.JSONL.parseChunk, Bun.JSON5, Bun.JSONC,
 * Bun.Archive, Bun.sliceAnsi/wrapAnsi/stringWidth and `process.on("memoryPressure")` all exist.
 * The archive bytes are deterministic for the same entries (two Bun.Archive instances compared
 * byte-for-byte).
 */
import type { RegistryColorRow } from "./token_automation.ts";
import { displayWidth, wrapDisplay } from "./terminal_format.ts";

/** Deterministic tarball of the emitted theme contract, built without a tar dependency. */
export async function exportThemeArchive(
  rows: readonly RegistryColorRow[],
  fingerprint: string,
  files: { readonly envExample: string; readonly themeGenTs: string },
): Promise<Uint8Array> {
  const tokensToml = Bun.TOML.stringify({
    meta: { sha256: fingerprint, count: rows.length },
    profiles: Object.fromEntries(
      rows.map((row) => [
        row.profile_id,
        {
          color_int: row.color_int,
          color_css: row.color_css,
          color_label: row.color_label,
        },
      ]),
    ),
  });
  const archive = new Bun.Archive({
    "tokens.toml": tokensToml,
    ".env.example": files.envExample,
    "index.theme.gen.ts": files.themeGenTs,
  });
  return archive.bytes();
}

/**
 * Stream a JSONL audit log without buffering the whole file. `parseChunk` reports how much of the
 * combined string was consumed; the tail is carried into the next chunk. A final flush handles a
 * last line with no trailing newline.
 */
export async function* streamAuditEvents(
  source: Blob,
): AsyncGenerator<Record<string, unknown>> {
  let remainder = "";
  for await (const chunk of source
    .stream()
    .pipeThrough(new TextDecoderStream())) {
    const combined = remainder + chunk;
    const { values, read } = Bun.JSONL.parseChunk(combined);
    remainder = combined.slice(read);
    for (const value of values) {
      yield value as Record<string, unknown>;
    }
  }
  if (remainder.trim() !== "") {
    const { values } = Bun.JSONL.parseChunk(remainder);
    for (const value of values) {
      yield value as Record<string, unknown>;
    }
  }
}

/** Import a commented config natively; only data modules are accepted. */
export async function loadTokenWatchConfig(
  path: string,
): Promise<Record<string, unknown>> {
  if (!/\.(?:json5|jsonc)$/i.test(path)) {
    throw new TypeError(`ERR_TOKEN_WATCH_CONFIG_FORMAT: ${path}`);
  }
  const mod = (await import(path)) as { default?: unknown };
  if (mod.default === null || typeof mod.default !== "object") {
    throw new TypeError(`ERR_TOKEN_WATCH_CONFIG_SHAPE: ${path}`);
  }
  return mod.default as Record<string, unknown>;
}

/** ANSI-safe wrapping for report rows; OSC-8 and colour escapes are preserved by Bun. */
export function fitAnsiCols(text: string, columns: number): string {
  if (!Number.isInteger(columns) || columns < 1) {
    throw new RangeError(`ERR_TOKEN_WATCH_COLUMNS: ${columns}`);
  }
  return wrapDisplay(text, columns, { hard: false }).join("\n");
}

export const ansiWidth = displayWidth;
export const sliceAnsi = Bun.sliceAnsi;

/** Avatar bytes are a cache, never a source of truth: a pressure event drops all of it. */
export const avatarCache = new Map<string, Uint8Array>();

process.on("memoryPressure", () => {
  avatarCache.clear();
});

/** Exposed for tests and for daemon shutdown; the listener above is the production path. */
export function evictAvatarCache(): void {
  avatarCache.clear();
}
