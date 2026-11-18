/**
 * @file packages/ui/src/tokens.registry.generated.ts
 * @description Generated from design/tokens.toml (v1.5.0) via `bun run gen:tokens`.
 * DO NOT EDIT BY HAND — enforced by `bun run gen:tokens:gate`.
 */

/** tokens.toml SSOT version this module was generated from. */
export const TOKENS_TOML_VERSION = "1.5.0" as const;

export type GeneratedTokenGroup =
  "surfaces" | "ui" | "sla" | "ingestion" | "routes";

export interface GeneratedToken {
  /** `--sd-*` custom property name. */
  readonly token: string;
  /** Canonical value emitted into both `@property` and `:root`. */
  readonly hex: string;
  /** Emitting section; the palette groups by this. */
  readonly group: GeneratedTokenGroup;
}

export interface GeneratedAlias {
  /** Alias emitted into `:root` as `<alias>: var(<target>)`. */
  readonly alias: string;
  /** Canonical token the alias resolves to. */
  readonly target: string;
  /** `legacy` ships in every stylesheet; `dashboard` only in the dashboard CSS. */
  readonly scope: "legacy" | "dashboard";
}

/** Canonical tokens in `:root` emission order. */
export const CANONICAL_TOKENS: readonly GeneratedToken[] = [
  { token: "--sd-surface-bg", hex: "#070b14", group: "surfaces" },
  { token: "--sd-surface-cli", hex: "#04070e", group: "surfaces" },
  { token: "--sd-surface-card", hex: "#0b1120", group: "ui" },
  { token: "--sd-surface-elevated", hex: "#121c31", group: "ui" },
  { token: "--sd-surface-hover", hex: "#19263d", group: "ui" },
  { token: "--sd-surface-raised", hex: "#202f4a", group: "ui" },
  { token: "--sd-surface-selected", hex: "#0f3a5d", group: "ui" },
  { token: "--sd-surface-border", hex: "#243247", group: "ui" },
  { token: "--sd-border-strong", hex: "#7085a1", group: "ui" },
  { token: "--sd-focus-ring", hex: "#38bdf8", group: "ui" },
  { token: "--sd-focus-ring-offset", hex: "#070b14", group: "ui" },
  { token: "--sd-text-primary", hex: "#f1f5f9", group: "ui" },
  { token: "--sd-text-secondary", hex: "#cbd5e1", group: "ui" },
  { token: "--sd-text-muted", hex: "#94a3b8", group: "ui" },
  { token: "--sd-sla-fresh", hex: "#34d399", group: "sla" },
  { token: "--sd-sla-fresh-bg", hex: "#0a2922", group: "sla" },
  { token: "--sd-sla-fresh-border", hex: "#10b981", group: "sla" },
  { token: "--sd-sla-warn", hex: "#38bdf8", group: "sla" },
  { token: "--sd-sla-warn-bg", hex: "#0c2438", group: "sla" },
  { token: "--sd-sla-warn-border", hex: "#29b6f6", group: "sla" },
  { token: "--sd-sla-stale", hex: "#fbbf24", group: "sla" },
  { token: "--sd-sla-stale-bg", hex: "#2b200c", group: "sla" },
  { token: "--sd-sla-stale-border", hex: "#f59e0b", group: "sla" },
  { token: "--sd-sla-poison", hex: "#fca5a5", group: "sla" },
  { token: "--sd-sla-poison-bg", hex: "#2d161d", group: "sla" },
  { token: "--sd-sla-poison-border", hex: "#ff7878", group: "sla" },
  { token: "--sd-tier-drop", hex: "#94a3b8", group: "ingestion" },
  { token: "--sd-tier-retail", hex: "#29b6f6", group: "ingestion" },
  { token: "--sd-tier-blocked", hex: "#8fa3bf", group: "ingestion" },
  { token: "--sd-tier-gateway", hex: "#22d39a", group: "ingestion" },
  { token: "--sd-tier-alert", hex: "#ff7878", group: "ingestion" },
  { token: "--sd-tier-steam", hex: "#f59e0b", group: "ingestion" },
  { token: "--sd-tier-whale", hex: "#4ade80", group: "ingestion" },
  { token: "--sd-tier-rec-bias", hex: "#7dd3fc", group: "ingestion" },
  { token: "--sd-tier-live-cws", hex: "#67e8f9", group: "ingestion" },
  { token: "--sd-tier-phone", hex: "#a5b4fc", group: "ingestion" },
  { token: "--sd-tier-house", hex: "#e2e8f0", group: "ingestion" },
  { token: "--sd-route-devig", hex: "#22d3ee", group: "routes" },
  { token: "--sd-route-sharp", hex: "#c892ff", group: "routes" },
  { token: "--sd-route-pending", hex: "#fb923c", group: "routes" },
  { token: "--sd-route-manager", hex: "#ff758f", group: "routes" },
];

