#!/usr/bin/env bun
/**
 * @file scripts/validate_dashboard_config.ts
 * @description Build-time validator for `packages/ui/src/config/*.toml`.
 *
 * Enforces:
 *  1. Native `Bun.TOML.parse` validity and Temporal-free date contract (all dates must be quoted
 *     ISO-8601 strings; unquoted TOML dates parse to `Temporal.*` and crash browser bundles).
 *  2. Schema invariants across `[meta]`, `[thresholds]`, `[leagues]`, `[api]`, `[freshness]`,
 *     and `[panels]` (including `meta.auto_execute === false` and origin-only `api.base`).
 *  3. Static bundle tree-shaking proof against `dist/dashboard/*.js`: `REQUIRED_PROBE` (`sharp`)
 *     is inlined while `SENTINEL_PROBE` (`churn`) is dead-code eliminated.
 */

import { Glob, TOML } from "bun";
import {
  DASHBOARD_TAB_IDS,
  isDashboardTabId,
  WAGER_SORT_FIELDS,
} from "../packages/ui/src/types.ts";

const CONFIG_GLOB = "packages/ui/src/config/*.toml";
const SOURCE_ROOTS = ["src/dashboard", "packages/ui/src"] as const;
const DIST_DIR = "dist/dashboard";
const REQUIRED_PROBE = "sharp"; // rendered by ThresholdsPanel
const SENTINEL_PROBE = "churn"; // defined in dashboard.toml, never imported
// wagers.toml carries a string probe because minification preserves string
// literals but not property names: the tag must appear, the dead marker must not.
const WAGERS_REQUIRED_PROBE = "wagers-policy/v1"; // [table].policy_tag, rendered in the tab header
const WAGERS_SENTINEL_PROBE = "wagers-dead-table-sentinel"; // [unused].dead_marker, never imported
const WAGERS_SCHEMA = "sportsdesk-wagers-tab/v1";

export type ConfigIssue = { path: string; message: string };

const API_PATH_KEYS = [
  "dashboard",
  "tiers",
  "customers",
  "wagers",
  "bet_ticker",
  "r2_pipeline",
  "dns",
  "health",
  "build_matrix",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function temporalType(v: unknown): string | null {
  const m =
    /^\[object Temporal\.(Instant|PlainDateTime|PlainDate|PlainTime)\]$/.exec(
      Object.prototype.toString.call(v),
    );
  return m ? m[1]! : null;
}

export function findTemporal(value: unknown, path = "$"): string[] {
  const t = temporalType(value);
  if (t) return [`${path} is Temporal.${t} (quote it as a string)`];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findTemporal(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      findTemporal(v, `${path}.${k}`),
    );
  }
  return [];
}

export function hasKeyDeep(obj: unknown, key: string): boolean {
  if (Array.isArray(obj)) return obj.some((v) => hasKeyDeep(v, key));
  if (obj && typeof obj === "object") {
    return Object.entries(obj).some(
      ([k, v]) => k === key || hasKeyDeep(v, key),
    );
  }
  return false;
}

function validateStringArray(
  arr: unknown,
  fieldPath: string,
  file: string,
  out: ConfigIssue[],
): void {
  if (!Array.isArray(arr) || arr.length === 0) {
    out.push({
      path: file,
      message: `${fieldPath} must be a non-empty array`,
    });
    return;
  }
  arr.forEach((entry, i) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      out.push({
        path: file,
        message: `${fieldPath}[${i}] must be a non-empty string`,
      });
    }
  });
}

function validatePositiveNumber(
  value: unknown,
  fieldPath: string,
  max: number,
  file: string,
  out: ConfigIssue[],
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max
  ) {
    out.push({
      path: file,
      message: `${fieldPath} must be a positive number up to ${max}`,
    });
  }
}

