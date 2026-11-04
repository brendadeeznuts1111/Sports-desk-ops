/**
 * @file types/wagers.ts
 * @description Domain types for wager reporting — extracted from lib/ so types
 * are separated from implementation. All types here are plain TypeScript (no
 * zod inference); zod-bound config types (WagersConfig, StateDef, etc.) live
 * in lib/wagers_config.ts.
 *
 * Import with `import type { WagerRow } from "../types/wagers.ts"`
 * (from a file in `lib/`; there is no `@/` path alias in this repo).
 */

export interface WagerRow {
  readonly ticket: string;
  readonly betGroup: string;
  readonly state: string;
  readonly risk: number;
  readonly toWin: number;
  readonly result: number;
  readonly betTime: Date;
  readonly player: string;
  readonly agent: string;
  readonly event: string;
}

export interface StateBucket {
  state: string;
  count: number;
  riskDollars: number;
  toWinDollars: number;
  resultDollars: number;
  legsTotal: number;
}

export type FilterValues = {
  stateFilter: string | undefined;
  wagerNumberFilter: string | undefined;
  legsFilter: number | undefined;
};

export type ReportFormat =
  "table" | "json" | "csv" | "summary" | "inspect" | "columns" | "grid";

export interface RenderResult {
  lines: string[];
  grand: StateBucket;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseMs: number;
}

export type GroupKey = "state" | "day" | "event" | "player" | "agent";
