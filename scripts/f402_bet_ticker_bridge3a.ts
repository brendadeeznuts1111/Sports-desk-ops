#!/usr/bin/env bun
/**
 * @file f402_bet_ticker_bridge3a.ts
 * @description Bridge 3a poller CLI: read the Fantasy402 bet ticker read-only, drain it, project the
 * sanitized delta, publish the WS event on `f402-bet-ticker`, and write
 * `f402-bet-ticker/latest.json` to R2. Polls every `--interval-ms` (default 15_000 ms, the locked
 * cadence); `--once` runs a single poll. The watermark and previous rows stay in memory for the
 * life of the process.
 *
 * Auth never appears on argv or in logs: the probe runs through `createF402ReplayTransport()`
 * (proxy, session file, or FetchSession), and the gateway token comes from `BLOB_API_TOKEN`.
 * `--from-body` replays a saved `getBetTicker` body; `--from-jsonl` tails the live 4C collector's
 * append-only JSONL instead of opening a second Fantasy402 session. Both avoid the live API.
 *
 * Usage:
 *   bun run bridge3a:poll                       # one loop tick (agent from F402_AGENT_ID)
 *   bun run bridge3a:poll --agent BILLY666 --interval-ms 30000
 *   bun run bridge3a:poll --dry-run --from-body scratch/f402-captures/bet-ticker.json
 *   bun run bridge3a:poll --from-jsonl /Users/nolarose/4c-odds-intergration/probes/out13/f402-bets.jsonl --publish-baseline
 *
 * Exit codes: 0 processed (published/baseline/noop), 1 poll failure or fail-closed skip, 2 usage.
 */

import { parseArgs } from "node:util";

import {
  F402_BET_TICKER_LIVE_CHANNEL,
  F402_BET_TICKER_R2_KEY,
  buildF402TickerSnapshot,
  projectF402TickerDelta,
} from "../lib/f402_bet_ticker_delta.ts";
import {
  F402_BET_TICKER_DEFAULT_POLL_INTERVAL_MS,
  pollF402BetTickerOnce,
  type F402BetTickerPollOutcome,
  type F402BetTickerPollState,
} from "../lib/f402_bet_ticker_poller.ts";
import { createF402BetTickerSink } from "../lib/f402_bet_ticker_sink.ts";
import {
  F402_BET_TICKER_JSONL_WINDOW_BYTES,
  loadF402TickerJsonlState,
  readF402TickerJsonl,
  saveF402TickerJsonlState,
  shouldRefreshWindowSnapshot,
  type F402TickerJsonlState,
} from "../lib/f402_bet_ticker_jsonl.ts";
import {
  parseF402TickerRow,
  probeF402BetTicker,
  type F402Probe,
  type F402TickerRow,
} from "../lib/f402_ingest.ts";
import {
  describeF402Session,
  readF402Session,
  refreshF402Session,
  writeF402Session,
} from "../lib/f402_session.ts";
import {
  createF402ReplayTransport,
  type F402ReplayTransport,
} from "../lib/f402_replay_transport.ts";

