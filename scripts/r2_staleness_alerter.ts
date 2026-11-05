#!/usr/bin/env bun
/**
 * @file r2_staleness_alerter.ts
 * @description Thin runner for `lib/r2_staleness.ts`: HEAD each v1 bridge key on the public R2
 * URL, build a report, post one Telegram summary when anything is degraded, stay silent when
 * everything is fresh. Designed to run from a GitHub Actions scheduled workflow (every 15 min)
 * so the operator Mac being dead does not take the monitoring with it.
 *
 * The runner is the only I/O boundary — all SLA evaluation and formatting lives in the library
 * and is covered by unit tests. The runner only needs two secrets (`TELEGRAM_BOT_TOKEN`,
 * `TELEGRAM_CHAT_ID`); no R2 credentials are required because public-URL freshness is exactly
 * what every consumer sees anyway.
 *
 * Exit contract (deliberately NOT the same as "did we post a message"):
 *   0 — all targets fresh (no post)
 *   1 — alerter itself failed (missing secrets, Telegram POST rejected)
 *   2 — at least one target degraded (post may or may not have been attempted, see logs)
 *
 * Usage:
 *   bun run scripts/r2_staleness_alerter.ts [--dry-run]
 *   bun run scripts/r2_staleness_alerter.ts --probe-only > probes.jsonl
 *
 * `--dry-run` skips the Telegram POST and prints the rendered message to stdout.
 * `--probe-only` emits one JSONL line per probe and exits 0; no SLA evaluation.
 */

import {
  ALERTER_EXIT,
  BRIDGE_STALENESS_TARGETS,
  buildReport,
  formatReport,
  parseLastModified,
  publicUrlFor,
  type AlerterExit,
  type StalenessProbe,
  type StalenessTarget,
} from "../lib/r2_staleness.ts";

interface RunnerOptions {
  readonly dryRun: boolean;
  readonly probeOnly: boolean;
  readonly perRequestTimeoutMs: number;
}

/** 10s per HEAD matches `agent-doctor` timeouts elsewhere in the repo. */
const DEFAULT_TIMEOUT_MS = 10_000;

function parseArgs(argv: readonly string[]): RunnerOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    probeOnly: argv.includes("--probe-only"),
    perRequestTimeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/**
 * HEAD one target. Catches every failure mode into `status: 0` with an `error` string so the
 * library gets a well-formed `StalenessProbe` and can decide the state uniformly.
 */
async function probeOne(
  target: StalenessTarget,
  timeoutMs: number,
): Promise<StalenessProbe> {
  const url = publicUrlFor(target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    const lastModifiedMs = parseLastModified(
      response.headers.get("last-modified"),
    );
    return {
      target,
      status: response.status,
      lastModifiedMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      target,
      status: 0,
      lastModifiedMs: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every target in parallel. */
async function probeAll(
  targets: readonly StalenessTarget[],
  timeoutMs: number,
): Promise<readonly StalenessProbe[]> {
  return Promise.all(targets.map((t) => probeOne(t, timeoutMs)));
}

/**
 * POST to Telegram with HTML parse mode. Returns `true` on `ok:true`, `false` on any other
 * outcome (network, non-200, parse_mode rejection). The caller decides what to do with
 * failure; we never throw.
 */
async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (response.ok && body.ok === true) {
      return { ok: true, detail: "sent" };
    }
    return {
      ok: false,
      detail: `telegram HTTP ${response.status} ${body.description ?? "(no description)"}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `telegram fetch threw: ${message}` };
  }
}

/** One JSONL line per run, for the GH Actions log and local `jq` greps. */
function logRunLine(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<AlerterExit> {
  const options = parseArgs(Bun.argv.slice(2));
  const nowMs = Date.now();

  const probes = await probeAll(
    BRIDGE_STALENESS_TARGETS,
    options.perRequestTimeoutMs,
  );

  if (options.probeOnly) {
    for (const probe of probes) {
      logRunLine({
        kind: "probe",
        key: probe.target.key,
        status: probe.status,
        lastModifiedMs: probe.lastModifiedMs,
        ...(probe.error === undefined ? {} : { error: probe.error }),
      });
    }
    return ALERTER_EXIT.allFresh;
  }

  const report = buildReport(probes, nowMs);
  const message = formatReport(report);

  logRunLine({
    kind: "report",
    observedAtMs: report.observedAtMs,
    degradedCount: report.degradedCount,
    verdicts: report.verdicts.map((v) => ({
      key: v.target.key,
      state: v.state,
      ageMs: v.ageMs,
      reason: v.reason,
    })),
  });

  if (report.degradedCount === 0) return ALERTER_EXIT.allFresh;

  if (options.dryRun) {
    process.stdout.write(`--- dry-run message ---\n${message}\n--- end ---\n`);
    return ALERTER_EXIT.degraded;
  }

  const botToken = Bun.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = Bun.env.TELEGRAM_CHAT_ID ?? "";
  if (botToken === "" || chatId === "") {
    logRunLine({
      kind: "alerter-error",
      detail:
        "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID; cannot send alert",
    });
    return ALERTER_EXIT.alerterError;
  }

  const send = await sendTelegram(botToken, chatId, message);
  logRunLine({ kind: "telegram", ...send });
  if (!send.ok) return ALERTER_EXIT.alerterError;
  return ALERTER_EXIT.degraded;
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
