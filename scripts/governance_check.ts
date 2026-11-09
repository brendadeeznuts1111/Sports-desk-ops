#!/usr/bin/env bun
/**
 * @file scripts/governance_check.ts
 * @description Automated RBAC Roles & Task Governance CLI Gate and Dashboard Generator.
 *
 * Usage:
 *   bun run governance:check
 *   bun run governance:check --json
 *   bun run governance:check --markdown
 *   bun run governance:check --html --out scratch/governance-dashboard.html
 *   bun run governance:check --role operator
 */

import { writeFileSync } from "node:fs";
import {
  DESK_ROLE_IDS,
  buildGovernanceDashboardSection,
  buildGovernanceReport,
  renderStandaloneGovernanceHtml,
  type DeskRoleId,
} from "../lib/rbac_governance.ts";

function flagValue(args: readonly string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1] ?? null;
  }
  return null;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function runGovernanceCli(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "Usage: bun run governance:check [options]",
        "",
        "Options:",
        "  --json              Emit full GovernanceReport as JSON",
        "  --markdown          Emit Markdown governance section",
        "  --html              Emit standalone interactive HTML dashboard",
        "  --audit             Include detailed Task Completeness, Direction & Goal Audit table",
        "  --channels          Include Team Leads, Email/Inbox Accountability & Multi-Channel table",
        "  --wagers            Include Incoming Wager / Client / Weblog / IP Pattern Profiles table",
        "  --autobet           Include Automated BetTicker Layoff, Hedge & Re-Bet table",
        "  --flowchart         Include 10-Node BetTicker Decision Flowchart & Mermaid DAG",
        "  --decisions-log     Include Human & Team-Member BetTicker Decision Audit Log table",
        "  --edge-cases        Include 10 Production BetTicker Edge Cases & Variants table",
        "  --tooling           Include Industry-Grade Desk Trading Tooling & Role Workstations tables",
        "  --weakest-links     Include Weakest-Link Bottleneck Radar, Co-Pilot Failover & Enhancements table",
        "  --issues-prs        Include GitHub Issues (#16..#115) & PRs (#104..#128) Teammate Triage & Merge table",
        "  --red-team          Include Red-Team Adversarial Drills & Defense Verification table",
        "  --out <path>        Write output to file instead of stdout",
        "  --role <roleId>     Filter scorecard/task output to a single DeskRoleId",
        "  --strict-warnings   Fail (exit 1) on warnings in addition to errors",
      ].join("\n"),
    );
    return 0;
  }

  const roleFilter = flagValue(argv, "--role");
  if (
    roleFilter !== null &&
    !(DESK_ROLE_IDS as readonly string[]).includes(roleFilter)
  ) {
    console.error(
      `governance:check: unknown --role "${roleFilter}". Valid roles: ${DESK_ROLE_IDS.join(", ")}`,
    );
    return 2;
  }

  const report = buildGovernanceReport();
  const outPath = flagValue(argv, "--out");
  const wantJson = argv.includes("--json");
  const wantMarkdown = argv.includes("--markdown");
  const wantHtml = argv.includes("--html");
  const wantAudit = argv.includes("--audit");
  const wantChannels = argv.includes("--channels");
  const wantWagers = argv.includes("--wagers");
  const wantAutobet = argv.includes("--autobet");
  const wantFlowchart = argv.includes("--flowchart");
  const wantDecisionsLog = argv.includes("--decisions-log");
  const wantEdgeCases = argv.includes("--edge-cases");
  const wantTooling = argv.includes("--tooling");
  const wantWeakestLinks = argv.includes("--weakest-links");
  const wantIssuesPrs = argv.includes("--issues-prs");
  const wantRedTeam = argv.includes("--red-team");
  const strictWarnings = argv.includes("--strict-warnings");

  if (wantHtml) {
    const html = renderStandaloneGovernanceHtml(report);
    if (outPath !== null && outPath !== "") {
      writeFileSync(outPath, html, "utf8");
      console.error(
        `governance:check: wrote HTML dashboard -> ${outPath} (${html.length} bytes)`,
      );
    } else {
      process.stdout.write(html);
    }
  } else if (wantJson) {
    const filtered =
      roleFilter === null
        ? report
        : {
            ...report,
            ownerScorecards: report.ownerScorecards.filter(
              (s) => s.roleId === (roleFilter as DeskRoleId),
            ),
            tasks: report.tasks.filter((t) =>
              t.owners.includes(roleFilter as DeskRoleId),
            ),
            decisions: report.decisions.filter((d) =>
              d.owners.includes(roleFilter as DeskRoleId),
            ),
          };
    const payload = `${JSON.stringify(filtered, null, 2)}\n`;
    if (outPath !== null && outPath !== "") {
      writeFileSync(outPath, payload, "utf8");
    } else {
      process.stdout.write(payload);
    }
  } else if (wantMarkdown) {
    const section = buildGovernanceDashboardSection(report);
    const md = [
      `## ${section.title}`,
      "",
      `> ${section.provenance ?? ""}`,
      "",
      ...section.body,
      "",
    ].join("\n");
    if (outPath !== null && outPath !== "") {
      writeFileSync(outPath, md, "utf8");
    } else {
      process.stdout.write(md);
    }
  } else {
    const {
      summary,
      taskAudit,
      valueTelemetry,
      wagerSurveillanceAndAutobet: ws,
    } = report;
    const scorecards =
      roleFilter === null
        ? report.ownerScorecards
        : report.ownerScorecards.filter((s) => s.roleId === roleFilter);

    console.log(
      `governance:check: ${summary.gatePassed ? "PASS" : "FAIL"} · teamHealth=${summary.teamHealthScore}% · openTasks=${summary.openTasks} (P0=${summary.p0Open}) · unowned=${summary.unownedTasks} · gates=${summary.readyGates}/${summary.totalGates} · decisions=${summary.pendingDecisions} (~${summary.pendingDecisionHours}h)`,
    );
    console.log(
      `value:telemetry:  4wkSavings=$${summary.totalCounterfactualSavingsUsd4Wk.toLocaleString("en-US")} ($${summary.dailyProtectionRateUsd.toLocaleString("en-US")}/day) · holdSwing=${valueTelemetry.backtest4Wk.baselineTotalHoldPct4Wk}%->+${valueTelemetry.backtest4Wk.protectedTotalHoldPct4Wk}% (+${valueTelemetry.backtest4Wk.holdSwingBps}bps) · bridgePriority=$${summary.crossDomainPriorityUsd.toLocaleString("en-US")} · syndicateWallets=${summary.activeSyndicateWallets}/${valueTelemetry.liveSyndicateFeed.configuredWalletsCount} ($${summary.openSyndicateExposureUsd.toLocaleString("en-US")} open)`,
    );
    console.log(
      `task:audit:       ${taskAudit.auditPassed ? "VERIFIED" : "INCOMPLETE"} · overallReadiness=${taskAudit.overallCompletionPct}% (open=${taskAudit.averageOpenCompletionPct}%) · goals=${taskAudit.openWithGoalCount}/${taskAudit.openTasksAudited} · directions=${taskAudit.openWithDirectionCount}/${taskAudit.openTasksAudited} · commands=${taskAudit.openWithCommandCount}/${taskAudit.openTasksAudited} · doneVerified=${taskAudit.doneVerifiedCompleteCount}/${taskAudit.doneTasksAudited} · citedPaths=${taskAudit.verifiedCitedPaths}/${taskAudit.totalCitedPaths} on-disk`,
    );
    console.log(
      `channels:inbox:   inboxes=${summary.totalRoleInboxes}/${DESK_ROLE_IDS.length} (@bookdeskops.com) · channels=${summary.activeChannelsCount} (${report.channelIntegrations.map((c) => c.id).join(",")}) · ackPending=${summary.inboxPendingAckTotal}`,
    );
    console.log(
      `wagers:autobet:   profiles=${ws.totalClientProfiles} (${ws.totalLinkedAccountsTracked} accts, ${ws.totalBridgedPolymarketWallets} PM wallets, avgDwell=${ws.avgModeADwellSeconds}s, avgMFCS=${ws.avgMfcsScore}) · flowNodes=${ws.flowchartNodesCount} (${ws.flowchartEdgesCount} edges) · decisionLogs=${ws.decisionAuditLogCount} (${ws.humanSignedDecisionsCount} human-signed) · edgeCases=${ws.edgeCaseVariantsCount} · redTeam=${ws.redTeamDrillsDefended}/${ws.redTeamDrillsTotal} defended · layoff=${ws.layoffOpportunitiesCount} routes ($${ws.totalPlannedLayoffUsd} / ${ws.totalPlannedContracts} contracts, +${ws.avgLayoffEdgeBps}bps avg edge)`,
    );
    console.log(
      `trading:tooling:  tools=${ws.verifiedTradingToolsOnDiskCount}/${ws.tradingToolsCount} on-disk · workstations=${ws.roleWorkstationsCount}/${DESK_ROLE_IDS.length} roles · cordisPlugins=5 (Format 1) · policy=${ws.executionPolicyMode}`,
    );
    console.log(
      `weakest:links:    diagnosed=${ws.weakestLinksCount} · weakestPlane=${ws.weakestPlaneId} (80%) · weakestRoles=${ws.weakestRoleIds.join(",")} (80%) · projectedHealthLift=${summary.teamHealthScore}%->${ws.projectedTeamHealthScoreAfterEnhancements}%`,
    );
    console.log(
      `issues:prs:       issuesTriaged=${ws.githubIssuesTriagedCount} (${ws.githubIssuesResolvedCount} fixed & closed, ${ws.githubIssuesTriagedCount - ws.githubIssuesResolvedCount} dispatched to inboxes) · prsReviewedMerged=${ws.githubPrsReviewedAndMergedCount}`,
    );
    console.log("");
    console.log(
      `${padRight("ROLE", 20)} ${padRight("F402", 5)} ${padRight("OPEN TASKS", 18)} ${padRight("DECISIONS", 11)} ${padRight("GATES", 7)} ${padRight("VALUE PROTECTED / GOVERNED", 28)} ${padRight("SCORE", 7)} STATUS`,
    );
    console.log("-".repeat(118));
    for (const s of scorecards) {
      const openStr =
        s.openTaskIds.length === 0 ? "0" : s.openTaskIds.join(",");
      const decStr =
        s.pendingDecisionCount > 0
          ? `${s.pendingDecisionCount} (~${s.pendingDecisionHours}h)`
          : "0";
      const valStr =
        s.protectedSavingsUsd > 0
          ? `$${(s.protectedSavingsUsd / 1000).toFixed(1)}k saved (${s.ownedGuards.length} guards)`
          : `$${(s.priorityExposureUsd / 1000).toFixed(1)}k governed`;
      console.log(
        `${padRight(s.roleId, 20)} ${padRight(s.f402Counterpart, 5)} ${padRight(openStr, 18)} ${padRight(decStr, 11)} ${padRight(`${s.gatesReady}/${s.gatesTotal}`, 7)} ${padRight(valStr, 28)} ${padRight(`${s.weightScore}%`, 7)} ${s.status}`,
      );
    }

    if (roleFilter === null) {
      console.log("");
      console.log(
        `${padRight("OPERATIONAL PLANE", 34)} ${padRight("ROLES", 6)} ${padRight("HEALTH", 8)} ${padRight("OPEN (P0)", 11)} ${padRight("4-WK PROTECTED", 16)} TELEMETRY PULSE`,
      );
      console.log("-".repeat(118));
      for (const p of valueTelemetry.planeSummaries) {
        const valStr =
          p.protectedSavingsUsd > 0
            ? `$${(p.protectedSavingsUsd / 1000).toFixed(1)}k`
            : `$${(p.priorityExposureUsd / 1000).toFixed(1)}k gov`;
        console.log(
          `${padRight(p.label, 34)} ${padRight(String(p.roleIds.length), 6)} ${padRight(`${p.avgHealthScore}%`, 8)} ${padRight(`${p.openTasksCount} (${p.p0TasksCount})`, 11)} ${padRight(valStr, 16)} ${p.telemetryHeadline}`,
        );
      }
    }

    if (wantChannels || wantAudit || roleFilter !== null) {
      console.log("");
      console.log(
        `${padRight("ROLE", 20)} ${padRight("TEAM LEAD", 36)} ${padRight("EMAIL INBOX", 32)} ${padRight("INBOX SLA / STATUS", 24)} CHANNELS`,
      );
      console.log("-".repeat(132));
      for (const s of scorecards) {
        console.log(
          `${padRight(s.roleId, 20)} ${padRight(s.teamLead.slice(0, 35), 36)} ${padRight(s.email, 32)} ${padRight(`${s.ackSlaMinutes}m · ${s.inboxStatus}`, 24)} ${s.primaryChannels.join(",")}`,
        );
      }
    }

    if (wantIssuesPrs || roleFilter !== null) {
      const items = ws.githubIssueAndPrTriageLedger.filter(
        (e) =>
          roleFilter === null ||
          e.primaryOwnerRole === roleFilter ||
          e.coPilotReviewerRole === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("REF", 11)} ${padRight("ASSIGNEE (ROLE)", 32)} ${padRight("CO-PILOT REVIEWER", 32)} ${padRight("STATUS", 29)} TITLE`,
      );
      console.log("-".repeat(144));
      for (const e of items) {
        const assigneeStr = `${e.assigneeName} (${e.primaryOwnerRole})`;
        const reviewerStr = `${e.coPilotReviewerName} (${e.coPilotReviewerRole})`;
        console.log(
          `${padRight(e.itemRef, 11)} ${padRight(assigneeStr.slice(0, 31), 32)} ${padRight(reviewerStr.slice(0, 31), 32)} ${padRight(e.resolutionStatus, 29)} ${e.title.slice(0, 44)}`,
        );
      }
    }

    if (wantWeakestLinks || roleFilter !== null) {
      const links = ws.weakestLinkDiagnostics.filter(
        (wl) =>
          roleFilter === null ||
          wl.primaryWeakRoles.includes(roleFilter as DeskRoleId) ||
          wl.coPilotDeputyRoles.includes(roleFilter as DeskRoleId),
      );
      console.log("");
      console.log(
        `${padRight("LINK", 7)} ${padRight("SEVERITY", 21)} ${padRight("WEAK ROLE(S) -> CO-PILOT", 36)} ${padRight("BEFORE -> PROJECTED AFTER", 44)} ENHANCEMENT & STATUS`,
      );
      console.log("-".repeat(144));
      for (const wl of links) {
        const rolePair = `${wl.primaryWeakRoles.join("+")} -> ${wl.coPilotDeputyRoles.join("+")}`;
        const liftStr = `${wl.beforeScoreOrSla.slice(0, 19)} -> ${wl.projectedAfterScoreOrSla.slice(0, 21)}`;
        console.log(
          `${padRight(wl.linkId, 7)} ${padRight(wl.severity, 21)} ${padRight(rolePair.slice(0, 35), 36)} ${padRight(liftStr, 44)} ${wl.status} · ${wl.code}`,
        );
      }
    }

    if (wantTooling || roleFilter !== null) {
      const tools = ws.tradingToolingSuite.filter(
        (t) =>
          roleFilter === null ||
          t.primaryOwnerRoles.includes(roleFilter as DeskRoleId),
      );
      console.log("");
      console.log(
        `${padRight("TOOL ID", 9)} ${padRight("CODE", 33)} ${padRight("ENTRYPOINT", 33)} ${padRight("OWNER ROLES", 30)} PRIMARY CLI COMMAND`,
      );
      console.log("-".repeat(142));
      for (const t of tools) {
        console.log(
          `${padRight(t.toolId, 9)} ${padRight(t.code.slice(0, 32), 33)} ${padRight(t.entrypointPath.slice(0, 32), 33)} ${padRight(t.primaryOwnerRoles.join("+").slice(0, 29), 30)} ${t.primaryCliCommand}`,
        );
      }

      const workstations = ws.roleWorkstations.filter(
        (w) => roleFilter === null || w.roleId === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("ROLE", 20)} ${padRight("TOOLS", 26)} ${padRight("PRE-SLATE LOOP", 38)} ${padRight("LIVE-SLATE LOOP", 34)} EDGE BENCHMARK`,
      );
      console.log("-".repeat(142));
      for (const w of workstations) {
        console.log(
          `${padRight(w.roleId, 20)} ${padRight(w.primaryToolIds.join(","), 26)} ${padRight(w.preSlateCommandSequence.join(" -> ").slice(0, 37), 38)} ${padRight(w.liveSlateExecutionLoop.join(" -> ").slice(0, 33), 34)} ${w.primaryEdgeBenchmark.slice(0, 42)}`,
        );
      }
    }

    if (wantFlowchart || wantAutobet) {
      const nodes = ws.flowchartNodes.filter(
        (n) => roleFilter === null || n.ownerRole === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("NODE", 9)} ${padRight("KIND", 18)} ${padRight("STAGE", 38)} ${padRight("PASS TARGET", 32)} OWNER & SLA`,
      );
      console.log("-".repeat(134));
      for (const n of nodes) {
        console.log(
          `${padRight(n.nodeId, 9)} ${padRight(n.nodeKind, 18)} ${padRight(n.label.slice(0, 37), 38)} ${padRight(n.passBranchTarget.slice(0, 31), 32)} ${n.ownerRole} (${n.slaOrLatencyBudget})`,
        );
      }
    }

    if (wantDecisionsLog || wantAutobet) {
      const logs = ws.decisionAuditLog.filter(
        (d) =>
          roleFilter === null ||
          d.actorRole === roleFilter ||
          d.coSignerRole === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("LOG ID", 13)} ${padRight("ROT / CLUSTER", 24)} ${padRight("HUMAN ACTOR (+ CO-SIGN)", 34)} ${padRight("TRANSITION / ACTION", 32)} EDGE CASE & RATIONALE`,
      );
      console.log("-".repeat(142));
      for (const d of logs) {
        const actorStr =
          d.coSignerName !== null
            ? `${d.actorName}+${d.coSignerName}`
            : `${d.actorName} (${d.actorRole})`;
        console.log(
          `${padRight(d.logId, 13)} ${padRight(`${d.rotation} · ${d.officeClusterId}`.slice(0, 23), 24)} ${padRight(actorStr.slice(0, 33), 34)} ${padRight(`${d.priorState}->${d.nextState} (${d.decisionAction})`.slice(0, 31), 32)} ${d.edgeCaseOrVariantId} · ${d.humanRationaleNote.slice(0, 44)}`,
        );
      }
    }

    if (wantEdgeCases || wantAutobet) {
      const variants = ws.edgeCaseVariants.filter(
        (ec) => roleFilter === null || ec.ownerRole === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("ID", 7)} ${padRight("CODE", 34)} ${padRight("OWNER", 19)} ${padRight("MODULE", 35)} HUMAN AUDIT RULE`,
      );
      console.log("-".repeat(138));
      for (const ec of variants) {
        console.log(
          `${padRight(ec.variantId, 7)} ${padRight(ec.code.slice(0, 33), 34)} ${padRight(ec.ownerRole, 19)} ${padRight(ec.sourceModule, 35)} ${ec.humanAuditRequirement.slice(0, 48)}`,
        );
      }
    }

    if (wantWagers || roleFilter !== null) {
      const profiles = ws.clientProfiles.filter(
        (cp) => roleFilter === null || cp.ownerRole === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("OFFICE", 10)} ${padRight("ARCHETYPE", 26)} ${padRight("SUBNET / DWELL", 32)} ${padRight("ACCTS/PM", 10)} ${padRight("LAYOFF DISPOSITION", 30)} OWNER & INBOX`,
      );
      console.log("-".repeat(138));
      for (const cp of profiles) {
        console.log(
          `${padRight(cp.officeAgentId, 10)} ${padRight(cp.patternArchetype, 26)} ${padRight(`${cp.sharedIpOrSubnet.slice(0, 22)} · ${cp.modeASessionDwellSeconds}s`, 32)} ${padRight(`${cp.totalLinkedAccounts}/${cp.bridgedPolymarketWallets.length}PM`, 10)} ${padRight(cp.layoffHedgeDisposition, 30)} ${cp.ownerRole} (${cp.ownerEmail})`,
        );
      }
    }

    if (wantAutobet || wantWagers || roleFilter !== null) {
      const opps = ws.layoffOpportunities.filter(
        (o) => roleFilter === null || o.ownerRole === roleFilter,
      );
      console.log("");
      console.log(
        `${padRight("OPPORTUNITY", 15)} ${padRight("ROT / LEAGUE", 15)} ${padRight("VENUE / STYLE", 16)} ${padRight("FAIR vs PRICE (EDGE)", 26)} ${padRight("STAKE / CNTR", 16)} ${padRight("LEDGER", 14)} OWNER`,
      );
      console.log("-".repeat(126));
      for (const o of opps) {
        console.log(
          `${padRight(o.opportunityId, 15)} ${padRight(`${o.rotation} (${o.league})`, 15)} ${padRight(`${o.externalVenue}:${o.executionStyle}`, 16)} ${padRight(`${(o.fairProb * 100).toFixed(1)}% vs ${(o.venuePrice * 100).toFixed(1)}c (+${o.edgeBps}bps)`, 26)} ${padRight(`$${o.plannedStakeUsd} (${o.contractsCount}c)`, 16)} ${padRight(o.intentLedgerState, 14)} ${o.ownerRole}`,
        );
      }
    }

    if (wantRedTeam || wantWagers || roleFilter !== null) {
      const drills = ws.redTeamDrills.filter(
        (d) =>
          roleFilter === null || d.ownerRoles.includes(roleFilter as DeskRoleId),
      );
      console.log("");
      console.log(
        `${padRight("DRILL ID", 13)} ${padRight("CATEGORY", 24)} ${padRight("STATUS", 19)} ${padRight("OWNER ROLES", 30)} VERIFICATION COMMAND`,
      );
      console.log("-".repeat(126));
      for (const d of drills) {
        console.log(
          `${padRight(d.drillId, 13)} ${padRight(d.category, 24)} ${padRight(d.status, 19)} ${padRight(d.ownerRoles.join("+"), 30)} ${d.verificationCommand}`,
        );
      }
    }

    if (wantAudit || roleFilter !== null) {
      const filteredOpen = report.tasks.filter(
        (t) =>
          t.status === "open" &&
          (roleFilter === null || t.owners.includes(roleFilter as DeskRoleId)),
      );
      console.log("");
      console.log(
        `${padRight("TASK", 6)} ${padRight("REF", 22)} ${padRight("READINESS", 10)} ${padRight("PATHS", 8)} ${padRight("VERDICT", 24)} GOAL & DIRECTION`,
      );
      console.log("-".repeat(118));
      for (const t of filteredOpen) {
        const goalShort = (t.goal ?? "MISSING GOAL").slice(0, 44);
        const cmdShort = t.nextCommand ?? (t.direction ?? "").slice(0, 36);
        console.log(
          `${padRight(t.id, 6)} ${padRight(t.ref ?? "—", 22)} ${padRight(`${t.completionPct}%`, 10)} ${padRight(`${t.verifiedPaths.length}/${t.citedPaths.length}`, 8)} ${padRight(t.auditVerdict, 24)} ${goalShort} -> [${cmdShort}]`,
        );
      }
    }

    if (report.findings.length > 0) {
      console.log("");
      console.log(`Findings (${report.findings.length}):`);
      for (const finding of report.findings) {
        console.log(
          `  [${finding.severity.toUpperCase()}] ${finding.code} (${finding.target}): ${finding.detail}`,
        );
      }
    }
  }

  const failed = strictWarnings
    ? report.findings.length > 0
    : !report.summary.gatePassed;
  return failed ? 1 : 0;
}

if (import.meta.main) {
  process.exit(runGovernanceCli(process.argv.slice(2)));
}

