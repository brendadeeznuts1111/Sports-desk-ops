/**
 * @file lib/gen_tokens/css_option_sections.ts
 * @description Renders the optional `design/tokens.toml` sections that the colour
 * pipeline does not cover: `[layout]`, `[motion]`, `[cas_states]`, and the
 * `aliases.accessibility` overrides.
 *
 * These were parsed and validated but emitted nowhere, so the CSS could not see
 * them. Every name is prefixed with its section (`--sd-layout-*`, `--sd-motion-*`,
 * `--sd-cas-*`) because the bare keys would collide with the UI colour tokens
 * (`--sd-border-hairline`, `--sd-border-interactive`).
 *
 * `[cas_states]` mirrors the SLA shape: `--sd-cas-<state>`, `-bg`, `-border`, and
 * a quoted `-glyph`, so a consumer reads them exactly like `--sd-sla-fresh`.
 *
 * Units are part of the emitted value: px for length, ms for time. The TOML keeps
 * integers only (no floats), which is why every key carries its unit in its name.
 */

import type {
  AliasToml,
  CasStateToml,
  TokensLayoutToml,
  TokensMotionToml,
} from "./tokens_ssot.ts";

const LAYOUT_KEYS = [
  ["grid_unit_px", "grid-unit", "px"],
  ["card_padding_px", "card-padding", "px"],
  ["row_height_compact_px", "row-height-compact", "px"],
  ["row_height_comfortable_px", "row-height-comfortable", "px"],
  ["border_hairline_px", "border-hairline-width", "px"],
  ["border_interactive_px", "border-interactive-width", "px"],
  ["focus_ring_width_px", "focus-ring-width", "px"],
  ["focus_ring_offset_px", "focus-ring-offset", "px"],
  ["radius_badge_px", "radius-badge", "px"],
  ["radius_card_px", "radius-card", "px"],
  ["radius_modal_px", "radius-modal", "px"],
] as const satisfies ReadonlyArray<
  readonly [keyof TokensLayoutToml, string, "px"]
>;

const MOTION_KEYS = [
  ["aria_live_coalesce_ms", "aria-live-coalesce", "ms"],
  ["tooltip_delay_ms", "tooltip-delay", "ms"],
  ["drawer_transition_ms", "drawer-transition", "ms"],
  ["pulse_critical_period_ms", "pulse-critical-period", "ms"],
] as const satisfies ReadonlyArray<
  readonly [keyof TokensMotionToml, string, "ms"]
>;

/** `@property` names emitted for `[layout]` and `[motion]` — none: they are untyped. */
export const LAYOUT_CSS_NAMES: readonly string[] = LAYOUT_KEYS.map(
  ([, name]) => `--sd-layout-${name}`,
);

export const MOTION_CSS_NAMES: readonly string[] = MOTION_KEYS.map(
  ([, name]) => `--sd-motion-${name}`,
);

/** `@property` names emitted for `[cas_states]` (colours only — the glyph is untyped). */
export function casPropertyNames(
  casStates: readonly CasStateToml[] | undefined,
): string[] {
  const names: string[] = [];
  for (const state of casStates ?? []) {
    names.push(
      state.token_name,
      `${state.token_name}-bg`,
      `${state.token_name}-border`,
    );
  }
  return names;
}

/** `:root` names emitted for `[cas_states]`, including the quoted `-glyph`. */
export function casRootNames(
  casStates: readonly CasStateToml[] | undefined,
): string[] {
  const names: string[] = [];
  for (const state of casStates ?? []) {
    names.push(
      state.token_name,
      `${state.token_name}-bg`,
      `${state.token_name}-border`,
      `${state.token_name}-glyph`,
    );
  }
  return names;
}

/** `:root` declarations for `[layout]` and `[motion]`. Indented for a `:root` body. */
export function renderLayoutMotionVars(
  layout: TokensLayoutToml | undefined,
  motion: TokensMotionToml | undefined,
): string {
  let css = "";
  if (layout !== undefined) {
    for (const [key, name, unit] of LAYOUT_KEYS) {
      css += `  --sd-layout-${name}: ${layout[key]}${unit};\n`;
    }
  }
  if (motion !== undefined) {
    for (const [key, name, unit] of MOTION_KEYS) {
      css += `  --sd-motion-${name}: ${motion[key]}${unit};\n`;
    }
  }
  return css;
}

/**
 * Houdini `@property` blocks for `[cas_states]` colours, so a `var(--sd-cas-*)`
 * never silently falls back to an untyped value.
 */
export function renderCasHoudiniProperties(
  casStates: readonly CasStateToml[] | undefined,
  indent = "  ",
): string {
  if (casStates === undefined) return "";
  let css = "";
  for (const state of casStates) {
    for (const [suffix, hex] of [
      ["", state.fg_hex],
      ["-bg", state.bg_hex],
      ["-border", state.border_hex],
    ] as const) {
      css += `${indent}@property ${state.token_name}${suffix} {\n`;
      css += `${indent}  syntax: "<color>";\n`;
      css += `${indent}  inherits: true;\n`;
      css += `${indent}  initial-value: ${hex};\n`;
      css += `${indent}}\n`;
    }
  }
  return css;
}

/** `:root` declarations for `[cas_states]`, mirroring the SLA token shape. */
export function renderCasVars(
  casStates: readonly CasStateToml[] | undefined,
): string {
  if (casStates === undefined) return "";
  let css = "";
  for (const state of casStates) {
    css += `  ${state.token_name}: ${state.fg_hex};\n`;
    css += `  ${state.token_name}-bg: ${state.bg_hex};\n`;
    css += `  ${state.token_name}-border: ${state.border_hex};\n`;
    css += `  ${state.token_name}-glyph: ${JSON.stringify(state.glyph)};\n`;
  }
  return css;
}

/**
 * `@media (prefers-contrast: more)` overrides from `aliases.accessibility`.
 * Emitted at top level (never inside `:root`), so it only appears in the
 * standalone stylesheet — the inlined dashboard tokens are spliced inside their
 * own `:root` and cannot host a media query.
 */
export function renderAccessibilityMedia(
  aliases: readonly AliasToml[] | undefined,
): string {
  if (aliases === undefined || aliases.length === 0) return "";
  let css = "";
  css +=
    "/* Accessibility: prefers-contrast alias overrides (aliases.accessibility) */\n";
  css += "@media (prefers-contrast: more) {\n";
  css += "  :root {\n";
  for (const entry of aliases) {
    css += `    ${entry.alias}: var(${entry.target});\n`;
  }
  css += "  }\n";
  css += "}\n";
  return css;
}
