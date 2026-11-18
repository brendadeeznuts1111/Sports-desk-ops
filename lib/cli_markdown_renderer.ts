/**
 * @file lib/cli_markdown_renderer.ts
 * @description Zero-copy `Bun.markdown.ansi()` renderer and deterministic `AnsiTheme` resolver
 * backed by `design/tokens.toml` (`lib/tokens_ansi.generated.ts`) and `useColor()` (`lib/ansi_color.ts`).
 */

import { useColor } from "./ansi_color.ts";
import {
  CHANNEL_BADGE_ANSI_LUT,
  CHANNEL_BADGE_ASCII_LUT,
  SD_ANSI_THEMES,
  type AnsiProfileKey,
} from "./tokens_ansi.generated.ts";

export { SD_ANSI_THEMES, type AnsiProfileKey };

/**
 * Resolves the canonical `Bun.markdown.AnsiTheme` without reading ambient `COLORFGBG`.
 * Honors `FORCE_COLOR` / `NO_COLOR` / TTY state via `useColor()`.
 */
export function resolveCliAnsiTheme(
  overrideProfile?: AnsiProfileKey,
): Readonly<Bun.markdown.AnsiTheme> {
  if (overrideProfile !== undefined) {
    return SD_ANSI_THEMES[overrideProfile];
  }
  if (!useColor()) {
    return SD_ANSI_THEMES.pipe_ascii;
  }
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 0 && cols < 100) {
    return SD_ANSI_THEMES.tty_narrow;
  }
  return SD_ANSI_THEMES.ghostty_interactive;
}

/**
 * Zero-copy R2 / CLI Markdown -> ANSI renderer.
 * Accepts `Uint8Array` / `ArrayBuffer` chunks directly from R2 without `TextDecoder` overhead.
 */
export function renderOpsMarkdownAnsi(
  markdownInput: string | Uint8Array | ArrayBuffer,
  theme: Readonly<Bun.markdown.AnsiTheme> = resolveCliAnsiTheme(),
): string {
  return Bun.markdown.ansi(markdownInput, theme);
}

/**
 * Formats a channel badge matching `AnsiTheme.colors` (`false` -> pure ASCII `[GSLIVE]`).
 *
 * The id must be a real index. `>>> 0` used to coerce it, which made `NaN`,
 * `Infinity` and `2**32` all land on channel `0` and `1.9` land on channel `1` —
 * a silent alias onto a real channel. Non-integers and out-of-range values now
 * report `[UNKNOWN]` instead.
 */
export function formatChannelBadge(
  channelId4: number,
  theme: Readonly<Bun.markdown.AnsiTheme>,
): string {
  const useAscii = theme.colors === false;
  const lut = useAscii ? CHANNEL_BADGE_ASCII_LUT : CHANNEL_BADGE_ANSI_LUT;
  if (
    !Number.isInteger(channelId4) ||
    channelId4 < 0 ||
    channelId4 >= lut.length
  ) {
    return "[UNKNOWN]";
  }
  return lut[channelId4]!;
}
