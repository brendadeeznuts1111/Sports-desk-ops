#!/usr/bin/env bun
/**
 * Live stream CLI — weight-tier `stream-signals` over raw Fantasy402 bet-ticker rows.
 *
 * The `/api/live-bets` WebSocket relay publishes PII-stripped aggregates on `f402-bet-ticker`;
 * tier matching requires customer logins, so this command reads **raw** `getBetTicker` rows via:
 *   - live poll (session file / replay transport)
 *   - `--from-jsonl` tail (4C collector)
 *   - `--from-body` capture replay
 *
 * Optional `--bridge-url` connects to the dashboard/blob bridge and **re-polls** the ticker when
 * a delta reports new/changed tickets (bridge tick ≠ row payload).
 *
 * Usage:
 *   bun run live:stream-signals --once --from-body scratch/f402-captures/bet-ticker.json
 *   bun run live:stream-signals --poll --interval-ms 15000
 *   bun run live:stream-signals --bridge-url ws://127.0.0.1:8787/api/live-bets --poll
 *
 * Exit: 0 ok, 1 poll/bridge failure, 2 usage.
 */
import { parseArgs } from "node:util";

import {
  F402_BET_TICKER_LIVE_CHANNEL,
  type F402TickerDeltaEvent,
} from "../lib/f402_bet_ticker_delta.ts";
import {
  readF402TickerJsonl,
  type F402TickerJsonlOptions,
  type F402TickerJsonlState,
} from "../lib/f402_bet_ticker_jsonl.ts";
import {
  parseF402TickerRow,
  probeF402BetTicker,
  type F402TickerRow,
} from "../lib/f402_ingest.ts";
import {
  createF402ReplayTransport,
  type F402ReplayTransport,
} from "../lib/f402_replay_transport.ts";
import { describeF402Session, readF402Session } from "../lib/f402_session.ts";
import type { Dod6SpineOverlay } from "../lib/dod6_spine_overlay.ts";
import type { GsliveSteamIndex } from "../lib/gslive_steam_index.ts";
import {
  createDod6SpineOverlay,
  explainDiagnostics,
  loadDod6BookOverlayFromJson,
  loadGsliveSteamIndexFromJson,
  type Dod6CustomerBookOverlay,
  type StreamSignalEmission,
  MiamiSyndicateClusterTracker,
  planStreamSignalsForRows,
  WEIGHT_TIER_DEFINITIONS,
  type WeightTierId,
} from "../lib/weight_tier_stream_signals.ts";
import { KalshiClient } from "../lib/kalshi_client.ts";
import {
  joinConfigFromEnv,
  type KalshiJoin,
} from "../lib/kalshi_signal_join.ts";
import {
  joinKalshiForStreamEmissions,
  withKalshiJoin,
  type StreamSignalEmissionWithKalshi,
} from "../lib/weight_tier_kalshi_join.ts";

/** Matches `services/sportsdesk_webview_server.ts` bridge subprotocol. */
const BRIDGE_WS_PROTOCOL = "sportsdesk.bridge.v1";

