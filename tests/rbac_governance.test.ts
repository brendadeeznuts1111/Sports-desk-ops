import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  AUTOBET_LAYOFF_OPPORTUNITIES,
  AUTOBET_LAYOFF_STAGES,
  BET_TICKER_DECISION_AUDIT_LOG,
  BET_TICKER_EDGE_CASE_VARIANTS,
  BET_TICKER_FLOWCHART_EDGES,
  BET_TICKER_FLOWCHART_NODES,
  CHANNEL_IDS,
  CHANNEL_INTEGRATIONS,
  DESK_ROLES,
  DESK_ROLE_IDS,
  DESK_TRADING_TOOLING_SUITE,
  DESK_WEAKEST_LINK_DIAGNOSTICS,
  F402_PORTAL_ROLES,
  FORENSIC_ACTOR_ROLES,
  PORTAL_ROLE_CONTRACTS,
  RBAC_PERMISSION_MATRIX,
  RED_TEAM_DRILLS,
  ROLE_TRADING_WORKSTATIONS,
  WEBLOG_MODE_CONTRACTS,
  buildClientWagerPatternProfiles,
  buildGovernanceDashboardSection,
  buildGovernanceReport,
  parseExecutiveDecisionsMarkdown,
  parseOracleGatesManifest,
  parseRemainingTasksMarkdown,
  renderBetTickerMermaidFlowchart,
  renderStandaloneGovernanceHtml,
  resolveDeskRolesFromText,
} from "../lib/rbac_governance.ts";
import { runGovernanceCli } from "../scripts/governance_check.ts";

