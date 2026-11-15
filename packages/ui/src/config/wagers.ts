/**
 * @file packages/ui/src/config/wagers.ts
 * @description Sole TypeScript entrypoint for `wagers.toml`.
 *
 * Bun parses and tree-shakes static TOML named exports at bundle time, so the
 * Live Wagers tab's filter vocabulary, CLV ramp and table bounds ship inside the
 * JS bundle with no runtime fetch and no JSON parse.
 *
 * `meta`, `thresholds`, `table` and the three pill lists are all imported: the
 * validator asserts `table.policy_tag` is inlined (proving the import happened)
 * while the unimported `[unused]` table is eliminated from `dist/dashboard/*.js`.
 */

import { isWagerSortField, type WagerSortField } from "../types.ts";
import {
  alert_tiers,
  bet_type_filters,
  meta,
  period_filters,
  sport_filters,
  table,
  thresholds,
} from "./wagers.toml";

export interface WagersTabMeta {
  readonly schema: string;
  readonly version: string;
  /** ISO-8601 string: unquoted TOML dates parse to Temporal.* and fail validation. */
  readonly generated_at: string;
  readonly auto_execute: false;
}

export interface WagersTabThresholds {
  readonly clv_hot_cents: number;
  readonly clv_warm_cents: number;
  readonly slice_leader_limit: number;
}

export interface WagersTabTable {
  readonly max_rows: number;
  readonly policy_tag: string;
  readonly default_sort_field: string;
  readonly default_sort_dir: string;
}

export interface WagerFilterOption {
  readonly id: string;
  readonly label: string;
}

export interface WagerAlertTierOption extends WagerFilterOption {
  readonly severity: number;
}

export const WAGERS_META: WagersTabMeta = meta;
export const WAGERS_THRESHOLDS: WagersTabThresholds = thresholds;
export const WAGERS_TABLE: WagersTabTable = table;

export const WAGER_ALERT_TIERS: readonly WagerAlertTierOption[] = alert_tiers;
export const WAGER_SPORT_FILTERS: readonly WagerFilterOption[] = sport_filters;
export const WAGER_BET_TYPE_FILTERS: readonly WagerFilterOption[] =
  bet_type_filters;
export const WAGER_PERIOD_FILTERS: readonly WagerFilterOption[] =
  period_filters;

/** Alert severity ranks, derived from the TOML order rather than restated in code. */
export const WAGER_TIER_RANK: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(WAGER_ALERT_TIERS.map((tier) => [tier.id, tier.severity])),
);

/** Narrow the TOML string to `WagerSortField`; unknown values fall back safely. */
export function toWagerSortField(
  raw: string,
  fallback: WagerSortField = "timestamp",
): WagerSortField {
  return isWagerSortField(raw) ? raw : fallback;
}

export function toWagerSortDir(raw: string): "asc" | "desc" {
  return raw === "asc" ? "asc" : "desc";
}

export const WAGERS_DEFAULTS = Object.freeze({
  sort_field: toWagerSortField(WAGERS_TABLE.default_sort_field),
  sort_dir: toWagerSortDir(WAGERS_TABLE.default_sort_dir),
});

/**
 * CLV edge color ramp, driven by `thresholds.clv_hot_cents` / `clv_warm_cents`.
 * Positive means the customer beat the closing line (desk liability).
 */
export function clvEdgeTone(cents: number | null): string {
  if (cents === null) return "#94a3b8";
  if (cents <= 0) return "#4ade80";
  return cents >= WAGERS_THRESHOLDS.clv_hot_cents ? "#ef4444" : "#f59e0b";
}

/** Row-level stake emphasis: one risk number, owned by dashboard.toml. */
export function formatClvCents(cents: number): string {
  return cents > 0 ? `+${cents}¢` : `${cents}¢`;
}