export function checkSchema(v: unknown, file: string): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  if (!isPlainObject(v)) {
    return [{ path: file, message: "$ is not a table" }];
  }

  if (v.meta != null) {
    if (!isPlainObject(v.meta)) {
      out.push({ path: file, message: "meta must be a table" });
    } else {
      if (v.meta.auto_execute !== undefined && v.meta.auto_execute !== false) {
        out.push({
          path: file,
          message: "meta.auto_execute must be false (Signal Honesty invariant)",
        });
      }
      if (
        v.meta.generated_at !== undefined &&
        (typeof v.meta.generated_at !== "string" ||
          Number.isNaN(Date.parse(v.meta.generated_at)))
      ) {
        out.push({
          path: file,
          message: "meta.generated_at must be a valid ISO-8601 string",
        });
      }
    }
  }

  if (v.thresholds != null) {
    if (!isPlainObject(v.thresholds)) {
      out.push({ path: file, message: "thresholds must be a table" });
    } else {
      if (
        typeof v.thresholds.sharp !== "number" ||
        !Number.isFinite(v.thresholds.sharp)
      ) {
        out.push({ path: file, message: "thresholds.sharp must be a number" });
      }
      if (
        v.thresholds.steam !== undefined &&
        (typeof v.thresholds.steam !== "number" ||
          v.thresholds.steam <= 0 ||
          v.thresholds.steam > 1)
      ) {
        out.push({
          path: file,
          message: "thresholds.steam must be a number in (0, 1]",
        });
      }
      if (
        v.thresholds.elite_sharp_score !== undefined &&
        v.thresholds.sharp_score !== undefined &&
        (typeof v.thresholds.elite_sharp_score !== "number" ||
          typeof v.thresholds.sharp_score !== "number" ||
          v.thresholds.elite_sharp_score <= v.thresholds.sharp_score ||
          v.thresholds.elite_sharp_score > 10)
      ) {
        out.push({
          path: file,
          message:
            "thresholds.elite_sharp_score must exceed sharp_score and be <= 10",
        });
      }
    }
  }

  if (v.leagues != null) {
    if (!isPlainObject(v.leagues)) {
      out.push({ path: file, message: "leagues must be a table" });
    } else {
      if (v.leagues.names !== undefined) {
        validateStringArray(v.leagues.names, "leagues.names", file, out);
      }
      if (v.leagues.primary !== undefined) {
        validateStringArray(v.leagues.primary, "leagues.primary", file, out);
      }
      if (v.leagues.inplay_priority !== undefined) {
        validateStringArray(
          v.leagues.inplay_priority,
          "leagues.inplay_priority",
          file,
          out,
        );
      }
    }
  }

  if (v.api != null) {
    if (!isPlainObject(v.api)) {
      out.push({ path: file, message: "api must be a table" });
    } else {
      if (v.api.base != null) {
        if (typeof v.api.base !== "string") {
          out.push({ path: file, message: "api.base must be a string" });
        } else if (v.api.base !== "") {
          try {
            const url = new URL(v.api.base);
            if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
              out.push({
                path: file,
                message: "api.base must be an origin (no path, query or hash)",
              });
            }
          } catch {
            out.push({
              path: file,
              message: "api.base must be empty or an absolute URL",
            });
          }
        }
      }
      for (const key of API_PATH_KEYS) {
        const value = v.api[key];
        if (value !== undefined) {
          if (typeof value !== "string" || !value.startsWith("/")) {
            out.push({
              path: file,
              message: `api.${key} must be a path starting with "/"`,
            });
          }
        }
      }
    }
  }

  if (v.freshness != null) {
    if (!isPlainObject(v.freshness)) {
      out.push({ path: file, message: "freshness must be a table" });
    } else {
      if (v.freshness.stale_after_minutes !== undefined) {
        validatePositiveNumber(
          v.freshness.stale_after_minutes,
          "freshness.stale_after_minutes",
          1440,
          file,
          out,
        );
      }
      if (v.freshness.critical_after_minutes !== undefined) {
        validatePositiveNumber(
          v.freshness.critical_after_minutes,
          "freshness.critical_after_minutes",
          10080,
          file,
          out,
        );
        if (
          typeof v.freshness.stale_after_minutes === "number" &&
          typeof v.freshness.critical_after_minutes === "number" &&
          v.freshness.critical_after_minutes <= v.freshness.stale_after_minutes
        ) {
          out.push({
            path: file,
            message:
              "freshness.critical_after_minutes must exceed stale_after_minutes",
          });
        }
      }
      for (const pollKey of [
        "poll_dashboard_seconds",
        "poll_wagers_seconds",
        "poll_ticker_seconds",
        "poll_dns_seconds",
      ] as const) {
        if (v.freshness[pollKey] !== undefined) {
          validatePositiveNumber(
            v.freshness[pollKey],
            `freshness.${pollKey}`,
            3600,
            file,
            out,
          );
        }
      }
    }
  }

  if (v.panels != null) {
    if (!isPlainObject(v.panels)) {
      out.push({ path: file, message: "panels must be a table" });
    } else {
      if (
        v.panels.default_tab !== undefined &&
        !isDashboardTabId(v.panels.default_tab)
      ) {
        out.push({
          path: file,
          message: `panels.default_tab must be one of ${DASHBOARD_TAB_IDS.join(", ")}`,
        });
      }
      for (const countKey of [
        "customers_page_size",
        "live_wagers_limit",
        "ticker_max_rows",
        "dns_cache_capacity",
      ] as const) {
        if (v.panels[countKey] !== undefined) {
          validatePositiveNumber(
            v.panels[countKey],
            `panels.${countKey}`,
            10000,
            file,
            out,
          );
        }
      }
      if (
        v.panels.dns_warm_hit_rate_pct !== undefined &&
        v.panels.dns_active_hit_rate_pct !== undefined &&
        (typeof v.panels.dns_warm_hit_rate_pct !== "number" ||
          typeof v.panels.dns_active_hit_rate_pct !== "number" ||
          v.panels.dns_active_hit_rate_pct <= 0 ||
          v.panels.dns_warm_hit_rate_pct <= v.panels.dns_active_hit_rate_pct ||
          v.panels.dns_warm_hit_rate_pct > 100)
      ) {
        out.push({
          path: file,
          message:
            "panels.dns_warm_hit_rate_pct must satisfy 0 < dns_active_hit_rate_pct < dns_warm_hit_rate_pct <= 100",
        });
      }
    }
  }

  return out;
}

