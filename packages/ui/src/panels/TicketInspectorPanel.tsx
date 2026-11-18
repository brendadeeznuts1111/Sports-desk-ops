/**
 * @file packages/ui/src/panels/TicketInspectorPanel.tsx
 * @description Deep drill-down for a selected live wager (exposure, taxonomy, channel, PTY).
 */

import type React from "react";
import { styles } from "../dashboard_styles.ts";
import { clvEdgeTone } from "../config/wagers.ts";
import { DASHBOARD_THRESHOLDS } from "../config/dashboard.ts";
import { sanitizeCaptureText } from "../capture_text.ts";
import { formatWagerSelection } from "../wager_display.ts";
import {
  buildAlertsTabTicketHref,
  buildBookdeskopsWeblogTraceHref,
  buildShadowSliceHrefFromWager,
  buildTicketInspectorPageUrl,
  capUtilizationPct,
  formatImpliedProbability,
  formatOperatorBrief,
  inferMarketKindFromBetType,
  inferPeriodHintFromWager,
  inferTicketInspectorRegime,
  mapWagerToShadowTaxonomy,
  payoutMultiple,
  syncTicketInspectorToLocation,
  ticketPtyFindCommand,
  ticketPtyFindSportCommand,
  ticketPtyProfileCommand,
  ticketPtyWagersCommand,
  ticketQuotedHoldPct,
  wagerChannelLabel,
} from "../ticket_inspector.ts";
import type {
  DashboardAlertRecord,
  LiveWager,
  TierStyleConfig,
} from "../types.ts";

export interface TicketInspectorPanelProps {
  readonly wager: LiveWager;
  readonly relatedWagers?: readonly LiveWager[] | undefined;
  readonly matchedAlert?: DashboardAlertRecord | null | undefined;
  readonly copiedTicketId: string | null;
  readonly onCopyText: (ticketId: string, text: string) => void;
  readonly onSelectCustomerById: (customerId: string) => void;
  readonly onSelectWager?: ((wager: LiveWager) => void) | undefined;
  readonly onInspectPty: (customerId: string) => void;
  readonly onRunPtyCommand?: ((command: string) => void) | undefined;
  readonly tiersConfig: TierStyleConfig | null;
}

