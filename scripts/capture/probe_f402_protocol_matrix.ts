#!/usr/bin/env bun
/**
 * One login; sweep API prefixes (Manager / Report / System) and record status + TLS ALPN.
 *
 *   bun run capture:probe-protocol-matrix
 *   bun run capture:probe-protocol-matrix --customer TACO217
 *
 * The rows come from in-page fetch, so the browser picks their HTTP version; the network flags
 * steer only the Bun-side preflight (DNS, TLS and its ALPN).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

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
import {
  applyHostOverride,
  F402_NET_ARG_OPTIONS,
  F402_NET_USAGE,
  F402NetOptionsError,
  f402NetReport,
  relaunchForBunNetworkEnv,
  resolveF402NetOptions,
} from "../../lib/f402_net_options.ts";
import {
  F402PullerError,
  resolvePullBaseUrl,
} from "../../lib/f402_readonly_puller.ts";
import { preflight, prefetchDns } from "../../lib/preflight.ts";
import { buildDnsPrefetchExpression } from "../../lib/f402_report_context.ts";
import { resolveAgentId } from "./f402_probe.ts";
import { loginF402 } from "./f402_login.ts";
import { ManagedWebView } from "./webview.ts";

const root = join(import.meta.dir, "../..");

export const PROBE_USAGE = `Usage: bun run capture:probe-protocol-matrix [options]

  --base-url <url>         https portal origin (default: F402_BASE_URL or https://www.fantasy402.com); --base is an alias
  --customer <id>          Customer for the report context (default: TACO217)
  --backend <webkit|chrome>
  --profile <dir>          WebView profile (default: scratch/webview-profile)
  --out <dir>              Output root (default: scratch/f402-probes)

${F402_NET_USAGE}`;

export class ProbeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeUsageError";
  }
}

export function parseProbeArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = Bun.env,
) {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "base-url": { type: "string" },
        base: { type: "string" },
        customer: { type: "string" },
        backend: { type: "string" },
        profile: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", default: false },
        ...F402_NET_ARG_OPTIONS,
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ProbeUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const baseFlag = values["base-url"] ?? values.base;
  if (values["base-url"] !== undefined && values.base !== undefined) {
    throw new ProbeUsageError("pass --base-url or --base, not both");
  }
  const backendRaw = String(values.backend ?? "webkit").trim();
  if (backendRaw !== "webkit" && backendRaw !== "chrome") {
    throw new ProbeUsageError(
      `--backend must be webkit or chrome, got ${JSON.stringify(backendRaw)}`,
    );
  }
  const net = resolveF402NetOptions(values, env);
  const base = applyHostOverride(
    resolvePullBaseUrl(
      typeof baseFlag === "string" ? baseFlag : undefined,
      env,
    ),
    net.host,
  );
  return {
    help: values.help === true,
    base,
    customer: String(values.customer ?? "TACO217").trim(),
    backend: backendRaw as "webkit" | "chrome",
    profile: String(values.profile ?? "scratch/webview-profile"),
    outRoot: String(values.out ?? "scratch/f402-probes"),
    net,
  };
}

function findOp(name: string) {
  const op = PROBE_OPS.find((row) => row.operation === name);
  if (!op) throw new Error(`unknown operation ${name}`);
  return op;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { help, base, customer, backend, profile, outRoot, net } =
    parseProbeArgs(argv);
  if (help) {
    console.log(PROBE_USAGE);
    return 0;
  }
  const relaunched = await relaunchForBunNetworkEnv(net);
  if (relaunched !== null) return relaunched;

  const baseParsed = new URL(base);
  const warmed = {
    host: baseParsed.hostname,
    port: baseParsed.port === "" ? 443 : Number(baseParsed.port),
  };
  if (net.dnsPrefetch) prefetchDns(warmed.host, warmed.port);
  const pf = await preflight(warmed.host, {
    port: warmed.port,
    timeoutMs: 10_000,
    skipDnsPrefetch: true,
    ...(net.family === "auto" ? {} : { family: Number(net.family) as 4 | 6 }),
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
  if (net.dnsPrefetch) await view.evaluate(buildDnsPrefetchExpression(base));
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
      dnsPrefetched: net.dnsPrefetch,
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
    network: f402NetReport(net),
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
  if (net.verbose) console.error(JSON.stringify(f402NetReport(net)));
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
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    if (
      error instanceof ProbeUsageError ||
      error instanceof F402NetOptionsError ||
      (error instanceof F402PullerError && error.code === "config")
    ) {
      console.error(`capture:protocol-matrix: ${error.message}`);
      console.error(PROBE_USAGE);
      process.exit(2);
    }
    throw error;
  }
}
