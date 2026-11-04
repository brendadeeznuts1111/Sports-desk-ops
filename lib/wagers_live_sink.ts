/**
 * @file wagers_live_sink.ts
 * @description Optional sinks for the GSLive wagers capture loop: one normalized,
 * PII-free event posted to the live-bets gateway, and the same aggregate written to
 * R2 plus a local sidecar the graph poller folds into graph-live-feed.json.
 */

import {
  writeTextAtomic,
  type WagersHistoryDelta,
  type WagersHistoryLine,
  type WagersHistoryState,
  type WagersHistoryTotals,
} from "../scripts/gslive_wagers_by_state.ts";
import { R2S3Client } from "./r2_s3_client.ts";

export const WAGERS_LIVE_CHANNEL = "gslive-wagers";
export const WAGERS_LIVE_EVENT_SCHEMA_VERSION = 1;
export const WAGERS_LIVE_EVENT_KIND = "gslive-wagers";
export const WAGERS_R2_SUMMARY_KEY = "wagers-by-state/latest.json";
export const WAGERS_LOCAL_SIDECAR_PATH = "Scratch/gslive-wagers/latest.json";
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4021";

export interface WagersLiveEvent {
  readonly schemaVersion: typeof WAGERS_LIVE_EVENT_SCHEMA_VERSION;
  readonly kind: typeof WAGERS_LIVE_EVENT_KIND;
  readonly capturedAt: string;
  readonly sourceKind: "live-ajax.php";
  readonly artifactSha256: string;
  readonly totals: WagersHistoryTotals;
  readonly states: readonly WagersHistoryState[];
  readonly delta: WagersHistoryDelta | null;
  readonly qualityFlags: readonly string[];
  readonly alerts: WagersHistoryLine["alerts"];
}

export interface WagersLiveOutcome {
  readonly historyLine: WagersHistoryLine;
  readonly artifactSha256: string;
}

export interface WagersLiveSinkResult {
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
  readonly published?: number;
  readonly url?: string;
}

export interface WagersLiveSinkOptions {
  readonly liveBets: boolean;
  readonly r2: boolean;
  readonly gatewayUrl?: string;
  readonly channel?: string;
  readonly apiToken?: string;
  readonly localSidecarPath?: string;
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Injectable for tests; `undefined` resolves from the environment, `null` disables R2. */
  readonly r2Client?: R2S3Client | null;
}

export interface WagersLiveSink {
  publishLiveBets(outcome: WagersLiveOutcome): Promise<WagersLiveSinkResult>;
  publishR2(outcome: WagersLiveOutcome): Promise<WagersLiveSinkResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gatewayDefaultUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.BLOB_GATEWAY_URL?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const port = env.BLOB_PORT?.trim();
  return port === undefined || port === ""
    ? DEFAULT_GATEWAY_URL
    : `http://127.0.0.1:${port}`;
}

export function resolveWagersGatewayUrl(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  return gatewayDefaultUrl(env).replace(/\/+$/, "");
}

export function buildWagersLiveEvent(
  outcome: WagersLiveOutcome,
): WagersLiveEvent {
  return {
    schemaVersion: WAGERS_LIVE_EVENT_SCHEMA_VERSION,
    kind: WAGERS_LIVE_EVENT_KIND,
    capturedAt: outcome.historyLine.capturedAt,
    sourceKind: outcome.historyLine.sourceKind,
    artifactSha256: outcome.artifactSha256,
    totals: outcome.historyLine.totals,
    states: outcome.historyLine.states,
    delta: outcome.historyLine.delta,
    qualityFlags: outcome.historyLine.qualityFlags,
    alerts: outcome.historyLine.alerts,
  };
}

/** Structural check for the sidecar before the graph poller embeds it. */
export function isWagersLiveEvent(value: unknown): value is WagersLiveEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Partial<WagersLiveEvent>;
  return (
    event.schemaVersion === WAGERS_LIVE_EVENT_SCHEMA_VERSION &&
    event.kind === WAGERS_LIVE_EVENT_KIND &&
    typeof event.capturedAt === "string" &&
    typeof event.artifactSha256 === "string" &&
    typeof event.totals === "object" &&
    event.totals !== null &&
    Array.isArray(event.states) &&
    Array.isArray(event.qualityFlags) &&
    Array.isArray(event.alerts) &&
    (event.delta === null || typeof event.delta === "object")
  );
}

export function createWagersLiveSink(
  options: WagersLiveSinkOptions,
): WagersLiveSink {
  const fetchImpl = options.fetchImpl ?? fetch;
  const channel = options.channel ?? WAGERS_LIVE_CHANNEL;
  const gatewayUrl = (options.gatewayUrl ?? resolveWagersGatewayUrl()).replace(
    /\/+$/,
    "",
  );
  const apiToken = options.apiToken ?? "";
  const localSidecarPath =
    options.localSidecarPath ?? WAGERS_LOCAL_SIDECAR_PATH;

  return {
    async publishLiveBets(outcome) {
      if (!options.liveBets) return { ok: true, skipped: true };
      if (apiToken.trim() === "") {
        return { ok: false, error: "BLOB_API_TOKEN is not set" };
      }
      const event = buildWagersLiveEvent(outcome);
      try {
        const response = await fetchImpl(`${gatewayUrl}/api/v1/live-bets`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ channel, event }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: `live-bets gateway returned HTTP ${response.status}`,
          };
        }
        const body = (await response.json()) as { published?: unknown };
        return typeof body.published === "number"
          ? { ok: true, published: body.published }
          : { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    async publishR2(outcome) {
      if (!options.r2) return { ok: true, skipped: true };
      const event = buildWagersLiveEvent(outcome);
      const text = `${JSON.stringify(event, null, 2)}\n`;
      try {
        await writeTextAtomic(localSidecarPath, text);
      } catch (error) {
        return {
          ok: false,
          error: `sidecar write failed: ${errorMessage(error)}`,
        };
      }
      const client =
        options.r2Client === undefined
          ? R2S3Client.fromEnv()
          : options.r2Client;
      if (client === null) {
        return { ok: false, error: "R2 credentials are unavailable" };
      }
      try {
        await client.writeWithMetadata(
          WAGERS_R2_SUMMARY_KEY,
          new TextEncoder().encode(text),
          {
            type: "application/json",
            metadata: {
              schemaVersion: String(event.schemaVersion),
              capturedAt: event.capturedAt,
              source: "gslive-wagers-capture",
            },
          },
        );
        return {
          ok: true,
          url: `${client.publicBase}/${WAGERS_R2_SUMMARY_KEY}`,
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}
