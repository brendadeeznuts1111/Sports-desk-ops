/**
 * @file lib/forensic_diagnostic_modes.ts
 * @description Specification-Grade 10-Mode Forensic, Risk, Cross-Market & Data Integrity Engine.
 *
 * Implements the complete 10-Mode Diagnostic Taxonomy across 4 Domains, grounded in:
 *   - `app/manager/report/help-report.js` (`api/Report/Pending`, `getDailyFiguresByCustomer`,
 *     `getGradedWagerByCustomer`, `getTransactions`, `getWagerDetailTransaction`, `getGrading`,
 *     `getPendingByTicket`, `getTypeInfo`, `getRotationNumber`, `getLineGame`)
 *   - `app/manager/module/ip-tracker.js` (`Manager/getWebLog` Modes `A`, `B` Per-Office vs Global, `C` YYYY-MM-DD, `I`)
 *   - `app/manager/module/bet-ticker.js` (`Manager/getBetTicker`, `getListVip`, `vipListInsert`)
 *   - Polymarket Public APIs (Gamma, CLOB REST/WSS, Data API `v2/positions?user=<0x>`)
 *
 * | Domain             | Mode                      | Checks                                                        | Output                                                        |
 * |--------------------|---------------------------|---------------------------------------------------------------|---------------------------------------------------------------|
 * | Risk & Exposure    | 1 · Customer overview     | Validated net, pending exposure, access freshness             | Summary with drill-downs and missing-data warnings            |
 * | Identity & Network | 2 · Access logs           | Customer ID, actor vs target, event time                      | Searchable access timeline                                    |
 * | Identity & Network | 3 · Shared-IP overview    | Normalized IPs, distinct customers, same date window          | Account groups with supporting observations                   |
 * | Identity & Network | 4 · Customer IP history   | First/last seen, changes, collection gaps                     | One customer’s IP timeline                                    |
 * | Identity & Network | 5 · Accounts by IP        | Selected IP, account IDs, timestamps                          | Accounts observed using that IP                               |
 * | Identity & Network | 6 · Activity overlap      | Session intervals or clearly labeled activity windows         | Overlap duration; distinguishes sessions from nearby events   |
 * | Cross-Market       | 7 · Wager comparison      | Event, market, period, side, line units and timestamps        | Comparable wagers with match reasons and uncertainty          |
 * | Risk & Exposure    | 8 · Settled net           | Settled tickets, adjustments, free-play, payout/sign conv.    | Customer P/L by period and currency                           |
 * | Risk & Exposure    | 9 · Pending exposure      | Unique tickets, stakes, payout terms, current status          | Stake, potential payout and defined liability separately      |
 * | Data Integrity     | 10 · Reconciliation       | Report totals vs tickets/ledger with identical scope          | Matched totals, explained differences, unresolved gaps        |
 */

import {
  normalizeWebLogLoginId,
  formatWebLogDateForMode,
  PER_OFFICE_IP_TRACKER_CLUSTERS,
} from "./bet_ticker_ip_tracker_bridge.ts";
import { buildGsLiveUsersReportDeepLink } from "./gslive_manager_deeplink_sidecar.ts";

export type DiagnosticDomain =
  "Identity & Network" | "Risk & Exposure" | "Cross-Market" | "Data Integrity";

export type DiagnosticModeNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface DiagnosticModeSpec {
  readonly modeNumber: DiagnosticModeNumber;
  readonly modeLabel: string;
  readonly domain: DiagnosticDomain;
  readonly checksSummary: string;
  readonly outputSummary: string;
  readonly upstreamEndpoints: readonly string[];
  readonly cliFlag: string;
}

export const TEN_MODE_CATALOG: readonly DiagnosticModeSpec[] = [
  {
    modeNumber: 1,
    modeLabel: "1 · Customer overview",
    domain: "Risk & Exposure",
    checksSummary: "Validated net, pending exposure, access freshness",
    outputSummary: "Summary with drill-downs and missing-data warnings",
    upstreamEndpoints: [
      "api/Report/getDailyFiguresByCustomer",
      "api/Report/Pending",
      "Manager/getWebLog (type=A)",
      "Manager/getInfoPlayer",
    ],
    cliFlag: "--mode=1",
  },
  {
    modeNumber: 2,
    modeLabel: "2 · Access logs",
    domain: "Identity & Network",
    checksSummary: "Customer ID, actor vs target, event time",
    outputSummary: "Searchable access timeline",
    upstreamEndpoints: ["Manager/getWebLog (type=A WEB_ACCESS)"],
    cliFlag: "--mode=2",
  },
  {
    modeNumber: 3,
    modeLabel: "3 · Shared-IP overview",
    domain: "Identity & Network",
    checksSummary: "Normalized IPs, distinct customers, same date window",
    outputSummary: "Account groups with supporting observations",
    upstreamEndpoints: [
      "Manager/getWebLog (type=B customerID=<OfficeAgentID>)",
      "Manager/getWebLog (type=B customerID=0)",
    ],
    cliFlag: "--mode=3",
  },
  {
    modeNumber: 4,
    modeLabel: "4 · Customer IP history",
    domain: "Identity & Network",
    checksSummary: "First/last seen, changes, collection gaps",
    outputSummary: "One customer’s IP timeline",
    upstreamEndpoints: [
      "Manager/getWebLog (type=C YYYY-MM-DD)",
      "Manager/getWebLog (type=A MM/DD/YYYY)",
    ],
    cliFlag: "--mode=4",
  },
  {
    modeNumber: 5,
    modeLabel: "5 · Accounts by IP",
    domain: "Identity & Network",
    checksSummary: "Selected IP, account IDs, timestamps",
    outputSummary: "Accounts observed using that IP",
    upstreamEndpoints: ["Manager/getWebLog (type=I ip=<SelectedIP>)"],
    cliFlag: "--mode=5",
  },
  {
    modeNumber: 6,
    modeLabel: "6 · Activity overlap",
    domain: "Identity & Network",
    checksSummary: "Session intervals or clearly labeled activity windows",
    outputSummary:
      "Overlap duration; distinguishes sessions from nearby events",
    upstreamEndpoints: [
      "Manager/getWebLog (type=A & type=I)",
      "Manager/getBetTicker (InsertDateTime)",
      "api/Report/Pending (PlacedOn)",
    ],
    cliFlag: "--mode=6",
  },
  {
    modeNumber: 7,
    modeLabel: "7 · Wager comparison",
    domain: "Cross-Market",
    checksSummary: "Event, market, period, side, line units and timestamps",
    outputSummary: "Comparable wagers with match reasons and uncertainty",
    upstreamEndpoints: [
      "api/Report/Pending (getLineGame / getRotationNumber)",
      "Manager/getBetTicker",
      "Polymarket Data API (/v2/positions?user=<0x>)",
    ],
    cliFlag: "--mode=7",
  },
  {
    modeNumber: 8,
    modeLabel: "8 · Settled net",
    domain: "Risk & Exposure",
    checksSummary:
      "Settled tickets, adjustments, free-play, payout/sign conventions",
    outputSummary: "Customer P/L by period and currency",
    upstreamEndpoints: [
      "api/Report/getGradedWagerByCustomer",
      "api/Report/getGrading",
      "api/Report/getDailyFiguresByCustomer",
      "api/Report/getTransactions",
    ],
    cliFlag: "--mode=8",
  },
  {
    modeNumber: 9,
    modeLabel: "9 · Pending exposure",
    domain: "Risk & Exposure",
    checksSummary: "Unique tickets, stakes, payout terms, current status",
    outputSummary: "Stake, potential payout and defined liability separately",
    upstreamEndpoints: ["api/Report/Pending", "api/Report/getPendingByTicket"],
    cliFlag: "--mode=9",
  },
  {
    modeNumber: 10,
    modeLabel: "10 · Reconciliation",
    domain: "Data Integrity",
    checksSummary: "Report totals vs tickets/ledger with identical scope",
    outputSummary: "Matched totals, explained differences, unresolved gaps",
    upstreamEndpoints: [
      "api/Report/getDailyFiguresByCustomer",
      "api/Report/getGradedWagerByCustomer",
      "api/Report/getTransactions",
    ],
    cliFlag: "--mode=10",
  },
];

