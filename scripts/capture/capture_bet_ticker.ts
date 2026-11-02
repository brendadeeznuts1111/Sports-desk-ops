#!/usr/bin/env bun
/**
 * @file capture_bet_ticker.ts
 * @description Captures the full `Manager/getBetTicker` list into `data/bet-ticker.json`, the file
 * the dashboard's Bet Ticker panel and `/api/live-wagers` read before the committed paste.
 *
 * Read-only: one POST with `wagerNumber=0`, which returns the whole current list (745 rows in the
 * 2026-11-01 discover run). Auth goes through `createF402ReplayTransport()` — session file or
 * replay proxy. No tokens on the command line, no tokens written to the artifact.
 *
 * The rows carry customer ids and logins, so the output is gitignored; `/api/live-wagers` is
 * PII-guarded for the same reason.
 *
 * Usage:
 *   bun run capture:bet-ticker                       # agent from F402_AGENT_ID
 *   bun run capture:bet-ticker --agent BILLY666
 *   bun run capture:bet-ticker --from-body scratch/f402-captures/bet-ticker-<ts>.json
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BET_TICKER_OPERATION,
  betTickerFile,
  readWagerListArtifact,
  summarizeLiveWagers,
} from "../../lib/live_wagers.ts";

const BET_TICKER_URL = `https://fantasy402.com${BET_TICKER_OPERATION}`;
const root = join(import.meta.dir, "../..");

const HELP = [
  "Usage: bun run capture:bet-ticker [flags]",
  "",
  "  --agent <id>        agent whose ticker to read (falls back to F402_AGENT_ID)",
  "  --from-body <path>  rebuild from a saved getBetTicker body instead of calling the API",
  "  --out <path>        artifact path (default data/bet-ticker.json, gitignored)",
  "  --dry-run           capture and report, write nothing",
  "",
  "Auth: a session file (bun run session:login), F402_SESSION_FILE or F402_REPLAY_PROXY_URL.",
  "Never pass a token on the command line.",
  "",
  "Exit codes: 0 written, 1 capture or parse failure, 2 usage.",
].join("\n");

function usage(message: string): never {
  console.error(`capture:bet-ticker: ${message}\n\n${HELP}`);
  process.exit(2);
}

const { values } = (() => {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        agent: { type: "string" },
        "from-body": { type: "string" },
        out: { type: "string", default: "data/bet-ticker.json" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
})();

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

async function fetchTickerBody(agentID: string): Promise<string> {
  const { createF402ReplayTransport } =
    await import("../../lib/f402_replay_transport.ts");
  const { readF402Session } = await import("../../lib/f402_session.ts");

  const proxyConfigured = (Bun.env.F402_REPLAY_PROXY_URL ?? "").trim() !== "";
  const session = readF402Session();
  // Without a session the transport degrades to a cookie-less fetch and gets a 401 page.
  if (!proxyConfigured && session === null) {
    throw new Error(
      [
        "no F402 session available for a live capture.",
        "Configure one of:",
        "  bun run session:login                       (one WebView login; writes the 0600 cache)",
        "  F402_SESSION_FILE=<session json>            (see lib/f402_session.ts)",
        "  F402_REPLAY_PROXY_URL=<localhost proxy>",
        "Or rebuild from a body you already saved: --from-body <path>",
      ].join("\n"),
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
  };
  if (session?.authorizationHeader !== undefined) {
    headers["authorization"] = session.authorizationHeader;
  }

  const transport = await createF402ReplayTransport();
  try {
    const body = new URLSearchParams({
      agentID,
      agentOwner: agentID,
      wagerNumber: "0",
      operation: "getBetTicker",
      RRO: "1",
    });
    const res = await transport.fetch(BET_TICKER_URL, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    const text = await res.text();
    console.log(
      `[capture:bet-ticker] ${agentID} via ${transport.label} -> HTTP ${res.status}, ${text.length} bytes`,
    );
    if (!res.ok) {
      throw new Error(
        `getBetTicker returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    return text;
  } finally {
    await transport.close();
  }
}

async function main(): Promise<void> {
  const fromBody = values["from-body"];
  let text: string;
  let observedAt: string;

  if (fromBody !== undefined) {
    const file = Bun.file(fromBody);
    if (!(await file.exists())) throw new Error(`not found: ${fromBody}`);
    text = await file.text();
    // A saved body has no capture time of its own; its mtime is the closest honest answer.
    observedAt = new Date(file.lastModified).toISOString();
  } else {
    const agentID = (values.agent ?? Bun.env.F402_AGENT_ID ?? "").trim();
    if (agentID === "") {
      usage("no agent: pass --agent <id> or set F402_AGENT_ID");
    }
    text = await fetchTickerBody(agentID);
    observedAt = new Date().toISOString();
  }

  const file = betTickerFile(JSON.parse(text), observedAt);
  const summary = summarizeLiveWagers(readWagerListArtifact(file).wagers);
  console.log(
    `[capture:bet-ticker] ${summary.counted} wager(s), ${summary.live} live, risk ${summary.risk}¢, volume ${summary.volume}¢`,
  );
  console.log(
    `[capture:bet-ticker] excluded ${summary.excluded.alert} alert + ${summary.excluded.blocked} blocked of ${summary.count} row(s), risk ${summary.excluded.risk}¢`,
  );
  console.log(
    `[capture:bet-ticker] byWriter: ${JSON.stringify(summary.byWriter)} byType: ${JSON.stringify(summary.byType)}`,
  );

  if (values["dry-run"]) {
    console.log("[capture:bet-ticker] dry run: artifact not written");
    return;
  }
  const outPath = resolve(root, values.out);
  await Bun.write(outPath, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `[capture:bet-ticker] artifact -> ${values.out} (PII-bearing, gitignored)`,
  );
  console.log(`[capture:bet-ticker] source: ${file.source}`);
}

try {
  await main();
} catch (err) {
  console.error(
    `capture:bet-ticker: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
