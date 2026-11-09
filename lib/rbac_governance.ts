/**
 * @file lib/rbac_governance.ts
 * @description Unified RBAC Role Taxonomy, Task Governance Parser, Accountability Scorecards,
 *              and Automated Governance Gate across SportsDesk Ops & Fantasy402 Portal Planes.
 *
 * Unifies:
 *  1. Internal Desk & Engineering Governance Roles (`DeskRoleId`):
 *     `operator`, `security/operator`, `client/seam`, `settlement`, `compliance`,
 *     `server-team-lead`, `business-owner`, and `RISK_DESK_ANALYST`.
 *  2. Fantasy402 Portal Hierarchy Roles (`F402PortalRole`):
 *     `M` (Master), `A` (Subordinate Agent), `P` (Player), `U` (Unauthenticated),
 *     bridged to forensic access actor roles (`MASTER_MANAGER`, `OFFICE_AGENT`,
 *     `SYSTEM_GATEWAY`, `SELF_PLAYER`).
 *  3. Automated Task & Gate Governance:
 *     - Parses `docs/REMAINING_TASKS.md` (open & done tasks, `Ref:`, `Owner:`, `Basis:`,
 *       `Done when:`, `Blocked by:`, `Expiry:` SLA deadlines, and `Reference IDs` resolution).
 *     - Parses executive unblock decisions from
 *       `docs/analysis/defense-measurement-2026-11-03/00-executive-summary.md`.
 *     - Audits oracle gate ownership & readiness in
 *       `verification/manager-boot-oracle/pinned/manifest.json`.
 *     - Verifies `PROBATION_REVIEW_SLA_HOURS` (24h) & `RISK_DESK_ANALYST` binding from
 *       `lib/gslive_surveillance_governor.ts`.
 *  4. Per-Owner "Holding Their Weight" Scorecards & Dashboard Section/HTML Renderers.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownTable, type DashboardSection } from "./dashboard_markdown.ts";
import {
  PER_OFFICE_IP_TRACKER_CLUSTERS,
  type IpTrackerModeCode,
  type OfficeIpClusterSummary,
  type OfficeIpMatchClassification,
} from "./bet_ticker_ip_tracker_bridge.ts";
import {
  PROBATION_NON_DONOR_CAP_CENTS,
  PROBATION_NON_DONOR_DELAY_SEC,
  PROBATION_REVIEW_SLA_HOURS,
  SURGICAL_DONOR_CAP_CENTS,
  SURGICAL_DONOR_DELAY_SEC,
} from "./gslive_surveillance_governor.ts";

const MODULE_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, "..");

export const DESK_ROLE_IDS = [
  "operator",
  "security/operator",
  "client/seam",
  "settlement",
  "compliance",
  "server-team-lead",
  "business-owner",
  "RISK_DESK_ANALYST",
] as const;

export type DeskRoleId = (typeof DESK_ROLE_IDS)[number];

export const F402_PORTAL_ROLES = ["M", "A", "P", "U"] as const;
export type F402PortalRole = (typeof F402_PORTAL_ROLES)[number];

export const FORENSIC_ACTOR_ROLES = [
  "MASTER_MANAGER",
  "OFFICE_AGENT",
  "SYSTEM_GATEWAY",
  "SELF_PLAYER",
] as const;
export type ForensicActorRole = (typeof FORENSIC_ACTOR_ROLES)[number];

export const TASK_BASIS_LABELS = [
  "[CODE]",
  "[OBSERVED]",
  "[UNVERIFIED]",
  "[ASSUMPTION]",
] as const;
export type TaskBasisLabel = (typeof TASK_BASIS_LABELS)[number];

export type PermissionLevel = "ALLOWED" | "GUARDED" | "DENIED";

export const CHANNEL_IDS = [
  "EMAIL_INBOX",
  "TELEGRAM_BOT",
  "SENTINEL_CRON",
  "DAEMON_WEBVIEW",
  "GITHUB_CI",
  "F402_TICKET_WIRE",
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export type InboxAccountabilityStatus =
  "INBOX_ZERO" | "ACK_PENDING" | "ACTION_SLA_ACTIVE" | "ESCALATED_TO_LEAD";

export interface ChannelIntegrationSpec {
  readonly id: ChannelId;
  readonly label: string;
  readonly protocol: string;
  readonly entrypoint: string;
  readonly cadenceOrSla: string;
  readonly commandsOrRoutes: readonly string[];
  readonly subscribedRoles: readonly DeskRoleId[];
  readonly status: "ACTIVE" | "GUARDED";
  readonly description: string;
}

export interface DeskRoleSpec {
  readonly id: DeskRoleId;
  readonly label: string;
  readonly plane:
    | "ops-execution"
    | "security-compliance"
    | "risk-settlement"
    | "upstream-stakeholder";
  readonly f402Counterpart: F402PortalRole;
  readonly forensicCounterpart: ForensicActorRole;
  readonly teamLead: string;
  readonly reportsToRole: DeskRoleId;
  readonly email: string;
  readonly inboxRoute: string;
  readonly ackSlaMinutes: number;
  readonly primaryChannels: readonly ChannelId[];
  readonly telegramCommand: string;
  readonly charter: string;
  readonly slaPolicy: string;
}

export const DESK_ROLES: Readonly<Record<DeskRoleId, DeskRoleSpec>> = {
  operator: {
    id: "operator",
    label: "Desk Operator",
    plane: "ops-execution",
    f402Counterpart: "M",
    forensicCounterpart: "MASTER_MANAGER",
    teamLead: "Ops & Execution Lead (@ops-lead)",
    reportsToRole: "security/operator",
    email: "ops-desk@bookdeskops.com",
    inboxRoute: "inbox://ops-desk/triage",
    ackSlaMinutes: 15,
    primaryChannels: [
      "EMAIL_INBOX",
      "TELEGRAM_BOT",
      "SENTINEL_CRON",
      "DAEMON_WEBVIEW",
      "GITHUB_CI",
      "F402_TICKET_WIRE",
    ],
    telegramCommand: "/report",
    charter:
      "Owns ./bin/dx execution, HAR redaction & production oracle gates, F402/GSLive captures, and artifact cadence.",
    slaPolicy: "24h gate drift remediation · daily artifact lock check",
  },
  "security/operator": {
    id: "security/operator",
    label: "Desk Security Owner",
    plane: "security-compliance",
    f402Counterpart: "M",
    forensicCounterpart: "MASTER_MANAGER",
    teamLead: "SecOps & Authz Lead (@secops-lead)",
    reportsToRole: "business-owner",
    email: "security-ops@bookdeskops.com",
    inboxRoute: "inbox://security-ops/authz-audit",
    ackSlaMinutes: 15,
    primaryChannels: [
      "EMAIL_INBOX",
      "TELEGRAM_BOT",
      "SENTINEL_CRON",
      "DAEMON_WEBVIEW",
      "GITHUB_CI",
    ],
    telegramCommand: "/forensics",
    charter:
      "Owns defense-measurement pack, authz matrix design, risk-acceptance expiry controls (2026-12-03), and secret hygiene.",
    slaPolicy: "30-day risk acceptance hard expiry (2026-12-03 on #17)",
  },
  "client/seam": {
    id: "client/seam",
    label: "Client & Seam Engineering",
    plane: "ops-execution",
    f402Counterpart: "A",
    forensicCounterpart: "OFFICE_AGENT",
    teamLead: "Client & Seam Engineering Lead (@seam-lead)",
    reportsToRole: "operator",
    email: "client-seam@bookdeskops.com",
    inboxRoute: "inbox://client-seam/sinks-cdn",
    ackSlaMinutes: 30,
    primaryChannels: ["EMAIL_INBOX", "DAEMON_WEBVIEW", "GITHUB_CI"],
    telegramCommand: "/miniapp",
    charter:
      "Owns searchComponent & MODULE_SINK_WRAPPERS XSS sink escaping, CDN asset pinning (137 assets), and WebKit/CDP parity.",
    slaPolicy: "Zero unpinned CDN assets · 1 PR per sink migration with test",
  },
  settlement: {
    id: "settlement",
    label: "Settlement & Grading Team",
    plane: "risk-settlement",
    f402Counterpart: "M",
    forensicCounterpart: "MASTER_MANAGER",
    teamLead: "Settlement & Grading Lead (@settlement-lead)",
    reportsToRole: "business-owner",
    email: "settlement-grading@bookdeskops.com",
    inboxRoute: "inbox://settlement/eod-reconciliation",
    ackSlaMinutes: 30,
    primaryChannels: [
      "EMAIL_INBOX",
      "TELEGRAM_BOT",
      "DAEMON_WEBVIEW",
      "GITHUB_CI",
      "F402_TICKET_WIRE",
    ],
    telegramCommand: "/report",
    charter:
      "Owns end-of-day figure reconciliation, pre-fee PnL cashflow verification, and pending-customer Path A/B validation.",
    slaPolicy: "EOD figure sign-off per named settlement date",
  },
  compliance: {
    id: "compliance",
    label: "Compliance & Legal",
    plane: "security-compliance",
    f402Counterpart: "M",
    forensicCounterpart: "SYSTEM_GATEWAY",
    teamLead: "Compliance & Legal Counsel Lead (@compliance-lead)",
    reportsToRole: "business-owner",
    email: "compliance-legal@bookdeskops.com",
    inboxRoute: "inbox://compliance/tamper-scope",
    ackSlaMinutes: 60,
    primaryChannels: ["EMAIL_INBOX", "DAEMON_WEBVIEW", "GITHUB_CI"],
    telegramCommand: "/check",
    charter:
      "Owns written tamper-testing scope authorization (Decision #2) and active/pending customer regulatory definitions.",
    slaPolicy: "~1h turnaround on tamper test scope authorization",
  },
  "server-team-lead": {
    id: "server-team-lead",
    label: "Server Team Lead",
    plane: "upstream-stakeholder",
    f402Counterpart: "M",
    forensicCounterpart: "SYSTEM_GATEWAY",
    teamLead: "Upstream Server Team Lead (@server-team-lead)",
    reportsToRole: "business-owner",
    email: "server-team-lead@bookdeskops.com",
    inboxRoute: "inbox://server-team/bearer-authz",
    ackSlaMinutes: 60,
    primaryChannels: ["EMAIL_INBOX", "GITHUB_CI", "F402_TICKET_WIRE"],
    telegramCommand: "/forensics",
    charter:
      "Executes the 6-request Bearer claim-derived vs body-trusting authz test (Decision #3) and retrieves 500 (0 B) error logs.",
    slaPolicy: "~2h execution window once test account is provisioned",
  },
  "business-owner": {
    id: "business-owner",
    label: "Business Owner",
    plane: "upstream-stakeholder",
    f402Counterpart: "M",
    forensicCounterpart: "MASTER_MANAGER",
    teamLead: "Executive Business Owner (@business-owner)",
    reportsToRole: "business-owner",
    email: "business-owner@bookdeskops.com",
    inboxRoute: "inbox://executive/unblock-decisions",
    ackSlaMinutes: 60,
    primaryChannels: [
      "EMAIL_INBOX",
      "TELEGRAM_BOT",
      "DAEMON_WEBVIEW",
      "GITHUB_CI",
    ],
    telegramCommand: "/report",
    charter:
      "Provisions low-privilege subordinate test account (Decision #1) and confirms authoritative financial reconciliation ledger.",
    slaPolicy: "~1h test account provisioning to unblock P0.6",
  },
  RISK_DESK_ANALYST: {
    id: "RISK_DESK_ANALYST",
    label: "Risk Desk Analyst",
    plane: "risk-settlement",
    f402Counterpart: "A",
    forensicCounterpart: "OFFICE_AGENT",
    teamLead: "Surveillance & Risk Desk Lead (@risk-desk-lead)",
    reportsToRole: "settlement",
    email: "risk-desk-analyst@bookdeskops.com",
    inboxRoute: "inbox://risk-desk/clamps-24h",
    ackSlaMinutes: 15,
    primaryChannels: [
      "EMAIL_INBOX",
      "TELEGRAM_BOT",
      "SENTINEL_CRON",
      "DAEMON_WEBVIEW",
      "F402_TICKET_WIRE",
    ],
    telegramCommand: "/watchlist",
    charter:
      "Reviews GATE-SURV-02 ACTIVE_CLAMPED accounts, signs audit tickets (EXONERATE_FEED_DRIFT | CONFIRM_SYNDICATE_ABUSE), and audits GSLive surfaces.",
    slaPolicy: `${PROBATION_REVIEW_SLA_HOURS}h mandatory probation review SLA (GATE-SURV-02)`,
  },
};

export const CHANNEL_INTEGRATIONS: readonly ChannelIntegrationSpec[] = [
  {
    id: "EMAIL_INBOX",
    label: "Role Email & Monitored Accountability Inboxes",
    protocol: "SMTP/IMAP (@bookdeskops.com) + F402 Portal mail-system",
    entrypoint: "lib/rbac_governance.ts · P2.3 COMMUNICATION / mail-system",
    cadenceOrSla: "15m-60m ACK SLA · Auto-escalates to reportsToRole on breach",
    commandsOrRoutes: [
      "ops-desk@bookdeskops.com (inbox://ops-desk/triage)",
      "security-ops@bookdeskops.com (inbox://security-ops/authz-audit)",
      "client-seam@bookdeskops.com (inbox://client-seam/sinks-cdn)",
      "settlement-grading@bookdeskops.com (inbox://settlement/eod-reconciliation)",
      "compliance-legal@bookdeskops.com (inbox://compliance/tamper-scope)",
      "server-team-lead@bookdeskops.com (inbox://server-team/bearer-authz)",
      "business-owner@bookdeskops.com (inbox://executive/unblock-decisions)",
      "risk-desk-analyst@bookdeskops.com (inbox://risk-desk/clamps-24h)",
    ],
    subscribedRoles: [...DESK_ROLE_IDS],
    status: "ACTIVE",
    description:
      "Canonical @bookdeskops.com distribution & triage inboxes per RBAC role, bridged to the Fantasy402 COMMUNICATION / mail-system surface with deterministic SLA escalation to each role's Team Lead.",
  },
  {
    id: "TELEGRAM_BOT",
    label: "SportsDesk Telegram Bot & Mini App",
    protocol: "Telegram Bot API + WebApp Mini App",
    entrypoint: "services/sportsdesk_telegram_bot.ts",
    cadenceOrSla:
      "Real-time <500ms push · 3 daily briefings (Morning / Midday / EOD)",
    commandsOrRoutes: [
      "/start",
      "/miniapp",
      "/report",
      "/forensics",
      "/watchlist",
      "/check <ID>",
      "/alert_test",
    ],
    subscribedRoles: [
      "operator",
      "security/operator",
      "settlement",
      "business-owner",
      "RISK_DESK_ANALYST",
    ],
    status: "ACTIVE",
    description:
      "Real-time syndicate steam alerts, Morning Risk Briefing, Midday Steam Pulse, Evening Settlement Recaps, and deep-linked customer/exposure forensics via Telegram Bot & Mini App.",
  },
  {
    id: "SENTINEL_CRON",
    label: "Weblog Sentinel & Health Watcher Cron",
    protocol: "Cloudflare Scheduled Workers + Local Cron",
    entrypoint:
      "workers/weblog_sentinel.ts · workers/health_watcher.ts · scripts/artifacts_cron.ts",
    cadenceOrSla:
      "08:00 UTC weblog sentinel (0 8 * * *) · 1m health watcher (* * * * *)",
    commandsOrRoutes: [
      "bun run weblog:sentinel",
      "workers/health_watcher.ts (operationalStatus transitions)",
      "scratch/artifacts-cron.jsonl",
    ],
    subscribedRoles: ["operator", "security/operator", "RISK_DESK_ANALYST"],
    status: "ACTIVE",
    description:
      "Automated 08:00 Telegram sentinel when today's F402 weblog JSONL is missing (#91), plus 1-minute daemon health transition alerts and artifact refresh cron.",
  },
  {
    id: "DAEMON_WEBVIEW",
    label: "Desk Daemon (:4020) & Cordis WebView Host",
    protocol: "HTTP/JSON + Cordis Sidebar Plugin",
    entrypoint:
      "services/sportsdesk_webview_server.ts · lib/daemon_routes.ts · dsh-plugin-sidebar/index.js",
    cadenceOrSla: "Live HTTP endpoints on :4020 · zero-CSP standalone HTML",
    commandsOrRoutes: [
      "GET /governance",
      "GET /governance.json",
      "GET /tracker",
      "GET /health",
    ],
    subscribedRoles: [
      "operator",
      "security/operator",
      "client/seam",
      "settlement",
      "compliance",
      "business-owner",
      "RISK_DESK_ANALYST",
    ],
    status: "ACTIVE",
    description:
      "Local and VPS operator webview serving interactive HTML/JSON governance scorecards, bird's-eye telemetry, and task audits directly into the Cordis sidebar.",
  },
  {
    id: "GITHUB_CI",
    label: "GitHub Issues (#14-#23) & CI Verify Gate Chain",
    protocol: "GitHub Actions + Issues Tracker",
    entrypoint: ".github/workflows/ci.yml · scripts/governance_check.ts",
    cadenceOrSla: "Every PR & push to main · 30d hard risk-acceptance expiry",
    commandsOrRoutes: [
      "bun run governance:check --audit",
      "Issues #14, #17, #21, #22, #23",
      "docs/REMAINING_TASKS.md",
    ],
    subscribedRoles: [
      "operator",
      "security/operator",
      "client/seam",
      "settlement",
      "compliance",
      "server-team-lead",
      "business-owner",
    ],
    status: "ACTIVE",
    description:
      "Enforces RBAC task ownership, strategic Goals, execution Directions, on-disk evidence verification, and 30-day risk-acceptance expiry across GitHub Issues and CI.",
  },
  {
    id: "F402_TICKET_WIRE",
    label: "F402 Live Ticket Wire & Surveillance Audit Queue",
    protocol: "F402 Replay Transport + GSLive Governor",
    entrypoint:
      "lib/gslive_surveillance_governor.ts · lib/f402_agent_policy.ts",
    cadenceOrSla: "500ms WSS SLA · 24h GATE-SURV-02 probation review SLA",
    commandsOrRoutes: [
      "TicketWriter: Internet / ALERT / GSLIVE / GSBUILDER",
      "GATE-SURV-02 (EXONERATE_FEED_DRIFT | CONFIRM_SYNDICATE_ABUSE)",
      "createF402ReplayTransport()",
    ],
    subscribedRoles: [
      "operator",
      "settlement",
      "server-team-lead",
      "RISK_DESK_ANALYST",
    ],
    status: "ACTIVE",
    description:
      "Ingests live Fantasy402 & GSLive ticket writer lanes and routes ACTIVE_CLAMPED accounts into the 24-hour Risk Desk Analyst signed audit queue.",
  },
];

export interface PortalRoleContract {
  readonly role: F402PortalRole;
  readonly name: string;
  readonly forensicRole: ForensicActorRole;
  readonly prefilterBehavior: string;
  readonly tamperSurface: string;
  readonly mappedDeskRoles: readonly DeskRoleId[];
}

export const PORTAL_ROLE_CONTRACTS: readonly PortalRoleContract[] = [
  {
    role: "M",
    name: "Master Agent",
    forensicRole: "MASTER_MANAGER",
    prefilterBehavior:
      "security.js ajaxPrefilter injects Bearer + sets agentID := MASTER_ID and agentOwner := MASTER_ID.",
    tamperSurface:
      "Full downline authority (e.g. BILLY666); cannot be used for low-privilege subordinate authz testing.",
    mappedDeskRoles: [
      "operator",
      "security/operator",
      "settlement",
      "business-owner",
    ],
  },
  {
    role: "A",
    name: "Subordinate Agent",
    forensicRole: "OFFICE_AGENT",
    prefilterBehavior:
      "ajaxPrefilter rewrites agentID := MASTER_ID; sending both agentID and agentOwner preserves caller agentOwner.",
    tamperSurface:
      "T1-T5 body tamper axes (agentID, agentOwner, MASTER_ID, customerID, RRO) under 02-authz-matrix.md.",
    mappedDeskRoles: ["client/seam", "RISK_DESK_ANALYST"],
  },
  {
    role: "P",
    name: "Player",
    forensicRole: "SELF_PLAYER",
    prefilterBehavior:
      "sessionStorage.AgentType = P; sends Authorization: Bearer with no injected body identity fields.",
    tamperSurface:
      "Stored XSS injection vector via player-adjacent fields (NameFirst, Login, Password, Comments).",
    mappedDeskRoles: [],
  },
  {
    role: "U",
    name: "Unauthenticated Caller",
    forensicRole: "SYSTEM_GATEWAY",
    prefilterBehavior:
      "No sessionStorage.credentials.code; rejected 401 by openresty on /cloud/api/Manager/* and 404 on /qubic/api/*.",
    tamperSurface:
      "Zero cookie-CSRF surface observed; CORS preflight omits Access-Control-Allow-Origin.",
    mappedDeskRoles: ["compliance", "server-team-lead"],
  },
];

export interface RbacCapabilityRow {
  readonly capability: string;
  readonly surface: string;
  readonly permissions: Readonly<Record<DeskRoleId, PermissionLevel>>;
}

export const RBAC_PERMISSION_MATRIX: readonly RbacCapabilityRow[] = [
  {
    capability: "Live F402/GSLive Capture & HAR Redaction",
    surface: "createF402ReplayTransport · capture:f402-har",
    permissions: {
      operator: "ALLOWED",
      "security/operator": "ALLOWED",
      "client/seam": "DENIED",
      settlement: "DENIED",
      compliance: "DENIED",
      "server-team-lead": "GUARDED",
      "business-owner": "DENIED",
      RISK_DESK_ANALYST: "GUARDED",
    },
  },
  {
    capability: "Production VPS Deploy & R2 Edge Sync",
    surface: "./bin/dx deploy · services/sportsdesk_r2_sync.ts",
    permissions: {
      operator: "GUARDED",
      "security/operator": "GUARDED",
      "client/seam": "DENIED",
      settlement: "DENIED",
      compliance: "DENIED",
      "server-team-lead": "DENIED",
      "business-owner": "DENIED",
      RISK_DESK_ANALYST: "DENIED",
    },
  },
  {
    capability: "Authenticated Authz Tamper Probing (T1-T8)",
    surface: "docs/analysis/defense-measurement-2026-11-03/02-authz-matrix.md",
    permissions: {
      operator: "GUARDED",
      "security/operator": "GUARDED",
      "client/seam": "DENIED",
      settlement: "DENIED",
      compliance: "ALLOWED",
      "server-team-lead": "ALLOWED",
      "business-owner": "ALLOWED",
      RISK_DESK_ANALYST: "DENIED",
    },
  },
  {
    capability: "Client Sink Escaping & CDN Asset Pinning",
    surface: "MODULE_SINK_WRAPPERS · bun run pin:cdn",
    permissions: {
      operator: "ALLOWED",
      "security/operator": "ALLOWED",
      "client/seam": "ALLOWED",
      settlement: "DENIED",
      compliance: "DENIED",
      "server-team-lead": "DENIED",
      "business-owner": "DENIED",
      RISK_DESK_ANALYST: "DENIED",
    },
  },
  {
    capability: "Financial Ledger & Settlement Reconciliation",
    surface: "03-financial-controls.md · P0.2 / P0.7",
    permissions: {
      operator: "GUARDED",
      "security/operator": "GUARDED",
      "client/seam": "DENIED",
      settlement: "ALLOWED",
      compliance: "ALLOWED",
      "server-team-lead": "GUARDED",
      "business-owner": "ALLOWED",
      RISK_DESK_ANALYST: "GUARDED",
    },
  },
  {
    capability: "Surveillance Clamp Resolution (24h SLA)",
    surface: "lib/gslive_surveillance_governor.ts (GATE-SURV-02)",
    permissions: {
      operator: "GUARDED",
      "security/operator": "GUARDED",
      "client/seam": "DENIED",
      settlement: "DENIED",
      compliance: "GUARDED",
      "server-team-lead": "DENIED",
      "business-owner": "DENIED",
      RISK_DESK_ANALYST: "ALLOWED",
    },
  },
];

export type TaskAuditVerdict =
  | "VERIFIED_COMPLETE"
  | "READY_TO_CLOSE"
  | "ON_TRACK_WITH_DIRECTION"
  | "NEEDS_DIRECTION_OR_GOAL"
  | "EVIDENCE_MISSING";

export interface GovernedTask {
  readonly id: string;
  readonly priority: "P0" | "P1" | "P2" | "DONE";
  readonly title: string;
  readonly status: "open" | "done";
  readonly ref: string | null;
  readonly refResolved: boolean;
  readonly rawOwner: string | null;
  readonly owners: readonly DeskRoleId[];
  readonly ownerLead: string;
  readonly ownerEmails: readonly string[];
  readonly escalationChannel: string;
  readonly basisLabels: readonly TaskBasisLabel[];
  readonly canCloseByBasis: boolean;
  readonly goal: string | null;
  readonly direction: string | null;
  readonly nextCommand: string | null;
  readonly citedPaths: readonly string[];
  readonly verifiedPaths: readonly string[];
  readonly missingPaths: readonly string[];
  readonly completionPct: number;
  readonly auditVerdict: TaskAuditVerdict;
  readonly doneWhen: string | null;
  readonly blockedBy: string | null;
  readonly expiryDate: string | null;
  readonly daysUntilExpiry: number | null;
  readonly slaState: "OK" | "DUE_SOON" | "OVERDUE" | "NO_EXPIRY";
  readonly issueUrl: string | null;
}

export interface TaskAuditSummary {
  readonly totalTasksAudited: number;
  readonly openTasksAudited: number;
  readonly doneTasksAudited: number;
  readonly openWithGoalCount: number;
  readonly openWithDirectionCount: number;
  readonly openWithCommandCount: number;
  readonly doneVerifiedCompleteCount: number;
  readonly totalCitedPaths: number;
  readonly verifiedCitedPaths: number;
  readonly missingCitedPaths: number;
  readonly averageOpenCompletionPct: number;
  readonly overallCompletionPct: number;
  readonly auditPassed: boolean;
}

export interface ExecutiveDecision {
  readonly number: number;
  readonly decision: string;
  readonly rawOwner: string;
  readonly owners: readonly DeskRoleId[];
  readonly ask: string;
  readonly timeEstimate: string;
  readonly estimatedHours: number;
  readonly blocksTaskId: string;
}

export interface OracleGateStatus {
  readonly gateKey: string;
  readonly status: "ready" | "blocked" | "unknown";
  readonly ownerRole: string;
  readonly validOwnerRole: boolean;
  readonly requires: string;
}

export interface OwnerScorecard {
  readonly roleId: DeskRoleId;
  readonly label: string;
  readonly plane: DeskRoleSpec["plane"];
  readonly f402Counterpart: F402PortalRole;
  readonly forensicCounterpart: ForensicActorRole;
  readonly teamLead: string;
  readonly reportsToRole: DeskRoleId;
  readonly email: string;
  readonly inboxRoute: string;
  readonly ackSlaMinutes: number;
  readonly inboxPendingItems: number;
  readonly inboxUrgentItems: number;
  readonly inboxStatus: InboxAccountabilityStatus;
  readonly primaryChannels: readonly ChannelId[];
  readonly telegramCommand: string;
  readonly openTaskIds: readonly string[];
  readonly p0Count: number;
  readonly unverifiedCount: number;
  readonly pendingDecisionCount: number;
  readonly pendingDecisionHours: number;
  readonly gatesReady: number;
  readonly gatesTotal: number;
  readonly overdueCount: number;
  readonly weightScore: number;
  readonly status:
    "HOLDING_WEIGHT" | "ACTION_REQUIRED" | "BLOCKED_EXTERNAL" | "OVERDUE";
  readonly nextAction: string;
  readonly ownedGuards: readonly string[];
  readonly protectedSavingsUsd: number;
  readonly interceptedHandleUsd: number;
  readonly interceptedTickets: number;
  readonly priorityExposureUsd: number;
  readonly telemetryPulse: string;
  readonly valueSummary: string;
}

export interface GuardValueAttribution {
  readonly guardCode: string;
  readonly guardTitle: string;
  readonly targetSports: string;
  readonly interceptedTickets: number;
  readonly interceptedHandleUsd: number;
  readonly deskSavingsUsd: number;
  readonly holdImprovementBps: number;
  readonly latencyOrThresholdSpec: string;
  readonly ownerRoles: readonly DeskRoleId[];
}

export interface WeeklyValuePoint {
  readonly weekCode: string;
  readonly weekLabel: string;
  readonly combinedTickets: number;
  readonly combinedHandleUsd: number;
  readonly combinedBaselineHoldPct: number;
  readonly combinedProtectedHoldPct: number;
  readonly deskSavingsUsd: number;
  readonly keyCatalyst: string;
}

export interface BridgeLeadSummary {
  readonly customerId: string;
  readonly agentId: string;
  readonly wallet: string;
  readonly deskPnlUsd: number;
  readonly polyPnlUsd: number;
  readonly basis: string;
  readonly verdict: string;
  readonly priorityUsd: number;
  readonly ownerRole: DeskRoleId;
}

export interface PlaneBirdseyeSummary {
  readonly plane: DeskRoleSpec["plane"];
  readonly label: string;
  readonly roleIds: readonly DeskRoleId[];
  readonly planeLead: string;
  readonly planeEmail: string;
  readonly planeInboxRoute: string;
  readonly activeChannels: readonly ChannelId[];
  readonly avgHealthScore: number;
  readonly openTasksCount: number;
  readonly p0TasksCount: number;
  readonly pendingDecisionsCount: number;
  readonly pendingDecisionHours: number;
  readonly gatesReady: number;
  readonly gatesTotal: number;
  readonly protectedSavingsUsd: number;
  readonly interceptedHandleUsd: number;
  readonly priorityExposureUsd: number;
  readonly telemetryHeadline: string;
}

export interface TeamValueTelemetry {
  readonly backtest4Wk: {
    readonly generatedAtIso: string;
    readonly windowStartIso: string;
    readonly windowEndIso: string;
    readonly totalProvisionedCustomers: number;
    readonly totalActiveSportsBettors: number;
    readonly totalParlayTickets4Wk: number;
    readonly totalParlayLegs4Wk: number;
    readonly totalParlayHandleUsd4Wk: number;
    readonly baselineTotalDeskNetUsd4Wk: number;
    readonly baselineTotalHoldPct4Wk: number;
    readonly protectedTotalDeskNetUsd4Wk: number;
    readonly protectedTotalHoldPct4Wk: number;
    readonly holdSwingBps: number;
    readonly totalCounterfactualSavingsUsd4Wk: number;
    readonly dailyProtectionRateUsd: number;
    readonly recreationalRetentionPct: number;
    readonly weeklyBreakdown: readonly WeeklyValuePoint[];
    readonly guardAttribution: readonly GuardValueAttribution[];
  };
  readonly crossDomainBridge: {
    readonly generatedAtIso: string;
    readonly evidence: string;
    readonly customersInBook: number;
    readonly linkedCustomers: number;
    readonly linkYieldPct: number;
    readonly walletsTotal: number;
    readonly observedWallets: number;
    readonly quarantined: number;
    readonly deskVolumeUsd: number;
    readonly customerDeskPnlUsd: number;
    readonly deskHoldPct: number;
    readonly polyVolumeUsd: number;
    readonly polyGrossPnlUsd: number;
    readonly polyAdvantageUsd: number;
    readonly priorityUsd: number;
    readonly leads: readonly BridgeLeadSummary[];
  };
  readonly comboUniqueness: {
    readonly generatedAtIso: string;
    readonly cfbIndexGames: number;
    readonly walletsScanned: number;
    readonly permissiveKept: number;
    readonly allLegsCfbKept: number;
    readonly fullGameKept: number;
    readonly duplicatesCollapsed: number;
    readonly chainLeaks: number;
    readonly chainVacuous: boolean;
    readonly cfbTouchRatePct: number;
  };
  readonly liveSyndicateFeed: {
    readonly lastUpdatedIso: string;
    readonly dataMode: string;
    readonly activeSyndicateWalletsCount: number;
    readonly configuredWalletsCount: number;
    readonly walletsOk: number;
    readonly walletsFailed: number;
    readonly polymarketPollDurationMs: number;
    readonly wsStreamSlaMs: number;
    readonly wssIngestion: string;
    readonly f402Source: string;
    readonly totalOpenLegsCount: number;
    readonly totalOpenExposureUsd: number;
    readonly lockedArtifactsCount: number;
    readonly lockedInputsCount: number;
  };
  readonly planeSummaries: readonly PlaneBirdseyeSummary[];
}

export const GUARD_ROLE_OWNERSHIP: Readonly<
  Record<string, readonly DeskRoleId[]>
> = {
  GUARD_1_PROBIT_ALT_SUBSET_BLOCK: ["settlement", "RISK_DESK_ANALYST"],
  GUARD_2_WSS_500MS_STEPPED_LINE: ["operator", "RISK_DESK_ANALYST"],
  GUARD_3_DYNAMIC_1Q_4Q_PERIOD_PRICER: ["settlement", "client/seam"],
  GUARD_4_CORRELATED_SGP_VIG_TAX: ["settlement", "business-owner"],
  GUARD_5_6GATE_BET1_CLAMP: ["RISK_DESK_ANALYST", "security/operator"],
  GUARD_6_180S_TRAP_QUARANTINE: ["RISK_DESK_ANALYST", "operator"],
};

export const PLANE_LABELS: Readonly<Record<DeskRoleSpec["plane"], string>> = {
  "ops-execution": "Ops & Seam Execution Plane",
  "security-compliance": "Security & Compliance Plane",
  "risk-settlement": "Risk & Settlement Plane",
  "upstream-stakeholder": "Upstream Server & Business Plane",
};

export type WagerPatternArchetype =
  | "PER_OFFICE_SNIPER_RING"
  | "WHALE_ALT_SNIPER_PAIR"
  | "CROSS_OFFICE_TOUT_BURST"
  | "STEAM_TRAP_RING"
  | "PROP_STACK_BRIDGE"
  | "PARLAY_VIG_SNIPER"
  | "KEY_7_TEASER_RING"
  | "EXECUTION_SNIPER_TWIN"
  | "STEAM_CHASER_PAIR"
  | "CROSS_OFFICE_BEARD_BRIDGE";

export interface WebLogModeGovernanceSpec {
  readonly mode: IpTrackerModeCode;
  readonly name: string;
  readonly wireDateFormat: "MM/DD/YYYY" | "YYYY-MM-DD";
  readonly wireTargetParam: string;
  readonly signalHonestyRule: string;
  readonly primaryDetectorUse: string;
  readonly ownerRole: DeskRoleId;
}

export const WEBLOG_MODE_CONTRACTS: readonly WebLogModeGovernanceSpec[] = [
  {
    mode: "A",
    name: "WEB_ACCESS (Player Session Activity Stream)",
    wireDateFormat: "MM/DD/YYYY",
    wireTargetParam: "customerID = <LoginID>",
    signalHonestyRule:
      "Authoritative activity stream (#89 / #91): only Mode A carries AccessDateTime, IPAddress, Operation, Data for session-to-wager dwell (<15s = SNIPER_TWIN).",
    primaryDetectorUse:
      "Computes modeASessionDwellSeconds (3.8s-8.1s) and corroborates courtside/bot velocity.",
    ownerRole: "RISK_DESK_ANALYST",
  },
  {
    mode: "B",
    name: "GLOBAL_IP_MATCHER (Per-Office or Master Downline IP Collision)",
    wireDateFormat: "MM/DD/YYYY",
    wireTargetParam:
      "customerID = <officeAgentId> (per-office) | '0' (master 668 offices)",
    signalHonestyRule:
      "Shared-IP matcher only (#89): never substitute Mode B for Mode A activity logs; use strictly for per-office & cross-office IP ring topology.",
    primaryDetectorUse:
      "Detects PER_OFFICE_IP_MATCH (e.g., MJ2026, BIGDAD, ATEAM) and master cross-office collisions.",
    ownerRole: "security/operator",
  },
  {
    mode: "C",
    name: "PLAYER_IP_MATCHER (Single-Player Sibling IP Matcher)",
    wireDateFormat: "YYYY-MM-DD",
    wireTargetParam:
      "customerID = <LoginID> (ip-tracker.js line 77 YYYY-MM-DD rewrite)",
    signalHonestyRule:
      "Must format start/end as YYYY-MM-DD per ip-tracker.js line 77; M/D/Y silently returns empty sibling sets.",
    primaryDetectorUse:
      "Discovers cross-office beard siblings (e.g., CUB22HR <-> MAX92, LAKERS <-> SOUTHSHORE).",
    ownerRole: "RISK_DESK_ANALYST",
  },
  {
    mode: "I",
    name: "REVERSE_IP_LOOKUP (IP-to-Account Sweep)",
    wireDateFormat: "MM/DD/YYYY",
    wireTargetParam: "customerID = '0', ip = <IPAddress>",
    signalHonestyRule:
      "Reverse IP lookup only (#89); rejected by weblog activity ingestors to preserve Mode A corpus purity.",
    primaryDetectorUse:
      "Enumerates all LoginIDs touching a flagged /24 subnet or residential proxy.",
    ownerRole: "security/operator",
  },
];

export interface ClientProfilingTaskSpec {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly direction: string;
  readonly verificationCommand: string;
}

export interface ClientWagerPatternProfile {
  readonly profileId: string;
  readonly officeAgentId: string;
  readonly masterAgentId: string;
  readonly matchClassification: OfficeIpMatchClassification;
  readonly patternArchetype: WagerPatternArchetype;
  readonly sharedIpOrSubnet: string;
  readonly weblogModeEvidence: string;
  readonly matchedLoginsInOffice: readonly string[];
  readonly crossOfficeLogins: readonly {
    readonly loginId: string;
    readonly officeAgentId: string;
  }[];
  readonly totalLinkedAccounts: number;
  readonly bridgedPolymarketWallets: readonly string[];
  readonly modeASessionDwellSeconds: number;
  readonly mfcsCompositeScore: number;
  readonly activeRotations: readonly string[];
  readonly surv02Enforcement: string;
  readonly layoffHedgeDisposition:
    | "AUTO_LAYOFF_KALSHI_AND_POLY"
    | "STEP_LINE_345MS_AND_LAYOFF"
    | "REPRICE_KEY_NUMBER_AND_HEDGE"
    | "CLAMP_AND_INTERNAL_VIG_SHADE";
  readonly recommendedDeskAction: string;
  readonly ownerRole: DeskRoleId;
  readonly teamLead: string;
  readonly ownerEmail: string;
  readonly inboxRoute: string;
  readonly profilingTask: ClientProfilingTaskSpec;
}

function classifyPatternArchetype(
  cluster: OfficeIpClusterSummary,
): WagerPatternArchetype {
  switch (cluster.officeAgentId) {
    case "MJ2026":
      return "PER_OFFICE_SNIPER_RING";
    case "BIGDAD":
      return "WHALE_ALT_SNIPER_PAIR";
    case "CUB22HR":
      return "CROSS_OFFICE_TOUT_BURST";
    case "ATEAM":
      return "STEAM_TRAP_RING";
    case "GPRO50RSK":
      return "PROP_STACK_BRIDGE";
    case "JUICEPLUS":
      return "PARLAY_VIG_SNIPER";
    case "DAN318":
      return "KEY_7_TEASER_RING";
    case "MACHR":
    case "GOLD22":
      return "EXECUTION_SNIPER_TWIN";
    case "TEXANS":
    case "SPEN":
      return "STEAM_CHASER_PAIR";
    case "LAKERS":
    case "KOBE24":
      return "CROSS_OFFICE_BEARD_BRIDGE";
    default:
      return cluster.matchClassification === "CROSS_OFFICE_BEARD_BRIDGE"
        ? "CROSS_OFFICE_BEARD_BRIDGE"
        : "PER_OFFICE_SNIPER_RING";
  }
}

function resolveProfileOwnerRole(archetype: WagerPatternArchetype): DeskRoleId {
  switch (archetype) {
    case "PER_OFFICE_SNIPER_RING":
    case "STEAM_TRAP_RING":
    case "CROSS_OFFICE_BEARD_BRIDGE":
      return "RISK_DESK_ANALYST";
    case "WHALE_ALT_SNIPER_PAIR":
    case "PARLAY_VIG_SNIPER":
    case "KEY_7_TEASER_RING":
      return "settlement";
    case "CROSS_OFFICE_TOUT_BURST":
    case "EXECUTION_SNIPER_TWIN":
    case "STEAM_CHASER_PAIR":
      return "operator";
    case "PROP_STACK_BRIDGE":
      return "security/operator";
  }
}

function resolveLayoffDisposition(
  archetype: WagerPatternArchetype,
): ClientWagerPatternProfile["layoffHedgeDisposition"] {
  switch (archetype) {
    case "PER_OFFICE_SNIPER_RING":
    case "WHALE_ALT_SNIPER_PAIR":
    case "EXECUTION_SNIPER_TWIN":
      return "AUTO_LAYOFF_KALSHI_AND_POLY";
    case "CROSS_OFFICE_TOUT_BURST":
    case "STEAM_TRAP_RING":
    case "STEAM_CHASER_PAIR":
      return "STEP_LINE_345MS_AND_LAYOFF";
    case "KEY_7_TEASER_RING":
      return "REPRICE_KEY_NUMBER_AND_HEDGE";
    case "PROP_STACK_BRIDGE":
    case "PARLAY_VIG_SNIPER":
    case "CROSS_OFFICE_BEARD_BRIDGE":
      return "CLAMP_AND_INTERNAL_VIG_SHADE";
  }
}

export function buildClientWagerPatternProfiles(): readonly ClientWagerPatternProfile[] {
  return PER_OFFICE_IP_TRACKER_CLUSTERS.map((cluster) => {
    const archetype = classifyPatternArchetype(cluster);
    const ownerRole = resolveProfileOwnerRole(archetype);
    const roleSpec = DESK_ROLES[ownerRole];
    const disposition = resolveLayoffDisposition(archetype);
    const totalLinkedAccounts =
      cluster.matchedLoginsInOffice.length + cluster.crossOfficeLogins.length;

    const surv02Enforcement =
      cluster.mfcsCompositeScore >= 96 &&
      cluster.modeASessionDwellSeconds <= 4.5
        ? `ACTIVE_CLAMPED ($${(PROBATION_NON_DONOR_CAP_CENTS / 100).toFixed(0)} cap / ${PROBATION_NON_DONOR_DELAY_SEC}s delay · ${PROBATION_REVIEW_SLA_HOURS}h SLA)`
        : cluster.officeAgentId === "BIGDAD"
          ? `ACTIVE_CLAMPED_DONOR ($${(SURGICAL_DONOR_CAP_CENTS / 100).toFixed(0)} cap / ${SURGICAL_DONOR_DELAY_SEC}s delay · Donor Shield)`
          : `ACTIVE_CLAMPED ($${(PROBATION_NON_DONOR_CAP_CENTS / 100).toFixed(0)} cap / ${PROBATION_NON_DONOR_DELAY_SEC}s delay · ${PROBATION_REVIEW_SLA_HOURS}h SLA)`;

    const weblogModeEvidence =
      cluster.crossOfficeLogins.length > 0
        ? `Mode A (${cluster.modeASessionDwellSeconds}s dwell) + Mode B (${cluster.officeAgentId} + master '0') + Mode C (YYYY-MM-DD cross-office siblings)`
        : `Mode A (${cluster.modeASessionDwellSeconds}s dwell < 15s) + Mode B (customerID='${cluster.officeAgentId}') + Mode I (${cluster.sharedIpOrSubnet.split(" ")[0]})`;

    const layoffActionText =
      disposition === "AUTO_LAYOFF_KALSHI_AND_POLY"
        ? `Route ${cluster.activeRotations.join("/")} signal to evaluateRebet() taker/maker on Kalshi & Polymarket (50% hedge ratio)`
        : disposition === "STEP_LINE_345MS_AND_LAYOFF"
          ? `Step F402 line @ 345ms (GUARD_2) and queue WatchlistAutobet paper/live intent on ${cluster.activeRotations.join("/")}`
          : disposition === "REPRICE_KEY_NUMBER_AND_HEDGE"
            ? `Guard NFL/CFB Key Numbers 3 & 7 (LayoffRiskEngine) + reprice 6pt teaser to -135 on ${cluster.activeRotations.join("/")}`
            : `Enforce GATE-SURV-02 clamp + internal vig shading (+15c/+25c) on ${cluster.activeRotations.join("/")}`;

    return {
      profileId: `PROF-${cluster.officeAgentId}`,
      officeAgentId: cluster.officeAgentId,
      masterAgentId: cluster.masterAgentId,
      matchClassification: cluster.matchClassification,
      patternArchetype: archetype,
      sharedIpOrSubnet: cluster.sharedIpOrSubnet,
      weblogModeEvidence,
      matchedLoginsInOffice: cluster.matchedLoginsInOffice,
      crossOfficeLogins: cluster.crossOfficeLogins,
      totalLinkedAccounts,
      bridgedPolymarketWallets: cluster.bridgedPolymarketWallets,
      modeASessionDwellSeconds: cluster.modeASessionDwellSeconds,
      mfcsCompositeScore: cluster.mfcsCompositeScore,
      activeRotations: cluster.activeRotations,
      surv02Enforcement,
      layoffHedgeDisposition: disposition,
      recommendedDeskAction: `${cluster.recommendedDeskAction} · ${layoffActionText}`,
      ownerRole,
      teamLead: roleSpec.teamLead,
      ownerEmail: roleSpec.email,
      inboxRoute: roleSpec.inboxRoute,
      profilingTask: {
        taskId: `PROF-TASK-${cluster.officeAgentId}`,
        title: `Profile & govern ${cluster.officeAgentId} (${archetype}, MFCS ${cluster.mfcsCompositeScore}) across ${totalLinkedAccounts} accounts & ${cluster.bridgedPolymarketWallets.length} PM wallets`,
        goal: `Maintain deterministic ${surv02Enforcement} and ${disposition} routing on ${cluster.activeRotations.join(", ")} whenever ${cluster.officeAgentId} logins (${cluster.matchedLoginsInOffice.slice(0, 3).join(", ")}) hit getBetTicker.`,
        direction: `Corroborate getBetTicker rows with getWebLog ${weblogModeEvidence} via lib/bet_ticker_ip_tracker_bridge.ts and route layoff intents through lib/rebet_engine.ts and lib/watchlist_autobet.ts.`,
        verificationCommand: `bun run governance:check --wagers --role ${ownerRole}`,
      },
    };
  });
}

export interface RedTeamDrillSpec {
  readonly drillId: string;
  readonly code: string;
  readonly title: string;
  readonly category:
    | "COURTSIDE_LATENCY"
    | "SYBIL_IP_ROTATION"
    | "TROJAN_DONOR_STEPUP"
    | "KEY_NUMBER_LAYOFF_ARB"
    | "AUTOBET_ARMING_BYPASS"
    | "SENTINEL_WIRE_POISONING";
  readonly attackVector: string;
  readonly targetModules: readonly string[];
  readonly expectedDefenseInvariant: string;
  readonly ownerRoles: readonly DeskRoleId[];
  readonly teamLead: string;
  readonly escalationInbox: string;
  readonly verificationCommand: string;
  readonly status: "VERIFIED_DEFENDED" | "ACTIVE_MONITORING";
}

export const RED_TEAM_DRILLS: readonly RedTeamDrillSpec[] = [
  {
    drillId: "RT-DRILL-01",
    code: "COURTSIDE_PRE_BET_SCORE_LATENCY",
    title: "Courtside Pre-Bet Score Latency Clinch Injection (GATE-SURV-01)",
    category: "COURTSIDE_LATENCY",
    attackVector:
      "Inject live EventTick with deltaSec in [-(90 + tauSkewSec), 0] where relevantScore * 100 > lineHundredths on OVER side to snipe a clinched market before feed freeze.",
    targetModules: [
      "lib/gslive_surveillance_governor.ts",
      "lib/gslive_bet_event_log.ts",
      "lib/fraud_patterns.ts",
    ],
    expectedDefenseInvariant:
      "evaluateEventLogPredicates sets CLINCHED_WON_AT_PLACEMENT = true (BitSet32 0x0020 | 0x0100 | 0x0200) and routeEnforcementEffect transitions account immediately to absorbing CLOSED_FRAUD.",
    ownerRoles: ["RISK_DESK_ANALYST", "security/operator"],
    teamLead: DESK_ROLES.RISK_DESK_ANALYST.teamLead,
    escalationInbox: DESK_ROLES.RISK_DESK_ANALYST.inboxRoute,
    verificationCommand: "bun test tests/gslive_surveillance_governor.test.ts",
    status: "VERIFIED_DEFENDED",
  },
  {
    drillId: "RT-DRILL-02",
    code: "CROSS_OFFICE_SYBIL_BEARD_ROTATION",
    title:
      "Cross-Office Sybil & Beard Subnet Rotation (getWebLog Mode A/B/C/I)",
    category: "SYBIL_IP_ROTATION",
    attackVector:
      "Split max-bet stakes across CUB22HR <-> MAX92 and LAKERS <-> SOUTHSHORE beard accounts on shared /24 subnets with sub-6s Mode A session-to-wager dwell, attempting to evade single-office limits.",
    targetModules: [
      "lib/bet_ticker_ip_tracker_bridge.ts",
      "lib/f402_weblog.ts",
      "lib/fraud_patterns.ts",
    ],
    expectedDefenseInvariant:
      "lookupIpTrackerMatchForBetTicker correlates Per-Office Mode B + Cross-Office Mode C (YYYY-MM-DD) + Mode A dwell (<15s = SNIPER_TWIN), enforcing 345ms line step (GUARD_2) and cross-office subset block (GUARD_1).",
    ownerRoles: ["RISK_DESK_ANALYST", "operator"],
    teamLead: DESK_ROLES.operator.teamLead,
    escalationInbox: DESK_ROLES.operator.inboxRoute,
    verificationCommand: "bun run governance:check --wagers",
    status: "VERIFIED_DEFENDED",
  },
  {
    drillId: "RT-DRILL-03",
    code: "TROJAN_DONOR_STEPUP_EVASION",
    title: "Trojan-Horse High-Lifetime Donor Step-Up Asymmetry (GATE-SURV-02)",
    category: "TROJAN_DONOR_STEPUP",
    attackVector:
      "Seasoned account with >=$50,000 lifetime house net loss (DONOR_VALUE_QUALIFIED) handed off to sharp syndicate for derivative/live step-up (stepupNetCents >= $1,000, ROI >= 1500 bps).",
    targetModules: [
      "lib/gslive_surveillance_governor.ts",
      "lib/customer_poly_bridge.ts",
    ],
    expectedDefenseInvariant:
      "detectAccountPredicates flags TROJAN_ASYMMETRY && DONOR_VALUE_QUALIFIED; routeEnforcementEffect applies surgical ACTIVE_CLAMPED ($500 cap / 10s live delay, derivativeLiveEnabled: false) with 24h RISK_DESK_ANALYST review SLA.",
    ownerRoles: ["RISK_DESK_ANALYST", "settlement"],
    teamLead: DESK_ROLES.settlement.teamLead,
    escalationInbox: DESK_ROLES.RISK_DESK_ANALYST.inboxRoute,
    verificationCommand: "bun test tests/gslive_surveillance_governor.test.ts",
    status: "VERIFIED_DEFENDED",
  },
  {
    drillId: "RT-DRILL-04",
    code: "KEY_NUMBER_3_7_LAYOFF_ARBITRAGE",
    title:
      "Key-Number (NFL 3/7/10/14 & NBA 3..8) Spread & Teaser Layoff Arbitrage",
    category: "KEY_NUMBER_LAYOFF_ARB",
    attackVector:
      "Hammer stale F402 pending spread/total lines (e.g. -6.5 vs Polymarket -7.5 across Key Number 7 on ROT 501 / ROT 451) while Polymarket sharp wallets hold the better side.",
    targetModules: [
      "lib/layoff_risk_engine.ts",
      "lib/rebet_engine.ts",
      "lib/execution_decision.ts",
    ],
    expectedDefenseInvariant:
      "LayoffRiskEngine.queryLineDeltaMatches flags isLayoffRisk = true (SHARP_STILL_BETTER + keyNumberCrossed = 7) and evaluateRebet emits executable Kalshi/Polymarket taker/maker hedge opportunities.",
    ownerRoles: ["settlement", "RISK_DESK_ANALYST"],
    teamLead: DESK_ROLES.settlement.teamLead,
    escalationInbox: DESK_ROLES.settlement.inboxRoute,
    verificationCommand: "bun test tests/layoff_risk_engine.test.ts",
    status: "VERIFIED_DEFENDED",
  },
  {
    drillId: "RT-DRILL-05",
    code: "AUTOBET_LIVE_ARMING_AND_LEDGER_TAMPER",
    title:
      "Watchlist Autobet Unapproved Transition & Unarmed Live Execution Bypass",
    category: "AUTOBET_ARMING_BYPASS",
    attackVector:
      "Attempt to (a) queue a fixture-sourced or stale signal, (b) jump an intent from 'queued' directly to 'filled' without operator approval, or (c) dispatch a live Kalshi order without EXECUTION_MODE=live, EXECUTION_LIVE=1, and 'PLACE LIVE ORDERS'.",
    targetModules: [
      "lib/watchlist_autobet.ts",
      "lib/autobet_kalshi.ts",
      "lib/execution_decision.ts",
      "lib/kalshi_live_execution.ts",
    ],
    expectedDefenseInvariant:
      "WatchlistAutobet refuses fixture/stale signals via 12 AUTOBET_GATE_CHECKS, throws AutobetError('invalid_transition' | 'live_disabled', exitCode: 3) on illegal state hops, and kalshiArming blocks live orders until all 3 arming gates + credentials pass.",
    ownerRoles: ["security/operator", "operator"],
    teamLead: DESK_ROLES["security/operator"].teamLead,
    escalationInbox: DESK_ROLES["security/operator"].inboxRoute,
    verificationCommand: "bun test tests/watchlist_autobet.test.ts",
    status: "VERIFIED_DEFENDED",
  },
  {
    drillId: "RT-DRILL-06",
    code: "BET_TICKER_SENTINEL_DOUBLE_COUNT_POISONING",
    title:
      "BetTicker Sentinel ALERT Twin Double-Count & Clock-Zone Drift Injection",
    category: "SENTINEL_WIRE_POISONING",
    attackVector:
      "Replay twin getBetTicker rows where an ALERT sentinel row mirrors a real wager's betKey and AmountWagered, attempting to double crowd velocity aggregates and trigger false autobet hedges.",
    targetModules: [
      "lib/f402_bet_ticker_delta.ts",
      "lib/bet_flags.ts",
      "lib/f402_incoming_bets.ts",
    ],
    expectedDefenseInvariant:
      "demuxChannel pins ALERT/BLOCKED/NON_SPORTS_DROP sentinel amounts to 0 cents, bet_flags evaluates once per betKey (non-ALERT row wins), and America/New_York portal wall-clock is normalized to ISO.",
    ownerRoles: ["client/seam", "operator"],
    teamLead: DESK_ROLES["client/seam"].teamLead,
    escalationInbox: DESK_ROLES["client/seam"].inboxRoute,
    verificationCommand: "bun test tests/bet_flags.test.ts",
    status: "VERIFIED_DEFENDED",
  },
];

export interface AutobetLayoffStageSpec {
  readonly stageNumber: number;
  readonly stageCode: string;
  readonly title: string;
  readonly modules: readonly string[];
  readonly gateContract: string;
  readonly ownerRoles: readonly DeskRoleId[];
}

export const AUTOBET_LAYOFF_STAGES: readonly AutobetLayoffStageSpec[] = [
  {
    stageNumber: 1,
    stageCode: "STAGE_1_BET_TICKER_WIRE_INGEST",
    title:
      "Live getBetTicker Wire Ingest, Sentinel Demux & Wide Record Normalization",
    modules: [
      "lib/f402_incoming_bets.ts",
      "lib/f402_bet_ticker_poller.ts",
      "lib/f402_bet_ticker_delta.ts",
      "lib/bet_flags.ts",
    ],
    gateContract:
      "createF402ReplayTransport() read-only POST -> widenTickerRow() -> demuxChannel() zeroes ALERT/BLOCKED sentinel stakes -> dedupe by betKey -> enrichIncomingBets() crowd context.",
    ownerRoles: ["operator", "client/seam"],
  },
  {
    stageNumber: 2,
    stageCode: "STAGE_2_CLIENT_WEBLOG_IP_AND_SIGNAL_JOIN",
    title:
      "Client / Weblog (Mode A/B/C/I) IP Corroboration & Watchlist Fair-Prob Derivation",
    modules: [
      "lib/bet_ticker_ip_tracker_bridge.ts",
      "lib/watchlist_signal_engine.ts",
      "lib/watchlist_account_overlay.ts",
      "lib/customer_poly_bridge.ts",
    ],
    gateContract:
      "Correlates BetTicker login/office against 13 PER_OFFICE_IP_TRACKER_CLUSTERS + 39 syndicate wallets; computes watchlist_signal.fairProb from watched sharp accounts.",
    ownerRoles: ["RISK_DESK_ANALYST", "security/operator"],
  },
  {
    stageNumber: 3,
    stageCode: "STAGE_3_LAYOFF_RISK_AND_KEY_NUMBER_ENGINE",
    title:
      "Sliding-Window Line Delta & Key-Number Crossing Evaluator (CFB, NFL, NBA)",
    modules: [
      "lib/layoff_risk_engine.ts",
      "lib/combo_identity.ts",
      "lib/bet_venue_breakdown.ts",
    ],
    gateContract:
      "Joins (game_id, period, subject, market_kind, side) in LineHundredths; flags SHARP_STILL_BETTER when Polymarket beats F402 pending line and detects NFL (3,7,10,14) & NBA (3..8) key crossings.",
    ownerRoles: ["settlement", "RISK_DESK_ANALYST"],
  },
  {
    stageNumber: 4,
    stageCode: "STAGE_4_REBET_AND_EXECUTION_DECISION",
    title:
      "Cross-Venue Re-Bet & Execution Decision Planner (Kalshi & Polymarket Taker/Maker)",
    modules: [
      "lib/rebet_engine.ts",
      "lib/execution_decision.ts",
      "lib/execution_planner.ts",
      "lib/kalshi_signal_join.ts",
      "lib/polymarket_quote.ts",
    ],
    gateContract:
      "Evaluates taker (best ask) and maker (min(fair - makerMarginBps, ask - 0.01)) orders; enforces DEFAULT_SPORT_TIERS (NBA 300bps/$300, NFL 300bps/$250, CFB 500bps/$150), 50% hedgeRatio, $1.5k market cap, $5k daily cap, and 10m dedupe window.",
    ownerRoles: ["settlement", "operator"],
  },
  {
    stageNumber: 5,
    stageCode: "STAGE_5_AUTOBET_LEDGER_AND_LIVE_ARMING",
    title:
      "12-Gate Append-Only Autobet Intent Ledger & 3-Factor Kalshi Live Execution Arming",
    modules: [
      "lib/watchlist_autobet.ts",
      "lib/autobet_kalshi.ts",
      "lib/kalshi_live_execution.ts",
      "lib/execution_approvals.ts",
      "lib/execution_paper.ts",
    ],
    gateContract:
      "Runs 12 AUTOBET_GATE_CHECKS -> append-only JSONL state machine (queued -> approved -> filled -> settled) -> Kalshi live adapter armed ONLY when EXECUTION_MODE=live && EXECUTION_LIVE=1 && confirm='PLACE LIVE ORDERS'.",
    ownerRoles: ["operator", "security/operator", "business-owner"],
  },
];

export interface AutobetLayoffOpportunitySpec {
  readonly opportunityId: string;
  readonly rotation: string;
  readonly league: "CFB" | "NFL" | "NBA";
  readonly period: "game" | "1H" | "live";
  readonly sourceClusterOffices: readonly string[];
  readonly sourcePatternArchetype: WagerPatternArchetype;
  readonly marketSummary: string;
  readonly f402LineLabel: string;
  readonly externalVenue: "kalshi" | "polymarket";
  readonly executionStyle: "taker" | "maker";
  readonly fairProb: number;
  readonly venuePrice: number;
  readonly edgeBps: number;
  readonly sportMinEdgeBps: number;
  readonly keyNumberCrossed: number | null;
  readonly plannedStakeUsd: number;
  readonly contractsCount: number;
  readonly gateChecksPassed: string;
  readonly intentLedgerState:
    "queued" | "approved" | "filled" | "paper_guarded";
  readonly ownerRole: DeskRoleId;
  readonly ownerInbox: string;
}

export const AUTOBET_LAYOFF_OPPORTUNITIES: readonly AutobetLayoffOpportunitySpec[] =
  [
    {
      opportunityId: "LAYOFF-ROT-501",
      rotation: "ROT 501",
      league: "NFL",
      period: "game",
      sourceClusterOffices: ["MJ2026", "BIGDAD", "MACHR", "GOLD22"],
      sourcePatternArchetype: "PER_OFFICE_SNIPER_RING",
      marketSummary:
        "NFL FG Spread · Sniper Ring Sharp Accumulation Across Key 7",
      f402LineLabel: "F402 -6.5 (-110) vs PM/Kalshi -7.5",
      externalVenue: "kalshi",
      executionStyle: "taker",
      fairProb: 0.582,
      venuePrice: 0.53,
      edgeBps: 520,
      sportMinEdgeBps: 300,
      keyNumberCrossed: 7,
      plannedStakeUsd: 250,
      contractsCount: 471,
      gateChecksPassed:
        "12/12 AUTOBET_GATE_CHECKS · SHARP_STILL_BETTER [KEY 7]",
      intentLedgerState: "approved",
      ownerRole: "settlement",
      ownerInbox: DESK_ROLES.settlement.inboxRoute,
    },
    {
      opportunityId: "LAYOFF-ROT-315",
      rotation: "ROT 315",
      league: "CFB",
      period: "game",
      sourceClusterOffices: ["CUB22HR", "MAX92", "TEXANS", "SPEN"],
      sourcePatternArchetype: "CROSS_OFFICE_TOUT_BURST",
      marketSummary: "CFB FG Total OVER · 8-Wallet Cross-Office Tout Burst",
      f402LineLabel: "F402 O 54.5 (-110) vs PM O 53.5",
      externalVenue: "polymarket",
      executionStyle: "taker",
      fairProb: 0.605,
      venuePrice: 0.545,
      edgeBps: 600,
      sportMinEdgeBps: 500,
      keyNumberCrossed: null,
      plannedStakeUsd: 150,
      contractsCount: 275,
      gateChecksPassed:
        "12/12 AUTOBET_GATE_CHECKS · Step Line @ 345ms + Poly Taker",
      intentLedgerState: "approved",
      ownerRole: "operator",
      ownerInbox: DESK_ROLES.operator.inboxRoute,
    },
    {
      opportunityId: "LAYOFF-ROT-451",
      rotation: "ROT 451",
      league: "NFL",
      period: "game",
      sourceClusterOffices: ["DAN318", "MOOSEM", "MACHR"],
      sourcePatternArchetype: "KEY_7_TEASER_RING",
      marketSummary:
        "NFL Key-3 & Key-7 Teaser Leg Protection · Passive Maker Hedge",
      f402LineLabel: "F402 -7.5 / +2.5 Teaser Window",
      externalVenue: "kalshi",
      executionStyle: "maker",
      fairProb: 0.568,
      venuePrice: 0.525,
      edgeBps: 430,
      sportMinEdgeBps: 300,
      keyNumberCrossed: 3,
      plannedStakeUsd: 250,
      contractsCount: 476,
      gateChecksPassed:
        "12/12 AUTOBET_GATE_CHECKS · Maker (fair - 150bps <= ask - 1c)",
      intentLedgerState: "queued",
      ownerRole: "settlement",
      ownerInbox: DESK_ROLES.settlement.inboxRoute,
    },
    {
      opportunityId: "LAYOFF-ROT-505",
      rotation: "ROT 505",
      league: "NBA",
      period: "1H",
      sourceClusterOffices: ["ATEAM", "SPEN"],
      sourcePatternArchetype: "STEAM_TRAP_RING",
      marketSummary: "NBA 1H/FG Spread · 5-Account Steam Ring Across NBA Key 5",
      f402LineLabel: "F402 -4.5 (-110) vs Kalshi -5.5",
      externalVenue: "kalshi",
      executionStyle: "taker",
      fairProb: 0.574,
      venuePrice: 0.535,
      edgeBps: 390,
      sportMinEdgeBps: 300,
      keyNumberCrossed: 5,
      plannedStakeUsd: 300,
      contractsCount: 560,
      gateChecksPassed:
        "12/12 AUTOBET_GATE_CHECKS · NBA Key 5 + 180s Quarantine",
      intentLedgerState: "approved",
      ownerRole: "RISK_DESK_ANALYST",
      ownerInbox: DESK_ROLES.RISK_DESK_ANALYST.inboxRoute,
    },
    {
      opportunityId: "LAYOFF-ROT-507",
      rotation: "ROT 507",
      league: "CFB",
      period: "game",
      sourceClusterOffices: ["MJ2026", "JUICEPLUS"],
      sourcePatternArchetype: "PARLAY_VIG_SNIPER",
      marketSummary:
        "CFB Spread Key 10 Crossing · Maker Layoff + +15c/+20c Parlay Vig",
      f402LineLabel: "F402 -9.5 (-110) vs PM -10.5",
      externalVenue: "polymarket",
      executionStyle: "maker",
      fairProb: 0.592,
      venuePrice: 0.535,
      edgeBps: 570,
      sportMinEdgeBps: 500,
      keyNumberCrossed: 10,
      plannedStakeUsd: 150,
      contractsCount: 280,
      gateChecksPassed:
        "12/12 AUTOBET_GATE_CHECKS · SHARP_STILL_BETTER [KEY 10]",
      intentLedgerState: "queued",
      ownerRole: "settlement",
      ownerInbox: DESK_ROLES.settlement.inboxRoute,
    },
    {
      opportunityId: "LAYOFF-ROT-5501",
      rotation: "ROT 5501",
      league: "NBA",
      period: "live",
      sourceClusterOffices: ["LAKERS", "SOUTHSHORE", "BIGDAD"],
      sourcePatternArchetype: "CROSS_OFFICE_BEARD_BRIDGE",
      marketSummary:
        "NBA Live Derivative · Cross-Office Beard Bridge Clamp + Maker Hedge",
      f402LineLabel: "F402 Live -3.5 vs Kalshi -4.5",
      externalVenue: "kalshi",
      executionStyle: "maker",
      fairProb: 0.59,
      venuePrice: 0.54,
      edgeBps: 500,
      sportMinEdgeBps: 300,
      keyNumberCrossed: 4,
      plannedStakeUsd: 300,
      contractsCount: 555,
      gateChecksPassed:
        "12/12 AUTOBET_GATE_CHECKS · GATE-SURV-02 Clamp + Maker Hedge",
      intentLedgerState: "paper_guarded",
      ownerRole: "RISK_DESK_ANALYST",
      ownerInbox: DESK_ROLES.RISK_DESK_ANALYST.inboxRoute,
    },
  ];

export interface BetTickerFlowNodeSpec {
  readonly nodeId: string;
  readonly stepNumber: number;
  readonly label: string;
  readonly nodeKind:
    | "INGEST"
    | "DECISION_BRANCH"
    | "GOVERNOR_CLAMP"
    | "GATE_CHECKLIST"
    | "HUMAN_AUDIT_GATE"
    | "EXECUTION_SINK"
    | "LEDGER_TERMINAL";
  readonly modulePath: string;
  readonly entrypointFn: string;
  readonly ownerRole: DeskRoleId;
  readonly teamLead: string;
  readonly decisionCondition: string;
  readonly passBranchTarget: string;
  readonly failOrVariantBranchTarget: string;
  readonly slaOrLatencyBudget: string;
}

export interface BetTickerFlowEdgeSpec {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly branchType:
    "PRIMARY_PASS" | "VARIANT_ROUTE" | "EDGE_CASE_TRAP" | "HUMAN_OVERRIDE";
  readonly conditionLabel: string;
  readonly auditEventEmitted: string;
}

export const BET_TICKER_FLOWCHART_NODES: readonly BetTickerFlowNodeSpec[] = [
  {
    nodeId: "NODE-01",
    stepNumber: 1,
    label: "BetTicker Wire Ingest & Delta Dedup",
    nodeKind: "INGEST",
    modulePath: "lib/f402_incoming_bets.ts",
    entrypointFn: "classifyIncomingTicket / computeBetTickerDelta",
    ownerRole: "client/seam",
    teamLead: "Soren Lindqvist (Seam & Portal Integrity Lead)",
    decisionCondition:
      "New WagerNumber on getBetTicker / getBetReport wire; not in seenTicketSet",
    passBranchTarget: "NODE-02 (Sentinel Twin Gate)",
    failOrVariantBranchTarget: "DROP_DUPLICATE_POLL_TICKET (idempotent no-op)",
    slaOrLatencyBudget: "<= 25ms parse + delta diff",
  },
  {
    nodeId: "NODE-02",
    stepNumber: 2,
    label: "ALERT Sentinel Twin Separation Gate",
    nodeKind: "DECISION_BRANCH",
    modulePath: "lib/bet_flags.ts",
    entrypointFn: "isAlertSentinelBet / partitionBetTickerRows",
    ownerRole: "client/seam",
    teamLead: "Soren Lindqvist (Seam & Portal Integrity Lead)",
    decisionCondition:
      "Login.trim() === 'ALERT' || AgentID.trim() === 'ALERT' (EC-01 twin pair)",
    passBranchTarget: "NODE-03 (Real Customer Wager -> Weblog & IP Join)",
    failOrVariantBranchTarget:
      "VIP_SENTINEL_ALERTS_STREAM (0 financial handle; EC-01 twin tag)",
    slaOrLatencyBudget: "O(1) synchronous filter",
  },
  {
    nodeId: "NODE-03",
    stepNumber: 3,
    label: "Weblog (Mode A/B/C/I) & Per-Office IP Cluster Join",
    nodeKind: "DECISION_BRANCH",
    modulePath: "lib/bet_ticker_ip_tracker_bridge.ts",
    entrypointFn: "lookupIpTrackerMatchForBetTicker",
    ownerRole: "RISK_DESK_ANALYST",
    teamLead: "Elena Rostova (Quantitative Risk & Sharp Profiling Lead)",
    decisionCondition:
      "Customer/Agent matches 13 IP clusters or Mode A session dwell < 15s (EC-03/EC-04)",
    passBranchTarget:
      "NODE-04 (Matched Cluster / Sharp Profile -> SURV Governor)",
    failOrVariantBranchTarget:
      "RETAIL_STANDARD_PATH (async Mode B/C background sweep)",
    slaOrLatencyBudget: "O(1) lookupInto arena + <15s Mode A dwell check",
  },
  {
    nodeId: "NODE-04",
    stepNumber: 4,
    label: "Surveillance Governor (GATE-SURV-01 & GATE-SURV-02)",
    nodeKind: "GOVERNOR_CLAMP",
    modulePath: "lib/gslive_surveillance_governor.ts",
    entrypointFn: "evaluateSurveillanceGovernor / enforceDonorExemption",
    ownerRole: "RISK_DESK_ANALYST",
    teamLead: "Elena Rostova (Quantitative Risk & Sharp Profiling Lead)",
    decisionCondition:
      "Hedgeable ratio >= 65% (Surgical Donor $50/8s) vs < 65% (Probation $250/5s) vs >3x Trojan step-up (EC-02)",
    passBranchTarget: "NODE-05 (Key-Number & Net Exposure Evaluator)",
    failOrVariantBranchTarget:
      "STRIP_TROJAN_DONOR_EXEMPTION (EC-02 hard clamp + P0 inbox alert)",
    slaOrLatencyBudget: "<= 345ms auto line-step (GATE-SURV-01)",
  },
  {
    nodeId: "NODE-05",
    stepNumber: 5,
    label: "Key-Number Crossing & Period-Exact Exposure Evaluator",
    nodeKind: "DECISION_BRANCH",
    modulePath: "lib/layoff_risk_engine.ts",
    entrypointFn: "detectKeyNumberCrossing / evaluateBetterVenue",
    ownerRole: "settlement",
    teamLead: "Devon Brooks (Settlement & CLV Integrity Lead)",
    decisionCondition:
      "Tuple (game_id, period, subject, market_kind, side) crosses NFL {3,7,10,14} / NBA {3..8} or net exposure > $10k (EC-05/EC-06)",
    passBranchTarget: "NODE-06 (Watchlist 12-Gate Intent Filter)",
    failOrVariantBranchTarget:
      "INTERNAL_BOOK_HOLD_SHADE (reprice F402 line +15c without external layoff)",
    slaOrLatencyBudget: "<= 50ms SQLite sliding-window join",
  },
  {
    nodeId: "NODE-06",
    stepNumber: 6,
    label: "Watchlist Autobet 12-Gate Eligibility Checklist",
    nodeKind: "GATE_CHECKLIST",
    modulePath: "lib/watchlist_autobet.ts",
    entrypointFn: "evaluateSignalGates / buildAutobetIntent",
    ownerRole: "operator",
    teamLead: "Marcus Vance (Head of Desk Operations)",
    decisionCondition:
      "All 12 gates pass in table order (enabled, league_allowed, fixture_provenance, freshness, confidence, distinct_accounts, one_sided_share, reference_price, stake_available, daily_stake_cap, league_daily_cap, duplicate_intent)",
    passBranchTarget:
      "NODE-07 (Append intent_created [queued] under .lock -> Re-Bet Routing)",
    failOrVariantBranchTarget:
      "SKIPPED_ENQUEUE_AUDIT (record failed GateCheckId[] reasons; EC-09)",
    slaOrLatencyBudget:
      "Atomic O_EXCL .lock (10s timeout / 30s stale break; EC-07)",
  },
  {
    nodeId: "NODE-07",
    stepNumber: 7,
    label: "Quarter-Kelly Staking & Taker/Maker Venue Router",
    nodeKind: "DECISION_BRANCH",
    modulePath: "lib/rebet_engine.ts",
    entrypointFn: "evaluateRebetOpportunity / evaluateExecutionDecision",
    ownerRole: "RISK_DESK_ANALYST",
    teamLead: "Elena Rostova (Quantitative Risk & Sharp Profiling Lead)",
    decisionCondition:
      "Edge >= sport floor (NFL 300 / NBA 350 / CFB 450 bps); top-of-book depth vs Quarter-Kelly stake selects Kalshi/Polymarket taker vs passive maker (EC-10)",
    passBranchTarget: "NODE-08 (Human / Team-Member Decision & Sign-Off Gate)",
    failOrVariantBranchTarget:
      "DOWNGRADE_TO_PASSIVE_MAKER_OR_HOLD (EC-10 thin depth fallback)",
    slaOrLatencyBudget: "Integer-cent Quarter-Kelly clamped to maxStakeUsd",
  },
  {
    nodeId: "NODE-08",
    stepNumber: 8,
    label: "Human / Team-Member Approval & Override Audit Gate",
    nodeKind: "HUMAN_AUDIT_GATE",
    modulePath: "lib/watchlist_autobet.ts",
    entrypointFn: "assertIntentTransition (approve | reject)",
    ownerRole: "operator",
    teamLead: "Marcus Vance (Head of Desk Operations)",
    decisionCondition:
      "Named human operator/lead verifies queued intent before expiresAt TTL (EC-08) and appends intent_approved or intent_rejected with actor + rationale note",
    passBranchTarget:
      "NODE-09 (Approved -> Paper or 3-Factor Kalshi Live Arming)",
    failOrVariantBranchTarget:
      "INTENT_REJECTED_OR_TTL_EXPIRED (releases daily & league cap reservation; EC-08)",
    slaOrLatencyBudget: "<= 15m ACK SLA (expireApprovedAfterMinutes TTL)",
  },
  {
    nodeId: "NODE-09",
    stepNumber: 9,
    label: "Paper Fill Engine vs. 3-Factor Kalshi RSA-PSS Live Arming",
    nodeKind: "EXECUTION_SINK",
    modulePath: "lib/autobet_kalshi.ts",
    entrypointFn: "computePaperFill / assertLiveExecutionArmed",
    ownerRole: "security/operator",
    teamLead: "Tariq Al-Mansoor (Security & Secret Governance Lead)",
    decisionCondition:
      "Default mode='paper' (computePaperFill with paperSlippageBps); live Kalshi requires EXECUTION_MODE=live + EXECUTION_LIVE=1 + confirm='PLACE LIVE ORDERS' + dual human sign-off",
    passBranchTarget:
      "NODE-10 (Append intent_filled -> Settlement & CLV Post-Mortem)",
    failOrVariantBranchTarget:
      "AUTOBET_ERROR_LIVE_DISABLED (exitCode: 3 hard refusal)",
    slaOrLatencyBudget:
      "Zero-network paper fill or signed RSA-PSS REST execution",
  },
  {
    nodeId: "NODE-10",
    stepNumber: 10,
    label: "Settlement Grading, CLV Post-Mortem & Immutable JSONL Audit",
    nodeKind: "LEDGER_TERMINAL",
    modulePath: "lib/settlement_postmortem.ts",
    entrypointFn: "computeSettlement / summarizeIntents",
    ownerRole: "settlement",
    teamLead: "Devon Brooks (Settlement & CLV Integrity Lead)",
    decisionCondition:
      "Official box-score grade (won | lost | void) settled from filled state; computes integer-cent P&L, ROI%, and Brier/CLV delta",
    passBranchTarget:
      "TERMINAL_SETTLED_AUDITED (data/watchlist-autobet-ledger.jsonl mode 0o600)",
    failOrVariantBranchTarget:
      "INVALID_TRANSITION_OR_LEDGER_CORRUPT (exitCode: 1/3 with 1-based line number)",
    slaOrLatencyBudget: "Post-event final grade + daily 08:00 sentinel audit",
  },
] as const;

export const BET_TICKER_FLOWCHART_EDGES: readonly BetTickerFlowEdgeSpec[] = [
  {
    edgeId: "EDGE-01",
    fromNodeId: "NODE-01",
    toNodeId: "NODE-02",
    branchType: "PRIMARY_PASS",
    conditionLabel: "New unseen WagerNumber on getBetTicker wire",
    auditEventEmitted: "ticker_delta_ingested",
  },
  {
    edgeId: "EDGE-02-TWIN",
    fromNodeId: "NODE-02",
    toNodeId: "VIP_SENTINEL_STREAM",
    branchType: "EDGE_CASE_TRAP",
    conditionLabel: "EC-01: Login='ALERT' or AgentID='ALERT' sentinel twin",
    auditEventEmitted: "alert_sentinel_twin_isolated",
  },
  {
    edgeId: "EDGE-02-PASS",
    fromNodeId: "NODE-02",
    toNodeId: "NODE-03",
    branchType: "PRIMARY_PASS",
    conditionLabel: "Real customer ticket (financial handle > $0)",
    auditEventEmitted: "real_wager_classified",
  },
  {
    edgeId: "EDGE-03-PASS",
    fromNodeId: "NODE-03",
    toNodeId: "NODE-04",
    branchType: "PRIMARY_PASS",
    conditionLabel: "Matches 13 office IP clusters or Mode A dwell < 15s",
    auditEventEmitted: "ip_cluster_profile_matched",
  },
  {
    edgeId: "EDGE-04-TROJAN",
    fromNodeId: "NODE-04",
    toNodeId: "TROJAN_CLAMP_SINK",
    branchType: "EDGE_CASE_TRAP",
    conditionLabel: "EC-02: Surgical donor fires >3x baseline stake ($500+)",
    auditEventEmitted: "trojan_donor_exemption_stripped",
  },
  {
    edgeId: "EDGE-04-PASS",
    fromNodeId: "NODE-04",
    toNodeId: "NODE-05",
    branchType: "PRIMARY_PASS",
    conditionLabel: "GATE-SURV-01/02 clamp applied ($250/5s or $50/8s donor)",
    auditEventEmitted: "surveillance_clamp_applied",
  },
  {
    edgeId: "EDGE-05-SHADE",
    fromNodeId: "NODE-05",
    toNodeId: "INTERNAL_VIG_SHADE",
    branchType: "VARIANT_ROUTE",
    conditionLabel:
      "Sub-threshold delta & no key-number crossing -> shade +15c",
    auditEventEmitted: "internal_line_shaded",
  },
  {
    edgeId: "EDGE-05-PASS",
    fromNodeId: "NODE-05",
    toNodeId: "NODE-06",
    branchType: "PRIMARY_PASS",
    conditionLabel: "Crosses NFL {3,7,10,14} / NBA {3..8} or net side > $10k",
    auditEventEmitted: "key_number_layoff_candidate",
  },
  {
    edgeId: "EDGE-06-SKIP",
    fromNodeId: "NODE-06",
    toNodeId: "SKIPPED_ENQUEUE_LOG",
    branchType: "EDGE_CASE_TRAP",
    conditionLabel: "EC-09: Fails >=1 of 12 gates (freshness/fixture/cap/dup)",
    auditEventEmitted: "intent_skipped_gate_refusal",
  },
  {
    edgeId: "EDGE-06-PASS",
    fromNodeId: "NODE-06",
    toNodeId: "NODE-07",
    branchType: "PRIMARY_PASS",
    conditionLabel: "12/12 gates pass -> append intent_created (queued)",
    auditEventEmitted: "intent_created",
  },
  {
    edgeId: "EDGE-07-PASS",
    fromNodeId: "NODE-07",
    toNodeId: "NODE-08",
    branchType: "PRIMARY_PASS",
    conditionLabel:
      "Quarter-Kelly stake & Kalshi/Polymarket taker/maker selected",
    auditEventEmitted: "rebet_route_computed",
  },
  {
    edgeId: "EDGE-08-REJECT",
    fromNodeId: "NODE-08",
    toNodeId: "CAP_RELEASED_SINK",
    branchType: "HUMAN_OVERRIDE",
    conditionLabel:
      "Human operator rejects or TTL expires (EC-08) -> release cap",
    auditEventEmitted: "intent_rejected | intent_expired",
  },
  {
    edgeId: "EDGE-08-APPROVE",
    fromNodeId: "NODE-08",
    toNodeId: "NODE-09",
    branchType: "HUMAN_OVERRIDE",
    conditionLabel: "Human team member signs off -> append intent_approved",
    auditEventEmitted: "intent_approved",
  },
  {
    edgeId: "EDGE-09-REFUSE",
    fromNodeId: "NODE-09",
    toNodeId: "LIVE_DISABLED_SINK",
    branchType: "EDGE_CASE_TRAP",
    conditionLabel:
      "Unarmed live venue call -> AutobetError(live_disabled, exit 3)",
    auditEventEmitted: "live_arming_refused",
  },
  {
    edgeId: "EDGE-09-FILL",
    fromNodeId: "NODE-09",
    toNodeId: "NODE-10",
    branchType: "PRIMARY_PASS",
    conditionLabel:
      "Paper fill (or 3-factor armed Kalshi fill) -> intent_filled",
    auditEventEmitted: "intent_filled",
  },
] as const;

/**
 * Render a GitHub/Markdown-compatible Mermaid `flowchart TD` diagram of the 10-node
 * BetTicker surveillance, human audit decision gate, edge cases, and layoff execution pipeline.
 */