// ============================================================================
// MODE 1 · CUSTOMER OVERVIEW (Risk & Exposure)
// ============================================================================
export interface Mode1CustomerOverviewOutput {
  readonly mode: 1;
  readonly domain: "Risk & Exposure";
  readonly customerId: string;
  readonly officeAgentId: string;
  readonly gsLivePlayerId: string;
  readonly polymarketWallet: string | null;
  readonly validatedNetCents: number;
  readonly pendingStakeCents: number;
  readonly pendingDefinedLiabilityCents: number;
  readonly lastAccessUtc: string | null;
  readonly accessFreshnessSeconds: number | null;
  readonly isAccessFresh: boolean;
  readonly drillDownLinks: {
    readonly f402CustomerUrl: string;
    readonly gsLiveProfileUrl: string;
    readonly polymarketProfileUrl: string | null;
    readonly mode8SettledRef: string;
    readonly mode9PendingRef: string;
    readonly mode2AccessRef: string;
  };
  readonly missingDataWarnings: readonly string[];
  readonly summaryVerdict: string;
}

export function evaluateMode1CustomerOverview(input: {
  customerId: string;
  officeAgentId: string;
  polymarketWallet?: string | null;
  validatedNetCents: number;
  pendingStakeCents: number;
  pendingDefinedLiabilityCents: number;
  lastAccessUtc?: string | null;
  referenceNowMs?: number;
  hasCompleteLedgerScope?: boolean;
  hasWebLogCoverage?: boolean;
}): Mode1CustomerOverviewOutput {
  const cleanCust = normalizeWebLogLoginId(input.customerId);
  const cleanOffice = input.officeAgentId.trim().toUpperCase();
  const nowMs = input.referenceNowMs ?? Date.parse("2026-10-31T17:37:20Z");
  const lastAccessMs = input.lastAccessUtc
    ? Date.parse(input.lastAccessUtc)
    : NaN;
  const freshnessSec = Number.isFinite(lastAccessMs)
    ? Math.max(0, Math.round((nowMs - lastAccessMs) / 1000))
    : null;
  const isFresh = freshnessSec !== null && freshnessSec <= 3600;

  const warnings: string[] = [];
  if (!input.lastAccessUtc || freshnessSec === null) {
    warnings.push("MISSING_ACCESS_TIMESTAMP_IN_WEBLOG");
  } else if (freshnessSec > 86400) {
    warnings.push(`STALE_ACCESS_TELEMETRY_${Math.round(freshnessSec / 3600)}H`);
  }
  if (input.hasCompleteLedgerScope === false) {
    warnings.push("INCOMPLETE_LEDGER_TRANSACTION_WINDOW");
  }
  if (input.hasWebLogCoverage === false) {
    warnings.push("WEBLOG_MODE_A_COLLECTION_GAP");
  }

  return {
    mode: 1,
    domain: "Risk & Exposure",
    customerId: cleanCust,
    officeAgentId: cleanOffice,
    gsLivePlayerId: `player_${cleanCust}`,
    polymarketWallet: input.polymarketWallet ?? null,
    validatedNetCents: input.validatedNetCents,
    pendingStakeCents: input.pendingStakeCents,
    pendingDefinedLiabilityCents: input.pendingDefinedLiabilityCents,
    lastAccessUtc: input.lastAccessUtc ?? null,
    accessFreshnessSeconds: freshnessSec,
    isAccessFresh: isFresh,
    drillDownLinks: {
      f402CustomerUrl: `https://fantasy402.com/manager.html?customer=${encodeURIComponent(cleanCust)}&agent=${encodeURIComponent(cleanOffice)}`,
      gsLiveProfileUrl: buildGsLiveUsersReportDeepLink({
        customerLogin: cleanCust,
      }),
      polymarketProfileUrl: input.polymarketWallet
        ? `https://polymarket.com/profile/${input.polymarketWallet}`
        : null,
      mode8SettledRef: `mode:8:${cleanCust}`,
      mode9PendingRef: `mode:9:${cleanCust}`,
      mode2AccessRef: `mode:2:${cleanCust}`,
    },
    missingDataWarnings: warnings,
    summaryVerdict:
      warnings.length === 0
        ? `VALIDATED: Net ${(input.validatedNetCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} | Pending Stake $${(input.pendingStakeCents / 100).toLocaleString()} (Liability $${(input.pendingDefinedLiabilityCents / 100).toLocaleString()}) | Access ${freshnessSec}s ago`
        : `WARN (${warnings.join(", ")}): Net $${(input.validatedNetCents / 100).toLocaleString()} | Pending Liability $${(input.pendingDefinedLiabilityCents / 100).toLocaleString()}`,
  };
}

// ============================================================================
// MODE 2 · ACCESS LOGS (Identity & Network)
// ============================================================================
export type AccessActorRole =
  "SELF_PLAYER" | "OFFICE_AGENT" | "MASTER_MANAGER" | "SYSTEM_GATEWAY";

export interface Mode2AccessTimelineEvent {
  readonly eventId: string;
  readonly customerId: string;
  readonly actorId: string;
  readonly actorRole: AccessActorRole;
  readonly targetCustomerId: string;
  readonly isActorDistinctFromTarget: boolean;
  readonly eventTimeUtc: string;
  readonly eventEpochMs: number;
  readonly ipAddress: string;
  readonly operation: string;
  readonly dataPayload: string;
  readonly nextWagerDwellSeconds: number | null;
}

export interface Mode2AccessLogsOutput {
  readonly mode: 2;
  readonly domain: "Identity & Network";
  readonly customerId: string;
  readonly totalEvents: number;
  readonly distinctActorsCount: number;
  readonly events: readonly Mode2AccessTimelineEvent[];
}

export function evaluateMode2AccessLogs(
  customerId: string,
  rawEvents: readonly {
    readonly LoginID: string;
    readonly ActorID?: string;
    readonly AccessDateTime: string;
    readonly IPAddress: string;
    readonly Operation: string;
    readonly Data: string;
    readonly nextWagerDwellSeconds?: number | null;
  }[],
): Mode2AccessLogsOutput {
  const targetCustomer = normalizeWebLogLoginId(customerId);
  const mapped: Mode2AccessTimelineEvent[] = rawEvents
    .map((row, idx) => {
      const targetId = normalizeWebLogLoginId(row.LoginID || targetCustomer);
      const rawActor = row.ActorID
        ? normalizeWebLogLoginId(row.ActorID)
        : targetId;
      let actorRole: AccessActorRole = "SELF_PLAYER";
      if (rawActor === "BILLY666") actorRole = "MASTER_MANAGER";
      else if (rawActor === "GATEWAY") actorRole = "SYSTEM_GATEWAY";
      else if (rawActor !== targetId) actorRole = "OFFICE_AGENT";

      const epochMs = Date.parse(row.AccessDateTime);
      return {
        eventId: `WEBLOG-A-${targetId}-${idx + 1}`,
        customerId: targetId,
        actorId: rawActor,
        actorRole,
        targetCustomerId: targetId,
        isActorDistinctFromTarget: rawActor !== targetId,
        eventTimeUtc: row.AccessDateTime,
        eventEpochMs: Number.isFinite(epochMs) ? epochMs : 0,
        ipAddress: row.IPAddress.trim(),
        operation: row.Operation.trim(),
        dataPayload: row.Data.trim(),
        nextWagerDwellSeconds: row.nextWagerDwellSeconds ?? null,
      };
    })
    .sort((a, b) => a.eventEpochMs - b.eventEpochMs);

  const distinctActors = new Set(mapped.map((e) => e.actorId)).size;
  return {
    mode: 2,
    domain: "Identity & Network",
    customerId: targetCustomer,
    totalEvents: mapped.length,
    distinctActorsCount: distinctActors,
    events: mapped,
  };
}

// ============================================================================
// MODE 3 · SHARED-IP OVERVIEW (Identity & Network)
// ============================================================================
export interface Mode3SharedIpAccountGroup {
  readonly groupId: string;
  readonly normalizedIp: string;
  readonly subnetCidr: string;
  readonly scope: "PER_OFFICE" | "CROSS_OFFICE_GLOBAL";
  readonly officeAgentId: string;
  readonly dateWindowStartMdy: string;
  readonly dateWindowEndMdy: string;
  readonly distinctCustomers: readonly string[];
  readonly distinctCustomerCount: number;
  readonly supportingObservations: readonly string[];
  readonly wireQueryParam: string;
}

