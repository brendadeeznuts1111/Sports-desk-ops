/**
 * @file lib/probe_retention.ts
 * @description Decide which probe runs to keep.
 *
 * Probe runs accumulated while the request envelope was being worked out: 18 directories, 52 files, and
 * up to ten attempts at the same operation. Retention keeps two things and deletes the rest:
 *
 *  - the newest N runs, so recent failures are still inspectable;
 *  - the newest run that produced a 2xx for each operation, so the evidence for a working call never
 *    disappears because it is old.
 */

export interface RunOperation {
  readonly operation: string;
  readonly status: number;
}

export interface ProbeRun {
  /** Directory name, `YYYY-MM-DDTHH-MM-SS-mmmZ`; sorts chronologically. */
  readonly id: string;
  readonly operations: readonly RunOperation[];
}

export interface RetentionPlan {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
}

export function planRetention(
  runs: readonly ProbeRun[],
  options: { keep: number },
): RetentionPlan {
  const ordered = [...runs].sort((a, b) => a.id.localeCompare(b.id));
  const keep = new Set<string>();

  // `slice(-0)` is `slice(0)`, which keeps every run; guard the zero case explicitly.
  const keepCount = Math.max(0, options.keep);
  if (keepCount > 0) {
    for (const run of ordered.slice(-keepCount)) keep.add(run.id);
  }

  // Newest successful run per operation.
  const seen = new Set<string>();
  for (const run of [...ordered].reverse()) {
    for (const op of run.operations) {
      if (op.status < 200 || op.status >= 300) continue;
      if (seen.has(op.operation)) continue;
      seen.add(op.operation);
      keep.add(run.id);
    }
  }

  return {
    keep: [...keep].sort(),
    remove: ordered.map((run) => run.id).filter((id) => !keep.has(id)),
  };
}

export type ScratchArtifactClassification =
  | "scratch-pii-backup"
  | "scratch-raw-har-dump"
  | "scratch-raw-dump"
  | "scratch-paste"
  | "scratch-temp-extract"
  | "scratch-audit-working-set";

export interface ScratchPiiArtifactPolicy {
  readonly path: string;
  readonly classification: ScratchArtifactClassification;
  readonly retentionDays: number;
  readonly inDeletionPath: boolean;
  readonly excludeFromBackups: boolean;
  readonly ownerRole: "compliance" | "operator";
}

/** Canonical retention & backup-exclusion table for git-ignored Scratch PII artifacts (#19). */
export const SCRATCH_PII_ARTIFACT_POLICIES: readonly ScratchPiiArtifactPolicy[] =
  [
    {
      path: "Scratch/enriched_customers_full.json.bak",
      classification: "scratch-pii-backup",
      retentionDays: 0,
      inDeletionPath: true,
      excludeFromBackups: true,
      ownerRole: "compliance",
    },
    {
      path: "Scratch/f402-har-and-getListAgenstByAgent-unformatted.txt.rtf",
      classification: "scratch-raw-har-dump",
      retentionDays: 0,
      inDeletionPath: true,
      excludeFromBackups: true,
      ownerRole: "compliance",
    },
    {
      path: "Scratch/Untitled.txt.rtf",
      classification: "scratch-raw-dump",
      retentionDays: 0,
      inDeletionPath: true,
      excludeFromBackups: true,
      ownerRole: "compliance",
    },
    {
      path: "Scratch/pastes/analysis-cp-baseball.json",
      classification: "scratch-paste",
      retentionDays: 7,
      inDeletionPath: true,
      excludeFromBackups: true,
      ownerRole: "operator",
    },
    {
      path: "Scratch/.tmp-f402-extract.txt",
      classification: "scratch-temp-extract",
      retentionDays: 0,
      inDeletionPath: true,
      excludeFromBackups: true,
      ownerRole: "operator",
    },
    {
      path: "Scratch/docs-audit/",
      classification: "scratch-audit-working-set",
      retentionDays: 14,
      inDeletionPath: true,
      excludeFromBackups: true,
      ownerRole: "operator",
    },
  ] as const;

export interface ObservedScratchArtifact {
  readonly path: string;
  readonly mtimeMs: number;
}