const HELP = [
  "Usage: bun run bridge3a:poll [flags]",
  "",
  "  --agent <id>         agent whose ticker to read (falls back to F402_AGENT_ID)",
  "  --base-url <url>     Fantasy402 base URL (default https://fantasy402.com)",
  "  --interval-ms <n>    poll every n ms (default 15000)",
  "  --once               run one poll and exit",
  "  --from-body <path>   replay a saved getBetTicker body (raw body or capture envelope)",
  "  --from-jsonl <path>  tail the live 4C ticker JSONL (new bytes only; no F402 session)",
  "  --jsonl-window-bytes <n>  initial tail window for --from-jsonl (default 2000000)",
  "  --jsonl-state <path>  persisted offset/watermark for --from-jsonl",
  "                        (default scratch/f402-bet-ticker/jsonl-state.json)",
  "  --jsonl-window-snapshot  ignore persisted state; read the window and write R2",
  "  --r2-window-every <n>  refresh the R2 window snapshot every n loop ticks",
  "                        with new bytes (default 4 = 60s at 15s)",
  "  --no-ws              do not publish the gateway delta",
  "  --no-r2              do not write the R2 snapshot",
  "  --publish-baseline   emit the first poll as a delta instead of establishing a silent watermark",
  "  --wire-format <fmt>  R2 wire format: json | binary | both (default: json or BRIDGE3A_WIRE_FORMAT)",
  "  --dry-run            no sinks; one poll; print the sanitized delta/snapshot JSON to stdout",
  "",
  "Auth: a session file (bun run session:login), F402_SESSION_FILE or F402_REPLAY_PROXY_URL.",
  "Gateway: BLOB_API_TOKEN, BLOB_GATEWAY_URL or BLOB_PORT (default http://127.0.0.1:4021).",
  "R2: R2_* / CLOUDFLARE_R2_* env or Bun.secrets, via R2S3Client.fromEnvOrSecrets().",
  "",
  "Exit codes: 0 processed, 1 fail-closed status (regressed/unsettled/error), 2 usage.",
].join("\n");

function usage(message: string): never {
  console.error(`bridge3a: ${message}\n\n${HELP}`);
  process.exit(2);
}

const { values } = (() => {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        agent: { type: "string" },
        "base-url": { type: "string" },
        "interval-ms": { type: "string" },
        "from-body": { type: "string" },
        "from-jsonl": { type: "string" },
        "jsonl-window-bytes": { type: "string" },
        "jsonl-state": { type: "string" },
        "jsonl-window-snapshot": { type: "boolean", default: false },
        "r2-window-every": { type: "string" },
        once: { type: "boolean", default: false },
        "no-ws": { type: "boolean", default: false },
        "no-r2": { type: "boolean", default: false },
        "publish-baseline": { type: "boolean", default: false },
        "wire-format": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
})();

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const dryRun = values["dry-run"];
const rawWireFormat =
  values["wire-format"] ?? Bun.env.BRIDGE3A_WIRE_FORMAT ?? "json";
if (
  rawWireFormat !== "json" &&
  rawWireFormat !== "binary" &&
  rawWireFormat !== "both"
) {
  usage("--wire-format must be one of: json, binary, both");
}
const wireFormat = rawWireFormat as "json" | "binary" | "both";

const intervalMs = (() => {
  if (values.once || dryRun) return 0;
  const raw = values["interval-ms"];
  if (raw === undefined) return F402_BET_TICKER_DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    usage("--interval-ms must be a non-negative integer");
  }
  return parsed;
})();

const agentId = (values.agent ?? Bun.env.F402_AGENT_ID ?? "").trim();
const baseUrl = (values["base-url"] ?? "https://fantasy402.com").trim();
if (
  agentId === "" &&
  values["from-body"] === undefined &&
  values["from-jsonl"] === undefined
) {
  usage("no agent: pass --agent <id> or set F402_AGENT_ID");
}

/** Probe source over the replay transport; refreshes once on the 401 sentinel. */
class SessionProbe {
  private transport: F402ReplayTransport | null = null;

  async probe(wagerNumber: string): Promise<F402Probe> {
    let session = readF402Session();
    if (session === null) {
      session = await refreshF402Session();
      writeF402Session(session);
    }
    const first = await this.run(session, wagerNumber);
    if (first.error !== "unauthorized") return first;
    const refreshed = await refreshF402Session();
    writeF402Session(refreshed);
    await this.reset();
    return this.run(refreshed, wagerNumber);
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private async reset(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport !== null) await transport.close();
  }

  private async transportOrCreate(): Promise<F402ReplayTransport> {
    if (this.transport === null) {
      this.transport = await createF402ReplayTransport();
    }
    return this.transport;
  }