export function TicketInspectorPanel({
  wager,
  relatedWagers = [],
  matchedAlert = null,
  copiedTicketId,
  onCopyText,
  onSelectCustomerById,
  onSelectWager,
  onInspectPty,
  onRunPtyCommand,
  tiersConfig,
}: TicketInspectorPanelProps): React.ReactElement {
  const shadowTax = mapWagerToShadowTaxonomy(wager);
  const shadowHref = buildShadowSliceHrefFromWager(wager);
  const regime = inferTicketInspectorRegime(wager);
  const quotedHold = ticketQuotedHoldPct(wager.riskUsd, wager.toWinUsd);
  const implied = formatImpliedProbability(wager.oddsAmerican);
  const marketKind = inferMarketKindFromBetType(wager.betType);
  const periodHint = inferPeriodHintFromWager(wager);
  const capUse = capUtilizationPct(wager.riskUsd, wager.maxRecommendedStake);
  const payoutMult = payoutMultiple(wager.riskUsd, wager.toWinUsd);
  const highRisk = wager.riskUsd >= DASHBOARD_THRESHOLDS.high_risk_wager_usd;
  const bookdeskTrace = buildBookdeskopsWeblogTraceHref(wager);
  const shareUrl = buildTicketInspectorPageUrl(wager.ticketId);
  const brief = formatOperatorBrief(wager);

  const runPty = (cmd: string) => {
    if (onRunPtyCommand) {
      onRunPtyCommand(cmd);
      return;
    }
    if (cmd.startsWith("profile ")) {
      onInspectPty(wager.customerId);
    }
  };

  return (
    <div style={styles.wagerInspectorCard}>
      <div style={styles.inspectorHeader}>
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "4px",
              flexWrap: "wrap",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: "18px",
                color: "#f8fafc",
              }}
            >
              Ticket Inspector: #{wager.ticketId}
            </h3>
            <span style={styles.wagerBadge(wager.alertTier, tiersConfig)}>
              {wager.alertBadge}
            </span>
            <span className="sd-pill sd-pill-live">
              {wagerChannelLabel(wager)}
            </span>
            {wager.vip === true ? (
              <span className="sd-pill sd-pill-fixture">VIP</span>
            ) : null}
            <span
              className="sd-pill"
              style={{
                fontSize: "10px",
                background: "rgba(148, 163, 184, 0.15)",
              }}
            >
              {regime === "live_in_play" ? "⚡ in-play" : "pregame"}
            </span>
          </div>
          <div style={styles.inspectorSub}>
            Placed {wager.timestamp} · {wager.sport}
            {wager.subSport ? ` / ${wager.subSport}` : ""} · {wager.betType} ·{" "}
            {sanitizeCaptureText(wager.lineDisplay)} ({wager.oddsAmerican})
            {wager.ticketWriter
              ? ` · writer ${sanitizeCaptureText(wager.ticketWriter)}`
              : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {shadowHref ? (
            <a
              href={shadowHref}
              style={{
                ...styles.actionBtn,
                textDecoration: "none",
                color: "#0f172a",
              }}
              title="Open shadow-pricing slice for this sport / subsport"
            >
              📊 Shadow slice
            </a>
          ) : null}
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() => onInspectPty(wager.customerId)}
            title="Inspect Customer in Terminal PTY"
          >
            💻 PTY Profile
          </button>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() => onSelectCustomerById(wager.customerId)}
            title="Inspect in Customer Showcase"
          >
            👤 Customer Card
          </button>
          <a
            href={bookdeskTrace}
            target="_blank"
            rel="noreferrer"
            style={{
              ...styles.actionBtn,
              textDecoration: "none",
              color: "#0f172a",
            }}
            title="BookDeskOps serve-local customer weblog join with traceTicket"
          >
            📓 Weblog trace
          </a>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() => {
              syncTicketInspectorToLocation(wager.ticketId);
              onCopyText(`${wager.ticketId}:share`, shareUrl);
            }}
            title="Copy deep link (?tab=wagers&ticket=)"
          >
            🔗 Share URL
          </button>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() => onCopyText(`${wager.ticketId}:brief`, brief)}
            title="Copy operator handoff brief"
          >
            📎 Operator brief
          </button>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() =>
              onCopyText(wager.ticketId, JSON.stringify(wager, null, 2))
            }
            title="Copy Full Ticket Payload"
          >
            {copiedTicketId === wager.ticketId
              ? "✓ Payload Copied"
              : "📋 Copy Payload"}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "12px",
          marginBottom: "16px",
        }}
      >
        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>EVENT & SELECTION</div>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "#f8fafc",
              marginBottom: "4px",
            }}
          >
            {wager.event}
          </div>
          <div
            style={{
              fontSize: "12px",
              color: "#f59e0b",
              fontWeight: 600,
            }}
          >
            Pick: {formatWagerSelection(wager)}
          </div>
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>FINANCIAL EXPOSURE & EDGE</div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Risk / To Win:</span>
            <span style={{ fontWeight: 700, color: "#f8fafc" }}>
              ${wager.riskUsd.toLocaleString()} / $
              {wager.toWinUsd.toLocaleString()}
            </span>
          </div>
          {typeof wager.volumeUsd === "number" ? (
            <div style={styles.radarRow}>
              <span style={{ color: "#94a3b8" }}>Reported volume:</span>
              <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                ${wager.volumeUsd.toLocaleString()}
              </span>
            </div>
          ) : null}
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>CLV Edge Delta:</span>
            <span
              style={{
                fontWeight: 700,
                color: clvEdgeTone(wager.clvCents),
              }}
            >
              {wager.clvCents === null
                ? "— (no closing line)"
                : wager.clvCents > 0
                  ? `+${wager.clvCents}¢`
                  : `${wager.clvCents}¢`}
            </span>
          </div>
          {typeof wager.customerClvBps === "number" ||
          typeof wager.customerSharpScore === "number" ? (
            <div style={styles.radarRow}>
              <span style={{ color: "#94a3b8" }}>Customer Book CLV:</span>
              <span
                style={{
                  fontWeight: 700,
                  color:
                    typeof wager.customerClvBps === "number"
                      ? wager.customerClvBps > 0
                        ? "#4ade80"
                        : wager.customerClvBps < 0
                          ? "#f87171"
                          : "#e2e8f0"
                      : "#e2e8f0",
                }}
              >
                {typeof wager.customerClvBps === "number"
                  ? `${wager.customerClvBps > 0 ? "+" : ""}${wager.customerClvBps} bps`
                  : "—"}
                {typeof wager.customerSharpScore === "number"
                  ? ` · Sharp ${wager.customerSharpScore.toFixed(1)}`
                  : ""}
              </span>
            </div>
          ) : null}
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>LINE, PRICE & TICKET HOLD</div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Implied win prob:</span>
            <span style={{ fontWeight: 700, color: "#f8fafc" }}>{implied}</span>
          </div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Quoted ticket hold:</span>
            <span style={{ fontWeight: 700, color: "#f8fafc" }}>
              {quotedHold === null ? "—" : `${quotedHold}%`}
            </span>
          </div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Line window / CLV:</span>
            <span
              style={{
                fontWeight: 700,
                color: clvEdgeTone(wager.clvCents),
              }}
            >
              {wager.clvCents === null
                ? "No closing line"
                : wager.clvCents > 0
                  ? `Beat move (+${wager.clvCents}¢)`
                  : `Behind move (${wager.clvCents}¢)`}
            </span>
          </div>
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>AGENT & SYNDICATE ROUTING</div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Customer Login:</span>
            <span style={{ fontWeight: 700, color: "#38bdf8" }}>
              {wager.customerId}
            </span>
          </div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Sub-Agent / Master:</span>
            <span style={{ fontWeight: 600, color: "#f8fafc" }}>
              {wager.agentId} / {wager.masterAgent}
            </span>
          </div>
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>OPERATOR GUARDRAILS</div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Cap utilization:</span>
            <span
              style={{
                fontWeight: 700,
                color: capUse !== null && capUse > 100 ? "#f87171" : "#f8fafc",
              }}
            >
              {capUse === null
                ? "—"
                : `${capUse}% of $${wager.maxRecommendedStake.toLocaleString()} cap`}
            </span>
          </div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Payout multiple:</span>
            <span style={{ fontWeight: 600, color: "#f8fafc" }}>
              {payoutMult === null ? "—" : `${payoutMult}x`}
            </span>
          </div>
          <div style={styles.radarRow}>
            <span style={{ color: "#94a3b8" }}>Stake emphasis:</span>
            <span
              style={{
                fontWeight: 600,
                color: highRisk ? "#f87171" : "#4ade80",
              }}
            >
              {highRisk
                ? "HIGH RISK (≥ dashboard.toml)"
                : "Below emphasis floor"}
            </span>
          </div>
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>SHADOW TAXONOMY MAP</div>
          {shadowTax ? (
            <>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Sport → SubSport:</span>
                <span style={{ fontWeight: 700, color: "#f8fafc" }}>
                  {shadowTax.sport} → {shadowTax.subSport}
                </span>
              </div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Market / period:</span>
                <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                  {marketKind}
                  {periodHint ? ` · ${periodHint}` : ""}
                </span>
              </div>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Feed regime:</span>
                <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                  {shadowTax.regime.replace("_", " ")}
                </span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: "12px", color: "#94a3b8" }}>
              No shadow taxonomy mapping for this row.
            </div>
          )}
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>ALERT QUEUE & CROSS-DESK</div>
          {matchedAlert ? (
            <>
              <div style={styles.radarRow}>
                <span style={{ color: "#94a3b8" }}>Delivery:</span>
                <span style={{ fontWeight: 600, color: "#f8fafc" }}>
                  {matchedAlert.status} · {matchedAlert.deliveryId.slice(0, 8)}…
                </span>
              </div>
              {matchedAlert.finalError ? (
                <div style={{ fontSize: "11px", color: "#f87171" }}>
                  {matchedAlert.finalError}
                </div>
              ) : null}
              <a
                href={buildAlertsTabTicketHref(wager.ticketId)}
                style={{ fontSize: "11px", color: "#38bdf8" }}
              >
                Open Alerts tab →
              </a>
            </>
          ) : (
            <div style={{ fontSize: "12px", color: "#94a3b8" }}>
              No DLQ / delivery row for this ticket in the current alert pool.
            </div>
          )}
          <div style={{ marginTop: "8px", fontSize: "11px", color: "#64748b" }}>
            BookDeskOps join hydrates Manager getWebLog + traceTicket for
            forensic correlate (local serve-local).
          </div>
        </div>

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>PTY TRACE (autoExecute: false)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <button
              type="button"
              style={{ ...styles.actionBtn, fontSize: "11px" }}
              onClick={() => runPty(ticketPtyProfileCommand(wager.customerId))}
            >
              profile --radar
            </button>
            <button
              type="button"
              style={{ ...styles.actionBtn, fontSize: "11px" }}
              onClick={() => runPty(ticketPtyWagersCommand(wager.customerId))}
            >
              profile --wagers
            </button>
            <button
              type="button"
              style={{ ...styles.actionBtn, fontSize: "11px" }}
              onClick={() => runPty(ticketPtyFindCommand(wager.customerId))}
            >
              find {wager.customerId}
            </button>
            <button
              type="button"
              style={{ ...styles.actionBtn, fontSize: "11px" }}
              onClick={() =>
                runPty(ticketPtyFindSportCommand(wager.subSport ?? wager.sport))
              }
            >
              find -s {wager.subSport ?? wager.sport}
            </button>
          </div>
        </div>

        {relatedWagers.length > 0 ? (
          <div style={styles.radarCard}>
            <div style={styles.cardHeader}>
              SAME CUSTOMER ({wager.customerId})
            </div>
            <ul style={{ margin: 0, paddingLeft: "16px", fontSize: "11px" }}>
              {relatedWagers.map((row) => (
                <li key={row.ticketId} style={{ marginBottom: "4px" }}>
                  <button
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      color: "#38bdf8",
                      cursor: "pointer",
                      padding: 0,
                      fontWeight: 600,
                    }}
                    onClick={() => {
                      syncTicketInspectorToLocation(row.ticketId);
                      onSelectWager?.(row);
                    }}
                  >
                    {row.ticketId}
                  </button>{" "}
                  · ${row.riskUsd.toLocaleString()} · {row.betType}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div style={styles.radarCard}>
          <div style={styles.cardHeader}>DESK DIRECTIVE</div>
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color:
                wager.alertTier === "CRITICAL" || wager.alertTier === "STEAM"
                  ? "#f87171"
                  : "#4ade80",
              marginBottom: "4px",
            }}
          >
            {wager.operatorDirective}
          </div>
          <div style={{ fontSize: "11px", color: "#94a3b8" }}>
            Max Recommended Stake: ${wager.maxRecommendedStake.toLocaleString()}
          </div>
        </div>
      </div>

      <div
        style={{
          padding: "10px 14px",
          borderRadius: "6px",
          backgroundColor:
            wager.alertTier === "CRITICAL"
              ? "rgba(239, 68, 68, 0.12)"
              : wager.alertTier === "STEAM"
                ? "rgba(251, 146, 60, 0.12)"
                : "rgba(34, 197, 94, 0.12)",
          border: `1px solid ${
            wager.alertTier === "CRITICAL"
              ? "rgba(239, 68, 68, 0.3)"
              : wager.alertTier === "STEAM"
                ? "rgba(251, 146, 60, 0.3)"
                : "rgba(34, 197, 94, 0.3)"
          }`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
        }}
      >
        <div style={{ fontSize: "12px", color: "#f1f5f9" }}>
          <b>Action Directive:</b> {wager.operatorDirective} · Safety Invariant:{" "}
          <code>autoExecute: false</code> (operator override in Fantasy402
          Manager)
        </div>
        <span
          style={{
            fontSize: "11px",
            color: "#94a3b8",
            fontWeight: 600,
          }}
        >
          Cap: ${wager.maxRecommendedStake.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