const HELP = [
  "Usage: bun run scripts/sportsdesk-live-stream-cli.ts stream-signals [flags]",
  "",
  "  stream-signals   Map sharp weight-tier customers to line-step + external order drafts",
  "",
  "Input (pick one primary; --poll combines with --bridge-url as wake-up):",
  "  --poll                 Live POST getBetTicker (session / replay transport)",
  "  --from-body <path>     Replay one capture (raw LIST or capture envelope)",
  "  --from-jsonl <path>    Tail 4C ticker JSONL (single pass unless --watch)",
  "  --watch                With --from-jsonl, loop and read new bytes",
  "",
  "Bridge wake-up (optional):",
  "  --bridge-url <ws-url>  Subscribe to f402-bet-ticker; poll when delta has new/changed tickets",
  "  --bridge-token <tok>   Admin token (subprotocol bearer-…); default SPORTSDESK_ADMIN_TOKEN",
  "",
  "Poll flags:",
  "  --agent <id>           F402 agent (default F402_AGENT_ID)",
  "  --base-url <url>       Fantasy402 base (default https://fantasy402.com)",
  "  --interval-ms <n>      Poll interval when not --once (default 15000)",
  "  --once                 Single poll / single jsonl pass / one bridge-triggered poll",
  "",
  "Output:",
  "  --json                 One NDJSON emission per stdout line (default)",
  "  --tier <id>            Filter to one tier (repeatable)",
  "  --dry-run              Print tier registry only; no network",
  "  --enrich-book <path>   DOD6/book JSON overlay (customer_id, clv_bps, sharp_score)",
  "  --dodbin <path>        DOD6 v5.4 spine envelope (64-byte header metadata)",
  "  --lifetime-csv <path>  Bettor lifetime CSV (CLV legs / avg CLV points gate)",
  "  --gslive-steam-index <path>  JSON map ROT → timeUntilScoreSec (Partner 118)",
  "  --resolve-markets      Offline Kalshi series + Gamma hints on wireDraft",
  "  --kalshi-join          Live read-only Kalshi join (public GET; adds kalshiJoin to NDJSON)",
  "  --explain              Human-readable diagnostics on stderr (NDJSON still on stdout)",
  "",
  "Tiers:",
  ...WEIGHT_TIER_DEFINITIONS.map((tier) => `    ${tier.id}`),
  "",
  "Exit: 0 ok, 1 failure, 2 usage.",
].join("\n");

function usage(message: string): never {
  console.error(`live-stream: ${message}\n\n${HELP}`);
  process.exit(2);
}

function extractRows(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["LIST", "data", "rows", "response"]) {
    const value = record[key];
    if (Array.isArray(value)) return value;
    if (value !== null && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const inner of ["LIST", "data", "rows"]) {
        const arr = nested[inner];
        if (Array.isArray(arr)) return arr;
      }
    }
  }
  return null;
}

async function loadBodyRows(path: string): Promise<F402TickerRow[]> {
  const text = await Bun.file(path).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`from-body: not JSON: ${path}`);
  }
  if (parsed !== null && typeof parsed === "object") {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.response !== undefined) {
      parsed = envelope.response;
    }
  }
  const rawRows = extractRows(parsed);
  if (rawRows === null) throw new Error(`from-body: no LIST in ${path}`);
  const rows: F402TickerRow[] = [];
  for (const raw of rawRows) {
    const row = parseF402TickerRow(raw);
    if (row !== null) rows.push(row);
  }
  return rows;
}

async function pollTickerRows(options: {
  readonly agentId: string;
  readonly baseUrl: string;
  readonly session: NonNullable<Awaited<ReturnType<typeof readF402Session>>>;
  readonly transport: F402ReplayTransport;
}): Promise<F402TickerRow[]> {
  const probe = await probeF402BetTicker(options.session, {
    baseUrl: options.baseUrl,
    agentId: options.agentId,
    fetchImpl: (input, init) => options.transport.fetch(input, init),
    maxTicks: 5000,
  });
  if (probe.error !== null) {
    throw new Error(probe.error);
  }
  return [...probe.ticks];
}

function rowLookupKey(row: F402TickerRow): string {
  return `${row.wagerNumber}:${row.login.trim().toUpperCase()}`;
}

function emissionLookupKey(emission: StreamSignalEmission): string {
  return `${emission.wagerNumber}:${emission.triggerLogin.trim().toUpperCase()}`;
}

