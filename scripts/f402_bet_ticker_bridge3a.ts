#!/usr/bin/env bun
/**
 * @file f402_bet_ticker_bridge3a.ts
 * @description Bridge 3a poller CLI: read the Fantasy402 bet ticker read-only, drain it, project the
 * sanitized delta, publish the WS event on `f402-bet-ticker`, and write
 * `f402-bet-ticker/latest.json` to R2. One poll by default; `--interval-ms` keeps an in-memory
 * watermark and previous rows across polls in this process.
 *
 * Auth never appears on argv or in logs: the probe runs through `createF402ReplayTransport()`
 * (proxy, session file, or FetchSession), and the gateway token comes from `BLOB_API_TOKEN`.
 * `--from-body` replays a saved `getBetTicker` body for local smoke runs without a session.
 *
 * Usage:
 *   bun run bridge3a:poll                       # one poll (agent from F402_AGENT_ID)
 *   bun run bridge3a:poll --agent BILLY666 --interval-ms 30000
 *   bun run bridge3a:poll --dry-run --from-body scratch/f402-captures/bet-ticker.json
 *
 * Exit codes: 0 processed (published/baseline/noop), 1 poll failure or fail-closed skip, 2 usage.
 */

import { parseArgs } from "node:util";

import {
  F402_BET_TICKER_LIVE_CHANNEL,
  F402_BET_TICKER_R2_KEY,
} from "../lib/f402_bet_ticker_delta.ts";
import {
  pollF402BetTickerOnce,
  type F402BetTickerPollOutcome,
  type F402BetTickerPollState,
} from "../lib/f402_bet_ticker_poller.ts";
import { createF402BetTickerSink } from "../lib/f402_bet_ticker_sink.ts";
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
  "  --interval-ms <n>    poll every n ms; 0 (default) runs one poll",
  "  --from-body <path>   replay a saved getBetTicker body (raw body or capture envelope)",
  "  --no-ws              do not publish the gateway delta",
  "  --no-r2              do not write the R2 snapshot",
  "  --publish-baseline   emit the first poll as a delta instead of establishing a silent watermark",
  "  --dry-run            no sinks; print the sanitized delta/snapshot JSON to stdout",
  "",
  "Auth: a session file (bun run session:login), F402_SESSION_FILE or F402_REPLAY_PROXY_URL.",
  "Gateway: BLOB_API_TOKEN, BLOB_GATEWAY_URL or BLOB_PORT (default http://127.0.0.1:4021).",
  "R2: R2_* / CLOUDFLARE_R2_* env or Bun.secrets, via R2S3Client.fromEnvOrSecrets().",
  "",
  "Exit codes: 0 processed, 1 fail-closed skip or error, 2 usage.",
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
        "no-ws": { type: "boolean", default: false },
        "no-r2": { type: "boolean", default: false },
        "publish-baseline": { type: "boolean", default: false },
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

const intervalMs = (() => {
  const raw = values["interval-ms"] ?? "0";
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    usage("--interval-ms must be a non-negative integer");
  }
  return parsed;
})();

const agentId = (values.agent ?? Bun.env.F402_AGENT_ID ?? "").trim();
const baseUrl = (values["base-url"] ?? "https://fantasy402.com").trim();
const dryRun = values["dry-run"];
if (agentId === "" && values["from-body"] === undefined) {
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
        const payload: unknown = JSON.parse(await Bun.file(path).text());
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
    case "published":
      console.error(
        `[bridge3a] published new=${outcome.event.newTickets} gone=${outcome.event.goneTickets} ` +
          `changed=${outcome.event.changedTickets} watermark=${outcome.event.watermark} ` +
          `ws=${sinkStatus(outcome.liveBets)} r2=${sinkStatus(outcome.r2)}`,
      );
      return 0;
    case "baseline":
      console.error(
        `[bridge3a] baseline rows=${outcome.snapshot.rowCount} ` +
          `watermark=${outcome.snapshot.watermark} r2=${sinkStatus(outcome.r2)}`,
      );
      return 0;
    case "noop":
      console.error(`[bridge3a] noop (${outcome.reason})`);
      return 0;
    case "skipped":
      console.error(
        `[bridge3a] skipped ${outcome.reason}${outcome.error === undefined ? "" : `: ${outcome.error}`}`,
      );
      return 1;
  }
}

async function main(): Promise<number> {
  const fromBody = values["from-body"];
  const session = fromBody === undefined ? new SessionProbe() : null;
  const fixture = fromBody === undefined ? null : fixtureProbe(fromBody);
  const probe =
    fixture?.probe ??
    (session === null
      ? usage("probe unavailable")
      : (wagerNumber: string) => session.probe(wagerNumber));

  const sink = createF402BetTickerSink({
    liveBets: dryRun ? false : !values["no-ws"],
    r2: dryRun ? false : !values["no-r2"],
    apiToken: Bun.env.BLOB_API_TOKEN ?? "",
  });

  if (session !== null) {
    console.error(
      `[bridge3a] session: ${describeF402Session(readF402Session())} ` +
        `channel=${F402_BET_TICKER_LIVE_CHANNEL} r2=${F402_BET_TICKER_R2_KEY}`,
    );
  }

  let state: F402BetTickerPollState = { watermark: 0, previousRows: [] };
  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on("SIGINT", onSignal);

  let exitCode = 0;
  try {
    do {
      const outcome = await pollF402BetTickerOnce({
        probe,
        sink,
        state,
        now: () => new Date().toISOString(),
        publishBaseline: dryRun || values["publish-baseline"],
      });
      const code = logOutcome(outcome);
      if (code !== 0) exitCode = code;
      if (outcome.status !== "skipped") state = outcome.state;
      if (
        dryRun &&
        (outcome.status === "published" || outcome.status === "baseline")
      ) {
        console.log(
          JSON.stringify(
            {
              status: outcome.status,
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