  private async run(
    session: Awaited<ReturnType<typeof refreshF402Session>>,
    wagerNumber: string,
  ): Promise<F402Probe> {
    const transport = await this.transportOrCreate();
    return probeF402BetTicker(session, {
      agentId,
      baseUrl,
      wagerNumber,
      // Bridge 3a processes the whole drained list, not the 200-row preview budget.
      maxTicks: 5_000,
      fetchImpl: (input, init) => transport.fetch(input, init),
    });
  }
}

/** Rows from a saved body: raw `{LIST}`/array, or a capture envelope `{response:{body}}`. */
function rowsFromPayload(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.LIST)) return record.LIST;
    const response = record.response;
    if (response !== null && typeof response === "object") {
      const body = (response as Record<string, unknown>).body;
      if (body !== null && typeof body === "object") {
        const list = (body as Record<string, unknown>).LIST;
        if (Array.isArray(list)) return list;
      }
    }
    const body = record.body;
    if (body !== null && typeof body === "object") {
      const list = (body as Record<string, unknown>).LIST;
      if (Array.isArray(list)) return list;
    }
  }
  throw new Error("fixture has no LIST array (raw body or capture envelope)");
}

function fixtureProbe(path: string): {
  readonly probe: (wagerNumber: string) => Promise<F402Probe>;
  readonly rowCount: number;
} {
  let rows: readonly F402TickerRow[] | null = null;
  return {
    async probe(wagerNumber) {
      if (rows === null) {
        const payload: unknown = await Bun.file(path).json();
        const raw = rowsFromPayload(payload);
        rows = raw
          .map((row) => parseF402TickerRow(row))
          .filter((row): row is F402TickerRow => row !== null);
      }
      const ticks = wagerNumber === "0" ? rows : [];
      return {
        endpoint: `fixture:${path}`,
        httpStatus: 200,
        rows: wagerNumber === "0" ? rows.length : 0,
        fields: [],
        ticks,
        durationMs: 0,
        fetchedAtIso: new Date().toISOString(),
        error: null,
      };
    },
    get rowCount() {
      return rows?.length ?? 0;
    },
  };
}

function sinkStatus(result: {
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly error?: string;
}): string {
  if (result.skipped === true) return "skipped";
  if (result.ok) return "ok";
  return `failed (${result.error ?? "unknown error"})`;
}

function logOutcome(outcome: F402BetTickerPollOutcome): number {
  switch (outcome.status) {
    case "published": {
      const diagSuffix =
        outcome.diagnostics && outcome.diagnostics.overflowRejectionCount > 0
          ? ` overflowRejections=${outcome.diagnostics.overflowRejectionCount}`
          : "";
      console.error(
        `[bridge3a] published new=${outcome.event.newTickets} gone=${outcome.event.goneTickets} ` +
          `changed=${outcome.event.changedTickets} watermark=${outcome.event.watermark} ` +
          `ws=${sinkStatus(outcome.liveBets)} r2=${sinkStatus(outcome.r2)}${diagSuffix}`,
      );
      if (
        outcome.diagnostics &&
        outcome.diagnostics.overflowRejectionCount > 0
      ) {
        console.error(
          `[bridge3a] WARNING: ${outcome.diagnostics.overflowRejectionCount} ticket(s) rejected due to amount overflow in batch`,
        );
      }
      return 0;
    }
    case "baseline": {
      const diagSuffix =
        outcome.diagnostics && outcome.diagnostics.overflowRejectionCount > 0
          ? ` overflowRejections=${outcome.diagnostics.overflowRejectionCount}`
          : "";
      console.error(
        `[bridge3a] baseline rows=${outcome.snapshot.rowCount} ` +
          `watermark=${outcome.snapshot.watermark} r2=${sinkStatus(outcome.r2)}${diagSuffix}`,
      );
      if (
        outcome.diagnostics &&
        outcome.diagnostics.overflowRejectionCount > 0
      ) {
        console.error(
          `[bridge3a] WARNING: ${outcome.diagnostics.overflowRejectionCount} ticket(s) rejected due to amount overflow in batch`,
        );
      }
      return 0;
    }
    case "noop":
      console.error(`[bridge3a] noop (${outcome.reason})`);
      return 0;
    case "regressed":
      console.error(
        `[bridge3a] regressed watermark=${outcome.watermark} pageMax=${outcome.pageMax} (R2/WS untouched)`,
      );
      return 1;
    case "unsettled":
      console.error(
        `[bridge3a] unsettled pages=${outcome.pages} (R2/WS untouched)`,
      );
      return 1;
    case "error":
      console.error(`[bridge3a] error: ${outcome.error}`);
      return 1;
  }
}

