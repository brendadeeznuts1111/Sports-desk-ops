#!/usr/bin/env bun
/**
 * SportsDesk Plane 3 — self-healing JSONL ingestion replay (stream · XML · patterns · optional bitemporal WAL).
 *
 * Usage:
 *   bun sportsdesk_replay_cli.ts --path reports/ingestion-audit.jsonl
 *   bun sportsdesk_replay_cli.ts --path /tmp/e.jsonl --markdown --bitemporal
 */

import { resolve } from "node:path";
import type { SignalChannelCode } from "../design/domain-branded-types.ts";
import {
  ingestionFeedPullExitCode,
  pullIngestionFeedWithProvenance,
} from "../services/sportsdesk_ingestion_feed_provenance.ts";
import {
  formatSportsdeskReplayTradesTable,
  isSignalChannelCode,
  replayIngestionExitCode,
  replaySportsdeskIngestionLog,
  renderSportsdeskPatternAnsi,
  renderSportsdeskPatternMarkdown,
  SPORTSDESK_INGESTION_LOG_DEFAULT,
} from "../services/sportsdesk_ingestion_replay.ts";

function warnLatencySla(
  channelCode: SignalChannelCode,
  latencyMs: number,
  slaMs: number,
): void {
  console.warn(
    `\x1b[31m[SLA]\x1b[0m ${channelCode} violated: ${latencyMs}ms > ${slaMs}ms`,
  );
}

function printDroppedSummary(
  droppedByChannel: Partial<Record<SignalChannelCode, number>>,
): void {
  for (const [ch, n] of Object.entries(droppedByChannel) as [
    SignalChannelCode,
    number,
  ][]) {
    console.warn(`\x1b[33m[DROPPED]\x1b[0m ${ch}: ${n} rows skipped`);
  }
}

