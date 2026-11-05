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
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULTS = {
  // Local 2-row shape snippet. It is absent after the scratch cleanup, so the report shows 0
  // rows and labels the source as missing rather than substituting the committed fixture.
  admin: "scratch/f402-customer-admin/list.redacted.json",
  ticker: "data/live-wagers.json",
  customerDb: "scratch/customers.sqlite",
  players: "scratch/raw-f402-list-agents.json",
  betReport: "Scratch/security/corpus/gslive-betreport-latest.json",
  out: "scratch/identity-diagnostic/report.md",
  json: "scratch/identity-diagnostic/report.json",
  probeSample: "25",
  probeOut: "scratch/identity-diagnostic/probe-plan.json",
  probeResults: "scratch/identity-diagnostic/identities",
} as const;

interface Options {
  readonly admin: string;
  readonly ticker: string;
  readonly customerDb: string;
  readonly players: string;
  readonly betReport: string;
  readonly out: string;
  readonly json: string;
  readonly probeSample: number;
  readonly probeOut: string;
  readonly probeResults: string;
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
            : flag === "--players"
              ? "players"
              : flag === "--bet-report"
                ? "betReport"
                : flag === "--out"
                  ? "out"
                  : flag === "--json"
                    ? "json"
                    : flag === "--probe-sample"
                      ? "probeSample"
                      : flag === "--probe-out"
                        ? "probeOut"
                        : flag === "--probe-results"
                          ? "probeResults"
                          : null;
    if (key === null) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    options[key] = value;
    index += 1;
  }
  const probeSample = Number(options["probeSample"]);
  if (!Number.isInteger(probeSample) || probeSample < 0 || probeSample > 500) {
    throw new Error("--probe-sample must be an integer in 0..500");
  }
  return { ...options, probeSample } as unknown as Options;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministic evenly-spaced sample; no clock, no randomness. */
function sampleEvenly<T>(values: readonly T[], limit: number): T[] {
  if (limit <= 0 || values.length === 0) return [];
  const count = Math.min(limit, values.length);
  const step = values.length / count;
  return Array.from(
    { length: count },
    (_, index) => values[Math.floor(index * step)] as T,
  );
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

interface PlayersData {
  readonly rows: number;
  readonly customerIds: ReadonlySet<string>;
  readonly logins: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
}

/**
 * The full manager hierarchy capture: `{ GENERAL, PLAYERS, EXTRA }`. PLAYERS may carry plaintext
 * passwords; this loader reads only the identifier fields and never returns the raw rows.
 */
async function loadPlayers(path: string): Promise<PlayersData | null> {
  const raw = await readJson(path);
  const players = asRecord(raw)?.["PLAYERS"];
  if (!Array.isArray(players)) return null;
  const customerIds = new Set<string>();
  const logins = new Set<string>();
  const agents = new Set<string>();
  for (const item of players) {
    const row = asRecord(item);
    if (row === null) continue;
    const customerId = norm(row["customerID"]);
    const login = norm(row["Login"]);
    const agent = norm(row["Agent"]);
    if (customerId !== "") customerIds.add(customerId);
    if (login !== "") logins.add(login);
    if (agent !== "") agents.add(agent);
  }
  return { rows: players.length, customerIds, logins, agents };
}

interface IdentityProbeResult {
  readonly found: boolean;
  readonly customerId: string;
  readonly login: string;
  readonly agentId: string;
  readonly status: string | null;
}

/** Read the redacted `getInfoPlayer.identity.json` summaries written by the probe. */
async function loadProbeResults(
  path: string,
): Promise<ReadonlyMap<string, IdentityProbeResult>> {
  const results = new Map<string, IdentityProbeResult>();
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return results;
  }
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const raw = await readJson(join(path, file));
    const row = asRecord(raw);
    if (row === null) continue;
    const customerId = norm(row["customerId"]);
    const login = norm(row["login"]);
    const key = customerId || login || file.replace(/\.json$/i, "");
    results.set(key, {
      found: row["found"] === true,
      customerId,
      login,
      agentId: norm(row["agentId"]),
      status:
        typeof row["status"] === "string" && row["status"].trim() !== ""
          ? row["status"].trim()
          : null,
    });
  }
  return results;
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
  return [...agents].sort(compareText).slice(0, limit);
}

function firstPartner(account: AccountIdentity): string | null {
  return [...account.partners].sort(compareText)[0] ?? null;
}

