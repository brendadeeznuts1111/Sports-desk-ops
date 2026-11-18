/**
 * @file lib/gen_tokens/ansi_tokens_module.ts
 * @description Renders `lib/tokens_ansi.generated.ts` with frozen `Bun.markdown.AnsiTheme`
 * profiles and pre-encoded 24-bit `Bun.color(hex, "ansi-16m")` channel badge LUTs.
 */

import type { TomlAnsiProfile } from "./tokens_ssot.ts";

export function emitGeneratedAnsiTokensModule(
  profiles: Readonly<Record<string, TomlAnsiProfile>>,
  channels: ReadonlyArray<{
    readonly channel_id: number;
    readonly channel_code: string;
    readonly hex: string;
    readonly glyph?: string;
  }>,
): string {
  const sortedChannels = [...channels].sort(
    (a, b) => a.channel_id - b.channel_id,
  );
  for (let i = 0; i < sortedChannels.length; i++) {
    if (sortedChannels[i]!.channel_id !== i) {
      throw new Error(
        `ERR_SPEC_CHANNEL_LUT_NON_CONTIGUOUS: expected ${i}, got ${sortedChannels[i]!.channel_id}`,
      );
    }
  }
  const profileKeys = Object.keys(profiles);
  if (profileKeys.length === 0) {
    // An empty profile set would emit `export type AnsiProfileKey = ;`
    // (a parse error, not a type error) because the union joins nothing.
    throw new Error(
      "ERR_SPEC_ANSI_PROFILES_MISSING: design/tokens.toml declares no [cli.markdown_ansi.*] profiles",
    );
  }
  const lines: string[] = [
    "// AUTO-GENERATED FROM design/tokens.toml — DO NOT EDIT",
    `export type AnsiProfileKey = ${profileKeys.map((k) => JSON.stringify(k)).join(" | ")};`,
    "",
    "export const SD_ANSI_THEMES: Readonly<Record<AnsiProfileKey, Readonly<Bun.markdown.AnsiTheme>>> = Object.freeze({",
  ];

  for (const [key, p] of Object.entries(profiles)) {
    lines.push(
      `  ${JSON.stringify(key)}: Object.freeze({ colors: ${p.colors}, columns: ${p.columns}, hyperlinks: ${p.hyperlinks}, kittyGraphics: ${p.kitty_graphics}, light: ${p.light} }),`,
    );
  }
  lines.push("});", "");

  lines.push(
    "export const CHANNEL_ANSI16M_FG_LUT: readonly string[] = Object.freeze([",
  );
  for (const ch of sortedChannels) {
    const sgr = Bun.color(ch.hex, "ansi-16m") ?? "";
    lines.push(
      `  ${JSON.stringify(sgr)}, // [${ch.channel_id}] ${ch.channel_code} (${ch.hex})`,
    );
  }
  lines.push("]);", "");

  lines.push(
    "export const CHANNEL_BADGE_ANSI_LUT: readonly string[] = Object.freeze([",
  );
  for (const ch of sortedChannels) {
    const sgr = Bun.color(ch.hex, "ansi-16m") ?? "";
    const glyph = ch.glyph ?? "*";
    lines.push(
      `  ${JSON.stringify(`${sgr}${glyph} ${ch.channel_code}\x1b[39m`)},`,
    );
  }
  lines.push("]);", "");

  lines.push(
    "export const CHANNEL_BADGE_ASCII_LUT: readonly string[] = Object.freeze([",
  );
  for (const ch of sortedChannels) {
    lines.push(`  ${JSON.stringify(`[${ch.channel_code}]`)},`);
  }
  lines.push("]);", "");

  return lines.join("\n");
}