function printHelp(): void {
  console.log(`SportsDesk ingestion JSONL replay (Plane 3)

SQLite: bun:sqlite via lib/sportsdesk_sqlite.ts (strict + safeIntegers, WAL).
  VALID_TIME_OPEN_SENTINEL is 9223372036854775807n — SQL literal only in overlap trigger.
  EOD bundle: bun run eod:archive (WAL flush before tar.gz).

Options:
  --path <file>     Append-only JSONL (default: ${SPORTSDESK_INGESTION_LOG_DEFAULT})
  --pull-raw [url]  Fetch raw JSONL from feed source, then replay (see env below)
  --pull-raw-only   With --pull-raw: write bytes only (no replay)
  --channel <code>  Lane for per-channel feed URL (Internet, GSLIVE, …)
  --markdown        Pattern table: raw file with --out, else Bun.markdown ANSI
  --out <file>      Pull destination (--pull-raw) or raw markdown (--markdown)
  Feed URL order: --pull-raw URL > SPORTSDESK_FEED_URL_<LANE> > SPORTSDESK_INGESTION_FEED_URL > R2 public
  Pull writes <path>.provenance.json (sha256, etag, JSONL drain counts, prior divergence).
  --require-clean-feed   Exit 1 if pulled bytes fail JSONL drain (corrupt / trailing partial)
  --fail-on-divergence   Exit 1 if sha256 differs from previous file at destination
  --json            Machine-readable summary on stdout
  --bitemporal      Require v_to on each non-DROPPED row (CHECK always enforces v_to > v_t)
  --no-verify-xml-golden   Skip xml_golden_ast_sha256 checks on JSONL rows
  --strict-xml-golden      Require pin on every row that includes xml
  --expected-bun <ver>     Fail replay when logged bun_version differs (with pins)
  -h, --help        This help

Transaction axis: business key is (channel_id, id) — ids are per-lane, not global.
  A later JSONL line with the same channel + id closes the prior open row (tx_to) then
  inserts the correction.   At most one open tx row per (channel_id, id) (UNIQUE index). Replay assumes a
  single writer; concurrent live corrections need re-read-and-retry (not modeled here).
  Without duplicate keys, replay is valid-time + current tx snapshot only.

Exit codes:
  0  success
  1  replay input corrupt
  2  transaction failure
  3  SLA violation
  4  XML golden issue — AST drift, version pin mismatch, or missing pin
     (see [XML-GOLDEN] output for which)
Precedence: corrupt > tx-axis > SLA > xml golden.
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return 0;
  }

  let path = resolve(import.meta.dir, "..", SPORTSDESK_INGESTION_LOG_DEFAULT);
  let markdown = false;
  let outPath: string | undefined;
  let json = false;
  let bitemporal = false;
  let pullRaw = false;
  let pullRawOnly = false;
  let pullRawUrl: string | undefined;
  let channelCode: SignalChannelCode | undefined;
  let requireCleanFeed = false;
  let failOnDivergence = false;
  let verifyXmlGolden = true;
  let strictXmlGolden = false;
  let expectedBun: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path" && args[i + 1]) {
      path = resolve(args[++i]!);
    } else if (a === "--out" && args[i + 1]) {
      outPath = resolve(args[++i]!);
    } else if (a === "--pull-raw") {
      pullRaw = true;
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        pullRawUrl = args[++i];
      }
    } else if (a === "--pull-raw-only") pullRawOnly = true;
    else if (a === "--channel" && args[i + 1]) {
      const ch = args[++i]!;
      if (isSignalChannelCode(ch)) channelCode = ch;
      else {
        console.error(`Unknown channel code: ${ch}`);
        return 1;
      }
    } else if (a === "--require-clean-feed") requireCleanFeed = true;
    else if (a === "--fail-on-divergence") failOnDivergence = true;
    else if (a === "--markdown") markdown = true;
    else if (a === "--json") json = true;
    else if (a === "--bitemporal") bitemporal = true;
    else if (a === "--no-verify-xml-golden") verifyXmlGolden = false;
    else if (a === "--strict-xml-golden") strictXmlGolden = true;
    else if (a === "--expected-bun" && args[i + 1]) {
      expectedBun = args[++i]!;
    }
  }

  let feedProvenance:
    | Awaited<ReturnType<typeof pullIngestionFeedWithProvenance>>["provenance"]
    | undefined;

  if (pullRaw || pullRawOnly) {
    const dest = outPath ?? path;
    try {
      const pulled = await pullIngestionFeedWithProvenance(dest, {
        ...(pullRawUrl !== undefined ? { url: pullRawUrl } : {}),
        ...(channelCode !== undefined ? { channelCode } : {}),
      });
      feedProvenance = pulled.provenance;
      path = pulled.path;
      const feedExit = ingestionFeedPullExitCode(pulled.provenance, {
        failOnDivergence,
      });
      if (!json) {
        const p = pulled.provenance;
        console.warn(
          `[FEED] ${p.byteLength} bytes sha256=${p.sha256Hex.slice(0, 12)}… records=${p.jsonl.recordCount} corrupt=${p.jsonl.corruptedLineSkips}\n       ← ${p.source.label}\n       ${p.source.url}`,
        );
        if (p.divergedFromPrior) {
          console.warn(
            `[FEED] diverged from prior sha256 ${p.priorSha256Hex?.slice(0, 12)}…`,
          );
        }
        console.warn(`[FEED] provenance: ${p.sidecarPath}`);
      }
      if (pullRawOnly) {
        if (!json) {
          console.log(`Wrote raw ingestion feed: ${path}`);
        } else {
          console.log(
            JSON.stringify({ path, provenance: pulled.provenance }, null, 2),
          );
        }
        if (requireCleanFeed || failOnDivergence) {
          return feedExit;
        }
        return 0;
      }
      if (requireCleanFeed && feedExit !== 0) {
        return feedExit;
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      return 1;
    }
  }

  if (!(await Bun.file(path).exists())) {
    console.error(`Missing log: ${path}`);
    return 1;
  }

  const result = await replaySportsdeskIngestionLog({
    path,
    bitemporal,
    verifyXmlGoldenAst: verifyXmlGolden,
    strictXmlGoldenPins: strictXmlGolden,
    ...(expectedBun !== undefined ? { expectedBunVersion: expectedBun } : {}),
    onXmlGoldenAstFailure(message) {
      if (!json) {
        console.warn(`\x1b[31m${message}\x1b[0m`);
      }
    },
    onCorruptedLine(byteOffset, message) {
      if (!json) {
        console.warn(
          `\x1b[33m[CORRUPTION]\x1b[0m byte ~${byteOffset}: ${message}`,
        );
      }
    },
    onLatencyViolation({ channelCode, latencyMs, slaMs }) {
      warnLatencySla(channelCode, latencyMs, slaMs);
    },
    onTxAxisViolation({ channelCode, id, txTo, message }) {
      console.warn(
        `\x1b[31m[TX]\x1b[0m ${channelCode} id ${id} tx_to=${txTo}: ${message}`,
      );
    },
  });

  if (!json) {
    printDroppedSummary(result.droppedByChannel);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          path,
          recordCount: result.recordCount,
          corruptedLineSkips: result.corruptedLineSkips,
          trailingPartialBytes: result.trailingPartialBytes,
          skippedInserts: result.skippedInserts,
          droppedChannelSkips: result.droppedChannelSkips,
          droppedByChannel: result.droppedByChannel,
          latencyViolationsSeen: result.latencyViolationsSeen,
          latencyViolationsAccepted: result.latencyViolationsAccepted,
          transactionSupersedes: result.transactionSupersedes,
          txAxisViolations: result.txAxisViolations,
          xmlGoldenAst: result.xmlGoldenAst,
          physicalRowCount: result.physicalRowCount,
          currentRowCount: result.currentRowCount,
          feedProvenance: feedProvenance ?? null,
          trades: result.trades,
        },
        null,
        2,
      ),
    );
    return replayIngestionExitCode(result);
  }

  console.log(
    `Replay: ${result.recordCount} JSONL values | ${result.trades.length} trades loaded | corrupt ${result.corruptedLineSkips} | dropped ${result.droppedChannelSkips} | SLA seen ${result.latencyViolationsSeen} accepted ${result.latencyViolationsAccepted} | insert skips ${result.skippedInserts}`,
  );

  if (result.trades.length > 0) {
    if (markdown) {
      const md = renderSportsdeskPatternMarkdown(result.trades);
      if (outPath) {
        await Bun.write(outPath, md);
        console.log(`Wrote markdown: ${outPath}`);
      } else {
        Bun.stdout.write(renderSportsdeskPatternAnsi(md));
        Bun.stdout.write("\n");
      }
    } else {
      Bun.stdout.write(formatSportsdeskReplayTradesTable(result.trades));
    }
  }

  return replayIngestionExitCode(result);
}

if (import.meta.main) {
  process.exitCode = await main();
}