/** `:root` aliases in emission order (legacy first, then dashboard). */
export const TOKEN_ALIASES: readonly GeneratedAlias[] = [
  { alias: "--sd-theme-emerald", target: "--sd-tier-gateway", scope: "legacy" },
  { alias: "--bg", target: "--sd-surface-bg", scope: "dashboard" },
  { alias: "--bg-cli", target: "--sd-surface-cli", scope: "dashboard" },
  { alias: "--card", target: "--sd-surface-card", scope: "dashboard" },
  {
    alias: "--card-elevated",
    target: "--sd-surface-elevated",
    scope: "dashboard",
  },
  { alias: "--card-hover", target: "--sd-surface-hover", scope: "dashboard" },
  { alias: "--card-raised", target: "--sd-surface-raised", scope: "dashboard" },
  {
    alias: "--card-selected",
    target: "--sd-surface-selected",
    scope: "dashboard",
  },
  { alias: "--border", target: "--sd-surface-border", scope: "dashboard" },
  {
    alias: "--border-strong",
    target: "--sd-border-strong",
    scope: "dashboard",
  },
  { alias: "--focus-ring", target: "--sd-focus-ring", scope: "dashboard" },
  { alias: "--text", target: "--sd-text-primary", scope: "dashboard" },
  {
    alias: "--text-secondary",
    target: "--sd-text-secondary",
    scope: "dashboard",
  },
  { alias: "--muted", target: "--sd-text-muted", scope: "dashboard" },
  { alias: "--accent", target: "--sd-tier-rec-bias", scope: "dashboard" },
  { alias: "--emerald", target: "--sd-tier-gateway", scope: "dashboard" },
  { alias: "--amber", target: "--sd-tier-steam", scope: "dashboard" },
  { alias: "--danger", target: "--sd-tier-alert", scope: "dashboard" },
  { alias: "--purple", target: "--sd-route-sharp", scope: "dashboard" },
  { alias: "--cyan", target: "--sd-route-devig", scope: "dashboard" },
  { alias: "--sd-state-ok", target: "--sd-tier-whale", scope: "dashboard" },
  { alias: "--sd-state-warn", target: "--sd-tier-steam", scope: "dashboard" },
  { alias: "--sd-state-danger", target: "--sd-tier-alert", scope: "dashboard" },
  { alias: "--sd-state-info", target: "--sd-tier-phone", scope: "dashboard" },
  { alias: "--sd-state-accent", target: "--sd-focus-ring", scope: "dashboard" },
];

/** Untyped `:root` declarations for [layout], [motion] and [cas_states]. */
export const ROOT_OPTION_DECLARATIONS: readonly string[] = [
  "  --sd-layout-grid-unit: 4px;",
  "  --sd-layout-card-padding: 12px;",
  "  --sd-layout-row-height-compact: 28px;",
  "  --sd-layout-row-height-comfortable: 36px;",
  "  --sd-layout-border-hairline-width: 1px;",
  "  --sd-layout-border-interactive-width: 1px;",
  "  --sd-layout-focus-ring-width: 2px;",
  "  --sd-layout-focus-ring-offset: 2px;",
  "  --sd-layout-radius-badge: 4px;",
  "  --sd-layout-radius-card: 6px;",
  "  --sd-layout-radius-modal: 8px;",
  "  --sd-motion-aria-live-coalesce: 500ms;",
  "  --sd-motion-tooltip-delay: 250ms;",
  "  --sd-motion-drawer-transition: 140ms;",
  "  --sd-motion-pulse-critical-period: 1600ms;",
  "  --sd-cas-committed: #34d399;",
  "  --sd-cas-committed-bg: #0a2922;",
  "  --sd-cas-committed-border: #10b981;",
  '  --sd-cas-committed-glyph: "✓";',
  "  --sd-cas-retry: #38bdf8;",
  "  --sd-cas-retry-bg: #0c2438;",
  "  --sd-cas-retry-border: #29b6f6;",
  '  --sd-cas-retry-glyph: "↻";',
  "  --sd-cas-conflict: #fbbf24;",
  "  --sd-cas-conflict-bg: #2b200c;",
  "  --sd-cas-conflict-border: #f59e0b;",
  '  --sd-cas-conflict-glyph: "⚡";',
  "  --sd-cas-quarantined: #fca5a5;",
  "  --sd-cas-quarantined-bg: #2d161d;",
  "  --sd-cas-quarantined-border: #ff7878;",
  '  --sd-cas-quarantined-glyph: "⛔";',
];
