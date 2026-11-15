/**
 * @file packages/ui/src/index.ts
 * @description Public barrel for `@sportsdesk-ops/ui` — modular React surfaces,
 * build-time TOML config contracts (`dashboard.toml` & `wagers.toml`), Signal-Honesty
 * hydration normalizers, route helpers, and strongly typed domain models.
 */

// 1. Orchestrator & Core Risk Surfaces
export * from "./App.tsx";
export * from "./ShadowPricingPanel.tsx";
export * from "./SliceMetricsViews.tsx";

// 2. Modular Tab Panels, Modals & CSS Houdini Registry
export * from "./panels/index.tsx";
export * from "./shadow_pricing/index.tsx";

// 3. Build-Time Tree-Shaken TOML Config Contracts
export * from "./config/dashboard.ts";
export * from "./config/slab.ts";
export * from "./config/wagers.ts";

// 4. Hydration, Provenance Badges, Route Sanitizers, ANSI & Runtime Flags
export * from "./ansi.tsx";
export * from "./hydration.ts";
export * from "./links.ts";
export * from "./runtime_flags.ts";

// 5. Visual Tokens, Terminal Command Catalog & Canonical Tab/Domain Types
export * from "./dashboard_styles.ts";
export * from "./terminal_catalog.ts";
export * from "./types.ts";