export interface ScratchPiiRetentionResult {
  readonly deleteNow: readonly string[];
  readonly retainWithinWindow: readonly string[];
  readonly unclassifiedPaths: readonly string[];
  readonly gdprDeleteVerifiable: boolean;
}

export function planScratchPiiRetention(
  observed: readonly ObservedScratchArtifact[],
  nowMs: number,
): ScratchPiiRetentionResult {
  const deleteNow: string[] = [];
  const retainWithinWindow: string[] = [];
  const unclassifiedPaths: string[] = [];
  const dayMs = 86_400_000;

  for (const item of observed) {
    const policy = SCRATCH_PII_ARTIFACT_POLICIES.find(
      (p) =>
        p.path === item.path ||
        (p.path.endsWith("/") && item.path.startsWith(p.path)),
    );
    if (policy === undefined) {
      unclassifiedPaths.push(item.path);
      deleteNow.push(item.path);
      continue;
    }
    const maxAgeMs = policy.retentionDays * dayMs;
    if (policy.retentionDays <= 0 || nowMs - item.mtimeMs >= maxAgeMs) {
      deleteNow.push(item.path);
    } else {
      retainWithinWindow.push(item.path);
    }
  }

  return {
    deleteNow: [...deleteNow].sort(),
    retainWithinWindow: [...retainWithinWindow].sort(),
    unclassifiedPaths: [...unclassifiedPaths].sort(),
    gdprDeleteVerifiable:
      unclassifiedPaths.length === 0 &&
      SCRATCH_PII_ARTIFACT_POLICIES.every(
        (p) => p.inDeletionPath && p.excludeFromBackups,
      ),
  };
}

export function verifyScratchPiiDeletion(
  existsOnDisk: (path: string) => boolean,
): {
  readonly clean: boolean;
  readonly survivingZeroRetentionPaths: readonly string[];
} {
  const surviving = SCRATCH_PII_ARTIFACT_POLICIES.filter(
    (p) => p.retentionDays === 0 && existsOnDisk(p.path),
  ).map((p) => p.path);
  return {
    clean: surviving.length === 0,
    survivingZeroRetentionPaths: surviving,
  };
}

/** Auth-adjacent Chrome profile artifacts tracked under #18. */
export const AUTH_ADJACENT_PROFILE_PATHS = [
  "Scratch/webview-profile/Default/Web Data",
  "Scratch/webview-profile/NetworkCache",
  "scratch/f402-manager-webview-profile",
] as const;

/**
 * Counts rendered `data-pass="<value>"` attributes while ignoring the unrendered vendor JS
 * concatenation template `data-pass="'+r+'"` (#18). Never returns or logs matched values.
 */
export function countRenderedDataPassAttributes(content: string): number {
  const matches = content.matchAll(/data-pass="([^"]*)"/g);
  let count = 0;
  for (const match of matches) {
    const inner = (match[1] ?? "").trim();
    if (inner === "" || inner.startsWith("'+") || inner.startsWith("' +")) {
      continue;
    }
    count += 1;
  }
  return count;
}

export interface AuthAdjacentScrubAuditInput {
  readonly scrubbedBeforeItem2Session: boolean;
  readonly item2SessionExecuted: boolean;
  readonly postSessionGrepped: boolean;
  readonly cacheSampleText: string;
  readonly liveAgentIdInWebData: boolean;
  readonly permissionsRestricted0600: boolean;
  readonly excludedFromBackups: boolean;
}

export interface AuthAdjacentScrubAuditVerdict {
  readonly sequencingValid: boolean;
  readonly renderedDataPassCount: number;
  readonly readyToCloseIssue18: boolean;
  readonly blockers: readonly string[];
}