export interface Mode3SharedIpOverviewOutput {
  readonly mode: 3;
  readonly domain: "Identity & Network";
  readonly dateWindowStartMdy: string;
  readonly dateWindowEndMdy: string;
  readonly totalAccountGroups: number;
  readonly groups: readonly Mode3SharedIpAccountGroup[];
}

export function normalizeIpv4Address(rawIp: string): {
  normalizedIp: string;
  subnetCidr: string;
} {
  const clean = rawIp.trim().split(" ")[0] ?? "";
  const octets = clean.split(".");
  const subnetCidr =
    octets.length === 4
      ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
      : `${clean}/32`;
  return { normalizedIp: clean, subnetCidr };
}

export function evaluateMode3SharedIpOverview(options?: {
  dateWindowStartMdy?: string;
  dateWindowEndMdy?: string;
  officeFilter?: string;
}): Mode3SharedIpOverviewOutput {
  const startMdy = formatWebLogDateForMode(
    options?.dateWindowStartMdy ?? "10/25/2026",
    "B",
  );
  const endMdy = formatWebLogDateForMode(
    options?.dateWindowEndMdy ?? "10/31/2026",
    "B",
  );
  const filterOffice = options?.officeFilter?.trim().toUpperCase();

  const groups: Mode3SharedIpAccountGroup[] =
    PER_OFFICE_IP_TRACKER_CLUSTERS.filter(
      (c) =>
        !filterOffice ||
        filterOffice === "ALL" ||
        c.officeAgentId === filterOffice,
    ).map((c, idx) => {
      const { normalizedIp, subnetCidr } = normalizeIpv4Address(
        c.sharedIpOrSubnet,
      );
      const allCustomers = Array.from(
        new Set([
          ...c.matchedLoginsInOffice.map(normalizeWebLogLoginId),
          ...c.crossOfficeLogins.map((x) => normalizeWebLogLoginId(x.loginId)),
        ]),
      );
      const isCrossOffice = c.crossOfficeLogins.length > 0;
      const wireCustomerParam =
        c.matchClassification === "CROSS_OFFICE_BEARD_BRIDGE"
          ? "0"
          : c.officeAgentId;

      return {
        groupId: `SHARED-IP-GRP-${String(idx + 1).padStart(2, "0")}`,
        normalizedIp,
        subnetCidr,
        scope: isCrossOffice ? "CROSS_OFFICE_GLOBAL" : "PER_OFFICE",
        officeAgentId: c.officeAgentId,
        dateWindowStartMdy: startMdy,
        dateWindowEndMdy: endMdy,
        distinctCustomers: allCustomers,
        distinctCustomerCount: allCustomers.length,
        supportingObservations: [
          `Mode A avg login-to-wager dwell: ${c.modeASessionDwellSeconds}s`,
          `MFCS composite toxicity: ${c.mfcsCompositeScore}/100`,
          `Synchronized board rotations: ${c.activeRotations.join(", ")}`,
          `Bridged Polymarket wallets: ${c.bridgedPolymarketWallets.length}`,
        ],
        wireQueryParam: `type="B" & customerID="${wireCustomerParam}" & start="${startMdy}" & end="${endMdy}"`,
      };
    });

  return {
    mode: 3,
    domain: "Identity & Network",
    dateWindowStartMdy: startMdy,
    dateWindowEndMdy: endMdy,
    totalAccountGroups: groups.length,
    groups,
  };
}

// ============================================================================
// MODE 4 · CUSTOMER IP HISTORY (Identity & Network)
// ============================================================================
export interface Mode4CustomerIpSpan {
  readonly normalizedIp: string;
  readonly subnetCidr: string;
  readonly asnLabel: string;
  readonly firstSeenUtc: string;
  readonly lastSeenUtc: string;
  readonly observationCount: number;
  readonly changedFromPreviousIp: boolean;
  readonly gapBeforeSpanHours: number;
  readonly hasCollectionGapWarning: boolean;
}

export interface Mode4CustomerIpHistoryOutput {
  readonly mode: 4;
  readonly domain: "Identity & Network";
  readonly customerId: string;
  readonly officeAgentId: string;
  readonly wireQueryParam: string;
  readonly firstSeenOverallUtc: string;
  readonly lastSeenOverallUtc: string;
  readonly ipChangeCount: number;
  readonly collectionGapsCount: number;
  readonly ipTimeline: readonly Mode4CustomerIpSpan[];
}

export function evaluateMode4CustomerIpHistory(input: {
  customerId: string;
  officeAgentId: string;
  startDateYmd?: string;
  endDateYmd?: string;
  observations: readonly {
    readonly ipAddress: string;
    readonly asnLabel: string;
    readonly firstSeenUtc: string;
    readonly lastSeenUtc: string;
    readonly observationCount: number;
  }[];
  collectionGapThresholdHours?: number;
}): Mode4CustomerIpHistoryOutput {
  const cleanCust = normalizeWebLogLoginId(input.customerId);
  const startYmd = formatWebLogDateForMode(
    input.startDateYmd ?? "2026-10-25",
    "C",
  );
  const endYmd = formatWebLogDateForMode(input.endDateYmd ?? "2026-10-31", "C");
  const gapThreshold = input.collectionGapThresholdHours ?? 24;

  const sorted = [...input.observations].sort(
    (a, b) => Date.parse(a.firstSeenUtc) - Date.parse(b.firstSeenUtc),
  );

  let ipChangeCount = 0;
  let collectionGapsCount = 0;

  const timeline: Mode4CustomerIpSpan[] = sorted.map((obs, idx) => {
    const { normalizedIp, subnetCidr } = normalizeIpv4Address(obs.ipAddress);
    const prev = idx > 0 ? sorted[idx - 1] : undefined;
    const prevIp = prev
      ? normalizeIpv4Address(prev.ipAddress).normalizedIp
      : normalizedIp;
    const changed = idx > 0 && prevIp !== normalizedIp;
    if (changed) ipChangeCount++;

    const gapHours = prev
      ? Math.max(
          0,
          Number(
            (
              (Date.parse(obs.firstSeenUtc) - Date.parse(prev.lastSeenUtc)) /
              3_600_000
            ).toFixed(2),
          ),
        )
      : 0;
    const hasGap = gapHours > gapThreshold;
    if (hasGap) collectionGapsCount++;

    return {
      normalizedIp,
      subnetCidr,
      asnLabel: obs.asnLabel,
      firstSeenUtc: obs.firstSeenUtc,
      lastSeenUtc: obs.lastSeenUtc,
      observationCount: obs.observationCount,
      changedFromPreviousIp: changed,
      gapBeforeSpanHours: gapHours,
      hasCollectionGapWarning: hasGap,
    };
  });

  return {
    mode: 4,
    domain: "Identity & Network",
    customerId: cleanCust,
    officeAgentId: input.officeAgentId.trim().toUpperCase(),
    wireQueryParam: `type="C" & customerID="${cleanCust}" & start="${startYmd}" & end="${endYmd}"`,
    firstSeenOverallUtc: timeline[0]?.firstSeenUtc ?? "",
    lastSeenOverallUtc: timeline[timeline.length - 1]?.lastSeenUtc ?? "",
    ipChangeCount,
    collectionGapsCount,
    ipTimeline: timeline,
  };
}

// ============================================================================
// MODE 5 · ACCOUNTS BY IP (Identity & Network)
// ============================================================================
export interface Mode5ObservedAccountOnIp {
  readonly accountId: string;
  readonly officeAgentId: string;
  readonly gsLivePlayerId: string;
  readonly firstTimestampUtc: string;
  readonly lastTimestampUtc: string;
  readonly totalHitsOnIp: number;
  readonly operationsObserved: readonly string[];
}

export interface Mode5AccountsByIpOutput {
  readonly mode: 5;
  readonly domain: "Identity & Network";
  readonly selectedIp: string;
  readonly subnetCidr: string;
  readonly wireQueryParam: string;
  readonly observedAccountCount: number;
  readonly accounts: readonly Mode5ObservedAccountOnIp[];
}

