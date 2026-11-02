#!/usr/bin/env bun
/**
 * One WebView login; batch PendingDelete per customer via in-page fetch loop.
 *
 *   bun run capture:batch-pending-delete --limit 92
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { DeletedWagerTicketTarget } from "../../lib/f402_deleted_wager_list.ts";
import {
  F402_FORM_WIRE_CONTENT_TYPE,
  redactedDevToolsRequestHeaders,
  redactedInPageRequestHeaders,
  redactedRequestHeaderProtocolVariants,
} from "../../lib/f402_in_page_fetch.ts";
import {
  buildBatchPendingDeleteExpression,
  buildPendingDeleteBodies,
  countPendingInResponseText,
  parsePendingDeleteBatchRows,
  pendingDeleteProbeOp,
  redactPendingDeletePreview,
} from "../../lib/f402_pending_delete_batch.ts";
import { probeUrl } from "../../lib/f402_probe.ts";
import { acquireProfileLock } from "../../lib/f402_profile_lock.ts";
import { preflight, warmCaptureNetwork } from "../../lib/preflight.ts";
import {
  buildDnsPrefetchExpression,
  buildReportCustomerContextExpression,
  reportCustomerContextUrl,
} from "../../lib/f402_report_context.ts";
import { resolveAgentId } from "./f402_probe.ts";
import { loginF402 } from "./f402_login.ts";
import { ManagedWebView } from "./webview.ts";

const root = join(import.meta.dir, "../..");
const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

const targetsPath = flag(
  "--targets",
  "scratch/f402-deleted-wagers/probe-targets.json",
);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx === -1 ? 9999 : Number(args[limitIdx + 1] ?? "9999");
const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : 9999;
const outRoot = flag("--out", "scratch/f402-probes");
const backend = flag("--backend", "webkit") === "chrome" ? "chrome" : "webkit";
const profile = flag("--profile", "scratch/webview-profile");
const prefix = flag("--prefix", "/cloud/api/Report");
const base = flag(
  "--base",
  process.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
);

interface TargetsFile {
  targets: DeletedWagerTicketTarget[];
}

export interface BatchPendingDeleteRowResult {
  customerId: string;
  ticketNumber: string;
  status: number;
  pendingCount: number;
  bytes: number;
  error?: string;
}

function groupByCustomer(
  targets: DeletedWagerTicketTarget[],
): Map<string, DeletedWagerTicketTarget[]> {
  const map = new Map<string, DeletedWagerTicketTarget[]>();
  for (const t of targets) {
    const cid = t.customerId.trim();
    const list = map.get(cid) ?? [];
    list.push(t);
    map.set(cid, list);
  }
  return map;
}

export async function runBatchPendingDeleteSession(options?: {
  targets?: DeletedWagerTicketTarget[];
  outDir?: string;
}): Promise<{
  results: BatchPendingDeleteRowResult[];
  outDir: string;
  ms: number;
}> {
  const t0 = Bun.nanoseconds();
  const targetsFile = (await Bun.file(
    join(root, targetsPath),
  ).json()) as TargetsFile;
  const targets =
    options?.targets ?? targetsFile.targets.slice(0, effectiveLimit);

  let agentId = await resolveAgentId();
  const op = pendingDeleteProbeOp();
  const url = probeUrl(base, op, prefix);
  const grouped = groupByCustomer(targets);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = options?.outDir ?? join(root, outRoot, `batch-${stamp}`);
  await mkdir(outDir, { recursive: true });

  const warmed = warmCaptureNetwork(base);
  const networkPreflight = await preflight(warmed.host, {
    port: warmed.port,
    skipDnsPrefetch: true,
  });
  if (!networkPreflight.ok) {
    throw new Error(networkPreflight.error ?? "preflight failed");
  }

  const results: BatchPendingDeleteRowResult[] = [];

  // Fails fast when another capture still holds this Chrome profile.
  using _lock =
    profile.trim() === "" ? null : acquireProfileLock(join(root, profile));

  await using view = ManagedWebView.launch({
    backend,
    dataStoreDir: join(root, profile),
    width: 1440,
    height: 900,
  });

  const loginWaitMs = 180_000;
  const outcome = await loginF402(view, {
    baseUrl: base,
    timeoutMs: loginWaitMs,
    loginKind: "agent",
  });
  if (agentId === "" && outcome.agentId !== "") agentId = outcome.agentId;
  if (agentId === "") {
    throw new Error("batch PendingDelete: missing agent id after login");
  }

  console.error(
    `capture:batch-pending-delete: signed in on ${backend}; dns prefetch ${warmed.host}:${warmed.port}; ${targets.length} tickets in ${grouped.size} customer group(s)`,
  );
  await view.evaluate(buildDnsPrefetchExpression(base));

  let groupIndex = 0;
  for (const [customerId, group] of grouped) {
    groupIndex++;
    const tickets = group.map((t) => t.ticketNumber.trim());
    console.error(
      `capture:batch-pending-delete: customer ${groupIndex}/${grouped.size} ${customerId} (${tickets.length} tickets)`,
    );

    await Bun.sleep(250);
    const ctxUrl = reportCustomerContextUrl(base, customerId);
    await view.navigate(ctxUrl);
    await view.waitForLoad();
    await view.evaluate(buildReportCustomerContextExpression(customerId));

    const items = buildPendingDeleteBodies(agentId, customerId, tickets);
    const wireContentType = op.wireContentType ?? F402_FORM_WIRE_CONTENT_TYPE;
    const raw = await view.evaluate(
      buildBatchPendingDeleteExpression(url, items, wireContentType),
    );

    let rows;
    try {
      rows = parsePendingDeleteBatchRows(raw);
    } catch (error) {
      for (const ticket of tickets) {
        results.push({
          customerId,
          ticketNumber: ticket,
          status: 0,
          pendingCount: 0,
          bytes: 0,
          error:
            error instanceof Error
              ? error.message
              : "batch evaluate parse failed",
        });
      }
      continue;
    }

    const byTicket = new Map(rows.map((r) => [r.ticketNumber, r]));
    for (const ticket of tickets) {
      const row = byTicket.get(ticket);
      if (!row) {
        results.push({
          customerId,
          ticketNumber: ticket,
          status: 0,
          pendingCount: 0,
          bytes: 0,
          error: "missing row from batch evaluate",
        });
        continue;
      }
      const pendingCount = countPendingInResponseText(row.bodyText);
      results.push({
        customerId,
        ticketNumber: ticket,
        status: row.status,
        pendingCount,
        bytes: row.bytes,
        ...(row.status < 200 || row.status >= 300
          ? { error: `HTTP ${row.status}` }
          : {}),
      });

      await Bun.write(
        join(outDir, `PendingDelete-${customerId}-${ticket}.json`),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            kind: "webview-probe-batch",
            customerId,
            ticketNumber: ticket,
            url,
            method: "POST",
            requestContentType: wireContentType,
            requestHeadersExplicit: redactedInPageRequestHeaders(
              wireContentType,
              true,
            ),
            requestHeaders: redactedDevToolsRequestHeaders({
              baseUrl: base,
              path: `${prefix.replace(/\/$/, "")}/PendingDelete`,
              contentType: wireContentType,
              tokenPresent: true,
            }),
            requestHeaderProtocols: redactedRequestHeaderProtocolVariants({
              baseUrl: base,
              path: `${prefix.replace(/\/$/, "")}/PendingDelete`,
              contentType: wireContentType,
              tokenPresent: true,
            }),
            status: row.status,
            pendingCount,
            cfRay: row.cfRay ?? null,
            responseHeaders: row.responseHeaders ?? {},
            preview: redactPendingDeletePreview(row.bodyText.slice(0, 4_000)),
          },
          null,
          2,
        )}\n`,
      );
    }

    await Bun.sleep(150);
  }

  const ms = (Bun.nanoseconds() - t0) / 1e6;
  await Bun.write(
    join(outDir, "run.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "probe-batch-run",
        mode: "single-webview-pending-delete",
        startedAt: new Date().toISOString(),
        base,
        prefix,
        networkWarm: {
          host: warmed.host,
          port: warmed.port,
          dnsPrefetched: true,
          dns: networkPreflight.dns,
          tlsVersion: networkPreflight.tls?.tlsVersion ?? null,
          dnsCacheStats: networkPreflight.dnsCacheStats ?? null,
        },
        ticketCount: targets.length,
        customerGroups: grouped.size,
        ms,
      },
      null,
      2,
    )}\n`,
  );

  return { results, outDir, ms };
}

export async function main(): Promise<number> {
  const { results, outDir, ms } = await runBatchPendingDeleteSession();

  const withPending = results.filter((r) => r.pendingCount > 0);
  const emptyPending = results.filter(
    (r) =>
      !r.error && r.status >= 200 && r.status < 300 && r.pendingCount === 0,
  );
  const failed = results.filter(
    (r) => r.error || r.status < 200 || r.status >= 300,
  );

  const summary = {
    schemaVersion: 2,
    mode: "single-webview-pending-delete",
    capturedAt: new Date().toISOString(),
    ms,
    outDir,
    total: results.length,
    withPending: withPending.length,
    emptyPending: emptyPending.length,
    failed: failed.length,
    results,
    emptyPendingTickets: emptyPending.map((r) => ({
      customerId: r.customerId,
      ticketNumber: r.ticketNumber,
    })),
    errors: failed.map((r) => ({
      customerId: r.customerId,
      ticketNumber: r.ticketNumber,
      error: r.error ?? `HTTP ${r.status}`,
    })),
  };

  const outPath = join(
    root,
    "scratch/f402-deleted-wagers/batch-pending-delete-summary.json",
  );
  await Bun.write(outPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        total: summary.total,
        withPending: summary.withPending,
        emptyPending: summary.emptyPending,
        failed: summary.failed,
        ms: summary.ms,
        outDir: summary.outDir,
        outPath,
      },
      null,
      2,
    ),
  );

  return failed.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main());
}
