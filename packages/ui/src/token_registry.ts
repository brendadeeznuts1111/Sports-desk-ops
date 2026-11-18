/**
 * @file packages/ui/src/token_registry.ts
 * @description Palette + Copy-registry source for the Build-Matrix drawer.
 *
 * Values, membership and aliases come from the generated tokens.toml registry, so the
 * drawer cannot show a token the SSOT does not define. Labels and detail strings are
 * editorial (presentation) and live here; a token without an annotation still renders,
 * using its own name, so adding a token to tokens.toml never leaves the palette short.
 */

import {
  CANONICAL_TOKENS,
  ROOT_OPTION_DECLARATIONS,
  TOKEN_ALIASES,
  TOKENS_TOML_VERSION,
  type GeneratedAlias,
  type GeneratedToken,
  type GeneratedTokenGroup,
} from "./tokens.registry.generated.ts";

export { TOKENS_TOML_VERSION };
export type { GeneratedAlias, GeneratedToken, GeneratedTokenGroup };

export type TokenAxis = "all" | "surfaces" | "sla" | "ingestion" | "routes";

/** Axis a single token belongs to (never `all`). */
export type TokenAxisValue = Exclude<TokenAxis, "all">;

export interface HoudiniTokenSpec {
  readonly token: string;
  readonly label: string;
  readonly hex: string;
  readonly axis: TokenAxisValue;
  readonly detail: string;
}

export interface TokenAliasSpec {
  readonly alias: string;
  readonly target: string;
  readonly scope: GeneratedAlias["scope"];
  /** Axis of the alias target; `unmapped` if the target is not a palette token. */
  readonly axis: TokenAxisValue | "unmapped";
}

/** Presentation-only annotations; the value + membership come from tokens.toml. */
const PRESENTATION: Readonly<
  Record<string, { readonly label: string; readonly detail: string }>
> = {
  "--sd-surface-bg": {
    label: "Obsidian",
    detail: "SURFACE.DOM · Main DOM canvas",
  },
  "--sd-surface-cli": {
    label: "CLI",
    detail: "SURFACE.CLI · Deterministic dark ANSI surface",
  },
  "--sd-surface-card": {
    label: "Card",
    detail: "UI surface · Cards, panels, table headers",
  },
  "--sd-surface-elevated": {
    label: "Elevated",
    detail: "UI surface · Elevated drawers, modals & popovers",
  },
  "--sd-surface-hover": {
    label: "Hover",
    detail: "UI surface · Hovered rows & cards",
  },
  "--sd-surface-raised": {
    label: "Raised",
    detail: "UI surface · Raised headers & toolbar strips",
  },
  "--sd-surface-selected": {
    label: "Selected",
    detail: "UI surface · Active BitSet32 roving tab & selected row",
  },
  "--sd-surface-border": {
    label: "Border",
    detail: "UI border · Hairlines & dividers",
  },
  "--sd-border-strong": {
    label: "Strong Border",
    detail: "UI border · Emphasized panel borders & keycaps",
  },
  "--sd-focus-ring": {
    label: "Focus Ring",
    detail: "UI focus · Keyboard roving tabindex ring",
  },
  "--sd-focus-ring-offset": {
    label: "Focus Offset",
    detail: "UI focus · 2px inner separation ring",
  },
  "--sd-text-primary": {
    label: "Text",
    detail: "UI text · Primary headings & body copy",
  },
  "--sd-text-secondary": {
    label: "Secondary Text",
    detail: "UI text · Subheadings & metric values",
  },
  "--sd-text-muted": {
    label: "Muted",
    detail: "UI text · Secondary labels & headers",
  },
  "--sd-sla-fresh": { label: "Fresh", detail: "SLA_FRESH · within SLA" },
  "--sd-sla-fresh-bg": {
    label: "Fresh BG",
    detail: "SLA_FRESH · tinted surface",
  },
  "--sd-sla-fresh-border": {
    label: "Fresh Border",
    detail: "SLA_FRESH · badge border",
  },
  "--sd-sla-warn": { label: "Warn", detail: "SLA_WARN · half-window advisory" },
  "--sd-sla-warn-bg": {
    label: "Warn BG",
    detail: "SLA_WARN · tinted surface",
  },
  "--sd-sla-warn-border": {
    label: "Warn Border",
    detail: "SLA_WARN · badge border",
  },
  "--sd-sla-stale": {
    label: "Stale",
    detail: "SLA_STALE · publish or window lag breached",
  },
  "--sd-sla-stale-bg": {
    label: "Stale BG",
    detail: "SLA_STALE · tinted surface",
  },
  "--sd-sla-stale-border": {
    label: "Stale Border",
    detail: "SLA_STALE · badge border",
  },
  "--sd-sla-poison": {
    label: "Poison",
    detail: "SLA_POISON · stale snapshot poison",
  },
  "--sd-sla-poison-bg": {
    label: "Poison BG",
    detail: "SLA_POISON · tinted surface",
  },
  "--sd-sla-poison-border": {
    label: "Poison Border",
    detail: "SLA_POISON · badge border",
  },
  "--sd-tier-drop": {
    label: "Drop L17",
    detail: "L17.N0000 · NON_SPORTS · Stage 1 drop",
  },
  "--sd-tier-retail": {
    label: "Retail L18",
    detail: "L18.N0204 · Internet · SLA ≤1500ms",
  },
  "--sd-tier-blocked": {
    label: "Blocked L19",
    detail: "L19.N0518 · BLOCKED · sentinel_drop",
  },
  "--sd-tier-gateway": {
    label: "Gateway L20",
    detail: "L20.N1105 · GATEWAY · SLA ≤1000ms",
  },
  "--sd-tier-alert": {
    label: "Alert L21",
    detail: "L21.N0884 · ALERT · SLA ≤250ms",
  },
  "--sd-tier-steam": {
    label: "Steam L22",
    detail: "L22.N1402 · GSBUILDER · SLA ≤1000ms",
  },
  "--sd-tier-whale": {
    label: "Whale L23",
    detail: "L23.N0412 · GSLIVE · SLA ≤500ms",
  },
  "--sd-tier-rec-bias": {
    label: "Rec L24",
    detail: "L24.N2019 · CSLEVEL2 · SLA ≤2000ms",
  },
  "--sd-tier-live-cws": {
    label: "Live CWS L24B",
    detail: "L24B.N2110 · LIVEBETTINGCWS · SLA ≤750ms",
  },
  "--sd-tier-phone": {
    label: "Phone L24C",
    detail: "L24C.N2204 · PHONE · SLA ≤1500ms",
  },
  "--sd-tier-house": {
    label: "House L24D",
    detail: "L24D.N2308 · HOUSE · SLA ≤1500ms",
  },
  "--sd-route-pending": {
    label: "Pending R01",
    detail: "L27.N0912 · LIQUIDITY_HALT · ≥$1,000 depth",
  },
  "--sd-route-sharp": {
    label: "Sharp R02",
    detail: "L26.N3104 · SHRINKAGE_SHARP · τ*≥6800 bps, N≥8",
  },
  "--sd-route-manager": {
    label: "Manager R03",
    detail: "L28.N2501 · TERMINAL_ENFORCE · tox≥80",
  },
  "--sd-route-devig": {
    label: "Devig R04",
    detail: "L25.N1882 · STEAM_CONVERGENCE · ≤5000ms lag",
  },
};