const WAGER_SORT_DIRS = ["asc", "desc"] as const;

/**
 * Validator for `wagers.toml` — the Live Wagers tab's filter vocabulary, CLV
 * ramp and table bounds. Kept separate from `checkSchema` because the two files
 * share `[meta]` and `[thresholds]` table names but not their keys.
 */
export function checkWagersSchema(v: unknown, file: string): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  if (!isPlainObject(v)) {
    return [{ path: file, message: "$ is not a table" }];
  }

  for (const required of [
    "meta",
    "thresholds",
    "table",
    "alert_tiers",
    "sport_filters",
    "bet_type_filters",
    "period_filters",
  ] as const) {
    if (v[required] == null) {
      out.push({ path: file, message: `[${required}] is required` });
    }
  }

  if (isPlainObject(v.meta)) {
    if (v.meta.auto_execute !== false) {
      out.push({
        path: file,
        message: "meta.auto_execute must be false (Signal Honesty invariant)",
      });
    }
    if (
      typeof v.meta.generated_at !== "string" ||
      Number.isNaN(Date.parse(v.meta.generated_at))
    ) {
      out.push({
        path: file,
        message: "meta.generated_at must be a valid ISO-8601 string",
      });
    }
  } else if (v.meta != null) {
    out.push({ path: file, message: "meta must be a table" });
  }

  if (isPlainObject(v.thresholds)) {
    const hot = v.thresholds.clv_hot_cents;
    const warm = v.thresholds.clv_warm_cents;
    if (
      typeof hot !== "number" ||
      !Number.isFinite(hot) ||
      typeof warm !== "number" ||
      !Number.isFinite(warm) ||
      warm <= 0 ||
      hot <= warm
    ) {
      out.push({
        path: file,
        message: "thresholds.clv_hot_cents must exceed clv_warm_cents > 0",
      });
    }
    const leaders = v.thresholds.slice_leader_limit;
    if (
      typeof leaders !== "number" ||
      !Number.isInteger(leaders) ||
      leaders < 1 ||
      leaders > 20
    ) {
      out.push({
        path: file,
        message: "thresholds.slice_leader_limit must be an integer in [1, 20]",
      });
    }
  } else if (v.thresholds != null) {
    out.push({ path: file, message: "thresholds must be a table" });
  }

  if (isPlainObject(v.table)) {
    const maxRows = v.table.max_rows;
    if (
      typeof maxRows !== "number" ||
      !Number.isInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > 10000
    ) {
      out.push({
        path: file,
        message: "table.max_rows must be an integer in [1, 10000]",
      });
    }
    if (
      typeof v.table.policy_tag !== "string" ||
      v.table.policy_tag.trim().length === 0
    ) {
      out.push({
        path: file,
        message: "table.policy_tag must be a non-empty string",
      });
    }
    if (
      !(WAGER_SORT_FIELDS as readonly unknown[]).includes(
        v.table.default_sort_field,
      )
    ) {
      out.push({
        path: file,
        message: `table.default_sort_field must be one of ${WAGER_SORT_FIELDS.join(", ")}`,
      });
    }
    if (
      !(WAGER_SORT_DIRS as readonly unknown[]).includes(
        v.table.default_sort_dir,
      )
    ) {
      out.push({
        path: file,
        message: "table.default_sort_dir must be asc or desc",
      });
    }
  } else if (v.table != null) {
    out.push({ path: file, message: "table must be a table" });
  }

  for (const listKey of [
    "sport_filters",
    "bet_type_filters",
    "period_filters",
  ] as const) {
    const list = v[listKey];
    if (list == null) continue;
    if (!Array.isArray(list) || list.length === 0) {
      out.push({ path: file, message: `${listKey} must be a non-empty array` });
      continue;
    }
    const seen = new Set<string>();
    list.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        out.push({ path: file, message: `${listKey}[${i}] must be a table` });
        return;
      }
      if (typeof entry.id !== "string") {
        out.push({
          path: file,
          message: `${listKey}[${i}].id must be a string`,
        });
      } else if (seen.has(entry.id)) {
        out.push({
          path: file,
          message: `${listKey}[${i}].id "${entry.id}" is duplicated`,
        });
      } else {
        seen.add(entry.id);
      }
      if (typeof entry.label !== "string" || entry.label.trim() === "") {
        out.push({
          path: file,
          message: `${listKey}[${i}].label must be a non-empty string`,
        });
      }
    });
    const first = list[0];
    if (isPlainObject(first) && first.id !== "" && first.id !== "ALL") {
      out.push({
        path: file,
        message: `${listKey}[0].id must be "" or "ALL" (the neutral filter)`,
      });
    }
  }

  if (Array.isArray(v.alert_tiers)) {
    const seen = new Set<string>();
    let prevSeverity = Number.POSITIVE_INFINITY;
    v.alert_tiers.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        out.push({ path: file, message: `alert_tiers[${i}] must be a table` });
        return;
      }
      if (typeof entry.id !== "string" || entry.id.trim() === "") {
        out.push({
          path: file,
          message: `alert_tiers[${i}].id must be a non-empty string`,
        });
      } else if (seen.has(entry.id)) {
        out.push({
          path: file,
          message: `alert_tiers[${i}].id "${entry.id}" is duplicated`,
        });
      } else {
        seen.add(entry.id);
      }
      if (typeof entry.label !== "string" || entry.label.trim() === "") {
        out.push({
          path: file,
          message: `alert_tiers[${i}].label must be a non-empty string`,
        });
      }
      if (
        typeof entry.severity !== "number" ||
        !Number.isInteger(entry.severity) ||
        entry.severity < 1
      ) {
        out.push({
          path: file,
          message: `alert_tiers[${i}].severity must be a positive integer`,
        });
      } else if (entry.severity >= prevSeverity) {
        out.push({
          path: file,
          message:
            "alert_tiers severity must strictly descend from the first row",
        });
      } else {
        prevSeverity = entry.severity;
      }
    });
  } else if (v.alert_tiers != null) {
    out.push({ path: file, message: "alert_tiers must be an array of tables" });
  }

  return out;
}

