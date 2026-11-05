#!/usr/bin/env bun
/**
 * @file scripts/capture/har_probe.ts
 * @description Probe the F402 report and manager.html boot reads with cookies (and bearer token) from a HAR — no browser.
 *
 * The WebView path is the only way to read an HttpOnly session that was never exported, but a HAR
 * is enough to replay it, and unlike WebView this runs headless in CI. Supports Bun 1.4.4's
 * per-request `protocol` option (`"http1.1" | "http2" | "http3"`), `--suite <report|manager-boot|all>`,
 * automatic `application/json` serialization for `getAccountInfoOwner` and `getDailyFiguresByCustomer`,
 * and `lib/blob_ingest.ts` (`inspectBlobSource` + `buildCaptureRecordFromBlob`) for unified `Blob`
 * extraction and optional `--promote-dir` promotion into `CaptureStore`.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCaptureRecordFromBlob,
  inspectBlobSource,
} from "../../lib/blob_ingest.ts";
import { provenanceFromWireFetch } from "./provenance_helpers.ts";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import {
  bearerFromHar,
  cookiesFromHar,
  cookieHeaderFrom,
} from "../../lib/cookie_jar.ts";
import {
  PROBE_PREFIXES,
  type ProbeSuite,
  type ProbeWireContentType,
  buildJsonProbeBody,
  buildProbeBody,
  parseProbePageResult,
  probeSummary,
  probeUrl,
  selectProbeOps,
} from "../../lib/f402_probe.ts";
import { preflight } from "../../lib/preflight.ts";
import { htmlToText } from "../../lib/ticket_html.ts";
import { CaptureStore } from "./recorder.ts";

const VALUE_FLAGS = [
  "--har",
  "--base",
  "--suite",
  "--prefix",
  "--protocol",
  "--out",
  "--promote-dir",
  "--ops",
  "--agent-id",
  "--customer-id",
] as const;

const HELP = `
capture:har — probe the F402 report and manager.html boot reads with cookies from a HAR (no browser)

Options:
  --har <path>            HAR file to read cookies from (required)
  --base <url>            Portal origin (default: F402_BASE_URL or https://fantasy402.com)
  --suite <name>          report (default) | manager-boot (9 v1.0.280 boot ops) | all
  --prefix <path>         Route prefix (default: /cloud/api/Manager)
  --protocol <proto>      http1.1 | h1 | http2 | h2 | http3 | h3 (per-request fetch protocol)
  --ops <a,b>             Only these operations (searches across report + manager-boot ops)
  --json-body             Force application/json request serialization
  --agent-id <id>         Manager agent id for the request body (default: F402_AGENT_ID)
  --customer-id <id>      Customer id for the request body (default: F402_CUSTOMER_ID)
  --out <dir>             Probe output root (default: scratch/f402-probes)
  --promote-dir <dir>     Write value-free CaptureStore records for 2xx read-only probes
  --dry-run               Print what would be sent; make no requests
  --no-preflight          Skip the DNS/TLS preflight
  --include-unconfirmed   Include unconfirmed ops (PendingDelete, Get_LeagueLines2)
  -h, --help              This text

Examples:
  bun run capture:har --har scratch/fantasy402.har --dry-run
  bun run capture:har --har scratch/fantasy402.har --suite manager-boot --protocol http2
  bun run capture:har --har scratch/fantasy402.har --prefix /cloud/api/Report \\
    --agent-id 118 --customer-id 12345 --promote-dir docs/evidence/captures

The HAR must contain a request to the target host with a Cookie header (or Set-Cookie response).
Values are never printed; only cookie names are recorded.
`.trim();

type FetchProtocol = "http1.1" | "h1" | "http2" | "h2" | "http3" | "h3";

const VALID_PROTOCOLS = new Set<FetchProtocol>([
  "http1.1",
  "h1",
  "http2",
  "h2",
  "http3",
  "h3",
]);

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: VALUE_FLAGS,
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    return 0;
  }

  const harPath = flagValue(parsed, "--har", "");
  const base = flagValue(
    parsed,
    "--base",
    Bun.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
  );
  const suiteRaw = flagValue(parsed, "--suite", "").toLowerCase();
  const prefix = flagValue(parsed, "--prefix", PROBE_PREFIXES[0]!);
  const protocolRaw = flagValue(parsed, "--protocol", "").toLowerCase();
  if (
    protocolRaw !== "" &&
    !VALID_PROTOCOLS.has(protocolRaw as FetchProtocol)
  ) {
    console.error(
      `capture:har: invalid --protocol "${protocolRaw}". Valid: ${[...VALID_PROTOCOLS].join(", ")}`,
    );
    process.exit(2);
  }
  const protocol: FetchProtocol | undefined =
    protocolRaw === "" ? undefined : (protocolRaw as FetchProtocol);
  const outRoot = flagValue(parsed, "--out", "scratch/f402-probes");
  const promoteDir = flagValue(parsed, "--promote-dir", "");
  const customerId = flagValue(
    parsed,
    "--customer-id",
    Bun.env.F402_CUSTOMER_ID?.trim() ?? "",
  );
  const agentId = flagValue(
    parsed,
    "--agent-id",
    Bun.env.F402_AGENT_ID?.trim() ?? "",
  );
  const opsArg = flagValue(parsed, "--ops", "");
  const forceJsonBody = hasFlag(parsed, "--json-body");
  const includeUnconfirmed = hasFlag(parsed, "--include-unconfirmed");
  const dryRun = hasFlag(parsed, "--dry-run");

  if (harPath === "") {
    console.error("capture:har: --har is required.");
    console.error(
      "  bun run capture:har --har scratch/fantasy402.har --ops Pending",
    );
    return 2;
  }

  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    console.error(`capture:har: --base is not a valid URL: ${base}`);
    process.exit(2);
  }

  let har: unknown;
  try {
    har = await Bun.file(harPath).json();
  } catch (error) {
    console.error(
      `capture:har: could not read HAR file ${harPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  const cookies = cookiesFromHar(har, host);
  const bearer = bearerFromHar(har, host);
  if (cookies.length === 0) {
    console.error(`capture:har: no Cookie header for ${host} in ${harPath}.`);
    console.error("  Export a HAR while signed in to the portal, then retry.");
    return 2;
  }
  const cookieHeader = cookieHeaderFrom(
    cookies.map((cookie) => [cookie.name, cookie.value] as const),
  );

  const suite: ProbeSuite =
    suiteRaw === "manager-boot" || suiteRaw === "all"
      ? suiteRaw
      : opsArg !== ""
        ? "all"
        : "report";

  const selected = selectProbeOps(includeUnconfirmed, suite);
  const wanted =
    opsArg === ""
      ? null
      : new Set(opsArg.split(",").map((name) => name.trim()));
  const ops =
    wanted === null
      ? selected
      : selected.filter((op) => wanted.has(op.operation));
  if (ops.length === 0) {
    console.error(
      `capture:har: --ops matched nothing. Available: ${selected.map((op) => op.operation).join(", ")}`,
    );
    return 2;
  }

  const contentTypeFor = (op: (typeof ops)[number]): ProbeWireContentType =>
    forceJsonBody
      ? "application/json"
      : (op.wireContentType ??
        "application/x-www-form-urlencoded; charset=UTF-8");

  const bodyFor = (op: (typeof ops)[number]): string => {
    if (agentId === "") return "";
    return contentTypeFor(op) === "application/json"
      ? buildJsonProbeBody(op, agentId, customerId)
      : buildProbeBody(op, agentId, customerId);
  };

  if (dryRun) {
    console.error(
      `capture:har: ${host} · suite: ${suite} · ${cookies.length} cookie(s): ${cookies.map((cookie) => cookie.name).join(", ")}${bearer ? " · bearer: present" : ""}${protocol ? ` · protocol: ${protocol}` : ""}`,
    );
    for (const op of ops) {
      console.log(
        `${op.operation.padEnd(30)} POST ${probeUrl(base, op, prefix)}  contentType=${contentTypeFor(op)}  body=${bodyFor(op)}`,
      );
    }
    console.error("capture:har: dry run; no requests made");
    return 0;
  }

  let tls: Awaited<ReturnType<typeof preflight>>["tls"] = null;
  if (!hasFlag(parsed, "--no-preflight")) {
    const check = await preflight(host);
    if (!check.ok) {
      console.error(`capture:har: ${check.error ?? "preflight failed"}`);
      console.error("  bun run capture:preflight --host " + host);
      return 1;
    }
    tls = check.tls;
    console.error(
      `capture:har: preflight ok · ${check.dns.length} address(es) · ${check.tls?.tlsVersion ?? "?"}`,
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(outRoot, stamp);
  await mkdir(outDir, { recursive: true });
  await Bun.write(
    join(outDir, "run.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        kind: "probe-run",
        startedAt: new Date().toISOString(),
        base,
        suite,
        prefix,
        ...(protocol === undefined ? {} : { protocol }),
        authMode: "har-cookie",
        tls,
        ops: ops.map((op) => op.operation),
      },
      null,
      2,
    )}\n`,
  );

  const promoteStore =
    promoteDir !== "" ? new CaptureStore({ root: promoteDir }) : null;
  let promotedCount = 0;
  let transportErrors = 0;

  for (const op of ops) {
    const url = probeUrl(base, op, prefix);
    const reqContentType = contentTypeFor(op);
    const body = bodyFor(op);
    try {
      const requestHeaders: Record<string, string> = {
        cookie: cookieHeader,
        ...(bearer === null ? {} : { authorization: bearer }),
        "content-type": reqContentType,
        "x-requested-with": "XMLHttpRequest",
      };
      const init: RequestInit & { protocol?: FetchProtocol } = {
        method: "POST",
        headers: requestHeaders,
        body,
        redirect: "manual",
        ...(protocol === undefined ? {} : { protocol }),
      };
      const response = await fetch(url, init);
      const inspected = await inspectBlobSource(
        response,
        response.headers.get("content-type") ?? "application/octet-stream",
      );
      const text = await inspected.blob.text();
      const capturedAt = new Date().toISOString();
      const cfRay = response.headers.get("cf-ray") ?? undefined;
      const result = parseProbePageResult({
        status: response.status,
        contentType: inspected.mimeType,
        bytes: inspected.size,
        preview: text.slice(0, 2_000),
        ...(cfRay ? { cfRay } : {}),
      });
      const record = {
        schemaVersion: 1,
        kind: "har-probe",
        capturedAt,
        operation: op.operation,
        url,
        method: op.method,
        requestContentType: reqContentType,
        body,
        ...(protocol === undefined ? {} : { protocol }),
        authMode: "har-cookie",
        readOnlyConfirmed: op.readOnly,
        headersObserved: true,
        cfRay: cfRay ?? null,
        cookieNames: cookies.map((cookie) => cookie.name),
        bearerObserved: bearer !== null,
        responseBodySha256: inspected.sha256,
        result,
        extractedText: result.contentType.includes("text/html")
          ? htmlToText(result.preview).slice(0, 2_000)
          : null,
        note: op.note,
      };
      await Bun.write(
        join(outDir, `${op.operation}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );

      if (
        promoteStore !== null &&
        op.readOnly &&
        result.status >= 200 &&
        result.status <= 299
      ) {
        const opPath = `${prefix.replace(/\/$/, "")}/${op.operation}`;
        const captureRecord = await buildCaptureRecordFromBlob({
          mode: "live",
          capturedAt,
          operation: {
            path: opPath,
            method: "POST",
          },
          request: {
            url,
            method: "POST",
            headers: requestHeaders,
            contentType: reqContentType,
            body,
          },
          response: {
            source: inspected.blob,
            status: response.status,
            headers: { "content-type": inspected.mimeType },
            contentType: inspected.mimeType,
            wireBytes: inspected.size,
          },
          provenance: provenanceFromWireFetch(
            {
              portalHost: host,
              bunVersion: Bun.version,
              headersObserved: true,
            },
            result,
            response.headers,
          ),
          samples: 1,
        });
        await promoteStore.write(captureRecord);
        promotedCount += 1;
      }

      const summary = probeSummary(op, result);
      console.log(
        `${summary.operation.padEnd(30)} ${String(summary.status).padEnd(5)} ${summary.verdict.padEnd(8)} ${summary.bytes} B`,
      );
    } catch (error) {
      transportErrors += 1;
      console.error(`${op.operation}: ${(error as Error).message}`);
    }
  }

  if (promoteStore !== null && promotedCount > 0) {
    await promoteStore.finalize();
    console.error(
      `capture:har: promoted ${promotedCount} 2xx capture(s) into ${promoteDir}`,
    );
  }

  console.error(
    `capture:har: wrote ${ops.length - transportErrors} probe(s) to ${outDir}`,
  );
  return transportErrors > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