function axisForGroup(group: GeneratedTokenGroup): TokenAxisValue {
  if (group === "ui" || group === "surfaces") return "surfaces";
  return group;
}

/** Every canonical `--sd-*` token, in `:root` emission order. */
export const HOUDINI_TOKENS: readonly HoudiniTokenSpec[] = CANONICAL_TOKENS.map(
  (token) => {
    const annotation = PRESENTATION[token.token];
    return {
      token: token.token,
      hex: token.hex,
      axis: axisForGroup(token.group),
      label: annotation?.label ?? token.token,
      detail: annotation?.detail ?? `tokens.toml ${token.group} token`,
    };
  },
);

/** Every `:root` alias, legacy first, then the dashboard-only layer. */
export const TOKEN_ALIAS_SPECS: readonly TokenAliasSpec[] = TOKEN_ALIASES.map(
  (alias) => {
    const target = HOUDINI_TOKENS.find((token) => token.token === alias.target);
    return {
      alias: alias.alias,
      target: alias.target,
      scope: alias.scope,
      axis: target?.axis ?? "unmapped",
    };
  },
);

/**
 * The `:root` block the generated stylesheet carries, rebuilt from the same registry
 * data. Kept byte-comparable (after whitespace normalisation) to
 * `src/dashboard/tokens.generated.css` — see tests/dashboard_ui_panels.test.tsx.
 */
export function buildRegistryRootCss(): string {
  const canonical = HOUDINI_TOKENS.map(
    (token) => `  ${token.token}: ${token.hex};`,
  ).join("\n");
  const legacy = TOKEN_ALIAS_SPECS.filter((alias) => alias.scope === "legacy")
    .map((alias) => `  ${alias.alias}: var(${alias.target});`)
    .join("\n");
  const dashboard = TOKEN_ALIAS_SPECS.filter(
    (alias) => alias.scope === "dashboard",
  )
    .map((alias) => `  ${alias.alias}: var(${alias.target});`)
    .join("\n");
  const options = ROOT_OPTION_DECLARATIONS.join("\n");
  return `:root {\n  color-scheme: dark;\n  /* Generated from tokens.toml (v${TOKENS_TOML_VERSION}) */\n${canonical}\n${legacy}\n\n  /* Semantic dashboard aliases mapped to canonical tokens.toml variables */\n${dashboard}\n${options}\n}\n`;
}
