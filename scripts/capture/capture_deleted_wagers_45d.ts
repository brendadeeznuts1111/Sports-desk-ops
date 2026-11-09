#!/usr/bin/env bun
/**
 * Single-WebView 45-day Deleted & Buyout Wager Capture + Buyout Ledger Reconciler.
 *
 * 1. Authenticates via `loginF402()` (keychain credentials; never logged or printed).
 * 2. Calls `POST /cloud/api/Manager/getDeleteWager` (`application/json`) with `date` = 45 days ago
 *    to retrieve all deleted and bought-out wager legs (`INFO.LIST`) across the hierarchy.
 * 3. Redacts `Password` in memory (`redactDeletedWagerEnvelope`) before persisting
 *    `scratch/f402-deleted-wagers/envelope.redacted.json` and `probe-targets.json`.
 * 4. For every customer with a `BUYOUT-*` ticket in the 45-day window, queries
 *    `POST /cloud/api/Report/getGrading` (`graded: 3`) to match the `"Buyout ... ticket <id>"`
 *    ledger credit amount against the parlay's risk/toWin and leg outcomes.
 *
 * Usage:
 *   bun run scripts/capture/capture_deleted_wagers_45d.ts [--days 45]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseDeletedWagerEnvelope,
  redactDeletedWagerEnvelope,
  targetsFromEnvelope,
  type DeletedWagerLegRow,
} from "../../lib/f402_deleted_wager_list.ts";
import { acquireProfileLock } from "../../lib/f402_profile_lock.ts";
import { buildDnsPrefetchExpression } from "../../lib/f402_report_context.ts";
import { preflight, warmCaptureNetwork } from "../../lib/preflight.ts";
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

const days = Math.max(1, Number(flag("--days", "45")) || 45);
const backend = flag("--backend", "webkit") === "chrome" ? "chrome" : "webkit";
const profile = flag(
  "--profile",
  "/Users/nolarose/code/sportsdesk-ops/scratch/webview-profile",
);
const base = flag(
  "--base",
  Bun.env.F402_BASE_URL?.trim() || "https://www.fantasy402.com",
);
const outRedacted = flag(
  "--out-redacted",
  "scratch/f402-deleted-wagers/envelope.redacted.json",
);
const outTargets = flag(
  "--out-targets",
  "scratch/f402-deleted-wagers/probe-targets.json",
);
const outSummary = flag(
  "--out-summary",
  "scratch/f402-deleted-wagers/summary-45d.json",
);

interface InPageDeleteWagerResponse {
  status: number;
  origin: string;
  tokenPresent: boolean;
  startDate: string;
  endDate: string;
  agentId: string;
  bodyText: string;
  error?: string;
}

interface InPageGradingRow {
  CustomerID?: string;
  DocumentNumber?: number | string;
  TranDateTime?: string;
  TranCode?: string;
  TranType?: string;
  Amount?: number | string;
  AmountWon?: number | string;
  AmountLost?: number | string;
  ShortDesc?: string;
  Description?: string;
}

function buildWaitForCredentialsExpression(): string {
  return `(async () => {
    for (let i = 0; i < 60; i++) {
      try {
        let token = (sessionStorage.getItem("token") || "").trim();
        let credCustomer = "";
        const raw = sessionStorage.getItem("credentials");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!token && parsed && typeof parsed.code === "string") token = parsed.code.trim();
          if (parsed && typeof parsed.customerID === "string") credCustomer = parsed.customerID.trim();
        }
        if (token.length > 10) {
          return {
            ok: true,
            origin: location.origin,
            href: location.href,
            title: document.title,
            sessionKeys: Object.keys(sessionStorage),
            agentId: (sessionStorage.getItem("MASTER_ID") || sessionStorage.getItem("customerID") || credCustomer || "").toString().trim(),
          };
        }
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    return {
      ok: false,
      origin: location.origin,
      href: location.href,
      title: document.title,
      sessionKeys: Object.keys(sessionStorage),
      bodySnippet: (document.body ? document.body.innerText : "").slice(0, 200),
      agentId: "",
    };
  })()`;
}

function buildFetchDeleteWagerExpression(
  lookbackDays: number,
  fallbackAgentId: string,
): string {
  return `(async () => {
    let token = (sessionStorage.getItem("token") || "").trim();
    let credCustomer = "";
    const rawCreds = sessionStorage.getItem("credentials");
    try {
      if (rawCreds) {
        const parsed = JSON.parse(rawCreds);
        if (!token && parsed && typeof parsed.code === "string") token = parsed.code.trim();
        if (parsed && typeof parsed.customerID === "string") credCustomer = parsed.customerID.trim();
      }
    } catch {}
    const agentId = (
      sessionStorage.getItem("MASTER_ID") ||
      credCustomer ||
      sessionStorage.getItem("customerID") ||
      ${JSON.stringify(fallbackAgentId)}
    ).toString().trim();

    // Anchor to moment() if loaded in portal, else browser Date
    let startDate = "";
    let endDate = "";
    if (typeof window.moment === "function") {
      endDate = window.moment().format("YYYY-MM-DD");
      startDate = window.moment().subtract(${lookbackDays}, "days").format("YYYY-MM-DD");
    } else {
      const now = new Date();
      endDate = now.toISOString().slice(0, 10);
      const past = new Date(now.getTime() - ${lookbackDays} * 86400000);
      startDate = past.toISOString().slice(0, 10);
    }

    const payload = {
      agentID: agentId,
      agentOwner: agentId,
      customerID: "",
      date: startDate,
      wagerType: "",
      sort: 0,
      typeSort: 0,
      week: 0,
      RRO: 1,
      path: "/qubic/api/Manager/getDeleteWager",
    };

    const headers = {
      "accept": "*/*",
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
    };
    if (token) {
      headers["authorization"] = "Bearer " + token;
    }

    try {
      const res = await fetch("/cloud/api/Manager/getDeleteWager", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(payload),
      });
      const bodyText = await res.text();
      return {
        status: res.status,
        origin: location.origin,
        tokenPresent: token.length > 0,
        startDate,
        endDate,
        agentId,
        bodyText: bodyText.replace(/"Password"\\s*:\\s*"[^"]*"/g, '"Password":"<redacted>"'),
      };
    } catch (err) {
      return {
        status: 0,
        origin: location.origin,
        tokenPresent: token.length > 0,
        startDate,
        endDate,
        agentId,
        bodyText: "",
        error: String(err && err.message ? err.message : err),
      };
    }
  })()`;
}

function buildFetchBuyoutGradingsExpression(
  customers: readonly string[],
  startDate: string,
  _endDate: string,
  agentId: string,
): string {
  return `(async () => {
    let token = (sessionStorage.getItem("token") || "").trim();
    const rawCreds = sessionStorage.getItem("credentials");
    try {
      if (!token && rawCreds) {
        const parsed = JSON.parse(rawCreds);
        if (parsed && typeof parsed.code === "string") token = parsed.code.trim();
      }
    } catch {}
    const jsonHeaders = {
      "accept": "*/*",
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
    };
    if (token) {
      jsonHeaders["authorization"] = "Bearer " + token;
    }

    const out = {};
    const customers = ${JSON.stringify(customers)};
    const batchSize = 16;
    for (let i = 0; i < customers.length; i += batchSize) {
      const slice = customers.slice(i, i + batchSize);
      await Promise.all(slice.map(async (cid) => {
        const payload = {
          customerID: cid,
          date: ${JSON.stringify(startDate)},
          operation: "getTransactions",
          RRO: 1,
          agentID: ${JSON.stringify(agentId)},
          agentOwner: ${JSON.stringify(agentId)},
        };
        try {
          const res = await fetch("/cloud/api/Report/getTransactions", {
            method: "POST",
            credentials: "include",
            headers: jsonHeaders,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
          });
          const text = await res.text();
          const safeText = text
            .replace(/"Password"\\s*:\\s*"[^"]*"/g, '"Password":"[REDACTED]"')
            .replace(/"CCNumber"\\s*:\\s*"[^"]*"/g, '"CCNumber":"[REDACTED]"')
            .replace(/"CCExpires"\\s*:\\s*"[^"]*"/g, '"CCExpires":"[REDACTED]"')
            .replace(/"CCApproval"\\s*:\\s*"[^"]*"/g, '"CCApproval":"[REDACTED]"');
          let rows = [];
          try {
            const parsed = JSON.parse(safeText);
            if (parsed && Array.isArray(parsed.LIST)) {
              rows = parsed.LIST;
            } else if (parsed && parsed.LIST && Array.isArray(parsed.LIST.INFO)) {
              rows = parsed.LIST.INFO;
            }
          } catch {}
          const buyoutRows = rows.filter(r => {
            const desc = String((r && (r.ShortDesc || r.Description)) || "").trim();
            return /buyout/i.test(desc);
          });
          out[cid] = { status: res.status, count: rows.length, rows: buyoutRows };
        } catch (err) {
          out[cid] = { status: 0, count: 0, rows: [], error: String(err) };
        }
      }));
    }
    return out;
  })()`;
}

async function main(): Promise<void> {
  const warmed = warmCaptureNetwork(base);
  const pf = await preflight(warmed.host, {
    port: warmed.port,
    timeoutMs: 10_000,
    skipDnsPrefetch: true,
  });
  if (!pf.ok) {
    throw new Error(`preflight failed: ${pf.error}`);
  }

  let agentId = await resolveAgentId();
  using _lock = profile.trim() === "" ? null : acquireProfileLock(profile);

  await using view = ManagedWebView.launch({
    backend,
    dataStoreDir: profile,
    width: 1440,
    height: 900,
  });

  const outcome = await loginF402(view, {
    baseUrl: base,
    timeoutMs: 180_000,
    loginKind: "agent",
  });
  if (agentId === "" && outcome.agentId !== "") agentId = outcome.agentId;

  await view.waitForLoad();
  const credCheck = (await view.evaluate(
    buildWaitForCredentialsExpression(),
  )) as {
    ok: boolean;
    origin: string;
    href?: string;
    title?: string;
    sessionKeys?: string[];
    bodySnippet?: string;
    agentId: string;
  };
  if (agentId === "" && credCheck.agentId !== "") agentId = credCheck.agentId;
  await view.evaluate(buildDnsPrefetchExpression(base));

  console.error(
    `[capture:deleted-45d] signed in on ${backend} (${JSON.stringify(credCheck)}); querying getDeleteWager for last ${days} days...`,
  );

  const rawResp = (await view.evaluate(
    buildFetchDeleteWagerExpression(days, agentId),
  )) as InPageDeleteWagerResponse;

  if (rawResp.status < 200 || rawResp.status >= 300) {
    throw new Error(
      `getDeleteWager returned HTTP ${rawResp.status} (origin=${rawResp.origin}, tokenPresent=${rawResp.tokenPresent}): ${rawResp.error ?? rawResp.bodyText.slice(0, 200)}`,
    );
  }

  const envelope = parseDeletedWagerEnvelope(JSON.parse(rawResp.bodyText));
  const redacted = redactDeletedWagerEnvelope(envelope);
  const targets = targetsFromEnvelope(redacted);

  // Group legs by ticketNumber and classify BUYOUT vs operator/system delete
  const byTicket = new Map<string, DeletedWagerLegRow[]>();
  for (const leg of redacted.INFO.LIST) {
    const t = String(leg.TicketNumber ?? "").trim();
    if (!t) continue;
    const arr = byTicket.get(t) ?? [];
    arr.push(leg);
    byTicket.set(t, arr);
  }

  const buyoutCustomers = new Set<string>();
  for (const legs of byTicket.values()) {
    const first = legs[0];
    if (!first) continue;
    const deletedBy = String(first.LoginID ?? first.DeletedBy ?? "").trim();
    if (deletedBy.toUpperCase().includes("BUYOUT")) {
      const cid = String(
        first.customerID ?? first.CustomerID ?? first.Login ?? "",
      ).trim();
      const login = String(first.Login ?? "").trim();
      if (cid) buyoutCustomers.add(cid);
      if (login) buyoutCustomers.add(login);
    }
  }

  console.error(
    `[capture:deleted-45d] getDeleteWager HTTP ${rawResp.status}: ${redacted.INFO.LIST.length} legs across ${targets.length} unique tickets (${buyoutCustomers.size} customer IDs with BUYOUT tickets). Fetching getGrading(graded=3) for buyout ledger reconciliation...`,
  );

  const gradingByCustomer =
    buyoutCustomers.size > 0
      ? ((await view.evaluate(
          buildFetchBuyoutGradingsExpression(
            [...buyoutCustomers],
            rawResp.startDate,
            rawResp.endDate,
            rawResp.agentId || agentId,
          ),
        )) as Record<
          string,
          {
            status: number;
            count: number;
            rows: InPageGradingRow[];
            error?: string;
          }
        >)
      : {};

  // Index any "Buyout ... ticket <ticketNumber>" rows from getGrading
  const buyoutLedgerByTicket = new Map<
    string,
    {
      customerId: string;
      documentNumber: number | string | null;
      tranDateTime: string | null;
      tranCode: string | null;
      tranType: string | null;
      amountCents: number | null;
      amountDollars: number | null;
      shortDesc: string;
    }
  >();

  for (const [cid, result] of Object.entries(gradingByCustomer)) {
    for (const row of result.rows ?? []) {
      const desc = String(row.ShortDesc ?? row.Description ?? "").trim();
      if (!/buyout/i.test(desc)) continue;
      const m = desc.match(/ticket\s*#?\s*(\d+)/i) ?? desc.match(/(\d{7,})/);
      const ticketNum = m?.[1] ?? "";
      const rawAmt = Number(
        row.Amount ?? row.AmountWon ?? row.AmountLost ?? NaN,
      );
      const amtCents = Number.isFinite(rawAmt) ? rawAmt : null;
      const resolvedCid = cid.startsWith("__HIERARCHY")
        ? String(row.CustomerID ?? "").trim() || cid
        : cid;
      if (ticketNum) {
        buyoutLedgerByTicket.set(ticketNum, {
          customerId: resolvedCid,
          documentNumber: row.DocumentNumber ?? null,
          tranDateTime: row.TranDateTime ?? null,
          tranCode: row.TranCode ?? null,
          tranType: row.TranType ?? null,
          amountCents: amtCents,
          amountDollars: amtCents !== null ? amtCents / 100 : null,
          shortDesc: desc,
        });
      }
    }
  }

  // Build detailed ticket summaries
  const ticketSummaries = [...byTicket.entries()]
    .map(([ticketNumber, legs]) => {
      const first = legs[0]!;
      const customerId = String(
        first.customerID ?? first.CustomerID ?? first.Login ?? "",
      ).trim();
      const login = String(first.Login ?? customerId).trim();
      const deletedBy = String(first.LoginID ?? first.DeletedBy ?? "").trim();
      const isBuyout = deletedBy.toUpperCase().includes("BUYOUT");
      const riskCents = Number(first.AmountWagered ?? 0);
      const toWinCents = Number(first.ToWinAmount ?? 0);
      const totalPicks = Number(first.totalPicks ?? legs.length);
      let wonLegs = 0;
      let lostLegs = 0;
      let pushLegs = 0;
      let pendingLegs = 0;
      for (const l of legs) {
        const out = String(l.Outcome ?? l.WagerStatus ?? "P")
          .trim()
          .toUpperCase();
        if (out === "W") wonLegs++;
        else if (out === "L") lostLegs++;
        else if (out === "X") pushLegs++;
        else pendingLegs++;
      }
      const ledger = buyoutLedgerByTicket.get(ticketNumber) ?? null;
      return {
        ticketNumber,
        customerId,
        login,
        kind: isBuyout ? ("BUYOUT" as const) : ("DELETED" as const),
        deletedBy,
        acceptedDateTime: String(first.AcceptedDateTime ?? "").trim() || null,
        deleteDateTime:
          String(first.DeleteDateTime ?? first.TranDateTime ?? "").trim() ||
          null,
        wagerType: String(first.WagerType ?? "").trim(),
        parlayName:
          String((first as Record<string, unknown>).ParlayName ?? "").trim() ||
          null,
        riskDollars: Number.isFinite(riskCents) ? riskCents / 100 : null,
        toWinDollars: Number.isFinite(toWinCents) ? toWinCents / 100 : null,
        totalPicks,
        legCountReturned: legs.length,
        legBreakdown: {
          won: wonLegs,
          lost: lostLegs,
          push: pushLegs,
          pendingAtDelete: pendingLegs,
        },
        buyoutLedgerCredit: ledger,
        legs: legs.map((l) => {
          const rec = l as Record<string, unknown>;
          return {
            itemNumber: Number(rec.ItemNumber ?? 0),
            wagerNumber: Number(l.WagerNumber ?? 1),
            sportType: String(rec.SportType ?? "").trim(),
            sportSubType: String(rec.SportSubType ?? "").trim(),
            periodDescription: String(rec.PeriodDescription ?? "").trim(),
            legWagerType: String(rec.LegWagerType ?? l.WagerType ?? "").trim(),
            chosenTeamId: String(rec.ChosenTeamID ?? "").trim(),
            team1Id: String(rec.Team1ID ?? "").trim(),
            team2Id: String(rec.Team2ID ?? "").trim(),
            adjSpread: rec.AdjSpread ?? null,
            adjTotalPoints: rec.AdjTotalPoints ?? null,
            totalPointsOU: rec.TotalPointsOU ?? null,
            finalMoney: rec.FinalMoney ?? null,
            gameDateTime: String(rec.GameDateTime ?? "").trim() || null,
            outcomeAtCapture: String(rec.Outcome ?? "").trim(),
            wagerStatus: String(l.WagerStatus ?? "").trim(),
            team1FinalScore: rec.Team1FinalScore ?? null,
            team2FinalScore: rec.Team2FinalScore ?? null,
            description: String(l.Description ?? "").trim(),
          };
        }),
      };
    })
    .sort((a, b) =>
      String(b.deleteDateTime ?? "").localeCompare(
        String(a.deleteDateTime ?? ""),
      ),
    );

  const buyoutTickets = ticketSummaries.filter((t) => t.kind === "BUYOUT");
  const deletedTickets = ticketSummaries.filter((t) => t.kind === "DELETED");

  const summaryPayload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    lookbackDays: days,
    windowStart: rawResp.startDate,
    windowEnd: rawResp.endDate,
    counts: {
      totalLegs: redacted.INFO.LIST.length,
      uniqueTickets: ticketSummaries.length,
      buyoutTickets: buyoutTickets.length,
      operatorOrSystemDeletedTickets: deletedTickets.length,
      buyoutLedgerMatched: buyoutLedgerByTicket.size,
    },
    buyoutTickets,
    deletedTickets,
  };

  for (const p of [outRedacted, outTargets, outSummary]) {
    await mkdir(dirname(resolve(root, p)), { recursive: true });
  }

  await writeFile(
    resolve(root, outRedacted),
    `${JSON.stringify(redacted, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(root, outTargets),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capturedAt: summaryPayload.capturedAt,
        lookbackDays: days,
        windowStart: rawResp.startDate,
        windowEnd: rawResp.endDate,
        targets,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    resolve(root, outSummary),
    `${JSON.stringify(summaryPayload, null, 2)}\n`,
    "utf8",
  );

  // Also mirror to /Users/nolarose/code/sportsdesk-ops/scratch/f402-deleted-wagers if it exists
  const mainScratchDir =
    "/Users/nolarose/code/sportsdesk-ops/scratch/f402-deleted-wagers";
  try {
    await mkdir(mainScratchDir, { recursive: true });
    await writeFile(
      join(mainScratchDir, "envelope.redacted.json"),
      `${JSON.stringify(redacted, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mainScratchDir, "probe-targets.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          capturedAt: summaryPayload.capturedAt,
          lookbackDays: days,
          windowStart: rawResp.startDate,
          windowEnd: rawResp.endDate,
          targets,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(mainScratchDir, "summary-45d.json"),
      `${JSON.stringify(summaryPayload, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Ignore if main checkout path is not writable.
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        windowStart: rawResp.startDate,
        windowEnd: rawResp.endDate,
        counts: summaryPayload.counts,
        outRedacted: resolve(root, outRedacted),
        outTargets: resolve(root, outTargets),
        outSummary: resolve(root, outSummary),
      },
      null,
      2,
    ),
  );
}

await main();