async function anyTomlImported(): Promise<boolean> {
  const re = /\bimport\b[^;]*?from\s*["'][^"']+\.toml["']/;
  for (const root of SOURCE_ROOTS) {
    for await (const file of new Glob("**/*.{ts,tsx,html}").scan(root)) {
      const path = file.startsWith(root) ? file : `${root}/${file}`;
      if (re.test(await Bun.file(path).text())) return true;
    }
  }
  return false;
}

async function bundleContents(
  distDir: string = DIST_DIR,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for await (const file of new Glob("*.js").scan(distDir)) {
      out.set(file, await Bun.file(`${distDir}/${file}`).text());
    }
  } catch (e) {
    throw new Error(
      `cannot read ${distDir}: ${(e as Error).message} — did the build run?`,
      { cause: e },
    );
  }
  if (out.size === 0) {
    throw new Error(`no .js files under ${distDir} — did the build run?`);
  }
  return out;
}

export async function validateDashboardConfig(
  distDir: string = DIST_DIR,
): Promise<void> {
  const files = await Array.fromAsync(new Glob(CONFIG_GLOB).scan("."));
  if (files.length === 0) {
    throw new Error(`no config files matched ${CONFIG_GLOB}`);
  }

  const issues: ConfigIssue[] = [];
  const parsed: unknown[] = [];
  const byName = new Map<string, unknown>();
  for (const file of files) {
    const text = await Bun.file(file).text();
    let value: unknown;
    try {
      value = TOML.parse(text);
    } catch (e) {
      issues.push({
        path: file,
        message: `TOML parse error: ${(e as Error).message}`,
      });
      continue;
    }
    parsed.push(value);
    byName.set(file.replace(/^.*\//, ""), value);
    issues.push(
      ...findTemporal(value).map((m) => ({ path: file, message: m })),
    );
    issues.push(
      ...(file.endsWith("wagers.toml")
        ? checkWagersSchema(value, file)
        : checkSchema(value, file)),
    );
  }
  if (issues.length) {
    for (const issue of issues) {
      console.error(`✗ ${issue.path}: ${issue.message}`);
    }
    throw new Error(`${issues.length} config issue(s)`);
  }

  const wagersConfig = byName.get("wagers.toml");
  if (wagersConfig === undefined) {
    throw new Error(
      "missing packages/ui/src/config/wagers.toml — the wagers tab policy SSOT",
    );
  }
  if (
    !isPlainObject(wagersConfig) ||
    !isPlainObject(wagersConfig.meta) ||
    wagersConfig.meta.schema !== WAGERS_SCHEMA
  ) {
    throw new Error(`wagers.toml meta.schema must be "${WAGERS_SCHEMA}"`);
  }

  if (!parsed.some((v) => hasKeyDeep(v, REQUIRED_PROBE))) {
    throw new Error(
      `config missing required probe "${REQUIRED_PROBE}" — add it to dashboard.toml or update REQUIRED_PROBE`,
    );
  }
  if (!parsed.some((v) => hasKeyDeep(v, SENTINEL_PROBE))) {
    throw new Error(
      `config missing sentinel probe "${SENTINEL_PROBE}" — add it to dashboard.toml or update SENTINEL_PROBE`,
    );
  }
  if (!hasKeyDeep(wagersConfig, "policy_tag")) {
    throw new Error(
      `wagers.toml missing required probe "policy_tag" ([table] table)`,
    );
  }
  if (!hasKeyDeep(wagersConfig, "dead_marker")) {
    throw new Error(
      `wagers.toml missing sentinel probe "dead_marker" ([unused] table)`,
    );
  }
  console.log(`✓ ${files.length} config file(s) valid, probes present`);

  if (!(await anyTomlImported())) {
    console.log(
      "· tree-shake check skipped: no dashboard source imports a .toml yet",
    );
    return;
  }

  const flat = [...(await bundleContents(distDir)).entries()];
  const sentinelHit = flat.find(([, text]) => text.includes(SENTINEL_PROBE));
  if (sentinelHit) {
    throw new Error(
      `tree-shake broken: "${SENTINEL_PROBE}" appears in ${sentinelHit[0]}`,
    );
  }
  const wagersSentinelHit = flat.find(([, text]) =>
    text.includes(WAGERS_SENTINEL_PROBE),
  );
  if (wagersSentinelHit) {
    throw new Error(
      `tree-shake broken: "${WAGERS_SENTINEL_PROBE}" appears in ${wagersSentinelHit[0]}`,
    );
  }
  const requiredHit = flat.find(([, text]) => text.includes(REQUIRED_PROBE));
  if (!requiredHit) {
    throw new Error(
      `config not inlined: "${REQUIRED_PROBE}" absent from every bundle in ${distDir}`,
    );
  }
  const wagersProbeHit = flat.find(([, text]) =>
    text.includes(WAGERS_REQUIRED_PROBE),
  );
  if (!wagersProbeHit) {
    throw new Error(
      `wagers.toml not inlined: "${WAGERS_REQUIRED_PROBE}" absent from every bundle in ${distDir} — is LiveWagersTabPanel importing config/wagers.ts?`,
    );
  }
  console.log(
    `✓ tree-shake intact: "${REQUIRED_PROBE}" and "${WAGERS_REQUIRED_PROBE}" present, "${SENTINEL_PROBE}" and "${WAGERS_SENTINEL_PROBE}" absent`,
  );
}

if (import.meta.main) {
  try {
    const { buildEnhancedDashboard } = await import("./build_dashboard.ts");
    await buildEnhancedDashboard();
    await validateDashboardConfig();
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