async function emitSignals(
  rows: readonly F402TickerRow[],
  tierFilter: ReadonlySet<WeightTierId> | null,
  clusterTracker: MiamiSyndicateClusterTracker,
  dod6Book: Dod6CustomerBookOverlay | null,
  dod6Spine: Dod6SpineOverlay | null,
  gsliveSteamIndex: GsliveSteamIndex | null,
  resolveMarkets: boolean,
  kalshiJoin: boolean,
  explain: boolean,
): Promise<void> {
  const emissions = planStreamSignalsForRows(rows, {
    clusterTracker,
    dod6Book,
    dod6Spine,
    gsliveSteamIndex,
    resolveMarkets,
  });
  const rowByKey = new Map(rows.map((row) => [rowLookupKey(row), row]));
  const visible = emissions.filter(
    (emission) => tierFilter === null || tierFilter.has(emission.tier),
  );

  if (!kalshiJoin) {
    for (const emission of visible) {
      writeEmission(emission, explain);
    }
    return;
  }

  const pairs = visible
    .map((emission) => {
      const row = rowByKey.get(emissionLookupKey(emission));
      return row === undefined ? null : { emission, row };
    })
    .filter(
      (pair): pair is { emission: StreamSignalEmission; row: F402TickerRow } =>
        pair !== null,
    );

  const client = new KalshiClient();
  const joined = await joinKalshiForStreamEmissions(pairs, {
    client,
    config: joinConfigFromEnv(),
  });
  const joinByKey = new Map(
    joined.map((entry) => [
      emissionLookupKey(entry.emission),
      entry.kalshiJoin,
    ]),
  );

  for (const emission of visible) {
    const kalshi = joinByKey.get(emissionLookupKey(emission));
    writeEmission(
      kalshi !== undefined ? withKalshiJoin(emission, kalshi) : emission,
      explain,
      kalshi,
    );
  }

  const telemetry = client.telemetry();
  if (!telemetry.ok) {
    for (const error of telemetry.errors) {
      process.stderr.write(
        `live-stream: kalshi degraded (${error.scope}): ${error.reason}\n`,
      );
    }
  }
}

function writeEmission(
  emission: StreamSignalEmission | StreamSignalEmissionWithKalshi,
  explain: boolean,
  kalshiJoin?: KalshiJoin,
): void {
  process.stdout.write(`${JSON.stringify(emission)}\n`);
  if (explain) {
    process.stderr.write(
      `[${emission.triggerLogin} tier=${emission.tier}] ${explainDiagnostics(emission.diagnostics)}\n`,
    );
  }
  if (explain && kalshiJoin !== undefined) {
    process.stderr.write(
      `  kalshi verdict=${kalshiJoin.verdict} market=${kalshiJoin.marketTicker ?? "—"} edge_bps=${kalshiJoin.edgeBps ?? "—"}\n`,
    );
  }
}

function parseTierFilter(
  values: readonly string[],
): ReadonlySet<WeightTierId> | null {
  if (values.length === 0) return null;
  const allowed = new Set(WEIGHT_TIER_DEFINITIONS.map((tier) => tier.id));
  const chosen = new Set<WeightTierId>();
  for (const raw of values) {
    if (!allowed.has(raw as WeightTierId)) {
      usage(`unknown tier ${raw}`);
    }
    chosen.add(raw as WeightTierId);
  }
  return chosen;
}