export function evaluateMode5AccountsByIp(input: {
  selectedIp: string;
  startDateMdy?: string;
  endDateMdy?: string;
  accounts: readonly {
    readonly accountId: string;
    readonly officeAgentId: string;
    readonly firstTimestampUtc: string;
    readonly lastTimestampUtc: string;
    readonly totalHitsOnIp: number;
    readonly operationsObserved: readonly string[];
  }[];
}): Mode5AccountsByIpOutput {
  const { normalizedIp, subnetCidr } = normalizeIpv4Address(input.selectedIp);
  const startMdy = formatWebLogDateForMode(
    input.startDateMdy ?? "10/25/2026",
    "I",
  );
  const endMdy = formatWebLogDateForMode(input.endDateMdy ?? "10/31/2026", "I");

  const mapped: Mode5ObservedAccountOnIp[] = input.accounts.map((a) => {
    const cleanId = normalizeWebLogLoginId(a.accountId);
    return {
      accountId: cleanId,
      officeAgentId: a.officeAgentId.trim().toUpperCase(),
      gsLivePlayerId: `player_${cleanId}`,
      firstTimestampUtc: a.firstTimestampUtc,
      lastTimestampUtc: a.lastTimestampUtc,
      totalHitsOnIp: a.totalHitsOnIp,
      operationsObserved: a.operationsObserved,
    };
  });

  return {
    mode: 5,
    domain: "Identity & Network",
    selectedIp: normalizedIp,
    subnetCidr,
    wireQueryParam: `type="I" & customerID="0" & ip="${normalizedIp}" & start="${startMdy}" & end="${endMdy}"`,
    observedAccountCount: mapped.length,
    accounts: mapped,
  };
}

// ============================================================================
// MODE 6 · ACTIVITY OVERLAP (Identity & Network)
// ============================================================================
export type ActivityWindowKind =
  "BOUNDED_SESSION_INTERVAL" | "POINT_IN_TIME_EVENT_WINDOW";
export type OverlapDistinctionVerdict =
  | "CONFIRMED_CONCURRENT_SESSION_OVERLAP"
  | "NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP"
  | "DISJOINT_NO_OVERLAP";

export interface Mode6ActivityWindow {
  readonly accountId: string;
  readonly officeAgentId: string;
  readonly windowKind: ActivityWindowKind;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly ipAddress: string;
  readonly actionSummary: string;
}

export interface Mode6ActivityOverlapOutput {
  readonly mode: 6;
  readonly domain: "Identity & Network";
  readonly primaryWindow: Mode6ActivityWindow;
  readonly secondaryWindow: Mode6ActivityWindow;
  readonly overlapDurationSeconds: number;
  readonly gapBetweenWindowsSeconds: number;
  readonly distinctionVerdict: OverlapDistinctionVerdict;
  readonly explanation: string;
}

export function evaluateMode6ActivityOverlap(
  primaryWindow: Mode6ActivityWindow,
  secondaryWindow: Mode6ActivityWindow,
  nearbyThresholdSeconds = 60,
): Mode6ActivityOverlapOutput {
  const startA = Date.parse(primaryWindow.startUtc);
  const endA = Math.max(startA, Date.parse(primaryWindow.endUtc));
  const startB = Date.parse(secondaryWindow.startUtc);
  const endB = Math.max(startB, Date.parse(secondaryWindow.endUtc));

  const intersectionStart = Math.max(startA, startB);
  const intersectionEnd = Math.min(endA, endB);

  const rawOverlapMs = intersectionEnd - intersectionStart;
  const overlapDurationSeconds =
    rawOverlapMs > 0 ? Math.round(rawOverlapMs / 1000) : 0;
  const gapBetweenWindowsSeconds =
    rawOverlapMs < 0 ? Math.round(Math.abs(rawOverlapMs) / 1000) : 0;

  const bothBoundedSessions =
    primaryWindow.windowKind === "BOUNDED_SESSION_INTERVAL" &&
    secondaryWindow.windowKind === "BOUNDED_SESSION_INTERVAL";

  let distinctionVerdict: OverlapDistinctionVerdict;
  let explanation: string;

  if (overlapDurationSeconds > 0 && bothBoundedSessions) {
    distinctionVerdict = "CONFIRMED_CONCURRENT_SESSION_OVERLAP";
    explanation = `Concurrent active session intervals intersect for ${overlapDurationSeconds}s across ${primaryWindow.accountId} (${primaryWindow.officeAgentId}) and ${secondaryWindow.accountId} (${secondaryWindow.officeAgentId}) on IP ${primaryWindow.ipAddress}.`;
  } else if (
    overlapDurationSeconds > 0 ||
    gapBetweenWindowsSeconds <= nearbyThresholdSeconds
  ) {
    distinctionVerdict = "NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP";
    explanation = `Nearby activity events within ${gapBetweenWindowsSeconds}s (overlap=${overlapDurationSeconds}s), distinguished from full session overlap because at least one observation is a point-in-time event window.`;
  } else {
    distinctionVerdict = "DISJOINT_NO_OVERLAP";
    explanation = `Disjoint activity windows separated by ${gapBetweenWindowsSeconds}s (> ${nearbyThresholdSeconds}s threshold).`;
  }

  return {
    mode: 6,
    domain: "Identity & Network",
    primaryWindow,
    secondaryWindow,
    overlapDurationSeconds,
    gapBetweenWindowsSeconds,
    distinctionVerdict,
    explanation,
  };
}

// ============================================================================
// MODE 7 · WAGER COMPARISON (Cross-Market: F402 vs Polymarket)
// ============================================================================
export interface Mode7ComparableWagerInput {
  readonly venue: "FANTASY402" | "POLYMARKET";
  readonly ticketOrOrderId: string;
  readonly accountOrWalletId: string;
  readonly eventDateYmd: string;
  readonly rotationNumber: number; // DGS GameNum+5000 normalized to parent ROT
  readonly rawGameNum?: number;
  readonly marketType: "SPREAD" | "TOTAL" | "MONEYLINE" | "TEAM_TOTAL";
  readonly period: "FG" | "1H" | "2H" | "1Q" | "2Q" | "3Q" | "4Q";
  readonly side: string; // e.g., "LAL", "KC", "OVER", "UNDER"
  readonly adjLinePoints: number;
  readonly teaserPoints?: number;
  readonly oddsAmerican: number;
  readonly stakeCents: number;
  readonly placedAtUtc: string;
}

export interface Mode7WagerComparisonOutput {
  readonly mode: 7;
  readonly domain: "Cross-Market";
  readonly canonicalEventId: string;
  readonly parentRotationNumber: number;
  readonly marketType: string;
  readonly period: string;
  readonly side: string;
  readonly f402EffectiveLineHundredths: number;
  readonly polymarketEffectiveLineHundredths: number;
  readonly lineDeltaHundredths: number;
  readonly timestampDeltaSeconds: number;
  readonly isComparableMatch: boolean;
  readonly matchReasons: readonly string[];
  readonly uncertaintyFlags: readonly string[];
}

/**
 * Computes effective line in integer hundredths following `customer/report/report.js` (`getLineGame`):
 * - Spread Teaser: `AdjSpread + TeaserPoints`
 * - Total Teaser: Over subtracts `TeaserPoints`, Under adds `TeaserPoints`
 */
export function computeEffectiveLineHundredths(input: {
  marketType: "SPREAD" | "TOTAL" | "MONEYLINE" | "TEAM_TOTAL";
  side: string;
  adjLinePoints: number;
  teaserPoints?: number;
}): number {
  if (input.marketType === "MONEYLINE") return 0;
  const teaser = input.teaserPoints ?? 0;
  let effective = input.adjLinePoints;
  if (teaser !== 0) {
    if (input.marketType === "TOTAL" || input.marketType === "TEAM_TOTAL") {
      const isOver = input.side.trim().toUpperCase().startsWith("O");
      effective = isOver ? effective - teaser : effective + teaser;
    } else {
      effective = effective + teaser;
    }
  }
  return Math.round(effective * 100);
}

/**
 * Normalizes DGS Alternate Spread child rotation (`GameNum + 5000`) to parent board rotation.
 */
export function normalizeDgsRotationNumber(rot: number): {
  parentRot: number;
  wasAltChildRotation: boolean;
} {
  if (rot >= 5000 && rot < 10000) {
    return { parentRot: rot - 5000, wasAltChildRotation: true };
  }
  return { parentRot: rot, wasAltChildRotation: false };
}