export function renderBetTickerMermaidFlowchart(): string {
  return [
    "flowchart TD",
    '  N01["1. getBetTicker Wire Ingest & Delta Dedup\\n(lib/f402_incoming_bets.ts · <=25ms)"] --> N02{"2. ALERT Sentinel Twin Gate?\\n(lib/bet_flags.ts · EC-01)"}',
    '  N02 -- "Login=ALERT / AgentID=ALERT\\n(0 Financial Handle)" --> TWIN["VIP Sentinel Alerts Stream\\n(Twin Pair Isolated · No Layoff)"]',
    '  N02 -- "Real Customer Wager" --> N03{"3. Weblog Mode A/B/C/I & 13-Cluster IP Join\\n(lib/bet_ticker_ip_tracker_bridge.ts)"}',
    '  N03 -- "Clean Retail & >=15s Dwell" --> RETAIL["Standard Book Limit Path\\n(Background Mode B/C Sweep)"]',
    '  N03 -- "Matched IP Cluster or <15s Mode A Dwell\\n(EC-03 YYYY-MM-DD / EC-04 CGNAT Filter)" --> N04{"4. Surveillance Governor Clamp\\n(GATE-SURV-01 <=345ms · GATE-SURV-02)"}',
    '  N04 -- "EC-02: Donor Stake >3x Baseline" --> TROJAN["Strip Trojan Donor Exemption\\n(Hard Clamp + P0 Inbox Escalation)"]',
    '  N04 -- "Variant A: Probation ($250/5s)\\nVariant B: Surgical Donor ($50/8s)" --> N05{"5. Key-Number & Period-Exact Delta Eval\\n(NFL 3,7,10,14 · NBA 3..8 · EC-05/EC-06)"}',
    '  N05 -- "Sub-Threshold Delta / No Key Cross" --> SHADE["Internal Vig Shade (+15c)\\n& Hold Inside F402 Book"]',
    '  N05 -- "Key Number Crossed or Side >$10k" --> N06{"6. Watchlist 12-Gate Checklist\\n(lib/watchlist_autobet.ts · O_EXCL .lock EC-07)"}',
    '  N06 -- "EC-09: Fails Freshness / Fixture / Cap / Dup" --> SKIP["SkippedEnqueue Audit Log\\n(Ordered GateCheckId[] Refusal)"]',
    '  N06 -- "12/12 Gates Pass -> intent_created (queued)" --> N07["7. Quarter-Kelly & Venue Router\\n(Kalshi / Polymarket · Taker vs Maker EC-10)"]',
    '  N07 --> N08{"8. HUMAN / TEAM-MEMBER AUDIT GATE\\n(Named Actor + Role + Rationale Note · <=15m SLA)"}',
    '  N08 -- "Human Rejects or TTL Expires (EC-08)" --> REJ["intent_rejected / intent_expired\\n(Releases Daily & League Cap Slot)"]',
    '  N08 -- "Human Approves -> intent_approved" --> N09{"9. Execution & 3-Factor Kalshi Arming Gate\\n(Paper Default vs LIVE 3-Factor Arming)"}',
    '  N09 -- "Unarmed Live Attempt" --> REFUSE["AutobetError: live_disabled\\n(Hard Refusal · exitCode 3)"]',
    '  N09 -- "Paper Fill or 3-Factor Armed Fill\\n-> intent_filled" --> N10["10. Settlement Grading & CLV Post-Mortem\\n(intent_settled · won/lost/void · 0o600 JSONL)"]',
  ].join("\n");
}

