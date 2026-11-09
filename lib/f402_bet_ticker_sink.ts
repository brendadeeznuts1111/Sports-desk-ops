/**
 * @file f402_bet_ticker_sink.ts
 * @description Bridge 3a sinks. One sanitized delta is posted to the live-bets gateway
 * (`POST /api/v1/live-bets`, channel `f402-bet-ticker`) and the sanitized snapshot is written to
 * `f402-bet-ticker/latest.json` in the reports bucket. Mirrors `lib/wagers_live_sink.ts`: every
 * dependency is injectable, failures are reported and never thrown, and the artifact is guarded by
 * the PII contract (`docs/design/pii_sanitization.md`) before either sink sees it.
 *
 * The gateway body cap is 16 KiB (`MAX_WS_MESSAGE_BYTES`); the delta is aggregate-only and far
 * below it. `published: 0` is a valid 200 (no subscriber), not an error.
 */

import { R2S3Client, resolveSecretBackedEnv } from "./r2_s3_client.ts";
import {
  assertSanitizedTickerArtifact,
  encodeF402TickerBinarySnapshot,
  F402_BET_TICKER_KIND,
  F402_BET_TICKER_LIVE_CHANNEL,
  F402_BET_TICKER_R2_BINARY_KEY,
  F402_BET_TICKER_R2_KEY,
  type F402TickerDeltaEvent,
  type F402TickerSnapshot,
} from "./f402_bet_ticker_delta.ts";

/** Loopback default of the blob + live-bets gateway (`BLOB_PORT` default 4021). */
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4021";

export const F402_BET_TICKER_SOURCE = "f402-bet-ticker";

export interface F402BetTickerSinkResult {
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
  readonly published?: number;
  readonly url?: string;
}

export type F402BetTickerWireFormat = "json" | "binary" | "both";

export interface F402BetTickerSinkOptions {
  readonly liveBets: boolean;
  readonly r2: boolean;
  readonly gatewayUrl?: string;
  readonly apiToken?: string;
  /** Wire format for R2 snapshots: "json" (v1), "binary" (v2 304B), or "both" (dual-write). */
  readonly wireFormat?: F402BetTickerWireFormat;
  /** Test seam for the env → Bun.secrets token fallback. */
  readonly apiTokenResolver?: () => Promise<string>;
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Injectable for tests; `undefined` resolves from env/secrets, `null` disables R2. */
  readonly r2Client?: R2S3Client | null;
}

export interface F402BetTickerSink {
  publishLiveBets(
    event: F402TickerDeltaEvent,
  ): Promise<F402BetTickerSinkResult>;
  publishR2(snapshot: F402TickerSnapshot): Promise<F402BetTickerSinkResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `BLOB_GATEWAY_URL`, then `BLOB_PORT`, then the loopback default. */
export function resolveF402BetTickerGatewayUrl(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const configured = env.BLOB_GATEWAY_URL?.trim();
  if (configured !== undefined && configured !== "") {
    return configured.replace(/\/+$/, "");
  }
  const port = env.BLOB_PORT?.trim();
  return port === undefined || port === ""
    ? DEFAULT_GATEWAY_URL
    : `http://127.0.0.1:${port}`;
}

/** Build the sink pair once per process; both methods are safe to call repeatedly. */
export function createF402BetTickerSink(
  options: F402BetTickerSinkOptions,
): F402BetTickerSink {
  const fetchImpl = options.fetchImpl ?? fetch;
  const gatewayUrl = (
    options.gatewayUrl ?? resolveF402BetTickerGatewayUrl()
  ).replace(/\/+$/, "");
  const apiToken = options.apiToken ?? "";
  let tokenPromise: Promise<string> | null = null;
  /** Env first, then `com.bookdeskops.sportsdesk` via Bun.secrets — no manual export needed. */
  const resolveApiToken = async (): Promise<string> => {
    if (apiToken.trim() !== "") return apiToken;
    if (options.apiTokenResolver !== undefined)
      return options.apiTokenResolver();
    tokenPromise ??= resolveSecretBackedEnv().then(
      (resolved) => resolved.BLOB_API_TOKEN ?? "",
    );
    return tokenPromise;
  };

  return {
    async publishLiveBets(event) {
      if (!options.liveBets) return { ok: true, skipped: true };
      if (event.kind !== F402_BET_TICKER_KIND) {
        return { ok: false, error: `unexpected event kind ${event.kind}` };
      }
      const token = await resolveApiToken();
      if (token.trim() === "") {
        return { ok: false, error: "BLOB_API_TOKEN is not set" };
      }
      try {
        assertSanitizedTickerArtifact(event);
      } catch (error) {
        return {
          ok: false,
          error: `sanitized delta rejected: ${errorMessage(error)}`,
        };
      }
      try {
        const response = await fetchImpl(`${gatewayUrl}/api/v1/live-bets`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: F402_BET_TICKER_LIVE_CHANNEL,
            event,
          }),
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

    async publishR2(snapshot) {
      if (!options.r2) return { ok: true, skipped: true };
      try {
        assertSanitizedTickerArtifact(snapshot);
      } catch (error) {
        return {
          ok: false,
          error: `sanitized snapshot rejected: ${errorMessage(error)}`,
        };
      }
      const client =
        options.r2Client === undefined
          ? await R2S3Client.fromEnvOrSecrets()
          : options.r2Client;
      if (client === null) {
        return { ok: false, error: "R2 credentials are unavailable" };
      }

      const wireFormat: F402BetTickerWireFormat =
        options.wireFormat ??
        (Bun.env.BRIDGE3A_WIRE_FORMAT as F402BetTickerWireFormat | undefined) ??
        "json";
      const writeJson = wireFormat === "json" || wireFormat === "both";
      const writeBinary = wireFormat === "binary" || wireFormat === "both";

      try {
        if (writeJson) {
          const text = `${JSON.stringify(snapshot, null, 2)}\n`;
          await client.writeWithMetadata(
            F402_BET_TICKER_R2_KEY,
            new TextEncoder().encode(text),
            {
              type: "application/json",
              metadata: {
                pii: "none",
                "schema-version": String(snapshot.schemaVersion),
                "desk-date": snapshot.deskDate,
                "generated-at": snapshot.generatedAt,
                sha256: snapshot.sourceSha256,
                source: F402_BET_TICKER_SOURCE,
              },
            },
          );
        }

        if (writeBinary) {
          const binBytes = encodeF402TickerBinarySnapshot(snapshot);
          await client.writeWithMetadata(
            F402_BET_TICKER_R2_BINARY_KEY,
            binBytes,
            {
              type: "application/octet-stream",
              metadata: {
                pii: "none",
                "schema-version": "2",
                "desk-date": snapshot.deskDate,
                "generated-at": snapshot.generatedAt,
                sha256: snapshot.sourceSha256,
                source: F402_BET_TICKER_SOURCE,
              },
            },
          );
        }

        const primaryKey =
          wireFormat === "binary"
            ? F402_BET_TICKER_R2_BINARY_KEY
            : F402_BET_TICKER_R2_KEY;
        return {
          ok: true,
          url: `${client.publicBase}/${primaryKey}`,
        };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}
