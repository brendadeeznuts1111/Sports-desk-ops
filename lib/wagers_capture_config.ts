/**
 * Capture-automation configuration: `config/wagers-capture.toml`, parsed with `Bun.TOML` and
 * validated with zod once at the boundary. CLI flags win over this file, which wins over the
 * built-in defaults. Secrets are never read from here.
 *
 * The older report renderer keeps `config/wagers.json` (its own loader); this file is only the
 * capture/automation surface so the two pipelines cannot silently share a half-typed schema.
 */

import { TOML } from "bun";
import { z } from "zod";

import {
  DEFAULT_CADENCE_MINUTES,
  DEFAULT_CHURN_MIN,
  DEFAULT_CHURN_PCT,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_PENDING_WARN_HOURS,
  DEFAULT_SPIKE_MIN,
  DEFAULT_SPIKE_PCT,
  WAGERS_ARTIFACT_PATH,
  WAGERS_STATUS_PATH,
  type WagersAlertThresholds,
} from "../scripts/gslive_wagers_by_state.ts";

export const DEFAULT_WAGERS_CAPTURE_CONFIG_PATH = "config/wagers-capture.toml";
export const DEFAULT_CAPTURE_CRON = "*/15 * * * *";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_KEEP_RUNS = 20;
export const DEFAULT_LOOKBACK_DAYS = 7;

const dateFilterSchema = z.enum(["calcTime", "betTime", "logTime"]);

export const wagersCaptureConfigSchema = z
  .object({
    capture: z
      .object({
        retries: z.number().int().min(0).max(10).default(2),
        retryBackoffMs: z.number().int().min(0).max(60_000).default(250),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(120_000)
          .default(DEFAULT_TIMEOUT_MS),
        dateFilterBy: dateFilterSchema.default("calcTime"),
        lookbackDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(DEFAULT_LOOKBACK_DAYS),
        cron: z.string().min(1).default(DEFAULT_CAPTURE_CRON),
        keepRuns: z.number().int().min(1).default(DEFAULT_KEEP_RUNS),
        keepHistory: z.number().int().min(1).default(DEFAULT_KEEP_HISTORY),
      })
      .strict()
      .prefault({}),
    paths: z
      .object({
        artifact: z.string().min(1).default(WAGERS_ARTIFACT_PATH),
        status: z.string().min(1).default(WAGERS_STATUS_PATH),
        history: z.string().min(1).optional(),
        tickets: z.string().min(1).optional(),
        alerts: z.string().min(1).optional(),
        archive: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
    alerts: z
      .object({
        pendingWarnHours: z.number().min(0).default(DEFAULT_PENDING_WARN_HOURS),
        spikePct: z.number().min(0).default(DEFAULT_SPIKE_PCT),
        spikeMin: z.number().min(0).default(DEFAULT_SPIKE_MIN),
        churnPct: z.number().min(0).default(DEFAULT_CHURN_PCT),
        churnMin: z.number().min(0).default(DEFAULT_CHURN_MIN),
        cadenceMinutes: z.number().min(1).default(DEFAULT_CADENCE_MINUTES),
      })
      .strict()
      .prefault({}),
    publish: z
      .object({
        liveBets: z.boolean().default(false),
        r2: z.boolean().default(false),
        /** Empty means BLOB_GATEWAY_URL/BLOB_PORT/default loopback. */
        gatewayUrl: z.string().default(""),
        channel: z
          .string()
          .regex(/^[a-z0-9-]{1,32}$/)
          .default("gslive-wagers"),
      })
      .strict()
      .prefault({}),
    session: z
      .object({
        /** Chrome --user-data-dir signed in to Manager Tools; empty means keychain/env. */
        webviewProfile: z.string().default(""),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type WagersCaptureConfig = z.infer<typeof wagersCaptureConfigSchema>;

export interface LoadedWagersCaptureConfig {
  readonly config: WagersCaptureConfig;
  /** Config file actually read, or null when the built-in defaults were used. */
  readonly source: string | null;
}

/**
 * Load the capture config. A missing default file means "built-in defaults"; a missing file the
 * operator named explicitly is an error, so a typo in `--config` cannot silently fall back.
 */
export async function loadWagersCaptureConfig(
  path: string = DEFAULT_WAGERS_CAPTURE_CONFIG_PATH,
  options: { readonly required?: boolean } = {},
): Promise<LoadedWagersCaptureConfig> {
  const handle = Bun.file(path);
  const exists = await handle.exists();
  if (!exists) {
    if (options.required === true) {
      throw new Error(`wagers capture config ${path} does not exist`);
    }
    return { config: wagersCaptureConfigSchema.parse({}), source: null };
  }
  let raw: unknown;
  try {
    raw = TOML.parse(await handle.text());
  } catch (error) {
    throw new Error(`${path} is not valid TOML`, { cause: error });
  }
  const parsed = wagersCaptureConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `${path} does not match the wagers capture config: ${issues}`,
    );
  }
  return { config: parsed.data, source: path };
}

/** The alert thresholds the producer consumes; one mapping, not two literals. */
export function alertThresholdsFromConfig(
  config: WagersCaptureConfig,
): WagersAlertThresholds {
  return {
    pendingWarnHours: config.alerts.pendingWarnHours,
    spikePct: config.alerts.spikePct,
    spikeMin: config.alerts.spikeMin,
    churnPct: config.alerts.churnPct,
    churnMin: config.alerts.churnMin,
    cadenceMinutes: config.alerts.cadenceMinutes,
  };
}
