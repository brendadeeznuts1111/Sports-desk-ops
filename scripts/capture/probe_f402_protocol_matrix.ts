#!/usr/bin/env bun
/**
 * One login; sweep API prefixes (Manager / Report / System) and record status + TLS ALPN.
 *
 *   bun run capture:probe-protocol-matrix
 *   bun run capture:probe-protocol-matrix --customer TACO217
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  buildApiPrefixMatrixExpression,
  F402_API_PREFIXES,
  F402_FORM_WIRE_CONTENT_TYPE,
  redactedRequestHeaderProtocolVariants,
} from "../../lib/f402_in_page_fetch.ts";
import { buildProbeBody, PROBE_OPS } from "../../lib/f402_probe.ts";
import { acquireProfileLock } from "../../lib/f402_profile_lock.ts";
import {
  buildReportCustomerContextExpression,
  reportCustomerContextUrl,
} from "../../lib/f402_report_context.ts";
import { preflight, warmCaptureNetwork } from "../../lib/preflight.ts";
import { buildDnsPrefetchExpression } from "../../lib/f402_report_context.ts";
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

const base = flag(
  "--base",
  process.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
);
const customer = flag("--customer", "TACO217").trim();
const backend = flag("--backend", "webkit") === "chrome" ? "chrome" : "webkit";
const profile = flag("--profile", "scratch/webview-profile");
const outRoot = flag("--out", "scratch/f402-probes");

function findOp(name: string) {
  const op = PROBE_OPS.find((row) => row.operation === name);
  if (!op) throw new Error(`unknown operation ${name}`);
  return op;
}

export async function main(): Promise<number> {
  const warmed = warmCaptureNetwork(base);
  const pf = await preflight(warmed.host, {
    port: warmed.port,
    timeoutMs: 10_000,
    skipDnsPrefetch: true,
  });
  if (!pf.ok) {
    console.error(`capture:protocol-matrix: preflight failed: ${pf.error}`);
    return 1;
  }

  const deletedOp = findOp("getDeletedTransactionHistory");
  const pendingOp = findOp("PendingDelete");
  let agentId = await resolveAgentId();

  const matrixItems = [
    ...F402_API_PREFIXES.map((prefix) => ({
      prefix,
      operation: deletedOp.operation,
      body: buildProbeBody(deletedOp, agentId || "AGENT", customer),
    })),
    ...F402_API_PREFIXES.map((prefix) => ({
      prefix,
      operation: pendingOp.operation,
      body: buildProbeBody(pendingOp, agentId || "AGENT", customer, {
        ticketNumber: "1072221007",
      }),
    })),
  ];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(root, outRoot, `protocol-matrix-${stamp}`);
  await mkdir(outDir, { recursive: true });

  // Fails fast when another capture still holds this Chrome profile.
  using _lock =
    profile.trim() === "" ? null : acquireProfileLock(join(root, profile));

  await using view = ManagedWebView.launch({
    backend,
    dataStoreDir: join(root, profile),
    width: 1440,
    height: 900,
  });

  const outcome = await loginF402(view, {
    baseUrl: base,
    timeoutMs: 180_000,
    loginKind: "agent",
  });
  if (agentId === "" && outcome.agentId !== "") agentId = outcome.agentId;

  await Bun.sleep(250);
  await view.evaluate(buildDnsPrefetchExpression(base));
  await view.navigate(reportCustomerContextUrl(base, customer));
  await view.waitForLoad();
  await view.evaluate(buildReportCustomerContextExpression(customer));

  const raw = await view.evaluate(
    buildApiPrefixMatrixExpression(
      base,
      matrixItems,
      F402_FORM_WIRE_CONTENT_TYPE,
    ),
  );

  const rows = Array.isArray(raw) ? raw : [];
  const summary = {
    schemaVersion: 1,
    kind: "protocol-matrix",
    capturedAt: new Date().toISOString(),
    base,
    customer,
    networkWarm: {
      host: warmed.host,
      port: warmed.port,
      dnsPrefetched: true,
      dns: pf.dns,
      dnsCacheStats: pf.dnsCacheStats ?? null,
      tls: pf.tls
        ? {
            tlsVersion: pf.tls.tlsVersion,
            alpn: pf.tls.alpn,
            cipher: pf.tls.cipher.name,
          }
        : null,
    },
    requestHeaderProtocols: redactedRequestHeaderProtocolVariants({
      baseUrl: base,
      path: "/cloud/api/Manager/getDeletedTransactionHistory",
      contentType: F402_FORM_WIRE_CONTENT_TYPE,
      tokenPresent: true,
    }),
    rows,
  };

  await Bun.write(
    join(outDir, "protocol-matrix.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      { outDir, rowCount: rows.length, tlsAlpn: pf.tls?.alpn },
      null,
      2,
    ),
  );
  for (const row of rows as Array<Record<string, unknown>>) {
    console.log(
      `${String(row.prefix).padEnd(22)} ${String(row.operation).padEnd(28)} ${row.status} ${row.bytes}B`,
    );
  }

  const ok = rows.some(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      (r as { status?: number }).status === 200,
  );
  return ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