async function runBridgeWakePoll(options: {
  readonly bridgeUrl: string;
  readonly bridgeToken: string | null;
  readonly poll: () => Promise<F402TickerRow[]>;
  readonly once: boolean;
  readonly tierFilter: ReadonlySet<WeightTierId> | null;
  readonly clusterTracker: MiamiSyndicateClusterTracker;
  readonly dod6Book: Dod6CustomerBookOverlay | null;
  readonly dod6Spine: Dod6SpineOverlay | null;
  readonly gsliveSteamIndex: GsliveSteamIndex | null;
  readonly resolveMarkets: boolean;
  readonly kalshiJoin: boolean;
  readonly explain: boolean;
}): Promise<void> {
  const protocols =
    options.bridgeToken === null
      ? [BRIDGE_WS_PROTOCOL]
      : [BRIDGE_WS_PROTOCOL, `bearer-${options.bridgeToken}`];
  const socket = new WebSocket(options.bridgeUrl, protocols);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("bridge ws open timeout")),
      8_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("bridge ws open failed"));
    });
  });
  socket.send(
    JSON.stringify({
      type: "SUBSCRIBE",
      channel: F402_BET_TICKER_LIVE_CHANNEL,
    }),
  );

  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const pollAndEmit = async (): Promise<void> => {
    const rows = await options.poll();
    await emitSignals(
      rows,
      options.tierFilter,
      options.clusterTracker,
      options.dod6Book,
      options.dod6Spine,
      options.gsliveSteamIndex,
      options.resolveMarkets,
      options.kalshiJoin,
      options.explain,
    );
  };

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      void (async () => {
        let frame: unknown;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (frame === null || typeof frame !== "object") return;
        const delta = frame as F402TickerDeltaEvent;
        if (
          delta.kind !== F402_BET_TICKER_LIVE_CHANNEL ||
          (delta.newTickets <= 0 && delta.changedTickets <= 0)
        ) {
          return;
        }
        try {
          await pollAndEmit();
          if (options.once) {
            stopping = true;
            socket.close();
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      })();
    });
    socket.addEventListener("close", () => {
      if (!stopping) reject(new Error("bridge ws closed"));
      else resolve();
    });
  });
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      poll: { type: "boolean", default: false },
      "from-body": { type: "string" },
      "from-jsonl": { type: "string" },
      watch: { type: "boolean", default: false },
      "bridge-url": { type: "string" },
      "bridge-token": { type: "string" },
      agent: { type: "string" },
      "base-url": { type: "string" },
      "interval-ms": { type: "string", default: "15000" },
      once: { type: "boolean", default: false },
      json: { type: "boolean", default: true },
      tier: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      "enrich-book": { type: "string" },
      dodbin: { type: "string" },
      "lifetime-csv": { type: "string" },
      "gslive-steam-index": { type: "string" },
      "resolve-markets": { type: "boolean", default: false },
      "kalshi-join": { type: "boolean", default: false },
      explain: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (
    values.help ||
    positionals[0] === undefined ||
    positionals[0] === "help"
  ) {
    console.log(HELP);
    return 0;
  }
  if (positionals[0] !== "stream-signals") {
    usage(`unknown command ${String(positionals[0])}`);
  }

  const tierFilter = parseTierFilter(values.tier ?? []);
  const clusterTracker = new MiamiSyndicateClusterTracker();
  const explain = values.explain === true;
  let dod6Book: Dod6CustomerBookOverlay | null = null;
  let dod6Spine: Dod6SpineOverlay | null = null;
  let gsliveSteamIndex: GsliveSteamIndex | null = null;
  const resolveMarkets = values["resolve-markets"] === true;
  const kalshiJoin = values["kalshi-join"] === true;
  const enrichBook = values["enrich-book"]?.trim();
  const dodbin = values.dodbin?.trim();
  const lifetimeCsv =
    values["lifetime-csv"]?.trim() ?? Bun.env.F402_LIFETIME_CSV?.trim() ?? "";
  const gsliveSteamPath = values["gslive-steam-index"]?.trim();

  if (enrichBook !== undefined && enrichBook !== "") {
    try {
      dod6Book = loadDod6BookOverlayFromJson(enrichBook);
    } catch (error) {
      console.error(
        `live-stream: --enrich-book failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  if (
    (dodbin !== undefined && dodbin !== "") ||
    lifetimeCsv !== "" ||
    (enrichBook !== undefined && enrichBook !== "")
  ) {
    try {
      dod6Spine = await createDod6SpineOverlay({
        ...(dodbin === undefined || dodbin === ""
          ? {}
          : { dodbinPath: dodbin }),
        ...(lifetimeCsv === "" ? {} : { lifetimeCsvPath: lifetimeCsv }),
        ...(enrichBook === undefined || enrichBook === ""
          ? {}
          : { jsonBookPath: enrichBook }),
      });
    } catch (error) {
      console.error(
        `live-stream: DOD6 spine overlay failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  if (gsliveSteamPath !== undefined && gsliveSteamPath !== "") {
    try {
      gsliveSteamIndex = await loadGsliveSteamIndexFromJson(gsliveSteamPath);
    } catch (error) {
      console.error(
        `live-stream: --gslive-steam-index failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  if (values["dry-run"]) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        tiers: WEIGHT_TIER_DEFINITIONS,
        note: "dry-run: no network; use --from-body or --poll for emissions",
      })}\n`,
    );
    return 0;
  }

  const fromBody = values["from-body"];
  const fromJsonl = values["from-jsonl"];
  const intervalMs = Number(values["interval-ms"]);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    usage("--interval-ms must be >= 1000");
  }

  if (fromBody !== undefined) {
    const rows = await loadBodyRows(fromBody);
    await emitSignals(
      rows,
      tierFilter,
      clusterTracker,
      dod6Book,
      dod6Spine,
      gsliveSteamIndex,
      resolveMarkets,
      kalshiJoin,
      explain,
    );
    return 0;
  }

  if (fromJsonl !== undefined) {
    let jsonlState: F402TickerJsonlState | undefined;
    const runPass = async (): Promise<void> => {
      const readOptions: F402TickerJsonlOptions =
        jsonlState === undefined
          ? { windowBytes: 2_000_000 }
          : {
              windowBytes: 2_000_000,
              state: jsonlState,
              filterWatermark: jsonlState.initialized,
            };
      const read = await readF402TickerJsonl(fromJsonl, readOptions);
      jsonlState = read.state;
      await emitSignals(
        read.rows,
        tierFilter,
        clusterTracker,
        dod6Book,
        dod6Spine,
        gsliveSteamIndex,
        resolveMarkets,
        kalshiJoin,
        explain,
      );
    };
    await runPass();
    if (!values.watch) return 0;
    while (true) {
      await Bun.sleep(intervalMs);
      await runPass();
    }
  }

  const agentId = (values.agent ?? Bun.env.F402_AGENT_ID ?? "").trim();
  if (agentId === "") usage("--agent or F402_AGENT_ID required for --poll");

  const baseUrl = (values["base-url"] ?? "https://fantasy402.com").replace(
    /\/$/,
    "",
  );
  const session = readF402Session();
  if (session === null) {
    console.error(
      `live-stream: no F402 session (${describeF402Session(session)}); use --from-body or --from-jsonl`,
    );
    return 1;
  }
  const transport = await createF402ReplayTransport();

  const poll = (): Promise<F402TickerRow[]> =>
    pollTickerRows({ agentId, baseUrl, session, transport });

  const bridgeUrl = values["bridge-url"]?.trim();
  if (bridgeUrl !== undefined && bridgeUrl !== "") {
    const bridgeToken =
      values["bridge-token"]?.trim() ??
      Bun.env.SPORTSDESK_ADMIN_TOKEN?.trim() ??
      null;
    try {
      await runBridgeWakePoll({
        bridgeUrl,
        bridgeToken,
        poll,
        once: values.once ?? false,
        tierFilter,
        clusterTracker,
        dod6Book,
        dod6Spine,
        gsliveSteamIndex,
        resolveMarkets,
        kalshiJoin,
        explain,
      });
    } catch (error) {
      console.error(
        `live-stream: bridge/poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    return 0;
  }

  const loop = async (): Promise<void> => {
    const rows = await poll();
    await emitSignals(
      rows,
      tierFilter,
      clusterTracker,
      dod6Book,
      dod6Spine,
      gsliveSteamIndex,
      resolveMarkets,
      kalshiJoin,
      explain,
    );
  };

  try {
    await loop();
    if (values.once) return 0;
    while (true) {
      await Bun.sleep(intervalMs);
      await loop();
    }
  } catch (error) {
    console.error(
      `live-stream: poll failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