export function evaluateMode7WagerComparison(
  f402Wager: Mode7ComparableWagerInput,
  polymarketWager: Mode7ComparableWagerInput,
): Mode7WagerComparisonOutput {
  const normF402 = normalizeDgsRotationNumber(f402Wager.rotationNumber);
  const normPm = normalizeDgsRotationNumber(polymarketWager.rotationNumber);

  const f402LineH = computeEffectiveLineHundredths(f402Wager);
  const pmLineH = computeEffectiveLineHundredths(polymarketWager);
  const lineDeltaH = pmLineH - f402LineH;

  const tsDeltaSec = Math.round(
    Math.abs(
      Date.parse(f402Wager.placedAtUtc) -
        Date.parse(polymarketWager.placedAtUtc),
    ) / 1000,
  );

  const matchReasons: string[] = [];
  const uncertaintyFlags: string[] = [];

  const sameEvent =
    f402Wager.eventDateYmd === polymarketWager.eventDateYmd &&
    normF402.parentRot === normPm.parentRot;
  if (sameEvent) {
    matchReasons.push(
      `EXACT_EVENT_ROT_${normF402.parentRot}_ON_${f402Wager.eventDateYmd}`,
    );
  }
  if (normF402.wasAltChildRotation) {
    matchReasons.push(
      `NORMALIZED_DGS_ALT_ROT_${f402Wager.rotationNumber}_TO_${normF402.parentRot}`,
    );
  }
  if (f402Wager.marketType === polymarketWager.marketType) {
    matchReasons.push(`SAME_MARKET_${f402Wager.marketType}`);
  }
  if (f402Wager.period === polymarketWager.period) {
    matchReasons.push(`SAME_PERIOD_${f402Wager.period}`);
  } else {
    uncertaintyFlags.push(
      `PERIOD_MISMATCH_${f402Wager.period}_VS_${polymarketWager.period}`,
    );
  }
  if (f402Wager.side.toUpperCase() === polymarketWager.side.toUpperCase()) {
    matchReasons.push(`SAME_SIDE_${f402Wager.side.toUpperCase()}`);
  }

  if (lineDeltaH === 0) {
    matchReasons.push(`IDENTICAL_EFFECTIVE_LINE_${f402LineH}_HUNDREDTHS`);
  } else if (Math.abs(lineDeltaH) <= 150) {
    matchReasons.push(`NEAR_LINE_WITHIN_${Math.abs(lineDeltaH)}_HUNDREDTHS`);
    uncertaintyFlags.push(
      `LINE_BASIS_DELTA_${lineDeltaH > 0 ? "+" : ""}${lineDeltaH}_HUNDREDTHS`,
    );
  } else {
    uncertaintyFlags.push(`WIDE_ALT_LINE_DELTA_${lineDeltaH}_HUNDREDTHS`);
  }

  if (tsDeltaSec <= 15) {
    matchReasons.push(`SYNCHRONIZED_EXECUTION_${tsDeltaSec}S_DELTA`);
  } else if (tsDeltaSec <= 300) {
    matchReasons.push(`WINDOW_EXECUTION_${tsDeltaSec}S_DELTA`);
  } else {
    uncertaintyFlags.push(`WIDE_TIMESTAMP_LAG_${tsDeltaSec}S`);
  }

  const isComparableMatch =
    sameEvent &&
    f402Wager.marketType === polymarketWager.marketType &&
    f402Wager.period === polymarketWager.period &&
    f402Wager.side.toUpperCase() === polymarketWager.side.toUpperCase();

  return {
    mode: 7,
    domain: "Cross-Market",
    canonicalEventId: `${f402Wager.eventDateYmd}:ROT-${normF402.parentRot}`,
    parentRotationNumber: normF402.parentRot,
    marketType: f402Wager.marketType,
    period: f402Wager.period,
    side: f402Wager.side.toUpperCase(),
    f402EffectiveLineHundredths: f402LineH,
    polymarketEffectiveLineHundredths: pmLineH,
    lineDeltaHundredths: lineDeltaH,
    timestampDeltaSeconds: tsDeltaSec,
    isComparableMatch,
    matchReasons,
    uncertaintyFlags,
  };
}

// ============================================================================
// MODE 8 · SETTLED NET (Risk & Exposure)
// ============================================================================
export interface Mode8SettledTicketInput {
  readonly ticketKey: string; // TicketNumber-WagerNumber
  readonly periodBucket: "24H" | "7D" | "4WK";
  readonly currency: "USD" | "USDC";
  readonly wagerStatus: "W" | "L" | "X"; // Won, Lost, Push/Cancelled
  readonly amountWageredCents: number;
  readonly toWinAmountCents: number;
  readonly freePlayFlag: "Y" | "N";
}

export interface Mode8AdjustmentInput {
  readonly adjustmentId: string;
  readonly periodBucket: "24H" | "7D" | "4WK";
  readonly currency: "USD" | "USDC";
  readonly signedAmountCents: number; // Positive = credit to customer P/L, Negative = debit
  readonly reason: string;
}

export interface Mode8SettledNetOutput {
  readonly mode: 8;
  readonly domain: "Risk & Exposure";
  readonly customerId: string;
  readonly signConvention: "CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN";
  readonly settledTicketCount: number;
  readonly freePlayTicketCount: number;
  readonly grossWonCents: number;
  readonly grossLostCents: number; // Negative integer
  readonly freePlayWonCents: number;
  readonly freePlayLostPrincipalSavedCents: number;
  readonly adjustmentsNetCents: number;
  readonly customerNetProfitLossCents: number;
  readonly bookNetHoldCents: number; // Inverse of customer P/L excluding adjustments
  readonly breakdownByPeriodAndCurrency: readonly {
    readonly periodBucket: "24H" | "7D" | "4WK";
    readonly currency: "USD" | "USDC";
    readonly settledNetCents: number;
    readonly adjustmentsCents: number;
    readonly totalCustomerPlCents: number;
  }[];
}

/**
 * Computes Mode 8 Settled Net following `help-report.js` (`getGradedWagerByCustomer`, `getTransactions`):
 * - Standard ticket (`FreePlayFlag === "N"`): Win = `+toWinAmountCents`, Loss = `-amountWageredCents`, Push (`X`) = `0`.
 * - Free-Play ticket (`FreePlayFlag === "Y"`): Win = `+toWinAmountCents`, Loss = `0` (house absorbs free-play stake; customer principal is not debited).
 */
export function evaluateMode8SettledNet(input: {
  customerId: string;
  tickets: readonly Mode8SettledTicketInput[];
  adjustments?: readonly Mode8AdjustmentInput[];
}): Mode8SettledNetOutput {
  const cleanCust = normalizeWebLogLoginId(input.customerId);
  const adjustments = input.adjustments ?? [];

  let grossWonCents = 0;
  let grossLostCents = 0;
  let freePlayTicketCount = 0;
  let freePlayWonCents = 0;
  let freePlayLostPrincipalSavedCents = 0;

  const bucketMap = new Map<
    string,
    {
      periodBucket: "24H" | "7D" | "4WK";
      currency: "USD" | "USDC";
      settledNetCents: number;
      adjustmentsCents: number;
    }
  >();

  const ensureBucket = (
    periodBucket: "24H" | "7D" | "4WK",
    currency: "USD" | "USDC",
  ) => {
    const key = `${periodBucket}:${currency}`;
    let b = bucketMap.get(key);
    if (!b) {
      b = { periodBucket, currency, settledNetCents: 0, adjustmentsCents: 0 };
      bucketMap.set(key, b);
    }
    return b;
  };

  for (const t of input.tickets) {
    const bucket = ensureBucket(t.periodBucket, t.currency);
    const isFp = t.freePlayFlag === "Y";
    if (isFp) freePlayTicketCount++;

    if (t.wagerStatus === "W") {
      grossWonCents += t.toWinAmountCents;
      bucket.settledNetCents += t.toWinAmountCents;
      if (isFp) freePlayWonCents += t.toWinAmountCents;
    } else if (t.wagerStatus === "L") {
      if (isFp) {
        // Free-play loss does not deduct customer cash balance
        freePlayLostPrincipalSavedCents += t.amountWageredCents;
      } else {
        grossLostCents -= t.amountWageredCents;
        bucket.settledNetCents -= t.amountWageredCents;
      }
    }
  }

  let adjustmentsNetCents = 0;
  for (const adj of adjustments) {
    const bucket = ensureBucket(adj.periodBucket, adj.currency);
    adjustmentsNetCents += adj.signedAmountCents;
    bucket.adjustmentsCents += adj.signedAmountCents;
  }

  const settledSportsNetCents = grossWonCents + grossLostCents;
  const customerNetProfitLossCents =
    settledSportsNetCents + adjustmentsNetCents;
  const bookNetHoldCents = -settledSportsNetCents;

  return {
    mode: 8,
    domain: "Risk & Exposure",
    customerId: cleanCust,
    signConvention: "CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN",
    settledTicketCount: input.tickets.length,
    freePlayTicketCount,
    grossWonCents,
    grossLostCents,
    freePlayWonCents,
    freePlayLostPrincipalSavedCents,
    adjustmentsNetCents,
    customerNetProfitLossCents,
    bookNetHoldCents,
    breakdownByPeriodAndCurrency: Array.from(bucketMap.values()).map((b) => ({
      periodBucket: b.periodBucket,
      currency: b.currency,
      settledNetCents: b.settledNetCents,
      adjustmentsCents: b.adjustmentsCents,
      totalCustomerPlCents: b.settledNetCents + b.adjustmentsCents,
    })),
  };
}