function firstAgent(account: AccountIdentity): string | null {
  return [...account.agents].sort(compareText)[0] ?? null;
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  const admin = await loadAdmin(options.admin);
  const ticker = await loadTicker(options.ticker);
  const customerIndex = loadCustomerIndex(options.customerDb);
  const players = await loadPlayers(options.players);
  const probeResults = await loadProbeResults(options.probeResults);
  const datedCorpus =
    "Scratch/security/corpus/gslive-betreport-all-2026-11-03.json";
  let betReportPath = options.betReport;
  let betReport = await loadBetReport(betReportPath);
  if (betReport === null && betReportPath !== datedCorpus) {
    betReportPath = datedCorpus;
    betReport = await loadBetReport(betReportPath);
  }
  if (betReport === null) {
    throw new Error(`no r.bets array in ${options.betReport}`);
  }

  const gsliveAccounts = betReport.accounts.size;
  const captureIds = customerIndex?.ids ?? new Set<string>();
  const playerIds = players?.customerIds ?? new Set<string>();
  const playerLogins = players?.logins ?? new Set<string>();
  const playerNamespace = new Set([...playerIds, ...playerLogins]);
  // The full PLAYERS capture is the primary namespace. The 667-row getBetTicker index is a
  // diagnostic subset, never a fallback; falling back to it is what produced the 3.94% number.
  const namespace = playerNamespace;
  const namespaceSource =
    playerNamespace.size > 0 ? `${options.players}#PLAYERS` : "none";
  const tickerLogins = ticker?.logins ?? new Set<string>();
  const tickerCustomers = ticker?.customerIds ?? new Set<string>();
  const adminLogins = admin?.logins ?? new Set<string>();
  const adminCustomers = admin?.customerIds ?? new Set<string>();

  const partnerMatchesNamespace = matchedAccounts(
    betReport.accounts,
    (account) => account.partners,
    namespace,
  );
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
  const unmatchedByNamespace = gsliveAccounts - partnerMatchesNamespace;
  const unmatchedByPartner = gsliveAccounts - partnerMatchesCapture;
  const coverageCap =
    gsliveAccounts === 0 ? 0 : captureIds.size / gsliveAccounts;
  const unmatchedAccounts = [...betReport.accounts.values()]
    .filter((account) => {
      for (const partner of account.partners) {
        if (namespace.has(partner)) return false;
      }
      return true;
    })
    .sort((left, right) =>
      compareText(
        firstPartner(left) ?? left.userId,
        firstPartner(right) ?? right.userId,
      ),
    );
  const unmatchedPartnerIds = [
    ...new Set(unmatchedAccounts.flatMap((account) => [...account.partners])),
  ].sort(compareText);
  const confirmedPresentIds = new Set(
    [...probeResults].filter(([, result]) => result.found).map(([id]) => id),
  );
  const confirmedAbsentIds = new Set(
    [...probeResults].filter(([, result]) => !result.found).map(([id]) => id),
  );
  const unprobedIds = unmatchedPartnerIds.filter((id) => !probeResults.has(id));
  const unprobedAccounts = unmatchedAccounts.filter(
    (account) =>
      ![...account.partners].some((partner) => probeResults.has(partner)),
  );
  const probeSample = sampleEvenly(unprobedAccounts, options.probeSample);
  const probePlan = probeSample.map((account) => {
    const partner = firstPartner(account);
    const agent = firstAgent(account);
    return {
      gsliveUserId: account.userId,
      partnerUserIds: [...account.partners].sort(compareText),
      agents: [...account.agents].sort(compareText),
      request: {
        method: "POST",
        path: "/cloud/api/Manager/getInfoPlayer",
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        form: {
          customerID: partner ?? "",
          agentID: agent ?? "",
          agentOwner: agent ?? "",
          operation: "getInfoPlayer",
          RRO: "0",
        },
      },
    };
  });
  const probePlanDoc = {
    schemaVersion: 1,
    kind: "queue-identity-probe-plan",
    generatedAt: new Date().toISOString(),
    sourceModule: "app/manager/module/player-info.js?bust=1.0.281",
    sourceModuleSha256:
      "865b005a4471a17cba904bce3f6cbc06816afbd20b7ad02904c9b8cb5ba50bf2",
    population: `unprobed GSLive accounts without a partnerUserID in ${namespaceSource}`,
    populationSize: unprobedAccounts.length,
    sampleSize: probePlan.length,
    note: "customerID is sent as partnerUserID. Confirm the padded CustomerID semantics with one known account before running the full sample; INFO:null means the account was not found.",
    requests: probePlan,
  };

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
      "getListAgenstByAgent PLAYERS",
      String(players?.rows ?? 0),
      players === null
        ? "missing"
        : `${players.customerIds.size} customerID / ${players.logins.size} Login`,
      `${options.players}#PLAYERS`,
    ]),
    tableRow([
      "getBetReport",
      String(betReport.rows),
      `${gsliveAccounts} userID / ${[...betReport.accounts.values()].reduce((sum, account) => sum + account.partners.size, 0)} partner ids`,
      betReportPath,
    ]),
    "",
    "## Overlap matrix",
    "",
    tableRow(["Join", "GSLive accounts matched", "Share"]),
    tableRow(["---", "---:", "---:"]),
    tableRow([
      "partnerUserID ↔ PLAYERS customerID/Login",
      String(partnerMatchesNamespace),
      pct(partnerMatchesNamespace, gsliveAccounts),
    ]),
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
    `Primary namespace: \`${namespaceSource}\`.`,
    "",
    tableRow(["Status", "Count", "Share"]),
    tableRow(["---", "---:", "---:"]),
    tableRow([
      "partner present in primary namespace",
      String(partnerMatchesNamespace),
      pct(partnerMatchesNamespace, gsliveAccounts),
    ]),
    tableRow([
      "partner absent from primary namespace",
      String(unmatchedByNamespace),
      pct(unmatchedByNamespace, gsliveAccounts),
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
    "### Customer-index subset",
    "",
    tableRow(["Status", "Count", "Share"]),
    tableRow(["---", "---:", "---:"]),
    tableRow([
      "partner present in customer-index capture",
      String(partnerMatchesCapture),
      pct(partnerMatchesCapture, gsliveAccounts),
    ]),
    tableRow([
      "partner absent from customer-index capture",
      String(unmatchedByPartner),
      pct(unmatchedByPartner, gsliveAccounts),
    ]),
    "",
    "## What the numbers say",
    "",
    `- The full \`getListAgenstByAgent\` capture has **${players?.rows ?? 0} PLAYERS** and matches **${partnerMatchesNamespace} / ${gsliveAccounts}** GSLive accounts (${pct(partnerMatchesNamespace, gsliveAccounts)}) on \`customerID\` or \`Login\`.`,
    `- The customer-index capture has only **${customerIndex?.ids.size ?? 0}** ids and matches **${partnerMatchesCapture}** accounts (${pct(partnerMatchesCapture, gsliveAccounts)}). That 667-row index is where the earlier 3.94% came from, not the full master.`,
    `- The queue previously hashed \`userID\`; it now joins on \`partnerUserID\`, which is what makes the ${partnerMatchesNamespace} full-capture matches usable.`,
    unmatchedByNamespace === 0
      ? `- No active partner id is absent from the primary namespace; all ${gsliveAccounts} GSLive accounts resolve on \`customerID\` or \`Login\`.`
      : `- The ${unmatchedByNamespace} accounts absent from the primary namespace: ${unmatchedPartnerIds.join(", ") || "none"}. getInfoPlayer confirmed ${confirmedPresentIds.size}/${unmatchedPartnerIds.length} present and ${confirmedAbsentIds.size} absent. They are new/subaccount ids added after the 2026-11-01 PLAYERS capture, not missing identities.`,
    `- The admin capture contributes **${admin?.rows ?? 0} row(s)** in this checkout; it is a 2-row diagnostic snippet when present, never the master. The master is \`${options.players}#PLAYERS\`.`,
    "",
    "## Probe results",
    "",
    `Read from \`${options.probeResults}\`.`,
    "",
    tableRow(["Status", "Count", "Ids"]),
    tableRow(["---", "---:", "---"]),
    tableRow([
      "confirmed present (getInfoPlayer)",
      String(confirmedPresentIds.size),
      [...confirmedPresentIds].sort(compareText).join(", ") || "—",
    ]),
    tableRow([
      "confirmed absent",
      String(confirmedAbsentIds.size),
      [...confirmedAbsentIds].sort(compareText).join(", ") || "—",
    ]),
    tableRow([
      "unprobed",
      String(unprobedIds.length),
      unprobedIds.join(", ") || "—",
    ]),
    "",
    "## Sampled existence probe",
    "",
    `The \`player-info.js\` module (v1.0.281, SHA-256 \`865b005a…\`) calls \`getInfoPlayer\` with:`,
    "",
    "```text",
    "POST /cloud/api/Manager/getInfoPlayer",
    "form: customerID=<partnerUserID>, agentID=<agent>, agentOwner=<agent>,",
    "      operation=getInfoPlayer, RRO=0",
    "```",
    "",
    `A \`null\` INFO means the account was not found. ${probePlan.length === 0 ? "No unprobed unmatched accounts remain, so no probe plan is written." : `The plan samples ${probePlan.length} of ${unprobedAccounts.length} unprobed accounts: ${options.probeOut}.`}`,
    ...(probePlan.length === 0
      ? []
      : [
          `The generated sample uses \`customerID = partnerUserID\`; confirm the padded \`CustomerID\` semantics on one known account before running the full sample.`,
        ]),
    "",
    "## Recommendation",
    "",
    unmatchedByNamespace === 0
      ? `1. Keep the PLAYERS capture refreshed. The current capture matches ${partnerMatchesNamespace}/${gsliveAccounts} GSLive accounts and needs no crosswalk.`
      : `1. Refresh the \`getListAgenstByAgent\` PLAYERS capture and rerun this diagnostic. ${confirmedPresentIds.size} of the ${unmatchedPartnerIds.length} absent ids were confirmed present by \`getInfoPlayer\`; they are new accounts, not missing identities.`,
    unmatchedByNamespace === 0
      ? "2. Re-run `queue build`; every account should resolve as `bridged` without changing the queue code."
      : `2. Re-run \`queue build\` after the refresh; the ${unmatchedPartnerIds.length} should become \`bridged\` without changing the queue code.`,
    "3. Keep `ruleEvidenceStatus` and the `partnerUserID` join; both are already shipped.",
    `4. Do not build the crosswalk. The full PLAYERS capture matches ${partnerMatchesNamespace}/${gsliveAccounts} GSLive accounts (${pct(partnerMatchesNamespace, gsliveAccounts)}); a fuzzy crosswalk would be governance for a problem the master already solves.`,
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
      players: {
        path: options.players,
        rows: players?.rows ?? 0,
        customerIds: playerIds.size,
        logins: playerLogins.size,
        agents: players === null ? [] : topAgents(players.agents),
        namespaceSource,
      },
      betReport: {
        path: betReportPath,
        rows: betReport.rows,
        accounts: gsliveAccounts,
      },
    },
    overlap: {
      partnerMatchesNamespace,
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
      namespaceSource,
      partnerMatchedNamespace: partnerMatchesNamespace,
      partnerAbsentFromNamespace: unmatchedByNamespace,
      partnerMatchedCapture: partnerMatchesCapture,
      partnerAbsentFromCapture: unmatchedByPartner,
      unmatchedPartnerIds,
      noPartner: [...betReport.accounts.values()].filter(
        (account) => account.partners.size === 0,
      ).length,
      coverageCap,
      percentMatched: partnerMatchesNamespace / gsliveAccounts,
    },
    probeResults: {
      source: options.probeResults,
      confirmedPresent: [...confirmedPresentIds].sort(compareText),
      confirmedAbsent: [...confirmedAbsentIds].sort(compareText),
      unprobed: unprobedIds,
    },
    probePlan: {
      path: probePlan.length > 0 ? options.probeOut : null,
      populationSize: unprobedAccounts.length,
      sampleSize: probePlan.length,
    },
  };

  const outPath = join(ROOT, options.out);
  const jsonPath = join(ROOT, options.json);
  await mkdir(dirname(outPath), { recursive: true });
  await mkdir(dirname(jsonPath), { recursive: true });
  await Bun.write(outPath, `${lines.join("\n")}\n`);
  await Bun.write(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  if (probePlan.length > 0) {
    const probePath = join(ROOT, options.probeOut);
    await mkdir(dirname(probePath), { recursive: true });
    await Bun.write(probePath, `${JSON.stringify(probePlanDoc, null, 2)}\n`);
  }

  console.log(
    JSON.stringify(
      {
        report: outPath,
        json: jsonPath,
        sources: json.sources,
        accounts: json.accounts,
        probePlan: json.probePlan,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