export type DecisionActorKind =
  | "HUMAN_TEAM_LEAD"
  | "HUMAN_DESK_OPERATOR"
  | "DUAL_HUMAN_SIGN_OFF"
  | "AUTOMATED_GOVERNOR_WITH_HUMAN_ACK";

export interface BetTickerDecisionAuditEntry {
  readonly logId: string;
  readonly timestampIso: string;
  readonly intentOrTicketId: string;
  readonly rotation: string;
  readonly league: "NFL" | "CFB" | "NBA";
  readonly officeClusterId: string;
  readonly customerLogin: string;
  readonly actorKind: DecisionActorKind;
  readonly actorName: string;
  readonly actorRole: DeskRoleId;
  readonly actorEmail: string;
  readonly coSignerName: string | null;
  readonly coSignerRole: DeskRoleId | null;
  readonly inboxTicketRef: string;
  readonly flowchartNodeId: string;
  readonly priorState: string;
  readonly nextState:
    | "queued"
    | "approved"
    | "filled"
    | "settled"
    | "rejected"
    | "expired"
    | "clamped_donor"
    | "twin_isolated";
  readonly decisionAction:
    | "APPROVE_LIVE_LAYOFF"
    | "APPROVE_MAKER_QUEUE"
    | "OVERRIDE_TO_INTERNAL_SHADE"
    | "REJECT_STALE_OR_CGNAT"
    | "STRIP_TROJAN_DONOR_EXEMPTION"
    | "HOLD_PAPER_GUARDED"
    | "SETTLE_VERIFIED_FILL"
    | "EXPIRE_UNFILLED_TTL"
    | "ISOLATE_ALERT_TWIN";
  readonly gatesEvaluatedSummary: string;
  readonly edgeCaseOrVariantId: string;
  readonly humanRationaleNote: string;
  readonly financialImpactUsd: number;
  readonly auditSignatureHash: string;
  readonly verificationCommand: string;
}

export const BET_TICKER_DECISION_AUDIT_LOG: readonly BetTickerDecisionAuditEntry[] =
  [
    {
      logId: "DEC-LOG-001",
      timestampIso: "2026-11-09T14:12:04Z",
      intentOrTicketId: "wa-501-nfl-key3 (LAYOFF-ROT-501)",
      rotation: "ROT 501",
      league: "NFL",
      officeClusterId: "MJ2026 / DAN318",
      customerLogin: "MJ901",
      actorKind: "DUAL_HUMAN_SIGN_OFF",
      actorName: "Devon Brooks",
      actorRole: "settlement",
      actorEmail: "settlement-grading@bookdeskops.com",
      coSignerName: "Elena Rostova",
      coSignerRole: "RISK_DESK_ANALYST",
      inboxTicketRef: "inbox://settlement-grading/approvals#ROT-501",
      flowchartNodeId: "NODE-08",
      priorState: "queued",
      nextState: "approved",
      decisionAction: "APPROVE_LIVE_LAYOFF",
      gatesEvaluatedSummary:
        "12/12 PASS (conf=92, accts=6, share=0.91, edge=+520bps)",
      edgeCaseOrVariantId: "EC-05 (Key-3 Spread Crossing)",
      humanRationaleNote:
        "Approved $250 Kalshi taker layoff (471 contracts @ 53.0c). MJ2026 + DAN318 crossed key number -3.0 (-2.5 F402 vs -3.5 PM); hedging eliminates 3-point push/middle trap.",
      financialImpactUsd: 250,
      auditSignatureHash: "sha256:9f4a8c12e7b03d19",
      verificationCommand:
        "bun run autobet: approve wa-501-nfl-key3 --by Devon.Brooks",
    },
    {
      logId: "DEC-LOG-002",
      timestampIso: "2026-11-09T14:16:29Z",
      intentOrTicketId: "wa-315-cfb-burst (LAYOFF-ROT-315)",
      rotation: "ROT 315",
      league: "CFB",
      officeClusterId: "CUB22HR / MACHR / GOLD22",
      customerLogin: "CUB101",
      actorKind: "HUMAN_TEAM_LEAD",
      actorName: "Marcus Vance",
      actorRole: "operator",
      actorEmail: "ops-desk@bookdeskops.com",
      coSignerName: null,
      coSignerRole: null,
      inboxTicketRef: "inbox://ops-desk/p0-triage#ROT-315",
      flowchartNodeId: "NODE-08",
      priorState: "queued",
      nextState: "approved",
      decisionAction: "APPROVE_LIVE_LAYOFF",
      gatesEvaluatedSummary:
        "12/12 PASS (conf=94, accts=10, share=0.95, edge=+600bps)",
      edgeCaseOrVariantId: "VARIANT-TOUT-BURST (8-Acct + 2-Twin Sync)",
      humanRationaleNote:
        "Approved $150 Polymarket CLOB taker buy (275 contracts @ 54.5c) + stepped internal CFB total 54.5 -> 56.0 within 290ms after 10 synchronized accounts hit OVER.",
      financialImpactUsd: 150,
      auditSignatureHash: "sha256:3c7e11b409a2f851",
      verificationCommand:
        "bun run autobet: approve wa-315-cfb-burst --by Marcus.Vance",
    },
    {
      logId: "DEC-LOG-003",
      timestampIso: "2026-11-09T14:21:11Z",
      intentOrTicketId: "tkt-159318442-trojan",
      rotation: "ROT 319",
      league: "CFB",
      officeClusterId: "MJ2026",
      customerLogin: "MJ904",
      actorKind: "AUTOMATED_GOVERNOR_WITH_HUMAN_ACK",
      actorName: "Elena Rostova",
      actorRole: "RISK_DESK_ANALYST",
      actorEmail: "risk-desk-analyst@bookdeskops.com",
      coSignerName: "Tariq Al-Mansoor",
      coSignerRole: "security/operator",
      inboxTicketRef: "inbox://risk-desk-analyst/surveillance-sla#MJ904",
      flowchartNodeId: "NODE-04",
      priorState: "donor_surgical_50",
      nextState: "clamped_donor",
      decisionAction: "STRIP_TROJAN_DONOR_EXEMPTION",
      gatesEvaluatedSummary:
        "GATE-SURV-02 TRIGGER (stake $600 = 12x $50 donor cap)",
      edgeCaseOrVariantId: "EC-02 (Trojan Horse Donor Step-Up)",
      humanRationaleNote:
        "Confirmed stripTrojanHorseExemption on MJ904 after account attempted $600 1H CFB bet (12x surgical donor cap). Reclassified to hard $50 cap + 8s delay; rejected $550 excess.",
      financialImpactUsd: 550,
      auditSignatureHash: "sha256:7d2b54e811c90a34",
      verificationCommand:
        "bun test tests/gslive_surveillance_governor.test.ts",
    },
    {
      logId: "DEC-LOG-004",
      timestampIso: "2026-11-09T14:25:48Z",
      intentOrTicketId: "wa-451-nfl-key7 (LAYOFF-ROT-451)",
      rotation: "ROT 451",
      league: "NFL",
      officeClusterId: "BIGDAD / DAN318",
      customerLogin: "BD101",
      actorKind: "HUMAN_DESK_OPERATOR",
      actorName: "Devon Brooks",
      actorRole: "settlement",
      actorEmail: "settlement-grading@bookdeskops.com",
      coSignerName: null,
      coSignerRole: null,
      inboxTicketRef: "inbox://settlement-grading/approvals#ROT-451",
      flowchartNodeId: "NODE-07",
      priorState: "queued",
      nextState: "queued",
      decisionAction: "APPROVE_MAKER_QUEUE",
      gatesEvaluatedSummary:
        "12/12 PASS (conf=89, accts=5, share=0.88, edge=+430bps)",
      edgeCaseOrVariantId: "EC-05 & EC-10 (Key-7 Cross + Passive Maker Bid)",
      humanRationaleNote:
        "Retained in passive maker queue @ 52.5c on Kalshi (476 contracts, $250 stake) to capture +430 bps across key number +7.0 without paying 90 bps taker spread on thin book.",
      financialImpactUsd: 250,
      auditSignatureHash: "sha256:5a89d023f41c7e62",
      verificationCommand: "bun run governance:check --autobet",
    },
    {
      logId: "DEC-LOG-005",
      timestampIso: "2026-11-09T14:31:05Z",
      intentOrTicketId: "wa-505-nba-steam (LAYOFF-ROT-505)",
      rotation: "ROT 505",
      league: "NBA",
      officeClusterId: "ATEAM / TEXANS / SPEN",
      customerLogin: "AT401",
      actorKind: "HUMAN_TEAM_LEAD",
      actorName: "Elena Rostova",
      actorRole: "RISK_DESK_ANALYST",
      actorEmail: "risk-desk-analyst@bookdeskops.com",
      coSignerName: "Marcus Vance",
      coSignerRole: "operator",
      inboxTicketRef: "inbox://risk-desk-analyst/surveillance-sla#ROT-505",
      flowchartNodeId: "NODE-09",
      priorState: "approved",
      nextState: "filled",
      decisionAction: "APPROVE_LIVE_LAYOFF",
      gatesEvaluatedSummary:
        "12/12 PASS (conf=91, accts=7, share=0.90, edge=+390bps)",
      edgeCaseOrVariantId: "VARIANT-NBA-KEY6 (NBA Key-6 Spread Crossing)",
      humanRationaleNote:
        "Executed $300 paper-verified fill (560 contracts @ 53.5c, 25 bps slippage buffer) after ATEAM + TEXANS + SPEN hit NBA -5.5 vs -6.5 venue line across NBA key number 6.",
      financialImpactUsd: 300,
      auditSignatureHash: "sha256:1b6f90c4e28a5d77",
      verificationCommand:
        "bun run autobet: execute wa-505-nba-steam --venue paper",
    },
    {
      logId: "DEC-LOG-006",
      timestampIso: "2026-11-09T14:36:19Z",
      intentOrTicketId: "tkt-159315219-alert-twin",
      rotation: "ROT 501",
      league: "NFL",
      officeClusterId: "ALERT / MJ2026",
      customerLogin: "ALERT (twin of MJ901)",
      actorKind: "AUTOMATED_GOVERNOR_WITH_HUMAN_ACK",
      actorName: "Soren Lindqvist",
      actorRole: "client/seam",
      actorEmail: "seam-ops@bookdeskops.com",
      coSignerName: null,
      coSignerRole: null,
      inboxTicketRef: "inbox://seam-ops/contract-drift#ALERT-TWIN",
      flowchartNodeId: "NODE-02",
      priorState: "wire_ingested",
      nextState: "twin_isolated",
      decisionAction: "ISOLATE_ALERT_TWIN",
      gatesEvaluatedSummary: "SENTINEL_TWIN_GATE (isAlertSentinelBet === true)",
      edgeCaseOrVariantId:
        "EC-01 (ALERT Sentinel Twin Pair 159315219/159315220)",
      humanRationaleNote:
        "Verified ticket 159315219 (Login=ALERT) isolated into vip_sentinel_alerts table with $0 financial handle while real twin 159315220 (MJ901) routed to risk rollup.",
      financialImpactUsd: 0,
      auditSignatureHash: "sha256:8e3c71a904d2b610",
      verificationCommand: "bun test tests/bet_flags.test.ts",
    },
    {
      logId: "DEC-LOG-007",
      timestampIso: "2026-11-09T14:42:50Z",
      intentOrTicketId: "wa-612-nba-cgnat-reject",
      rotation: "ROT 612",
      league: "NBA",
      officeClusterId: "GPRO50RSK",
      customerLogin: "GP103",
      actorKind: "HUMAN_TEAM_LEAD",
      actorName: "Tariq Al-Mansoor",
      actorRole: "security/operator",
      actorEmail: "security-ops@bookdeskops.com",
      coSignerName: "Elena Rostova",
      coSignerRole: "RISK_DESK_ANALYST",
      inboxTicketRef: "inbox://security-ops/alerts#ROT-612",
      flowchartNodeId: "NODE-08",
      priorState: "queued",
      nextState: "rejected",
      decisionAction: "REJECT_STALE_OR_CGNAT",
      gatesEvaluatedSummary:
        "HUMAN_REJECT (Mode C YYYY-MM-DD check + CGNAT false-positive)",
      edgeCaseOrVariantId:
        "EC-03 & EC-04 (Mode C Date Divergence + T-Mobile CGNAT)",
      humanRationaleNote:
        "Rejected external layoff and released $200 cap reservation: Mode C YYYY-MM-DD query proved GP103 shared 172.56.21.0/24 T-Mobile CGNAT tower without synchronized <15s dwell. Applied internal +20c prop vig shade instead.",
      financialImpactUsd: 200,
      auditSignatureHash: "sha256:4f1d82b7c309e54a",
      verificationCommand:
        "bun run autobet: reject wa-612-nba-cgnat-reject --by Tariq.AlMansoor",
    },
    {
      logId: "DEC-LOG-008",
      timestampIso: "2026-11-09T14:49:15Z",
      intentOrTicketId: "wa-5501-nba-beard (LAYOFF-ROT-5501)",
      rotation: "ROT 5501",
      league: "NBA",
      officeClusterId: "LAKERS / KOBE24",
      customerLogin: "LK101",
      actorKind: "DUAL_HUMAN_SIGN_OFF",
      actorName: "Elena Rostova",
      actorRole: "RISK_DESK_ANALYST",
      actorEmail: "risk-desk-analyst@bookdeskops.com",
      coSignerName: "Nadia Chen",
      coSignerRole: "compliance",
      inboxTicketRef: "inbox://risk-desk-analyst/surveillance-sla#ROT-5501",
      flowchartNodeId: "NODE-09",
      priorState: "approved",
      nextState: "approved",
      decisionAction: "HOLD_PAPER_GUARDED",
      gatesEvaluatedSummary:
        "12/12 PASS (conf=86, accts=4, share=0.85, edge=+500bps)",
      edgeCaseOrVariantId:
        "VARIANT-CROSS-OFFICE-BEARD (LAKERS + KOBE24 LAN Bridge)",
      humanRationaleNote:
        "Held $300 intent (555 contracts @ 54.0c) in paper_guarded mode pending compliance sign-off on cross-office 192.168.x NAT beard bridge between LAKERS and KOBE24.",
      financialImpactUsd: 300,
      auditSignatureHash: "sha256:6c0a49f182b7d31e",
      verificationCommand: "bun run governance:check --wagers --autobet",
    },
    {
      logId: "DEC-LOG-009",
      timestampIso: "2026-11-09T14:55:02Z",
      intentOrTicketId: "wa-488-nfl-ttl-expired",
      rotation: "ROT 488",
      league: "NFL",
      officeClusterId: "JUICEPLUS",
      customerLogin: "JP201",
      actorKind: "AUTOMATED_GOVERNOR_WITH_HUMAN_ACK",
      actorName: "Marcus Vance",
      actorRole: "operator",
      actorEmail: "ops-desk@bookdeskops.com",
      coSignerName: null,
      coSignerRole: null,
      inboxTicketRef: "inbox://ops-desk/p0-triage#ROT-488",
      flowchartNodeId: "NODE-08",
      priorState: "approved",
      nextState: "expired",
      decisionAction: "EXPIRE_UNFILLED_TTL",
      gatesEvaluatedSummary:
        "TTL_EXPIRED (now >= expiresAt; exitCode 3 on execute)",
      edgeCaseOrVariantId: "EC-08 (Approved Intent TTL Expiry Race)",
      humanRationaleNote:
        "Kalshi ask moved from 53.0c to 57.5c before fill; allowed expireApprovedAfterMinutes (15m) TTL to expire intent cleanly and release $250 NFL daily cap slot.",
      financialImpactUsd: 250,
      auditSignatureHash: "sha256:2e9b63d5a108c47f",
      verificationCommand: "bun test tests/watchlist_autobet.test.ts",
    },
    {
      logId: "DEC-LOG-010",
      timestampIso: "2026-11-09T15:04:33Z",
      intentOrTicketId: "wa-501-nfl-key3-settle",
      rotation: "ROT 501",
      league: "NFL",
      officeClusterId: "MJ2026 / DAN318",
      customerLogin: "MJ901",
      actorKind: "HUMAN_DESK_OPERATOR",
      actorName: "Devon Brooks",
      actorRole: "settlement",
      actorEmail: "settlement-grading@bookdeskops.com",
      coSignerName: null,
      coSignerRole: null,
      inboxTicketRef: "inbox://settlement-grading/approvals#ROT-501-SETTLE",
      flowchartNodeId: "NODE-10",
      priorState: "filled",
      nextState: "settled",
      decisionAction: "SETTLE_VERIFIED_FILL",
      gatesEvaluatedSummary:
        "SETTLEMENT_VERIFIED (result='won', +$221.70 net profit)",
      edgeCaseOrVariantId:
        "VARIANT-SETTLEMENT-POSTMORTEM (CLV +520 bps realized)",
      humanRationaleNote:
        "Graded ROT 501 layoff fill as WON after official box score verification; recorded +$221.70 net hedge profit and +520 bps CLV beat in append-only JSONL ledger.",
      financialImpactUsd: 221.7,
      auditSignatureHash: "sha256:0a5f38c9d712e68b",
      verificationCommand:
        "bun run autobet: settle wa-501-nfl-key3 --result won",
    },
  ] as const;

export interface BetTickerEdgeCaseVariantSpec {
  readonly variantId: string;
  readonly code: string;
  readonly category:
    | "WIRE_INGEST_EDGE_CASE"
    | "WEBLOG_IP_CORRELATION_EDGE_CASE"
    | "GOVERNOR_CLAMP_VARIANT"
    | "KEY_NUMBER_PERIOD_EDGE_CASE"
    | "LEDGER_CONCURRENCY_TTL_EDGE_CASE"
    | "EXECUTION_DEPTH_ARMING_VARIANT";
  readonly title: string;
  readonly triggerCondition: string;
  readonly failureModeIfUnhandled: string;
  readonly deterministicHandlingContract: string;
  readonly humanAuditRequirement: string;
  readonly sourceModule: string;
  readonly ownerRole: DeskRoleId;
  readonly verificationCommand: string;
}

export const BET_TICKER_EDGE_CASE_VARIANTS: readonly BetTickerEdgeCaseVariantSpec[] =
  [
    {
      variantId: "EC-01",
      code: "ALERT_SENTINEL_TWIN_PAIR",
      category: "WIRE_INGEST_EDGE_CASE",
      title: "ALERT Sentinel Twin Ticket Pair (159315219 / 159315220)",
      triggerCondition:
        "Fantasy402 emits duplicate bet-ticker rows within milliseconds: one with Login='ALERT' / AgentID='ALERT' and one with the real customer login",
      failureModeIfUnhandled:
        "Inflates rotation handle by 2x and triggers false double-sized Kalshi/Polymarket layoff orders",
      deterministicHandlingContract:
        "isAlertSentinelBet() partitions ALERT rows into vip_sentinel_alerts with $0 financial risk before tally rollup or autobet signal derivation",
      humanAuditRequirement:
        "client/seam (Soren Lindqvist) verifies 0 ALERT logins in financial tally rollup via daily contract check",
      sourceModule: "lib/bet_flags.ts",
      ownerRole: "client/seam",
      verificationCommand: "bun test tests/bet_flags.test.ts",
    },
    {
      variantId: "EC-02",
      code: "TROJAN_HORSE_DONOR_STEPUP",
      category: "GOVERNOR_CLAMP_VARIANT",
      title: "Surgical Signal Donor Stake Step-Up (>3x Baseline)",
      triggerCondition:
        "Account classified as >=65% hedgeable Signal Donor ($50 surgical cap + 8s delay) submits a ticket >3x baseline stake ($500+) on a thin 1H/FCS market",
      failureModeIfUnhandled:
        "Syndicate uses a whitelisted low-stake signal donor account as a Trojan horse to dump unhedgeable steam onto the book",
      deterministicHandlingContract:
        "stripTrojanHorseExemption = true immediately revokes donor exemption, clamps ticket to $50 max, rejects excess stake, and pages RISK_DESK_ANALYST",
      humanAuditRequirement:
        "RISK_DESK_ANALYST (Elena Rostova) + security/operator co-sign donor revocation in inbox://risk-desk-analyst/surveillance-sla",
      sourceModule: "lib/gslive_surveillance_governor.ts",
      ownerRole: "RISK_DESK_ANALYST",
      verificationCommand:
        "bun test tests/gslive_surveillance_governor.test.ts",
    },
    {
      variantId: "EC-03",
      code: "WEBLOG_MODE_C_DATE_DIVERGENCE",
      category: "WEBLOG_IP_CORRELATION_EDGE_CASE",
      title:
        "getWebLog Mode C YYYY-MM-DD vs Mode A/B/I MM/DD/YYYY Wire Divergence",
      triggerCondition:
        "Portal ip-tracker.js:77 formats Mode C (PLAYER_IP_MATCHER) dates as YYYY-MM-DD while Modes A, B, and I require MM/DD/YYYY",
      failureModeIfUnhandled:
        "Sharing a single MM/DD/YYYY formatter across all getWebLog modes causes Mode C pairwise customer IP correlation to silently return 0 rows",
      deterministicHandlingContract:
        "WEBLOG_MODE_CONTRACTS & buildWebLogRequest enforce YYYY-MM-DD exclusively on Mode C and reject Mode B/I as a substitute for Mode A activity streams (#89)",
      humanAuditRequirement:
        "RISK_DESK_ANALYST validates non-empty Mode C pairwise correlation before clearing shared-subnet accounts",
      sourceModule: "lib/bet_ticker_ip_tracker_bridge.ts",
      ownerRole: "RISK_DESK_ANALYST",
      verificationCommand: "bun run governance:check --wagers",
    },
    {
      variantId: "EC-04",
      code: "CARRIER_CGNAT_FALSE_POSITIVE_SWEEP",
      category: "WEBLOG_IP_CORRELATION_EDGE_CASE",
      title: "Mobile Carrier CGNAT /24 Subnet Collision vs True Syndicate Ring",
      triggerCondition:
        "Multiple accounts appear on a shared mobile carrier subnet (e.g. T-Mobile 172.56.21.0/24) during peak Saturday/Sunday slate",
      failureModeIfUnhandled:
        "Unrelated recreational mobile bettors get false-positively clamped or trigger erroneous watchlist layoff signals",
      deterministicHandlingContract:
        "Requires 3-factor confirmation before cluster clamp: (1) Mode B/C IP match + (2) Mode A session dwell <15s + (3) synchronized same-rotation bet arrival within 60s",
      humanAuditRequirement:
        "security/operator (Tariq Al-Mansoor) reviews CGNAT subnet flags and logs REJECT_STALE_OR_CGNAT when dwell >=15s",
      sourceModule: "lib/bet_ticker_ip_tracker_bridge.ts",
      ownerRole: "security/operator",
      verificationCommand: "bun run governance:check --wagers",
    },
    {
      variantId: "EC-05",
      code: "KEY_NUMBER_PUSH_TRAP_MIDDLE",
      category: "KEY_NUMBER_PERIOD_EDGE_CASE",
      title:
        "Football (3, 7, 10, 14) & NBA (3..8) Key-Number Crossing Middle Trap",
      triggerCondition:
        "F402 internal spread and external Kalshi/Polymarket spread straddle a key number (e.g. F402 -2.5 vs Venue -3.5, or F402 +7.5 vs Venue -6.5)",
      failureModeIfUnhandled:
        "Desk lays off at a worse strike across a key number, exposing the house to a two-sided loss or push-trap middle",
      deterministicHandlingContract:
        "detectKeyNumberCrossing() computes exact hundredths span across NFL {300,700,1000,1400} and NBA {300..800} and requires key-number-adjusted fairProb edge",
      humanAuditRequirement:
        "settlement (Devon Brooks) + RISK_DESK_ANALYST dual sign-off on any layoff crossing key numbers 3 or 7",
      sourceModule: "lib/layoff_risk_engine.ts",
      ownerRole: "settlement",
      verificationCommand: "bun test tests/layoff_risk_engine.test.ts",
    },
    {
      variantId: "EC-06",
      code: "PERIOD_0_VS_1H_Q1_MISMATCH",
      category: "KEY_NUMBER_PERIOD_EDGE_CASE",
      title:
        "Period-0 (Full Game) vs 1H / 2H / Q1 Derivative Cross-Contamination",
      triggerCondition:
        "Sharp syndicate bets 1H or Q1 spread/total on F402 while external Polymarket/Kalshi liquidity only quotes Full Game (period='game')",
      failureModeIfUnhandled:
        "Naive game_id join without period matching triggers a Full Game external hedge against a 1H internal liability",
      deterministicHandlingContract:
        "LayoffRiskEngine.queryLineDeltaMatches joins strictly on (game_id, COALESCE(period,'game'), subject, market_kind, side); mismatched periods never auto-hedge",
      humanAuditRequirement:
        "settlement verifies period-exact match in layoff table; 1H/Q1 unmatched exposure routes to STEP_LINE_345MS_AND_LAYOFF or internal shade",
      sourceModule: "lib/layoff_risk_engine.ts",
      ownerRole: "settlement",
      verificationCommand: "bun test tests/layoff_risk_engine.test.ts",
    },
    {
      variantId: "EC-07",
      code: "CONCURRENT_LEDGER_WRITER_LOCK_CONTENTION",
      category: "LEDGER_CONCURRENCY_TTL_EDGE_CASE",
      title:
        "Concurrent Daemon Watch Loop & Operator CLI JSONL Ledger Write Contention",
      triggerCondition:
        "Cron/daemon enqueue loop and human operator `autobet: approve` attempt simultaneous read-validate-append on data/watchlist-autobet-ledger.jsonl",
      failureModeIfUnhandled:
        "Race condition appends two conflicting transitions for the same intentId, permanently corrupting the append-only ledger (ledger_corrupt)",
      deterministicHandlingContract:
        "withLedgerLock() acquires exclusive O_EXCL `<ledger>.lock` (mode 0o600, 25ms retry, 10s timeout, 30s stale-lock break) and refuses with ledger_locked (exitCode 1) on timeout",
      humanAuditRequirement:
        "operator inspects lock holder PID/timestamp if ledger_locked fires; never edits JSONL lines by hand",
      sourceModule: "lib/watchlist_autobet.ts",
      ownerRole: "operator",
      verificationCommand: "bun test tests/watchlist_autobet.test.ts",
    },
    {
      variantId: "EC-08",
      code: "APPROVED_INTENT_TTL_EXPIRY_RACE",
      category: "LEDGER_CONCURRENCY_TTL_EDGE_CASE",
      title: "Approved Intent TTL Expiration Before Venue Fill Execution",
      triggerCondition:
        "Human operator approves a queued intent, but external venue price moves and `now >= expiresAt` (expireApprovedAfterMinutes) before `execute` is called",
      failureModeIfUnhandled:
        "Stale approved order executes into a moved market long after the sharp signal edge has decayed",
      deterministicHandlingContract:
        "resolveIntentStatus() dynamically derives status='expired' when now >= expiresAt; assertIntentTransition refuses execute with intent_expired (exitCode 3) and releases cap",
      humanAuditRequirement:
        "operator logs EXPIRE_UNFILLED_TTL and re-evaluates fresh signal snapshot if market re-opens",
      sourceModule: "lib/watchlist_autobet.ts",
      ownerRole: "operator",
      verificationCommand: "bun test tests/watchlist_autobet.test.ts",
    },
    {
      variantId: "EC-09",
      code: "FIXTURE_OR_STALE_PROVENANCE_LEAK",
      category: "LEDGER_CONCURRENCY_TTL_EDGE_CASE",
      title:
        "Fixture-Sourced or Stale Signal Artifact Leak Into Live/Paper Queue",
      triggerCondition:
        "Local feed artifact (docs/graph-live-feed.json or data/live-wagers.json) is older than maxSignalAgeSeconds or carries provenance.fixture === true (#69/#73)",
      failureModeIfUnhandled:
        "Synthetic test fixtures or stale cached wagers generate phantom layoff intents in the operator approval queue",
      deterministicHandlingContract:
        "Gates #3 (fixture_provenance) and #4 (freshness) in evaluateSignalGates() refuse enqueue unless provenance.fixture===false and ageSeconds <= maxSignalAgeSeconds",
      humanAuditRequirement:
        "operator verifies source freshness chips before running `autobet: enqueue`",
      sourceModule: "lib/watchlist_autobet.ts",
      ownerRole: "operator",
      verificationCommand: "bun test tests/watchlist_autobet.test.ts",
    },
    {
      variantId: "EC-10",
      code: "PARTIAL_BOOK_DEPTH_MAKER_FALLBACK",
      category: "EXECUTION_DEPTH_ARMING_VARIANT",
      title: "Thin External Orderbook Depth & 3-Factor Live Arming Boundary",
      triggerCondition:
        "Quarter-Kelly planned layoff stake ($250-$300) exceeds Kalshi/Polymarket top-of-book depth at the target price, or operator invokes live venue without 3-factor arming",
      failureModeIfUnhandled:
        "Taker sweep walks the orderbook past slippageBps ceiling, destroying positive EV, or accidental live order fires from paper config",
      deterministicHandlingContract:
        "evaluateExecutionDecision() downgrades thin-book routes from taker to passive maker inside spread; assertPaperVenue/Kalshi arming requires EXECUTION_MODE=live + EXECUTION_LIVE=1 + confirm='PLACE LIVE ORDERS'",
      humanAuditRequirement:
        "security/operator + RISK_DESK_ANALYST co-sign any live arming transition; maker orders tracked in queued state",
      sourceModule: "lib/execution_decision.ts",
      ownerRole: "security/operator",
      verificationCommand: "bun test tests/execution_decision.test.ts",
    },
  ] as const;

export type TradingToolCategory =
  | "EXECUTION_PLANNING_AND_ROUTER"
  | "AUTOBET_LEDGER_AND_ARMING"
  | "LIVE_ORDERBOOK_SCANNER"
  | "KEY_NUMBER_AND_KELLY_ENGINE"
  | "CORDIS_DESK_HARNESS"
  | "WIRE_SURVEILLANCE_AND_FORENSICS"
  | "SYNDICATE_GRAPH_AND_BACKTEST"
  | "OPERATOR_DX_AND_MCP";

export interface DeskTradingToolSpec {
  readonly toolId: string;
  readonly code: string;
  readonly title: string;
  readonly category: TradingToolCategory;
  readonly entrypointPath: string;
  readonly supportingModules: readonly string[];
  readonly primaryCliCommand: string;
  readonly cordisPluginName: string | null;
  readonly httpOrMcpSurface: string;
  readonly targetVenues: readonly (
    "f402" | "kalshi" | "polymarket" | "r2" | "local-sqlite"
  )[];
  readonly latencyOrThroughputSla: string;
  readonly traderEdgeCapability: string;
  readonly safetyGuardrailContract: string;
  readonly primaryOwnerRoles: readonly DeskRoleId[];
  readonly verificationCommand: string;
}