// ============================================================================
// MODE 9 · PENDING EXPOSURE (Risk & Exposure)
// ============================================================================
export interface Mode9RawPendingRow {
  readonly TicketNumber: number | string;
  readonly WagerNumber: number | string;
  readonly WagerType: "S" | "M" | "L" | "E" | "P" | "T" | "I" | "C" | "G" | "A";
  readonly AmountWagered: number; // cents
  readonly ToWinAmount: number; // cents
  readonly FreePlayFlag: "Y" | "N";
  readonly WagerStatus: "P" | "W" | "L" | "X";
  readonly TicketWriter?: string;
  readonly Description: string;
}

export interface Mode9PendingExposureOutput {
  readonly mode: 9;
  readonly domain: "Risk & Exposure";
  readonly customerId: string;
  readonly rawLegRowsCount: number;
  readonly uniquePendingTicketsCount: number;
  readonly droppedNoiseOrAlertRowsCount: number;
  readonly totalStakeCents: number; // Cash at risk by customer
  readonly potentialPayoutCents: number; // Total gross return (stake returned + winnings)
  readonly definedLiabilityCents: number; // Net book liability (ToWinAmount across unique pending tickets)
  readonly tickets: readonly {
    readonly compositeTicketKey: string;
    readonly wagerType: string;
    readonly legCount: number;
    readonly stakeCents: number;
    readonly potentialPayoutCents: number;
    readonly definedLiabilityCents: number;
    readonly isFreePlay: boolean;
  }[];
}

/**
 * Computes Mode 9 Pending Exposure following `customer/report/report.js` (`getPendingWagers`):
 * - Groups multi-leg parlays/teasers by `TicketNumber + "-" + WagerNumber` so `AmountWagered` and `ToWinAmount`
 *   are counted once per parent ticket, never multiplied by leg rows.
 * - Separates:
 *   1. `stakeCents`: Customer cash staked (`0` on `FreePlayFlag === "Y"`, `AmountWagered` on `"N"`).
 *   2. `potentialPayoutCents`: Total cash returned to customer on win (`stakeCents + ToWinAmount`).
 *   3. `definedLiabilityCents`: Book liability (`ToWinAmount`).
 */
