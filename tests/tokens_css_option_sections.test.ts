/**
 * @file tests/tokens_css_option_sections.test.ts
 * @description Pins the CSS emission for the optional `design/tokens.toml`
 * sections that the colour pipeline does not cover: `[layout]`, `[motion]`,
 * `[cas_states]` and `aliases.accessibility`.
 *
 * These were parsed and validated but emitted nowhere, so `tokens.toml` claimed
 * constants that no stylesheet could read. The names are asserted literally
 * because consumers (`var(--sd-layout-focus-ring-width)`, `var(--sd-cas-retry)`)
 * depend on the exact spelling — renaming one is a breaking change, not a tidy-up.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseTokensToml } from "../lib/gen_tokens/tokens_ssot.ts";

const rootDir = resolve(import.meta.dir, "..");
const tomlText = await Bun.file(resolve(rootDir, "design/tokens.toml")).text();
const ssot = parseTokensToml(tomlText);

const cssPath = resolve(rootDir, "src/dashboard/tokens.generated.css");
const css = await Bun.file(cssPath).text();

const DASHBOARDS = [
  "static/customer-churn-simulation-dashboard.html",
  "static/telegram-miniapp-dashboard.html",
] as const;

/** Exact emitted `:root` declarations for `[layout]`, in file order. */
const EXPECTED_LAYOUT = [
  "--sd-layout-grid-unit: 4px;",
  "--sd-layout-card-padding: 12px;",
  "--sd-layout-row-height-compact: 28px;",
  "--sd-layout-row-height-comfortable: 36px;",
  "--sd-layout-border-hairline-width: 1px;",
  "--sd-layout-border-interactive-width: 1px;",
  "--sd-layout-focus-ring-width: 2px;",
  "--sd-layout-focus-ring-offset: 2px;",
  "--sd-layout-radius-badge: 4px;",
  "--sd-layout-radius-card: 6px;",
  "--sd-layout-radius-modal: 8px;",
] as const;

const EXPECTED_MOTION = [
  "--sd-motion-aria-live-coalesce: 500ms;",
  "--sd-motion-tooltip-delay: 250ms;",
  "--sd-motion-drawer-transition: 140ms;",
  "--sd-motion-pulse-critical-period: 1600ms;",
] as const;

describe("tokens.toml optional sections reach the stylesheet", () => {
  test("[layout] emits every integer as a px custom property", () => {
    const layout = ssot.layout;
    expect(layout).toBeDefined();
    // Guards the list below: a new TOML key must be added here deliberately.
    expect(Object.keys(layout ?? {})).toHaveLength(EXPECTED_LAYOUT.length);
    for (const declaration of EXPECTED_LAYOUT) {
      expect(css).toContain(declaration);
    }
  });

  test("[motion] emits every integer as a ms custom property", () => {
    const motion = ssot.motion;
    expect(motion).toBeDefined();
    expect(Object.keys(motion ?? {})).toHaveLength(EXPECTED_MOTION.length);
    for (const declaration of EXPECTED_MOTION) {
      expect(css).toContain(declaration);
    }
  });

  test("[cas_states] emits fg/bg/border/glyph and typed @property for each colour", () => {
    const states = ssot.cas_states;
    expect(states).toBeDefined();
    expect(states?.length).toBeGreaterThan(0);

    for (const state of states ?? []) {
      expect(css).toContain(`  ${state.token_name}: ${state.fg_hex};`);
      expect(css).toContain(`  ${state.token_name}-bg: ${state.bg_hex};`);
      expect(css).toContain(
        `  ${state.token_name}-border: ${state.border_hex};`,
      );
      expect(css).toContain(
        `  ${state.token_name}-glyph: ${JSON.stringify(state.glyph)};`,
      );
      expect(css).toContain(
        `@property ${state.token_name} {\n  syntax: "<color>";`,
      );
    }
  });

  test("aliases.accessibility emits a prefers-contrast block, not a bare alias", () => {
    const aliases = ssot.aliases.accessibility;
    expect(aliases).toBeDefined();
    expect(css).toContain("@media (prefers-contrast: more) {");

    const block = css.slice(css.indexOf("@media (prefers-contrast: more)"));
    for (const entry of aliases ?? []) {
      expect(block).toContain(`${entry.alias}: var(${entry.target});`);
    }
  });

  test("both inlined dashboards carry the same layout, motion and CAS vars", async () => {
    for (const dashboard of DASHBOARDS) {
      const html = await Bun.file(resolve(rootDir, dashboard)).text();
      for (const declaration of [...EXPECTED_LAYOUT, ...EXPECTED_MOTION]) {
        const name = declaration.slice(0, declaration.indexOf(":"));
        expect(html).toContain(`${name}:`);
      }
      for (const state of ssot.cas_states ?? []) {
        expect(html).toContain(`${state.token_name}:`);
      }
    }
  });

  test("no custom property is defined twice inside the standalone :root block", () => {
    // A collision would silently let the later declaration win — the reason the
    // layout names carry a `-width` suffix rather than reusing --sd-border-*.
    const rootStart = css.indexOf(":root {");
    const rootEnd = css.indexOf("\n}\n", rootStart);
    expect(rootStart).toBeGreaterThanOrEqual(0);
    expect(rootEnd).toBeGreaterThan(rootStart);
    const body = css.slice(rootStart, rootEnd);

    const declared = new Map<string, number>();
    for (const match of body.matchAll(/^\s+(--[a-z0-9-]+):/gm)) {
      const name = match[1]!;
      declared.set(name, (declared.get(name) ?? 0) + 1);
    }
    const duplicates = [...declared.entries()].filter(([, n]) => n > 1);
    expect(duplicates).toEqual([]);
    expect(declared.size).toBeGreaterThan(EXPECTED_LAYOUT.length);
  });
});
