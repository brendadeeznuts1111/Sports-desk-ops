#!/usr/bin/env bun
/**
 * @file scripts/capture/discover_customers.ts
 * @description Read `getBetTicker` from a signed-in page and index real customer ids.
 *
 *   bun run capture:discover --login
 *
 * The response is 951 rows of wagers, each carrying `CustomerID`, `AgentID`, `Login`,
 * `TicketWriter` and `WagerNumber`. This extracts identifiers and counts, never amounts, and writes
 * them to scratch/ (gitignored). Only aggregates are printed: the ids are the point, not the output.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import {
  ensureCustomerSchema,
  openCustomerIndex,
  upsertCustomers,
} from "../../lib/customer_index.ts";
import { pendingDeleteHuntExpression } from "./discover_ticket_hunt.ts";
import { loginF402 } from "./f402_login.ts";
import { ManagedWebView } from "./webview.ts";

const HELP = `
capture:discover — read getBetTicker and index the real customer ids it returns

Options:
  --login          Sign in with F402_AGENT_ID / F402_PASSWORD
  --hunt-pending-delete  Probe PendingDelete until a ticket returns non-empty Pending[] (slower)
  --base <url>     Portal origin (default: F402_BASE_URL or https://fantasy402.com)
  --out <dir>      Where to write the discovery JSON (default: scratch/f402-discover)
  --db <path>      Customer index (default: scratch/customers.sqlite)

Ticket sample for getTicketDetailPrint reprobe uses Report/Pending first row (ticketNumber, wagerNumber, flag=WagerType).
  -h, --help       This text

Examples:
  bun run capture:discover --login
  bun run customers list --source capture --limit 5

Writes identifiers only (customer id, agent id, login, writer, wager number) and prints aggregates.
`.trim();

const VALUE_FLAGS = ["--base", "--out", "--db"] as const;
const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: VALUE_FLAGS });
const huntPendingDelete = hasFlag(parsed, "--hunt-pending-delete");
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const base = flagValue(
  parsed,
  "--base",
  Bun.env.F402_BASE_URL?.trim() || "https://fantasy402.com",
);
const outRoot = flagValue(parsed, "--out", "scratch/f402-discover");
const dbPath = flagValue(parsed, "--db", "scratch/customers.sqlite");

const EXPRESSION = (baseUrl: string) => `(async () => {
  const creds = JSON.parse(sessionStorage.getItem("credentials") ?? "{}");
  const agentID = ${JSON.stringify(Bun.env.F402_AGENT_ID ?? "")};
  const body = new URLSearchParams({ agentID, agentOwner: agentID, wagerNumber: "0", operation: "getBetTicker", RRO: "1" }).toString();
  const r = await fetch(${JSON.stringify(baseUrl)} + "/cloud/api/Manager/getBetTicker", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json",
      authorization: "Bearer " + (creds.code ?? ""),
    },
    body,
  });
  const text = await r.text();
  if (!r.ok) return { status: r.status, error: text.slice(0, 200) };
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload.LIST) ? payload.LIST : [];
  const customers = new Map();
  const writers = {};
  const wagerNumbers = {};
  const sampleWagers = [];
  for (const row of rows) {
    const id = String(row.CustomerID ?? "").trim();
    if (id !== "") {
      const current = customers.get(id) ?? { customerId: id, agentId: String(row.AgentID ?? ""), login: String(row.Login ?? ""), wagers: 0 };
      current.wagers += 1;
      customers.set(id, current);
    }
    const writer = String(row.TicketWriter ?? "").trim();
    if (writer !== "") writers[writer] = (writers[writer] ?? 0) + 1;
    const wager = String(row.WagerNumber ?? "").trim();
    if (wager !== "") wagerNumbers[wager] = (wagerNumbers[wager] ?? 0) + 1;
    if (sampleWagers.length < 5) {
      const ticketNumber = String(row.TicketNumber ?? row.ticketNumber ?? "").trim();
      if (ticketNumber !== "" && wager !== "" && id !== "") {
        sampleWagers.push({ customerId: id, ticketNumber, wagerNumber: wager });
      }
    }
  }
  return {
    status: r.status,
    totalRows: rows.length,
    customers: [...customers.values()],
    writers,
    sampleWagers,
    duplicateWagerNumbers: Object.entries(wagerNumbers)
      .filter(([, count]) => count > 1)
      .map(([wagerNumber, count]) => ({ wagerNumber, count })),
  };
})()`;

function pendingTicketSampleExpression(
  baseUrl: string,
  customerId: string,
): string {
  const origin = baseUrl.replace(/\/$/, "");
  return `(async () => {
  const creds = JSON.parse(sessionStorage.getItem("credentials") ?? "{}");
  const body = new URLSearchParams({
    customerID: ${JSON.stringify(customerId)},
    token: "",
    operation: "Pending",
  }).toString();
  const r = await fetch(${JSON.stringify(origin)} + "/cloud/api/Report/Pending", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "application/json",
      authorization: "Bearer " + (creds.code ?? ""),
    },
    body,
  });
  const text = await r.text();
  if (!r.ok) return { status: r.status, error: text.slice(0, 200) };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { status: r.status, error: "non-json pending body" };
  }
  const pending = Array.isArray(payload.Pending) ? payload.Pending : [];
  const row = pending[0];
  if (!row || typeof row !== "object") {
    return { status: r.status, pendingCount: pending.length, sample: null };
  }
  const ticketNumber = String(row.TicketNumber ?? "").trim();
  const wagerNumber = String(row.WagerNumber ?? "").trim();
  if (ticketNumber === "" || wagerNumber === "") {
    return { status: r.status, pendingCount: pending.length, sample: null };
  }
  const wagerType = String(row.WagerType ?? row.wagerType ?? "").trim();
  return {
    status: r.status,
    pendingCount: pending.length,
    sample: {
      customerId: ${JSON.stringify(customerId)},
      ticketNumber,
      wagerNumber,
      flag: String(row.flag ?? row.Flag ?? wagerType).trim(),
    },
  };
})()`;
}

if (!hasFlag(parsed, "--login")) {
  console.error("capture:discover: --login is required (reads a live page).");
  console.error("  bun run capture:discover --login");
  process.exit(2);
}

const view = ManagedWebView.launch({
  backend: "webkit",
  dataStoreDir: "scratch/webview-profile",
  width: 1440,
  height: 900,
});

try {
  await loginF402(view, { baseUrl: base, timeoutMs: 60_000 });
  const raw = (await view.evaluate(EXPRESSION(base))) as Record<
    string,
    unknown
  >;
  const status = Number(raw["status"] ?? 0);
  if (status !== 200) {
    console.error(
      `capture:discover: getBetTicker answered ${status}: ${String(raw["error"] ?? "")}`,
    );
    process.exit(1);
  }

  const customers = (raw["customers"] as Array<Record<string, unknown>>) ?? [];
  const writers = (raw["writers"] as Record<string, number>) ?? {};
  const duplicates =
    (raw["duplicateWagerNumbers"] as Array<Record<string, unknown>>) ?? [];

  const pickCustomer =
    customers.find((row) => Number(row["wagers"] ?? 0) >= 1)?.["customerId"] ??
    customers[0]?.["customerId"];
  let ticketSample: Record<string, unknown> | null = null;
  let pendingDeleteHit: Record<string, unknown> | null = null;
  let pendingDeleteCandidates: unknown[] = [];
  if (pickCustomer !== undefined && String(pickCustomer).trim() !== "") {
    const customer = String(pickCustomer).trim();
    if (huntPendingDelete) {
      const huntRaw = (await view.evaluate(
        pendingDeleteHuntExpression(base, customer),
      )) as Record<string, unknown>;
      pendingDeleteCandidates =
        (huntRaw["candidates"] as unknown[] | undefined) ?? [];
      const hit = huntRaw["hit"];
      if (typeof hit === "object" && hit !== null) {
        pendingDeleteHit = hit as Record<string, unknown>;
        ticketSample = hit as Record<string, unknown>;
      }
    }
    if (ticketSample === null) {
      const pendingRaw = (await view.evaluate(
        pendingTicketSampleExpression(base, customer),
      )) as Record<string, unknown>;
      const sample = pendingRaw["sample"];
      if (typeof sample === "object" && sample !== null) {
        ticketSample = sample as Record<string, unknown>;
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(outRoot, stamp);
  await mkdir(outDir, { recursive: true });
  const document = {
    ...raw,
    ticketSample,
    ...(pendingDeleteHit ? { pendingDeleteHit } : {}),
    ...(pendingDeleteCandidates.length > 0 ? { pendingDeleteCandidates } : {}),
    ...(huntPendingDelete && pendingDeleteHit === null
      ? {
          pendingDeleteHuntNote:
            "Probed PendingDelete for first Pending rows: all returned 200 with empty Pending[] (expected for open pending wagers; modal path in report.js:8578 uses bought-out/deleted rows).",
        }
      : {}),
  };
  await Bun.write(
    join(outDir, "getBetTicker.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );

  const db = openCustomerIndex(`sqlite://${dbPath}`);
  try {
    await ensureCustomerSchema(db);
    await upsertCustomers(
      db,
      customers.map((row) => ({
        id: String(row["customerId"]),
        source: "capture" as const,
        agent: String(row["agentId"] ?? ""),
        name: "",
        updatedAt: new Date().toISOString(),
      })),
    );
  } finally {
    await db.close();
  }

  console.log(`rows: ${String(raw["totalRows"])}`);
  console.log(`distinct customers: ${customers.length}`);
  console.log(
    `distinct agents: ${new Set(customers.map((row) => row["agentId"])).size}`,
  );
  console.log(
    `ticket writers: ${
      Object.entries(writers)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}=${count}`)
        .join(" ") || "(none)"
    }`,
  );
  console.log(`duplicate wager numbers: ${duplicates.length}`);
  console.log(
    `ticket sample: ${ticketSample === null ? "none" : pendingDeleteHit !== null ? "yes (PendingDelete hit)" : "yes (Report/Pending)"}`,
  );
  console.error(
    `capture:discover: wrote ${outDir}/getBetTicker.json and indexed ${customers.length} customer(s)`,
  );
} finally {
  await view.close();
}