export function auditAuthAdjacentProfileScrub(
  input: AuthAdjacentScrubAuditInput,
): AuthAdjacentScrubAuditVerdict {
  const blockers: string[] = [];
  const renderedCount = countRenderedDataPassAttributes(input.cacheSampleText);
  if (!input.scrubbedBeforeItem2Session) {
    blockers.push("pre-test scrub has not run before item-2 search session");
  }
  if (input.item2SessionExecuted && !input.scrubbedBeforeItem2Session) {
    blockers.push(
      "sequencing violation: item-2 ran before profile was scrubbed",
    );
  }
  if (!input.permissionsRestricted0600) {
    blockers.push("profile permissions must be restricted to 0600/0700");
  }
  if (!input.excludedFromBackups) {
    blockers.push("webview-profile must be excluded from host backups");
  }
  if (input.liveAgentIdInWebData) {
    blockers.push("live agent id still present in Chrome Web Data SQLite");
  }
  if (renderedCount > 0) {
    blockers.push(`rendered data-pass attribute count is ${renderedCount}`);
  }
  if (!input.postSessionGrepped) {
    blockers.push("post-test grep after item-2 session has not completed");
  }
  return {
    sequencingValid:
      input.scrubbedBeforeItem2Session || !input.item2SessionExecuted,
    renderedDataPassCount: renderedCount,
    readyToCloseIssue18: blockers.length === 0,
    blockers,
  };
}

export type PendingWrongAnswerCode =
  | "N1_NEGATIVE_BALANCE_OR_RISK"
  | "N2_RECONCILIATION_MISMATCH"
  | "N3_UNRESOLVED_CUSTOMER_ID"
  | "N4_FROZEN_OR_DELETED_AGENT"
  | "N5_INVALID_SETTLEMENT_TIMESTAMP"
  | "N6_MISSING_PLACEMENT_TIMESTAMP"
  | "N7_AMBIGUOUS_BARE_P_STATUS"
  | "N8_DUPLICATE_TICKET_LEG_KEY"
  | "N9_CANCELED_ROW_IN_PENDING"
  | "N10_PENDING_CAPTURE_OLDER_THAN_1H"
  | "N11_DERIVED_FROM_DISPLAY_CAPTURE"
  | "N12_LEDGER_ROW_MISSING_WAGER_KEY"
  | "N13_NON_WAGER_ADJUSTMENT_INCLUDED"
  | "N14_DUPLICATE_TIMESTAMP_AMOUNT";

export interface PendingCountCandidateInput {
  readonly sourceKind: "authoritative-server-log" | "display-capture-har";
  readonly captureAgeSeconds: number;
  readonly hasNegativeBalanceOrRisk: boolean;
  readonly placedMinusSettledVoidedMatchesPending: boolean;
  readonly unknownCustomerIds: number;
  readonly frozenAgentsIncludedWithoutRule: number;
  readonly invalidSettlementTimestamps: number;
  readonly missingPlacementTimestamps: number;
  readonly ambiguousBarePRows: number;
  readonly duplicateTicketKeys: number;
  readonly canceledRowsInPending: number;
  readonly keylessLedgerRowsCounted: number;
  readonly nonWagerRowsIncluded: number;
  readonly undedupedSameTimestampAmountRows: number;
}

/** 14-case wrong-answer detector for pending-customer counts (`#23` / `08-pending-customer-count-feasibility.md`). */
export function detectPendingCountWrongAnswers(
  input: PendingCountCandidateInput,
): {
  readonly quotable: boolean;
  readonly triggered: readonly PendingWrongAnswerCode[];
} {
  const triggered: PendingWrongAnswerCode[] = [];
  if (input.hasNegativeBalanceOrRisk) {
    triggered.push("N1_NEGATIVE_BALANCE_OR_RISK");
  }
  if (!input.placedMinusSettledVoidedMatchesPending) {
    triggered.push("N2_RECONCILIATION_MISMATCH");
  }
  if (input.unknownCustomerIds > 0) {
    triggered.push("N3_UNRESOLVED_CUSTOMER_ID");
  }
  if (input.frozenAgentsIncludedWithoutRule > 0) {
    triggered.push("N4_FROZEN_OR_DELETED_AGENT");
  }
  if (input.invalidSettlementTimestamps > 0) {
    triggered.push("N5_INVALID_SETTLEMENT_TIMESTAMP");
  }
  if (input.missingPlacementTimestamps > 0) {
    triggered.push("N6_MISSING_PLACEMENT_TIMESTAMP");
  }
  if (input.ambiguousBarePRows > 0) {
    triggered.push("N7_AMBIGUOUS_BARE_P_STATUS");
  }
  if (input.duplicateTicketKeys > 0) {
    triggered.push("N8_DUPLICATE_TICKET_LEG_KEY");
  }
  if (input.canceledRowsInPending > 0) {
    triggered.push("N9_CANCELED_ROW_IN_PENDING");
  }
  if (input.captureAgeSeconds > 3600) {
    triggered.push("N10_PENDING_CAPTURE_OLDER_THAN_1H");
  }
  if (input.sourceKind !== "authoritative-server-log") {
    triggered.push("N11_DERIVED_FROM_DISPLAY_CAPTURE");
  }
  if (input.keylessLedgerRowsCounted > 0) {
    triggered.push("N12_LEDGER_ROW_MISSING_WAGER_KEY");
  }
  if (input.nonWagerRowsIncluded > 0) {
    triggered.push("N13_NON_WAGER_ADJUSTMENT_INCLUDED");
  }
  if (input.undedupedSameTimestampAmountRows > 0) {
    triggered.push("N14_DUPLICATE_TIMESTAMP_AMOUNT");
  }
  return {
    quotable: triggered.length === 0,
    triggered,
  };
}