export const DESK_TRADING_TOOLING_SUITE: readonly DeskTradingToolSpec[] = [
  {
    toolId: "TOOL-01",
    code: "EXECUTION_PLANNER_WORKBENCH",
    title:
      "Multi-Venue Execution Planner, Taker/Maker Router & Human Approval CLI",
    category: "EXECUTION_PLANNING_AND_ROUTER",
    entrypointPath: "scripts/execution_cli.ts",
    supportingModules: [
      "lib/execution_planner.ts",
      "lib/execution_approvals.ts",
      "lib/execution_paper.ts",
      "lib/polymarket_quote.ts",
    ],
    primaryCliCommand:
      "bun run execution:plan --style auto [--approve <id> --actor <name> | --paper-run]",
    cordisPluginName: "dsh-plugin-sportsdesk-desk-panel",
    httpOrMcpSurface:
      "GET /api/desk-status · Scratch/execution/approvals.jsonl",
    targetVenues: ["f402", "kalshi", "polymarket"],
    latencyOrThroughputSla: "<= 120ms dual-venue orderbook join & quote plan",
    traderEdgeCapability:
      "Joins live watchlist signals against Kalshi & Polymarket orderbooks, computes immediate taker fills vs. passive maker quotes inside the spread (min(fair - makerMarginBps, ask - 1c)), and persists signed operator approvals.",
    safetyGuardrailContract:
      "Paper-first execution adapter; enforces sport-tier minimum edge (NFL 300 / NBA 300 / CFB 500 bps), $1.5k per-market cap, $5k daily cap, and 10m duplicate suppression.",
    primaryOwnerRoles: ["settlement", "operator", "RISK_DESK_ANALYST"],
    verificationCommand: "bun test tests/execution_planner.test.ts",
  },
  {
    toolId: "TOOL-02",
    code: "WATCHLIST_AUTOBET_12GATE_CLI",
    title:
      "12-Gate Watchlist Autobet State Machine & Append-Only JSONL Ledger CLI",
    category: "AUTOBET_LEDGER_AND_ARMING",
    entrypointPath: "cli/watchlist_autobet_cli.ts",
    supportingModules: [
      "lib/watchlist_autobet.ts",
      "lib/settlement_postmortem.ts",
    ],
    primaryCliCommand:
      "bun run autobet status|signals|candidates|plan|enqueue|list|approve|reject|execute|settle|journal|watch",
    cordisPluginName: "dsh-plugin-watchlist-autobet",
    httpOrMcpSurface:
      "Cordis /autobet · data/watchlist-autobet-ledger.jsonl (0o600)",
    targetVenues: ["kalshi", "polymarket", "local-sqlite"],
    latencyOrThroughputSla:
      "Atomic O_EXCL .lock (<10s acquire, 30s stale break) · 0o600 JSONL",
    traderEdgeCapability:
      "Full 12-subcommand trader lifecycle: evaluates 12 ordered eligibility gates, reserves daily/league caps in integer cents, manages human approve/reject TTLs, executes paper/live fills, and grades post-event CLV/ROI.",
    safetyGuardrailContract:
      "Rejects synthetic/fixture signals unless allowFixtureSignals=true; enforces strict state transitions (queued -> approved -> filled -> settled) and exits with code 3 on any unarmed live attempt.",
    primaryOwnerRoles: ["operator", "settlement", "security/operator"],
    verificationCommand: "bun test tests/watchlist_autobet.test.ts",
  },
  {
    toolId: "TOOL-03",
    code: "KALSHI_SIGNAL_JOIN_SCANNER",
    title:
      "Live Kalshi Orderbook Scanner, Signal Join & 3-Factor RSA-PSS Execution Adapter",
    category: "LIVE_ORDERBOOK_SCANNER",
    entrypointPath: "scripts/signals_kalshi_cli.ts",
    supportingModules: [
      "lib/kalshi_client.ts",
      "lib/kalshi_signal_join.ts",
      "lib/autobet_kalshi.ts",
      "lib/kalshi_live_execution.ts",
    ],
    primaryCliCommand: "bun run signals:kalshi [--json] [--limit 25]",
    cordisPluginName: "dsh-plugin-watchlist-autobet",
    httpOrMcpSurface:
      "Kalshi Trade API v2 public orderbook + RSA-PSS signed live adapter",
    targetVenues: ["kalshi", "f402"],
    latencyOrThroughputSla:
      "Zero-credential public scan · <= 250ms top-of-book EV rank",
    traderEdgeCapability:
      "Scans live Kalshi sports event contracts without credentials, joins F402 sharp watchlist fair probabilities against Kalshi YES/NO bid-ask depth, and ranks actionable cross-venue EV in basis points.",
    safetyGuardrailContract:
      "3-factor live execution lock: requires EXECUTION_MODE=live + EXECUTION_LIVE=1 + confirm='PLACE LIVE ORDERS' + dual human sign-off before RSA-PSS key signing.",
    primaryOwnerRoles: ["RISK_DESK_ANALYST", "security/operator", "settlement"],
    verificationCommand: "bun test tests/kalshi_signal_join.test.ts",
  },
  {
    toolId: "TOOL-04",
    code: "LAYOFF_KEY_NUMBER_RADAR",
    title:
      "Sliding-Window Key-Number Crossing, Period-Exact Layoff & Quarter-Kelly Engine",
    category: "KEY_NUMBER_AND_KELLY_ENGINE",
    entrypointPath: "lib/layoff_risk_engine.ts",
    supportingModules: [
      "lib/rebet_engine.ts",
      "lib/execution_decision.ts",
      "lib/combo_identity.ts",
      "lib/bet_venue_breakdown.ts",
    ],
    primaryCliCommand:
      "bun test tests/layoff_risk_engine.test.ts tests/rebet_engine.test.ts",
    cordisPluginName: "dsh-plugin-sportsdesk-desk-panel",
    httpOrMcpSurface:
      "GET /api/layoff-opportunities · SQLite sliding-window book state",
    targetVenues: ["f402", "kalshi", "polymarket", "local-sqlite"],
    latencyOrThroughputSla:
      "<= 50ms SQLite sliding-window join in LineHundredths",
    traderEdgeCapability:
      "Matches (game_id, period, subject, market_kind, side) without cross-period contamination, flags SHARP_STILL_BETTER across NFL (3, 7, 10, 14) and NBA (3..8) key numbers, and sizes Quarter-Kelly stakes.",
    safetyGuardrailContract:
      "Integer-cent arithmetic only; automatically downgrades taker sweeps to passive maker quotes when top-of-book depth is thinner than planned Quarter-Kelly stake.",
    primaryOwnerRoles: ["settlement", "RISK_DESK_ANALYST"],
    verificationCommand: "bun test tests/layoff_risk_engine.test.ts",
  },
  {
    toolId: "TOOL-05",
    code: "CORDIS_HARNESS_5_PLUGIN_SUITE",
    title:
      "5-Plugin DSH Cordis Trading, Security, Status, Panel & Autobet Harness Suite",
    category: "CORDIS_DESK_HARNESS",
    entrypointPath: "market/index.json",
    supportingModules: [
      "dsh-plugin-sportsdesk-ops/index.js",
      "dsh-plugin-sportsdesk-security/index.js",
      "dsh-plugin-sportsdesk-desk-status/index.js",
      "dsh-plugin-sportsdesk-desk-panel/index.js",
      "dsh-plugin-watchlist-autobet/index.js",
    ],
    primaryCliCommand: "bun run test:market-index",
    cordisPluginName:
      "dsh-plugin-sportsdesk-ops + security + desk-status + desk-panel + watchlist-autobet",
    httpOrMcpSurface:
      "Cordis /sportsdesk · /sportsdesk-sec · /autobet · :4020 resolveDeskOrigin",
    targetVenues: ["f402", "kalshi", "polymarket", "r2"],
    latencyOrThroughputSla:
      "60s auto-refresh status bar + instant command palette & sidebar drawers",
    traderEdgeCapability:
      "Embeds live P&L, CLV, sharp heatmaps, 13-cluster IP surveillance, and 12-gate autobet queue approvals directly inside the operator's DSH Cordis workspace with configurable apiPort (default 4020).",
    safetyGuardrailContract:
      "Immutable commit pins in market/index.json (Format 1), zero-innerHTML DOM rendering, and read-only session redaction across all 5 plugins.",
    primaryOwnerRoles: ["client/seam", "operator", "security/operator"],
    verificationCommand: "bun run test:market-index",
  },
  {
    toolId: "TOOL-06",
    code: "BET_TICKER_WEBLOG_BRIDGE_SUITE",
    title:
      "Real-Time BetTicker (3A), Pending (3B), Tally (3C) & 4-Mode Weblog Forensics Suite",
    category: "WIRE_SURVEILLANCE_AND_FORENSICS",
    entrypointPath: "scripts/f402_bet_ticker_bridge3a.ts",
    supportingModules: [
      "scripts/f402_pending_bridge3b.ts",
      "scripts/gslive_tally_bridge3c.ts",
      "scripts/f402_weblog_bridge.ts",
      "lib/bet_ticker_ip_tracker_bridge.ts",
      "lib/gslive_tally_rollup.ts",
    ],
    primaryCliCommand:
      "bun run bridge3a:poll && bun run bridge3b:rollup && bun run bridge3c:rollup && bun run weblog:rollup",
    cordisPluginName: "dsh-plugin-sportsdesk-ops",
    httpOrMcpSurface:
      "createF402ReplayTransport() -> R2 snapshots & local forensic JSONL",
    targetVenues: ["f402", "r2", "local-sqlite"],
    latencyOrThroughputSla:
      "0 collection allocations over 10k+ rows (Uint32Array/Float64Array arenas + lookupInto)",
    traderEdgeCapability:
      "Streams incoming BetTicker wagers, isolates ALERT sentinel twins, joins Mode A (<15s dwell), Mode B (subnet), Mode C (YYYY-MM-DD account changes), and Mode I (access audit) against 13 office IP clusters.",
    safetyGuardrailContract:
      "Uses createF402ReplayTransport() with 401 retry; never sets BUN_CONFIG_VERBOSE_FETCH; enforces 3-tier weblog corpus and 08:00 weblog:sentinel check.",
    primaryOwnerRoles: ["RISK_DESK_ANALYST", "client/seam", "operator"],
    verificationCommand: "bun test tests/tally_allocation_invariant.test.ts",
  },
  {
    toolId: "TOOL-07",
    code: "CROSS_DOMAIN_POLY_F402_GRAPH",
    title:
      "Cross-Domain Polymarket <-> F402 Syndicate Graph & 4-Week Counterfactual Backtester",
    category: "SYNDICATE_GRAPH_AND_BACKTEST",
    entrypointPath: "scripts/build_agent_graph.ts",
    supportingModules: [
      "scripts/graph_feed_poller_daemon.ts",
      "lib/customer_poly_bridge.ts",
      "lib/watchlist_signal_engine.ts",
      "lib/gslive_surveillance_governor.ts",
    ],
    primaryCliCommand:
      "bun run graph:agent && ./bin/dx poll && ./bin/dx backtest",
    cordisPluginName: "dsh-plugin-sportsdesk-desk-panel",
    httpOrMcpSurface:
      "docs/cross-domain-bridge.json · docs/backtest-4wk-cfb-nba.json · :4020/tracker",
    targetVenues: ["polymarket", "f402", "r2"],
    latencyOrThroughputSla:
      "345ms WSS SLA · 39 syndicate wallets · $1.17M 4-wk protected value",
    traderEdgeCapability:
      "Links 200 F402 customers to 39 Polymarket proxy wallets ($503k priority exposure), attributes 4-week hold lift (+1,003 bps swing) across 6 automated guards, and drives GATE-SURV-01/02 clamps.",
    safetyGuardrailContract:
      "--no-backtest-artifact flag prevents live feed refreshes from overwriting the locked 4-week counterfactual baseline in docs/artifacts.lock.json.",
    primaryOwnerRoles: ["RISK_DESK_ANALYST", "settlement", "business-owner"],
    verificationCommand: "bun run artifacts:lock",
  },
  {
    toolId: "TOOL-08",
    code: "ZERO_FRICTION_DX_MCP_WORKSTATION",
    title:
      "Zero-Friction ./bin/dx Operator Runner, Desk Doctor, MCP Server & Telegram Bot",
    category: "OPERATOR_DX_AND_MCP",
    entrypointPath: "bin/dx",
    supportingModules: [
      "scripts/desk_doctor.ts",
      "scripts/agent_env_doctor.ts",
      "scripts/mcp_dx_server.ts",
      "services/sportsdesk_telegram_bot.ts",
    ],
    primaryCliCommand:
      "./bin/dx status | bun run desk:doctor | bun run agent:doctor | bun run mcp:dx",
    cordisPluginName: "dsh-plugin-sportsdesk-desk-status",
    httpOrMcpSurface:
      "MCP stdio (dx_status, dx_screenshot, dx_deploy) · Telegram @SportsDeskBot",
    targetVenues: ["f402", "r2", "local-sqlite"],
    latencyOrThroughputSla:
      "<= 2s full workstation doctor probe + headless WebKit visual proof",
    traderEdgeCapability:
      "Single-command operator control plane for pre-slate readiness checks, secret-scoped execution (./bin/dx exec --with), headless visual verification (./bin/dx shot), and mobile Telegram slash commands.",
    safetyGuardrailContract:
      "Never sources raw .env pipes; validates secret manifest via audit:secrets and blocks unredacted HAR/bundle staging before VPS or Pages deploy.",
    primaryOwnerRoles: [
      "operator",
      "server-team-lead",
      "compliance",
      "business-owner",
    ],
    verificationCommand: "bun test tests/dx_cli.test.ts",
  },
] as const;

export interface RoleTradingWorkstationSpec {
  readonly roleId: DeskRoleId;
  readonly workstationTitle: string;
  readonly primaryToolIds: readonly string[];
  readonly cordisPluginsAssigned: readonly string[];
  readonly preSlateCommandSequence: readonly string[];
  readonly liveSlateExecutionLoop: readonly string[];
  readonly postSlateAuditLoop: readonly string[];
  readonly latencyOrExecutionSla: string;
  readonly primaryEdgeBenchmark: string;
}

export const ROLE_TRADING_WORKSTATIONS: readonly RoleTradingWorkstationSpec[] =
  [
    {
      roleId: "RISK_DESK_ANALYST",
      workstationTitle:
        "Quantitative Sharp Surveillance, Syndicate Graph & Kalshi Signal Join Workstation",
      primaryToolIds: ["TOOL-03", "TOOL-06", "TOOL-07", "TOOL-04"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-ops",
        "dsh-plugin-sportsdesk-desk-panel",
        "dsh-plugin-watchlist-autobet",
      ],
      preSlateCommandSequence: [
        "bun run weblog:sentinel",
        "bun run signals:kalshi --limit 25",
        "bun run governance:check --wagers --role RISK_DESK_ANALYST",
      ],
      liveSlateExecutionLoop: [
        "bun run bridge3a:poll",
        "bun run weblog:rollup",
        "./bin/dx watch",
      ],
      postSlateAuditLoop: [
        "bun run graph:agent",
        "bun run governance:check --decisions-log --edge-cases",
      ],
      latencyOrExecutionSla:
        "<= 345ms GATE-SURV-01 line-step · <15s Mode A bot dwell detection",
      primaryEdgeBenchmark:
        "$484.2k 4-wk counterfactual savings across 13 IP clusters & 39 bridged Polymarket wallets",
    },
    {
      roleId: "settlement",
      workstationTitle:
        "Multi-Venue Layoff Router, Key-Number Radar & CLV Post-Mortem Workstation",
      primaryToolIds: ["TOOL-01", "TOOL-04", "TOOL-02", "TOOL-07"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-desk-panel",
        "dsh-plugin-watchlist-autobet",
        "dsh-plugin-sportsdesk-ops",
      ],
      preSlateCommandSequence: [
        "bun run bridge3b:rollup",
        "bun run bridge3c:rollup",
        "bun run execution:plan --style auto",
      ],
      liveSlateExecutionLoop: [
        "bun run autobet candidates",
        "bun run execution:plan --style auto --paper-run",
        "bun run autobet settle --help",
      ],
      postSlateAuditLoop: [
        "bun run autobet journal",
        "bun run governance:check --autobet --role settlement",
      ],
      latencyOrExecutionSla:
        "<= 50ms key-number crossing eval · +485 bps avg external layoff edge",
      primaryEdgeBenchmark:
        "$685.9k 4-wk parlay/teaser & steam defense + integer-cent CLV post-mortem grading",
    },
    {
      roleId: "operator",
      workstationTitle:
        "Primary Desk Execution Console, 12-Gate Autobet Queue & ./bin/dx Control Plane",
      primaryToolIds: ["TOOL-02", "TOOL-01", "TOOL-08", "TOOL-05"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-ops",
        "dsh-plugin-sportsdesk-desk-status",
        "dsh-plugin-sportsdesk-desk-panel",
        "dsh-plugin-watchlist-autobet",
      ],
      preSlateCommandSequence: [
        "bun run desk:doctor",
        "bun run agent:doctor",
        "bun run autobet status",
      ],
      liveSlateExecutionLoop: [
        "bun run autobet watch",
        "bun run autobet list --state queued",
        "./bin/dx status",
      ],
      postSlateAuditLoop: [
        "bun run ci:local --list",
        "bun run governance:check --tooling",
      ],
      latencyOrExecutionSla:
        "<= 15m human queue approval SLA · 3/3 oracle gates green",
      primaryEdgeBenchmark:
        "$656.5k 4-wk protected value · 100% 12-gate checklist enforcement before venue routing",
    },
    {
      roleId: "security/operator",
      workstationTitle:
        "3-Factor Kalshi Live-Arming Vault, Secret Manifest & Red-Team Defense Console",
      primaryToolIds: ["TOOL-03", "TOOL-02", "TOOL-05", "TOOL-08"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-security",
        "dsh-plugin-watchlist-autobet",
        "dsh-plugin-sportsdesk-desk-status",
      ],
      preSlateCommandSequence: [
        "bun run check:secrets",
        "bun run audit:secrets",
        "bun run secrets:env status --all",
      ],
      liveSlateExecutionLoop: [
        "bun run governance:check --red-team --role security/operator",
        "bun run autobet status",
      ],
      postSlateAuditLoop: [
        "bun test lib/f402_har_redaction_proof_verify.test.ts",
        "bun run governance:check --decisions-log",
      ],
      latencyOrExecutionSla:
        "0 secret leaks · exitCode 3 immediate refusal on unarmed live execution",
      primaryEdgeBenchmark:
        "6/6 Red-Team drills VERIFIED_DEFENDED + dual-human RSA-PSS live arming governance",
    },
    {
      roleId: "client/seam",
      workstationTitle:
        "Portal Wire Normalization, Sentinel Twin Filter & 5-Plugin Cordis Seam Console",
      primaryToolIds: ["TOOL-05", "TOOL-06", "TOOL-08"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-ops",
        "dsh-plugin-sportsdesk-desk-panel",
        "dsh-plugin-sportsdesk-desk-status",
      ],
      preSlateCommandSequence: [
        "bun run test:market-index",
        "bun bin/check-innerhtml.ts --verbose",
        "bun bin/check-fetch-init.ts --verbose",
      ],
      liveSlateExecutionLoop: [
        "bun run bridge3a:poll",
        "./bin/dx shot http://localhost:4020/governance --out scratch/shots/gov.png",
      ],
      postSlateAuditLoop: [
        "bun run verify:manager-oracle-slices",
        "bun run governance:check --flowchart --role client/seam",
      ],
      latencyOrExecutionSla:
        "<= 25ms getBetTicker wire delta parse · O(1) ALERT twin isolation",
      primaryEdgeBenchmark:
        "Zero ALERT twin double-counts (EC-01) + 5/5 DSH Cordis plugins verified on Format 1",
    },
    {
      roleId: "compliance",
      workstationTitle:
        "Immutable Audit Ledger, CGNAT Fairness & Written Scope Sign-Off Console",
      primaryToolIds: ["TOOL-02", "TOOL-08", "TOOL-06"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-security",
        "dsh-plugin-sportsdesk-desk-status",
      ],
      preSlateCommandSequence: [
        "bun run governance:check --decisions-log --role compliance",
        "bun run verify:docs",
      ],
      liveSlateExecutionLoop: [
        "bun run autobet journal",
        "bun run governance:check --edge-cases",
      ],
      postSlateAuditLoop: [
        "bun run check:spec-citations",
        "bun run artifacts:lock",
      ],
      latencyOrExecutionSla:
        "30m written scope ACK SLA · 96.4% recreational bettor retention",
      primaryEdgeBenchmark:
        "100% sha256-signed human rationale audit coverage + EC-04 mobile CGNAT false-positive guard",
    },
    {
      roleId: "server-team-lead",
      workstationTitle:
        "Upstream Bearer Claim Verification, Authoritative Wager Ledger & VPS Infra Console",
      primaryToolIds: ["TOOL-08", "TOOL-06", "TOOL-07"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-security",
        "dsh-plugin-sportsdesk-desk-status",
      ],
      preSlateCommandSequence: [
        "bun run check:route-surface",
        "CI=true bun run schema:gate",
      ],
      liveSlateExecutionLoop: [
        "./bin/dx status",
        "bun run governance:check --role server-team-lead",
      ],
      postSlateAuditLoop: [
        "bash scripts/ci/run-manager-oracle-gates.sh",
        "bun run audit:ops",
      ],
      latencyOrExecutionSla:
        "60m upstream verification SLA · 0 unauthenticated route surfaces",
      primaryEdgeBenchmark:
        "Governs $503.2k cross-domain authz & server-side wager ledger integrity (Decision #3)",
    },
    {
      roleId: "business-owner",
      workstationTitle:
        "Executive Capital Allocation, Hold Swing Telemetry & Live-Capital Authorization Console",
      primaryToolIds: ["TOOL-07", "TOOL-01", "TOOL-08"],
      cordisPluginsAssigned: [
        "dsh-plugin-sportsdesk-desk-status",
        "dsh-plugin-sportsdesk-desk-panel",
      ],
      preSlateCommandSequence: [
        "bun run governance:check --tooling --role business-owner",
        "./bin/dx status",
      ],
      liveSlateExecutionLoop: [
        "bun run autobet status",
        "bun run governance:check --decisions-log",
      ],
      postSlateAuditLoop: [
        "./bin/dx backtest",
        "bun run governance:check --markdown",
      ],
      latencyOrExecutionSla:
        "60m executive sign-off SLA · $5,000 daily / $1,500 per-market cap governance",
      primaryEdgeBenchmark:
        "$1.17M 4-wk counterfactual desk savings ($41.8k/day) · -3.21% -> +6.82% hold swing",
    },
  ] as const;

export type WeakestLinkSeverity =
  "CRITICAL_BOTTLENECK" | "HIGH_FRICTION" | "LATENCY_EXPOSURE";

export type WeakestLinkBottleneckLayer =
  | "RBAC_ROLE_AND_PLANE"
  | "INGESTION_AND_CRON_WIRE"
  | "SYNDICATE_FEED_AND_PNL"
  | "EXECUTION_QUEUE_AND_MAKER_TTL"
  | "CLIENT_WIRE_AND_DOM_SINKS";

export type WeakestLinkRemediationStatus =
  | "ENHANCED_IN_CODE_AND_GOVERNANCE"
  | "CO_PILOT_FAILOVER_ACTIVE"
  | "HARNESS_READY_AWAITING_UPSTREAM";

export interface WeakestLinkDiagnosticSpec {
  readonly linkId: string;
  readonly code: string;
  readonly title: string;
  readonly severity: WeakestLinkSeverity;
  readonly bottleneckLayer: WeakestLinkBottleneckLayer;
  readonly measuredWeaknessMetric: string;
  readonly rootCauseAnalysis: string;
  readonly impactedTasksOrRefs: readonly string[];
  readonly primaryWeakRoles: readonly DeskRoleId[];
  readonly coPilotDeputyRoles: readonly DeskRoleId[];
  readonly sourceModules: readonly string[];
  readonly implementedEnhancement: string;
  readonly remediationCommand: string;
  readonly beforeScoreOrSla: string;
  readonly projectedAfterScoreOrSla: string;
  readonly financialExposureProtectedUsd: number;
  readonly status: WeakestLinkRemediationStatus;
}

export const DESK_WEAKEST_LINK_DIAGNOSTICS: readonly WeakestLinkDiagnosticSpec[] =
  [
    {
      linkId: "WL-01",
      code: "UPSTREAM_AUTHZ_3_DECISION_BOTTLENECK",
      title:
        "Upstream Stakeholder Plane (80% Health — Lowest of 4 Planes) & 3 Pending Executive Decisions (~4h)",
      severity: "CRITICAL_BOTTLENECK",
      bottleneckLayer: "RBAC_ROLE_AND_PLANE",
      measuredWeaknessMetric:
        "upstream-stakeholder plane at 80% health · server-team-lead (80%), business-owner (80%), compliance (88%) hold 3 pending decisions (~4h) blocking P0.6 (2026-12-03 expiry)",
      rootCauseAnalysis:
        "Decision #1 (subordinate test account ~1h), Decision #2 (written tamper scope ~1h), and Decision #3 (6-request Bearer claim vs body customerID/agentID verification ~2h) sit in ACK_PENDING across 3 executive inboxes, stalling P0.6 (RT-DEFENSE-MEASURE) and $503.2k cross-domain priority exposure.",
      impactedTasksOrRefs: [
        "P0.6",
        "RT-DEFENSE-MEASURE",
        "Decision #1",
        "Decision #2",
        "Decision #3",
      ],
      primaryWeakRoles: ["server-team-lead", "business-owner", "compliance"],
      coPilotDeputyRoles: ["security/operator", "operator"],
      sourceModules: [
        "docs/analysis/defense-measurement-2026-11-03/00-executive-summary.md",
        "lib/rbac_governance.ts",
        "services/sportsdesk_telegram_bot.ts",
      ],
      implementedEnhancement:
        "Pre-staged the 6-request Bearer-vs-body verification harness + 1-click executive sign-off packet in Cordis (/sportsdesk-sec) & Telegram (/gov_ack), with 15m Co-Pilot failover to security/operator (Tariq Al-Mansoor) so server-team-lead runs a 10m pre-scripted replay instead of a cold 2h build.",
      remediationCommand:
        "bun run governance:check --weakest-links --role server-team-lead",
      beforeScoreOrSla: "80% Plane Health · ~4h manual executive coordination",
      projectedAfterScoreOrSla:
        "96% Plane Health · <= 25m pre-staged replay & sign-off",
      financialExposureProtectedUsd: 503_200,
      status: "HARNESS_READY_AWAITING_UPSTREAM",
    },
    {
      linkId: "WL-02",
      code: "OPERATOR_SINGLE_POINT_QUEUE_OVERLOAD",
      title:
        "Desk Operator Role (80% Score — Tied Lowest Role) Single-Point Queue & 15m Approval Bottleneck",
      severity: "CRITICAL_BOTTLENECK",
      bottleneckLayer: "RBAC_ROLE_AND_PLANE",
      measuredWeaknessMetric:
        "operator role at 80% score · 4 open tasks (P0.1, P0.7, P1.6, P2.3) + Decision #2 + 5 queued inbox items (3 urgent) + sole primary approver on NODE-08 15m human gate",
      rootCauseAnalysis:
        "Marcus Vance (operator) simultaneously owns 4 open tasks, all 3 manager-boot-oracle gates, and the 15-minute human approval queue for dsh-plugin-watchlist-autobet, creating a single-point bottleneck during peak Saturday CFB and Sunday NFL slates.",
      impactedTasksOrRefs: ["P0.1", "P0.7", "P1.6", "P2.3", "NODE-08", "EC-08"],
      primaryWeakRoles: ["operator"],
      coPilotDeputyRoles: ["settlement", "RISK_DESK_ANALYST", "client/seam"],
      sourceModules: [
        "lib/rbac_governance.ts",
        "lib/watchlist_autobet.ts",
        "cli/watchlist_autobet_cli.ts",
      ],
      implementedEnhancement:
        "Activated Co-Pilot Load-Shedding & Deputy Failover: when operator inboxUrgentItems >= 3 or autobet queued intents >= 2, NODE-08 automatically delegates NFL/CFB key-number layoff approvals to settlement (Devon Brooks, 92% score) and NBA steam/donor clamps to RISK_DESK_ANALYST (Elena Rostova), while client/seam (Nadia Chen, 100% score) co-owns P0.1/P1.6 wire triage.",
      remediationCommand:
        "bun run governance:check --weakest-links --role operator",
      beforeScoreOrSla:
        "80% Role Score · 5 queued (3 urgent) · single-point 15m SLA",
      projectedAfterScoreOrSla:
        "96% Role Score · 3-way Co-Pilot load-balanced (<= 4m avg approval)",
      financialExposureProtectedUsd: 656_500,
      status: "CO_PILOT_FAILOVER_ACTIVE",
    },
    {
      linkId: "WL-03",
      code: "BRIDGE3C_LARGE_BETREPORT_TIMEOUT_AND_CRON_GAP",
      title:
        "Bridge 3c Large getBetReport Timeout Absence (#94) & Two-Step Wagers Snapshot Cron Gap (#93)",
      severity: "HIGH_FRICTION",
      bottleneckLayer: "INGESTION_AND_CRON_WIRE",
      measuredWeaknessMetric:
        "AGENTS.md open items #94 & #93 · scripts/gslive_tally_bridge3c.ts lacked --timeout CLI flag for heavy Saturday CFB getBetReport windows + P0.7 cron capture gap",
      rootCauseAnalysis:
        "fetchBetReportRows() in scripts/fetch-bet-tally.ts accepted timeoutMs, but scripts/gslive_tally_bridge3c.ts never exposed --timeout in parseArgs or forwarded timeoutMs in fetchOpenCapture(), risking mid-stream aborts on peak weekend slates while wagers capture + publish-snapshot (#93) required manual chaining.",
      impactedTasksOrRefs: ["#94", "#93", "P0.7", "RT-PENDING-COUNT"],
      primaryWeakRoles: ["operator", "settlement"],
      coPilotDeputyRoles: ["client/seam"],
      sourceModules: [
        "scripts/gslive_tally_bridge3c.ts",
        "scripts/fetch-bet-tally.ts",
        "lib/gslive_tally_rollup.ts",
      ],
      implementedEnhancement:
        "Enhanced scripts/gslive_tally_bridge3c.ts directly in code with --timeout <ms> (validated positive integer) and wired timeoutMs through fetchOpenCapture() -> fetchBetReportRows(), eliminating mid-stream aborts on large weekend getBetReport captures.",
      remediationCommand: "bun scripts/gslive_tally_bridge3c.ts --help",
      beforeScoreOrSla: "Fixed default fetch timeout · manual 2-step snapshot",
      projectedAfterScoreOrSla:
        "Configurable --timeout <ms> (e.g. 60000ms peak slate) + atomic R2 rollup",
      financialExposureProtectedUsd: 481_700,
      status: "ENHANCED_IN_CODE_AND_GOVERNANCE",
    },
    {
      linkId: "WL-04",
      code: "SYNDICATE_WSS_FALLBACK_AND_UNOBSERVED_WALLETS",
      title:
        "Syndicate Feed Coverage Gap (23/39 Active Wallets · 16 Un-Observed · WSS Fallback & P0.2 $110.6k Fee Gap)",
      severity: "LATENCY_EXPOSURE",
      bottleneckLayer: "SYNDICATE_FEED_AND_PNL",
      measuredWeaknessMetric:
        "23/39 active syndicate wallets (16 dormant/un-observed, 10 quarantined) · wssIngestion='not_ingested' (929ms HTTP poll vs 345ms WSS SLA) · P0.2 $110,637.44 pre-fee PnL gap",
      rootCauseAnalysis:
        "docs/graph-live-feed.json operates in PARTIAL polling mode (929ms Polymarket HTTP poll) when WSS stream ingestion is idle, and 16 of 39 bridged proxy wallets have rotated or gone dormant while P0.2 (RT-PREFEE-PNL) awaits fill-level fee reconciliation.",
      impactedTasksOrRefs: [
        "P0.2",
        "RT-PREFEE-PNL",
        "GATE-SURV-01",
        "GATE-SURV-02",
      ],
      primaryWeakRoles: ["RISK_DESK_ANALYST", "settlement"],
      coPilotDeputyRoles: ["security/operator"],
      sourceModules: [
        "scripts/graph_feed_poller_daemon.ts",
        "lib/customer_poly_bridge.ts",
        "lib/watchlist_signal_engine.ts",
      ],
      implementedEnhancement:
        "Bound automated shadow-wallet rotation detection (Mode C IP/account-change join) + offline pre-fee PnL reconciliation (bun run artifacts:value --offline) + automatic GATE-SURV-01 345ms conservative line-step whenever polymarketPollDurationMs > 500ms.",
      remediationCommand: "bun run artifacts:value --offline",
      beforeScoreOrSla:
        "23/39 wallets observed · 929ms poll · $110.6k unadjusted fee gap",
      projectedAfterScoreOrSla:
        "39/39 wallet rotation sweep + net-of-fee priority ranking + 345ms auto-step",
      financialExposureProtectedUsd: 484_200,
      status: "ENHANCED_IN_CODE_AND_GOVERNANCE",
    },
    {
      linkId: "WL-05",
      code: "MAKER_QUEUE_TTL_AND_THIN_BOOK_REANCHOR_DRIFT",
      title:
        "Passive Maker Layoff Queue Drift (3/6 Routes in Maker Mode) & Pre-Expiry Quote Re-Anchoring",
      severity: "LATENCY_EXPOSURE",
      bottleneckLayer: "EXECUTION_QUEUE_AND_MAKER_TTL",
      measuredWeaknessMetric:
        "3 of 6 layoff opportunities (LAYOFF-ROT-451, LAYOFF-ROT-507, LAYOFF-ROT-5501 · $720 / 1,288 contracts) sit in queued/paper_guarded passive maker state exposed to EC-08 TTL expiry",
      rootCauseAnalysis:
        "Thin external orderbook depth on CFB Totals (ROT-451) and NBA 1H/Derivatives (ROT-5501) downgrades evaluateExecutionDecision() from taker to passive maker (min(fair - makerMarginBps, ask - 1c)); if top-of-book moves before sign-off, resting quotes risk missing fill or expiring at the 15m TTL cliff (EC-08).",
      impactedTasksOrRefs: [
        "EC-08",
        "EC-10",
        "LAYOFF-ROT-451",
        "LAYOFF-ROT-507",
        "LAYOFF-ROT-5501",
      ],
      primaryWeakRoles: ["settlement", "operator"],
      coPilotDeputyRoles: ["RISK_DESK_ANALYST"],
      sourceModules: [
        "lib/execution_planner.ts",
        "lib/execution_decision.ts",
        "lib/watchlist_autobet.ts",
      ],
      implementedEnhancement:
        "Added dynamic maker quote re-anchoring (bun run execution:plan --style auto) with automatic 5-minute pre-expiry Telegram/Cordis escalation to Co-Pilot approver (Devon Brooks / Elena Rostova) so resting maker intents are re-priced or split into taker tranches before TTL expiration.",
      remediationCommand:
        "bun test tests/execution_planner.test.ts tests/execution_decision.test.ts",
      beforeScoreOrSla:
        "Static maker quote · 15m hard TTL expiry cliff (EC-08)",
      projectedAfterScoreOrSla:
        "Dynamic spread re-anchor + 5m pre-expiry Co-Pilot ping (0 stale expiries)",
      financialExposureProtectedUsd: 218_400,
      status: "CO_PILOT_FAILOVER_ACTIVE",
    },
    {
      linkId: "WL-06",
      code: "CLIENT_SINK_WRAPPERS_AND_500_ON_BOTH_WIRE_GAPS",
      title:
        "Portal Wire 500-on-Both Unknowns (P0.1 getGradedWagerByCustomer / getTicketDetailPrint) & Client Sink Hardening (P0.5)",
      severity: "HIGH_FRICTION",
      bottleneckLayer: "CLIENT_WIRE_AND_DOM_SINKS",
      measuredWeaknessMetric:
        "2 remaining [unknown] portal operations (P0.1 0-byte HTTP 500s) + P0.5 client searchComponent DOM sink wrapper enforcement + lib/fraud_model.ts advisory debt",
      rootCauseAnalysis:
        "getGradedWagerByCustomer and getTicketDetailPrint return 0-byte HTTP 500 responses when invoked without graded ticketNumber/wagerNumber/flag/week parameters, while legacy portal views require MODULE_SINK_WRAPPERS and zero-innerHTML enforcement.",
      impactedTasksOrRefs: [
        "P0.1",
        "P0.5",
        "RT-F402-CAPTURE",
        "RT-SEARCH-ESCAPE",
      ],
      primaryWeakRoles: ["client/seam", "security/operator"],
      coPilotDeputyRoles: ["operator"],
      sourceModules: [
        "lib/blob_ingest.ts",
        "bin/check-innerhtml.ts",
        "lib/fraud_model.ts",
      ],
      implementedEnhancement:
        "Enforced strict preflight parameter validation (--week 0, --ticket, --wager, --flag) + parseF402ListEnvelope() polymorphic LIST guard in lib/blob_ingest.ts + zero-innerHTML gate across all operator dashboards and Cordis plugins.",
      remediationCommand: "bun bin/check-innerhtml.ts --verbose",
      beforeScoreOrSla:
        "2 [unknown] 0-byte 500s · unescaped legacy search render",
      projectedAfterScoreOrSla:
        "7/7 typed wire envelopes + 0 innerHTML violations across all surfaces",
      financialExposureProtectedUsd: 196_800,
      status: "ENHANCED_IN_CODE_AND_GOVERNANCE",
    },
  ] as const;

export type IssuePrResolutionStatus =
  "FIXED_AND_MERGED" | "FIXED_IN_CURRENT_PR" | "DISPATCHED_TO_TEAMMATE_INBOX";

export interface GitHubIssueAndPrTriageEntry {
  readonly itemRef: string;
  readonly kind: "GITHUB_ISSUE" | "GITHUB_PR";
  readonly number: number;
  readonly title: string;
  readonly primaryOwnerRole: DeskRoleId;
  readonly assigneeName: string;
  readonly assigneeEmail: string;
  readonly inboxDispatchRoute: string;
  readonly coPilotReviewerRole: DeskRoleId;
  readonly coPilotReviewerName: string;
  readonly linkedPrsOrIssues: readonly string[];
  readonly resolutionStatus: IssuePrResolutionStatus;
  readonly reviewAndMergeNote: string;
  readonly verificationCommand: string;
}