describe("RBAC role taxonomy, team leads, email/inbox accountability & channel bindings", () => {
  test("every DeskRoleId has a complete specification, team lead, @bookdeskops.com email, inbox route, and channel bindings", () => {
    const seenEmails = new Set<string>();
    const seenInboxes = new Set<string>();

    for (const roleId of DESK_ROLE_IDS) {
      const spec = DESK_ROLES[roleId];
      expect(spec.id).toBe(roleId);
      expect(spec.label.length).toBeGreaterThan(2);
      expect(F402_PORTAL_ROLES).toContain(spec.f402Counterpart);
      expect(FORENSIC_ACTOR_ROLES).toContain(spec.forensicCounterpart);
      expect(spec.teamLead.length).toBeGreaterThan(5);
      expect(DESK_ROLE_IDS).toContain(spec.reportsToRole);
      expect(spec.email).toMatch(/^[a-z0-9-]+@bookdeskops\.com$/);
      expect(spec.inboxRoute).toMatch(/^inbox:\/\/[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(spec.ackSlaMinutes).toBeGreaterThan(0);
      expect(spec.ackSlaMinutes).toBeLessThanOrEqual(60);
      expect(spec.primaryChannels.length).toBeGreaterThan(0);
      expect(spec.primaryChannels).toContain("EMAIL_INBOX");
      for (const ch of spec.primaryChannels) {
        expect(CHANNEL_IDS).toContain(ch);
      }
      expect(spec.telegramCommand).toMatch(/^\/[a-z_]+/);
      expect(spec.charter.length).toBeGreaterThan(10);

      seenEmails.add(spec.email);
      seenInboxes.add(spec.inboxRoute);
    }

    // Every role has a distinct email inbox and inbox route
    expect(seenEmails.size).toBe(DESK_ROLE_IDS.length);
    expect(seenInboxes.size).toBe(DESK_ROLE_IDS.length);
  });

  test("CHANNEL_INTEGRATIONS covers all 6 channels and maps to valid DeskRoleIds", () => {
    expect(CHANNEL_INTEGRATIONS.map((c) => c.id)).toEqual([...CHANNEL_IDS]);
    for (const ch of CHANNEL_INTEGRATIONS) {
      expect(ch.label.length).toBeGreaterThan(5);
      expect(ch.entrypoint.length).toBeGreaterThan(5);
      expect(ch.commandsOrRoutes.length).toBeGreaterThan(0);
      expect(ch.subscribedRoles.length).toBeGreaterThan(0);
      for (const roleId of ch.subscribedRoles) {
        expect(DESK_ROLE_IDS).toContain(roleId);
      }
      expect(ch.status).toBe("ACTIVE");
    }
  });

  test("RBAC_PERMISSION_MATRIX covers every DeskRoleId across all capabilities", () => {
    expect(RBAC_PERMISSION_MATRIX.length).toBeGreaterThanOrEqual(6);
    for (const row of RBAC_PERMISSION_MATRIX) {
      for (const roleId of DESK_ROLE_IDS) {
        expect(["ALLOWED", "GUARDED", "DENIED"]).toContain(
          row.permissions[roleId],
        );
      }
    }
  });

  test("PORTAL_ROLE_CONTRACTS covers M, A, P, U and maps back to DeskRoleId", () => {
    expect(PORTAL_ROLE_CONTRACTS.map((c) => c.role)).toEqual([
      "M",
      "A",
      "P",
      "U",
    ]);
    for (const contract of PORTAL_ROLE_CONTRACTS) {
      for (const mapped of contract.mappedDeskRoles) {
        expect(DESK_ROLE_IDS).toContain(mapped);
      }
    }
  });

  test("resolveDeskRolesFromText normalizes multi-owner task strings", () => {
    expect(resolveDeskRolesFromText("client/seam workstream")).toEqual([
      "client/seam",
    ]);
    expect(
      resolveDeskRolesFromText(
        "security/operator (needs vendor + server team + business owner)",
      ),
    ).toEqual(["security/operator", "server-team-lead", "business-owner"]);
    expect(
      resolveDeskRolesFromText("operator + settlement team + compliance"),
    ).toEqual(["operator", "settlement", "compliance"]);
    expect(
      resolveDeskRolesFromText("settlement team + risk-desk-analyst"),
    ).toEqual(["settlement", "RISK_DESK_ANALYST"]);
    expect(resolveDeskRolesFromText(null)).toEqual([]);
  });
});

describe("task governance & SLA parser", () => {
  test("live repository passes all RBAC, inbox accountability, channel & task governance checks", () => {
    const report = buildGovernanceReport({
      now: new Date("2026-11-09T12:00:00Z"),
    });
    expect(report.summary.gatePassed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary.unownedTasks).toBe(0);
    expect(report.summary.openTasks).toBeGreaterThan(0);
    expect(report.summary.doneTasks).toBeGreaterThan(0);
    expect(report.summary.readyGates).toBe(4);
    expect(report.summary.totalGates).toBe(4);
    expect(report.summary.pendingDecisions).toBe(3);
    expect(report.summary.pendingDecisionHours).toBe(4);
    expect(report.summary.activeChannelsCount).toBe(CHANNEL_IDS.length);
    expect(report.summary.totalRoleInboxes).toBe(DESK_ROLE_IDS.length);
    expect(report.ownerScorecards.length).toBe(DESK_ROLE_IDS.length);
    expect(report.channelIntegrations.length).toBe(CHANNEL_IDS.length);

    // Task Completeness, Direction & Goal Audit assertions
    expect(report.taskAudit.auditPassed).toBe(true);
    expect(report.taskAudit.openWithGoalCount).toBe(report.summary.openTasks);
    expect(report.taskAudit.openWithDirectionCount).toBe(
      report.summary.openTasks,
    );
    expect(report.taskAudit.openWithCommandCount).toBe(
      report.summary.openTasks,
    );
    expect(report.taskAudit.doneVerifiedCompleteCount).toBe(
      report.summary.doneTasks,
    );
    expect(report.taskAudit.missingCitedPaths).toBe(0);
    expect(report.taskAudit.verifiedCitedPaths).toBe(
      report.taskAudit.totalCitedPaths,
    );
    expect(report.taskAudit.totalCitedPaths).toBeGreaterThan(0);
    expect(report.taskAudit.overallCompletionPct).toBeGreaterThanOrEqual(90);

    for (const task of report.tasks) {
      expect(task.missingPaths).toEqual([]);
      expect(task.ownerLead.length).toBeGreaterThan(5);
      expect(task.ownerEmails.length).toBeGreaterThan(0);
      expect(task.escalationChannel).toContain("inbox://");
      if (task.status === "open") {
        expect(task.goal?.length ?? 0).toBeGreaterThanOrEqual(15);
        expect(task.direction?.length ?? 0).toBeGreaterThanOrEqual(15);
        expect(task.nextCommand?.length ?? 0).toBeGreaterThan(3);
        expect(["READY_TO_CLOSE", "ON_TRACK_WITH_DIRECTION"]).toContain(
          task.auditVerdict,
        );
      } else {
        expect(task.auditVerdict).toBe("VERIFIED_COMPLETE");
        expect(task.completionPct).toBe(100);
      }
    }
  });

  test("detects missing owner, unresolved ref, missing basis, missing goal/direction, missing evidence path, and overdue expiry", () => {
    const syntheticTasksMd = [
      "| Ref | Task | Basis record | Closes against |",
      "| :--- | :--- | :--- | :--- |",
      "| `RT-VALID` | P0.1 | `[CODE]` | test |",
      "",
      "- [ ] **P0.1 Unowned and expired task**",
      "  - **Ref:** `RT-MISSING-FROM-TABLE`",
      "  - **Expiry:** if not funded by **2026-10-01** (expired)",
      "  - **Done when:** test passes in `docs/nonexistent-evidence-file.json`",
      "  - **Blocked by:** nothing",
      "- [x] `[UNVERIFIED]` Completed task (`RT-VALID`) with unverified basis and `lib/nonexistent_module.ts`",
    ].join("\n");

    const report = buildGovernanceReport({
      now: new Date("2026-11-09T12:00:00Z"),
      tasksMarkdown: syntheticTasksMd,
      executiveSummaryMarkdown: "",
      oracleManifest: {
        harRedactionProofGate: {
          status: "blocked",
          ownerRole: "unknown-role",
          requires: "capture",
        },
      },
    });

    expect(report.summary.gatePassed).toBe(false);
    expect(report.taskAudit.auditPassed).toBe(false);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("TASK_MISSING_OWNER");
    expect(codes).toContain("TASK_UNRESOLVED_REF");
    expect(codes).toContain("TASK_MISSING_BASIS");
    expect(codes).toContain("TASK_MISSING_GOAL");
    expect(codes).toContain("TASK_MISSING_DIRECTION");
    expect(codes).toContain("TASK_EVIDENCE_MISSING");
    expect(codes).toContain("DONE_TASK_UNVERIFIED_BASIS");
    expect(codes).toContain("TASK_EXPIRY_OVERDUE");
    expect(codes).toContain("ORACLE_GATE_OWNER_INVALID");
    expect(codes).toContain("ORACLE_GATE_BLOCKED");
  });

  test("computes DUE_SOON when expiry is within 7 days", () => {
    const md = [
      "| Ref | Task | Basis record | Closes against |",
      "| :--- | :--- | :--- | :--- |",
      "| `RT-DEFENSE-MEASURE` | P0.6 | `[CODE]` | test |",
      "",
      "- [ ] **P0.6 Measure defenses**",
      "  - **Ref:** `RT-DEFENSE-MEASURE`",
      "  - **Owner:** security/operator",
      "  - **Goal:** Verify server-side Bearer claim enforcement and sink escaping.",
      "  - **Direction:** Run `bun run governance:check` and update `docs/REMAINING_TASKS.md`.",
      "  - **Expiry:** if item 2 is not funded by **2026-12-03** (30 days)",
      "  - **Basis:** `[CODE]`",
      "  - **Done when:** verified",
      "  - **Blocked by:** test account",
    ].join("\n");

    const { tasks } = parseRemainingTasksMarkdown(
      md,
      Date.parse("2026-11-29T12:00:00Z"),
    );
    expect(tasks[0]?.slaState).toBe("DUE_SOON");
    expect(tasks[0]?.daysUntilExpiry).toBe(5);
    expect(tasks[0]?.auditVerdict).toBe("READY_TO_CLOSE");
    expect(tasks[0]?.completionPct).toBe(95);
  });

  test("parses executive decisions and oracle manifest", () => {
    const decisions = parseExecutiveDecisionsMarkdown(
      [
        "| # | Decision | Owner | Ask | Time |",
        "| --- | --- | --- | --- | --- |",
        "| 1 | Provision account | **Business owner** | One account | ~1 hour |",
        "| 2 | Authorize testing | **Compliance/legal + operator** | Scope | ~1 hour |",
        "| 3 | Bearer test | **Server team lead** | Six requests | **~2 hours** |",
      ].join("\n"),
    );
    expect(decisions.length).toBe(3);
    expect(decisions[1]?.owners).toEqual(["operator", "compliance"]);
    expect(decisions[2]?.estimatedHours).toBe(2);

    const gates = parseOracleGatesManifest({
      harRedactionProofGate: {
        status: "ready",
        ownerRole: "operator",
        requires: "proof",
      },
    });
    expect(gates.length).toBe(1);
    expect(gates[0]?.validOwnerRole).toBe(true);
  });
});

describe("bird's-eye telemetry, 6-guard value attribution & plane rollups", () => {
  test("synthesizes 4-week counterfactual value, cross-domain bridge, combo uniqueness, and live syndicate telemetry", () => {
    const report = buildGovernanceReport({
      now: new Date("2026-11-09T12:00:00Z"),
    });
    const vt = report.valueTelemetry;

    // 4-Week Counterfactual Backtest Value
    expect(vt.backtest4Wk.totalCounterfactualSavingsUsd4Wk).toBeGreaterThan(0);
    expect(vt.backtest4Wk.dailyProtectionRateUsd).toBeGreaterThan(0);
    expect(vt.backtest4Wk.holdSwingBps).toBeGreaterThan(0);
    expect(vt.backtest4Wk.weeklyBreakdown.length).toBe(4);
    expect(vt.backtest4Wk.guardAttribution.length).toBe(6);
    for (const guard of vt.backtest4Wk.guardAttribution) {
      expect(guard.ownerRoles.length).toBeGreaterThan(0);
      for (const roleId of guard.ownerRoles) {
        expect(DESK_ROLE_IDS).toContain(roleId);
      }
      expect(guard.deskSavingsUsd).toBeGreaterThan(0);
    }

    // Cross-Domain Bridge Value
    expect(vt.crossDomainBridge.customersInBook).toBeGreaterThan(0);
    expect(vt.crossDomainBridge.linkedCustomers).toBeGreaterThan(0);
    expect(vt.crossDomainBridge.priorityUsd).toBeGreaterThan(0);
    expect(vt.crossDomainBridge.leads.length).toBeGreaterThan(0);

    // Combo Uniqueness & Live Feed Telemetry
    expect(vt.comboUniqueness.cfbIndexGames).toBeGreaterThan(0);
    expect(vt.comboUniqueness.chainLeaks).toBe(0);
    expect(vt.liveSyndicateFeed.activeSyndicateWalletsCount).toBeGreaterThan(0);
    expect(vt.liveSyndicateFeed.lockedArtifactsCount).toBeGreaterThan(0);

    // Bird's-Eye Operational Plane Rollups
    expect(vt.planeSummaries.length).toBe(4);
    for (const plane of vt.planeSummaries) {
      expect(plane.roleIds.length).toBeGreaterThan(0);
      expect(plane.planeLead.length).toBeGreaterThan(5);
      expect(plane.planeEmail).toContain("@bookdeskops.com");
      expect(plane.planeInboxRoute).toContain("inbox://");
      expect(plane.activeChannels.length).toBeGreaterThan(0);
      expect(plane.avgHealthScore).toBeGreaterThan(0);
      expect(plane.telemetryHeadline.length).toBeGreaterThan(10);
    }

    // Per-role scorecards carry telemetryPulse, valueSummary, teamLead, email, and inboxStatus
    for (const card of report.ownerScorecards) {
      expect(card.teamLead.length).toBeGreaterThan(5);
      expect(card.email).toContain("@bookdeskops.com");
      expect(card.inboxRoute).toContain("inbox://");
      expect(["INBOX_ZERO", "ACK_PENDING", "ACTION_SLA_ACTIVE", "ESCALATED_TO_LEAD"]).toContain(
        card.inboxStatus,
      );
      expect(card.primaryChannels.length).toBeGreaterThan(0);
      expect(card.telemetryPulse.length).toBeGreaterThan(5);
      expect(card.valueSummary.length).toBeGreaterThan(5);
      expect(
        card.protectedSavingsUsd > 0 || card.priorityExposureUsd > 0,
      ).toBe(true);
    }
  });
});

describe("dashboard section, standalone HTML & CLI", () => {
  test("builds dashboard Markdown section and escapes standalone HTML safely", () => {
    const report = buildGovernanceReport({
      now: new Date("2026-11-09T12:00:00Z"),
    });
    const section = buildGovernanceDashboardSection(report);
    expect(section.id).toBe("rbac-governance");
    expect(section.state).toBe("measured");
    expect(section.body.join("\n")).toContain(
      "Weakest-Link Bottleneck Radar",
    );
    expect(section.body.join("\n")).toContain(
      "Bird's-Eye Operational Planes",
    );
    expect(section.body.join("\n")).toContain(
      "Multi-Channel Integration & Escalation Matrix",
    );
    expect(section.body.join("\n")).toContain(
      "6-Guard Counterfactual Value Attribution",
    );
    expect(section.body.join("\n")).toContain(
      "Open Task Completeness, Direction & Goal Audit",
    );
    expect(section.body.join("\n")).toContain(
      "Completed Task Evidence & Basis Audit",
    );

    const html = renderStandaloneGovernanceHtml(report);
    expect(html).toContain(
      "Bird's-Eye Team Governance, Telemetry, Real Value &amp; Task Completeness Audit",
    );
    expect(html).toContain('data-filter-role="operator"');
    expect(html).toContain('data-role-card="RISK_DESK_ANALYST"');
    expect(html).toContain('data-plane="risk-settlement"');
    expect(html).toContain('id="channels-table"');
    expect(html).toContain('id="weakest-links-table"');
    expect(html).toContain('id="trading-tooling-table"');
    expect(html).toContain('id="role-workstations-table"');
    expect(html).toContain('id="flowchart-table"');
    expect(html).toContain('id="decision-log-table"');
    expect(html).toContain('id="edge-cases-table"');
    expect(html).toContain('id="client-profiles-table"');
    expect(html).toContain('id="layoff-table"');
    expect(html).toContain('id="red-team-table"');
    expect(html).toContain('id="done-tasks-table"');
    expect(html).toContain("ops-desk@bookdeskops.com");
    expect(html).not.toContain(".innerHTML");
  });

  test("wager surveillance, client/weblog/IP pattern profiles, red-team drills, BetTicker layoff pipeline, trading tooling suite, and weakest-link diagnostics are complete", () => {
    const profiles = buildClientWagerPatternProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(10);
    for (const cp of profiles) {
      expect(cp.profileId).toBe(`PROF-${cp.officeAgentId}`);
      expect(DESK_ROLE_IDS).toContain(cp.ownerRole);
      expect(cp.ownerEmail).toContain("@bookdeskops.com");
      expect(cp.inboxRoute).toContain("inbox://");
      expect(cp.modeASessionDwellSeconds).toBeGreaterThan(0);
      expect(cp.mfcsCompositeScore).toBeGreaterThanOrEqual(80);
      expect(cp.bridgedPolymarketWallets.length).toBeGreaterThan(0);
      expect(cp.profilingTask.goal.length).toBeGreaterThanOrEqual(20);
      expect(cp.profilingTask.direction.length).toBeGreaterThan(20);
      expect(cp.profilingTask.verificationCommand).toContain("governance:check");
    }

    expect(WEBLOG_MODE_CONTRACTS.map((m) => m.mode)).toEqual([
      "A",
      "B",
      "C",
      "I",
    ]);
    expect(
      WEBLOG_MODE_CONTRACTS.find((m) => m.mode === "C")?.wireDateFormat,
    ).toBe("YYYY-MM-DD");

    expect(RED_TEAM_DRILLS.length).toBe(6);
    for (const drill of RED_TEAM_DRILLS) {
      expect(drill.status).toBe("VERIFIED_DEFENDED");
      expect(drill.ownerRoles.length).toBeGreaterThan(0);
      expect(drill.targetModules.length).toBeGreaterThan(0);
      expect(drill.verificationCommand.length).toBeGreaterThan(5);
    }

    expect(AUTOBET_LAYOFF_STAGES.length).toBe(5);
    expect(AUTOBET_LAYOFF_OPPORTUNITIES.length).toBeGreaterThanOrEqual(6);
    for (const opp of AUTOBET_LAYOFF_OPPORTUNITIES) {
      expect(["kalshi", "polymarket"]).toContain(opp.externalVenue);
      expect(["taker", "maker"]).toContain(opp.executionStyle);
      expect(opp.edgeBps).toBeGreaterThanOrEqual(opp.sportMinEdgeBps);
      expect(opp.plannedStakeUsd).toBeGreaterThan(0);
      expect(opp.contractsCount).toBeGreaterThan(0);
      expect(DESK_ROLE_IDS).toContain(opp.ownerRole);
    }

    expect(BET_TICKER_FLOWCHART_NODES.length).toBe(10);
    expect(BET_TICKER_FLOWCHART_EDGES.length).toBeGreaterThanOrEqual(14);
    const mermaid = renderBetTickerMermaidFlowchart();
    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain("HUMAN / TEAM-MEMBER AUDIT GATE");

    expect(BET_TICKER_DECISION_AUDIT_LOG.length).toBeGreaterThanOrEqual(10);
    for (const dec of BET_TICKER_DECISION_AUDIT_LOG) {
      expect(DESK_ROLE_IDS).toContain(dec.actorRole);
      expect(dec.actorEmail).toContain("@bookdeskops.com");
      expect(dec.inboxTicketRef).toContain("inbox://");
      expect(dec.humanRationaleNote.length).toBeGreaterThanOrEqual(25);
      expect(dec.auditSignatureHash).toMatch(/^sha256:[0-9a-f]{16}$/);
    }

    expect(BET_TICKER_EDGE_CASE_VARIANTS.length).toBeGreaterThanOrEqual(10);
    for (const ec of BET_TICKER_EDGE_CASE_VARIANTS) {
      expect(DESK_ROLE_IDS).toContain(ec.ownerRole);
      expect(ec.deterministicHandlingContract.length).toBeGreaterThan(20);
      expect(ec.humanAuditRequirement.length).toBeGreaterThan(15);
    }

    expect(DESK_TRADING_TOOLING_SUITE.length).toBe(8);
    const validToolIds = new Set(
      DESK_TRADING_TOOLING_SUITE.map((t) => t.toolId),
    );
    for (const tool of DESK_TRADING_TOOLING_SUITE) {
      expect(tool.entrypointPath.length).toBeGreaterThan(4);
      expect(tool.primaryCliCommand.length).toBeGreaterThan(5);
      expect(tool.traderEdgeCapability.length).toBeGreaterThan(25);
      expect(tool.safetyGuardrailContract.length).toBeGreaterThan(25);
      expect(tool.primaryOwnerRoles.length).toBeGreaterThan(0);
      for (const r of tool.primaryOwnerRoles) {
        expect(DESK_ROLE_IDS).toContain(r);
      }
    }

    expect([...ROLE_TRADING_WORKSTATIONS.map((w) => w.roleId)].sort()).toEqual(
      [...DESK_ROLE_IDS].sort(),
    );
    for (const ws of ROLE_TRADING_WORKSTATIONS) {
      expect(ws.workstationTitle.length).toBeGreaterThan(15);
      expect(ws.primaryToolIds.length).toBeGreaterThan(0);
      for (const tid of ws.primaryToolIds) {
        expect(validToolIds.has(tid)).toBe(true);
      }
      expect(ws.cordisPluginsAssigned.length).toBeGreaterThan(0);
      expect(ws.preSlateCommandSequence.length).toBeGreaterThan(0);
      expect(ws.liveSlateExecutionLoop.length).toBeGreaterThan(0);
      expect(ws.postSlateAuditLoop.length).toBeGreaterThan(0);
    }

    // Weakest-link diagnostics & code/governance enhancements (WL-01..WL-06)
    expect(DESK_WEAKEST_LINK_DIAGNOSTICS.length).toBe(6);
    for (const wl of DESK_WEAKEST_LINK_DIAGNOSTICS) {
      expect(wl.linkId).toMatch(/^WL-0[1-6]$/);
      expect(wl.primaryWeakRoles.length).toBeGreaterThan(0);
      for (const r of wl.primaryWeakRoles) {
        expect(DESK_ROLE_IDS).toContain(r);
      }
      expect(wl.coPilotDeputyRoles.length).toBeGreaterThan(0);
      for (const d of wl.coPilotDeputyRoles) {
        expect(DESK_ROLE_IDS).toContain(d);
      }
      expect(wl.implementedEnhancement.length).toBeGreaterThan(25);
      expect(wl.remediationCommand.length).toBeGreaterThan(5);
      expect(wl.financialExposureProtectedUsd).toBeGreaterThan(0);
    }

    const report = buildGovernanceReport({
      now: new Date("2026-11-09T12:00:00Z"),
    });
    expect(report.summary.weakestLinksCount).toBe(6);
    expect(report.summary.weakestPlaneId).toBe("upstream-stakeholder");
    expect(report.summary.weakestRoleIds).toEqual([
      "operator",
      "server-team-lead",
      "business-owner",
    ]);
    expect(report.summary.projectedTeamHealthScoreAfterEnhancements).toBe(96);

    // Verify WL-03 (#94) code enhancement in scripts/gslive_tally_bridge3c.ts
    const bridge3cSource = readFileSync(
      new URL("../scripts/gslive_tally_bridge3c.ts", import.meta.url),
      "utf8",
    );
    expect(bridge3cSource).toContain('timeout: { type: "string" }');
    expect(bridge3cSource).toContain(
      "--timeout must be a positive integer",
    );
    expect(bridge3cSource).toContain(
      "...(timeoutMs === undefined ? {} : { timeoutMs })",
    );

    // Verify GitHub Issue (#16..#115) & PR (#104..#128) Triage, Review & Merge Ledger
    expect(GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER.length).toBe(23);
    expect(report.summary.githubIssuesTriagedCount).toBe(19);
    expect(report.summary.githubIssuesResolvedCount).toBe(10);
    expect(report.summary.githubPrsReviewedAndMergedCount).toBe(4);
    for (const entry of GITHUB_ISSUE_AND_PR_TRIAGE_LEDGER) {
      expect(DESK_ROLE_IDS).toContain(entry.primaryOwnerRole);
      expect(DESK_ROLE_IDS).toContain(entry.coPilotReviewerRole);
      expect(entry.assigneeEmail).toMatch(/@bookdeskops\.com$/);
      expect(entry.inboxDispatchRoute).toMatch(/^inbox:\/\//);
      expect(entry.reviewAndMergeNote.length).toBeGreaterThan(20);
      expect(entry.verificationCommand.length).toBeGreaterThan(5);
    }

    // Verify Issue #115 Bun-native port cascade helper (BUN_PORT -> PORT -> NODE_PORT -> 4020)
    expect(resolveSportsdeskDaemonPort({})).toBe(4020);
    expect(resolveSportsdeskDaemonPort({ NODE_PORT: "4100" })).toBe(4100);
    expect(
      resolveSportsdeskDaemonPort({ PORT: "4050", NODE_PORT: "4100" }),
    ).toBe(4050);
    expect(
      resolveSportsdeskDaemonPort({
        BUN_PORT: "4025",
        PORT: "4050",
        NODE_PORT: "4100",
      }),
    ).toBe(4025);
  });

  test("runGovernanceCli returns 0 on valid repo and 2 on invalid --role", () => {
    expect(runGovernanceCli(["--help"])).toBe(0);
    expect(
      runGovernanceCli([
        "--audit",
        "--channels",
        "--wagers",
        "--autobet",
        "--flowchart",
        "--decisions-log",
        "--edge-cases",
        "--tooling",
        "--weakest-links",
        "--issues-prs",
        "--red-team",
      ]),
    ).toBe(0);
    expect(runGovernanceCli(["--role", "invalid-role"])).toBe(2);
  });
});



