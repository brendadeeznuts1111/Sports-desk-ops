#!/usr/bin/env bun
/**
 * Re-probe the pending-500 diagnostic set (Report + Manager prefixes) with cfRay capture.
 *
 * Requires keychain F402 credentials or F402_AGENT_ID / F402_PASSWORD.
 */
import { Glob } from "bun";
import { statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

const DEFAULT_REPORT_OPS = [
  "getDailyFiguresByCustomer",
  "getGradedWagerByCustomer",
  "getTicketDetailPrint",
] as const;

const opsFilterRaw = args.includes("--ops")
  ? (args[args.indexOf("--ops") + 1] ?? "")
  : "";
const REPORT_OPS: readonly string[] =
  opsFilterRaw.trim() === ""
    ? DEFAULT_REPORT_OPS
    : opsFilterRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
const backend = args.includes("--backend")
  ? (args[args.indexOf("--backend") + 1] ?? "webkit")
  : "webkit";
const promote = args.includes("--promote");
const promoteEdge = args.includes("--promote-edge");
const promoteTicket = args.includes("--promote-ticket");
const bothBackends = args.includes("--both-backends");
const fromDiscover = args.includes("--from-discover");
const reportOnly = args.includes("--report-only");
const root = join(import.meta.dir, "../..");

async function applyDiscoverEnv(): Promise<boolean> {
  const { discoverContextFromRoot } =
    await import("./load_discover_context.ts");
  const ctx = await discoverContextFromRoot(root);
  if (ctx === null) return false;
  Bun.env.F402_CUSTOMER_ID = ctx.customerId;
  if (ctx.ticketNumber !== "") Bun.env.F402_PROBE_TICKET = ctx.ticketNumber;
  if (ctx.wagerNumber !== "") Bun.env.F402_PROBE_WAGER = ctx.wagerNumber;
  if (ctx.flag !== undefined && ctx.flag !== "") {
    Bun.env.F402_PROBE_FLAG = ctx.flag;
  }
  console.error(
    `reprobe_pending_500s: discover context from ${ctx.discoverDir} (customer + ${ctx.ticketNumber !== "" ? "ticket sample" : "no ticket sample"})`,
  );
  return true;
}

if (fromDiscover || promoteTicket) {
  if (!(await applyDiscoverEnv())) {
    console.error(
      "reprobe_pending_500s: discover context missing (run capture:discover --login first)",
    );
    process.exit(2);
  }
}

const skipDiagnosticBatch =
  promoteTicket &&
  !fromDiscover &&
  !promote &&
  !promoteEdge &&
  opsFilterRaw.trim() === "";

function extraProbeArgs(): string[] {
  const out: string[] = [];
  const ticket = Bun.env.F402_PROBE_TICKET?.trim();
  const wager = Bun.env.F402_PROBE_WAGER?.trim();
  const flag = Bun.env.F402_PROBE_FLAG?.trim();
  if (ticket) out.push("--ticket", ticket);
  if (wager) out.push("--wager", wager);
  if (flag) out.push("--flag", flag);
  return out;
}

async function runBatch(
  label: string,
  prefix: string,
  ops: readonly string[],
  batchBackend: string,
): Promise<number> {
  console.error(
    `\nreprobe_pending_500s: ${label} (${prefix}) backend=${batchBackend}`,
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/capture/f402_probe.ts",
      "--login",
      "--no-screenshot",
      "--no-preflight",
      "--backend",
      batchBackend,
      "--prefix",
      prefix,
      "--ops",
      ops.join(","),
      "--jsonl",
      "--report-customer-context",
      ...extraProbeArgs(),
    ],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: Bun.env,
    },
  );
  return proc.exited;
}

async function latestScratchDir(root: string): Promise<string | null> {
  const glob = new Glob("scratch/f402-probes/2026-*");
  const dirs: string[] = [];
  for await (const rel of glob.scan({ cwd: root, onlyFiles: false })) {
    try {
      if (!statSync(join(root, rel)).isDirectory()) continue;
    } catch {
      continue; // broken symlink or raced deletion
    }
    dirs.push(rel);
  }
  dirs.sort();
  return dirs.length === 0 ? null : join(root, dirs[dirs.length - 1]!);
}

async function promoteFromLatestScratch(options: {
  opFile: string;
  allowNon2xx: boolean;
  promoteDir: string;
}): Promise<number> {
  const dir = await latestScratchDir(root);
  if (dir === null) {
    console.error("reprobe_pending_500s: no scratch probe dir found");
    return 1;
  }
  const probePath = join(dir, options.opFile);
  if (!(await Bun.file(probePath).exists())) {
    console.error(`reprobe_pending_500s: missing ${probePath}`);
    return 1;
  }
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/capture/f402_probe.ts",
      "--from-probes",
      probePath,
      "--promote-dir",
      options.promoteDir,
      ...(options.allowNon2xx ? ["--allow-non-2xx"] : []),
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  return proc.exited;
}

async function runPendingDeleteTicketProbe(
  batchBackend: string,
): Promise<number> {
  console.error(
    `\nreprobe_pending_500s: agent ticket read (Report/PendingDelete) backend=${batchBackend}`,
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/capture/f402_probe.ts",
      "--login",
      "--no-screenshot",
      "--no-preflight",
      "--backend",
      batchBackend,
      "--prefix",
      "/cloud/api/Report",
      "--ops",
      "PendingDelete",
      "--include-unconfirmed",
      "--i-understand-mutations",
      ...extraProbeArgs(),
    ],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: Bun.env,
    },
  );
  return proc.exited;
}

let code = 0;
const backends = bothBackends
  ? (["webkit", "chrome"] as const)
  : [backend as "webkit" | "chrome"];
if (!skipDiagnosticBatch) {
  for (const batchBackend of backends) {
    code ||= await runBatch(
      "prefix-identical (Report)",
      "/cloud/api/Report",
      REPORT_OPS,
      batchBackend,
    );
    if (!reportOnly) {
      code ||= await runBatch(
        "prefix-identical (Manager)",
        "/cloud/api/Manager",
        REPORT_OPS,
        batchBackend,
      );
    }
  }
}

if (promote) {
  code ||= await promoteFromLatestScratch({
    opFile: "getDailyFiguresByCustomer.json",
    allowNon2xx: false,
    promoteDir: "docs/evidence/captures",
  });
}

if (promoteEdge) {
  code ||= await promoteFromLatestScratch({
    opFile: "getGradedWagerByCustomer.json",
    allowNon2xx: true,
    promoteDir: "docs/evidence/captures/pending-500s/edge-store",
  });
}

if (promoteTicket) {
  code ||= await runPendingDeleteTicketProbe(backend);
  code ||= await promoteFromLatestScratch({
    opFile: "PendingDelete.json",
    allowNon2xx: false,
    promoteDir: "docs/evidence/captures",
  });
}

process.exit(code);