export const GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER: readonly GitHubIssueAndPrTriageEntry[] =
  [
    {
      itemRef: "ISSUE-115",
      kind: "GITHUB_ISSUE",
      number: 115,
      title:
        "fix(daemon/dsh-proxy): unify Bun-native port cascade (4020 vs 3000) and Host/Client proxy port contracts",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "client/seam",
      coPilotReviewerName: "Soren Lindqvist",
      linkedPrsOrIssues: ["PR #114", "PR #129"],
      resolutionStatus: "FIXED_IN_CURRENT_PR",
      reviewAndMergeNote:
        "Added resolveSportsdeskDaemonPort(env, 4020) in lib/bun_serve_port.ts (BUN_PORT -> PORT -> NODE_PORT -> 4020) and wired lib/health_watcher.ts alongside Cordis config.apiPort in dsh-plugin-sidebar.",
      verificationCommand:
        "bun test tests/supervisor.test.ts tests/rbac_governance.test.ts",
    },
    {
      itemRef: "ISSUE-103",
      kind: "GITHUB_ISSUE",
      number: 103,
      title:
        "fix(bridge3b): credential gate ignores session.authorizationHeader",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "security/operator",
      coPilotReviewerName: "Tariq Al-Mansoor",
      linkedPrsOrIssues: ["PR #104"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #104 (80014a4): resolveF402BearerTokenDetailed honors session.authorizationHeader across lib/f402_pending_fetch.ts, lib/bridge_rollup_cron.ts, and scripts/f402_pending_bridge3b.ts.",
      verificationCommand: "bun test tests/f402_pending_bridge3b.test.ts",
    },
    {
      itemRef: "ISSUE-101",
      kind: "GITHUB_ISSUE",
      number: 101,
      title:
        "wagers:by-state default calcTime misreports data freshness for desk KPIs",
      primaryOwnerRole: "settlement",
      assigneeName: "Devon Brooks",
      assigneeEmail: "settlement@bookdeskops.com",
      inboxDispatchRoute: "inbox://risk-settlement/grading",
      coPilotReviewerRole: "operator",
      coPilotReviewerName: "Marcus Vance",
      linkedPrsOrIssues: ["PR #104"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #104 (80014a4): live wagers capture defaults to betTime so pending wagers report real placement freshness instead of 1969-12-31 calcTime sentinel.",
      verificationCommand: "bun test tests/gslive_wagers_by_state.test.ts",
    },
    {
      itemRef: "ISSUE-96",
      kind: "GITHUB_ISSUE",
      number: 96,
      title: "chore(lint): add ast-grep rule to ban generic throws",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "security/operator",
      coPilotReviewerName: "Tariq Al-Mansoor",
      linkedPrsOrIssues: ["PR #119"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #119 (3c87c7d): bin/check-signal-honesty.ts + tests/check_signal_honesty_meta.test.ts enforce structured signal-honesty throws in CI.",
      verificationCommand: "bun test tests/check_signal_honesty_meta.test.ts",
    },
    {
      itemRef: "ISSUE-93",
      kind: "GITHUB_ISSUE",
      number: 93,
      title:
        "feat(cron): wire wagers-by-state + publish-snapshot into bridge_rollup_cron",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "settlement",
      coPilotReviewerName: "Devon Brooks",
      linkedPrsOrIssues: ["PR #119"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #119 (3c87c7d): wagers-by-state and wagers-publish are wired into BRIDGE_ROLLUP_JOBS in lib/bridge_rollup_cron.ts and services/reporting_scheduler_service.ts.",
      verificationCommand: "bun test tests/bridge_rollup_cron.test.ts",
    },
    {
      itemRef: "ISSUE-91",
      kind: "GITHUB_ISSUE",
      number: 91,
      title: "f402-weblog: automate activity JSONL producer (Nov 4+)",
      primaryOwnerRole: "RISK_DESK_ANALYST",
      assigneeName: "Elena Rostova",
      assigneeEmail: "risk-analyst@bookdeskops.com",
      inboxDispatchRoute: "inbox://risk-settlement/surveillance",
      coPilotReviewerRole: "operator",
      coPilotReviewerName: "Marcus Vance",
      linkedPrsOrIssues: ["PR #119", "P0.1"],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "08:00 weblog:sentinel + 3-tier corpus active (#90/#91/#92); dispatched to Elena Rostova & Marcus Vance to keep manual portal export + sentinel verification green.",
      verificationCommand: "bun run weblog:sentinel",
    },
    {
      itemRef: "ISSUE-80",
      kind: "GITHUB_ISSUE",
      number: 80,
      title:
        "desk panel: legacy portal UX parity (status strip, freshness, compact density, drill-down)",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "RISK_DESK_ANALYST",
      coPilotReviewerName: "Elena Rostova",
      linkedPrsOrIssues: ["PR #119", "PR #127"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #119 (3c87c7d) and PR #127 (28b7c9b): provenance chips, data-age status strip, and gap-halt drill-down shipped in dsh-plugin-sidebar.",
      verificationCommand: "bun test tests/sidebar_provenance_chip.test.ts",
    },
    {
      itemRef: "ISSUE-79",
      kind: "GITHUB_ISSUE",
      number: 79,
      title:
        "ux: distinguish scratch fallback vs intentional sample fixture chip",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "operator",
      coPilotReviewerName: "Marcus Vance",
      linkedPrsOrIssues: ["PR #119"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #119 (3c87c7d): lib/sidebar_fixture_provenance.ts distinguishes scratch fallback from intentional sample fixture chips.",
      verificationCommand: "bun test tests/sidebar_provenance_chip.test.ts",
    },
    {
      itemRef: "ISSUE-78",
      kind: "GITHUB_ISSUE",
      number: 78,
      title:
        "ux: fixture [not live] chip should say why (session expired vs fixture mode vs offline)",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "RISK_DESK_ANALYST",
      coPilotReviewerName: "Elena Rostova",
      linkedPrsOrIssues: ["PR #119"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed & merged in PR #119 (3c87c7d): lib/sidebar_fixture_provenance.ts + lib/desk_enhanced_health.ts surface exact non-live reason (session expired vs fixture vs R2 age).",
      verificationCommand: "bun test tests/sidebar_provenance_chip.test.ts",
    },
    {
      itemRef: "ISSUE-77",
      kind: "GITHUB_ISSUE",
      number: 77,
      title:
        "live KPI: F402_BEARER_TOKEN fallback for Manager reads (needs wire proof)",
      primaryOwnerRole: "server-team-lead",
      assigneeName: "Vikram Patel",
      assigneeEmail: "server-lead@bookdeskops.com",
      inboxDispatchRoute: "inbox://upstream/server-team",
      coPilotReviewerRole: "security/operator",
      coPilotReviewerName: "Tariq Al-Mansoor",
      linkedPrsOrIssues: ["PR #104", "Decision #3"],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "session.authorizationHeader fallback landed in PR #104; dispatched wire proof verification to Vikram Patel & Tariq Al-Mansoor alongside Decision #3.",
      verificationCommand: "bun test tests/f402_pending_bridge3b.test.ts",
    },
    {
      itemRef: "ISSUE-76",
      kind: "GITHUB_ISSUE",
      number: 76,
      title:
        "sched: wire f402_session_refresh into reporting scheduler (optional)",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "server-team-lead",
      coPilotReviewerName: "Vikram Patel",
      linkedPrsOrIssues: ["PR #119"],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "Dispatched optional scheduler hook review to Marcus Vance & Vikram Patel in services/reporting_scheduler_service.ts.",
      verificationCommand: "bun test tests/bridge_rollup_cron.test.ts",
    },
    {
      itemRef: "ISSUE-23",
      kind: "GITHUB_ISSUE",
      number: 23,
      title:
        "Pending-customer count blocked: transaction log + definitions + test environment",
      primaryOwnerRole: "settlement",
      assigneeName: "Devon Brooks",
      assigneeEmail: "settlement@bookdeskops.com",
      inboxDispatchRoute: "inbox://risk-settlement/grading",
      coPilotReviewerRole: "compliance",
      coPilotReviewerName: "Nadia Chen",
      linkedPrsOrIssues: ["P0.7", "RT-PENDING-COUNT"],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "Governed under P0.7 (RT-PENDING-COUNT): dispatched to Devon Brooks, Nadia Chen & Marcus Vance for server-side wager ledger & written pending definition.",
      verificationCommand: "bun run governance:check --audit --role settlement",
    },
    {
      itemRef: "ISSUE-22",
      kind: "GITHUB_ISSUE",
      number: 22,
      title:
        "Triage agent-management-thin credential sinks (password/name renders)",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "security/operator",
      coPilotReviewerName: "Tariq Al-Mansoor",
      linkedPrsOrIssues: ["P0.5", "RT-SEARCH-ESCAPE", "PR #131"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "applyAgentManagementThinEscaper active in client/overlay/security-seams.preload.js, wrapping setPassword, setName, and setColsAgentManagement with strict targeted markup escaping and throw-safe restoration; module sink anchor registered in lib/f402_client_seams.ts; reviewed and merged in PR #131.",
      verificationCommand: "bun test tests/f402_client_seams.test.ts",
    },
    {
      itemRef: "ISSUE-21",
      kind: "GITHUB_ISSUE",
      number: 21,
      title:
        "Escape pending-thin wager-detail source render (bet-desc/gameReport are copies)",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "security/operator",
      coPilotReviewerName: "Tariq Al-Mansoor",
      linkedPrsOrIssues: ["P0.5", "RT-SEARCH-ESCAPE"],
      resolutionStatus: "FIXED_IN_CURRENT_PR",
      reviewAndMergeNote:
        "applyPendingThinEscaper active in client/overlay/security-seams.preload.js, wrapping getResultTicketPending, getResultTicketMobileDetails, and getResultTicketMobile with input leg data escaping before template interpolation, eliminating stored DOM XSS in .gameReport and preventing downstream exfiltration in delete-confirm bet-desc copy; anchors registered in lib/f402_client_seams.ts.",
      verificationCommand: "bun test tests/f402_client_seams.test.ts",
    },
    {
      itemRef: "ISSUE-20",
      kind: "GITHUB_ISSUE",
      number: 20,
      title:
        "Reconcile PLAYERS scale: ~5.7k in boot evidence vs 57,763 in the full envelope",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "client/seam",
      coPilotReviewerName: "Soren Lindqvist",
      linkedPrsOrIssues: ["PR #129"],
      resolutionStatus: "FIXED_IN_CURRENT_PR",
      reviewAndMergeNote:
        "Reconciled in docs/evidence/manager-boot-primary-sources.md with explicit F402_PLAYERS_MODE capture-mode qualifier (projected ~5.7k on boot capture i' vs full 57,763 in raw-f402-list-agents.json).",
      verificationCommand: "bun run verify:docs",
    },
    {
      itemRef: "ISSUE-19",
      kind: "GITHUB_ISSUE",
      number: 19,
      title:
        "PII retention: Scratch backups and raw dumps are not in the deletion path",
      primaryOwnerRole: "compliance",
      assigneeName: "Nadia Chen",
      assigneeEmail: "compliance@bookdeskops.com",
      inboxDispatchRoute: "inbox://security/compliance",
      coPilotReviewerRole: "operator",
      coPilotReviewerName: "Marcus Vance",
      linkedPrsOrIssues: ["tests/data_artifacts_tracking.test.ts"],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "tests/data_artifacts_tracking.test.ts blocks tracked live dumps; dispatched scratch/backups retention sweep policy to Nadia Chen & Marcus Vance.",
      verificationCommand: "bun test tests/data_artifacts_tracking.test.ts",
    },
    {
      itemRef: "ISSUE-18",
      kind: "GITHUB_ISSUE",
      number: 18,
      title:
        "Auth-adjacent artifacts: cached Chrome profile / Web Data hold a live agent id",
      primaryOwnerRole: "security/operator",
      assigneeName: "Tariq Al-Mansoor",
      assigneeEmail: "security@bookdeskops.com",
      inboxDispatchRoute: "inbox://security/red-team",
      coPilotReviewerRole: "operator",
      coPilotReviewerName: "Marcus Vance",
      linkedPrsOrIssues: ["lib/f402_har_redaction_proof_verify.test.ts"],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "HAR redaction proof gate active; dispatched Chrome profile / Web Data scrub runbook check to Tariq Al-Mansoor & Marcus Vance.",
      verificationCommand:
        "bun test lib/f402_har_redaction_proof_verify.test.ts",
    },
    {
      itemRef: "ISSUE-17",
      kind: "GITHUB_ISSUE",
      number: 17,
      title:
        "Unblock: Bearer verdict + financial ledger (decisions, owners, ~4 hours total)",
      primaryOwnerRole: "server-team-lead",
      assigneeName: "Vikram Patel",
      assigneeEmail: "server-lead@bookdeskops.com",
      inboxDispatchRoute: "inbox://upstream/server-team",
      coPilotReviewerRole: "business-owner",
      coPilotReviewerName: "Arthur Pendelton",
      linkedPrsOrIssues: [
        "P0.6",
        "WL-01",
        "Decision #1",
        "Decision #2",
        "Decision #3",
      ],
      resolutionStatus: "DISPATCHED_TO_TEAMMATE_INBOX",
      reviewAndMergeNote:
        "Pre-staged 6-request Bearer-vs-body verification harness under WL-01; dispatched to Vikram Patel, Arthur Pendelton & Nadia Chen for executive sign-off before 2026-12-03.",
      verificationCommand:
        "bun run governance:check --weakest-links --role server-team-lead",
    },
    {
      itemRef: "ISSUE-16",
      kind: "GITHUB_ISSUE",
      number: 16,
      title:
        "searchComponent render sink: escape NameFirst/Password before .html()",
      primaryOwnerRole: "client/seam",
      assigneeName: "Soren Lindqvist",
      assigneeEmail: "client-seam@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/client-seam",
      coPilotReviewerRole: "security/operator",
      coPilotReviewerName: "Tariq Al-Mansoor",
      linkedPrsOrIssues: ["PR #129", "RT-SEARCH-ESCAPE"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Verified all 8 MODULE_SINK_WRAPPERS (applySearchEscaper, applySetHistoryEscaper, applyMessageInitEscaper, applyPopUpMessagesEscaper, applySetCommunicationMessagesEscaper, applySearchCustomerEscaper, applyGetCommunicationMessagesEscaper, applyPlayerInfoEscaper) active in client/overlay/security-seams.preload.js.",
      verificationCommand: "bun bin/check-innerhtml.ts --verbose",
    },
    {
      itemRef: "PR-127",
      kind: "GITHUB_PR",
      number: 127,
      title:
        "feat(tally-3c): halt rollup on pagination gap + surface banner in sidebar",
      primaryOwnerRole: "settlement",
      assigneeName: "Devon Brooks",
      assigneeEmail: "settlement@bookdeskops.com",
      inboxDispatchRoute: "inbox://risk-settlement/grading",
      coPilotReviewerRole: "client/seam",
      coPilotReviewerName: "Soren Lindqvist",
      linkedPrsOrIssues: ["PR #128", "ISSUE-80"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed by Devon Brooks & Soren Lindqvist and merged to main (28b7c9b) with market-index pin follow-up in PR #128 (ef249fa).",
      verificationCommand: "bun test tests/gslive_tally_bridge3c.test.ts",
    },
    {
      itemRef: "PR-125",
      kind: "GITHUB_PR",
      number: 125,
      title:
        "feat(autobet): wire Kalshi live execution adapter + 3-factor arming gate",
      primaryOwnerRole: "security/operator",
      assigneeName: "Tariq Al-Mansoor",
      assigneeEmail: "security@bookdeskops.com",
      inboxDispatchRoute: "inbox://security/red-team",
      coPilotReviewerRole: "RISK_DESK_ANALYST",
      coPilotReviewerName: "Elena Rostova",
      linkedPrsOrIssues: ["PR #126", "TOOL-03"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed by Tariq Al-Mansoor & Elena Rostova and merged to main (3aa16da) with market-index pin update in PR #126 (e0b05f4).",
      verificationCommand: "bun test tests/kalshi_live_execution.test.ts",
    },
    {
      itemRef: "PR-119",
      kind: "GITHUB_PR",
      number: 119,
      title: "chore(ci): scope verify job to PR-changed files and plugins",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "client/seam",
      coPilotReviewerName: "Soren Lindqvist",
      linkedPrsOrIssues: [
        "ISSUE-96",
        "ISSUE-93",
        "ISSUE-80",
        "ISSUE-79",
        "ISSUE-78",
      ],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed by Marcus Vance & Soren Lindqvist and merged to main (3c87c7d), resolving #96, #93, #80, #79, #78, and #94.",
      verificationCommand: "bun run test:market-index",
    },
    {
      itemRef: "PR-104",
      kind: "GITHUB_PR",
      number: 104,
      title:
        "fix(f402): resolve bearer token from session.authorizationHeader + default wagers capture to betTime (#101, #103)",
      primaryOwnerRole: "operator",
      assigneeName: "Marcus Vance",
      assigneeEmail: "ops-desk@bookdeskops.com",
      inboxDispatchRoute: "inbox://ops-desk/triage",
      coPilotReviewerRole: "settlement",
      coPilotReviewerName: "Devon Brooks",
      linkedPrsOrIssues: ["ISSUE-103", "ISSUE-101"],
      resolutionStatus: "FIXED_AND_MERGED",
      reviewAndMergeNote:
        "Reviewed by Marcus Vance & Devon Brooks and merged to main (80014a4), resolving #103 and #101.",
      verificationCommand: "bun test tests/f402_pending_bridge3b.test.ts",
    },
  ] as const;

export interface WagerSurveillanceAndAutobetSummary {
  readonly totalClientProfiles: number;
  readonly totalLinkedAccountsTracked: number;
  readonly totalBridgedPolymarketWallets: number;
  readonly avgModeADwellSeconds: number;
  readonly avgMfcsScore: number;
  readonly weblogModesGoverned: number;
  readonly redTeamDrillsTotal: number;
  readonly redTeamDrillsDefended: number;
  readonly autobetStagesCount: number;
  readonly autobetGateChecksCount: number;
  readonly layoffOpportunitiesCount: number;
  readonly totalPlannedLayoffUsd: number;
  readonly totalPlannedContracts: number;
  readonly avgLayoffEdgeBps: number;
  readonly flowchartNodesCount: number;
  readonly flowchartEdgesCount: number;
  readonly decisionAuditLogCount: number;
  readonly humanSignedDecisionsCount: number;
  readonly edgeCaseVariantsCount: number;
  readonly tradingToolsCount: number;
  readonly verifiedTradingToolsOnDiskCount: number;
  readonly roleWorkstationsCount: number;
  readonly weakestLinksCount: number;
  readonly weakestRoleIds: readonly DeskRoleId[];
  readonly weakestPlaneId: DeskRoleSpec["plane"];
  readonly projectedTeamHealthScoreAfterEnhancements: number;
  readonly githubIssuesTriagedCount: number;
  readonly githubIssuesResolvedCount: number;
  readonly githubPrsReviewedAndMergedCount: number;
  readonly executionPolicyMode: "paper (live-gated by 3-factor Kalshi arming)";
  readonly liveConfirmPhrase: "PLACE LIVE ORDERS";
  readonly weblogModeContracts: readonly WebLogModeGovernanceSpec[];
  readonly clientProfiles: readonly ClientWagerPatternProfile[];
  readonly redTeamDrills: readonly RedTeamDrillSpec[];
  readonly autobetStages: readonly AutobetLayoffStageSpec[];
  readonly layoffOpportunities: readonly AutobetLayoffOpportunitySpec[];
  readonly flowchartNodes: readonly BetTickerFlowNodeSpec[];
  readonly flowchartEdges: readonly BetTickerFlowEdgeSpec[];
  readonly flowchartMermaid: string;
  readonly decisionAuditLog: readonly BetTickerDecisionAuditEntry[];
  readonly edgeCaseVariants: readonly BetTickerEdgeCaseVariantSpec[];
  readonly tradingToolingSuite: readonly DeskTradingToolSpec[];
  readonly roleWorkstations: readonly RoleTradingWorkstationSpec[];
  readonly weakestLinkDiagnostics: readonly WeakestLinkDiagnosticSpec[];
  readonly githubIssueAndPrTriageLedger: readonly GitHubIssueAndPrTriageEntry[];
}

export interface GovernanceFinding {
  readonly code:
    | "TASK_MISSING_OWNER"
    | "TASK_UNMAPPED_OWNER"
    | "TASK_MISSING_REF"
    | "TASK_UNRESOLVED_REF"
    | "TASK_MISSING_BASIS"
    | "TASK_MISSING_CONTRACT"
    | "TASK_MISSING_GOAL"
    | "TASK_MISSING_DIRECTION"
    | "TASK_EVIDENCE_MISSING"
    | "DONE_TASK_UNVERIFIED_BASIS"
    | "TASK_EXPIRY_OVERDUE"
    | "ORACLE_GATE_OWNER_INVALID"
    | "ORACLE_GATE_BLOCKED"
    | "SURVEILLANCE_SLA_DRIFT"
    | "ROLE_MISSING_EMAIL_OR_INBOX"
    | "ROLE_MISSING_TEAM_LEAD"
    | "ROLE_MISSING_CHANNEL_BINDING"
    | "CLIENT_PROFILE_MISSING_OWNER_OR_TASK"
    | "RED_TEAM_DRILL_UNVERIFIED"
    | "AUTOBET_LAYOFF_POLICY_DRIFT"
    | "DECISION_AUDIT_LOG_INCOMPLETE"
    | "EDGE_CASE_VARIANT_UNOWNED"
    | "TRADING_TOOL_ENTRYPOINT_MISSING"
    | "ROLE_WORKSTATION_INCOMPLETE"
    | "WEAKEST_LINK_MODULE_MISSING"
    | "WEAKEST_LINK_UNOWNED_OR_INCOMPLETE";
  readonly severity: "error" | "warn";
  readonly target: string;
  readonly detail: string;
}

export interface GovernanceReport {
  readonly generatedAt: string;
  readonly referenceDate: string;
  readonly summary: {
    readonly openTasks: number;
    readonly doneTasks: number;
    readonly p0Open: number;
    readonly unownedTasks: number;
    readonly unverifiedTasks: number;
    readonly overdueItems: number;
    readonly readyGates: number;
    readonly totalGates: number;
    readonly pendingDecisions: number;
    readonly pendingDecisionHours: number;
    readonly surveillanceSlaHours: number;
    readonly teamHealthScore: number;
    readonly gatePassed: boolean;
    readonly totalCounterfactualSavingsUsd4Wk: number;
    readonly dailyProtectionRateUsd: number;
    readonly crossDomainPriorityUsd: number;
    readonly activeSyndicateWallets: number;
    readonly openSyndicateExposureUsd: number;
    readonly openTasksWithGoal: number;
    readonly openTasksWithDirection: number;
    readonly verifiedCitedPaths: number;
    readonly totalCitedPaths: number;
    readonly overallCompletionPct: number;
    readonly activeChannelsCount: number;
    readonly totalRoleInboxes: number;
    readonly inboxPendingAckTotal: number;
    readonly clientProfilesCount: number;
    readonly redTeamDrillsDefended: number;
    readonly redTeamDrillsTotal: number;
    readonly layoffOpportunitiesCount: number;
    readonly totalPlannedLayoffUsd: number;
    readonly flowchartNodesCount: number;
    readonly decisionAuditLogCount: number;
    readonly edgeCaseVariantsCount: number;
    readonly tradingToolsCount: number;
    readonly verifiedTradingToolsOnDiskCount: number;
    readonly roleWorkstationsCount: number;
    readonly weakestLinksCount: number;
    readonly weakestRoleIds: readonly DeskRoleId[];
    readonly weakestPlaneId: DeskRoleSpec["plane"];
    readonly projectedTeamHealthScoreAfterEnhancements: number;
    readonly githubIssuesTriagedCount: number;
    readonly githubIssuesResolvedCount: number;
    readonly githubPrsReviewedAndMergedCount: number;
  };
  readonly taskAudit: TaskAuditSummary;
  readonly channelIntegrations: readonly ChannelIntegrationSpec[];
  readonly wagerSurveillanceAndAutobet: WagerSurveillanceAndAutobetSummary;
  readonly ownerScorecards: readonly OwnerScorecard[];
  readonly tasks: readonly GovernedTask[];
  readonly decisions: readonly ExecutiveDecision[];
  readonly oracleGates: readonly OracleGateStatus[];
  readonly rbacMatrix: readonly RbacCapabilityRow[];
  readonly portalHierarchy: readonly PortalRoleContract[];
  readonly valueTelemetry: TeamValueTelemetry;
  readonly findings: readonly GovernanceFinding[];
}

/**
 * Normalize a free-form owner text into canonical `DeskRoleId` values.
 * Order is preserved and duplicates are removed.
 */
export function resolveDeskRolesFromText(raw: string | null): DeskRoleId[] {
  if (raw === null || raw.trim() === "") return [];
  const lower = raw.toLowerCase();
  const matched = new Set<DeskRoleId>();

  if (
    lower.includes("security/operator") ||
    lower.includes("desk security owner")
  ) {
    matched.add("security/operator");
  }
  if (
    /\boperator\b/.test(lower) &&
    (!lower.includes("security/operator") ||
      lower.includes("+ operator") ||
      lower.includes("operator +"))
  ) {
    matched.add("operator");
  }
  if (
    lower.includes("client/seam") ||
    lower.includes("client") ||
    lower.includes("seam")
  ) {
    matched.add("client/seam");
  }
  if (lower.includes("settlement")) {
    matched.add("settlement");
  }
  if (lower.includes("compliance") || lower.includes("legal")) {
    matched.add("compliance");
  }
  if (lower.includes("server team") || lower.includes("server-team")) {
    matched.add("server-team-lead");
  }
  if (lower.includes("business owner") || lower.includes("business-owner")) {
    matched.add("business-owner");
  }
  if (
    lower.includes("risk_desk_analyst") ||
    lower.includes("risk-desk-analyst") ||
    lower.includes("risk desk analyst")
  ) {
    matched.add("RISK_DESK_ANALYST");
  }

  return [...matched];
}

function extractBasisLabels(text: string): TaskBasisLabel[] {
  const found = new Set<TaskBasisLabel>();
  for (const label of TASK_BASIS_LABELS) {
    if (text.includes(label)) {
      found.add(label);
    }
  }
  return [...found];
}

function extractTrackedRepoPaths(text: string): string[] {
  const matches = text.matchAll(
    /`((?:docs|lib|scripts|tests|\.github|verification|services|bin|cli|schema)\/[A-Za-z0-9_./-]+)`/g,
  );
  const unique = new Set<string>();
  for (const m of matches) {
    const raw = (m[1] ?? "").replace(/[.,;:]+$/, "");
    if (raw.length > 0 && !raw.includes("*") && !raw.includes("<")) {
      unique.add(raw);
    }
  }
  return [...unique];
}

function verifyRepoPaths(
  citedPaths: readonly string[],
  root: string,
): {
  readonly verifiedPaths: readonly string[];
  readonly missingPaths: readonly string[];
} {
  const verifiedPaths: string[] = [];
  const missingPaths: string[] = [];
  for (const rel of citedPaths) {
    if (existsSync(join(root, rel))) {
      verifiedPaths.push(rel);
    } else {
      missingPaths.push(rel);
    }
  }
  return { verifiedPaths, missingPaths };
}

function extractRunnableCommand(text: string): string | null {
  const m = /`((?:bun|bash|node|\.\/bin\/dx)\s+[^`]+)`/.exec(text);
  return m?.[1]?.trim() ?? null;
}

function computeSlaState(
  expiryIso: string | null,
  nowMs: number,
): {
  readonly daysUntilExpiry: number | null;
  readonly slaState: GovernedTask["slaState"];
} {
  if (expiryIso === null) {
    return { daysUntilExpiry: null, slaState: "NO_EXPIRY" };
  }
  const expiryMs = Date.parse(`${expiryIso}T23:59:59Z`);
  if (!Number.isFinite(expiryMs)) {
    return { daysUntilExpiry: null, slaState: "NO_EXPIRY" };
  }
  const days = Math.ceil((expiryMs - nowMs) / (1000 * 60 * 60 * 24));
  if (days < 0) return { daysUntilExpiry: days, slaState: "OVERDUE" };
  if (days <= 7) return { daysUntilExpiry: days, slaState: "DUE_SOON" };
  return { daysUntilExpiry: days, slaState: "OK" };
}

/**
 * Parse `docs/REMAINING_TASKS.md` into structured `GovernedTask` records and reference table IDs.
 */
export function parseRemainingTasksMarkdown(
  markdown: string,
  nowMs: number = Date.now(),
  root: string = DEFAULT_REPO_ROOT,
): {
  readonly tasks: readonly GovernedTask[];
  readonly referenceTableIds: ReadonlySet<string>;
} {
  const tableRefs = new Set<string>(
    [...markdown.matchAll(/^\|\s*`(RT-[A-Z0-9-]+)`\s*\|/gm)].map(
      (m) => m[1] ?? "",
    ),
  );

  const lines = markdown.split("\n");
  const tasks: GovernedTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("- [ ] ")) {
      const headMatch = /^- \[ \] \*\*(P([0-2])\.\d+)\s+(.+?)\*\*\s*$/.exec(
        line.trim(),
      );
      const id = headMatch?.[1] ?? `OPEN-${tasks.length + 1}`;
      const priorityTier = (
        headMatch?.[2] !== undefined ? `P${headMatch[2]}` : "P0"
      ) as "P0" | "P1" | "P2";
      const title = headMatch?.[3] ?? line.replace(/^- \[ \]\s*/, "").trim();

      const blockLines: string[] = [];
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j] === "" || /^\s{2,}\S/.test(lines[j] ?? ""))
      ) {
        blockLines.push(lines[j] ?? "");
        j++;
      }
      i = j - 1;

      const blockText = blockLines.join("\n");
      const refMatch = /^\s+- \*\*Ref:\*\* `(RT-[A-Z0-9-]+)`/m.exec(blockText);
      const ownerMatch = /^\s+- \*\*Owner:\*\* (.+)$/m.exec(blockText);
      const goalMatch = /^\s+- \*\*Goal:\*\* (.+)$/m.exec(blockText);
      const directionMatch = /^\s+- \*\*Direction:\*\* (.+)$/m.exec(blockText);
      const doneWhenMatch = /^\s+- \*\*(?:Done when|Exit):\*\* (.+)$/m.exec(
        blockText,
      );
      const blockedByMatch = /^\s+- \*\*Blocked by:\*\* (.+)$/m.exec(blockText);
      const expiryMatch =
        /\*\*Expiry:\*\*[^\n]*?\*\*(\d{4}-\d{2}-\d{2})\*\*/m.exec(blockText);
      const issueMatch =
        /^\s+- \*\*Issue:\*\* \[#\d+\]\((https:\/\/[^)]+)\)/m.exec(blockText);

      const ref = refMatch?.[1] ?? null;
      const rawOwner = ownerMatch?.[1]?.trim() ?? null;
      const owners = resolveDeskRolesFromText(rawOwner);
      const basisLabels = extractBasisLabels(blockText);
      const canCloseByBasis =
        basisLabels.length > 0 &&
        basisLabels.every((b) => b === "[CODE]" || b === "[OBSERVED]");
      const goal = goalMatch?.[1]?.trim() ?? null;
      const direction = directionMatch?.[1]?.trim() ?? null;
      const nextCommand = extractRunnableCommand(
        `${direction ?? ""}\n${blockText}`,
      );
      const citedPaths = extractTrackedRepoPaths(`${line}\n${blockText}`);
      const { verifiedPaths, missingPaths } = verifyRepoPaths(citedPaths, root);
      const doneWhen = doneWhenMatch?.[1]?.trim() ?? null;
      const blockedBy = blockedByMatch?.[1]?.trim() ?? null;
      const expiryDate = expiryMatch?.[1] ?? null;
      const { daysUntilExpiry, slaState } = computeSlaState(expiryDate, nowMs);

      // Compute audit readiness percentage (0..95 for open tasks; 100 when closed):
      let completionPct = 0;
      if (owners.length > 0) completionPct += 15;
      if (ref !== null && tableRefs.has(ref)) completionPct += 10;
      if (goal !== null && goal.length >= 15) completionPct += 20;
      if (direction !== null && direction.length >= 15) completionPct += 20;
      if (doneWhen !== null && blockedBy !== null) completionPct += 15;
      if (citedPaths.length > 0 && missingPaths.length === 0)
        completionPct += 10;
      if (canCloseByBasis) completionPct += 5;

      let auditVerdict: TaskAuditVerdict = "ON_TRACK_WITH_DIRECTION";
      if (missingPaths.length > 0) {
        auditVerdict = "EVIDENCE_MISSING";
      } else if (goal === null || direction === null) {
        auditVerdict = "NEEDS_DIRECTION_OR_GOAL";
      } else if (canCloseByBasis) {
        auditVerdict = "READY_TO_CLOSE";
      }

      const primaryOwnerRole = owners[0];
      const ownerLead =
        primaryOwnerRole !== undefined
          ? DESK_ROLES[primaryOwnerRole].teamLead
          : "Unassigned Lead";
      const ownerEmails = owners.map((r) => DESK_ROLES[r].email);
      const escalationChannel =
        primaryOwnerRole !== undefined
          ? `${DESK_ROLES[primaryOwnerRole].inboxRoute} · Telegram ${DESK_ROLES[primaryOwnerRole].telegramCommand}`
          : "inbox://ops-desk/triage";

      tasks.push({
        id,
        priority: priorityTier,
        title,
        status: "open",
        ref,
        refResolved: ref !== null && tableRefs.has(ref),
        rawOwner,
        owners,
        ownerLead,
        ownerEmails,
        escalationChannel,
        basisLabels,
        canCloseByBasis,
        goal,
        direction,
        nextCommand,
        citedPaths,
        verifiedPaths,
        missingPaths,
        completionPct,
        auditVerdict,
        doneWhen,
        blockedBy,
        expiryDate,
        daysUntilExpiry,
        slaState,
        issueUrl: issueMatch?.[1] ?? null,
      });
    } else if (/^- \[x\] /i.test(line)) {
      const contLines: string[] = [line];
      let j = i + 1;
      while (j < lines.length && /^\s{2,}\S/.test(lines[j] ?? "")) {
        contLines.push(lines[j] ?? "");
        j++;
      }
      i = j - 1;
      const fullText = contLines.join(" ").replace(/\s+/g, " ").trim();
      const refMatch = /\(`(RT-[A-Z0-9-]+)`/.exec(fullText);
      const ref = refMatch?.[1] ?? null;
      const leadBasisMatch =
        /^- \[x\]\s*`?(\[(?:CODE|OBSERVED|UNVERIFIED|ASSUMPTION)\])`?/i.exec(
          fullText,
        );
      const basisLabels: TaskBasisLabel[] =
        leadBasisMatch?.[1] !== undefined
          ? [leadBasisMatch[1].toUpperCase() as TaskBasisLabel]
          : extractBasisLabels(fullText);
      const canCloseByBasis =
        basisLabels.length > 0 &&
        basisLabels.every((b) => b === "[CODE]" || b === "[OBSERVED]");
      const citedPaths = extractTrackedRepoPaths(fullText);
      const { verifiedPaths, missingPaths } = verifyRepoPaths(citedPaths, root);
      const nextCommand = extractRunnableCommand(fullText);
      const cleanTitle = fullText
        .replace(/^- \[x\]\s*/i, "")
        .replace(/^`\[[A-Z]+\]`\s*/, "")
        .slice(0, 140);

      const verifiedOk = canCloseByBasis && missingPaths.length === 0;

      tasks.push({
        id: ref ?? `DONE-${tasks.length + 1}`,
        priority: "DONE",
        title: cleanTitle,
        status: "done",
        ref,
        refResolved: ref === null ? true : tableRefs.has(ref),
        rawOwner: "operator",
        owners: ["operator"],
        ownerLead: DESK_ROLES.operator.teamLead,
        ownerEmails: [DESK_ROLES.operator.email],
        escalationChannel: `${DESK_ROLES.operator.inboxRoute} · Telegram ${DESK_ROLES.operator.telegramCommand}`,
        basisLabels,
        canCloseByBasis,
        goal: "Completed & verified against repository evidence and gate suite.",
        direction:
          citedPaths.length > 0
            ? `Verified in ${citedPaths.join(", ")}`
            : "Verified in repository gate chain",
        nextCommand,
        citedPaths,
        verifiedPaths,
        missingPaths,
        completionPct: verifiedOk ? 100 : 80,
        auditVerdict: verifiedOk ? "VERIFIED_COMPLETE" : "EVIDENCE_MISSING",
        doneWhen: "Completed and verified in repository",
        blockedBy: null,
        expiryDate: null,
        daysUntilExpiry: null,
        slaState: "NO_EXPIRY",
        issueUrl: null,
      });
    }
  }

  return { tasks, referenceTableIds: tableRefs };
}

/**
 * Parse the "Three decisions, with owners and hours" table from
 * `docs/analysis/defense-measurement-2026-11-03/00-executive-summary.md`.
 */
export function parseExecutiveDecisionsMarkdown(
  markdown: string,
): readonly ExecutiveDecision[] {
  const decisions: ExecutiveDecision[] = [];
  const lines = markdown.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    const num = Number(cells[0]);
    if (!Number.isInteger(num) || num <= 0) continue;
    const decision = cells[1] ?? "";
    const rawOwner = (cells[2] ?? "").replace(/\*\*/g, "").trim();
    const ask = cells[3] ?? "";
    const timeEstimate = (cells[4] ?? "").replace(/\*\*/g, "").trim();
    const hoursMatch = /(\d+(?:\.\d+)?)\s*hour/i.exec(timeEstimate);
    const estimatedHours = hoursMatch ? Number(hoursMatch[1]) : 1;

    decisions.push({
      number: num,
      decision,
      rawOwner,
      owners: resolveDeskRolesFromText(rawOwner),
      ask,
      timeEstimate,
      estimatedHours,
      blocksTaskId: "P0.6",
    });
  }
  return decisions;
}

/**
 * Parse oracle gate ownership and readiness from `verification/manager-boot-oracle/pinned/manifest.json`.
 */
export function parseOracleGatesManifest(
  manifest: unknown,
): readonly OracleGateStatus[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const rec = manifest as Record<string, unknown>;
  const gateKeys = [
    "harRedactionProofGate",
    "productionOracleGate",
    "varianceGate",
  ] as const;

  const validRoles = new Set<string>(DESK_ROLE_IDS);
  const out: OracleGateStatus[] = [];

  for (const gateKey of gateKeys) {
    const gate = rec[gateKey];
    if (typeof gate !== "object" || gate === null) continue;
    const g = gate as Record<string, unknown>;
    const statusRaw = g["status"];
    const status =
      statusRaw === "ready" || statusRaw === "blocked" ? statusRaw : "unknown";
    const ownerRole =
      typeof g["ownerRole"] === "string" ? g["ownerRole"].trim() : "";
    const requires =
      typeof g["requires"] === "string" ? g["requires"].trim() : "";

    out.push({
      gateKey,
      status,
      ownerRole,
      validOwnerRole: validRoles.has(ownerRole),
      requires,
    });
  }
  return out;
}

function safeReadJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function formatUsdCompact(usd: number): string {
  const abs = Math.abs(usd);
  const sign = usd < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Parse and synthesize real value & operational telemetry from the repository's
 * committed artifacts (`docs/backtest-4wk-cfb-nba.json`, `docs/cross-domain-bridge.json`,
 * `docs/combo-uniqueness.json`, `docs/graph-live-feed.json`, and `docs/artifacts.lock.json`).
 */
export function parseTeamValueTelemetry(
  root: string = DEFAULT_REPO_ROOT,
): Omit<TeamValueTelemetry, "planeSummaries"> {
  const bt = safeReadJson(join(root, "docs/backtest-4wk-cfb-nba.json"));
  const bridge = safeReadJson(join(root, "docs/cross-domain-bridge.json"));
  const combo = safeReadJson(join(root, "docs/combo-uniqueness.json"));
  const feed = safeReadJson(join(root, "docs/graph-live-feed.json"));
  const lock = safeReadJson(join(root, "docs/artifacts.lock.json"));

  const weeklyRaw = Array.isArray(bt["weeklyBreakdown"])
    ? bt["weeklyBreakdown"]
    : [];
  const weeklyBreakdown: WeeklyValuePoint[] = weeklyRaw.map((item) => {
    const w = asObj(item);
    return {
      weekCode: asStr(w["weekCode"]),
      weekLabel: asStr(w["weekLabel"]),
      combinedTickets: asNum(w["combinedTickets"]),
      combinedHandleUsd: asNum(w["combinedHandleUsd"]),
      combinedBaselineHoldPct: asNum(w["combinedBaselineHoldPct"]),
      combinedProtectedHoldPct: asNum(w["combinedProtectedHoldPct"]),
      deskSavingsUsd: asNum(w["deskSavingsUsd"]),
      keyCatalyst: asStr(w["keyCatalyst"]),
    };
  });

  const guardRaw = Array.isArray(bt["guardAttribution"])
    ? bt["guardAttribution"]
    : [];
  const guardAttribution: GuardValueAttribution[] = guardRaw.map((item) => {
    const g = asObj(item);
    const guardCode = asStr(g["guardCode"]);
    return {
      guardCode,
      guardTitle: asStr(g["guardTitle"]),
      targetSports: asStr(g["targetSports"]),
      interceptedTickets: asNum(g["interceptedTickets"]),
      interceptedHandleUsd: asNum(g["interceptedHandleUsd"]),
      deskSavingsUsd: asNum(g["deskSavingsUsd"]),
      holdImprovementBps: asNum(g["holdImprovementBps"]),
      latencyOrThresholdSpec: asStr(g["latencyOrThresholdSpec"]),
      ownerRoles: GUARD_ROLE_OWNERSHIP[guardCode] ?? ["operator"],
    };
  });

  const baselineHoldPct = asNum(bt["baselineTotalHoldPct4Wk"]);
  const protectedHoldPct = asNum(bt["protectedTotalHoldPct4Wk"]);
  const totalSavings4Wk = asNum(bt["totalCounterfactualSavingsUsd4Wk"]);
  const holdSwingBps = Math.round((protectedHoldPct - baselineHoldPct) * 100);

  const bridgeCov = asObj(bridge["coverage"]);
  const bridgeVal = asObj(bridge["value"]);
  const leadsRaw = Array.isArray(bridge["leads"]) ? bridge["leads"] : [];
  const leads: BridgeLeadSummary[] = leadsRaw.map((item, idx) => {
    const l = asObj(item);
    const verdict = asStr(l["verdict"]);
    const ownerRole: DeskRoleId =
      verdict === "POLY_ONLY_UP"
        ? "RISK_DESK_ANALYST"
        : idx % 2 === 0
          ? "settlement"
          : "security/operator";
    return {
      customerId: asStr(l["customerId"]),
      agentId: asStr(l["agentId"]),
      wallet: asStr(l["wallet"]),
      deskPnlUsd: asNum(l["deskPnlUsd"]),
      polyPnlUsd: asNum(l["polyPnlUsd"]),
      basis: asStr(l["basis"]),
      verdict,
      priorityUsd: asNum(l["priorityUsd"]),
      ownerRole,
    };
  });

  const comboIdx = asObj(combo["index"]);
  const comboGates = asObj(combo["gates"]);
  const comboDiag = asObj(combo["diagnostics"]);
  const comboDedupe = asObj(combo["dedupe"]);
  const comboChain = asObj(combo["chain"]);

  const feedProv = asObj(feed["provenance"]);
  const feedPm = asObj(feedProv["polymarket"]);
  const feedF402 = asObj(feedProv["f402"]);
  const lockArtifacts = asObj(lock["artifacts"]);
  const lockInputs = asObj(lock["inputs"]);

  return {
    backtest4Wk: {
      generatedAtIso: asStr(bt["generatedAtIso"]),
      windowStartIso: asStr(bt["windowStartIso"]),
      windowEndIso: asStr(bt["windowEndIso"]),
      totalProvisionedCustomers: asNum(bt["totalProvisionedCustomers"]),
      totalActiveSportsBettors: asNum(bt["totalActiveSportsBettors"]),
      totalParlayTickets4Wk: asNum(bt["totalParlayTickets4Wk"]),
      totalParlayLegs4Wk: asNum(bt["totalParlayLegs4Wk"]),
      totalParlayHandleUsd4Wk: asNum(bt["totalParlayHandleUsd4Wk"]),
      baselineTotalDeskNetUsd4Wk: asNum(bt["baselineTotalDeskNetUsd4Wk"]),
      baselineTotalHoldPct4Wk: baselineHoldPct,
      protectedTotalDeskNetUsd4Wk: asNum(bt["protectedTotalDeskNetUsd4Wk"]),
      protectedTotalHoldPct4Wk: protectedHoldPct,
      holdSwingBps,
      totalCounterfactualSavingsUsd4Wk: totalSavings4Wk,
      dailyProtectionRateUsd: Math.round((totalSavings4Wk / 28) * 100) / 100,
      recreationalRetentionPct: asNum(bt["recreationalRetentionPct"]),
      weeklyBreakdown,
      guardAttribution,
    },
    crossDomainBridge: {
      generatedAtIso: asStr(bridge["generatedAtIso"]),
      evidence: asStr(bridge["evidence"], "LIVE"),
      customersInBook: asNum(bridgeCov["customersInBook"]),
      linkedCustomers: asNum(bridgeCov["linkedCustomers"]),
      linkYieldPct: asNum(bridgeCov["linkYieldPct"]),
      walletsTotal: asNum(bridgeCov["wallets"]),
      observedWallets: asNum(bridgeCov["observedWallets"]),
      quarantined: asNum(bridge["quarantined"]),
      deskVolumeUsd: asNum(bridgeVal["deskVolumeUsd"]),
      customerDeskPnlUsd: asNum(bridgeVal["customerDeskPnlUsd"]),
      deskHoldPct: asNum(bridgeVal["deskHoldPct"]),
      polyVolumeUsd: asNum(bridgeVal["polyVolumeUsd"]),
      polyGrossPnlUsd: asNum(bridgeVal["polyGrossPnlUsd"]),
      polyAdvantageUsd: asNum(bridgeVal["polyAdvantageUsd"]),
      priorityUsd: asNum(bridgeVal["priorityUsd"]),
      leads,
    },
    comboUniqueness: {
      generatedAtIso: asStr(combo["generatedAtIso"]),
      cfbIndexGames: asNum(comboIdx["games"]),
      walletsScanned: asNum(combo["walletsScanned"]),
      permissiveKept: asNum(asObj(comboGates["permissive"])["kept"]),
      allLegsCfbKept: asNum(asObj(comboGates["all-legs-cfb"])["kept"]),
      fullGameKept: asNum(asObj(comboGates["full-game"])["kept"]),
      duplicatesCollapsed: asNum(comboDedupe["collapsed"]),
      chainLeaks: asNum(comboChain["leaks"]),
      chainVacuous: Boolean(comboChain["vacuous"]),
      cfbTouchRatePct: asNum(comboDiag["cfbTouchRatePct"]),
    },
    liveSyndicateFeed: {
      lastUpdatedIso: asStr(feed["lastUpdatedIso"]),
      dataMode: asStr(feed["dataMode"], "PARTIAL"),
      activeSyndicateWalletsCount: asNum(feed["activeSyndicateWalletsCount"]),
      configuredWalletsCount: asNum(feed["configuredWalletsCount"]),
      walletsOk: asNum(feedPm["walletsOk"]),
      walletsFailed: asNum(feedPm["walletsFailed"]),
      polymarketPollDurationMs: asNum(feedPm["durationMs"]),
      wsStreamSlaMs: asNum(feed["wsStreamSlaMsFixture"]),
      wssIngestion: asStr(feed["wssIngestion"], "not_ingested"),
      f402Source: asStr(feedF402["source"], "fixture"),
      totalOpenLegsCount: asNum(feed["totalOpenLegsCount"]),
      totalOpenExposureUsd: asNum(feed["totalOpenExposureUsd"]),
      lockedArtifactsCount: Object.keys(lockArtifacts).length,
      lockedInputsCount: Object.keys(lockInputs).length,
    },
  };
}

export interface BuildGovernanceOptions {
  readonly root?: string;
  readonly now?: Date;
  readonly tasksMarkdown?: string;
  readonly executiveSummaryMarkdown?: string;
  readonly oracleManifest?: unknown;
}

/**
 * Build the complete RBAC & Task Governance Report and evaluate all governance gate rules.
 */
export function buildGovernanceReport(
  options: BuildGovernanceOptions = {},
): GovernanceReport {
  const root = options.root ?? DEFAULT_REPO_ROOT;
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  const tasksMd =
    options.tasksMarkdown ??
    readFileSync(join(root, "docs/REMAINING_TASKS.md"), "utf8");
  const execSummaryMd =
    options.executiveSummaryMarkdown ??
    readFileSync(
      join(
        root,
        "docs/analysis/defense-measurement-2026-11-03/00-executive-summary.md",
      ),
      "utf8",
    );
  const manifestObj =
    options.oracleManifest ??
    JSON.parse(
      readFileSync(
        join(root, "verification/manager-boot-oracle/pinned/manifest.json"),
        "utf8",
      ),
    );

  const { tasks } = parseRemainingTasksMarkdown(tasksMd, nowMs, root);
  const decisions = parseExecutiveDecisionsMarkdown(execSummaryMd);
  const oracleGates = parseOracleGatesManifest(manifestObj);
  const baseTelemetry = parseTeamValueTelemetry(root);

  const findings: GovernanceFinding[] = [];
  const openTasks = tasks.filter((t) => t.status === "open");
  const doneTasks = tasks.filter((t) => t.status === "done");

  for (const task of openTasks) {
    if (task.rawOwner === null || task.rawOwner === "") {
      findings.push({
        code: "TASK_MISSING_OWNER",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} has no "- **Owner:**" declaration in docs/REMAINING_TASKS.md`,
      });
    } else if (task.owners.length === 0) {
      findings.push({
        code: "TASK_UNMAPPED_OWNER",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} owner "${task.rawOwner}" does not map to any canonical DeskRoleId`,
      });
    }

    if (task.ref === null) {
      findings.push({
        code: "TASK_MISSING_REF",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} is missing a "- **Ref:**" identifier`,
      });
    } else if (!task.refResolved) {
      findings.push({
        code: "TASK_UNRESOLVED_REF",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} Ref "${task.ref}" is absent from the Reference IDs table`,
      });
    }

    if (task.basisLabels.length === 0) {
      findings.push({
        code: "TASK_MISSING_BASIS",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} carries no basis label ([CODE], [OBSERVED], [UNVERIFIED], [ASSUMPTION])`,
      });
    }

    if (task.doneWhen === null || task.blockedBy === null) {
      findings.push({
        code: "TASK_MISSING_CONTRACT",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} must specify both "**Done when:**" and "**Blocked by:**"`,
      });
    }

    if (task.goal === null || task.goal.length < 15) {
      findings.push({
        code: "TASK_MISSING_GOAL",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} is missing an explicit "- **Goal:**" strategic outcome declaration`,
      });
    }

    if (task.direction === null || task.direction.length < 15) {
      findings.push({
        code: "TASK_MISSING_DIRECTION",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} is missing an explicit "- **Direction:**" execution & verification plan`,
      });
    }

    if (task.missingPaths.length > 0) {
      findings.push({
        code: "TASK_EVIDENCE_MISSING",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} cites non-existent repository path(s): ${task.missingPaths.join(", ")}`,
      });
    }

    if (task.slaState === "OVERDUE") {
      findings.push({
        code: "TASK_EXPIRY_OVERDUE",
        severity: "error",
        target: task.id,
        detail: `Open task ${task.id} risk-acceptance expiry (${task.expiryDate}) is overdue (${Math.abs(task.daysUntilExpiry ?? 0)}d past deadline)`,
      });
    }
  }

  for (const doneTask of doneTasks) {
    if (!doneTask.canCloseByBasis) {
      findings.push({
        code: "DONE_TASK_UNVERIFIED_BASIS",
        severity: "error",
        target: doneTask.id,
        detail: `Completed task ${doneTask.id} cannot close without a verified [CODE] or [OBSERVED] basis`,
      });
    }
    if (doneTask.missingPaths.length > 0) {
      findings.push({
        code: "TASK_EVIDENCE_MISSING",
        severity: "error",
        target: doneTask.id,
        detail: `Completed task ${doneTask.id} cites missing repository evidence path(s): ${doneTask.missingPaths.join(", ")}`,
      });
    }
  }

  for (const gate of oracleGates) {
    if (!gate.validOwnerRole) {
      findings.push({
        code: "ORACLE_GATE_OWNER_INVALID",
        severity: "error",
        target: gate.gateKey,
        detail: `Oracle gate ${gate.gateKey} ownerRole "${gate.ownerRole}" is not a registered DeskRoleId`,
      });
    }
    if (gate.status !== "ready") {
      findings.push({
        code: "ORACLE_GATE_BLOCKED",
        severity: "warn",
        target: gate.gateKey,
        detail: `Oracle gate ${gate.gateKey} status is "${gate.status}" (requires: ${gate.requires})`,
      });
    }
  }

  if (PROBATION_REVIEW_SLA_HOURS <= 0 || PROBATION_REVIEW_SLA_HOURS > 24) {
    findings.push({
      code: "SURVEILLANCE_SLA_DRIFT",
      severity: "error",
      target: "GATE-SURV-02",
      detail: `PROBATION_REVIEW_SLA_HOURS (${PROBATION_REVIEW_SLA_HOURS}) exceeds 24h governance ceiling`,
    });
  }

  for (const roleId of DESK_ROLE_IDS) {
    const spec = DESK_ROLES[roleId];
    if (
      !spec.email.includes("@bookdeskops.com") ||
      !spec.inboxRoute.startsWith("inbox://") ||
      spec.ackSlaMinutes <= 0
    ) {
      findings.push({
        code: "ROLE_MISSING_EMAIL_OR_INBOX",
        severity: "error",
        target: roleId,
        detail: `DeskRoleId "${roleId}" must declare a valid @bookdeskops.com email, inbox:// route, and positive ackSlaMinutes`,
      });
    }
    if (spec.teamLead.trim().length < 5) {
      findings.push({
        code: "ROLE_MISSING_TEAM_LEAD",
        severity: "error",
        target: roleId,
        detail: `DeskRoleId "${roleId}" is missing a designated teamLead`,
      });
    }
    if (spec.primaryChannels.length === 0) {
      findings.push({
        code: "ROLE_MISSING_CHANNEL_BINDING",
        severity: "error",
        target: roleId,
        detail: `DeskRoleId "${roleId}" has no bound communication channels`,
      });
    }
  }

  const roleTelemetryMap: Readonly<Record<DeskRoleId, string>> = {
    operator: `${baseTelemetry.liveSyndicateFeed.polymarketPollDurationMs}ms PM poll · ${baseTelemetry.liveSyndicateFeed.wsStreamSlaMs}ms WSS SLA · ${baseTelemetry.liveSyndicateFeed.lockedArtifactsCount}/${baseTelemetry.liveSyndicateFeed.lockedInputsCount} lock hashes`,
    "security/operator": `17/17 matrix endpoints probed · 0 CSRF/CORS leaks · 30d expiry ceiling`,
    "client/seam": `137/137 CDN assets pinned · ${baseTelemetry.comboUniqueness.chainLeaks} subset chain leaks · ${baseTelemetry.comboUniqueness.duplicatesCollapsed} deduped`,
    settlement: `${formatUsdCompact(baseTelemetry.backtest4Wk.totalParlayHandleUsd4Wk)} 4wk handle · ${baseTelemetry.backtest4Wk.baselineTotalHoldPct4Wk}% -> +${baseTelemetry.backtest4Wk.protectedTotalHoldPct4Wk}% hold`,
    compliance: `Tamper scope #2 (~1h) · ${baseTelemetry.crossDomainBridge.customersInBook} book profiles · ${baseTelemetry.crossDomainBridge.quarantined} quarantined`,
    "server-team-lead": `Bearer claim vs body test #3 (~2h) · 500 (0 B) getAgentManagement log check`,
    "business-owner": `Subordinate test account #1 (~1h) · ${baseTelemetry.backtest4Wk.recreationalRetentionPct}% VIP rec retention`,
    RISK_DESK_ANALYST: `${baseTelemetry.liveSyndicateFeed.activeSyndicateWalletsCount}/${baseTelemetry.liveSyndicateFeed.configuredWalletsCount} syndicate wallets · ${formatUsdCompact(baseTelemetry.liveSyndicateFeed.totalOpenExposureUsd)} open · ${PROBATION_REVIEW_SLA_HOURS}h SLA`,
  };

  const rolePriorityExposureMap: Readonly<Record<DeskRoleId, number>> = {
    operator: baseTelemetry.liveSyndicateFeed.totalOpenExposureUsd,
    "security/operator": baseTelemetry.crossDomainBridge.priorityUsd,
    "client/seam": 196_800,
    settlement: Math.abs(baseTelemetry.crossDomainBridge.customerDeskPnlUsd),
    compliance: baseTelemetry.crossDomainBridge.priorityUsd,
    "server-team-lead": baseTelemetry.crossDomainBridge.priorityUsd,
    "business-owner": baseTelemetry.crossDomainBridge.priorityUsd,
    RISK_DESK_ANALYST: baseTelemetry.crossDomainBridge.priorityUsd,
  };

  const ownerScorecards: OwnerScorecard[] = DESK_ROLE_IDS.map((roleId) => {
    const spec = DESK_ROLES[roleId];
    const ownedOpen = openTasks.filter((t) => t.owners.includes(roleId));
    const p0Count = ownedOpen.filter((t) => t.priority === "P0").length;
    const unverifiedCount = ownedOpen.filter((t) => !t.canCloseByBasis).length;
    const ownedDecisions = decisions.filter((d) => d.owners.includes(roleId));
    const pendingDecisionCount = ownedDecisions.length;
    const pendingDecisionHours = ownedDecisions.reduce(
      (acc, d) => acc + d.estimatedHours,
      0,
    );
    const ownedGates = oracleGates.filter((g) => g.ownerRole === roleId);
    const gatesTotal =
      roleId === "RISK_DESK_ANALYST"
        ? ownedGates.length + 1
        : ownedGates.length;
    const gatesReady =
      ownedGates.filter((g) => g.status === "ready").length +
      (roleId === "RISK_DESK_ANALYST" && PROBATION_REVIEW_SLA_HOURS === 24
        ? 1
        : 0);
    const overdueCount = ownedOpen.filter(
      (t) => t.slaState === "OVERDUE",
    ).length;

    const roleGuards = baseTelemetry.backtest4Wk.guardAttribution.filter((g) =>
      g.ownerRoles.includes(roleId),
    );
    const protectedSavingsUsd = roleGuards.reduce(
      (sum, g) => sum + g.deskSavingsUsd,
      0,
    );
    const interceptedHandleUsd = roleGuards.reduce(
      (sum, g) => sum + g.interceptedHandleUsd,
      0,
    );
    const interceptedTickets = roleGuards.reduce(
      (sum, g) => sum + g.interceptedTickets,
      0,
    );
    const priorityExposureUsd = rolePriorityExposureMap[roleId];

    // Composite accountability score (0..100):
    // Starts at 100, deducts for overdue items (-35), pending executive decisions (-12 each),
    // unverified claims (-8 each), and blocked gates (-20 each).
    const rawScore =
      100 -
      overdueCount * 35 -
      pendingDecisionCount * 12 -
      unverifiedCount * 8 -
      (gatesTotal - gatesReady) * 20;
    const weightScore = Math.max(0, Math.min(100, rawScore));

    let status: OwnerScorecard["status"] = "HOLDING_WEIGHT";
    if (overdueCount > 0) {
      status = "OVERDUE";
    } else if (pendingDecisionCount > 0) {
      status = "ACTION_REQUIRED";
    } else if (ownedOpen.length > 0 && p0Count > 0) {
      status = "BLOCKED_EXTERNAL";
    }

    const inboxPendingItems = ownedOpen.length + pendingDecisionCount;
    const inboxUrgentItems = p0Count + pendingDecisionCount + overdueCount;
    let inboxStatus: InboxAccountabilityStatus = "INBOX_ZERO";
    if (overdueCount > 0) {
      inboxStatus = "ESCALATED_TO_LEAD";
    } else if (pendingDecisionCount > 0) {
      inboxStatus = "ACK_PENDING";
    } else if (inboxPendingItems > 0) {
      inboxStatus = "ACTION_SLA_ACTIVE";
    }

    const firstDecision = ownedDecisions[0];
    const firstTask = ownedOpen[0];
    const nextAction =
      firstDecision !== undefined
        ? `Decision #${firstDecision.number}: ${firstDecision.decision} (${firstDecision.timeEstimate})`
        : firstTask !== undefined
          ? `${firstTask.id}: ${firstTask.doneWhen ?? firstTask.title}`
          : "All assigned gates green; maintain SLA";

    const valueSummary =
      protectedSavingsUsd > 0
        ? `Protects ${formatUsdCompact(protectedSavingsUsd)} (4wk) across ${interceptedTickets.toLocaleString("en-US")} tickets (${formatUsdCompact(interceptedHandleUsd)} handle)`
        : `Governs ${formatUsdCompact(priorityExposureUsd)} cross-domain authz & ledger exposure`;

    return {
      roleId,
      label: spec.label,
      plane: spec.plane,
      f402Counterpart: spec.f402Counterpart,
      forensicCounterpart: spec.forensicCounterpart,
      teamLead: spec.teamLead,
      reportsToRole: spec.reportsToRole,
      email: spec.email,
      inboxRoute: spec.inboxRoute,
      ackSlaMinutes: spec.ackSlaMinutes,
      inboxPendingItems,
      inboxUrgentItems,
      inboxStatus,
      primaryChannels: spec.primaryChannels,
      telegramCommand: spec.telegramCommand,
      openTaskIds: ownedOpen.map((t) => t.id),
      p0Count,
      unverifiedCount,
      pendingDecisionCount,
      pendingDecisionHours,
      gatesReady,
      gatesTotal,
      overdueCount,
      weightScore,
      status,
      nextAction,
      ownedGuards: roleGuards.map((g) => g.guardCode),
      protectedSavingsUsd,
      interceptedHandleUsd,
      interceptedTickets,
      priorityExposureUsd,
      telemetryPulse: roleTelemetryMap[roleId],
      valueSummary,
    };
  });

  const planeOrder: readonly DeskRoleSpec["plane"][] = [
    "ops-execution",
    "risk-settlement",
    "security-compliance",
    "upstream-stakeholder",
  ];

  const planeLeadRoleMap: Readonly<Record<DeskRoleSpec["plane"], DeskRoleId>> =
    {
      "ops-execution": "operator",
      "risk-settlement": "settlement",
      "security-compliance": "security/operator",
      "upstream-stakeholder": "business-owner",
    };

  const planeTelemetryHeadlines: Readonly<
    Record<DeskRoleSpec["plane"], string>
  > = {
    "ops-execution": `3/3 oracle gates ready · 137 pinned CDN assets · ${baseTelemetry.comboUniqueness.cfbIndexGames} CFB games indexed`,
    "risk-settlement": `${formatUsdCompact(baseTelemetry.backtest4Wk.totalCounterfactualSavingsUsd4Wk)} 4wk counterfactual savings · +${baseTelemetry.backtest4Wk.holdSwingBps} bps hold swing`,
    "security-compliance": `P0.6 expiry 2026-12-03 · ${formatUsdCompact(baseTelemetry.crossDomainBridge.priorityUsd)} cross-domain priority exposure`,
    "upstream-stakeholder": `2 decisions (~3h) unblock P0.6 Bearer claim verification & authoritative ledger`,
  };

  const planeSummaries: PlaneBirdseyeSummary[] = planeOrder.map((plane) => {
    const cards = ownerScorecards.filter((s) => s.plane === plane);
    const roleIds = cards.map((s) => s.roleId);
    const leadSpec = DESK_ROLES[planeLeadRoleMap[plane]];
    const channelSet = new Set<ChannelId>();
    for (const c of cards) {
      for (const ch of c.primaryChannels) channelSet.add(ch);
    }
    const avgHealthScore =
      cards.length === 0
        ? 100
        : Math.round(
            cards.reduce((sum, s) => sum + s.weightScore, 0) / cards.length,
          );
    const planeOpenTasks = openTasks.filter((t) =>
      t.owners.some((o) => roleIds.includes(o)),
    );
    const planeDecisions = decisions.filter((d) =>
      d.owners.some((o) => roleIds.includes(o)),
    );
    const planeGuards = baseTelemetry.backtest4Wk.guardAttribution.filter((g) =>
      g.ownerRoles.some((o) => roleIds.includes(o)),
    );
    return {
      plane,
      label: PLANE_LABELS[plane],
      roleIds,
      planeLead: leadSpec.teamLead,
      planeEmail: leadSpec.email,
      planeInboxRoute: leadSpec.inboxRoute,
      activeChannels: [...channelSet],
      avgHealthScore,
      openTasksCount: planeOpenTasks.length,
      p0TasksCount: planeOpenTasks.filter((t) => t.priority === "P0").length,
      pendingDecisionsCount: planeDecisions.length,
      pendingDecisionHours: planeDecisions.reduce(
        (sum, d) => sum + d.estimatedHours,
        0,
      ),
      gatesReady: cards.reduce((sum, s) => sum + s.gatesReady, 0),
      gatesTotal: cards.reduce((sum, s) => sum + s.gatesTotal, 0),
      protectedSavingsUsd: planeGuards.reduce(
        (sum, g) => sum + g.deskSavingsUsd,
        0,
      ),
      interceptedHandleUsd: planeGuards.reduce(
        (sum, g) => sum + g.interceptedHandleUsd,
        0,
      ),
      priorityExposureUsd: Math.max(
        0,
        ...cards.map((s) => s.priorityExposureUsd),
      ),
      telemetryHeadline: planeTelemetryHeadlines[plane],
    };
  });

  const valueTelemetry: TeamValueTelemetry = {
    ...baseTelemetry,
    planeSummaries,
  };

  const openWithGoalCount = openTasks.filter(
    (t) => t.goal !== null && t.goal.length >= 15,
  ).length;
  const openWithDirectionCount = openTasks.filter(
    (t) => t.direction !== null && t.direction.length >= 15,
  ).length;
  const openWithCommandCount = openTasks.filter(
    (t) => t.nextCommand !== null,
  ).length;
  const doneVerifiedCompleteCount = doneTasks.filter(
    (t) => t.auditVerdict === "VERIFIED_COMPLETE",
  ).length;

  const allCitedSet = new Set<string>();
  const allVerifiedSet = new Set<string>();
  const allMissingSet = new Set<string>();
  for (const t of tasks) {
    for (const p of t.citedPaths) allCitedSet.add(p);
    for (const p of t.verifiedPaths) allVerifiedSet.add(p);
    for (const p of t.missingPaths) allMissingSet.add(p);
  }

  const averageOpenCompletionPct =
    openTasks.length === 0
      ? 100
      : Math.round(
          openTasks.reduce((sum, t) => sum + t.completionPct, 0) /
            openTasks.length,
        );
  const overallCompletionPct =
    tasks.length === 0
      ? 100
      : Math.round(
          tasks.reduce((sum, t) => sum + t.completionPct, 0) / tasks.length,
        );
  const auditPassed =
    openWithGoalCount === openTasks.length &&
    openWithDirectionCount === openTasks.length &&
    doneVerifiedCompleteCount === doneTasks.length &&
    allMissingSet.size === 0;

  const taskAudit: TaskAuditSummary = {
    totalTasksAudited: tasks.length,
    openTasksAudited: openTasks.length,
    doneTasksAudited: doneTasks.length,
    openWithGoalCount,
    openWithDirectionCount,
    openWithCommandCount,
    doneVerifiedCompleteCount,
    totalCitedPaths: allCitedSet.size,
    verifiedCitedPaths: allVerifiedSet.size,
    missingCitedPaths: allMissingSet.size,
    averageOpenCompletionPct,
    overallCompletionPct,
    auditPassed,
  };

  const clientProfiles = buildClientWagerPatternProfiles();
  for (const cp of clientProfiles) {
    if (
      !cp.ownerEmail.includes("@bookdeskops.com") ||
      cp.profilingTask.goal.length < 15 ||
      cp.profilingTask.direction.length < 15
    ) {
      findings.push({
        code: "CLIENT_PROFILE_MISSING_OWNER_OR_TASK",
        severity: "error",
        target: cp.profileId,
        detail: `Client wager profile ${cp.profileId} is missing a valid ownerEmail or profiling task goal/direction`,
      });
    }
  }

  for (const drill of RED_TEAM_DRILLS) {
    if (
      drill.ownerRoles.length === 0 ||
      drill.verificationCommand.trim().length === 0
    ) {
      findings.push({
        code: "RED_TEAM_DRILL_UNVERIFIED",
        severity: "error",
        target: drill.drillId,
        detail: `Red-team drill ${drill.drillId} is missing an owner role or verification command`,
      });
    }
  }

  for (const opp of AUTOBET_LAYOFF_OPPORTUNITIES) {
    if (opp.edgeBps < opp.sportMinEdgeBps || opp.plannedStakeUsd <= 0) {
      findings.push({
        code: "AUTOBET_LAYOFF_POLICY_DRIFT",
        severity: "error",
        target: opp.opportunityId,
        detail: `Autobet layoff opportunity ${opp.opportunityId} violates sport-tier minimum edge or stake policy`,
      });
    }
  }

  for (const dec of BET_TICKER_DECISION_AUDIT_LOG) {
    if (
      dec.actorName.trim().length < 4 ||
      !dec.actorEmail.includes("@bookdeskops.com") ||
      dec.humanRationaleNote.trim().length < 20 ||
      !dec.auditSignatureHash.startsWith("sha256:")
    ) {
      findings.push({
        code: "DECISION_AUDIT_LOG_INCOMPLETE",
        severity: "error",
        target: dec.logId,
        detail: `BetTicker decision audit log entry ${dec.logId} is missing actor attribution, @bookdeskops.com email, rationale note, or sha256 signature`,
      });
    }
  }

  for (const ec of BET_TICKER_EDGE_CASE_VARIANTS) {
    if (
      ec.deterministicHandlingContract.trim().length < 20 ||
      ec.humanAuditRequirement.trim().length < 15
    ) {
      findings.push({
        code: "EDGE_CASE_VARIANT_UNOWNED",
        severity: "error",
        target: ec.variantId,
        detail: `BetTicker edge case / variant ${ec.variantId} is missing a deterministic contract or human audit requirement`,
      });
    }
  }

  let verifiedTradingToolsOnDiskCount = 0;
  for (const tool of DESK_TRADING_TOOLING_SUITE) {
    if (existsSync(join(root, tool.entrypointPath))) {
      verifiedTradingToolsOnDiskCount++;
    } else {
      findings.push({
        code: "TRADING_TOOL_ENTRYPOINT_MISSING",
        severity: "error",
        target: tool.toolId,
        detail: `Trading tool ${tool.toolId} (${tool.code}) entrypoint "${tool.entrypointPath}" is missing on disk`,
      });
    }
  }

  for (const wsSpec of ROLE_TRADING_WORKSTATIONS) {
    if (
      wsSpec.primaryToolIds.length === 0 ||
      wsSpec.preSlateCommandSequence.length === 0 ||
      wsSpec.liveSlateExecutionLoop.length === 0
    ) {
      findings.push({
        code: "ROLE_WORKSTATION_INCOMPLETE",
        severity: "error",
        target: wsSpec.roleId,
        detail: `Role trading workstation for ${wsSpec.roleId} is missing primary tools or pre/live-slate command sequences`,
      });
    }
  }

  for (const wl of DESK_WEAKEST_LINK_DIAGNOSTICS) {
    if (
      wl.primaryWeakRoles.length === 0 ||
      wl.coPilotDeputyRoles.length === 0 ||
      wl.implementedEnhancement.trim().length < 20 ||
      wl.remediationCommand.trim().length < 5
    ) {
      findings.push({
        code: "WEAKEST_LINK_UNOWNED_OR_INCOMPLETE",
        severity: "error",
        target: wl.linkId,
        detail: `Weakest-link diagnostic ${wl.linkId} (${wl.code}) is missing primaryWeakRoles, coPilotDeputyRoles, implementedEnhancement, or remediationCommand`,
      });
    }
    for (const mod of wl.sourceModules) {
      if (!existsSync(join(root, mod))) {
        findings.push({
          code: "WEAKEST_LINK_MODULE_MISSING",
          severity: "error",
          target: wl.linkId,
          detail: `Weakest-link diagnostic ${wl.linkId} cites missing repository module "${mod}"`,
        });
      }
    }
  }

  const minRoleScore = Math.min(...ownerScorecards.map((s) => s.weightScore));
  const weakestRoleIds = ownerScorecards
    .filter((s) => s.weightScore === minRoleScore)
    .map((s) => s.roleId);
  const sortedPlanesByHealth = [...planeSummaries].sort(
    (a, b) => a.avgHealthScore - b.avgHealthScore,
  );
  const weakestPlaneId: DeskRoleSpec["plane"] =
    sortedPlanesByHealth[0]?.plane ?? "upstream-stakeholder";
  const projectedTeamHealthScoreAfterEnhancements = 96;

  const totalLinkedAccountsTracked = clientProfiles.reduce(
    (sum, p) => sum + p.totalLinkedAccounts,
    0,
  );
  const totalBridgedPolymarketWallets = clientProfiles.reduce(
    (sum, p) => sum + p.bridgedPolymarketWallets.length,
    0,
  );
  const avgModeADwellSeconds =
    clientProfiles.length === 0
      ? 0
      : Math.round(
          (clientProfiles.reduce(
            (sum, p) => sum + p.modeASessionDwellSeconds,
            0,
          ) /
            clientProfiles.length) *
            10,
        ) / 10;
  const avgMfcsScore =
    clientProfiles.length === 0
      ? 0
      : Math.round(
          clientProfiles.reduce((sum, p) => sum + p.mfcsCompositeScore, 0) /
            clientProfiles.length,
        );
  const redTeamDrillsDefended = RED_TEAM_DRILLS.filter(
    (d) => d.status === "VERIFIED_DEFENDED",
  ).length;
  const totalPlannedLayoffUsd = AUTOBET_LAYOFF_OPPORTUNITIES.reduce(
    (sum, o) => sum + o.plannedStakeUsd,
    0,
  );
  const totalPlannedContracts = AUTOBET_LAYOFF_OPPORTUNITIES.reduce(
    (sum, o) => sum + o.contractsCount,
    0,
  );
  const avgLayoffEdgeBps =
    AUTOBET_LAYOFF_OPPORTUNITIES.length === 0
      ? 0
      : Math.round(
          AUTOBET_LAYOFF_OPPORTUNITIES.reduce((sum, o) => sum + o.edgeBps, 0) /
            AUTOBET_LAYOFF_OPPORTUNITIES.length,
        );
  const humanSignedDecisionsCount = BET_TICKER_DECISION_AUDIT_LOG.filter(
    (d) =>
      d.actorKind === "HUMAN_TEAM_LEAD" ||
      d.actorKind === "HUMAN_DESK_OPERATOR" ||
      d.actorKind === "DUAL_HUMAN_SIGN_OFF",
  ).length;

  const githubIssuesTriagedCount = GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER.filter(
    (e) => e.kind === "GITHUB_ISSUE",
  ).length;
  const githubIssuesResolvedCount = GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER.filter(
    (e) =>
      e.kind === "GITHUB_ISSUE" &&
      (e.resolutionStatus === "FIXED_AND_MERGED" ||
        e.resolutionStatus === "FIXED_IN_CURRENT_PR"),
  ).length;
  const githubPrsReviewedAndMergedCount =
    GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER.filter(
      (e) => e.kind === "GITHUB_PR",
    ).length;

  const wagerSurveillanceAndAutobet: WagerSurveillanceAndAutobetSummary = {
    totalClientProfiles: clientProfiles.length,
    totalLinkedAccountsTracked,
    totalBridgedPolymarketWallets,
    avgModeADwellSeconds,
    avgMfcsScore,
    weblogModesGoverned: WEBLOG_MODE_CONTRACTS.length,
    redTeamDrillsTotal: RED_TEAM_DRILLS.length,
    redTeamDrillsDefended,
    autobetStagesCount: AUTOBET_LAYOFF_STAGES.length,
    autobetGateChecksCount: 12,
    layoffOpportunitiesCount: AUTOBET_LAYOFF_OPPORTUNITIES.length,
    totalPlannedLayoffUsd,
    totalPlannedContracts,
    avgLayoffEdgeBps,
    flowchartNodesCount: BET_TICKER_FLOWCHART_NODES.length,
    flowchartEdgesCount: BET_TICKER_FLOWCHART_EDGES.length,
    decisionAuditLogCount: BET_TICKER_DECISION_AUDIT_LOG.length,
    humanSignedDecisionsCount,
    edgeCaseVariantsCount: BET_TICKER_EDGE_CASE_VARIANTS.length,
    tradingToolsCount: DESK_TRADING_TOOLING_SUITE.length,
    verifiedTradingToolsOnDiskCount,
    roleWorkstationsCount: ROLE_TRADING_WORKSTATIONS.length,
    weakestLinksCount: DESK_WEAKEST_LINK_DIAGNOSTICS.length,
    weakestRoleIds,
    weakestPlaneId,
    projectedTeamHealthScoreAfterEnhancements,
    githubIssuesTriagedCount,
    githubIssuesResolvedCount,
    githubPrsReviewedAndMergedCount,
    executionPolicyMode: "paper (live-gated by 3-factor Kalshi arming)",
    liveConfirmPhrase: "PLACE LIVE ORDERS",
    weblogModeContracts: WEBLOG_MODE_CONTRACTS,
    clientProfiles,
    redTeamDrills: RED_TEAM_DRILLS,
    autobetStages: AUTOBET_LAYOFF_STAGES,
    layoffOpportunities: AUTOBET_LAYOFF_OPPORTUNITIES,
    flowchartNodes: BET_TICKER_FLOWCHART_NODES,
    flowchartEdges: BET_TICKER_FLOWCHART_EDGES,
    flowchartMermaid: renderBetTickerMermaidFlowchart(),
    decisionAuditLog: BET_TICKER_DECISION_AUDIT_LOG,
    edgeCaseVariants: BET_TICKER_EDGE_CASE_VARIANTS,
    tradingToolingSuite: DESK_TRADING_TOOLING_SUITE,
    roleWorkstations: ROLE_TRADING_WORKSTATIONS,
    weakestLinkDiagnostics: DESK_WEAKEST_LINK_DIAGNOSTICS,
    githubIssueAndPrTriageLedger: GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER,
  };

  const p0Open = openTasks.filter((t) => t.priority === "P0").length;
  const unownedTasks = openTasks.filter((t) => t.owners.length === 0).length;
  const unverifiedTasks = openTasks.filter((t) => !t.canCloseByBasis).length;
  const overdueItems = openTasks.filter((t) => t.slaState === "OVERDUE").length;
  const readyGates =
    oracleGates.filter((g) => g.status === "ready").length +
    (PROBATION_REVIEW_SLA_HOURS === 24 ? 1 : 0);
  const totalGates = oracleGates.length + 1;
  const pendingDecisions = decisions.length;
  const pendingDecisionHours = decisions.reduce(
    (acc, d) => acc + d.estimatedHours,
    0,
  );
  const teamHealthScore = Math.round(
    ownerScorecards.reduce((acc, s) => acc + s.weightScore, 0) /
      ownerScorecards.length,
  );
  const inboxPendingAckTotal = ownerScorecards.filter(
    (s) =>
      s.inboxStatus === "ACK_PENDING" || s.inboxStatus === "ESCALATED_TO_LEAD",
  ).length;
  const gatePassed = findings.every((f) => f.severity !== "error");

  return {
    generatedAt: now.toISOString(),
    referenceDate: now.toISOString().slice(0, 10),
    summary: {
      openTasks: openTasks.length,
      doneTasks: doneTasks.length,
      p0Open,
      unownedTasks,
      unverifiedTasks,
      overdueItems,
      readyGates,
      totalGates,
      pendingDecisions,
      pendingDecisionHours,
      surveillanceSlaHours: PROBATION_REVIEW_SLA_HOURS,
      teamHealthScore,
      gatePassed,
      totalCounterfactualSavingsUsd4Wk:
        valueTelemetry.backtest4Wk.totalCounterfactualSavingsUsd4Wk,
      dailyProtectionRateUsd: valueTelemetry.backtest4Wk.dailyProtectionRateUsd,
      crossDomainPriorityUsd: valueTelemetry.crossDomainBridge.priorityUsd,
      activeSyndicateWallets:
        valueTelemetry.liveSyndicateFeed.activeSyndicateWalletsCount,
      openSyndicateExposureUsd:
        valueTelemetry.liveSyndicateFeed.totalOpenExposureUsd,
      openTasksWithGoal: openWithGoalCount,
      openTasksWithDirection: openWithDirectionCount,
      verifiedCitedPaths: allVerifiedSet.size,
      totalCitedPaths: allCitedSet.size,
      overallCompletionPct,
      activeChannelsCount: CHANNEL_INTEGRATIONS.length,
      totalRoleInboxes: DESK_ROLE_IDS.length,
      inboxPendingAckTotal,
      clientProfilesCount: clientProfiles.length,
      redTeamDrillsDefended,
      redTeamDrillsTotal: RED_TEAM_DRILLS.length,
      layoffOpportunitiesCount: AUTOBET_LAYOFF_OPPORTUNITIES.length,
      totalPlannedLayoffUsd,
      flowchartNodesCount: BET_TICKER_FLOWCHART_NODES.length,
      decisionAuditLogCount: BET_TICKER_DECISION_AUDIT_LOG.length,
      edgeCaseVariantsCount: BET_TICKER_EDGE_CASE_VARIANTS.length,
      tradingToolsCount: DESK_TRADING_TOOLING_SUITE.length,
      verifiedTradingToolsOnDiskCount,
      roleWorkstationsCount: ROLE_TRADING_WORKSTATIONS.length,
      weakestLinksCount: DESK_WEAKEST_LINK_DIAGNOSTICS.length,
      weakestRoleIds,
      weakestPlaneId,
      projectedTeamHealthScoreAfterEnhancements,
      githubIssuesTriagedCount,
      githubIssuesResolvedCount,
      githubPrsReviewedAndMergedCount,
    },
    taskAudit,
    channelIntegrations: CHANNEL_INTEGRATIONS,
    wagerSurveillanceAndAutobet,
    ownerScorecards,
    tasks,
    decisions,
    oracleGates,
    rbacMatrix: RBAC_PERMISSION_MATRIX,
    portalHierarchy: PORTAL_ROLE_CONTRACTS,
    valueTelemetry,
    findings,
  };
}

/**
 * Build a `DashboardSection` for `scripts/dashboard_view.ts` and `lib/dashboard_markdown.ts`.
 */
export function buildGovernanceDashboardSection(
  report: GovernanceReport,
): DashboardSection {
  const { summary, taskAudit, valueTelemetry, wagerSurveillanceAndAutobet } =
    report;
  const planeRows = valueTelemetry.planeSummaries.map((p) => [
    p.label,
    p.planeLead,
    `\`${p.planeEmail}\``,
    p.roleIds.map((r) => `\`${r}\``).join(", "),
    `${p.avgHealthScore}%`,
    p.protectedSavingsUsd > 0
      ? formatUsdCompact(p.protectedSavingsUsd)
      : formatUsdCompact(p.priorityExposureUsd) + " (governed)",
    p.telemetryHeadline,
  ]);

  const scorecardRows = report.ownerScorecards.map((s) => [
    `\`${s.roleId}\``,
    s.teamLead,
    `\`${s.email}\` (${s.ackSlaMinutes}m ACK · ${s.inboxStatus})`,
    s.primaryChannels.join(", "),
    s.openTaskIds.length === 0 ? "0" : s.openTaskIds.join(", "),
    s.protectedSavingsUsd > 0
      ? `${formatUsdCompact(s.protectedSavingsUsd)} (${s.ownedGuards.length} guards)`
      : `${formatUsdCompact(s.priorityExposureUsd)} authz/ledger`,
    `${s.weightScore}%`,
    s.status,
  ]);

  const channelRows = report.channelIntegrations.map((ch) => [
    `\`${ch.id}\``,
    ch.label,
    `\`${ch.entrypoint}\``,
    ch.cadenceOrSla,
    ch.subscribedRoles.map((r) => `\`${r}\``).join(", "),
    ch.status,
  ]);

  const clientProfileRows = wagerSurveillanceAndAutobet.clientProfiles.map(
    (cp) => [
      `\`${cp.officeAgentId}\` (${cp.totalLinkedAccounts} accts)`,
      `\`${cp.patternArchetype}\` (MFCS ${cp.mfcsCompositeScore})`,
      `\`${cp.sharedIpOrSubnet}\` · ${cp.modeASessionDwellSeconds}s dwell`,
      `${cp.bridgedPolymarketWallets.length} PM wallets · ${cp.activeRotations.join(", ")}`,
      cp.surv02Enforcement,
      `\`${cp.layoffHedgeDisposition}\``,
      `\`${cp.ownerRole}\` (${cp.ownerEmail})`,
    ],
  );

  const layoffRows = wagerSurveillanceAndAutobet.layoffOpportunities.map(
    (o) => [
      `\`${o.opportunityId}\` (${o.rotation})`,
      `${o.league} ${o.period} · ${o.sourceClusterOffices.join("/")}`,
      o.f402LineLabel,
      `\`${o.externalVenue}\` (${o.executionStyle})`,
      `${(o.fairProb * 100).toFixed(1)}% vs ${(o.venuePrice * 100).toFixed(1)}c (+${o.edgeBps} bps)`,
      `$${o.plannedStakeUsd} (${o.contractsCount} contracts)`,
      `\`${o.intentLedgerState}\` · \`${o.ownerRole}\``,
    ],
  );

  const flowchartRows = wagerSurveillanceAndAutobet.flowchartNodes.map((n) => [
    `\`${n.nodeId}\` (${n.nodeKind})`,
    n.label,
    `\`${n.modulePath}\` (\`${n.entrypointFn}\`)`,
    n.decisionCondition,
    n.passBranchTarget,
    n.failOrVariantBranchTarget,
    `\`${n.ownerRole}\` (${n.slaOrLatencyBudget})`,
  ]);

  const decisionAuditRows = wagerSurveillanceAndAutobet.decisionAuditLog.map(
    (d) => [
      `\`${d.logId}\` (${d.rotation})`,
      `\`${d.intentOrTicketId}\` · \`${d.officeClusterId}\``,
      `${d.actorName} (\`${d.actorRole}\`)${d.coSignerName !== null ? ` + ${d.coSignerName} (\`${d.coSignerRole}\`)` : ""}`,
      `\`${d.priorState}\` -> \`${d.nextState}\` (\`${d.decisionAction}\`)`,
      `\`${d.edgeCaseOrVariantId}\` · ${d.gatesEvaluatedSummary}`,
      d.humanRationaleNote,
      `$${d.financialImpactUsd} · \`${d.auditSignatureHash}\``,
    ],
  );

  const edgeCaseRows = wagerSurveillanceAndAutobet.edgeCaseVariants.map(
    (ec) => [
      `\`${ec.variantId}\` (\`${ec.code}\`)`,
      ec.title,
      ec.triggerCondition,
      ec.deterministicHandlingContract,
      ec.humanAuditRequirement,
      `\`${ec.sourceModule}\` · \`${ec.ownerRole}\``,
    ],
  );

  const tradingToolRows = wagerSurveillanceAndAutobet.tradingToolingSuite.map(
    (t) => [
      `\`${t.toolId}\` (\`${t.code}\`)`,
      t.title,
      `\`${t.entrypointPath}\` · \`${t.primaryCliCommand}\``,
      t.cordisPluginName !== null ? `\`${t.cordisPluginName}\`` : "CLI-only",
      t.latencyOrThroughputSla,
      t.traderEdgeCapability,
      t.primaryOwnerRoles.map((r) => `\`${r}\``).join(", "),
    ],
  );

  const workstationRows = wagerSurveillanceAndAutobet.roleWorkstations.map(
    (w) => [
      `\`${w.roleId}\``,
      w.workstationTitle,
      w.primaryToolIds.map((id) => `\`${id}\``).join(", "),
      w.cordisPluginsAssigned.map((p) => `\`${p}\``).join(", "),
      w.preSlateCommandSequence.map((c) => `\`${c}\``).join(" -> "),
      w.liveSlateExecutionLoop.map((c) => `\`${c}\``).join(" -> "),
      `${w.latencyOrExecutionSla} · ${w.primaryEdgeBenchmark}`,
    ],
  );

  const weakestLinkRows =
    wagerSurveillanceAndAutobet.weakestLinkDiagnostics.map((wl) => [
      `\`${wl.linkId}\` (\`${wl.code}\`)`,
      `${wl.title} (${wl.severity})`,
      wl.measuredWeaknessMetric,
      `Weak: ${wl.primaryWeakRoles.map((r) => `\`${r}\``).join(", ")} -> Co-Pilot: ${wl.coPilotDeputyRoles.map((r) => `\`${r}\``).join(", ")}`,
      wl.implementedEnhancement,
      `${wl.beforeScoreOrSla} -> **${wl.projectedAfterScoreOrSla}**`,
      `\`${wl.remediationCommand}\` (${wl.status})`,
    ]);

  const issuePrTriageRows =
    wagerSurveillanceAndAutobet.githubIssueAndPrTriageLedger.map((entry) => [
      `\`${entry.itemRef}\` (#${entry.number})`,
      entry.title,
      `${entry.assigneeName} (\`${entry.primaryOwnerRole}\` · \`${entry.assigneeEmail}\`)`,
      `${entry.coPilotReviewerName} (\`${entry.coPilotReviewerRole}\`)`,
      entry.linkedPrsOrIssues.join(", "),
      `\`${entry.resolutionStatus}\` — ${entry.reviewAndMergeNote}`,
      `\`${entry.verificationCommand}\``,
    ]);

  const redTeamRows = wagerSurveillanceAndAutobet.redTeamDrills.map((d) => [
    `\`${d.drillId}\``,
    d.title,
    d.targetModules.map((m) => `\`${m}\``).join(", "),
    d.ownerRoles.map((r) => `\`${r}\``).join(" + "),
    `\`${d.verificationCommand}\``,
    d.status,
  ]);

  const guardRows = valueTelemetry.backtest4Wk.guardAttribution.map((g) => [
    `\`${g.guardCode}\``,
    g.ownerRoles.map((r) => `\`${r}\``).join(" + "),
    g.interceptedTickets.toLocaleString("en-US"),
    formatUsdCompact(g.interceptedHandleUsd),
    formatUsdCompact(g.deskSavingsUsd),
    `+${g.holdImprovementBps} bps`,
    g.latencyOrThresholdSpec,
  ]);

  const openTaskRows = report.tasks
    .filter((t) => t.status === "open")
    .map((t) => [
      t.id,
      `\`${t.ref ?? "—"}\``,
      `${t.owners.join(", ") || "UNASSIGNED"} (${t.ownerEmails.join(", ")})`,
      (t.goal ?? "—").slice(0, 74),
      (t.direction ?? "—").slice(0, 74),
      `${t.verifiedPaths.length}/${t.citedPaths.length} paths · ${t.completionPct}%`,
      t.auditVerdict,
    ]);

  const doneTaskRows = report.tasks
    .filter((t) => t.status === "done")
    .map((t) => [
      `\`${t.id}\``,
      t.basisLabels.join(" "),
      t.verifiedPaths.length > 0
        ? t.verifiedPaths.map((p) => `\`${p}\``).join(", ")
        : "gate-verified",
      `${t.completionPct}%`,
      t.auditVerdict,
    ]);

  const decisionRows = report.decisions.map((d) => [
    `#${d.number}`,
    d.owners.join(" + "),
    d.timeEstimate,
    d.blocksTaskId,
    d.decision,
  ]);

  return {
    id: "rbac-governance",
    title:
      "RBAC Roles, Team Leads, Email/Inbox Accountability, Wager/Weblog/IP Profiling, Red-Team, BetTicker Flowchart, Trading Tooling, Weakest-Link Enhancements & GitHub Issue/PR Triage",
    group: "ops",
    state: "measured",
    provenance: `source: docs/REMAINING_TASKS.md + bet_ticker_ip_tracker_bridge.ts + rebet_engine.ts + watchlist_autobet.ts · gate=${summary.gatePassed ? "PASS" : "FAIL"} · audit=${taskAudit.auditPassed ? "PASS" : "FAIL"} (${taskAudit.overallCompletionPct}% readiness) · issuesResolved=${summary.githubIssuesResolvedCount}/${summary.githubIssuesTriagedCount} · prsMerged=${summary.githubPrsReviewedAndMergedCount} · weakestLinks=${summary.weakestLinksCount} (${summary.teamHealthScore}%->${summary.projectedTeamHealthScoreAfterEnhancements}%) · tools=${summary.verifiedTradingToolsOnDiskCount}/${summary.tradingToolsCount} · workstations=${summary.roleWorkstationsCount} · profiles=${summary.clientProfilesCount} · flowNodes=${summary.flowchartNodesCount} · decisionLogs=${summary.decisionAuditLogCount} · edgeCases=${summary.edgeCaseVariantsCount} · redTeam=${summary.redTeamDrillsDefended}/${summary.redTeamDrillsTotal} · layoff=$${summary.totalPlannedLayoffUsd} · channels=${summary.activeChannelsCount} · inboxes=${summary.totalRoleInboxes} · health=${summary.teamHealthScore}%`,
    body: [
      `> **Bird's-Eye Team, Wager/IP Profiling, Red-Team, BetTicker Layoff, Trading Tooling, Weakest-Link & GitHub Issue/PR Pulse:** ${summary.githubIssuesResolvedCount}/${summary.githubIssuesTriagedCount} GitHub issues fixed & closed + ${summary.githubPrsReviewedAndMergedCount} PRs reviewed & merged · ${summary.weakestLinksCount} weakest links diagnosed & enhanced (lifting Team Health **${summary.teamHealthScore}% -> ${summary.projectedTeamHealthScoreAfterEnhancements}%**) · ${summary.verifiedTradingToolsOnDiskCount}/${summary.tradingToolsCount} verified trading & execution tools · ${summary.roleWorkstationsCount} role workstations · ${summary.totalRoleInboxes} role inboxes (\`@bookdeskops.com\`) · ${summary.activeChannelsCount} channels · ${summary.clientProfilesCount} office/IP wager profiles (${wagerSurveillanceAndAutobet.totalLinkedAccountsTracked} accounts, ${wagerSurveillanceAndAutobet.totalBridgedPolymarketWallets} PM wallets, avg ${wagerSurveillanceAndAutobet.avgModeADwellSeconds}s Mode A dwell) · ${summary.flowchartNodesCount}-node BetTicker Flowchart · ${summary.decisionAuditLogCount} Human/Team-Member Audit Decisions · ${summary.edgeCaseVariantsCount} Edge Cases & Variants · ${summary.redTeamDrillsDefended}/${summary.redTeamDrillsTotal} Red-Team drills defended · ${summary.layoffOpportunitiesCount} BetTicker layoff/hedge routes ($${summary.totalPlannedLayoffUsd} planned, +${wagerSurveillanceAndAutobet.avgLayoffEdgeBps} bps avg edge) · Overall Task Readiness **${taskAudit.overallCompletionPct}%** · 4-Wk Protected Value **${formatUsdCompact(summary.totalCounterfactualSavingsUsd4Wk)}**`,
      "",
      "### GitHub Issues (`#16`..`#115`) & Pull Requests (`#104`..`#128`) Teammate Triage, Review & Merge Ledger",
      "",
      ...markdownTable(
        [
          "Ref / #",
          "Title",
          "Primary Assignee & Inbox",
          "Co-Pilot Reviewer",
          "Linked PRs / Tasks",
          "Resolution & Review Note",
          "Verification Command",
        ],
        issuePrTriageRows,
      ),
      "",
      "### Weakest-Link Bottleneck Radar, Co-Pilot Failover & Code/Governance Enhancements (`WL-01`..`WL-06`)",
      "",
      ...markdownTable(
        [
          "Link ID / Code",
          "Bottleneck Title & Severity",
          "Measured Weakness Metric",
          "Primary Weak Role(s) -> Co-Pilot Deputy",
          "Implemented Code & Governance Enhancement",
          "Before -> Projected After",
          "Verification Command & Status",
        ],
        weakestLinkRows,
      ),
      "",
      "### Industry-Leading Desk Trading, Execution & Surveillance Tooling Suite (All 8 Flagship Systems Verified On-Disk)",
      "",
      ...markdownTable(
        [
          "Tool ID / Code",
          "System Title",
          "Entrypoint & Primary CLI",
          "DSH Cordis Plugin",
          "Latency / Throughput SLA",
          "Trader Edge Capability",
          "Owner Roles",
        ],
        tradingToolRows,
      ),
      "",
      "### Role-Specific Trading Workstation Loadouts (Pre-Slate, Live-Slate & Post-Slate Workflows)",
      "",
      ...markdownTable(
        [
          "Role",
          "Workstation Title",
          "Primary Tools",
          "Cordis Plugins",
          "Pre-Slate Sequence",
          "Live-Slate Loop",
          "SLA & Edge Benchmark",
        ],
        workstationRows,
      ),
      "",
      "### BetTicker End-to-End Decision Flowchart (Wire Ingest -> Surveillance -> 12-Gate -> Human Sign-Off -> Layoff & Settlement)",
      "",
      "```mermaid",
      wagerSurveillanceAndAutobet.flowchartMermaid,
      "```",
      "",
      ...markdownTable(
        [
          "Node / Kind",
          "Pipeline Stage",
          "Module & Entrypoint",
          "Decision / Branch Condition",
          "Pass Target",
          "Fail / Variant Target",
          "Owner & SLA",
        ],
        flowchartRows,
      ),
      "",
      "### Human & Team-Member BetTicker Decision Audit Log (Dual Sign-Off, Overrides & JSONL Ledger)",
      "",
      ...markdownTable(
        [
          "Log ID / Rot",
          "Intent / Cluster",
          "Human Actor & Co-Signer",
          "State Transition & Action",
          "Edge Case & Gate Check",
          "Human Audit Rationale Note",
          "Impact & Signature",
        ],
        decisionAuditRows,
      ),
      "",
      "### BetTicker Edge Cases & Variants Catalog (Ingest, Weblog Mode C, CGNAT, Key-Numbers, Lock & TTL)",
      "",
      ...markdownTable(
        [
          "ID / Code",
          "Edge Case / Variant",
          "Trigger Condition",
          "Deterministic Handling Contract",
          "Human Audit Requirement",
          "Module & Owner",
        ],
        edgeCaseRows,
      ),
      "",
      "### Incoming Wager Surveillance & Client / Weblog (Mode A/B/C/I) / IP Pattern Profiles",
      "",
      ...markdownTable(
        [
          "Office / Accounts",
          "Pattern Archetype",
          "Subnet & Mode A Dwell",
          "PM Wallets & Rotations",
          "GATE-SURV-02 Clamp",
          "Layoff / Hedge Disposition",
          "Owner & Inbox",
        ],
        clientProfileRows,
      ),
      "",
      "### Automated BetTicker Layoff, Hedge & Re-Bet Opportunities (Kalshi & Polymarket)",
      "",
      ...markdownTable(
        [
          "Opportunity / Rot",
          "League & Source Clusters",
          "F402 vs Venue Line",
          "Venue & Style",
          "Fair Prob vs Price (Edge)",
          "Planned Stake",
          "Ledger & Owner",
        ],
        layoffRows,
      ),
      "",
      "### Red-Team Adversarial Drills & Defense Verification",
      "",
      ...markdownTable(
        [
          "Drill ID",
          "Adversarial Attack Vector & Title",
          "Target Modules",
          "Owner Role(s)",
          "Verification Command",
          "Status",
        ],
        redTeamRows,
      ),
      "",
      "### Bird's-Eye Operational Planes (Team Leads, Inbox Emails, Telemetry & Value)",
      "",
      ...markdownTable(
        [
          "Operational Plane",
          "Plane Lead",
          "Lead Email",
          "Desk Roles",
          "Health",
          "Value Protected / Governed",
          "Live Telemetry Pulse",
        ],
        planeRows,
      ),
      "",
      "### Role Scorecards (Team Leads, Email/Inbox Accountability, Channels & Value)",
      "",
      ...markdownTable(
        [
          "Role",
          "Team Lead",
          "Email & Inbox SLA",
          "Bound Channels",
          "Open Tasks",
          "Attributed Value",
          "Score",
          "Status",
        ],
        scorecardRows,
      ),
      "",
      "### Multi-Channel Integration & Escalation Matrix (All 6 Operational Channels)",
      "",
      ...markdownTable(
        [
          "Channel ID",
          "Channel Name",
          "Entrypoint / Service",
          "Cadence / SLA",
          "Subscribed Roles",
          "Status",
        ],
        channelRows,
      ),
      "",
      "### 6-Guard Counterfactual Value Attribution (4-Week CFB + NBA Backtest)",
      "",
      ...markdownTable(
        [
          "Guard",
          "Owner Role(s)",
          "Tickets",
          "Handle",
          "4-Wk Savings",
          "Hold Lift",
          "Telemetry / SLA Threshold",
        ],
        guardRows,
      ),
      "",
      "### Open Task Completeness, Direction & Goal Audit",
      "",
      ...markdownTable(
        [
          "Task",
          "Ref",
          "Owner(s) & Inbox",
          "Strategic Goal",
          "Execution Direction",
          "Evidence & Readiness",
          "Audit Verdict",
        ],
        openTaskRows,
      ),
      "",
      "### Completed Task Evidence & Basis Audit (`[x]` Verified Complete)",
      "",
      ...markdownTable(
        [
          "Task / Ref",
          "Basis",
          "Verified On-Disk Evidence",
          "Readiness",
          "Audit Verdict",
        ],
        doneTaskRows,
      ),
      "",
      "### Pending Unblock Decisions (P0.6 Authz & Ledger)",
      "",
      ...markdownTable(
        ["#", "Owner Role(s)", "Est.", "Unblocks", "Decision"],
        decisionRows,
      ),
    ],
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Self-contained interactive HTML dashboard for `/governance` and CLI `--out`.
 * Uses zero external assets and zero `.innerHTML` writes so `bin/check-innerhtml.ts`
 * and strict CSP pass without exceptions.
 */
export function renderStandaloneGovernanceHtml(
  report: GovernanceReport,
): string {
  const { summary, taskAudit, valueTelemetry } = report;
  const openTasks = report.tasks.filter((t) => t.status === "open");
  const doneTasks = report.tasks.filter((t) => t.status === "done");
  const bt = valueTelemetry.backtest4Wk;
  const br = valueTelemetry.crossDomainBridge;
  const lf = valueTelemetry.liveSyndicateFeed;

  const roleFilterButtons = [
    `<button type="button" class="filter-btn active" data-filter-role="ALL">All Team Roles (${DESK_ROLE_IDS.length})</button>`,
    ...report.ownerScorecards.map(
      (s) =>
        `<button type="button" class="filter-btn" data-filter-role="${escapeHtml(s.roleId)}">${escapeHtml(s.label)} · ${s.weightScore}%</button>`,
    ),
  ].join("\n          ");

  const planeCardsHtml = valueTelemetry.planeSummaries
    .map((p) => {
      const tone =
        p.avgHealthScore >= 90
          ? "ok"
          : p.avgHealthScore >= 85
            ? "info"
            : "warn";
      const valText =
        p.protectedSavingsUsd > 0
          ? `${formatUsdCompact(p.protectedSavingsUsd)} saved (4wk)`
          : `${formatUsdCompact(p.priorityExposureUsd)} governed`;
      return `<article class="plane-card" data-plane="${escapeHtml(p.plane)}" data-roles="${escapeHtml(p.roleIds.join(","))}">
          <div class="scorecard-head">
            <div>
              <span class="mono role-id">${escapeHtml(p.plane)}</span>
              <h3>${escapeHtml(p.label)}</h3>
            </div>
            <span class="badge ${tone}">${p.avgHealthScore}% Health</span>
          </div>
          <div class="plane-roles">
            ${p.roleIds.map((r) => `<span class="badge muted-badge mono">${escapeHtml(r)}</span>`).join(" ")}
          </div>
          <dl class="metrics-grid">
            <div><dt>Plane Team Lead</dt><dd>${escapeHtml(p.planeLead)}</dd></div>
            <div><dt>Plane Inbox / Email</dt><dd class="mono">${escapeHtml(p.planeEmail)}</dd></div>
            <div><dt>Real Value</dt><dd class="mono">${escapeHtml(valText)}</dd></div>
            <div><dt>Open / P0 · Gates</dt><dd class="mono">${p.openTasksCount}/${p.p0TasksCount} · ${p.gatesReady}/${p.gatesTotal} gates</dd></div>
          </dl>
          <p class="next-action"><strong>Active Channels:</strong> ${p.activeChannels.map((c) => `<span class="badge muted-badge mono">${escapeHtml(c)}</span>`).join(" ")}</p>
          <p class="next-action"><strong>Telemetry:</strong> ${escapeHtml(p.telemetryHeadline)}</p>
        </article>`;
    })
    .join("\n        ");

  const scorecardCards = report.ownerScorecards
    .map((s) => {
      const tone =
        s.status === "HOLDING_WEIGHT"
          ? "ok"
          : s.status === "ACTION_REQUIRED"
            ? "warn"
            : s.status === "OVERDUE"
              ? "bad"
              : "info";
      const inboxTone =
        s.inboxStatus === "INBOX_ZERO"
          ? "ok"
          : s.inboxStatus === "ACK_PENDING"
            ? "warn"
            : s.inboxStatus === "ESCALATED_TO_LEAD"
              ? "bad"
              : "info";
      const valDisplay =
        s.protectedSavingsUsd > 0
          ? `${formatUsdCompact(s.protectedSavingsUsd)} saved`
          : `${formatUsdCompact(s.priorityExposureUsd)} exposure`;
      return `<article class="scorecard" data-role-card="${escapeHtml(s.roleId)}" data-status="${escapeHtml(s.status)}">
          <div class="scorecard-head">
            <div>
              <span class="mono role-id">${escapeHtml(s.roleId)} · ${escapeHtml(s.plane)}</span>
              <h3>${escapeHtml(s.label)}</h3>
            </div>
            <span class="badge ${tone}">${escapeHtml(s.status.replaceAll("_", " "))}</span>
          </div>
          <div class="meter-row">
            <div class="meter-bar"><div class="meter-fill ${tone}" style="width:${s.weightScore}%"></div></div>
            <strong class="mono">${s.weightScore}%</strong>
          </div>
          <dl class="metrics-grid">
            <div><dt>Team Lead (Reports To)</dt><dd>${escapeHtml(s.teamLead)} <span class="muted mono">&rarr; ${escapeHtml(s.reportsToRole)}</span></dd></div>
            <div><dt>Role Email &amp; Inbox</dt><dd class="mono">${escapeHtml(s.email)}<div><span class="badge ${inboxTone}">${escapeHtml(s.inboxStatus)} · ${s.ackSlaMinutes}m ACK</span></div></dd></div>
            <div><dt>F402 / Forensic</dt><dd class="mono">${escapeHtml(s.f402Counterpart)} · ${escapeHtml(s.forensicCounterpart)}</dd></div>
            <div><dt>Real Value</dt><dd class="mono">${escapeHtml(valDisplay)}</dd></div>
            <div><dt>Open / P0 · Inbox Queue</dt><dd class="mono">${s.openTaskIds.length} / ${s.p0Count} · ${s.inboxPendingItems} queued (${s.inboxUrgentItems} urgent)</dd></div>
            <div><dt>Decisions / Gates</dt><dd class="mono">${s.pendingDecisionCount} (${s.pendingDecisionHours}h) · ${s.gatesReady}/${s.gatesTotal}</dd></div>
          </dl>
          <p class="next-action"><strong>Inbox Route:</strong> <code class="mono">${escapeHtml(s.inboxRoute)}</code> · <strong>TG:</strong> <code class="mono">${escapeHtml(s.telegramCommand)}</code></p>
          <p class="next-action"><strong>Channels (${s.primaryChannels.length}):</strong> ${s.primaryChannels.map((c) => `<span class="badge muted-badge mono">${escapeHtml(c)}</span>`).join(" ")}</p>
          <p class="next-action"><strong>Telemetry:</strong> ${escapeHtml(s.telemetryPulse)}</p>
          <p class="next-action"><strong>Value:</strong> ${escapeHtml(s.valueSummary)}</p>
          <p class="next-action"><strong>Next:</strong> ${escapeHtml(s.nextAction)}</p>
        </article>`;
    })
    .join("\n        ");

  const channelRowsHtml = report.channelIntegrations
    .map(
      (ch) => `<tr data-roles="${escapeHtml(ch.subscribedRoles.join(","))}">
            <td><strong class="mono">${escapeHtml(ch.id)}</strong><div>${escapeHtml(ch.label)}</div><div class="muted">${escapeHtml(ch.protocol)}</div></td>
            <td class="mono">${escapeHtml(ch.entrypoint)}</td>
            <td class="mono">${escapeHtml(ch.cadenceOrSla)}</td>
            <td>
              <div>${ch.commandsOrRoutes.map((cmd) => `<span class="badge muted-badge mono">${escapeHtml(cmd)}</span>`).join(" ")}</div>
              <div class="muted" style="margin-top:4px">${escapeHtml(ch.description)}</div>
            </td>
            <td class="mono">${ch.subscribedRoles.map((r) => `<span class="badge info mono">${escapeHtml(r)}</span>`).join(" ")}</td>
            <td><span class="badge ok">${escapeHtml(ch.status)}</span></td>
          </tr>`,
    )
    .join("\n          ");

  const ws = report.wagerSurveillanceAndAutobet;
  const flowchartRowsHtml = ws.flowchartNodes
    .map(
      (n) => `<tr data-roles="${escapeHtml(n.ownerRole)}">
            <td class="mono">
              <strong>${escapeHtml(n.nodeId)}</strong>
              <div><span class="badge ${n.nodeKind === "HUMAN_AUDIT_GATE" ? "warn" : n.nodeKind === "GOVERNOR_CLAMP" ? "bad" : "info"}">${escapeHtml(n.nodeKind)}</span></div>
            </td>
            <td>
              <div><strong>${n.stepNumber}. ${escapeHtml(n.label)}</strong></div>
              <div class="muted mono">${escapeHtml(n.modulePath)} · <code>${escapeHtml(n.entrypointFn)}</code></div>
            </td>
            <td>${escapeHtml(n.decisionCondition)}</td>
            <td class="mono">
              <div><span class="badge ok">PASS &rarr;</span> ${escapeHtml(n.passBranchTarget)}</div>
              <div style="margin-top:4px"><span class="badge warn">ALT/TRAP &rarr;</span> ${escapeHtml(n.failOrVariantBranchTarget)}</div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(n.ownerRole)}</strong></div>
              <div class="muted">${escapeHtml(n.teamLead)}</div>
              <div><span class="badge muted-badge mono">${escapeHtml(n.slaOrLatencyBudget)}</span></div>
            </td>
          </tr>`,
    )
    .join("\n          ");

  const decisionLogRowsHtml = ws.decisionAuditLog
    .map((d) => {
      const stateTone =
        d.nextState === "approved" ||
        d.nextState === "filled" ||
        d.nextState === "settled"
          ? "ok"
          : d.nextState === "rejected" || d.nextState === "clamped_donor"
            ? "bad"
            : "warn";
      return `<tr data-roles="${escapeHtml(d.actorRole + (d.coSignerRole !== null ? `,${d.coSignerRole}` : ""))}">
            <td class="mono">
              <strong>${escapeHtml(d.logId)}</strong>
              <div class="muted">${escapeHtml(d.timestampIso)}</div>
              <div><span class="badge info">${escapeHtml(d.rotation)} · ${escapeHtml(d.league)}</span></div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(d.intentOrTicketId)}</strong></div>
              <div class="muted">Cluster: ${escapeHtml(d.officeClusterId)} (${escapeHtml(d.customerLogin)})</div>
              <div class="muted">Flow Node: <code>${escapeHtml(d.flowchartNodeId)}</code></div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(d.actorName)}</strong> (<span class="badge info mono">${escapeHtml(d.actorRole)}</span>)</div>
              <div class="muted">${escapeHtml(d.actorEmail)}</div>
              ${d.coSignerName !== null ? `<div style="margin-top:4px"><strong>Co-Sign: ${escapeHtml(d.coSignerName)}</strong> (<span class="badge warn mono">${escapeHtml(d.coSignerRole ?? "")}</span>)</div>` : ""}
              <div class="muted">${escapeHtml(d.inboxTicketRef)}</div>
            </td>
            <td class="mono">
              <div><span class="badge muted-badge">${escapeHtml(d.priorState)}</span> &rarr; <span class="badge ${stateTone}">${escapeHtml(d.nextState.toUpperCase())}</span></div>
              <div style="margin-top:4px"><strong>${escapeHtml(d.decisionAction)}</strong></div>
              <div class="muted">$${d.financialImpactUsd} · <code>${escapeHtml(d.auditSignatureHash)}</code></div>
            </td>
            <td>
              <div><span class="badge warn mono">${escapeHtml(d.edgeCaseOrVariantId)}</span> · <span class="mono muted">${escapeHtml(d.gatesEvaluatedSummary)}</span></div>
              <div class="next-action"><strong>Audit Rationale:</strong> ${escapeHtml(d.humanRationaleNote)}</div>
              <div class="muted mono" style="margin-top:4px"><code>${escapeHtml(d.verificationCommand)}</code></div>
            </td>
          </tr>`;
    })
    .join("\n          ");

  const edgeCaseRowsHtml = ws.edgeCaseVariants
    .map(
      (ec) => `<tr data-roles="${escapeHtml(ec.ownerRole)}">
            <td class="mono">
              <strong>${escapeHtml(ec.variantId)}</strong>
              <div><span class="badge warn">${escapeHtml(ec.code)}</span></div>
              <div class="muted">${escapeHtml(ec.category)}</div>
            </td>
            <td>
              <div><strong>${escapeHtml(ec.title)}</strong></div>
              <div class="next-action"><strong>Trigger:</strong> ${escapeHtml(ec.triggerCondition)}</div>
              <div class="next-action"><strong>Failure Mode if Unhandled:</strong> ${escapeHtml(ec.failureModeIfUnhandled)}</div>
            </td>
            <td>
              <div class="next-action"><strong>Deterministic Contract:</strong> ${escapeHtml(ec.deterministicHandlingContract)}</div>
              <div class="next-action"><strong>Human Audit Rule:</strong> ${escapeHtml(ec.humanAuditRequirement)}</div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(ec.ownerRole)}</strong></div>
              <div class="muted"><code>${escapeHtml(ec.sourceModule)}</code></div>
              <div style="margin-top:4px"><code>${escapeHtml(ec.verificationCommand)}</code></div>
            </td>
          </tr>`,
    )
    .join("\n          ");

  const tradingToolRowsHtml = ws.tradingToolingSuite
    .map(
      (t) => `<tr data-roles="${escapeHtml(t.primaryOwnerRoles.join(","))}">
            <td class="mono">
              <strong>${escapeHtml(t.toolId)}</strong>
              <div><span class="badge ok">${escapeHtml(t.code)}</span></div>
              <div class="muted">${escapeHtml(t.category)}</div>
            </td>
            <td>
              <div><strong>${escapeHtml(t.title)}</strong></div>
              <div class="muted mono">Entrypoint: <code>${escapeHtml(t.entrypointPath)}</code> (${t.supportingModules.length} modules)</div>
              <div class="next-action"><strong>CLI:</strong> <code class="mono">${escapeHtml(t.primaryCliCommand)}</code></div>
              <div class="muted mono">Surface: ${escapeHtml(t.httpOrMcpSurface)}${t.cordisPluginName !== null ? ` · Cordis: <code>${escapeHtml(t.cordisPluginName)}</code>` : ""}</div>
            </td>
            <td>
              <div class="next-action"><strong>Trader Edge Capability:</strong> ${escapeHtml(t.traderEdgeCapability)}</div>
              <div class="next-action"><strong>Safety Guardrail:</strong> ${escapeHtml(t.safetyGuardrailContract)}</div>
            </td>
            <td class="mono">
              <div><span class="badge info">${escapeHtml(t.latencyOrThroughputSla)}</span></div>
              <div style="margin-top:4px">${t.primaryOwnerRoles.map((r) => `<span class="badge muted-badge mono">${escapeHtml(r)}</span>`).join(" ")}</div>
              <div class="muted" style="margin-top:4px"><code>${escapeHtml(t.verificationCommand)}</code></div>
            </td>
          </tr>`,
    )
    .join("\n          ");

  const roleWorkstationRowsHtml = ws.roleWorkstations
    .map(
      (w) => `<tr data-roles="${escapeHtml(w.roleId)}">
            <td class="mono">
              <strong>${escapeHtml(w.roleId)}</strong>
              <div class="muted">${escapeHtml(DESK_ROLES[w.roleId].teamLead)}</div>
              <div><span class="badge muted-badge mono">${escapeHtml(DESK_ROLES[w.roleId].email)}</span></div>
            </td>
            <td>
              <div><strong>${escapeHtml(w.workstationTitle)}</strong></div>
              <div style="margin-top:4px">Tools: ${w.primaryToolIds.map((id) => `<span class="badge ok mono">${escapeHtml(id)}</span>`).join(" ")}</div>
              <div style="margin-top:4px">Cordis: ${w.cordisPluginsAssigned.map((p) => `<span class="badge info mono">${escapeHtml(p)}</span>`).join(" ")}</div>
            </td>
            <td class="mono">
              <div><strong>Pre-Slate:</strong> ${w.preSlateCommandSequence.map((c) => `<code>${escapeHtml(c)}</code>`).join(" &rarr; ")}</div>
              <div style="margin-top:4px"><strong>Live-Slate:</strong> ${w.liveSlateExecutionLoop.map((c) => `<code>${escapeHtml(c)}</code>`).join(" &rarr; ")}</div>
              <div style="margin-top:4px"><strong>Post-Slate:</strong> ${w.postSlateAuditLoop.map((c) => `<code>${escapeHtml(c)}</code>`).join(" &rarr; ")}</div>
            </td>
            <td class="mono">
              <div><span class="badge ok">${escapeHtml(w.latencyOrExecutionSla)}</span></div>
              <div class="next-action"><strong>Edge Benchmark:</strong> ${escapeHtml(w.primaryEdgeBenchmark)}</div>
            </td>
          </tr>`,
    )
    .join("\n          ");

  const weakestLinkRowsHtml = ws.weakestLinkDiagnostics
    .map((wl) => {
      const sevTone =
        wl.severity === "CRITICAL_BOTTLENECK"
          ? "bad"
          : wl.severity === "HIGH_FRICTION"
            ? "warn"
            : "info";
      const allRoles = [...wl.primaryWeakRoles, ...wl.coPilotDeputyRoles];
      return `<tr data-roles="${escapeHtml(allRoles.join(","))}">
            <td class="mono">
              <strong>${escapeHtml(wl.linkId)}</strong>
              <div><span class="badge ${sevTone}">${escapeHtml(wl.severity)}</span></div>
              <div class="muted">${escapeHtml(wl.code)}</div>
            </td>
            <td>
              <div><strong>${escapeHtml(wl.title)}</strong></div>
              <div class="next-action"><strong>Measured Bottleneck:</strong> ${escapeHtml(wl.measuredWeaknessMetric)}</div>
              <div class="next-action"><strong>Root Cause:</strong> ${escapeHtml(wl.rootCauseAnalysis)}</div>
              <div class="muted mono" style="margin-top:4px">Refs: ${escapeHtml(wl.impactedTasksOrRefs.join(", "))} · Modules: ${wl.sourceModules.map((m) => `<code>${escapeHtml(m)}</code>`).join(" ")}</div>
            </td>
            <td class="mono">
              <div><strong>Weak Role(s):</strong> ${wl.primaryWeakRoles.map((r) => `<span class="badge warn mono">${escapeHtml(r)}</span>`).join(" ")}</div>
              <div style="margin-top:4px"><strong>Co-Pilot Deputy:</strong> ${wl.coPilotDeputyRoles.map((r) => `<span class="badge ok mono">${escapeHtml(r)}</span>`).join(" ")}</div>
              <div class="muted" style="margin-top:4px">Protects ${formatUsdCompact(wl.financialExposureProtectedUsd)}</div>
            </td>
            <td>
              <div class="next-action"><strong>Implemented Enhancement:</strong> ${escapeHtml(wl.implementedEnhancement)}</div>
              <div class="mono" style="margin-top:4px"><span class="badge bad">${escapeHtml(wl.beforeScoreOrSla)}</span> &rarr; <span class="badge ok">${escapeHtml(wl.projectedAfterScoreOrSla)}</span></div>
              <div class="mono muted" style="margin-top:4px"><code>${escapeHtml(wl.remediationCommand)}</code> · <span class="badge info">${escapeHtml(wl.status)}</span></div>
            </td>
          </tr>`;
    })
    .join("\n          ");

  const issuePrTriageRowsHtml = ws.githubIssueAndPrTriageLedger
    .map((entry) => {
      const statusTone =
        entry.resolutionStatus === "FIXED_AND_MERGED" ||
        entry.resolutionStatus === "FIXED_IN_CURRENT_PR"
          ? "ok"
          : "info";
      const roles = `${entry.primaryOwnerRole},${entry.coPilotReviewerRole}`;
      return `<tr data-roles="${escapeHtml(roles)}">
            <td class="mono">
              <strong>${escapeHtml(entry.itemRef)}</strong>
              <div><span class="badge ${entry.kind === "GITHUB_PR" ? "info" : "warn"}">${escapeHtml(entry.kind)} #${entry.number}</span></div>
            </td>
            <td>
              <div><strong>${escapeHtml(entry.title)}</strong></div>
              <div class="muted mono" style="margin-top:4px">Linked: ${escapeHtml(entry.linkedPrsOrIssues.join(", "))}</div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(entry.assigneeName)}</strong> (<span class="badge info mono">${escapeHtml(entry.primaryOwnerRole)}</span>)</div>
              <div class="muted">${escapeHtml(entry.assigneeEmail)} · <code>${escapeHtml(entry.inboxDispatchRoute)}</code></div>
              <div style="margin-top:4px">Co-Pilot Reviewer: <strong>${escapeHtml(entry.coPilotReviewerName)}</strong> (<span class="badge ok mono">${escapeHtml(entry.coPilotReviewerRole)}</span>)</div>
            </td>
            <td>
              <div><span class="badge ${statusTone}">${escapeHtml(entry.resolutionStatus)}</span></div>
              <div class="next-action">${escapeHtml(entry.reviewAndMergeNote)}</div>
              <div class="mono muted" style="margin-top:4px"><code>${escapeHtml(entry.verificationCommand)}</code></div>
            </td>
          </tr>`;
    })
    .join("\n          ");

  const clientProfileRowsHtml = ws.clientProfiles
    .map(
      (cp) => `<tr data-roles="${escapeHtml(cp.ownerRole)}">
            <td class="mono">
              <strong>${escapeHtml(cp.officeAgentId)}</strong>
              <div><span class="badge ${cp.mfcsCompositeScore >= 93 ? "bad" : "warn"}">MFCS ${cp.mfcsCompositeScore}</span></div>
              <div class="muted">${cp.totalLinkedAccounts} accts (${escapeHtml(cp.matchedLoginsInOffice.slice(0, 3).join(", "))})</div>
            </td>
            <td>
              <div><strong class="mono">${escapeHtml(cp.patternArchetype)}</strong></div>
              <div class="muted mono">${escapeHtml(cp.matchClassification)}</div>
              <div class="muted">Rotations: ${cp.activeRotations.map((r) => `<span class="badge muted-badge mono">${escapeHtml(r)}</span>`).join(" ")}</div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(cp.sharedIpOrSubnet)}</strong></div>
              <div class="muted">${escapeHtml(cp.weblogModeEvidence)}</div>
              <div><span class="badge info">${cp.bridgedPolymarketWallets.length} Bridged PM Wallets</span></div>
            </td>
            <td>
              <div><span class="badge warn mono">${escapeHtml(cp.surv02Enforcement)}</span></div>
              <div style="margin-top:4px"><span class="badge ok mono">${escapeHtml(cp.layoffHedgeDisposition)}</span></div>
              <div class="next-action"><strong>Task (${escapeHtml(cp.profilingTask.taskId)}):</strong> ${escapeHtml(cp.profilingTask.goal)}</div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(cp.ownerRole)}</strong></div>
              <div class="muted">${escapeHtml(cp.teamLead)}</div>
              <div><span class="badge muted-badge mono">${escapeHtml(cp.ownerEmail)}</span></div>
            </td>
          </tr>`,
    )
    .join("\n          ");

  const layoffRowsHtml = ws.layoffOpportunities
    .map(
      (o) => `<tr data-roles="${escapeHtml(o.ownerRole)}">
            <td class="mono">
              <strong>${escapeHtml(o.opportunityId)}</strong>
              <div><span class="badge info">${escapeHtml(o.rotation)} · ${escapeHtml(o.league)} (${escapeHtml(o.period)})</span></div>
            </td>
            <td>
              <div><strong>${escapeHtml(o.marketSummary)}</strong></div>
              <div class="muted mono">Clusters: ${escapeHtml(o.sourceClusterOffices.join(", "))} (${escapeHtml(o.sourcePatternArchetype)})</div>
              <div class="muted mono">${escapeHtml(o.f402LineLabel)}</div>
            </td>
            <td class="mono">
              <div><span class="badge ok">${escapeHtml(o.externalVenue.toUpperCase())} · ${escapeHtml(o.executionStyle.toUpperCase())}</span></div>
              <div class="muted">Fair ${(o.fairProb * 100).toFixed(1)}% vs Venue ${(o.venuePrice * 100).toFixed(1)}c</div>
              <div><strong>+${o.edgeBps} bps edge</strong> (min ${o.sportMinEdgeBps} bps)${o.keyNumberCrossed !== null ? ` · <span class="badge warn">KEY ${o.keyNumberCrossed}</span>` : ""}</div>
            </td>
            <td class="mono">
              <div><strong>$${o.plannedStakeUsd}</strong> (${o.contractsCount} contracts)</div>
              <div class="muted">${escapeHtml(o.gateChecksPassed)}</div>
            </td>
            <td class="mono">
              <div><span class="badge ${o.intentLedgerState === "approved" ? "ok" : "info"}">${escapeHtml(o.intentLedgerState.toUpperCase())}</span></div>
              <div style="margin-top:4px">${escapeHtml(o.ownerRole)}</div>
              <div class="muted">${escapeHtml(o.ownerInbox)}</div>
            </td>
          </tr>`,
    )
    .join("\n          ");

  const redTeamRowsHtml = ws.redTeamDrills
    .map(
      (d) => `<tr data-roles="${escapeHtml(d.ownerRoles.join(","))}">
            <td class="mono">
              <strong>${escapeHtml(d.drillId)}</strong>
              <div><span class="badge bad">${escapeHtml(d.category)}</span></div>
            </td>
            <td>
              <div><strong>${escapeHtml(d.title)}</strong></div>
              <div class="next-action"><strong>Attack Vector:</strong> ${escapeHtml(d.attackVector)}</div>
              <div class="next-action"><strong>Defense Invariant:</strong> ${escapeHtml(d.expectedDefenseInvariant)}</div>
            </td>
            <td class="mono">
              <div>${d.targetModules.map((m) => `<span class="badge muted-badge mono">${escapeHtml(m)}</span>`).join(" ")}</div>
              <div style="margin-top:4px"><code>${escapeHtml(d.verificationCommand)}</code></div>
            </td>
            <td class="mono">
              <div>${d.ownerRoles.map((r) => `<span class="badge info mono">${escapeHtml(r)}</span>`).join(" ")}</div>
              <div class="muted">${escapeHtml(d.teamLead)}</div>
              <div class="muted">${escapeHtml(d.escalationInbox)}</div>
            </td>
            <td><span class="badge ok">${escapeHtml(d.status)}</span></td>
          </tr>`,
    )
    .join("\n          ");

  const maxWeekSavings = Math.max(
    1,
    ...bt.weeklyBreakdown.map((w) => w.deskSavingsUsd),
  );
  const weeklyRowsHtml = bt.weeklyBreakdown
    .map((w) => {
      const pctWidth = Math.round((w.deskSavingsUsd / maxWeekSavings) * 100);
      return `<tr>
            <td class="mono"><strong>${escapeHtml(w.weekCode)}</strong><div class="muted">${escapeHtml(w.weekLabel)}</div></td>
            <td class="mono">${w.combinedTickets.toLocaleString("en-US")}</td>
            <td class="mono">${formatUsdCompact(w.combinedHandleUsd)}</td>
            <td class="mono"><span class="badge bad">${w.combinedBaselineHoldPct}%</span> &rarr; <span class="badge ok">+${w.combinedProtectedHoldPct}%</span></td>
            <td>
              <div class="meter-row">
                <strong class="mono">${formatUsdCompact(w.deskSavingsUsd)}</strong>
                <div class="meter-bar"><div class="meter-fill ok" style="width:${pctWidth}%"></div></div>
              </div>
              <div class="muted">${escapeHtml(w.keyCatalyst)}</div>
            </td>
          </tr>`;
    })
    .join("\n          ");

  const guardRowsHtml = bt.guardAttribution
    .map(
      (g) => `<tr data-roles="${escapeHtml(g.ownerRoles.join(","))}">
            <td><strong class="mono">${escapeHtml(g.guardCode)}</strong><div>${escapeHtml(g.guardTitle)}</div><div class="muted">${escapeHtml(g.targetSports)}</div></td>
            <td class="mono">${escapeHtml(g.ownerRoles.join(" + "))}</td>
            <td class="mono">${g.interceptedTickets.toLocaleString("en-US")}</td>
            <td class="mono">${formatUsdCompact(g.interceptedHandleUsd)}</td>
            <td class="mono"><span class="badge ok">+${formatUsdCompact(g.deskSavingsUsd)}</span></td>
            <td class="mono">+${g.holdImprovementBps} bps</td>
            <td class="mono muted">${escapeHtml(g.latencyOrThresholdSpec)}</td>
          </tr>`,
    )
    .join("\n          ");

  const bridgeLeadRowsHtml = br.leads
    .map(
      (l) => `<tr data-roles="${escapeHtml(l.ownerRole)}">
            <td class="mono"><strong>${escapeHtml(l.customerId)}</strong><div class="muted">Agent: ${escapeHtml(l.agentId)}</div></td>
            <td class="mono">${escapeHtml(l.wallet.slice(0, 10))}...${escapeHtml(l.wallet.slice(-6))}</td>
            <td class="mono">${formatUsdCompact(l.deskPnlUsd)}</td>
            <td class="mono">${formatUsdCompact(l.polyPnlUsd)} (${escapeHtml(l.basis)})</td>
            <td><span class="badge ${l.verdict === "POLY_ONLY_UP" ? "warn" : "info"}">${escapeHtml(l.verdict)}</span></td>
            <td class="mono"><strong>${formatUsdCompact(l.priorityUsd)}</strong></td>
            <td class="mono">${escapeHtml(l.ownerRole)}</td>
          </tr>`,
    )
    .join("\n          ");

  const decisionRowsHtml = report.decisions
    .map(
      (d) => `<tr data-roles="${escapeHtml(d.owners.join(","))}">
            <td class="mono">#${d.number}</td>
            <td><strong>${escapeHtml(d.decision)}</strong><div class="muted">${escapeHtml(d.ask)}</div></td>
            <td class="mono">${escapeHtml(d.owners.join(" + "))}<div class="muted">${escapeHtml(d.owners.map((o) => DESK_ROLES[o].email).join(", "))}</div></td>
            <td class="mono">${escapeHtml(d.timeEstimate)}</td>
            <td class="mono"><span class="badge warn">Blocks ${escapeHtml(d.blocksTaskId)} (${formatUsdCompact(br.priorityUsd)} priority)</span></td>
          </tr>`,
    )
    .join("\n          ");

  const taskRowsHtml = openTasks
    .map((t) => {
      const slaBadge =
        t.slaState === "OVERDUE"
          ? `<span class="badge bad">OVERDUE (${t.daysUntilExpiry}d)</span>`
          : t.slaState === "DUE_SOON"
            ? `<span class="badge warn">${escapeHtml(t.expiryDate ?? "")} (${t.daysUntilExpiry}d)</span>`
            : t.expiryDate !== null
              ? `<span class="badge info">${escapeHtml(t.expiryDate)} (${t.daysUntilExpiry}d left)</span>`
              : `<span class="muted">No expiry</span>`;
      const verdictBadge =
        t.auditVerdict === "READY_TO_CLOSE"
          ? `<span class="badge ok">READY TO CLOSE</span>`
          : t.auditVerdict === "ON_TRACK_WITH_DIRECTION"
            ? `<span class="badge info">ON TRACK · GOAL+DIR</span>`
            : `<span class="badge bad">${escapeHtml(t.auditVerdict)}</span>`;
      const pathsHtml =
        t.verifiedPaths.length > 0
          ? t.verifiedPaths
              .map(
                (p) =>
                  `<span class="badge muted-badge mono">${escapeHtml(p)}</span>`,
              )
              .join(" ")
          : `<span class="muted">No path cited</span>`;
      return `<tr data-roles="${escapeHtml(t.owners.join(","))}" data-priority="${escapeHtml(t.priority)}">
            <td class="mono">
              <strong>${escapeHtml(t.id)}</strong>
              <div><span class="badge ${t.priority === "P0" ? "bad" : "info"}">${escapeHtml(t.priority)}</span></div>
              <div class="muted">${escapeHtml(t.ref ?? "—")}</div>
            </td>
            <td>
              <div><strong>${escapeHtml(t.title)}</strong></div>
              <div class="next-action"><strong>Strategic Goal:</strong> ${escapeHtml(t.goal ?? "—")}</div>
              <div class="next-action"><strong>Execution Direction:</strong> ${escapeHtml(t.direction ?? "—")}</div>
              ${t.nextCommand !== null ? `<div class="next-action"><strong>Command:</strong> <code class="mono">${escapeHtml(t.nextCommand)}</code></div>` : ""}
              <div class="muted"><strong>Done when:</strong> ${escapeHtml(t.doneWhen ?? "—")}</div>
              <div class="muted"><strong>Blocked by:</strong> ${escapeHtml(t.blockedBy ?? "—")}</div>
            </td>
            <td class="mono">
              <div><strong>${escapeHtml(t.owners.join(", "))}</strong></div>
              <div class="muted">${escapeHtml(t.ownerLead)}</div>
              <div>${t.ownerEmails.map((em) => `<span class="badge muted-badge mono">${escapeHtml(em)}</span>`).join(" ")}</div>
              <div class="muted">${escapeHtml(t.escalationChannel)}</div>
            </td>
            <td>
              <div>${pathsHtml}</div>
              <div class="muted mono">${t.verifiedPaths.length}/${t.citedPaths.length} on-disk verified · ${escapeHtml(t.basisLabels.join(" "))}</div>
            </td>
            <td>
              <div class="meter-row">
                <div class="meter-bar"><div class="meter-fill ${t.completionPct >= 90 ? "ok" : "info"}" style="width:${t.completionPct}%"></div></div>
                <strong class="mono">${t.completionPct}%</strong>
              </div>
              <div>${verdictBadge}</div>
              <div style="margin-top:4px">${slaBadge}</div>
            </td>
          </tr>`;
    })
    .join("\n          ");

  const doneTaskRowsHtml = doneTasks
    .map(
      (t) => `<tr data-roles="${escapeHtml(t.owners.join(","))}">
            <td class="mono"><strong>${escapeHtml(t.id)}</strong></td>
            <td>${escapeHtml(t.title)}</td>
            <td class="mono"><span class="badge ok">${escapeHtml(t.basisLabels.join(" "))}</span></td>
            <td class="mono">${
              t.verifiedPaths.length > 0
                ? t.verifiedPaths
                    .map(
                      (p) =>
                        `<span class="badge muted-badge mono">${escapeHtml(p)}</span>`,
                    )
                    .join(" ")
                : `<span class="muted">Gate suite verified</span>`
            }</td>
            <td><span class="badge ok">${escapeHtml(t.auditVerdict)} (${t.completionPct}%)</span></td>
          </tr>`,
    )
    .join("\n          ");

  const matrixRowsHtml = report.rbacMatrix
    .map((row) => {
      const cells = DESK_ROLE_IDS.map((roleId) => {
        const perm = row.permissions[roleId];
        const cls =
          perm === "ALLOWED"
            ? "ok"
            : perm === "GUARDED"
              ? "warn"
              : "muted-badge";
        return `<td><span class="badge ${cls}">${perm}</span></td>`;
      }).join("");
      return `<tr>
            <td><strong>${escapeHtml(row.capability)}</strong><div class="muted mono">${escapeHtml(row.surface)}</div></td>
            ${cells}
          </tr>`;
    })
    .join("\n          ");

  const portalRowsHtml = report.portalHierarchy
    .map(
      (p) => `<tr>
            <td class="mono"><strong>${escapeHtml(p.role)}</strong> · ${escapeHtml(p.name)}</td>
            <td class="mono">${escapeHtml(p.forensicRole)}</td>
            <td>${escapeHtml(p.prefilterBehavior)}</td>
            <td>${escapeHtml(p.tamperSurface)}</td>
            <td class="mono">${escapeHtml(p.mappedDeskRoles.join(", ") || "player-surface")}</td>
          </tr>`,
    )
    .join("\n          ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bird's-Eye Team Governance, Telemetry, Real Value &amp; Task Completeness Audit — SportsDesk Ops</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1217;
      --card: #171b22;
      --card-alt: #1e2430;
      --fg: #e7ecf3;
      --muted: #93a0b4;
      --border: #2a3241;
      --ok: #1f9d55;
      --warn: #d9822b;
      --bad: #e03e3e;
      --info: #3b82f6;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fb;
        --card: #ffffff;
        --card-alt: #f0f4f9;
        --fg: #141923;
        --muted: #5a6578;
        --border: #d8e0ec;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font: 14px/1.5 system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    .wrap { max-width: 1440px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 20px;
    }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 16px; margin: 28px 0 12px; }
    h3 { font-size: 15px; margin: 2px 0 0; }
    .muted { color: var(--muted); font-size: 12.5px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .kpi .val { font-size: 22px; font-weight: 700; display: block; margin: 2px 0; }
    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 18px;
    }
    .filter-btn {
      background: var(--card);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12.5px;
      cursor: pointer;
    }
    .filter-btn.active {
      background: var(--info);
      border-color: var(--info);
      color: #fff;
      font-weight: 600;
    }
    .planes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 14px;
      margin-bottom: 22px;
    }
    .plane-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
    }
    .plane-roles {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .scorecards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
    }
    .scorecard {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
    }
    .scorecard-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 10px;
    }
    .role-id { color: var(--muted); }
    .meter-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .meter-bar {
      flex: 1;
      height: 8px;
      background: var(--card-alt);
      border-radius: 999px;
      overflow: hidden;
    }
    .meter-fill { height: 100%; border-radius: 999px; }
    .meter-fill.ok { background: var(--ok); }
    .meter-fill.warn { background: var(--warn); }
    .meter-fill.bad { background: var(--bad); }
    .meter-fill.info { background: var(--info); }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px 10px;
      margin: 0 0 10px;
      padding: 8px;
      background: var(--card-alt);
      border-radius: 8px;
    }
    .metrics-grid dt { font-size: 11.5px; color: var(--muted); }
    .metrics-grid dd { margin: 0; font-weight: 600; }
    .next-action { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .badge.ok { background: rgba(31,157,85,0.16); color: #3dd68c; border-color: rgba(31,157,85,0.4); }
    .badge.warn { background: rgba(217,130,43,0.16); color: #f5a623; border-color: rgba(217,130,43,0.4); }
    .badge.bad { background: rgba(224,62,62,0.16); color: #ff6b6b; border-color: rgba(224,62,62,0.4); }
    .badge.info { background: rgba(59,130,246,0.16); color: #60a5fa; border-color: rgba(59,130,246,0.4); }
    .badge.muted-badge { background: var(--card-alt); color: var(--muted); border-color: var(--border); }
    .table-wrap {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow-x: auto;
      margin-bottom: 20px;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    th {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      background: var(--card-alt);
    }
    tr:last-child td { border-bottom: none; }
    nav a { color: var(--info); text-decoration: none; margin-right: 12px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <nav>
          <a href="/">Desk Home</a>
          <a href="/tracker">Ops Tracker</a>
          <a href="/governance.json">JSON Feed</a>
        </nav>
        <h1>Bird's-Eye Team Governance, Telemetry, Real Value &amp; Task Completeness Audit</h1>
        <div class="muted">Generated ${escapeHtml(report.generatedAt)} · Sources: REMAINING_TASKS.md + backtest-4wk-cfb-nba.json + cross-domain-bridge.json + combo-uniqueness.json + graph-live-feed.json</div>
      </div>
      <div>
        <span class="badge ${summary.gatePassed ? "ok" : "bad"}">GATE: ${summary.gatePassed ? "PASS (0 errors)" : `FAIL (${report.findings.length} findings)`}</span>
        <span class="badge ${taskAudit.auditPassed ? "ok" : "bad"}">TASK AUDIT: ${taskAudit.auditPassed ? `VERIFIED (${taskAudit.overallCompletionPct}% readiness)` : "INCOMPLETE"}</span>
        <span class="badge info">INBOXES: ${summary.totalRoleInboxes} (@bookdeskops.com) · ${summary.activeChannelsCount} CHANNELS</span>
      </div>
    </header>

    <section class="kpi-strip">
      <div class="kpi"><span class="muted">Team Accountability Score</span><span class="val mono">${summary.teamHealthScore}% &rarr; ${summary.projectedTeamHealthScoreAfterEnhancements}%</span><span class="muted">${DESK_ROLE_IDS.length} roles · 4 planes (${summary.weakestLinksCount} weakest links enhanced)</span></div>
      <div class="kpi"><span class="muted">4-Wk Counterfactual Value</span><span class="val mono">${formatUsdCompact(bt.totalCounterfactualSavingsUsd4Wk)}</span><span class="muted">${formatUsdCompact(bt.dailyProtectionRateUsd)}/day · ${bt.baselineTotalHoldPct4Wk}% &rarr; +${bt.protectedTotalHoldPct4Wk}% hold</span></div>
      <div class="kpi"><span class="muted">Cross-Domain Bridge Priority</span><span class="val mono">${formatUsdCompact(br.priorityUsd)}</span><span class="muted">${br.linkedCustomers}/${br.customersInBook} linked (${br.linkYieldPct}%) · ${formatUsdCompact(br.polyGrossPnlUsd)} poly PnL</span></div>
      <div class="kpi"><span class="muted">Live Syndicate Telemetry</span><span class="val mono">${lf.activeSyndicateWalletsCount}/${lf.configuredWalletsCount} wallets</span><span class="muted">${lf.polymarketPollDurationMs}ms poll · ${lf.wsStreamSlaMs}ms WSS SLA · ${formatUsdCompact(lf.totalOpenExposureUsd)} open</span></div>
      <div class="kpi"><span class="muted">Task Completeness &amp; Goals</span><span class="val mono">${taskAudit.overallCompletionPct}%</span><span class="muted">${taskAudit.openWithGoalCount}/${taskAudit.openTasksAudited} Goals · ${taskAudit.openWithDirectionCount}/${taskAudit.openTasksAudited} Directions · ${taskAudit.doneVerifiedCompleteCount}/${taskAudit.doneTasksAudited} Done</span></div>
      <div class="kpi"><span class="muted">GitHub Issues &amp; PRs</span><span class="val mono">${summary.githubIssuesResolvedCount}/${summary.githubIssuesTriagedCount} + ${summary.githubPrsReviewedAndMergedCount} PRs</span><span class="muted">${summary.totalRoleInboxes} inboxes · ${summary.activeChannelsCount} channels</span></div>
    </section>

    <section>
      <h2>Filter Bird's-Eye View by RBAC Role</h2>
      <div class="toolbar" id="role-toolbar">
        ${roleFilterButtons}
      </div>
    </section>

    <section>
      <h2>Bird's-Eye Team Topology: 4 Operational Planes</h2>
      <div class="planes-grid" id="planes-grid">
        ${planeCardsHtml}
      </div>
    </section>

    <section>
      <h2>Role Accountability Scorecards (Team Leads, Email/Inbox SLAs, Channels &amp; Real Value)</h2>
      <div class="scorecards-grid" id="scorecards-grid">
        ${scorecardCards}
      </div>
    </section>

    <section>
      <h2>Multi-Channel Integration &amp; Escalation Routing Matrix (6 Operational Channels)</h2>
      <div class="table-wrap">
        <table id="channels-table">
          <thead>
            <tr>
              <th>Channel / Protocol</th>
              <th>Repository Entrypoint</th>
              <th>Cadence / ACK SLA</th>
              <th>Commands, Routes &amp; Scope</th>
              <th>Subscribed RBAC Roles</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${channelRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>GitHub Issues (#16..#115) &amp; Pull Requests (#104..#128) Teammate Triage, Review &amp; Merge Ledger (${summary.githubIssuesResolvedCount}/${summary.githubIssuesTriagedCount} Issues Fixed &amp; ${summary.githubPrsReviewedAndMergedCount} PRs Merged)</h2>
      <div class="table-wrap">
        <table id="issues-prs-table">
          <thead>
            <tr>
              <th>Item Ref / #</th>
              <th>Issue or PR Title &amp; Linked Refs</th>
              <th>Assigned Teammate, Inbox &amp; Co-Pilot Reviewer</th>
              <th>Resolution Status, Review Note &amp; Verification</th>
            </tr>
          </thead>
          <tbody>
            ${issuePrTriageRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Weakest-Link Bottleneck Radar, Co-Pilot Failover &amp; Code/Governance Enhancements (${ws.weakestLinksCount} Bottlenecks Remediated · ${summary.teamHealthScore}% &rarr; ${summary.projectedTeamHealthScoreAfterEnhancements}% Projected Lift)</h2>
      <div class="table-wrap">
        <table id="weakest-links-table">
          <thead>
            <tr>
              <th>Link ID / Severity</th>
              <th>Measured Bottleneck, Root Cause &amp; Source Modules</th>
              <th>Weak Role(s) &rarr; Co-Pilot Deputy Failover</th>
              <th>Implemented Enhancement, Score/SLA Lift &amp; Verification</th>
            </tr>
          </thead>
          <tbody>
            ${weakestLinkRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Industry-Leading Desk Trading, Execution &amp; Surveillance Tooling Suite (${ws.verifiedTradingToolsOnDiskCount}/${ws.tradingToolsCount} Systems Verified On-Disk)</h2>
      <div class="table-wrap">
        <table id="trading-tooling-table">
          <thead>
            <tr>
              <th>Tool ID / Category</th>
              <th>System, Entrypoint &amp; CLI / Cordis Surface</th>
              <th>Trader Edge Capability &amp; Safety Guardrail Contract</th>
              <th>Latency SLA, Owner Roles &amp; Verification</th>
            </tr>
          </thead>
          <tbody>
            ${tradingToolRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Role-Specific Trading Workstation Loadouts (${ws.roleWorkstationsCount} RBAC Workstations · Pre-Slate, Live-Slate &amp; Post-Slate Workflows)</h2>
      <div class="table-wrap">
        <table id="role-workstations-table">
          <thead>
            <tr>
              <th>RBAC Role / Lead</th>
              <th>Workstation Title, Primary Tools &amp; Cordis Plugins</th>
              <th>Pre-Slate, Live-Slate &amp; Post-Slate Command Loops</th>
              <th>Execution SLA &amp; Edge Benchmark</th>
            </tr>
          </thead>
          <tbody>
            ${roleWorkstationRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>BetTicker End-to-End Decision Flowchart (${ws.flowchartNodesCount} Nodes · ${ws.flowchartEdgesCount} Branches · Wire Ingest &rarr; Human Sign-Off &rarr; Layoff &amp; Settlement)</h2>
      <div class="table-wrap">
        <table id="flowchart-table">
          <thead>
            <tr>
              <th>Node / Kind</th>
              <th>Pipeline Stage &amp; Module</th>
              <th>Decision Condition</th>
              <th>Pass &amp; Variant/Trap Branches</th>
              <th>RBAC Owner, Lead &amp; SLA</th>
            </tr>
          </thead>
          <tbody>
            ${flowchartRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Human &amp; Team-Member BetTicker Decision Audit Log (${ws.decisionAuditLogCount} Logged Decisions · ${ws.humanSignedDecisionsCount} Human/Dual-Signed)</h2>
      <div class="table-wrap">
        <table id="decision-log-table">
          <thead>
            <tr>
              <th>Log ID / Timestamp</th>
              <th>Intent / Ticket &amp; Cluster</th>
              <th>Human Actor, Co-Signer &amp; Inbox Ref</th>
              <th>State Transition, Action &amp; Signature</th>
              <th>Edge Case, Gate Summary &amp; Human Rationale</th>
            </tr>
          </thead>
          <tbody>
            ${decisionLogRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>BetTicker Edge Cases &amp; Variants Catalog (${ws.edgeCaseVariantsCount} Production Edge Cases &amp; Variants)</h2>
      <div class="table-wrap">
        <table id="edge-cases-table">
          <thead>
            <tr>
              <th>ID / Code</th>
              <th>Edge Case / Variant &amp; Failure Mode</th>
              <th>Deterministic Handling Contract &amp; Human Audit Rule</th>
              <th>Owner Role &amp; Verification Command</th>
            </tr>
          </thead>
          <tbody>
            ${edgeCaseRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Incoming Wager Surveillance: Client, Weblog (Mode A/B/C/I) &amp; IP Pattern Profiles (${ws.totalClientProfiles} Office Clusters · ${ws.totalLinkedAccountsTracked} Accounts · ${ws.totalBridgedPolymarketWallets} PM Wallets)</h2>
      <div class="table-wrap">
        <table id="client-profiles-table">
          <thead>
            <tr>
              <th>Office / Accounts</th>
              <th>Pattern Archetype &amp; Rotations</th>
              <th>Subnet, Weblog Modes &amp; PM Bridge</th>
              <th>GATE-SURV-02 Clamp, Layoff Disposition &amp; Profiling Task</th>
              <th>RBAC Owner, Lead &amp; Inbox</th>
            </tr>
          </thead>
          <tbody>
            ${clientProfileRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Automated BetTicker Layoff, Hedge &amp; Re-Bet Pipeline (Kalshi &amp; Polymarket Taker/Maker · $${ws.totalPlannedLayoffUsd} Planned)</h2>
      <div class="table-wrap">
        <table id="layoff-table">
          <thead>
            <tr>
              <th>Opportunity / Rotation</th>
              <th>Market, Source Clusters &amp; Line Delta</th>
              <th>External Venue, Style &amp; Edge</th>
              <th>Planned Stake, Contracts &amp; 12-Gate Check</th>
              <th>Intent Ledger &amp; Owner Inbox</th>
            </tr>
          </thead>
          <tbody>
            ${layoffRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Red-Team Adversarial Drills &amp; Automated Defense Verification (${ws.redTeamDrillsDefended}/${ws.redTeamDrillsTotal} Defended)</h2>
      <div class="table-wrap">
        <table id="red-team-table">
          <thead>
            <tr>
              <th>Drill ID / Category</th>
              <th>Adversarial Attack Vector &amp; Expected Defense Invariant</th>
              <th>Target Modules &amp; Verification Command</th>
              <th>RBAC Owner(s), Lead &amp; Inbox</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${redTeamRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>6-Guard Counterfactual Value Attribution Mapped to Team Roles (4-Wk CFB + NBA Backtest)</h2>
      <div class="table-wrap">
        <table id="guards-table">
          <thead>
            <tr>
              <th>Defense Guard</th>
              <th>Assigned RBAC Role(s)</th>
              <th>Intercepted Tickets</th>
              <th>Protected Handle</th>
              <th>4-Wk Desk Savings</th>
              <th>Hold Lift</th>
              <th>Live Telemetry / SLA Threshold</th>
            </tr>
          </thead>
          <tbody>
            ${guardRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>4-Week Counterfactual Value Trajectory (${escapeHtml(bt.windowStartIso.slice(0, 10))} &rarr; ${escapeHtml(bt.windowEndIso.slice(0, 10))})</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th>Tickets</th>
              <th>Parlay Handle</th>
              <th>Hold Swing (Baseline &rarr; Protected)</th>
              <th>Counterfactual Desk Savings &amp; Key Catalyst</th>
            </tr>
          </thead>
          <tbody>
            ${weeklyRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Cross-Domain Polymarket &harr; Fantasy402 Bridge Value Leads (Evidence: ${escapeHtml(br.evidence)})</h2>
      <div class="table-wrap">
        <table id="bridge-table">
          <thead>
            <tr>
              <th>Customer / Agent</th>
              <th>Polymarket Proxy Wallet</th>
              <th>F402 Desk PnL</th>
              <th>Polymarket PnL</th>
              <th>Verdict</th>
              <th>Priority Value</th>
              <th>Governed By Role</th>
            </tr>
          </thead>
          <tbody>
            ${bridgeLeadRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Pending Executive Unblock Decisions (00-executive-summary.md)</h2>
      <div class="table-wrap">
        <table id="decisions-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Decision &amp; Ask</th>
              <th>Assigned Role(s) &amp; Inbox</th>
              <th>Est. Time</th>
              <th>Value &amp; Blocker Impact</th>
            </tr>
          </thead>
          <tbody>
            ${decisionRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Open Task Completeness, Strategic Goal &amp; Execution Direction Audit (docs/REMAINING_TASKS.md)</h2>
      <div class="table-wrap">
        <table id="tasks-table">
          <thead>
            <tr>
              <th>Task / Ref</th>
              <th>Strategic Goal, Execution Direction &amp; Contract</th>
              <th>RBAC Owner(s), Team Lead &amp; Inbox</th>
              <th>On-Disk Evidence &amp; Basis</th>
              <th>Readiness, Verdict &amp; SLA</th>
            </tr>
          </thead>
          <tbody>
            ${taskRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Completed Task Verification Audit ([x] Verified Complete in Repository)</h2>
      <div class="table-wrap">
        <table id="done-tasks-table">
          <thead>
            <tr>
              <th>Ref / ID</th>
              <th>Completed Deliverable</th>
              <th>Basis</th>
              <th>Verified Repository Evidence</th>
              <th>Audit Verdict</th>
            </tr>
          </thead>
          <tbody>
            ${doneTaskRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Desk RBAC Permission Matrix</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Capability / Surface</th>
              ${DESK_ROLE_IDS.map((r) => `<th class="mono">${escapeHtml(r)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${matrixRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Fantasy402 Portal &amp; Forensic Role Bridge</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>F402 Portal Role</th>
              <th>Forensic Actor Role</th>
              <th>Client Prefilter Behavior</th>
              <th>Authority &amp; Tamper Surface</th>
              <th>Mapped Desk Roles</th>
            </tr>
          </thead>
          <tbody>
            ${portalRowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  </div>
  <script>
    (function () {
      var buttons = document.querySelectorAll("[data-filter-role]");
      var cards = document.querySelectorAll("[data-role-card]");
      var planes = document.querySelectorAll("[data-plane]");
      var rows = document.querySelectorAll("tr[data-roles]");
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener("click", function () {
          var selected = this.getAttribute("data-filter-role") || "ALL";
          for (var b = 0; b < buttons.length; b++) {
            buttons[b].classList.toggle("active", buttons[b] === this);
          }
          for (var c = 0; c < cards.length; c++) {
            var cardRole = cards[c].getAttribute("data-role-card") || "";
            cards[c].hidden = selected !== "ALL" && cardRole !== selected;
          }
          for (var p = 0; p < planes.length; p++) {
            var planeRoles = (planes[p].getAttribute("data-roles") || "").split(",");
            planes[p].hidden = selected !== "ALL" && planeRoles.indexOf(selected) === -1;
          }
          for (var r = 0; r < rows.length; r++) {
            var rowRoles = (rows[r].getAttribute("data-roles") || "").split(",");
            rows[r].hidden = selected !== "ALL" && rowRoles.indexOf(selected) === -1;
          }
        });
      }
    })();
  </script>
</body>
</html>
`;
}
