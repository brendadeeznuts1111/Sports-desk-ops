#!/usr/bin/env bun
/**
 * Identity diagnostic: decide whether the queue's low bridge coverage is a matching problem or a
 * source-coverage problem. Read-only over whatever captures are present.
 *
 * Usage:
 *   bun run scripts/identity_diagnostic.ts
 *   bun run scripts/identity_diagnostic.ts --admin <path> --ticker <path> --customer-db <path>
 *
 * Outputs:
 *   scratch/identity-diagnostic/report.md
 *   scratch/identity-diagnostic/report.json
 *
 * The report deliberately distinguishes:
 *   - partnerUserID: the F402 login carried by getBetReport
 *   - userID: the GSLive numeric player id (the wrong field for the F402 join)
 *   - present in the available F402 namespace vs absent from it
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULTS = {
  admin: "scratch/f402-customer-admin/list.redacted.json",
  ticker: "data/live-wagers.json",
  customerDb: "scratch/customers.sqlite",
  betReport: "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json",
  out: "scratch/identity-diagnostic/report.md",
  json: "scratch/identity-diagnostic/report.json",
} as const;

interface Options {
  readonly admin: string;
  readonly ticker: string;
  readonly customerDb: string;
  readonly betReport: string;
  readonly out: string;
  readonly json: string;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Record<string, string> = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) break;
    const key =
      flag === "--admin"
        ? "admin"
        : flag === "--ticker"
          ? "ticker"
          : flag === "--customer-db"
            ? "customerDb"
            : flag === "--bet-report"
              ? "betReport"
              : flag === "--out"
                ? "out"
                : flag === "--json"
                  ? "json"
                  : null;
    if (key === null) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    options[key] = value;
    index += 1;
  }
  return options as unknown as Options;
}

function norm(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function stripPlayer(value: unknown): string {
  return norm(value).replace(/^PLAYER_/, "");
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;
}

interface AdminRow {
  readonly customerId: string;
  readonly login: string;
  readonly agentId: string;
}

interface AdminData {
  readonly rows: number;
  readonly customerIds: ReadonlySet<string>;
  readonly logins: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
  readonly samples: readonly AdminRow[];
}

async function readJson(path: string): Promise<unknown | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return await file.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function loadAdmin(path: string): Promise<AdminData | null> {
  const raw = await readJson(path);
  const record = asRecord(raw);
  const list = Array.isArray(record?.["LIST"]) ? record["LIST"] : null;
  if (list === null) return null;
  const customerIds = new Set<string>();
  const logins = new Set<string>();
  const agents = new Set<string>();
  const samples: AdminRow[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (row === null) continue;
    const customerId = norm(row["CustomerID"]);
    const login = norm(row["Login"]);
    const agentId = norm(row["AgentID"]);
    if (customerId !== "") customerIds.add(customerId);
    if (login !== "") logins.add(login);
    if (agentId !== "") agents.add(agentId);
    if (samples.length < 5) samples.push({ customerId, login, agentId });
  }
  return { rows: list.length, customerIds, logins, agents, samples };
}

interface TickerData {
  readonly rows: number;
  readonly customerIds: ReadonlySet<string>;
  readonly logins: ReadonlySet<string>;
}

async function loadTicker(path: string): Promise<TickerData | null> {
  const raw = await readJson(path);
  const record = asRecord(raw);
  const list = Array.isArray(record?.["LIST"]) ? record["LIST"] : null;
  if (list === null) return null;
  const customerIds = new Set<string>();
  const logins = new Set<string>();
  for (const item of list) {
    const row = asRecord(item);
    if (row === null) continue;
    const customerId = norm(row["CustomerID"]);
    const login = norm(row["Login"]);
    if (customerId !== "") customerIds.add(customerId);
    if (login !== "") logins.add(login);
  }
  return { rows: list.length, customerIds, logins };
}

interface CustomerIndexData {
  readonly rows: number;
  readonly ids: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
}

function loadCustomerIndex(path: string): CustomerIndexData | null {
  const file = Bun.file(path);
  if (!file.size) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT id, agent FROM customers WHERE source = 'capture' ORDER BY id`,
        )
        .all() as Array<{ id: string; agent: string }>;
      const ids = new Set<string>();
      const agents = new Set<string>();
      for (const row of rows) {
        const id = norm(row.id);
        const agent = norm(row.agent);
        if (id !== "") ids.add(id);
        if (agent !== "") agents.add(agent);
      }
      return { rows: rows.length, ids, agents };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

interface AccountIdentity {
  readonly userId: string;
  readonly partners: Set<string>;
  readonly profiles: Set<string>;
  readonly agents: Set<string>;
  rows: number;
}

interface BetReportData {
  readonly rows: number;
  readonly accounts: ReadonlyMap<string, AccountIdentity>;
}

async function loadBetReport(path: string): Promise<BetReportData | null> {
  const raw = await readJson(path);
  const record = asRecord(raw);
  const bets = asRecord(record?.["r"])?.["bets"];
  if (!Array.isArray(bets)) return null;
  const accounts = new Map<string, AccountIdentity>();
  for (const item of bets) {
    const row = asRecord(item);
    if (row === null) continue;
    const userId = norm(row["userID"]);
    if (userId === "") continue;
    const existing = accounts.get(userId);
    const account: AccountIdentity = existing ?? {
      userId,
      partners: new Set<string>(),
      profiles: new Set<string>(),
      agents: new Set<string>(),
      rows: 0,
    };
    account.rows += 1;
    const partner = norm(row["partnerUserID"]);
    const profile = stripPlayer(row["profile"]);
    const agent = norm(row["agent"]);
    if (partner !== "") account.partners.add(partner);
    if (profile !== "") account.profiles.add(profile);
    if (agent !== "") account.agents.add(agent);
    accounts.set(userId, account);
  }
  return { rows: bets.length, accounts };
}

function matchedAccounts(
  accounts: ReadonlyMap<string, AccountIdentity>,
  key: (account: AccountIdentity) => ReadonlySet<string>,
  namespace: ReadonlySet<string>,
): number {
  let count = 0;
  for (const account of accounts.values()) {
    for (const value of key(account)) {
      if (namespace.has(value)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function topAgents(agents: ReadonlySet<string>, limit = 8): string[] {
  return [...agents].sort().slice(0, limit);
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const admin = await loadAdmin(options.admin);
  const ticker = await loadTicker(options.ticker);
  const customerIndex = loadCustomerIndex(options.customerDb);
  const betReport = await loadBetReport(options.betReport);

  if (betReport === null) {
    throw new Error(`no r.bets array in ${options.betReport}`);
  }

  const gsliveAccounts = betReport.accounts.size;
  const captureIds = customerIndex?.ids ?? new Set<string>();
  const tickerLogins = ticker?.logins ?? new Set<string>();
  const tickerCustomers = ticker?.customerIds ?? new Set<string>();
  const adminLogins = admin?.logins ?? new Set<string>();
  const adminCustomers = admin?.customerIds ?? new Set<string>();

  const partnerMatchesCapture = matchedAccounts(
    betReport.accounts,
    (account) => account.partners,
    captureIds,
  );
  const partnerMatchesTicker = matchedAccounts(
    betReport.accounts,
    (account) => account.partners,
    tickerLogins,
  );
  const profileMatchesCapture = matchedAccounts(
    betReport.accounts,
    (account) => account.profiles,
    captureIds,
  );
  const userMatchesTicker = matchedAccounts(
    betReport.accounts,
    (account) => new Set([account.userId]),
    tickerCustomers,
  );
  const userMatchesCapture = matchedAccounts(
    betReport.accounts,
    (account) => new Set([account.userId]),
    captureIds,
  );
  const partnerMatchesAdmin = matchedAccounts(
    betReport.accounts,
    (account) => account.partners,
    adminLogins,
  );
  const partnerMatchesAdminCustomer = matchedAccounts(
    betReport.accounts,
    (account) => account.partners,
    adminCustomers,
  );
  const unmatchedByPartner = gsliveAccounts - partnerMatchesCapture;
  const coverageCap =
    gsliveAccounts === 0 ? 0 : captureIds.size / gsliveAccounts;

  const lines: string[] = [
    "# Identity diagnostic",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Sources and scope",
    "",
    tableRow(["Source", "Rows", "Distinct keys", "Note"]),
    tableRow(["---", "---:", "---:", "---"]),
    tableRow([
      "getCustomerAdmin (redacted)",
      String(admin?.rows ?? 0),
      admin === null
        ? "missing"
        : `${admin.customerIds.size} CustomerID / ${admin.logins.size} Login`,
      admin === null
        ? options.admin
        : `${options.admin} — ${admin.rows <= 5 ? "snippet, not a full capture" : "available capture"}`,
    ]),
    tableRow([
      "getBetTicker snapshot",
      String(ticker?.rows ?? 0),
      ticker === null
        ? "missing"
        : `${ticker.customerIds.size} CustomerID / ${ticker.logins.size} Login`,
      options.ticker,
    ]),
    tableRow([
      "getBetTicker customer index",
      String(customerIndex?.rows ?? 0),
      customerIndex === null ? "missing" : `${customerIndex.ids.size} ids`,
      `${options.customerDb} (source=capture)`,
    ]),
    tableRow([
      "getBetReport",
      String(betReport.rows),
      `${gsliveAccounts} userID / ${[...betReport.accounts.values()].reduce((sum, account) => sum + account.partners.size, 0)} partner ids`,
      options.betReport,
    ]),
    "",
    "## Overlap matrix",
    "",
    tableRow(["Join", "GSLive accounts matched", "Share"]),
    tableRow(["---", "---:", "---:"]),
    tableRow([
      "partnerUserID ↔ customer-index capture",
      String(partnerMatchesCapture),
      pct(partnerMatchesCapture, gsliveAccounts),
    ]),
    tableRow([
      "partnerUserID ↔ ticker snapshot Login",
      String(partnerMatchesTicker),
      pct(partnerMatchesTicker, gsliveAccounts),
    ]),
    tableRow([
      "profile (PLAYER_ stripped) ↔ customer-index capture",
      String(profileMatchesCapture),
      pct(profileMatchesCapture, gsliveAccounts),
    ]),
    tableRow([
      "userID ↔ ticker snapshot CustomerID",
      String(userMatchesTicker),
      pct(userMatchesTicker, gsliveAccounts),
    ]),
    tableRow([
      "userID ↔ customer-index capture",
      String(userMatchesCapture),
      pct(userMatchesCapture, gsliveAccounts),
    ]),
    tableRow([
      "partnerUserID ↔ admin Login",
      String(partnerMatchesAdmin),
      pct(partnerMatchesAdmin, gsliveAccounts),
    ]),
    tableRow([
      "partnerUserID ↔ admin CustomerID",
      String(partnerMatchesAdminCustomer),
      pct(partnerMatchesAdminCustomer, gsliveAccounts),
    ]),
    "",
    "## The 2,586 GSLive accounts",
    "",
    tableRow(["Status", "Count", "Share"]),
    tableRow(["---", "---:", "---:"]),
    tableRow([
      "partner present in customer-index capture",
      String(partnerMatchesCapture),
      pct(partnerMatchesCapture, gsliveAccounts),
    ]),
    tableRow([
      "partner present, absent from capture",
      String(unmatchedByPartner),
      pct(unmatchedByPartner, gsliveAccounts),
    ]),
    tableRow([
      "no partnerUserID at all",
      String(
        [...betReport.accounts.values()].filter(
          (account) => account.partners.size === 0,
        ).length,
      ),
      pct(
        [...betReport.accounts.values()].filter(
          (account) => account.partners.size === 0,
        ).length,
        gsliveAccounts,
      ),
    ]),
    "",
    "## What the numbers say",
    "",
    `- The current queue hashes \`userID\` as the customer key. Against the available F402 namespace that matches **${userMatchesCapture}** accounts.`,
    `- The F402 login is \`partnerUserID\`. Against the customer-index capture it matches **${partnerMatchesCapture}** accounts (${pct(partnerMatchesCapture, gsliveAccounts)}).`,
    `- Even a perfect matcher can cover at most **${customerIndex?.ids.size ?? 0} / ${gsliveAccounts} = ${(coverageCap * 100).toFixed(1)}%** with this capture. The remaining ${unmatchedByPartner} accounts have no row in the available F402 namespace.`,
    `- The admin file in this checkout has **${admin?.rows ?? 0} row(s)**, so it cannot answer the full-master question. The 131-row namespace referenced earlier is closer to the ticker snapshot (${ticker?.customerIds.size ?? 0} distinct today) than to this admin file.`,
    `- "Present but no key match" cannot be measured from this capture because the customer index carries only the key itself. The full \`getCustomerAdmin\` rows carry \`CustomerID\`, \`Login\`, \`AgentID\`, and \`Name\`; that is the capture needed to distinguish normalization from absence.`,
    "",
    "## Recommendation",
    "",
    "1. Capture the full `getCustomerAdmin` scope and rerun this diagnostic. If it contains the 2,167 absent partner ids, coverage rises without a crosswalk. If it does not, the master is incomplete.",
    "2. Ship `ruleEvidenceStatus` on the queue row (`bridged` / `unmatched` / `not_applied`) before the crosswalk.",
    "3. Correct the queue's rule-evidence join from `userID` to `partnerUserID`; that alone moves the available bridge from 0 to 419 accounts.",
    "4. Build the crosswalk only if the full admin capture still leaves a large present-but-unmatched population.",
    "",
  ];

  const json = {
    generatedAt: new Date().toISOString(),
    sources: {
      admin: {
        path: options.admin,
        rows: admin?.rows ?? 0,
        customerIds: admin?.customerIds.size ?? 0,
        logins: admin?.logins.size ?? 0,
        agents: admin === null ? [] : topAgents(admin.agents),
      },
      ticker: {
        path: options.ticker,
        rows: ticker?.rows ?? 0,
        customerIds: ticker?.customerIds.size ?? 0,
        logins: ticker?.logins.size ?? 0,
      },
      customerIndex: {
        path: options.customerDb,
        rows: customerIndex?.rows ?? 0,
        ids: customerIndex?.ids.size ?? 0,
        agents: customerIndex === null ? [] : topAgents(customerIndex.agents),
      },
      betReport: {
        path: options.betReport,
        rows: betReport.rows,
        accounts: gsliveAccounts,
      },
    },
    overlap: {
      partnerMatchesCapture,
      partnerMatchesTicker,
      profileMatchesCapture,
      userMatchesTicker,
      userMatchesCapture,
      partnerMatchesAdmin,
      partnerMatchesAdminCustomer,
    },
    accounts: {
      total: gsliveAccounts,
      partnerMatchedCapture: partnerMatchesCapture,
      partnerAbsentFromCapture: unmatchedByPartner,
      noPartner: [...betReport.accounts.values()].filter(
        (account) => account.partners.size === 0,
      ).length,
      coverageCap,
      percentMatched: partnerMatchesCapture / gsliveAccounts,
    },
  };

  const outPath = join(ROOT, options.out);
  const jsonPath = join(ROOT, options.json);
  await mkdir(dirname(outPath), { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await Bun.write(outPath, `${lines.join("\n")}\n`);
  await Bun.write(jsonPath, `${JSON.stringify(json, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        report: outPath,
        json: jsonPath,
        sources: json.sources,
        accounts: json.accounts,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