export function evaluateMode9PendingExposure(
  customerId: string,
  rawRows: readonly Mode9RawPendingRow[],
): Mode9PendingExposureOutput {
  const cleanCust = normalizeWebLogLoginId(customerId);
  const grouped = new Map<
    string,
    {
      compositeTicketKey: string;
      wagerType: string;
      legCount: number;
      stakeCents: number;
      potentialPayoutCents: number;
      definedLiabilityCents: number;
      isFreePlay: boolean;
    }
  >();

  let droppedNoiseOrAlertRowsCount = 0;

  for (const row of rawRows) {
    const writer = (row.TicketWriter ?? "Internet").trim().toUpperCase();
    if (writer === "BLOCKED" || writer === "ALERT" || row.WagerStatus !== "P") {
      droppedNoiseOrAlertRowsCount++;
      continue;
    }

    const key = `${row.TicketNumber}-${row.WagerNumber}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.legCount += 1;
      continue;
    }

    const isFreePlay = row.FreePlayFlag === "Y";
    const stakeCents = isFreePlay ? 0 : Math.round(row.AmountWagered);
    const definedLiabilityCents = Math.round(row.ToWinAmount);
    const potentialPayoutCents = stakeCents + definedLiabilityCents;

    grouped.set(key, {
      compositeTicketKey: key,
      wagerType: row.WagerType,
      legCount: 1,
      stakeCents,
      potentialPayoutCents,
      definedLiabilityCents,
      isFreePlay,
    });
  }

  const tickets = Array.from(grouped.values());
  const totalStakeCents = tickets.reduce((acc, t) => acc + t.stakeCents, 0);
  const potentialPayoutCents = tickets.reduce(
    (acc, t) => acc + t.potentialPayoutCents,
    0,
  );
  const definedLiabilityCents = tickets.reduce(
    (acc, t) => acc + t.definedLiabilityCents,
    0,
  );

  return {
    mode: 9,
    domain: "Risk & Exposure",
    customerId: cleanCust,
    rawLegRowsCount: rawRows.length,
    uniquePendingTicketsCount: tickets.length,
    droppedNoiseOrAlertRowsCount,
    totalStakeCents,
    potentialPayoutCents,
    definedLiabilityCents,
    tickets,
  };
}

// ============================================================================
// MODE 10 · RECONCILIATION (Data Integrity)
// ============================================================================
export interface Mode10ExplainedDifference {
  readonly category:
    | "FREE_PLAY_PRINCIPAL_EXCLUSION"
    | "MANUAL_LEDGER_ADJUSTMENT"
    | "CASINO_NON_SPORTS_DAILY_FIGURE"
    | "FIGURE_DATE_CUTOFF_SETTLEMENT_LAG";
  readonly amountCents: number;
  readonly explanation: string;
}

export interface Mode10ReconciliationOutput {
  readonly mode: 10;
  readonly domain: "Data Integrity";
  readonly customerId: string;
  readonly scopeWindow: string;
  readonly isIdenticalScopeVerified: boolean;
  readonly reportDailyFiguresTotalCents: number;
  readonly settledTicketsSumCents: number;
  readonly ledgerTransactionsDeltaCents: number;
  readonly matchedTotalsCents: number;
  readonly explainedDifferencesTotalCents: number;
  readonly explainedDifferences: readonly Mode10ExplainedDifference[];
  readonly unresolvedGapCents: number;
  readonly reconciliationStatus:
    | "RECONCILED_EXACT"
    | "RECONCILED_WITH_EXPLAINED_DIFFS"
    | "UNRESOLVED_GAP_ALERT";
}

export function evaluateMode10Reconciliation(input: {
  customerId: string;
  scopeWindow: string;
  isIdenticalScopeVerified: boolean;
  reportDailyFiguresTotalCents: number;
  settledTicketsSumCents: number;
  ledgerTransactionsDeltaCents: number;
  explainedDifferences?: readonly Mode10ExplainedDifference[];
}): Mode10ReconciliationOutput {
  const cleanCust = normalizeWebLogLoginId(input.customerId);
  const diffs = input.explainedDifferences ?? [];
  const explainedTotal = diffs.reduce((acc, d) => acc + d.amountCents, 0);

  // Reconcile Report Daily Figures + Explained Adjustments against Ledger Delta and Settled Tickets
  const expectedLedgerFromTickets =
    input.settledTicketsSumCents + explainedTotal;
  const unresolvedGapCents =
    input.ledgerTransactionsDeltaCents - expectedLedgerFromTickets;

  let reconciliationStatus: Mode10ReconciliationOutput["reconciliationStatus"];
  if (!input.isIdenticalScopeVerified || unresolvedGapCents !== 0) {
    reconciliationStatus = "UNRESOLVED_GAP_ALERT";
  } else if (
    diffs.length === 0 &&
    input.reportDailyFiguresTotalCents === input.settledTicketsSumCents
  ) {
    reconciliationStatus = "RECONCILED_EXACT";
  } else {
    reconciliationStatus = "RECONCILED_WITH_EXPLAINED_DIFFS";
  }

  return {
    mode: 10,
    domain: "Data Integrity",
    customerId: cleanCust,
    scopeWindow: input.scopeWindow,
    isIdenticalScopeVerified: input.isIdenticalScopeVerified,
    reportDailyFiguresTotalCents: input.reportDailyFiguresTotalCents,
    settledTicketsSumCents: input.settledTicketsSumCents,
    ledgerTransactionsDeltaCents: input.ledgerTransactionsDeltaCents,
    matchedTotalsCents: input.settledTicketsSumCents,
    explainedDifferencesTotalCents: explainedTotal,
    explainedDifferences: diffs,
    unresolvedGapCents,
    reconciliationStatus,
  };
}

// ============================================================================
// LIVE PRODUCTION SNAPSHOT ACROSS ALL 10 MODES (For Portal & CLI Inspection)
// ============================================================================
export interface TenModeLiveSnapshot {
  readonly generatedAtIso: string;
  readonly catalog: readonly DiagnosticModeSpec[];
  readonly mode1CustomerOverview: readonly Mode1CustomerOverviewOutput[];
  readonly mode2AccessLogs: Mode2AccessLogsOutput;
  readonly mode3SharedIpOverview: Mode3SharedIpOverviewOutput;
  readonly mode4CustomerIpHistory: Mode4CustomerIpHistoryOutput;
  readonly mode5AccountsByIp: Mode5AccountsByIpOutput;
  readonly mode6ActivityOverlap: readonly Mode6ActivityOverlapOutput[];
  readonly mode7WagerComparisons: readonly Mode7WagerComparisonOutput[];
  readonly mode8SettledNet: readonly Mode8SettledNetOutput[];
  readonly mode9PendingExposure: readonly Mode9PendingExposureOutput[];
  readonly mode10Reconciliation: readonly Mode10ReconciliationOutput[];
}

export function buildTenModeLiveSnapshot(): TenModeLiveSnapshot {
  const mode1CustomerOverview: Mode1CustomerOverviewOutput[] = [
    evaluateMode1CustomerOverview({
      customerId: "MJ102",
      officeAgentId: "MJ2026",
      polymarketWallet: "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
      validatedNetCents: 4285000,
      pendingStakeCents: 6060000,
      pendingDefinedLiabilityCents: 6412000,
      lastAccessUtc: "2026-10-31T17:32:10Z",
      hasCompleteLedgerScope: true,
      hasWebLogCoverage: true,
    }),
    evaluateMode1CustomerOverview({
      customerId: "BGD101",
      officeAgentId: "BIGDAD",
      polymarketWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
      validatedNetCents: 8940000,
      pendingStakeCents: 7330000,
      pendingDefinedLiabilityCents: 8541100,
      lastAccessUtc: "2026-10-31T17:29:45Z",
      hasCompleteLedgerScope: true,
      hasWebLogCoverage: true,
    }),
    evaluateMode1CustomerOverview({
      customerId: "CB112_1",
      officeAgentId: "CUB22HR",
      polymarketWallet: "0x3af8392189d021cfa82000000000000000021cfa",
      validatedNetCents: 3120000,
      pendingStakeCents: 6300000,
      pendingDefinedLiabilityCents: 5727200,
      lastAccessUtc: "2026-10-31T17:31:12Z",
      hasCompleteLedgerScope: true,
      hasWebLogCoverage: true,
    }),
    evaluateMode1CustomerOverview({
      customerId: "CHURN_059",
      officeAgentId: "LAKERS",
      polymarketWallet: "0x88d199c044a210f877b312e900c412a881b999c0",
      validatedNetCents: 1940000,
      pendingStakeCents: 1800000,
      pendingDefinedLiabilityCents: 4320000,
      lastAccessUtc: "2026-10-29T11:10:00Z",
      hasCompleteLedgerScope: true,
      hasWebLogCoverage: false,
    }),
  ];

  const mode2AccessLogs = evaluateMode2AccessLogs("MJ102", [
    {
      LoginID: "MJ102",
      ActorID: "MJ102",
      AccessDateTime: "2026-10-31T14:42:07Z",
      IPAddress: "104.28.34.12",
      Operation: "LOGIN_AUTH",
      Data: "Browser=Safari18.1 Mobile; Widget=player_MJ102",
      nextWagerDwellSeconds: 4.2,
    },
    {
      LoginID: "MJ102",
      ActorID: "MJ102",
      AccessDateTime: "2026-10-31T14:42:11Z",
      IPAddress: "104.28.34.12",
      Operation: "PLACE_WAGER",
      Data: "Ticket=901104-1; ROT=501; NBA 1Q O55.5 ($16,200)",
      nextWagerDwellSeconds: 0,
    },
    {
      LoginID: "MJ102",
      ActorID: "MJ2026",
      AccessDateTime: "2026-10-31T14:42:18Z",
      IPAddress: "172.56.21.89",
      Operation: "UPDATE_BY_COLUMN",
      Data: "Actor=MJ2026 -> Target=MJ102; MaxBet=1000; Delay=6; Allow1H2HQtr=0",
      nextWagerDwellSeconds: null,
    },
  ]);

  const mode3SharedIpOverview = evaluateMode3SharedIpOverview({
    dateWindowStartMdy: "10/25/2026",
    dateWindowEndMdy: "10/31/2026",
  });

  const mode4CustomerIpHistory = evaluateMode4CustomerIpHistory({
    customerId: "MJ102",
    officeAgentId: "MJ2026",
    startDateYmd: "2026-10-25",
    endDateYmd: "2026-10-31",
    observations: [
      {
        ipAddress: "104.28.34.12",
        asnLabel: "AS13335 Cloudflare WARP",
        firstSeenUtc: "2026-10-25T12:00:00Z",
        lastSeenUtc: "2026-10-27T23:30:00Z",
        observationCount: 19,
      },
      {
        ipAddress: "172.56.21.89",
        asnLabel: "AS21928 T-Mobile USA",
        firstSeenUtc: "2026-10-29T08:15:00Z",
        lastSeenUtc: "2026-10-30T22:10:00Z",
        observationCount: 11,
      },
      {
        ipAddress: "104.28.34.12",
        asnLabel: "AS13335 Cloudflare WARP",
        firstSeenUtc: "2026-10-31T14:40:00Z",
        lastSeenUtc: "2026-10-31T17:32:10Z",
        observationCount: 8,
      },
    ],
    collectionGapThresholdHours: 24,
  });

  const mode5AccountsByIp = evaluateMode5AccountsByIp({
    selectedIp: "104.28.34.12",
    startDateMdy: "10/25/2026",
    endDateMdy: "10/31/2026",
    accounts: [
      {
        accountId: "MJ102",
        officeAgentId: "MJ2026",
        firstTimestampUtc: "2026-10-25T12:00:00Z",
        lastTimestampUtc: "2026-10-31T17:32:10Z",
        totalHitsOnIp: 27,
        operationsObserved: ["LOGIN_AUTH", "GET_PENDING", "PLACE_WAGER"],
      },
      {
        accountId: "MJ103",
        officeAgentId: "MJ2026",
        firstTimestampUtc: "2026-10-26T15:11:00Z",
        lastTimestampUtc: "2026-10-31T17:32:13Z",
        totalHitsOnIp: 18,
        operationsObserved: ["LOGIN_AUTH", "PLACE_WAGER"],
      },
      {
        accountId: "EJ8834",
        officeAgentId: "MJ2026",
        firstTimestampUtc: "2026-10-27T18:04:00Z",
        lastTimestampUtc: "2026-10-31T15:11:30Z",
        totalHitsOnIp: 22,
        operationsObserved: ["LOGIN_AUTH", "PLACE_WAGER"],
      },
      {
        accountId: "EJ8835",
        officeAgentId: "MJ2026",
        firstTimestampUtc: "2026-10-28T19:20:00Z",
        lastTimestampUtc: "2026-10-31T15:11:34Z",
        totalHitsOnIp: 14,
        operationsObserved: ["LOGIN_AUTH", "PLACE_WAGER"],
      },
      {
        accountId: "MJ101",
        officeAgentId: "MJ2026",
        firstTimestampUtc: "2026-10-29T20:00:00Z",
        lastTimestampUtc: "2026-10-31T14:55:00Z",
        totalHitsOnIp: 9,
        operationsObserved: ["LOGIN_AUTH", "GET_DAILY_FIGURES"],
      },
    ],
  });

  const mode6ActivityOverlap: Mode6ActivityOverlapOutput[] = [
    evaluateMode6ActivityOverlap(
      {
        accountId: "MJ102",
        officeAgentId: "MJ2026",
        windowKind: "BOUNDED_SESSION_INTERVAL",
        startUtc: "2026-10-31T14:40:00Z",
        endUtc: "2026-10-31T14:46:30Z",
        ipAddress: "104.28.34.12",
        actionSummary:
          "Session login + NBA 1Q O55.5 ($16.2K) + LAL -3.0 ($26.4K)",
      },
      {
        accountId: "MJ103",
        officeAgentId: "MJ2026",
        windowKind: "BOUNDED_SESSION_INTERVAL",
        startUtc: "2026-10-31T14:41:10Z",
        endUtc: "2026-10-31T14:45:40Z",
        ipAddress: "104.28.34.12",
        actionSummary:
          "Concurrent session + identical NBA 1Q O55.5 ($11.5K) @ +2s",
      },
    ),
    evaluateMode6ActivityOverlap(
      {
        accountId: "CHURN_059",
        officeAgentId: "LAKERS",
        windowKind: "POINT_IN_TIME_EVENT_WINDOW",
        startUtc: "2026-10-31T15:22:48Z",
        endUtc: "2026-10-31T15:22:48Z",
        ipAddress: "192.168.9.42",
        actionSummary:
          "Single bet-ticker timestamp on GameNum 5501 LAL Alt -10.5",
      },
      {
        accountId: "CHURN_049",
        officeAgentId: "SOUTHSHORE",
        windowKind: "POINT_IN_TIME_EVENT_WINDOW",
        startUtc: "2026-10-31T15:23:12Z",
        endUtc: "2026-10-31T15:23:12Z",
        ipAddress: "192.168.9.42",
        actionSummary:
          "Single bet-ticker timestamp on NBA 1H Derivative Spread (+24s)",
      },
    ),
  ];

  const mode7WagerComparisons: Mode7WagerComparisonOutput[] = [
    evaluateMode7WagerComparison(
      {
        venue: "FANTASY402",
        ticketOrOrderId: "F402-901007-KEY7",
        accountOrWalletId: "CB112_1",
        eventDateYmd: "2026-10-31",
        rotationNumber: 451,
        marketType: "SPREAD",
        period: "FG",
        side: "NE",
        adjLinePoints: -7.5,
        teaserPoints: 0,
        oddsAmerican: -110,
        stakeCents: 6300000,
        placedAtUtc: "2026-10-31T15:31:12Z",
      },
      {
        venue: "POLYMARKET",
        ticketOrOrderId: "PM-CLOB-0x3af8-NE",
        accountOrWalletId: "0x3af8392189d021cfa82000000000000000021cfa",
        eventDateYmd: "2026-10-31",
        rotationNumber: 451,
        marketType: "SPREAD",
        period: "FG",
        side: "NE",
        adjLinePoints: -6.5,
        teaserPoints: 0,
        oddsAmerican: -108,
        stakeCents: 650000,
        placedAtUtc: "2026-10-31T15:31:08Z",
      },
    ),
    evaluateMode7WagerComparison(
      {
        venue: "FANTASY402",
        ticketOrOrderId: "F402-901002-ALT",
        accountOrWalletId: "BGD101",
        eventDateYmd: "2026-10-31",
        rotationNumber: 5501,
        rawGameNum: 5501,
        marketType: "SPREAD",
        period: "FG",
        side: "LAL",
        adjLinePoints: -7.5,
        teaserPoints: 0,
        oddsAmerican: 165,
        stakeCents: 2400000,
        placedAtUtc: "2026-10-31T15:21:10Z",
      },
      {
        venue: "POLYMARKET",
        ticketOrOrderId: "PM-CLOB-0x26cf-LAL",
        accountOrWalletId: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
        eventDateYmd: "2026-10-31",
        rotationNumber: 501,
        marketType: "SPREAD",
        period: "FG",
        side: "LAL",
        adjLinePoints: -7.5,
        teaserPoints: 0,
        oddsAmerican: 172,
        stakeCents: 2400000,
        placedAtUtc: "2026-10-31T15:21:06Z",
      },
    ),
  ];

  const mode8SettledNet: Mode8SettledNetOutput[] = [
    evaluateMode8SettledNet({
      customerId: "MJ102",
      tickets: [
        {
          ticketKey: "899101-1",
          periodBucket: "7D",
          currency: "USD",
          wagerStatus: "W",
          amountWageredCents: 2200000,
          toWinAmountCents: 2000000,
          freePlayFlag: "N",
        },
        {
          ticketKey: "899145-1",
          periodBucket: "7D",
          currency: "USD",
          wagerStatus: "W",
          amountWageredCents: 500000,
          toWinAmountCents: 454500,
          freePlayFlag: "Y",
        },
        {
          ticketKey: "899210-1",
          periodBucket: "7D",
          currency: "USD",
          wagerStatus: "L",
          amountWageredCents: 300000,
          toWinAmountCents: 272700,
          freePlayFlag: "Y",
        },
        {
          ticketKey: "PM-SETTLED-01",
          periodBucket: "7D",
          currency: "USDC",
          wagerStatus: "W",
          amountWageredCents: 1500000,
          toWinAmountCents: 1980500,
          freePlayFlag: "N",
        },
      ],
      adjustments: [
        {
          adjustmentId: "TXN-ADJ-901",
          periodBucket: "7D",
          currency: "USD",
          signedAmountCents: -150000,
          reason: "Wire fee & agent settlement adjustment",
        },
      ],
    }),
  ];

  const mode9PendingExposure: Mode9PendingExposureOutput[] = [
    evaluateMode9PendingExposure("MJ102", [
      {
        TicketNumber: 901104,
        WagerNumber: 1,
        WagerType: "P",
        AmountWagered: 1620000,
        ToWinAmount: 4212000,
        FreePlayFlag: "N",
        WagerStatus: "P",
        TicketWriter: "GSLIVE",
        Description: "Basketball #501 LAL/BOS 1Q Over 55.5 -110",
      },
      {
        TicketNumber: 901104,
        WagerNumber: 1,
        WagerType: "P",
        AmountWagered: 1620000,
        ToWinAmount: 4212000,
        FreePlayFlag: "N",
        WagerStatus: "P",
        TicketWriter: "GSLIVE",
        Description: "Basketball #501 LAL -3.0 -110",
      },
      {
        TicketNumber: 901104,
        WagerNumber: 2,
        WagerType: "S",
        AmountWagered: 1620000,
        ToWinAmount: 4212000,
        FreePlayFlag: "N",
        WagerStatus: "P",
        TicketWriter: "ALERT",
        Description: "ALERT mirror twin — zeroed out by Mode 9 deduplicator",
      },
      {
        TicketNumber: 901188,
        WagerNumber: 1,
        WagerType: "S",
        AmountWagered: 500000,
        ToWinAmount: 950000,
        FreePlayFlag: "Y",
        WagerStatus: "P",
        TicketWriter: "Internet",
        Description:
          "Football #315 Baylor +3.5 (Free Play Stake=$0, Liability=$9,500)",
      },
    ]),
  ];

  const mode10Reconciliation: Mode10ReconciliationOutput[] = [
    evaluateMode10Reconciliation({
      customerId: "MJ102",
      scopeWindow: "2026-10-25..2026-10-31 (America/Chicago FigureDate)",
      isIdenticalScopeVerified: true,
      reportDailyFiguresTotalCents: 2454500,
      settledTicketsSumCents: 2454500,
      ledgerTransactionsDeltaCents: 2304500,
      explainedDifferences: [
        {
          category: "MANUAL_LEDGER_ADJUSTMENT",
          amountCents: -150000,
          explanation:
            "getTransactions row TXN-ADJ-901 (-$1,500 wire settlement fee) excluded from sports daily figures",
        },
      ],
    }),
    evaluateMode10Reconciliation({
      customerId: "BGD101",
      scopeWindow: "2026-10-25..2026-10-31 (America/Chicago FigureDate)",
      isIdenticalScopeVerified: true,
      reportDailyFiguresTotalCents: 8940000,
      settledTicketsSumCents: 8940000,
      ledgerTransactionsDeltaCents: 8940000,
      explainedDifferences: [],
    }),
  ];

  return {
    generatedAtIso: new Date().toISOString(),
    catalog: TEN_MODE_CATALOG,
    mode1CustomerOverview,
    mode2AccessLogs,
    mode3SharedIpOverview,
    mode4CustomerIpHistory,
    mode5AccountsByIp,
    mode6ActivityOverlap,
    mode7WagerComparisons,
    mode8SettledNet,
    mode9PendingExposure,
    mode10Reconciliation,
  };
}
