#!/usr/bin/env bun
/**
 * Run PendingDelete probes for tickets from deleted-transactions ingest output.
 *
 *   bun run capture:ingest-deleted-wagers --in scratch/f402-deleted-wagers/envelope.json
 *   bun run capture:probe-deleted-wagers --limit 3 --dry-run
 *   bun run capture:probe-deleted-wagers --limit 3 --promote
 *
 * For many targets prefer one login:
 *   bun run capture:batch-pending-delete --limit 92
 */

import { join } from "node:path";

import type { DeletedWagerTicketTarget } from "../../lib/f402_deleted_wager_list.ts";

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
const limit = Number(flag("--limit", "5"));
const backend = flag("--backend", "webkit");
const dryRun = args.includes("--dry-run");
const promote = args.includes("--promote");

interface TargetsFile {
  targets: DeletedWagerTicketTarget[];
}

async function loadTargets(): Promise<DeletedWagerTicketTarget[]> {
  const abs = join(root, targetsPath);
  const file = Bun.file(abs);
  if (!(await file.exists())) {
    console.error(
      `probe_deleted_wager_targets: missing ${abs} — run capture:ingest-deleted-wagers first`,
    );
    process.exit(2);
  }
  const parsed = (await file.json()) as TargetsFile;
  if (!Array.isArray(parsed.targets)) {
    console.error(
      "probe_deleted_wager_targets: targets file missing targets[]",
    );
    process.exit(2);
  }
  return parsed.targets.slice(0, Math.max(1, limit));
}

async function probeOne(
  target: DeletedWagerTicketTarget,
  batchBackend: string,
): Promise<number> {
  const customer = target.customerId.trim();
  const ticket = target.ticketNumber.trim();
  console.error(
    `\nprobe_deleted_wager_targets: PendingDelete customer=${customer} ticket=${ticket} (${target.amountWagered} risk)`,
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
      "--report-customer-context",
      "--report-customer",
      customer,
      "--ticket",
      ticket,
      ...(promote ? ["--promote-dir", "docs/evidence/captures"] : []),
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

const targets = await loadTargets();
if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        count: targets.length,
        targets: targets.map((t) => ({
          customerId: t.customerId,
          ticketNumber: t.ticketNumber,
          amountWagered: t.amountWagered,
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

let code = 0;
for (const target of targets) {
  code ||= await probeOne(target, backend);
}
process.exit(code);