/** Verifies the BB55103 single-customer balance formula (`Available = Current - Pending + CreditLimit`). */
export function verifyCustomerAccountBalanceInvariant(account: {
  readonly currentBalanceCents: number;
  readonly pendingWagerBalanceCents: number;
  readonly creditLimitCents: number;
  readonly availableBalanceCents: number;
}): boolean {
  const expected =
    account.currentBalanceCents -
    account.pendingWagerBalanceCents +
    account.creditLimitCents;
  return expected === account.availableBalanceCents;
}

export const DEFENSE_PAUSE_EXPIRY_ISO = "2026-12-03T00:00:00.000Z";

export const AUTHZ_MATRIX_SIX_OPERATIONS = [
  "getMasterSheet",
  "getListAgenstByAgent",
  "searchCustomerAdmin",
  "getTransactions",
  "getAuthorizations",
  "updateDistribution",
] as const;

export interface BearerAndLedgerDecisionInput {
  readonly nowIso: string;
  readonly lowPrivilegeTestAccountProvisioned: boolean;
  readonly writtenComplianceAndOperatorTamperAuth: boolean;
  readonly serverTeamOnlyApproval: boolean;
  readonly mutationAuthorizedForUpdateDistribution: boolean;
  readonly verifiedOperations: readonly string[];
}

export interface BearerAndLedgerDecisionVerdict {
  readonly pauseExpired: boolean;
  readonly reopenAcceptanceDeliberately: boolean;
  readonly authorizationValid: boolean;
  readonly missingOperations: readonly string[];
  readonly readyToCloseIssue17: boolean;
}

/** Evaluates the three owner decisions and 2026-12-03 expiry control on `#17`. */
export function evaluateBearerAndLedgerDecisionGate(
  input: BearerAndLedgerDecisionInput,
): BearerAndLedgerDecisionVerdict {
  const nowMs = Date.parse(input.nowIso);
  const expiryMs = Date.parse(DEFENSE_PAUSE_EXPIRY_ISO);
  const pauseExpired = Number.isFinite(nowMs) && nowMs >= expiryMs;
  // Server-team OK alone is explicitly rejected by #17; written compliance + operator auth is mandatory.
  const authorizationValid =
    input.writtenComplianceAndOperatorTamperAuth &&
    !input.serverTeamOnlyApproval;
  const requiredOps = input.mutationAuthorizedForUpdateDistribution
    ? AUTHZ_MATRIX_SIX_OPERATIONS
    : AUTHZ_MATRIX_SIX_OPERATIONS.filter((op) => op !== "updateDistribution");
  const verifiedSet = new Set(input.verifiedOperations);
  const missingOperations = requiredOps.filter((op) => !verifiedSet.has(op));
  const readyToCloseIssue17 =
    input.lowPrivilegeTestAccountProvisioned &&
    authorizationValid &&
    missingOperations.length === 0;

  return {
    pauseExpired,
    reopenAcceptanceDeliberately: pauseExpired && !readyToCloseIssue17,
    authorizationValid,
    missingOperations,
    readyToCloseIssue17,
  };
}