async function main(): Promise<number> {
  const fromBody = values["from-body"];
  const fromJsonl = values["from-jsonl"];
  if (fromBody !== undefined && fromJsonl !== undefined) {
    usage("use either --from-body or --from-jsonl, not both");
  }
  const fixture = fromBody === undefined ? null : fixtureProbe(fromBody);
  const session =
    fromBody === undefined && fromJsonl === undefined
      ? new SessionProbe()
      : null;
  const jsonlWindowBytes = (() => {
    const raw = values["jsonl-window-bytes"];
    if (raw === undefined) return F402_BET_TICKER_JSONL_WINDOW_BYTES;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      usage("--jsonl-window-bytes must be a positive integer");
    }
    return parsed;
  })();
  const r2WindowEvery = (() => {
    const raw = values["r2-window-every"];
    if (raw === undefined) return 4;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      usage("--r2-window-every must be a positive integer");
    }
    return parsed;
  })();
  const jsonlStatePath =
    values["jsonl-state"] ?? "scratch/f402-bet-ticker/jsonl-state.json";
  const forceWindowSnapshot = values["jsonl-window-snapshot"];
  let jsonlState: F402TickerJsonlState | undefined =
    fromJsonl === undefined || forceWindowSnapshot
      ? undefined
      : await loadF402TickerJsonlState(jsonlStatePath, fromJsonl);
  // R2 holds the live-window snapshot. An incremental JSONL read covers only new rows, so the
  // poller must not write it; window polls (cold start, forced) and the periodic window refresh do.
  let pollerWindowPoll =
    fromJsonl === undefined || forceWindowSnapshot || jsonlState === undefined;
  let lastJsonlBytesRead = 0;

  // One poll's probe: read the new tail bytes once, then answer the drain's follow-up pages empty.
  const jsonlProbeForPoll = (): ((
    wagerNumber: string,
  ) => Promise<F402Probe>) => {
    let served = false;
    let tailRows: readonly F402TickerRow[] = [];
    return async () => {
      if (!served) {
        const read = await readF402TickerJsonl(fromJsonl ?? "", {
          ...(jsonlState === undefined ? {} : { state: jsonlState }),
          windowBytes: jsonlWindowBytes,
          filterWatermark: jsonlState !== undefined,
        });
        jsonlState = read.state;
        tailRows = read.rows;
        lastJsonlBytesRead = read.bytesRead;
        console.error(
          `[bridge3a] jsonl rows=${read.rows.length} bytes=${read.bytesRead} ` +
            `skipped=${read.skippedLines} reset=${read.reset} ` +
            `offset=${read.state.offset} watermark=${read.state.watermark}`,
        );
      }
      served = true;
      return {
        endpoint: `jsonl:${fromJsonl ?? ""}`,
        httpStatus: 200,
        rows: tailRows.length,
        fields: [],
        ticks: tailRows,
        durationMs: 0,
        fetchedAtIso: new Date().toISOString(),
        error: null,
      };
    };
  };

  const probeForPoll = (): ((wagerNumber: string) => Promise<F402Probe>) => {
    if (fromJsonl !== undefined) return jsonlProbeForPoll();
    if (fixture !== null) return fixture.probe;
    if (session === null) usage("probe unavailable");
    return (wagerNumber: string) => session.probe(wagerNumber);
  };

  const baseSink = createF402BetTickerSink({
    liveBets: dryRun ? false : !values["no-ws"],
    r2: dryRun ? false : !values["no-r2"],
    apiToken: Bun.env.BLOB_API_TOKEN ?? "",
    wireFormat,
  });
  const sink = {
    publishLiveBets: (event: Parameters<typeof baseSink.publishLiveBets>[0]) =>
      baseSink.publishLiveBets(event),
    publishR2: (snapshot: Parameters<typeof baseSink.publishR2>[0]) =>
      pollerWindowPoll
        ? baseSink.publishR2(snapshot)
        : Promise.resolve({ ok: true, skipped: true }),
  };

  if (session !== null) {
    console.error(
      `[bridge3a] session: ${describeF402Session(readF402Session())} ` +
        `channel=${F402_BET_TICKER_LIVE_CHANNEL} r2=${F402_BET_TICKER_R2_KEY}`,
    );
  }

  // A persisted JSONL watermark is the previous poll's processed point, so an incremental run
  // publishes a delta instead of reporting a false cold-start baseline.
  let state: F402BetTickerPollState = {
    watermark: jsonlState?.watermark ?? 0,
    previousRows: [],
  };
  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);

  let exitCode = 0;
  let tick = 0;
  let bytesSinceWindow = 0;
  try {
    do {
      pollerWindowPoll =
        fromJsonl === undefined ||
        forceWindowSnapshot ||
        jsonlState === undefined;
      lastJsonlBytesRead = 0;
      const outcome = await pollF402BetTickerOnce({
        probe: probeForPoll(),
        sink,
        state,
        now: () => new Date().toISOString(),
        publishBaseline: dryRun || values["publish-baseline"],
      });
      const code = logOutcome(outcome);
      if (code !== 0) exitCode = code;
      if (
        outcome.status === "published" ||
        outcome.status === "baseline" ||
        outcome.status === "noop"
      ) {
        state = outcome.state;
      }
      const processed =
        outcome.status === "published" ||
        outcome.status === "baseline" ||
        outcome.status === "noop";
      if (processed) {
        tick += 1;
        bytesSinceWindow += lastJsonlBytesRead;
      }
      if (fromJsonl !== undefined && jsonlState !== undefined && processed) {
        await saveF402TickerJsonlState(jsonlStatePath, fromJsonl, jsonlState);
      }
      if (
        fromJsonl !== undefined &&
        !dryRun &&
        !values["no-r2"] &&
        intervalMs > 0 &&
        processed &&
        shouldRefreshWindowSnapshot({
          tick,
          every: r2WindowEvery,
          bytesSinceLastWrite: bytesSinceWindow,
        })
      ) {
        const window = await readF402TickerJsonl(fromJsonl, {
          windowBytes: jsonlWindowBytes,
          filterWatermark: false,
        });
        const windowEvent = projectF402TickerDelta(
          [],
          window.rows,
          new Date().toISOString(),
        );
        const windowSnapshot = buildF402TickerSnapshot(
          windowEvent,
          window.rows.length,
        );
        const result = await baseSink.publishR2(windowSnapshot);
        console.error(
          `[bridge3a] r2 window rows=${window.rows.length} ` +
            `watermark=${windowSnapshot.watermark} r2=${sinkStatus(result)}`,
        );
        if (result.ok || result.skipped === true) bytesSinceWindow = 0;
      }
      if (
        dryRun &&
        (outcome.status === "published" || outcome.status === "baseline")
      ) {
        console.log(
          JSON.stringify(
            {
              status: outcome.status,
              wireFormat,
              event: outcome.event,
              snapshot: outcome.snapshot,
            },
            null,
            2,
          ),
        );
      }
      if (intervalMs === 0 || stopping) break;
      await Bun.sleep(intervalMs);
    } while (!stopping);
  } finally {
    process.off("SIGINT", onSignal);
    await session?.close();
  }
  return exitCode;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(
    `[bridge3a] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
